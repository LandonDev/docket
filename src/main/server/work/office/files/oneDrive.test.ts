import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveAddress } from '../live/address'
import { ensureFilesTables, foldersPlace, librariesOf, setCloudDir, setRoots, windowsLibrary } from './library'
import * as macOneDrive from './macOneDrive'
import * as oneDrive from './oneDrive'

const CID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const SITE = 'a'.repeat(32)
const WEB = 'b'.repeat(32)
const LIBRARY = 'c'.repeat(32)
const LINK = 'd'.repeat(32)
const TEAM_FOLDER = 'e'.repeat(32)
const SHORTCUT = 'f'.repeat(32)
const ROOT = '0'.repeat(32)
const MINE_WEB = 'https://example-my.sharepoint.com/personal/alex_example_edu/Documents'
const TEAM_WEB = 'https://example.sharepoint.com/sites/Club/Shared%20Documents'
const SHORTCUT_WEB = 'https://example.sharepoint.com/sites/Other/Archive'
const SETTINGS_WEB = 'https://example.sharepoint.com/sites/Old/Documents'
const APP_STORE = 'Library/Containers/com.microsoft.OneDrive-mac/Data/Library/Application Support/OneDrive/settings'
const STANDALONE = 'Library/Group Containers/UBF8T346G9.OneDriveStandaloneSuite/OneDrive.noindex/OneDrive/settings'
const RECWELL_WEB = 'https://example.sharepoint.com/sites/RecWell/Shared%20Documents'
const RECWELL_FOLDERS = [
  { id: '1'.repeat(32), name: 'Team RecWell', mount: 'TeamRecWell' },
  { id: '2'.repeat(32), name: 'Sport Programs', mount: 'SportPrograms' },
  { id: '3'.repeat(32), name: 'AI Task Force', mount: 'AITaskForce' }
]

let home: string
let cloud: string
let mine: string
let team: string
let section: string
let settings: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'onedrive-settings-')))
  cloud = join(home, 'Library', 'CloudStorage')
  mine = join(cloud, 'OneDrive-Example')
  team = join(cloud, 'OneDrive-Example-Club')
  section = join(cloud, 'OneDrive-Example-Club-Planning')
  for (const path of [mine, team, section]) mkdirSync(path, { recursive: true })
  settings = join(home, STANDALONE, 'Business1')
})

afterEach(() => {
  vi.restoreAllMocks()
  setCloudDir(() => join(homedir(), 'Library', 'CloudStorage'))
  rmSync(home, { recursive: true, force: true })
})

const policy = (web: string): string => `DavUrlNamespace = ${web}\r\n`
const scope = (number: number, path: string): string =>
  `libraryScope = ${number} 0 0 0 0 0 0 0 ${SITE} ${WEB} ${LIBRARY} 0 "${path}" 0 00000000-0000-0000-0000-000000000000`
const read = () => macOneDrive.readMacOneDrive(home, 'darwin')

function fixture(rows: string[], teamPolicy = `ClientPolicy_${LIBRARY}${SITE}.ini`): void {
  mkdirSync(settings, { recursive: true })
  writeFileSync(join(settings, 'global.ini'), `\uFEFFcid = ${CID}\r\n`)
  writeFileSync(join(settings, `${CID}.ini`), rows.join('\r\n'))
  writeFileSync(join(settings, 'ClientPolicy.ini'), policy(MINE_WEB))
  writeFileSync(join(settings, teamPolicy), policy(TEAM_WEB.replace('%20', ' ')))
  writeFileSync(join(settings, `ClientPolicy_${LIBRARY}${SITE}${LINK}.ini`), policy(SHORTCUT_WEB))
}

