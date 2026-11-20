/**
 * Starting and stopping a machine's two daemons, QEMU and swtpm, the same from the rig's scripts and from a
 * server keeper. Plain node only: scripts/win-vm/vm.ts runs this under bun.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonEnv, type RigConfig, type RigPaths } from './config'
import { qemuArgs, swtpmArgs, type Machine } from './qemu'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** A shell started before `usermod -aG kvm agents` lacks the group; `sg kvm` gives it to the child without a restart. */
export function kvmWrapped(cmd: string, args: string[], kvmOpen = canOpenKvm()): [string, string[]] {
  return kvmOpen ? [cmd, args] : ['sg', ['kvm', '-c', [cmd, ...args].map(shq).join(' ')]]
}
function canOpenKvm(): boolean {
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The signals a stop of the box's service sends the whole cgroup at once (systemd's default `control-group`).
 * The standing machine's daemons start with them blocked: a blocked signal stays blocked across exec, QEMU and
 * swtpm only install handlers (which a block outlives), and every thread QEMU makes starts with all signals
 * blocked. So the stop leaves both running, and the watcher beside them (watcher.ts) has the stop's 30 seconds to
 * hibernate the guest. `sg` clears the mask, so the block goes inside it (kvmWrapped(stopBlocked(…))). Perl's POSIX module is on every Ubuntu box; node cannot set a child's signal mask.
 */
export const STOP_SIGNALS = ['TERM', 'INT', 'HUP'] as const
export function stopBlocked(cmd: string, args: string[]): [string, string[]] {
  const block = `use POSIX; sigprocmask(SIG_BLOCK, POSIX::SigSet->new(${STOP_SIGNALS.map((s) => `SIG${s}`).join(', ')})) or die "sigprocmask: $!"; exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!"`
  return ['perl', ['-e', block, cmd, ...args]]
}

/** Options for starting a daemon: `blockStop` starts it with the stop signals blocked (the standing machine's). */
export interface DaemonOpts {
  blockStop?: boolean
  /**
   * Added to the clean environment of QEMU alone: a window's display and QEMU's window modules (window.ts). They go
   * through `env` inside the command, since `sg` is setuid and the loader drops LD_LIBRARY_PATH from what it starts.
   */
  env?: Record<string, string>
}

/** The pid in a pid file, only while that pid is still the process it names (a pid comes round again after a restart). */
export function livePid(file: string, isIt: (pid: number) => boolean): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim())
    process.kill(pid, 0)
    return isIt(pid) ? pid : null
  } catch {
    return null
  }
}
const procFile = (pid: number, f: string) => readFileSync(`/proc/${pid}/${f}`, 'utf8')
export const qemuPid = (c: RigConfig, p: RigPaths) => livePid(p.pid, (pid) => procFile(pid, 'comm').trim() === c.process)
export const tpmPid = (p: RigPaths) => livePid(p.tpmPid, (pid) => procFile(pid, 'cmdline').includes(p.tpmSock))

export async function waitFor(what: string, timeoutSec: number, check: () => boolean | Promise<boolean>, everySec = 5): Promise<void> {
  const end = Date.now() + timeoutSec * 1000
  while (Date.now() < end) {
    if (await check()) return
    await sleep(everySec * 1000)
  }
  throw new Error(`timed out after ${timeoutSec} s waiting for ${what}`)
}

