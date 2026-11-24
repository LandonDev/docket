import { execFileSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { oneDriveNamespace } from './oneDrive'

export interface MacOneDriveMount {
  path: string
  web: string
}

const SETTINGS = [
  'Library/Group Containers/UBF8T346G9.OneDriveStandaloneSuite/OneDrive.noindex/OneDrive/settings',
  'Library/Group Containers/UBF8T346G9.OneDriveStandaloneSuite/Library/Application Support/OneDrive/settings',
  'Library/Containers/com.microsoft.OneDrive-mac/Data/Library/Application Support/OneDrive/settings',
  'Library/Application Support/OneDrive/settings'
]
const ACCOUNT = /^Business\d+$/i
const CID = /^[a-z0-9-]{8,80}$/i
const POLICY = /^ClientPolicy(?:_[a-z0-9{}-]+)*\.ini$/i
const RESOURCE = /^[a-f0-9]{32}(?:![a-f0-9]+|\+\d+)?$/i
const MAX_INI = 4 * 1024 * 1024
const MAX_DAT = 64 * 1024 * 1024
const DB = 'SyncEngineDatabase.db'
const FOLDER_COLUMNS = 'resourceID, parentResourceID, folderName'
const DAT_MARKER = Buffer.from([1, 0, 0, 0])
type Folder = { parent: string; name: string; root?: string }
type Policy = { web: string; site: string; webId: string; library: string; title: string }
type Mount = { path: string | null; cloudName: string | null; web: string; nested?: string[] }
const cache = new Map<string, { stamp: string; mounts: Mount[] }>()
const utf8 = new TextDecoder('utf-8', { fatal: true })

function readFile(path: string, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > max) throw new Error('Unreadable OneDrive settings file')
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

function iniOf(path: string): [string, string][] {
  return utf8.decode(readFile(path, MAX_INI)).split(/\r?\n/).flatMap((line) => {
    const field = /^\s*(\w+)\s*=\s*(.*?)\s*$/.exec(line)
    return field ? [[field[1]!.toLowerCase(), field[2]!]] : []
  })
}

const idOf = (value = ''): string => value.replace(/[{}-]/g, '').toLowerCase()
const resourceOf = (value: string): string => value.replace(/\+\d+$/, '').toLowerCase()
const pathKey = (path: string): string => path.normalize('NFC').toLowerCase()
const namePart = (name: string): boolean => !!name && name !== '.' && name !== '..' && !/[/\x00-\x1f\x7f]/.test(name)
const mountPath = (value: string | undefined, home: string): string | null => {
  const path = value?.replace(/^~(?=\/)/, home)
  if (!path?.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)) return null
  return posix.resolve(path)
}

function existingDir(path: string | null): string | null {
  if (!path) return null
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function folderRecords(dat: Buffer): Map<string, Folder> {
  const folders = new Map<string, Folder>()
  // Legacy Mac folder records use a type byte, a marker and two 39-byte IDs, then a UTF-32LE name.
  for (let at = dat.indexOf(DAT_MARKER); at !== -1; at = dat.indexOf(DAT_MARKER, at + 4)) {
    if (dat[at - 8] !== 2 && dat[at - 16] !== 2) continue
    const idAt = at + 8
    const nameAt = idAt + 160
    const id = dat.toString('ascii', idAt, idAt + 39).split('\0')[0]!
    const parent = dat.toString('ascii', idAt + 39, idAt + 78).split('\0')[0]!
    if (!RESOURCE.test(id) || !RESOURCE.test(parent)) continue
    let name = ''
    for (let i = nameAt; i + 4 <= dat.length && i < nameAt + 255 * 4; i += 4) {
      const code = dat.readUInt32LE(i)
      if (code === 0) {
        if (namePart(name)) folders.set(resourceOf(id), { parent: resourceOf(parent), name })
        break
      }
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) break
      name += String.fromCodePoint(code)
    }
  }
  return folders
}

function* sqliteRows(path: string, columns: string): Iterable<Record<string, unknown>> {
  const query = `SELECT ${columns} FROM od_ClientFolder_Records`
  const uri = pathToFileURL(path)
  // SQLite may set up WAL sidecars for a regular read-only open. Read the checkpointed database only.
  uri.searchParams.set('immutable', '1')
  if (process.versions.bun) {
    // The Bun used for the Mac probe may predate node:sqlite.
    const rows = execFileSync('/usr/bin/sqlite3', ['-batch', '-readonly', '-json', uri.href, query], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    })
    if (rows.trim()) yield* JSON.parse(rows) as Record<string, unknown>[]
    return
  }
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(uri.href, { readOnly: true })
  try {
    yield* db.prepare(query).iterate()
  } finally {
    db.close()
  }
}

