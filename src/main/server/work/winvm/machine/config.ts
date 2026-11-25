import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Microsoft's own download of Windows 11 Enterprise Evaluation, 25H2, x64, en-US (the Evaluation Center's link). */
export const ISO_URL = 'https://go.microsoft.com/fwlink/?linkid=2334167&clcid=0x409&culture=en-us&country=us'
export const ISO_NAME = 'win11-enterprise-eval.iso'

/** Git for Windows, pinned: Claude Code's Bash tool and TempCode's command strings need Git Bash. */
export const GIT = {
  name: 'Git-2.56.1-64-bit.exe',
  url: 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-64-bit.exe',
  sha256: 'c330c72e10b408cc39994bfefdb63542b0d93d21699325c3e0bd874af8a5a559'
}

/** The two guest users: an admin for setup, and the standard user that models a locked-down PC and is logged on. */
export const ADMIN_USER = 'tcadmin'
export const STANDARD_USER = 'tcuser'

const OVMF = '/usr/share/OVMF'

/**
 * Two machines run from the one read-only base image. `rig` is the proof rig the build threads share: a fresh
 * overlay per `up`. `standing` is the machine Work threads drive: its own lasting overlay, firmware variables,
 * lock, QMP socket and ports, so the two run at once and never share a file that changes.
 */
export type Instance = 'rig' | 'standing'
export const INSTANCES: readonly Instance[] = ['rig', 'standing']

const DEFAULTS: Record<Instance, { sub: string; cpus: number; memory: string; sshPort: number; cdpPort: number | null; process: string }> = {
  rig: { sub: '', cpus: 8, memory: '16G', sshPort: 22220, cdpPort: 9333, process: 'tc-win11' },
  // No CDP forward: everything of the standing machine goes over SSH. The process name fits /proc's 15-character comm.
  standing: { sub: 'standing', cpus: 6, memory: '8G', sshPort: 22230, cdpPort: null, process: 'tc-win11-stand' }
}

export function instanceName(name: string | undefined): Instance {
  if (name === undefined || name === '') return 'rig'
  if ((INSTANCES as readonly string[]).includes(name)) return name as Instance
  throw new Error(`no instance ${JSON.stringify(name)} (${INSTANCES.join(' or ')})`)
}

export interface RigConfig {
  instance: Instance
  /** The folder of both machines: the ISO, the base image and the keys are shared; each instance has its own folder below. */
  root: string
  /** This instance's own folder: the root for the rig, root/standing for the standing machine. */
  dir: string
  /** QEMU's process name, by which a pid file is checked to still name this machine. */
  process: string
  cpus: number
  memory: string
  diskSize: string
  sshPort: number
  /** The port forwarded to the same port in the guest; none for the standing machine. */
  cdpPort: number | null
  /**
   * swtpm's live state. Its AppArmor profile lets it write under /tmp only (on this box the agents' home is not
   * under /home), so the live state sits there and the lasting copy is the instance's run/tpm, saved at every stop.
   */
  tpmDir: string
  ovmfCode: string
  ovmfVars: string
  /** The disk's cache mode when not QEMU's default: `unsafe` on a throwaway rig alone (`diskCacheOf`). */
  diskCache: 'unsafe' | null
}

export function rigConfig(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0, instance: Instance = 'rig'): RigConfig {
  const d = DEFAULTS[instance]
  const root = env.WINVM_DIR || '/srv/agents/win-vm'
  const cdp = env.WINVM_CDP_PORT ? Number(env.WINVM_CDP_PORT) : d.cdpPort
  return {
    instance,
    root,
    dir: d.sub ? join(root, d.sub) : root,
    process: d.process,
    cpus: Number(env.WINVM_CPUS || d.cpus),
    memory: env.WINVM_MEM || d.memory,
    diskSize: env.WINVM_DISK || '128G',
    sshPort: Number(env.WINVM_SSH_PORT || d.sshPort),
    cdpPort: instance === 'rig' ? cdp : null,
    tpmDir: env.WINVM_TPM_DIR || `/tmp/win-vm-tpm-${uid}${d.sub ? `-${d.sub}` : ''}`,
    ovmfCode: join(OVMF, 'OVMF_CODE_4M.secboot.fd'),
    ovmfVars: join(OVMF, 'OVMF_VARS_4M.ms.fd'),
    diskCache: diskCacheOf(env, uid, instance)
  }
}

