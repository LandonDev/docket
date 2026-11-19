import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * The user's login shell: $SHELL, else zsh on macOS and bash elsewhere.
 * Every "ask the login shell" call (the PATH the CLIs live on, a build
 * command, a sign-in probe) goes through here, so a host without zsh
 * (Ubuntu) still finds what .profile puts on the PATH.
 *
 * `-lc` reads .zprofile/.zshenv (or .profile) but never .zshrc/.bashrc,
 * where many people put ~/.bun/bin on the PATH, so a job that runs a tool
 * by name (the release scripts, a batch shell step, a dev server, a build)
 * wraps its command in `withToolPath`: the usual tool dirs go first when
 * the PATH lacks them, and a PATH that has them is left as it is.
 *
 * Windows has no login shell. Command strings run in Git Bash when it is
 * installed (Claude Code needs it there anyway, and project scripts are
 * written for sh): `-lc` keeps the cwd and the arguments, and reads the
 * user's PATH from the Windows environment. Without it they run in cmd.exe.
 * Terminals and probes use PowerShell (pty-core.ts) and `where.exe`.
 */
export function loginShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync
): string {
  if (platform === 'win32') return gitBash(env, exists) ?? (env.ComSpec || 'cmd.exe')
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

/** Git for Windows' bash.exe, machine-wide or per user; null when neither is installed. */
export function gitBash(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | null {
  if (env.CLAUDE_CODE_GIT_BASH_PATH && exists(env.CLAUDE_CODE_GIT_BASH_PATH)) return env.CLAUDE_CODE_GIT_BASH_PATH
  const roots = [env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')]
  for (const root of roots) {
    if (!root) continue
    const bash = win32.join(root, 'Git', 'bin', 'bash.exe')
    if (exists(bash)) return bash
  }
  return null
}

/** How a command string is run: the shell, its argv for one command, and the spawn options that argv needs. */
export interface ShellSpec {
  file: string
  /** Reads POSIX sh text: `withToolPath`'s prelude, `"$@"`, `$VAR`. */
  posix: boolean
  /** The argv after `file` that runs `command` as written. */
  args(command: string): string[]
  /** windowsHide on win32 (a console window per command otherwise); cmd.exe takes its line verbatim. */
  options: { windowsHide?: boolean; windowsVerbatimArguments?: boolean }
}

/** The shell command strings run in: the login shell's `-lc`; on win32 Git Bash's, else cmd.exe's `/d /s /c`. */
export function commandShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync
): ShellSpec {
  const file = loginShell(env, platform, exists)
  if (platform !== 'win32') return { file, posix: true, args: (command) => ['-lc', command], options: {} }
  if (file.toLowerCase().endsWith('bash.exe')) return { file, posix: true, args: (command) => ['-lc', command], options: { windowsHide: true } }
  return { file, posix: false, args: (command) => ['/d', '/s', '/c', `"${command}"`], options: { windowsHide: true, windowsVerbatimArguments: true } }
}

/** A POSIX shell at `file` as a ShellSpec (`-lc`), for a caller that names its shell. */
export function posixShell(file: string): ShellSpec {
  return { file, posix: true, args: (command) => ['-lc', command], options: process.platform === 'win32' ? { windowsHide: true } : {} }
}

/** `command` as the shell should run it: behind `withToolPath` in a POSIX shell; as written in cmd.exe, whose PATH is the user's. */
export function shellLine(command: string, shell: ShellSpec, platform: NodeJS.Platform = process.platform): string {
  return shell.posix ? withToolPath(command, platform) : command
}

/**
 * The path of a command as the login shell resolves it, never a shell
 * function wrapping it: `whence -p` on zsh, `type -P` on bash, and
 * `command -v` where neither is known to exist.
 */
export function commandPathProbe(name: string, shell: string = loginShell()): string {
  const base = shell.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? shell
  if (base === 'zsh') return `whence -p ${name}`
  if (base === 'bash') return `type -P ${name}`
  return `command -v ${name}`
}

/**
 * The argv that prints a command's path: the login shell's probe, or on
 * win32 `where.exe` (the first line it prints is the one PATH and PATHEXT
 * pick; no shell function can stand in the way there).
 */
export function commandPathArgv(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'win32') return ['where.exe', [name]]
  const shell = loginShell(env, platform)
  return [shell, ['-lc', commandPathProbe(name, shell)]]
}

/** The dirs a tool usually lives in, in the order they should lead PATH. */
export function toolDirs(platform: NodeJS.Platform = process.platform): string[] {
  // ~/.local/bin on the Mac too: Muse Code's installer puts its launcher there.
  return platform === 'darwin'
    ? ['$HOME/.bun/bin', '/opt/homebrew/bin', '/usr/local/bin', '$HOME/.local/bin']
    : ['$HOME/.bun/bin', '$HOME/.local/bin']
}

/**
 * `command` behind a prelude that puts each of `toolDirs` on PATH when the
 * login shell's PATH lacks it, the first dir leading. Plain POSIX, so zsh,
 * bash and sh all read it.
 */
export function withToolPath(command: string, platform: NodeJS.Platform = process.platform): string {
  const dirs = toolDirs(platform).reverse().map((d) => `"${d}"`).join(' ')
  return `for d in ${dirs}; do case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac; done; export PATH; ${command}`
}

/**
 * `env` with PATH set to `value`. Windows spells the key `Path` and reads it
 * without regard to case, so a spread of process.env plus `PATH` would hand a
 * child two of them; every other spelling goes first.
 */
export function withPath(env: NodeJS.ProcessEnv, value: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out = { ...env }
  if (platform === 'win32') for (const key of Object.keys(out)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete out[key]
  out.PATH = value
  return out
}

/** The PATH of `env`, whatever its spelling (win32's `Path`). */
export function pathOf(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return env.PATH ?? ''
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (key && env[key]) || ''
}

// ── a program by name on win32 ────────────────────────────────────────

/** `name` on `env`'s PATH with PATHEXT, as Windows' own lookup finds it; null when absent. */
export function whichWin(name: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string | null {
  if (/[\\/]/.test(name)) return exists(name) ? name : null
  const exts = /\.[a-z0-9]+$/i.test(name) ? [''] : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of pathOf(env, 'win32').split(';')) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = win32.join(dir, name + ext.toLowerCase())
      if (exists(candidate)) return candidate
    }
  }
  return null
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** One argument as cmd.exe passes it on whole (cross-spawn's rules); a node_modules\.bin shim reads its line twice, so its arguments are escaped twice. */
export function cmdArgument(arg: string, twice = false): string {
  let out = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1')
  out = `"${out}"`.replace(CMD_META, '^$1')
  return twice ? out.replace(CMD_META, '^$1') : out
}

/**
 * The argv that starts `command` on win32: the program PATH and PATHEXT find
 * for it, and for a `.cmd` or `.bat` (an npm shim such as `npx.cmd`, which
 * Node will not start without a shell) cmd.exe with the line quoted for it.
 * The third value is `windowsVerbatimArguments`. Elsewhere `command` as given.
 */
export function windowsCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): [string, string[], boolean] {
  if (platform !== 'win32') return [command, args, false]
  const found = whichWin(command, env, exists) ?? command
  if (!/\.(cmd|bat)$/i.test(found)) return [found, args, false]
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(found)
  const line = [found.replace(CMD_META, '^$1'), ...args.map((a) => cmdArgument(a, twice))].join(' ')
  return [env.ComSpec || env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], true]
}