/** The App Store client's folder-only sync records, with fixture account and resource IDs. */
function appStoreFixture() {
  settings = join(home, APP_STORE, 'Business1')
  mkdirSync(settings, { recursive: true })
  const myMount = join(cloud, 'OneDrive-example.edu')
  const folders = RECWELL_FOLDERS.map((folder) => ({
    ...folder,
    previous: join(home, 'example.edu', `RecWell - ${folder.name}`),
    path: join(cloud, `OneDrive-example.edu-RecWell-${folder.mount}`)
  }))
  for (const path of [myMount, ...folders.map((f) => f.path)]) mkdirSync(path)
  const scope0 = `libraryScope = 0 0 0 0 "MySite" "ODB" https://example-my.sharepoint.com/personal/alex_example_edu 0 0 0 0 0 "${home}/OneDrive - example.edu" 0 00000000-0000-0000-0000-000000000000`
  const scope1 = `libraryScope = 1 1 0 0 "RecWell" "Documents" https://example.sharepoint.com/sites/RecWell 0 ${SITE} ${WEB} ${LIBRARY} 0 "" 0 00000000-0000-0000-0000-000000000000`
  const rows = [scope0, scope1, ...folders.map(({ id, name, previous }, index) =>
    `libraryFolder = ${index} 1 ${id}+1 0 "${previous}" "${name}" 0 00000000-0000-0000-0000-000000000000`)]
  const account = join(settings, `${CID}.ini`)
  writeFileSync(account, rows.join('\n'))
  writeFileSync(join(settings, 'global.ini'), `cid = ${CID}\n`)
  writeFileSync(join(settings, 'ClientPolicy.ini'), policy(MINE_WEB + '/') + 'SiteTitle = Alex Example\n')
  writeFileSync(join(settings, `ClientPolicy_${LIBRARY}_${SITE}.ini`), policy(RECWELL_WEB.replace('%20', ' ') + '/') + 'SiteTitle = RecWell\n')
  const source = new DatabaseSync(join(settings, 'SyncEngineDatabase.db'))
  source.exec('PRAGMA journal_mode = WAL')
  source.exec('CREATE TABLE od_ClientFolder_Records (resourceID TEXT, parentResourceID TEXT, folderName TEXT, parentScopeID TEXT)')
  const root = '4'.repeat(32)
  const insert = source.prepare('INSERT INTO od_ClientFolder_Records VALUES (?, ?, ?, ?)')
  for (const [i, folder] of folders.entries()) insert.run(i === 1 ? folder.id + '+1' : folder.id, root, folder.name, root)
  source.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return { account, rows, source, folders, myMount, root, insert }
}

/** The Mac settings .dat stores the folder name in UTF-32LE after its two IDs. */
function folderRecord(id: string, parent: string, name: string, headerSize: number): Buffer {
  const at = headerSize + 8
  const record = Buffer.alloc(at + 160 + 260 * 4)
  record[0] = 2
  record[headerSize] = 1
  record.write(id, at, 'ascii')
  record.write(parent, at + 39, 'ascii')
  let nameAt = at + 160
  for (const character of name) {
    record.writeUInt32LE(character.codePointAt(0)!, nameAt)
    nameAt += 4
  }
  return record
}

