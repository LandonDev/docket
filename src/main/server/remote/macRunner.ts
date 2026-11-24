import { MAC_RUN_OUTPUT_CAP, type MacRunResult } from '@shared/contract-macbridge'
import { loginShell, pathOf, windowsCommand } from '../loginShell'
import { spawnLowered } from '../childPriority'
import { adoptTree, killTree, treeSpawnOptions } from '../procTree'
import { trackChild } from '../spawnBudget'
import { HeadTailOutput, ProgressPacer } from './peerStreams'

/**
 * The Mac bridge's command runner (docs/box.md "The Mac bridge"). Only ever
 * reached after the person at the Mac allowed the exact argv and cwd. The
 * command runs through the login shell (loginShell.ts) so the Mac's PATH
 * (Homebrew, …) is there, with no stdin, in a process group of its own, and
 * an environment scrubbed down to who and where: nothing of the app's own
 * (no TEMP_CODE_*, no provider keys, no ELECTRON_*). Past the timeout or on
 * stop() the whole group goes: SIGTERM, then SIGKILL after a grace. Output
 * past MAC_RUN_OUTPUT_CAP keeps its head and tail (peerStreams.ts
 * HeadTailOutput), and `onOutput` hears it line by line while it runs
 * (ProgressPacer: one frame per 100 ms at most, 64 KiB each).
 *
 * The same runner serves a Windows host's bridge (docs/agents/windows-host.md
 * "A Windows host linked to the box"): there the shell is Git Bash, else
 * cmd.exe (loginShell.ts), the environment keeps Windows' own variables and
 * the user's Path, and the "group" is the child's Job Object (procTree.ts).
 */

const KEEP_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ']
const BASE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
/** Windows' own variables (a child fails without SystemRoot) and the profile's folders; no secret lives in any of them. */
const KEEP_ENV_WIN = [
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'TZ'
]
export const KILL_GRACE_MS = 2_000

export function scrubbedEnv(
  src: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const out: Record<string, string> = {}
  if (platform === 'win32') {
    // Windows spells its keys as it likes (Path, SYSTEMROOT); a plain object here is case-blind no more.
    const byLower = new Map(Object.keys(src).map((k) => [k.toLowerCase(), k]))
    for (const key of KEEP_ENV_WIN) {
      const have = byLower.get(key.toLowerCase())
      if (have && src[have]) out[key] = src[have] as string
    }
    // Windows has one user environment and no login shell to rebuild PATH from: the user's own.
    out.Path = pathOf(src, 'win32')
  } else {
    for (const key of KEEP_ENV) if (src[key]) out[key] = src[key] as string
    out.PATH = BASE_PATH
  }
  out.TERM = 'dumb'
  out.NO_COLOR = '1'
  return out
}

/** The login shell's argv for a command: argv runs as given ("$@", no word splitting), a command string as the shell reads it. */
export function shellArgv(
  spec: { argv?: string[]; command?: string },
  shell: string = loginShell()
): string[] {
  if (spec.argv?.length) return [shell, '-lc', 'exec "$@"', 'mac-bridge', ...spec.argv]
  if (spec.command) return [shell, '-lc', spec.command]
  throw new Error('mac.run needs argv or command')
}

/** What spawn needs for a command on this host: the file, its args, and the Windows-only options. */
export interface ShellCall {
  file: string
  args: string[]
  options: { windowsHide?: boolean; windowsVerbatimArguments?: boolean }
}

/**
 * The spawn for a command: the login shell's `-lc` off Windows (shellArgv);
 * on Windows Git Bash's `-lc` the same way, or with no Git cmd.exe: argv
 * through cross-spawn's quoting (an npm `.cmd` shim needs cmd.exe), a command
 * line as written.
 */
