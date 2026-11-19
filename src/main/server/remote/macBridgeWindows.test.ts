import { describe, expect, it } from 'vitest'
import { alwaysAsks, coversHome, hostPath, programOf, runOffer } from './macBridgeRules'
import { scrubbedEnv, shellCall } from './macRunner'

// The bridge on a Windows host (docs/agents/windows-host.md "A Windows host linked to the box"),
// with the platform injected: these run on Linux and macOS too.

const HOME = 'C:\\Users\\tc'
const W = 'win32' as const
const asks = (spec: { argv?: string[]; command?: string; cwd?: string }): string | null =>
  alwaysAsks({ ...spec, cwd: spec.cwd ?? 'C:\\Users\\tc\\src\\app' }, HOME, W)

describe('scrubbedEnv on Windows', () => {
  it("keeps Windows' own variables and the user's Path, whatever their case, and drops every secret", () => {
    const env = scrubbedEnv(
      {
        SYSTEMROOT: 'C:\\Windows',
        USERPROFILE: HOME,
        APPDATA: `${HOME}\\AppData\\Roaming`,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        Path: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32',
        TEMP_CODE_USER_DATA: 'C:\\x',
        ANTHROPIC_API_KEY: 'sk',
        GITHUB_TOKEN: 't',
        ELECTRON_RUN_AS_NODE: '1'
      },
      W
    )
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.USERPROFILE).toBe(HOME)
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD')
    expect(env.Path).toBe('C:\\Program Files\\Git\\cmd;C:\\Windows\\System32')
    expect(env.PATH).toBeUndefined()
    for (const k of ['TEMP_CODE_USER_DATA', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'ELECTRON_RUN_AS_NODE'])
      expect(env[k]).toBeUndefined()
  })
})

describe('shellCall', () => {
  it('runs through Git Bash the way the Mac runs through its login shell, hidden', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    expect(shellCall({ argv: ['git', 'status'] }, bash, W)).toEqual({
      file: bash,
      args: ['-lc', 'exec "$@"', 'mac-bridge', 'git', 'status'],
      options: { windowsHide: true }
    })
    expect(shellCall({ command: 'ls | wc -l' }, bash, W).args).toEqual(['-lc', 'ls | wc -l'])
  })

  it('without Git, a command line goes to cmd.exe as written', () => {
    expect(shellCall({ command: 'dir /b && echo ok' }, 'C:\\Windows\\System32\\cmd.exe', W)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"dir /b && echo ok"'],
      options: { windowsHide: true, windowsVerbatimArguments: true }
    })
  })

  it('off Windows it is the login shell, as before', () => {
    expect(shellCall({ argv: ['ls'] }, '/bin/zsh', 'darwin')).toEqual({
      file: '/bin/zsh',
      args: ['-lc', 'exec "$@"', 'mac-bridge', 'ls'],
      options: {}
    })
  })
})

describe('hostPath on Windows', () => {
  it('reads ~ with either slash and takes drive paths with either slash', () => {
    expect(hostPath('~', HOME, W)).toBe(HOME)
    expect(hostPath('~\\Documents\\a.txt', HOME, W)).toBe('C:\\Users\\tc\\Documents\\a.txt')
    expect(hostPath('~/src', HOME, W)).toBe('C:\\Users\\tc\\src')
    expect(hostPath('C:/Users/tc/src/../notes', HOME, W)).toBe('C:\\Users\\tc\\notes')
  })

  it('refuses the box path, a share, a device path, a stream and a drive-relative path', () => {
    for (const bad of ['/srv/agents/x', '\\Users\\tc', '\\\\host\\share\\x', '\\\\?\\C:\\x', '//host/x', 'C:\\a.txt:hidden', 'C:foo', 'src\\x'])
      expect(() => hostPath(bad, HOME, W), bad).toThrow(/drive paths/)
  })

  it('on the Mac a POSIX path is still the rule', () => {
    expect(hostPath('~/x', '/Users/me', 'darwin')).toBe('/Users/me/x')
    expect(() => hostPath('C:\\x', '/Users/me', 'darwin')).toThrow(/absolute/)
  })
})

describe('coversHome on Windows', () => {
  it('a drive root (any whole disk), the profiles folder and the profile cover home, in any case', () => {
    for (const dir of ['C:\\', 'c:', 'D:\\', 'C:\\Users', 'c:\\users\\TC']) expect(coversHome(dir, HOME, W), dir).toBe(true)
    for (const dir of ['C:\\Users\\tc\\src', 'D:\\data', 'C:\\Users\\tcx']) expect(coversHome(dir, HOME, W), dir).toBe(false)
  })
})

