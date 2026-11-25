/**
 * The pure parts of scripts/e2e-vm-screen-mac.ts (M8 of the VM screen plan): the isolated instance's environment,
 * the tools it reads, the rules it starts and holds under, and the one line a Mac reads to pair over `ssh -L`.
 */

/** The file whose arrival ends the hold: the Mac side is done. */
export const DONE_FILE = '/tmp/vm-screen-mac/DONE'

/** The rig rule's memory line: no machine starts while the agents' slice holds this much anonymous memory. */
export const ANON_MAX_BYTES = 38 * 1024 ** 3

/** A pairing key's grants: watch, drive and size the VM, and its Settings. */
export const PAIR_CAPS = ['read', 'operate', 'approve', 'admin'] as const

/**
 * The instance's environment: the parent's, less every mark of the live app and the box's own sign-ins, with its
 * own userData, home, listener port and Work's throwaway machine (`throwawayHost`, machine/config.ts). The
 * scratch machine's three variables pass through from the parent, which the guard has checked.
 */
export function instanceEnv(parent: NodeJS.ProcessEnv, o: { root: string; data: string; home: string; remotePort: number; exe: string | null; uid: number }): Record<string, string> {
  const runtime = parent.XDG_RUNTIME_DIR
  const kept = Object.entries(parent).filter(
    (e): e is [string, string] =>
      e[1] !== undefined && !/^(TEMP_CODE_|CLAUDE|ANTHROPIC_|CODEX_)/.test(e[0]) && e[0] !== 'ELECTRON_RUN_AS_NODE' && !(e[0] === 'XDG_RUNTIME_DIR' && runtime && !runtime.endsWith(`/${o.uid}`))
  )
  return {
    ...Object.fromEntries(kept),
    HOME: o.home,
    TMPDIR: `${o.root}/tmp`,
    TEMP_CODE_USER_DATA: o.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(o.remotePort),
    TEMP_CODE_ALIAX_DATA_DIR: `${o.data}/aliax`,
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WARM_HARNESS: '0',
    TEMP_CODE_WORK_ROOT: `${o.home}/work`,
    ...(o.exe ? { TEMP_CODE_WINVM_EXE: o.exe } : {}),
    CLAUDE_CONFIG_DIR: `${o.home}/.claude`,
    CODEX_HOME: `${o.home}/.codex`,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    ALIAX_CREDENTIAL_BACKEND: 'file',
    WINVM_THROWAWAY: '1',
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ELECTRON_DISABLE_SANDBOX: '1'
  }
}

interface ToolState {
  tools: Record<string, { ok?: boolean; dir?: string }>
  [k: string]: unknown
}

/**
 * The instance's work-tools state: the box's tools, and the run's own cache's for what it holds (the display
 * driver, installed once ahead so no run downloads its 877 MB image).
 */
export function mergeToolStates(box: ToolState, cache: ToolState | null): ToolState {
  const own = Object.fromEntries(Object.entries(cache?.tools ?? {}).filter(([, t]) => t.ok))
  return { ...box, tools: { ...box.tools, ...own } }
}

/** `anon` of a cgroup's memory.stat, in bytes; null when the file has none. */
export function anonBytes(memoryStat: string): number | null {
  const m = /^anon (\d+)$/m.exec(memoryStat)
  return m ? Number(m[1]) : null
}

/** QEMU processes of another scratch machine (a rig, or a standing machine outside the owner's folder): one at a time. */
export function otherScratchVms(procs: readonly { pid: number; comm: string; cmdline: string }[]): number[] {
  return procs.filter((p) => p.comm === 'tc-win11' || (p.comm === 'tc-win11-stand' && !p.cmdline.includes('/srv/agents/win-vm/'))).map((p) => p.pid)
}

/** Why the hold ends now, or null: the Mac's DONE, else the run's 30 minutes (the watch ends it apart, at once). */
export function holdEnd(o: { done: boolean; now: number; deadline: number }): string | null {
  if (o.done) return 'the Mac side is done'
  if (o.now >= o.deadline) return 'the run reached its 30 minutes'
  return null
}

/** A pairing code's life in whole minutes: the run's time left, at least 1 and at most 30. */
export function pairMinutes(now: number, deadline: number): number {
  return Math.max(1, Math.min(30, Math.floor((deadline - now) / 60_000)))
}

/**
 * What the Mac needs, as one JSON line: the tunnel (the same port on both ends, so the origin the key is saved
 * under is the one the instance answers on), the code and its link, and how long the box holds.
 */
export function pairLine(o: { port: number; code: string; codeExpires: number; holdsUntil: number; vm: Record<string, unknown> }): string {
  const origin = `http://127.0.0.1:${o.port}`
  return JSON.stringify({
    m8: 'pair',
    ssh: `ssh -N -L ${o.port}:127.0.0.1:${o.port} box`,
    origin,
    code: o.code,
    link: `${origin}/pair#${o.code}`,
    codeExpires: new Date(o.codeExpires).toISOString(),
    holdsUntil: new Date(o.holdsUntil).toISOString(),
    done: `ssh box touch ${DONE_FILE}`,
    vm: o.vm
  })
}