/** Runs a daemon's starter (it forks and returns); its own error output goes into the error. */
function startDaemon(name: string, [cmd, args]: [string, string[]]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: daemonEnv(), stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}${err.trim() ? `: ${err.trim()}` : ''}`))))
  })
}

export function stopTpm(p: RigPaths): void {
  const pid = tpmPid(p)
  try {
    if (pid !== null) process.kill(pid, 'SIGTERM')
  } catch {
    // swtpm's AppArmor profile takes no signal from us; it ends on its own when QEMU lets go of it.
  }
}

const readOr = (file: string, none: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : none)

/**
 * Starts swtpm on a fresh live state copied from `from` (a saved state), or a blank TPM when there is none. The
 * live state is marked with the run's id, so only that run ever takes it back.
 */
export async function startTpm(c: RigConfig, p: RigPaths, from: string | null, opts: DaemonOpts = {}): Promise<void> {
  stopTpm(p)
  await waitFor('the old swtpm to exit', 10, () => tpmPid(p) === null, 0.2)
  rmSync(c.tpmDir, { recursive: true, force: true })
  mkdirSync(p.tpmState, { recursive: true, mode: 0o700 })
  if (from && existsSync(from)) cpSync(from, p.tpmState, { recursive: true })
  writeFileSync(p.tpmRunId, readOr(p.runId, ''))
  await startDaemon('swtpm', opts.blockStop ? stopBlocked('swtpm', swtpmArgs(p)) : ['swtpm', swtpmArgs(p)])
}

/** After QEMU stops: waits for swtpm to let go, then keeps its live state at `to`. */
export async function saveTpm(p: RigPaths, to: string): Promise<void> {
  await waitFor('swtpm to exit', 30, () => tpmPid(p) === null, 1)
  rmSync(to, { recursive: true, force: true })
  cpSync(p.tpmState, to, { recursive: true })
}

/** The newest change to any file in a folder, or null when it has none. */
function newest(dir: string): number | null {
  if (!existsSync(dir)) return null
  let best: number | null = null
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const t = e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs
    if (t !== null && (best === null || t > best)) best = t
  }
  return best
}

/**
 * Whether the live TPM state is this run's and changed after the run's saved copy: QEMU crashed, or the guest
 * stopped itself, so no clean stop saved it. A clean stop copies the live state, and the copy is the newer, so this
 * is then false. A live state started for another run (or a run with no id, from before ids) is never taken.
 */
export function liveTpmIsNewer(p: RigPaths): boolean {
  const id = readOr(p.runId, '')
  if (!id || readOr(p.tpmRunId, '') !== id) return false
  const live = newest(p.tpmState)
  if (live === null) return false
  const saved = newest(p.runTpm)
  return saved === null || live > saved
}

/**
 * Saves the live TPM state into the run when it is newer than the run's copy, so a crash or the guest's own stop
 * does not roll the TPM back (a rollback breaks TPM-bound sign-ins such as a PIN). Only while the machine is
 * stopped; true when it saved.
 */
export async function keepLiveTpm(c: RigConfig, p: RigPaths): Promise<boolean> {
  if (qemuPid(c, p) !== null || !existsSync(p.run) || !liveTpmIsNewer(p)) return false
  stopTpm(p)
  await saveTpm(p, p.runTpm)
  return true
}

/**
 * QEMU's whole command: its window's environment through `env`, the stop signals blocked, all inside `sg kvm` where
 * this process lacks the group (the block inside it: sg starts its shell with a clear signal mask).
 */
export function qemuCommand(c: RigConfig, p: RigPaths, m: Machine, opts: DaemonOpts = {}, kvmOpen?: boolean): [string, string[]] {
  const extra = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`)
  const argv: [string, string[]] = extra.length ? ['env', [...extra, 'qemu-system-x86_64', ...qemuArgs(c, p, m)]] : ['qemu-system-x86_64', qemuArgs(c, p, m)]
  return kvmWrapped(...(opts.blockStop ? stopBlocked(...argv) : argv), kvmOpen)
}

/** Starts QEMU as a daemon (it outlives the caller) with the clean environment; its pid. */
export async function startQemu(c: RigConfig, p: RigPaths, m: Machine, opts: DaemonOpts = {}): Promise<number | null> {
  mkdirSync(p.run, { recursive: true })
  try {
    await startDaemon('qemu-system-x86_64', qemuCommand(c, p, m, opts))
  } catch (e) {
    stopTpm(p)
    throw e
  }
  return qemuPid(c, p)
}
