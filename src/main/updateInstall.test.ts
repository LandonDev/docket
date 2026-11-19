import { describe, expect, it } from 'vitest'
import {
  APP_STILL_RUNNING,
  DID_NOT_INSTALL,
  NEVER_INSTALLED,
  SIGNATURE_FAILED,
  WAITING_FOR_QUIT,
  bundleIdentifier,
  bundleShortVersion,
  compareVersions,
  describeInstallFailure,
  feedFallback,
  judgeAttempt,
  parseAttempt,
  serializeAttempt,
  shipItLinesSince,
  stagedBundlePath,
  stalePaths,
  updaterCacheDirName,
  RELEASE_FEED,
  installBlockers,
  parseProcessTable,
  staleWindowsPaths,
  type ProcRow
} from './updateInstall'

// The real log of the failed 1.0.205 install (2026-10-10), two attempts.
const LOG = [
  '2026-10-10 02:17:40.324 ShipIt[46546:5749534] Detected this as an install request',
  '2026-10-10 02:17:40.639 ShipIt[46546:5749540] Beginning installation',
  '2026-10-10 02:17:49.745 ShipIt[46546:5749540] Installation error: Error Domain=SQRLCodeSignatureErrorDomain Code=-1 "Code signature at URL file:///var/folders/T/dev.landon.tempcode.ShipIt.6MXTFbJu/TempCode.app did not pass validation" UserInfo={...}',
  '2026-10-10 02:17:49.745 ShipIt[46546:5749540] ShipIt quitting',
  '2026-10-10 22:05:01.726 ShipIt[34118:308621] Detected this as an install request',
  '2026-10-10 22:05:01.925 ShipIt[34118:308628] Resuming installation attempt 2',
  '2026-10-10 22:05:10.477 ShipIt[34118:308629] Aborting update attempt because there are 1 running instances of the target app',
  '2026-10-10 22:05:10.478 ShipIt[34118:309611] Installation cancelled: Error Domain=SQRLInstallerErrorDomain Code=-9 "App Still Running Error" UserInfo={...}',
  '2026-10-10 22:05:10.478 ShipIt[34118:309611] ShipIt quitting'
].join('\n')

const at = (h: number, m: number): number => new Date(2026, 9, 10, h, m, 0).getTime()

describe('install attempt record', () => {
  it('round-trips and rejects junk', () => {
    expect(parseAttempt(serializeAttempt('1.0.205', 123))).toEqual({ version: '1.0.205', at: 123 })
    expect(parseAttempt(null)).toBeNull()
    expect(parseAttempt('nope')).toBeNull()
    expect(parseAttempt('{"version":"","at":1}')).toBeNull()
    expect(parseAttempt('{"version":"1.0.1"}')).toBeNull()
  })

  it('compares dotted versions numerically', () => {
    expect(compareVersions('1.0.205', '1.0.200')).toBe(1)
    expect(compareVersions('1.0.99', '1.0.100')).toBe(-1)
    expect(compareVersions('1.0.205', '1.0.205')).toBe(0)
    expect(compareVersions('1.0.205', '1.0.205.1')).toBe(-1)
  })
})