describe.skipIf(process.platform === 'win32')('OneDrive for Mac settings', () => {
  it('joins My files and Teams scopes to their policies and resolves a mount alias', () => {
    const alias = join(home, 'OneDrive - Example')
    symlinkSync(mine, alias)
    fixture([scope(1, team), scope(0, '~/OneDrive - Example')])
    expect(read()).toEqual([{ path: team, web: TEAM_WEB }, { path: mine, web: MINE_WEB }])
  })

  it('finds App Store accounts and matches a policy by its site, web and library IDs', () => {
    settings = join(home, APP_STORE, 'Business2')
    fixture([scope(1, team)], 'ClientPolicy_other.ini')
    const guid = (id: string) => `{${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}}`.toUpperCase()
    writeFileSync(join(settings, 'ClientPolicy_other.ini'), policy(TEAM_WEB) + `SiteID = ${guid(SITE)}\nWebID = ${guid(WEB)}\nIrmLibraryId = ${guid(LIBRARY)}\n`)
    expect(read()).toEqual([{ path: team, web: TEAM_WEB }])
  })

  it('prints the four App Store mounts even when their configured paths have gone stale', () => {
    const { source } = appStoreFixture()
    try {
      const lines = read().map(({ path, web }) => `${path.replace(home, '/Users/alex')}\t${web}`)
      expect(lines).toEqual([
        '/Users/alex/Library/CloudStorage/OneDrive-example.edu\thttps://example-my.sharepoint.com/personal/alex_example_edu/Documents',
        '/Users/alex/Library/CloudStorage/OneDrive-example.edu-RecWell-TeamRecWell\thttps://example.sharepoint.com/sites/RecWell/Shared%20Documents/Team%20RecWell',
        '/Users/alex/Library/CloudStorage/OneDrive-example.edu-RecWell-SportPrograms\thttps://example.sharepoint.com/sites/RecWell/Shared%20Documents/Sport%20Programs',
        '/Users/alex/Library/CloudStorage/OneDrive-example.edu-RecWell-AITaskForce\thttps://example.sharepoint.com/sites/RecWell/Shared%20Documents/AI%20Task%20Force'
      ])
    } finally {
      source.close()
    }
  })

  it('prefers the File Provider folder and falls back to the existing ini directory as mounts change', () => {
    const { folders, source } = appStoreFixture()
    try {
      const { path, previous } = folders[0]!
      mkdirSync(previous, { recursive: true })
      expect(read().map((m) => m.path)).toContain(path)
      expect(read().map((m) => m.path)).not.toContain(previous)
      rmSync(path, { recursive: true })
      expect(read().map((m) => m.path)).toContain(previous)
      rmSync(previous, { recursive: true })
      expect(read().map((m) => m.web)).not.toContain(`${RECWELL_WEB}/Team%20RecWell`)
    } finally {
      source.close()
    }
  })

  it('backs stale whole-library mounts with CloudStorage and builds folder URLs only from complete database paths', () => {
    const { account, rows, folders, source, root, insert, myMount } = appStoreFixture()
    try {
      const mount = join(cloud, 'OneDrive-example.edu-RecWell')
      mkdirSync(mount)
      rows[1] = rows[1]!.replace('""', `"${home}/example.edu/RecWell - Documents"`)
      writeFileSync(account, rows.join('\n'))
      const parent = '5'.repeat(32)
      insert.run(parent, root, 'Server # Archive', root)
      const statement = source.prepare('UPDATE od_ClientFolder_Records SET parentResourceID = ?, folderName = ? WHERE resourceID = ?')
      statement.run(parent, 'Server Team', folders[0]!.id)
      statement.run('6'.repeat(32), 'Server AI', folders[2]!.id)
      source.prepare('DELETE FROM od_ClientFolder_Records WHERE resourceID = ?').run(folders[1]!.id + '+1')
      source.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      expect(read()).toEqual([
        { path: myMount, web: MINE_WEB },
        { path: mount, web: RECWELL_WEB },
        { path: folders[0]!.path, web: `${RECWELL_WEB}/Server%20%23%20Archive/Server%20Team` }
      ])
    } finally {
      source.close()
    }
  })

  it('reads a separately synced folder and a shortcut with a different local name from .dat folder IDs', () => {
    fixture([
      `libraryFolder = 0 1 ${TEAM_FOLDER} 0 "${section}" 0 0 0`,
      `AddedScope = 0 ${SHORTCUT}!01 0 0 0 ${SITE} ${WEB} ${LIBRARY} ${LINK} "/Deep%20Docs"`,
      scope(0, mine),
      scope(1, '')
    ])
    writeFileSync(join(settings, `${CID}.dat`), Buffer.concat([
      folderRecord(TEAM_FOLDER, ROOT, 'Plans #1', 16),
      folderRecord(SHORTCUT, ROOT, 'Local 📂 alias', 8)
    ]))
    expect(read()).toEqual([
      { path: mine, web: MINE_WEB },
      { path: section, web: `${TEAM_WEB}/Plans%20%231` },
      { path: join(mine, 'Local 📂 alias'), web: `${SHORTCUT_WEB}/Deep%20Docs` }
    ])
  })

  it('reads checkpointed folder metadata when the client no longer has a .dat', () => {
    fixture([scope(0, mine), `AddedScope = 0 ${SHORTCUT} 0 0 0 ${SITE} ${WEB} ${LIBRARY} ${LINK} " "`])
    const source = new DatabaseSync(join(settings, 'SyncEngineDatabase.db'))
    source.exec('CREATE TABLE od_ClientFolder_Records (resourceID TEXT, parentResourceID TEXT, folderName TEXT)')
    source.prepare('INSERT INTO od_ClientFolder_Records VALUES (?, ?, ?)').run(SHORTCUT, ROOT, 'Local alias')
    source.close()
    expect(read()).toContainEqual({ path: join(mine, 'Local alias'), web: SHORTCUT_WEB })
  })

  it('skips subfolders and shortcuts whose folder IDs do not resolve', () => {
    fixture([
      scope(0, mine),
      scope(1, ''),
      `libraryFolder = 0 1 ${TEAM_FOLDER} 0 "${section}"`,
      `AddedScope = 0 ${SHORTCUT} 0 0 0 ${SITE} ${WEB} ${LIBRARY} ${LINK} " "`
    ])
    expect(read()).toEqual([{ path: mine, web: MINE_WEB }])
  })

  it('reloads when a policy changes or disappears, and tolerates missing or garbled settings', () => {
    expect(read()).toEqual([])
    fixture([scope(0, mine), 'libraryScope = 1 "unterminated'])
    expect(read()).toEqual([{ path: mine, web: MINE_WEB }])
    const file = join(settings, 'ClientPolicy.ini')
    writeFileSync(file, policy(SETTINGS_WEB))
    utimesSync(file, 1, 1)
    expect(read()).toEqual([{ path: mine, web: SETTINGS_WEB }])
    rmSync(file)
    expect(read()).toEqual([])
    writeFileSync(join(settings, `${CID}.ini`), Buffer.from([0xff, 0x00]))
    expect(read()).toEqual([])
  })

  it('skips settings symlinks that point into synced folders', () => {
    fixture([scope(0, mine)])
    const file = join(settings, 'ClientPolicy.ini')
    rmSync(file)
    const synced = join(mine, 'document.ini')
    writeFileSync(synced, policy(MINE_WEB))
    symlinkSync(synced, file)
    expect(read()).toEqual([])
    expect(macOneDrive.readMacOneDrive(home, 'linux')).toEqual([])
  })

  it('matches existing libraries by mount without regard to case, and prefers OneDrive to Settings', () => {
    fixture([
      scope(1, team),
      scope(0, mine),
      `AddedScope = 0 ${SHORTCUT} 0 0 0 ${SITE} ${WEB} ${LIBRARY} ${LINK} "/Deep%20Docs"`
    ])
    writeFileSync(join(settings, `${CID}.dat`), folderRecord(SHORTCUT, ROOT, 'Local alias', 16))
    const mounts = read().map((m) => m.path === team ? { ...m, path: m.path.toUpperCase() } : m)
    vi.spyOn(macOneDrive, 'readMacOneDrive').mockReturnValue(mounts)
    setCloudDir(() => cloud)
    const db = new DatabaseSync(':memory:')
    try {
      ensureFilesTables(db)
      setRoots(db, [{ folder: team, web: SETTINGS_WEB }, { folder: mine, web: SETTINGS_WEB }, { folder: section, web: SETTINGS_WEB }])
      const libs = librariesOf(db, 'mac')
      const shared = libs.find((l) => l.path === team)!
      const own = libs.find((l) => l.path === mine)!
      expect(shared).toMatchObject({ web: TEAM_WEB, webSource: 'onedrive' })
      expect(own).toMatchObject({ web: MINE_WEB, webSource: 'onedrive' })
      expect(libs.find((l) => l.path === section)).toMatchObject({ web: SETTINGS_WEB, webSource: 'settings' })
      expect(liveAddress(shared, join(team, 'Plan #1.docx'))).toEqual({ ok: true, url: `${TEAM_WEB}/Plan%20%231.docx?web=1` })
      expect(liveAddress(own, join(mine, 'Local alias', 'Plan.docx'))).toEqual({ ok: true, url: `${SHORTCUT_WEB}/Deep%20Docs/Plan.docx?web=1` })
      const peerMine = { ...own, host: 'peer', id: 'peer~mine', web: SETTINGS_WEB, webSource: 'settings' as const, webMounts: undefined }
      expect(liveAddress(peerMine, join(mine, 'Local Alias', 'Plan.docx'), { libraries: [own] }))
        .toEqual({ ok: true, url: `${SHORTCUT_WEB}/Deep%20Docs/Plan.docx?web=1` })
      expect(liveAddress(own, join(mine, 'Local aliases', 'Plan.docx'))).toEqual({ ok: true, url: `${MINE_WEB}/Local%20aliases/Plan.docx?web=1` })
      setRoots(db, [{ folder: team, off: true }])
      expect(librariesOf(db, 'mac').some((l) => l.path === team)).toBe(false)
    } finally {
      db.close()
    }
  })
})