/**
 * `WINVM_DISK_CACHE=unsafe`: the disk's writes stay in the host's page cache and QEMU drops the guest's
 * flushes, so Windows booting on a fresh overlay does not storm the box's one NVMe (a scratch boot's flushes
 * froze the live app for 82 s on 2026-11-24). A crash of the host loses that disk, so only a throwaway rig may
 * ask: a scratch root, TPM folder and port (`scratchMachineRefusal`). The standing machine keeps its disk and
 * never reads it.
 */
function diskCacheOf(env: NodeJS.ProcessEnv, uid: number, instance: Instance): 'unsafe' | null {
  const asked = env.WINVM_DISK_CACHE
  if (!asked || instance === 'standing') return null
  if (asked !== 'unsafe') throw new Error(`WINVM_DISK_CACHE ${asked}: the one mode it takes is unsafe`)
  const why = scratchMachineRefusal(env, uid)
  if (why) throw new Error(`WINVM_DISK_CACHE=unsafe is for a throwaway rig: ${why}`)
  return 'unsafe'
}

/**
 * The environment QEMU and swtpm start with. They are meant to outlive the call that starts them, and the
 * host's process guard (src/main/server/processGuard.ts) kills a call's leftovers by the marks in their
 * environment (TEMP_CODE_THREAD, TEMP_CODE_CALL, CLAUDE_PID, …), so they carry none, and no tokens either.
 */
export function daemonEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: env.HOME ?? '/', LANG: 'C.UTF-8' }
}

/** A snapshot's name: a plain folder name under snapshots/, never `.` or `..` or a path, nor `*.part` (a snapshot being made). */
export function snapshotName(name: string | undefined): string {
  if (!name || !/^[A-Za-z0-9_][\w.-]*$/.test(name) || name.endsWith('.part')) throw new Error(`bad snapshot name ${JSON.stringify(name ?? '')} (letters, digits, . _ -)`)
  return name
}

/** Where everything of a machine lives: the shared files under the root, the instance's own under its folder. */
export function rigPaths(c: RigConfig) {
  const base = join(c.root, 'base')
  const run = join(c.dir, 'run')
  return {
    iso: join(c.root, 'iso', ISO_NAME),
    payload: join(c.root, 'payload'),
    keys: join(c.root, 'keys'),
    key: join(c.root, 'keys', 'id_ed25519'),
    build: join(c.root, 'build'),
    base,
    baseDisk: join(base, 'disk.qcow2'),
    baseVars: join(base, 'OVMF_VARS.fd'),
    baseTpm: join(base, 'tpm'),
    secrets: join(base, 'secrets.json'),
    baseReady: join(base, 'READY'),
    // Each instance's own: ssh's accept-new writes its known hosts, so the rig keeps the one it always had.
    knownHosts: c.instance === 'rig' ? join(base, 'known_hosts') : join(c.dir, 'known_hosts'),
    lock: join(c.dir, '.lock'),
    shots: join(c.dir, 'shots'),
    snapshots: join(c.dir, 'snapshots'),
    run,
    runDisk: join(run, 'disk.qcow2'),
    runVars: join(run, 'OVMF_VARS.fd'),
    runTpm: join(run, 'tpm'),
    /** A run's id, new with each fresh overlay; the live TPM state carries the id of the run it was started for. */
    runId: join(run, 'ID'),
    tpmRunId: join(c.tpmDir, 'run-id'),
    qmp: join(run, 'qmp.sock'),
    pid: join(run, 'qemu.pid'),
    tpmState: join(c.tpmDir, 'state'),
    tpmSock: join(c.tpmDir, 'swtpm.sock'),
    tpmPid: join(c.tpmDir, 'swtpm.pid'),
    tpmLog: join(c.tpmDir, 'swtpm.log')
  }
}
export type RigPaths = ReturnType<typeof rigPaths>

/**
 * What stands on the base image and a rebuild would corrupt: the rig's snapshots and the standing machine's
 * disk (an overlay on the base). `install` refuses while any is there.
 */