describe('ShipIt log reading', () => {
  it('keeps the lines written since the hand-over, with a minute of slack', () => {
    expect(shipItLinesSince(LOG, at(22, 4)).length).toBe(5)
    expect(shipItLinesSince(LOG, at(22, 5))).toHaveLength(5)
    expect(shipItLinesSince(LOG, at(2, 17))).toHaveLength(9)
    expect(shipItLinesSince(LOG, at(23, 0))).toEqual([])
    expect(shipItLinesSince('garbage\nno timestamp', 0)).toEqual([])
  })

  it('names the failure in one line', () => {
    expect(describeInstallFailure(shipItLinesSince(LOG, at(2, 17)))).toBe(SIGNATURE_FAILED)
    expect(describeInstallFailure(shipItLinesSince(LOG, at(22, 4)))).toBe(APP_STILL_RUNNING)
    expect(describeInstallFailure([])).toBe(NEVER_INSTALLED)
    // ShipIt launched and is waiting for every instance to quit (first attempt).
    expect(describeInstallFailure(['2026-10-10 23:06:13.433 ShipIt[88575:659500] Detected this as an install request'])).toBe(WAITING_FOR_QUIT)
    expect(
      describeInstallFailure([
        '2026-10-10 23:06:13.433 ShipIt[88575:659500] Detected this as an install request',
        '2026-10-10 23:08:18.521 ShipIt[88575:659503] Beginning installation'
      ])
    ).toBe(DID_NOT_INSTALL)
    expect(describeInstallFailure(['2026-10-10 22:05:01.726 ShipIt[1:1] Installation error: something else'])).toBe(DID_NOT_INSTALL)
  })

  it('judges the attempt against the running version', () => {
    expect(judgeAttempt({ version: '1.0.205', at: at(2, 17) }, '1.0.200', LOG)).toEqual({
      version: '1.0.205',
      reason: SIGNATURE_FAILED
    })
    expect(judgeAttempt({ version: '1.0.205', at: at(22, 4) }, '1.0.200', LOG)).toEqual({
      version: '1.0.205',
      reason: APP_STILL_RUNNING
    })
    // The install happened: nothing to report.
    expect(judgeAttempt({ version: '1.0.205', at: at(2, 17) }, '1.0.205', LOG)).toBeNull()
    expect(judgeAttempt({ version: '1.0.205', at: at(2, 17) }, '1.0.206', LOG)).toBeNull()
    expect(judgeAttempt(null, '1.0.200', LOG)).toBeNull()
    // The app quit but ShipIt never wrote a line: it never ran.
    expect(judgeAttempt({ version: '1.0.207', at: at(23, 30) }, '1.0.200', LOG)).toEqual({
      version: '1.0.207',
      reason: NEVER_INSTALLED
    })
  })
})

describe('bundle metadata', () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
    <key>CFBundleIdentifier</key>
    <string>dev.landon.tempcode</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.205</string>
</dict></plist>`
  it('reads the identifier and version out of Info.plist', () => {
    expect(bundleIdentifier(plist)).toBe('dev.landon.tempcode')
    expect(bundleShortVersion(plist)).toBe('1.0.205')
    expect(bundleIdentifier('<plist/>')).toBeNull()
  })

  it('reads the cache dir name out of app-update.yml', () => {
    expect(updaterCacheDirName('owner: LandonDev\nrepo: temp-code\nprovider: github\nupdaterCacheDirName: temp-code-updater\n')).toBe(
      'temp-code-updater'
    )
    expect(updaterCacheDirName('provider: generic\n')).toBeNull()
  })

  it('reads the staged bundle out of ShipItState.plist', () => {
    const xml = `<dict><key>updateBundleURL</key>
<string>file:///Users/landon/Library/Caches/dev.landon.tempcode.ShipIt/update.mchjM6S/TempCode.app/</string></dict>`
    expect(stagedBundlePath(xml)).toBe('/Users/landon/Library/Caches/dev.landon.tempcode.ShipIt/update.mchjM6S/TempCode.app')
    expect(stagedBundlePath('<dict/>')).toBeNull()
  })
})

describe('stalePaths', () => {
  it('names the download, its differential base, and the Squirrel state and stagings', () => {
    expect(
      stalePaths(
        '/Users/l/Library/Caches',
        'temp-code-updater',
        'dev.landon.tempcode',
        ['ShipItState.plist', 'ShipIt_stderr.log', 'update.mchjM6S'],
        true
      )
    ).toEqual([
      '/Users/l/Library/Caches/temp-code-updater/pending',
      '/Users/l/Library/Caches/temp-code-updater/update.zip',
      '/Users/l/Library/Caches/dev.landon.tempcode.ShipIt/ShipItState.plist',
      '/Users/l/Library/Caches/dev.landon.tempcode.ShipIt/update.mchjM6S'
    ])
    expect(stalePaths('/c', 'temp-code-updater', 'dev.landon.tempcode', ['update.a'], false)).toEqual([
      '/c/dev.landon.tempcode.ShipIt/ShipItState.plist',
      '/c/dev.landon.tempcode.ShipIt/update.a'
    ])
  })
})

