#!/usr/bin/env bun
/**
 * The gate's boot of the BUILT app (the commit tier's `boot-built` row, after
 * `build`): out/ under Electron, headless, on a scratch home, data and VM
 * folder, then the same Work reads a deploy's trial asks (scripts/box/probe-work.mjs).
 * An import cycle that only the built main bundle's order trips is invisible
 * to vitest, which runs the sources unbundled: 1.0.371 reached the box with
 * the Files place dead that way (2026-11-24).
 *
 *   bun scripts/boot-built-probe.ts [--keep]
 *
 * Exits 1 with the pillar and its error, or the instance's last lines when it
 * never came up; 0 with the times. Nothing of the real host is read or held.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localCaller, probeWork } from './box/probe-work.mjs'

const REPO = join(import.meta.dir, '..')
const BOOT_MS = 90_000
const keep = process.argv.includes('--keep')

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('boot-built: out/main/index.js is missing; run the build first')
  process.exit(1)
}
const root = mkdtempSync(join(tmpdir(), 'tc-boot-built-'))
const dirs = { data: join(root, 'data'), home: join(root, 'home'), tmp: join(root, 'tmp'), vm: join(root, 'no-vm') }
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
const logFile = join(root, 'instance.log')

function launch(): ChildProcess {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    WINVM_DIR: dirs.vm,
    TEMP_CODE_USER_DATA: dirs.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WARM_HARNESS: '0',
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: process.env.SHELL || '/bin/bash'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv =
    process.platform === 'linux'
      ? ['/usr/bin/xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', '/usr/bin/dbus-run-session', '--', electron, '.']
      : [electron, '.']
  const child = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout?.on('data', (c: Buffer) => appendFileSync(logFile, c))
  child.stderr?.on('data', (c: Buffer) => appendFileSync(logFile, c))
  return child
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done()
    const kill = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {}
    }, 10_000)
    child.once('exit', () => {
      clearTimeout(kill)
      done()
    })
    try {
      process.kill(-child.pid!, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  })
}

const tail = (): string => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n') : '(no output)')

const started = Date.now()
const child = launch()
let code = 0
try {
  const serverJson = join(dirs.data, 'server.json')
  let port = 0
  while (Date.now() - started < BOOT_MS && child.exitCode === null) {
    if (existsSync(serverJson)) {
      port = (JSON.parse(readFileSync(serverJson, 'utf8')) as { port: number }).port
      break
    }
    await Bun.sleep(250)
  }
  if (!port) throw new Error(`the built app never wrote server.json in ${Math.round((Date.now() - started) / 1000)} s${child.exitCode !== null ? ` (it exited ${child.exitCode})` : ''}`)
  const bootMs = Date.now() - started
  const call = localCaller(port)
  const sessions = await call('session.list', {})
  if (!Array.isArray(sessions)) throw new Error('session.list did not answer a list')
  const work = await probeWork(call)
  for (const note of work.notes) console.log(`note: ${note}`)
  if (work.failures.length) throw new Error(`a Work pillar did not load in the built app:\n  ${work.failures.join('\n  ')}`)
  console.log(`boot-built: the built app booted in ${bootMs} ms; every Work pillar answered in ${work.ms} ms`)
} catch (err) {
  code = 1
  console.error(`boot-built: ${err instanceof Error ? err.message : String(err)}`)
  console.error(`--- the instance's last lines ---\n${tail()}`)
} finally {
  await stop(child)
  if (keep) console.log(`kept ${root}`)
  else rmSync(root, { recursive: true, force: true })
}
process.exit(code)
