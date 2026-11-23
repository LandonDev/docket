/**
 * The packaged entry (package.json `main`). It turns on Node's compile cache,
 * picks the code this launch runs, and loads that main bundle through the
 * cache, so a warm launch reads V8's cached code for index.js instead of
 * compiling it. The cache reaches disk only when index.ts flushes it (10 s
 * after boot and at quit): Electron's quit is not Node's exit path.
 *
 * The code is the bundle's own `out/main/index.js`, or a code-only update
 * staged under userData when codeChoice.ts finds one it may run
 * (docs/agents/code-only-updates.md). A staged tree that throws while it
 * loads is recorded and the app starts again at once with BUNDLE_CODE_FLAG,
 * which runs the bundle's code whatever the state on disk says: a process
 * that ran half of one index.js is no place to load another. boot.ts also
 * decides when a staged tree is good (`settle`): the code on trial only
 * says that it started.
 *
 * Imports nothing index.ts imports: a shared module would make Rollup emit
 * out/main/chunks/* and both entries would require it, so index.js would no
 * longer load alone through the cache that was just enabled, and a staged
 * index.js would share a file with the boot code it must not change. The
 * app reads what was picked from `globalThis.__tempcodeCode`.
 */
import { app } from 'electron'
import { constants, enableCompileCache } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUNDLE_CODE_FLAG, bakedUserData, pickCode, sameProgramAlive, type CodeBoot } from './codeChoice'
import { compileCacheDir, compileCacheLine } from './compileCache'

// Packaged only: dev serves changing code, and the cache is a speedup, never a gate.
if (app.isPackaged) {
  try {
    const result = enableCompileCache(compileCacheDir(process.env, tmpdir()))
    console.log(
      `[boot] ${compileCacheLine(result, constants.compileCacheStatus as unknown as Record<string, number>)}`
    )
  } catch {
    // never let the cache stop the app from starting
  }
}

// Read once and taken out of process.argv. Electron's own copy of the command line keeps it, and a
// relaunch with no arguments copies that, so every app.relaunch() in the app names its arguments
// from process.argv (src/main/codePaths.test.ts).
const flagAt = process.argv.indexOf(BUNDLE_CODE_FLAG)
if (flagAt >= 0) process.argv.splice(flagAt, 1)

const bundleRoot = app.getAppPath()
const code = pickCode({
  packaged: app.isPackaged,
  platform: process.platform,
  bundleRoot,
  // The same directory index.ts settles on a moment later (its harness block and TEMP_CODE_USER_DATA).
  userData: process.env.TEMP_CODE_USER_DATA || bakedUserData(bundleRoot) || app.getPath('userData'),
  pid: process.pid,
  alive: (pid) => sameProgramAlive(pid, process.execPath),
  bundleOnly: flagAt >= 0,
  later: (fn, ms) => void setTimeout(fn, ms).unref(),
  log: (line) => console.log(`[boot] ${line}`)
})
;(globalThis as { __tempcodeCode?: CodeBoot }).__tempcodeCode = code.boot
// A started launch that quits cleanly inside its first minute is good too; a crash never gets here.
app.on('will-quit', () => code.settle())

// A computed path keeps Rollup from folding index.js into this file, so the
// main bundle is compiled through the cache that was just enabled.
if (code.boot.running) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(join(code.out, 'main', 'index.js'))
  } catch (err) {
    console.error('[boot] the staged code threw while loading; starting again on the bundle', err)
    code.threw(err)
    // Explicit arguments: a relaunch with none copies this process's own command line.
    app.relaunch({ args: [...process.argv.slice(1), BUNDLE_CODE_FLAG] })
    app.exit(0)
  }
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(join(__dirname, 'index.js'))
}