export function shellCall(
  spec: { argv?: string[]; command?: string },
  shell?: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): ShellCall {
  if (platform !== 'win32') {
    const [file, ...args] = shellArgv(spec, shell)
    return { file, args, options: {} }
  }
  const file = shell ?? loginShell(env, 'win32')
  if (/bash(\.exe)?$/i.test(file)) {
    const [f, ...args] = shellArgv(spec, file)
    return { file: f, args, options: { windowsHide: true } }
  }
  if (spec.argv?.length) {
    const [f, args, verbatim] = windowsCommand(spec.argv[0], spec.argv.slice(1), env, 'win32')
    return { file: f, args, options: { windowsHide: true, ...(verbatim ? { windowsVerbatimArguments: true } : {}) } }
  }
  if (spec.command) return { file, args: ['/d', '/s', '/c', `"${spec.command}"`], options: { windowsHide: true, windowsVerbatimArguments: true } }
  throw new Error('mac.run needs argv or command')
}

/** Signal a command's tree (its group off Windows, its job and taskkill on Windows), else the child alone. */
export function signalTree(child: { pid?: number; kill?: (sig: NodeJS.Signals) => void }, sig: NodeJS.Signals): void {
  if (child.pid && killTree(child.pid, sig)) return
  try {
    child.kill?.(sig)
  } catch {
    /* gone */
  }
}

export interface RunningCommand {
  result: Promise<MacRunResult>
  /** Kill the process group (a denial after the start, the person pressed Stop). */
  stop: () => void
  pid: number | undefined
}

export function runMacCommand(opts: {
  argv?: string[]
  command?: string
  cwd: string
  timeoutMs: number
  outputCap?: number
  shell?: string
  env?: Record<string, string>
  /** The output so far, as progress frames (peerStreams.ts ProgressPacer); the last one comes before the result. */
  onOutput?: (chunk: string, skipped: number) => void
  progressMs?: number
}): RunningCommand {
  const cap = opts.outputCap ?? MAC_RUN_OUTPUT_CAP
  const { file, args, options } = shellCall(opts, opts.shell)
  const startedAt = Date.now()
  // A command run for a thread runs below the server (childPriority.ts), as its own Bash calls do.
  const child = adoptTree(
    trackChild(
      spawnLowered('job')(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? scrubbedEnv(),
        ...treeSpawnOptions(),
        ...options,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
  )
  // The first quarter of the cap is the head, the rest the tail (1 MiB + 3 MiB at 4 MiB).
  const output = new HeadTailOutput(Math.floor(cap / 4), cap - Math.floor(cap / 4))
  const pacer = opts.onOutput
    ? new ProgressPacer({
        send: opts.onOutput,
        ...(opts.progressMs !== undefined ? { intervalMs: opts.progressMs } : {})
      })
    : null
  let timedOut = false
  let killTimer: NodeJS.Timeout | null = null
  const killGroup = (): void => {
    if (killTimer) return
    const signal = (sig: NodeJS.Signals): void => signalTree(child, sig)
    signal('SIGTERM')
    killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS)
    killTimer.unref()
  }
  const take = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    output.push(stream, chunk)
    pacer?.push(stream, chunk)
  }
  child.stdout?.on('data', take('stdout'))
  child.stderr?.on('data', take('stderr'))
  const timer = setTimeout(() => {
    timedOut = true
    killGroup()
  }, opts.timeoutMs)
  timer.unref()
  const result = new Promise<MacRunResult>((resolve) => {
    let done = false
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, extra = ''): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      // The shell is gone; anything it left in the group goes with it.
      if (child.pid) killTree(child.pid, 'SIGKILL')
      if (killTimer) clearTimeout(killTimer)
      pacer?.end()
      resolve({
        exitCode,
        signal,
        stdout: output.text('stdout'),
        stderr: output.text('stderr') + extra,
        truncated: output.truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(output.truncated ? { droppedBytes: output.dropped } : {})
      })
    }
    // A background child of the command holding the pipes open would keep
    // 'close' from firing: once the shell exits, the rest of its group goes.
    child.on('exit', () => {
      if (child.pid) killTree(child.pid, 'SIGKILL')
    })
    child.on('error', (e) => finish(null, null, e.message))
    child.on('close', (code, signal) => finish(code, signal))
  })
  return { result, stop: killGroup, pid: child.pid }
}
