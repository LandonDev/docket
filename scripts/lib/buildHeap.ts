import { spawn } from 'node:child_process'
import { getHeapStatistics } from 'node:v8'

/**
 * The build's heap. electron-vite builds main, preload, the renderer and the
 * hosted pages in one node process, and on 2026-11-23 the renderer took that
 * process past node's default heap limit of about 4 GB (the release gate died
 * "JavaScript heap out of memory"; the measure is in
 * .temp-code/plans/landed/F-build-heap.md). Every caller starts the process
 * its own way (`bun run build`, the gate's step, release-publish.sh, the box's
 * installed box-update lib, the Windows build, a proof's execFileSync) and none
 * can hand node a flag before it starts, but all of them load
 * electron.vite.config.ts. So the config asks `buildHeapHold` first: in a
 * build under a smaller heap it runs the same command again in a child node
 * with BUILD_HEAP_MB, holds the parent until the child ends, runs `after`
 * (the hosted pages' build) once the child's memory is gone, and leaves with
 * the status (docs/agents/releases.md "The build's heap").
 */
export const BUILD_HEAP_MB = 8192

/** Set on the child, so a child that still finds a small heap never runs a third. */
export const BUILD_HEAP_ENV = 'TEMP_CODE_BUILD_HEAP'

export interface HeapProcess {
  argv: readonly string[]
  execArgv: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  /** v8's heap_size_limit, in bytes. */
  heapLimit: number
  /** Bun runs the CLI on JavaScriptCore, which has no such flag. */
  bun: boolean
}

/** The node arguments of the rerun, or null when this process already has the room or is no build. */
export function heapRerunArgs(p: HeapProcess): string[] | null {
  const [, script = '', command] = p.argv
  if (p.bun || command !== 'build' || !/electron-vite/.test(script)) return null
  if (p.env[BUILD_HEAP_ENV] || p.heapLimit >= BUILD_HEAP_MB * 1024 * 1024) return null
  return [...p.execArgv.filter((a) => !a.startsWith('--max-old-space-size')), `--max-old-space-size=${BUILD_HEAP_MB}`, ...p.argv.slice(1)]
}

/**
 * The config's export while a rerun runs: electron-vite awaits a config
 * function, and this one never settles; the child's exit, then `after`'s,
 * ends the parent. Null when this process builds itself.
 */
export function buildHeapHold(after?: () => Promise<void>): (() => Promise<never>) | null {
  const args = heapRerunArgs({
    argv: process.argv,
    execArgv: process.execArgv,
    env: process.env,
    heapLimit: getHeapStatistics().heap_size_limit,
    bun: Boolean(process.versions.bun)
  })
  if (!args) return null
  return () =>
    new Promise<never>(() => {
      const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, [BUILD_HEAP_ENV]: String(BUILD_HEAP_MB) } })
      // A caller that ends the parent by its pid (Windows has no process group) ends the build with it.
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig))
      child.on('error', (err) => {
        console.error(`[build heap] could not start the build with ${BUILD_HEAP_MB} MB: ${err.message}`)
        process.exit(1)
      })
      child.on('exit', (code, signal) => {
        if (code !== 0 || !after) process.exit(code ?? (signal ? 1 : 0))
        else
          after().then(
            () => process.exit(0),
            (err: Error) => {
              console.error(err.message)
              process.exit(1)
            }
          )
      })
    })
}