function sqliteFolders(path: string, columns: string): Map<string, Folder> {
  const folders = new Map<string, Folder>()
  const ambiguous = new Set<string>()
  for (const { resourceID, parentResourceID, folderName, parentScopeID } of sqliteRows(path, columns)) {
    if (typeof resourceID !== 'string' || typeof folderName !== 'string' || !namePart(folderName)) continue
    if (typeof parentResourceID !== 'string' && parentResourceID !== null) continue
    const id = resourceOf(resourceID)
    const parent = resourceOf(parentResourceID ?? '')
    const root = typeof parentScopeID === 'string' ? resourceOf(parentScopeID) : undefined
    const previous = folders.get(id)
    if (previous && (previous.parent !== parent || previous.name !== folderName || previous.root !== root)) ambiguous.add(id)
    folders.set(id, { parent, name: folderName, root })
  }
  for (const id of ambiguous) folders.delete(id)
  return folders
}

function folderMetadata(dat?: string, db?: string): Map<string, Folder> {
  if (db) {
    for (const columns of [`${FOLDER_COLUMNS}, parentScopeID`, FOLDER_COLUMNS]) {
      try {
        return sqliteFolders(db, columns)
      } catch {
        // The checkpoint may be unreadable, or the client may use an older table.
      }
    }
  }
  return dat ? folderRecords(readFile(dat, MAX_DAT)) : new Map()
}

function folderParts(folders: ReadonlyMap<string, Folder>, id: string): string[] | null {
  const parts: string[] = []
  const seen = new Set<string>()
  for (let key = resourceOf(id), folder = folders.get(key); folder; key = folder.parent, folder = folders.get(key)) {
    if (seen.has(key)) return null
    seen.add(key)
    parts.unshift(folder.name)
    if (!folder.parent || folder.parent === folder.root || /^0{32}$/.test(folder.parent)) return parts
  }
  return null
}

function readAccount(home: string, files: ReadonlyMap<string, string>): Mount[] {
  const global = files.get('global.ini')
  if (!global) return []
  const cid = new Map(iniOf(global)).get('cid')
  if (!cid || !CID.test(cid)) return []
  const account = files.get(`${cid.toLowerCase()}.ini`)
  if (!account) return []

  const policies = new Map<string, Policy>()
  for (const [name, path] of files) {
    if (!POLICY.test(name)) continue
    const fields = new Map(iniOf(path))
    const web = oneDriveNamespace(fields.get('davurlnamespace') ?? '')
    if (web) policies.set(name, { web, site: idOf(fields.get('siteid')), webId: idOf(fields.get('webid')), library: idOf(fields.get('irmlibraryid')), title: fields.get('sitetitle') ?? '' })
  }
  const policyOf = (site: string, webId: string, library: string, link = ''): Policy | undefined => {
    const ids = [library, site, link].filter(Boolean).map(idOf)
    const direct = policies.get(`clientpolicy_${ids.join('_')}.ini`) ?? policies.get(`clientpolicy_${ids.join('')}.ini`)
    if (direct) return direct
    if (![site, webId, library].every((id) => /^[a-f0-9]{32}$/.test(idOf(id)))) return undefined
    const matches = [...policies.values()].filter((p) => p.site === idOf(site) && p.webId === idOf(webId) && p.library === idOf(library))
    return matches.length === 1 ? matches[0] : undefined
  }

  const rows = iniOf(account).flatMap(([tag, value]) => {
    if (!['libraryscope', 'libraryfolder', 'addedscope'].includes(tag)) return []
    if (!/^(?:"[^"]*"|[^\s"]+)(?:\s+(?:"[^"]*"|[^\s"]+))*$/.test(value)) return []
    const parts = value.match(/"[^"]*"|[^\s"]+/g)!.map((part) => part.replace(/^"|"$/g, ''))
    return /^\d+$/.test(parts[0]!) ? [{ tag, parts }] : []
  })
  const mainPath = mountPath(rows.find(({ tag, parts }) => tag === 'libraryscope' && parts[0] === '0')?.parts[12], home)
  const domain = mainPath && /^OneDrive\s*-\s*(.+)$/i.exec(posix.basename(mainPath))?.[1]
  const mainCloud = domain && namePart(domain) ? `OneDrive-${domain}` : null
  const scopes = new Map<string, { mount: Mount; siteCloud: string | null }>()
  const mounts: Mount[] = []
  for (const { tag, parts } of rows) {
    if (tag !== 'libraryscope' || parts.length < 13) continue
    const [number] = parts
    const policy = number === '0' ? policies.get('clientpolicy.ini') : policyOf(parts[8]!, parts[9]!, parts[10]!)
    if (!policy) continue
    const path = mountPath(parts[12], home)
    const siteCloud = mainCloud && namePart(policy.title) ? `${mainCloud}-${policy.title}` : null
    const mount = { path, cloudName: number === '0' ? mainCloud : siteCloud, web: policy.web }
    scopes.set(number!, { mount, siteCloud })
    if (path) mounts.push(mount)
  }

  if (!rows.some(({ tag }) => tag !== 'libraryscope')) return mounts
  const folders = folderMetadata(files.get(`${cid.toLowerCase()}.dat`), files.get(DB.toLowerCase()))
  for (const { tag, parts } of rows) {
    if (tag === 'libraryfolder' && parts.length >= 5) {
      const scope = scopes.get(parts[1]!)
      const path = mountPath(parts[4], home)
      const display = (parts[5] ?? '').replace(/\s/g, '')
      const cloudName = scope?.siteCloud && namePart(display) ? `${scope.siteCloud}-${display}` : null
      const names = folderParts(folders, parts[2]!)
      if (scope && names && (cloudName || path)) mounts.push({ path, cloudName, web: `${scope.mount.web}/${names.map(encodeURIComponent).join('/')}` })
    } else if (tag === 'addedscope' && parts.length >= 10) {
      const main = scopes.get('0')?.mount
      const names = folderParts(folders, parts[1]!.slice(0, 32))
      const policy = policyOf(parts[5]!, parts[6]!, parts[7]!, parts[8]!)
      const suffix = parts[9]!.trim()
      const web = policy && (!suffix || suffix.startsWith('/')) ? oneDriveNamespace(policy.web + suffix) : null
      if (main && names && web) mounts.push({ ...main, web, nested: names })
    }
  }
  return mounts
}