export function onTheBase(root: string): string[] {
  const rig = rigPaths(rigConfig({ WINVM_DIR: root }, 0, 'rig'))
  const standing = rigPaths(rigConfig({ WINVM_DIR: root }, 0, 'standing'))
  const snapshots = existsSync(rig.snapshots) ? readdirSync(rig.snapshots).filter((n) => existsSync(join(rig.snapshots, n, 'FROM'))) : []
  return [...snapshots.map((n) => `snapshot ${n}`), ...(existsSync(standing.runDisk) ? [`the standing machine's disk (${standing.runDisk})`] : [])]
}

/**
 * The locks a command holds, outermost first, as `flock -o` takes them (-o: not handed down to QEMU, which
 * outlives the command). Each instance has its own; `install` rebuilds the base both stand on, so it takes both.
 */
export function locksFor(cmd: string, c: RigConfig): string[] {
  const lockOf = (i: Instance) => rigPaths(rigConfig({ WINVM_DIR: c.root }, 0, i)).lock
  return cmd === 'install' ? [lockOf('standing'), lockOf('rig')] : [lockOf(c.instance)]
}

/** The owner's machines: the root both live under, and the ports their guests' SSH answers on. */
const OWNER_ROOT = '/srv/agents/win-vm'
const OWNER_PORTS = [DEFAULTS.rig.sshPort, DEFAULTS.standing.sshPort]

/**
 * Why a script that starts a machine may not run with this environment, or null. With any of the three unset a
 * `standing` machine's folder, TPM folder and SSH port are the owner's, and `startTpm` clears the TPM folder it
 * is given. So a bench or a proof names a scratch root (with `base` and `keys` linked in), a TPM folder and a
 * port of its own, and calls this before anything else.
 */
export function scratchMachineRefusal(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0, real: (path: string) => string = realOrSelf): string | null {
  const missing = ['WINVM_DIR', 'WINVM_TPM_DIR', 'WINVM_SSH_PORT'].filter((k) => !env[k])
  if (missing.length) return `${missing.join(', ')} not set: the machine would be the owner's`
  const root = real(resolve(env.WINVM_DIR!))
  const owner = real(OWNER_ROOT)
  if (root === owner || root.startsWith(`${owner}/`)) return `WINVM_DIR ${env.WINVM_DIR} is the owner's machines' folder`
  const tpm = resolve(env.WINVM_TPM_DIR!)
  if (tpm === `/tmp/win-vm-tpm-${uid}` || tpm.endsWith('-standing')) return `WINVM_TPM_DIR ${env.WINVM_TPM_DIR} is the owner's TPM folder`
  const port = Number(env.WINVM_SSH_PORT)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return `WINVM_SSH_PORT ${env.WINVM_SSH_PORT} is not a port`
  if (OWNER_PORTS.includes(port)) return `WINVM_SSH_PORT ${port} is the owner's machine's`
  return null
}

/**
 * `WINVM_THROWAWAY=1`: an isolated instance's keeper runs its standing machine as a throwaway (qemu.ts), for a
 * proof the live app must never feel (scripts/e2e-vm-screen-mac.ts). Granted only on a scratch machine whose root
 * is in memory, under /dev/shm; anywhere else the switch is refused and the machine is the plain one.
 */
export function throwawayHost(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0, real: (path: string) => string = realOrSelf): { throwaway: boolean; refused: string | null } {
  if (env.WINVM_THROWAWAY !== '1') return { throwaway: false, refused: null }
  const why = scratchMachineRefusal(env, uid, real) ?? (real(resolve(env.WINVM_DIR!)).startsWith('/dev/shm/') ? null : `WINVM_DIR ${env.WINVM_DIR} is not under /dev/shm`)
  return why ? { throwaway: false, refused: why } : { throwaway: true, refused: null }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** For a script's first line: exits with the refusal, so nothing of the owner's machine is ever opened. */
export function requireScratchMachine(env: NodeJS.ProcessEnv = process.env): void {
  const why = scratchMachineRefusal(env)
  if (!why) return
  console.error(`refused: ${why}. Set WINVM_DIR (a scratch root with base and keys linked in), WINVM_TPM_DIR and WINVM_SSH_PORT.`)
  process.exit(2)
}
