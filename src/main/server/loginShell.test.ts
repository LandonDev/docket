import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cmdArgument, commandPathArgv, commandPathProbe, commandShell, loginShell, pathOf, posixShell, shellLine, whichWin, windowsCommand, withPath, withToolPath } from './loginShell'

describe('loginShell', () => {
  it('prefers $SHELL and falls back by platform', () => {
    expect(loginShell({ SHELL: '/usr/bin/fish' }, 'linux')).toBe('/usr/bin/fish')
    expect(loginShell({}, 'darwin')).toBe('/bin/zsh')
    expect(loginShell({}, 'linux')).toBe('/bin/bash')
  })
  it('probes a command path without shell functions in the way', () => {
    expect(commandPathProbe('codex', '/bin/zsh')).toBe('whence -p codex')
    expect(commandPathProbe('codex', '/bin/bash')).toBe('type -P codex')
    expect(commandPathProbe('codex', '/usr/bin/fish')).toBe('command -v codex')
  })
})

describe('withToolPath', () => {
  const run = (command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string =>
    execFileSync('/bin/sh', ['-c', withToolPath(command, platform)], { env, encoding: 'utf8' })

  it('puts the macOS tool dirs first, in order, when PATH lacks them', () => {
    expect(run('echo "$PATH"', 'darwin', { HOME: '/h', PATH: '/usr/bin:/bin' }).trim()).toBe(
      '/h/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/h/.local/bin:/usr/bin:/bin'
    )
  })

  it("puts Muse Code's install dir (~/.local/bin) on the PATH on both platforms", () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(run('echo "$PATH"', platform, { HOME: '/h', PATH: '/usr/bin:/bin' }).split(':')).toContain('/h/.local/bin')
    }
  })

  it('puts the Linux tool dirs first elsewhere', () => {
    expect(run('echo "$PATH"', 'linux', { HOME: '/h', PATH: '/usr/bin:/bin' }).trim()).toBe('/h/.bun/bin:/h/.local/bin:/usr/bin:/bin')
  })

  it('repeats no dir the PATH already has, so a full PATH is unchanged', () => {
    const path = '/h/.bun/bin:/h/.local/bin:/usr/bin'
    expect(run('echo "$PATH"', 'linux', { HOME: '/h', PATH: path }).trim()).toBe(path)
    expect(run('echo "$PATH"', 'linux', { HOME: '/h', PATH: '/usr/bin:/h/.local/bin' }).trim()).toBe('/h/.bun/bin:/usr/bin:/h/.local/bin')
  })

  it('leaves the command and its arguments alone', () => {
    const out = execFileSync('/bin/sh', ['-c', withToolPath('printf "%s|" "$@"', 'linux'), 'sh', 'a b', 'c'], {
      env: { HOME: '/h', PATH: '/usr/bin:/bin' },
      encoding: 'utf8'
    })
    expect(out).toBe('a b|c|')
  })
})

describe('the command shell on win32', () => {
  const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' }
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'

  it('is Git Bash with -lc when Git for Windows is installed, hidden', () => {
    const sh = commandShell(env, 'win32', (p) => p === gitBash)
    expect(sh.file).toBe(gitBash)
    expect(sh.posix).toBe(true)
    expect(sh.args('bun run build')).toEqual(['-lc', 'bun run build'])
    expect(sh.options).toEqual({ windowsHide: true })
    expect(shellLine('bun run build', sh, 'win32')).toBe(withToolPath('bun run build', 'win32'))
  })

  it("finds a per-user Git install, and Claude Code's own setting first", () => {
    const user = 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
    expect(loginShell(env, 'win32', (p) => p === user)).toBe(user)
    expect(loginShell({ ...env, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\bash.exe' }, 'win32', () => true)).toBe('D:\\git\\bash.exe')
  })

  it('is cmd.exe with the line verbatim and run as written when there is no Git Bash', () => {
    const sh = commandShell(env, 'win32', () => false)
    expect(sh.file).toBe(env.ComSpec)
    expect(sh.posix).toBe(false)
    expect(sh.args('bun run a && bun run b')).toEqual(['/d', '/s', '/c', '"bun run a && bun run b"'])
    expect(sh.options).toEqual({ windowsHide: true, windowsVerbatimArguments: true })
    expect(shellLine('bun run a', sh, 'win32')).toBe('bun run a')
  })

  it('is the login shell with -lc and no extra options elsewhere', () => {
    const sh = commandShell({ SHELL: '/bin/zsh' }, 'darwin')
    expect([sh.file, sh.args('x'), sh.options]).toEqual(['/bin/zsh', ['-lc', 'x'], {}])
    expect(posixShell('/bin/sh').args('x')).toEqual(['-lc', 'x'])
  })

  it('probes a path with where.exe on win32 and the login shell elsewhere', () => {
    expect(commandPathArgv('code', {}, 'win32')).toEqual(['where.exe', ['code']])
    expect(commandPathArgv('code', { SHELL: '/bin/bash' }, 'linux')).toEqual(['/bin/bash', ['-lc', 'type -P code']])
    expect(commandPathProbe('codex', gitBash)).toBe('type -P codex')
  })
})

describe('PATH on win32', () => {
  it("replaces Windows' Path spelling instead of adding a second key", () => {
    const env = withPath({ Path: 'C:\\a', Foo: '1' }, 'C:\\b', 'win32')
    expect(env).toEqual({ PATH: 'C:\\b', Foo: '1' })
    expect(pathOf({ Path: 'C:\\a' }, 'win32')).toBe('C:\\a')
  })

  it('leaves other keys alone off win32', () => {
    expect(withPath({ Path: 'x', PATH: '/a' }, '/b', 'linux')).toEqual({ Path: 'x', PATH: '/b' })
    expect(pathOf({ Path: 'x' }, 'linux')).toBe('')
  })
})

describe('windowsCommand', () => {
  const env = { PATH: 'C:\\npm;C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' }

  it('is the command as given off win32', () => {
    expect(windowsCommand('npx', ['-y', 'x'], env, 'linux')).toEqual(['npx', ['-y', 'x'], false])
  })

  it('resolves an .exe by PATH and PATHEXT and starts it directly', () => {
    expect(windowsCommand('uvx', ['srv'], env, 'win32', (p) => p === 'C:\\bin\\uvx.exe')).toEqual(['C:\\bin\\uvx.exe', ['srv'], false])
    expect(whichWin('uvx', env, () => false)).toBeNull()
  })

  it('starts a .cmd shim through cmd.exe with every argument quoted for it', () => {
    const [file, args, verbatim] = windowsCommand('npx', ['-y', '@scope/pkg', 'a b', 'x&y'], env, 'win32', (p) => p === 'C:\\npm\\npx.cmd')
    expect(file).toBe(env.ComSpec)
    expect(verbatim).toBe(true)
    expect(args).toEqual(['/d', '/s', '/c', '"C:\\npm\\npx.cmd ^"-y^" ^"@scope/pkg^" ^"a^ b^" ^"x^&y^""'])
  })

  it('escapes the arguments of a node_modules\\.bin shim twice', () => {
    expect(cmdArgument('a b', true)).toBe('^^^"a^^^ b^^^"')
    expect(cmdArgument('say "hi"')).toBe('^"say^ \\^"hi\\^"^"')
  })
})