function cachedAccount(dir: string, home: string): Mount[] {
  try {
    // Only the client's settings tree. A linked account folder or settings file could point elsewhere.
    if (pathKey(realpathSync(dir)) !== pathKey(dir)) return []
    const files = new Map<string, string>()
    const stamp: [string, number, number, number][] = []
    for (const name of readdirSync(dir).sort()) {
      if (!/^(?:[a-z0-9-]{8,80}\.(?:ini|dat)|global\.ini|SyncEngineDatabase\.db)$/i.test(name) && !POLICY.test(name)) continue
      const path = posix.join(dir, name)
      const s = lstatSync(path)
      if (!s.isFile()) continue
      files.set(name.toLowerCase(), path)
      stamp.push([name, s.mtimeMs, s.ctimeMs, s.size])
    }
    const key = JSON.stringify(stamp)
    const was = cache.get(dir)
    if (was?.stamp === key) return was.mounts
    const mounts = readAccount(home, files)
    cache.set(dir, { stamp: key, mounts })
    return mounts
  } catch {
    cache.delete(dir)
    return []
  }
}

function cloudDirs(home: string): Map<string, string> {
  const cloud = posix.join(home, 'Library', 'CloudStorage')
  try {
    return new Map(readdirSync(cloud, { withFileTypes: true })
      .filter((dir) => dir.isDirectory() && /^OneDrive-/i.test(dir.name))
      .map((dir) => [pathKey(dir.name), posix.join(cloud, dir.name)]))
  } catch {
    return new Map()
  }
}

/** OneDrive's own mount and namespace pairs. The settings are undocumented and may be absent. */
export function readMacOneDrive(home = homedir(), platform = process.platform): MacOneDriveMount[] {
  if (platform !== 'darwin') return []
  try {
    const root = realpathSync(home)
    const cloud = cloudDirs(root)
    const byPath = new Map<string, MacOneDriveMount | null>()
    for (const location of SETTINGS) {
      const settings = posix.join(root, location)
      let dirs
      try {
        dirs = readdirSync(settings, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dir of dirs) {
        if (!dir.isDirectory() || !ACCOUNT.test(dir.name)) continue
        for (const mount of cachedAccount(posix.join(settings, dir.name), root)) {
          const cloudPath = mount.cloudName ? cloud.get(pathKey(mount.cloudName)) : undefined
          const base = existingDir(cloudPath ?? null) ?? existingDir(mount.path)
          if (!base) continue
          const nested = mount.nested ? posix.join(base, ...mount.nested) : null
          const path = nested ? existingDir(nested) ?? nested : base
          const key = pathKey(path)
          const was = byPath.get(key)
          if (was === undefined) byPath.set(key, { path, web: mount.web })
          else if (was && was.web !== mount.web) byPath.set(key, null)
        }
      }
    }
    return [...byPath.values()].filter((mount) => mount !== null)
  } catch {
    return []
  }
}
