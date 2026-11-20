import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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
    ovmfVars: join(OVMF, 'OVMF_VARS_4M.ms.fd')
  }
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