describe('feedFallback', () => {
  it('leaves a bundle with app-update.yml to electron-updater', () => {
    expect(feedFallback(true)).toBeNull()
  })
  it('names the public repo for a bundle shipped without the file', () => {
    expect(feedFallback(false)).toEqual({ provider: 'github', owner: 'LandonDev', repo: 'temp-code' })
    expect(feedFallback(false)).toBe(RELEASE_FEED)
  })
})

describe('Windows: the child tree before an install', () => {
  const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\TempCode\\TempCode.exe'
  const DIR = 'C:\\Users\\me\\AppData\\Local\\Programs\\TempCode'
  const CLI = `${DIR}\\resources\\app\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe`
  const row = (pid: number, ppid: number, exe: string | null, startedAt = pid): ProcRow => ({ pid, ppid, exe, startedAt })
  const self = { pid: 100, exe: EXE, appDir: DIR }

  it('ends what the app started, down the tree, and leaves its own processes to the quit', () => {
    const rows = [
      row(4, 0, null),
      row(100, 50, EXE),
      row(110, 100, EXE), // a renderer
      row(120, 100, EXE), // the exec broker, a utility process
      row(121, 120, 'C:\\Program Files\\Git\\cmd\\git.exe'), // its child
      row(130, 100, CLI), // a warm harness
      row(131, 130, 'C:\\Program Files\\Git\\bin\\bash.exe'), // the CLI's shell
      row(140, 100, 'C:\\Windows\\System32\\conhost.exe'), // a terminal's console host
      row(900, 800, 'C:\\Windows\\explorer.exe') // a stranger
    ]
    expect(installBlockers(rows, self).sort((a, b) => a - b)).toEqual([121, 130, 131, 140])
  })

  it('ends a process running out of the install folder even when its parent is gone', () => {
    const rows = [row(100, 50, EXE), row(300, 77, CLI), row(301, 77, 'C:\\Windows\\notepad.exe')]
    expect(installBlockers(rows, self)).toEqual([300])
  })

  it('compares paths as Windows does, without case', () => {
    const rows = [row(100, 50, EXE), row(110, 100, EXE.toUpperCase()), row(300, 77, CLI.toLowerCase())]
    expect(installBlockers(rows, { ...self, appDir: `${DIR}\\` })).toEqual([300])
  })

  it('does not believe a parent younger than its child: Windows reuses ids', () => {
    // 100 started at t=5000; a process naming 100 as its parent but started at t=10 belonged to an earlier 100.
    const rows = [row(100, 50, EXE, 5000), row(200, 100, 'C:\\Windows\\notepad.exe', 10), row(201, 100, 'C:\\Windows\\notepad.exe', 6000)]
    expect(installBlockers(rows, self)).toEqual([201])
  })

  it('never names itself, and survives a table it cannot read', () => {
    expect(installBlockers([row(100, 100, EXE)], self)).toEqual([])
    expect(installBlockers(parseProcessTable('not json'), self)).toEqual([])
  })

  it('reads the process table PowerShell prints, in either date form, one row or many', () => {
    const table = JSON.stringify([
      { ProcessId: 100, ParentProcessId: 50, ExecutablePath: EXE, CreationDate: '/Date(1763500000000)/' },
      { ProcessId: 130, ParentProcessId: 100, ExecutablePath: null, CreationDate: '2026-11-19T01:00:00.000Z' },
      { ProcessId: 'x', ParentProcessId: 1 }
    ])
    expect(parseProcessTable(table)).toEqual([
      { pid: 100, ppid: 50, exe: EXE, startedAt: 1763500000000 },
      { pid: 130, ppid: 100, exe: null, startedAt: Date.parse('2026-11-19T01:00:00.000Z') }
    ])
    expect(parseProcessTable(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, ExecutablePath: EXE }))).toEqual([
      { pid: 7, ppid: 1, exe: EXE, startedAt: 0 }
    ])
  })

  it("a retry drops electron-updater's download and nothing of Squirrel's", () => {
    const paths = staleWindowsPaths('/local', 'temp-code-updater')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toMatch(/temp-code-updater[\\/]pending$/)
  })
})
