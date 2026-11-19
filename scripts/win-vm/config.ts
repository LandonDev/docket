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

export interface RigConfig {
  dir: string
  cpus: number
  memory: string
  diskSize: string
  sshPort: number
  cdpPort: number
  /** swtpm's AppArmor profile lets it write under /tmp only, so its live state sits there and is copied back on a clean stop. */
  tpmDir: string
  ovmfCode: string
  ovmfVars: string
}

export function rigConfig(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0): RigConfig {
  return {
    dir: env.WINVM_DIR || '/srv/agents/win-vm',
    cpus: Number(env.WINVM_CPUS || 8),
    memory: env.WINVM_MEM || '16G',
    diskSize: env.WINVM_DISK || '128G',
    sshPort: Number(env.WINVM_SSH_PORT || 22220),
    cdpPort: Number(env.WINVM_CDP_PORT || 9333),
    tpmDir: env.WINVM_TPM_DIR || `/tmp/win-vm-tpm-${uid}`,
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

/** Where everything of the rig lives under its folder. */
export function rigPaths(c: RigConfig) {
  const base = join(c.dir, 'base')
  const run = join(c.dir, 'run')
  return {
    iso: join(c.dir, 'iso', ISO_NAME),
    payload: join(c.dir, 'payload'),
    keys: join(c.dir, 'keys'),
    key: join(c.dir, 'keys', 'id_ed25519'),
    shots: join(c.dir, 'shots'),
    snapshots: join(c.dir, 'snapshots'),
    build: join(c.dir, 'build'),
    base,
    baseDisk: join(base, 'disk.qcow2'),
    baseVars: join(base, 'OVMF_VARS.fd'),
    baseTpm: join(base, 'tpm'),
    secrets: join(base, 'secrets.json'),
    knownHosts: join(base, 'known_hosts'),
    baseReady: join(base, 'READY'),
    run,
    runDisk: join(run, 'disk.qcow2'),
    runVars: join(run, 'OVMF_VARS.fd'),
    runTpm: join(run, 'tpm'),
    qmp: join(run, 'qmp.sock'),
    pid: join(run, 'qemu.pid'),
    tpmState: join(c.tpmDir, 'state'),
    tpmSock: join(c.tpmDir, 'swtpm.sock'),
    tpmPid: join(c.tpmDir, 'swtpm.pid'),
    tpmLog: join(c.tpmDir, 'swtpm.log')
  }
}
export type RigPaths = ReturnType<typeof rigPaths>