describe('OneDrive on a Windows PC', () => {
  const key = String.raw`HKEY_CURRENT_USER\Software\SyncEngines\Providers\OneDrive`
  const team = String.raw`C:\Users\Alex\Example University\Club - Documents`
  const mine = String.raw`C:\Users\Alex\OneDrive - Example University`
  const output = [
    key,
    `${key}\\Club`,
    `    UrlNamespace    REG_SZ    ${TEAM_WEB}/`,
    `    MountPoint      REG_SZ    ${team}\\`,
    '    LibraryType     REG_SZ    site',
    `${key}\\Mine`,
    '    LibraryType     REG_SZ    MySite',
    `    MountPoint      REG_SZ    ${mine}`,
    `    UrlNamespace    REG_SZ    ${MINE_WEB}`,
    `${key}\\Mine\\Nested`,
    '    MountPoint      REG_SZ    C:\\Wrong',
    `${key}\\Personal`,
    '    LibraryType     REG_SZ    Personal',
    '    MountPoint      REG_SZ    C:\\Users\\Alex\\OneDrive',
    `${key}\\MissingUrl`,
    '    MountPoint      REG_SZ    D:\\Projects',
    `${key}\\MissingMount`,
    `    UrlNamespace    REG_SZ    ${SHORTCUT_WEB}`,
    `${key}\\BadMount`,
    '    MountPoint      REG_SZ    relative-folder'
  ].join('\r\n')

  it('reads the provider rows by key with the same mount fields as the VM', () => {
    const mounts = oneDrive.parseOneDriveRegistry(output)
    expect(mounts).toEqual([
      { path: team, type: 'team', web: TEAM_WEB },
      { path: mine, type: 'mine', web: MINE_WEB },
      { path: 'D:\\Projects', type: 'team', web: null }
    ])
    const pc = windowsLibrary('pc', mounts[0]!, ['General'])
    const vm = windowsLibrary('box', mounts[0]!, ['General'], true)
    expect(pc).toMatchObject({ team: 'Club', kind: 'channels', webSource: 'onedrive', web: TEAM_WEB, channels: ['General'] })
    expect(pc.vm).toBeUndefined()
    expect(vm).toMatchObject({ web: TEAM_WEB, vm: true })
    expect(liveAddress(pc, win32.join(team, 'General', 'Plan.docx'))).toEqual({ ok: true, url: `${TEAM_WEB}/General/Plan.docx?web=1` })
    expect(oneDrive.parseOneDriveRegistry('ERROR: The system was unable to find the specified registry key or value.')).toEqual([])
  })

  it('discovers local provider mounts through librariesOf and uses Settings when a provider has no URL', () => {
    const club = join(home, 'Example University', 'Club - Documents')
    mkdirSync(join(club, 'General'), { recursive: true })
    const db = new DatabaseSync(':memory:')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const mounts = oneDrive.parseOneDriveRegistry(output)
    vi.spyOn(oneDrive, 'readWindowsOneDrive').mockReturnValue([
      { ...mounts[0]!, path: club },
      { ...mounts[2]!, path: section },
      { ...mounts[1]!, path: join(home, 'Missing') }
    ])
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      ensureFilesTables(db)
      setRoots(db, [{ folder: club, web: SETTINGS_WEB }, { folder: section, web: SETTINGS_WEB }])
      expect(librariesOf(db, 'pc')).toEqual([
        expect.objectContaining({ team: 'Club', channels: ['General'], web: TEAM_WEB, webSource: 'onedrive', found: true }),
        expect.objectContaining({ path: section, web: SETTINGS_WEB, webSource: 'settings', found: true })
      ])
      expect(foldersPlace('pc')).toMatchObject({ state: 'ok' })
    } finally {
      Object.defineProperty(process, 'platform', platform)
      db.close()
    }
  })

  it.skipIf(process.platform === 'win32')('skips the registry off Windows', () => {
    expect(oneDrive.readWindowsOneDrive()).toEqual([])
  })
})