describe('the always-ask floor on Windows', () => {
  it('asks for the registry, tasks, services, trust, ACLs and runas, by any spelling of the program', () => {
    expect(asks({ argv: ['reg', 'add', 'HKCU\\Software\\X'] })).toBe('reg')
    expect(asks({ argv: ['C:\\Windows\\System32\\schtasks.exe', '/create'] })).toBe('schtasks')
    expect(asks({ command: 'CertUtil -addstore Root ca.pem' })).toBe('certutil')
    expect(asks({ command: 'netsh advfirewall set allprofiles state off' })).toBe('netsh')
    expect(asks({ command: 'icacls C:\\x /grant Everyone:F' })).toBe('icacls')
    expect(asks({ argv: ['runas', '/user:Administrator', 'cmd'] })).toBe('runas')
    expect(asks({ command: 'powershell -Command "Set-ExecutionPolicy Unrestricted"' })).toBe('set-executionpolicy')
    expect(asks({ argv: ['sudo', 'whoami'] })).toBe('sudo')
  })

  it('asks for PowerShell whose command cannot be read off the card', () => {
    expect(asks({ argv: ['powershell.exe', '-enc', 'SQBFAFgA'] })).toMatch(/encoded/)
    expect(asks({ argv: ['pwsh', '-EncodedCommand', 'SQBFAFgA'] })).toMatch(/encoded/)
    expect(asks({ argv: ['powershell', '-ExecutionPolicy', 'Bypass', '-File', 'x.ps1'] })).toMatch(/execution policy/)
    expect(asks({ argv: ['powershell', '-NoProfile', '-Command', 'Get-ChildItem'] })).toBeNull()
  })

  it('asks for a recursive delete of a drive, a top folder or the profile, not of a project folder', () => {
    expect(asks({ command: 'rd /s /q C:\\' })).toMatch(/recursive delete/)
    expect(asks({ command: 'Remove-Item -Recurse -Force C:\\Users' })).toMatch(/recursive delete/)
    expect(asks({ argv: ['rm', '-rf', 'C:/Users/TC'] })).toMatch(/recursive delete/)
    expect(asks({ command: 'del /s /q *', cwd: HOME })).toMatch(/recursive delete/)
    expect(asks({ command: 'rm -rf $env:USERPROFILE' })).toMatch(/recursive delete/)
    expect(asks({ command: 'rm -rf build' })).toBeNull()
    expect(asks({ command: 'rd /s /q C:\\Users\\tc\\src\\app\\dist' })).toBeNull()
  })

  it("asks for Windows' credential stores and the usual keys, with either slash, in any case", () => {
    expect(asks({ command: 'dir C:\\Users\\tc\\AppData\\Roaming\\Microsoft\\Credentials' })).toMatch(/credential path/)
    expect(asks({ command: 'type C:\\Users\\tc\\.ssh\\id_ed25519' })).toMatch(/credential path/)
    expect(asks({ argv: ['cat', 'c:/users/tc/.CODEX/auth.json'] })).toMatch(/credential path/)
  })

  it('leaves ordinary work alone, and offers the program by its plain name', () => {
    expect(asks({ argv: ['git', 'status'] })).toBeNull()
    expect(asks({ command: 'dir /b' })).toBeNull()
    expect(programOf({ argv: ['C:\\Program Files\\Git\\cmd\\Git.EXE', 'status'] }, W)).toBe('git')
    expect(programOf({ argv: ['cmd', '/c', 'dir'] }, W)).toBeNull()
    expect(runOffer({ argv: ['git', 'status'], cwd: 'C:\\Users\\tc\\src\\app' }, HOME, W)).toEqual({
      folder: 'C:\\Users\\tc\\src\\app',
      program: 'git'
    })
    expect(runOffer({ argv: ['git', 'status'], cwd: 'c:\\users\\tc' }, HOME, W)).toEqual({ program: 'git' })
  })

  it('the Mac reads none of the Windows list', () => {
    expect(alwaysAsks({ argv: ['reg', 'add', 'x'], cwd: '/Users/me/src' }, '/Users/me', 'darwin')).toBeNull()
  })
})
