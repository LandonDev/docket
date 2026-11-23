import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, realpathSync, statSync, type Stats } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { teamsKindOf, type TeamsEntry, type TeamsFileKind, type TeamsLibrary, type TeamsPlace, type TeamsRoot } from '@shared/contract-work-office'
import { zipEntries } from './zip'

/**
 * Teams files (docs/agents/work-files.md): the Teams and SharePoint libraries the OneDrive app
 * syncs on this host, read where they lie. Nothing here copies a file anywhere; a file OneDrive
 * keeps in the cloud is downloaded only by `fetch` (or by reading it), when he or a thread opens it.
 *
 * On a Mac, OneDrive syncs under ~/Library/CloudStorage:
 *  - `OneDrive-<Tenant>/`: his own files (with any "Add shortcut to My files" folders in it);
 *  - `OneDrive-SharedLibraries-<Tenant>/<Team or site> - <Library>/`: each synced library. A team's
 *    library is "Documents" (or "Shared Documents"), and its top folders are the team's channels.
 * His own edits to that list (a folder added, a found one off, a folder's web address) are a row of
 * this pillar's own table.
 */

let cloudDir = (_host: string): string => join(homedir(), 'Library', 'CloudStorage')
/** A test points the finder at a dummy CloudStorage, per host. */
export const setCloudDir = (dir: (host: string) => string): void => void (cloudDir = dir)
/** Where OneDrive and the other cloud apps keep their folders on this host. */
export const cloudDirOf = (host: string): string => cloudDir(host)

export function ensureFilesTables(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS work_office_files (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
}

const getValue = (db: DatabaseSync, key: string): string | null => (db.prepare('SELECT value FROM work_office_files WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
const setValue = (db: DatabaseSync, key: string, value: string | null): void =>
  void (value === null ? db.prepare('DELETE FROM work_office_files WHERE key = ?').run(key) : db.prepare('INSERT OR REPLACE INTO work_office_files (key, value) VALUES (?, ?)').run(key, value))

export function rootsOf(db: DatabaseSync): TeamsRoot[] {
  try {
    const v = JSON.parse(getValue(db, 'roots') ?? '[]') as TeamsRoot[]
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
/** His edits, one row per folder; a row that says nothing is dropped. */
export function setRoots(db: DatabaseSync, roots: readonly TeamsRoot[]): TeamsRoot[] {
  const byFolder = new Map<string, TeamsRoot>()
  for (const r of roots) {
    const folder = resolve(r.folder.replace(/^~(?=\/|$)/, homedir()))
    byFolder.set(folder, { folder, ...(r.off ? { off: true } : {}), ...(r.web ? { web: r.web } : {}) })
  }
  const kept = [...byFolder.values()]
  setValue(db, 'roots', JSON.stringify(kept))
  return kept
}

/** Whether a workspace here may copy Teams files from another host: off unless he turned it on. */
export const copyAllowed = (db: DatabaseSync, workspaceId: string): boolean => getValue(db, `copy:${workspaceId}`) === '1'
export const setCopyAllowed = (db: DatabaseSync, workspaceId: string, on: boolean): void => setValue(db, `copy:${workspaceId}`, on ? '1' : null)

const TEAM_LIBRARIES = /^(shared )?documents$/i
const hidden = (name: string): boolean => name.startsWith('.') || name.startsWith('~$') || name === 'Icon\r' || name.endsWith('.tmp')

const dirsIn = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !hidden(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export const libraryId = (host: string, path: string): string => `${host}~${createHash('sha1').update(path).digest('hex').slice(0, 10)}`

/** `<Team or site> - <Library>`: the last " - " parts them, since a team's own name may hold one. */
export function splitLibraryName(name: string): { team: string; library: string | null } {
  const at = name.lastIndexOf(' - ')
  return at > 0 ? { team: name.slice(0, at), library: name.slice(at + 3) } : { team: name, library: null }
}

/**
 * The tenant a top folder `OneDrive-<name>` belongs to, when another top folder is that tenant's
 * own OneDrive: OneDrive 26 names a library synced from Teams `OneDrive-<tenant>-<rest>` beside his
 * `OneDrive-<tenant>` (observed: `OneDrive-purdue.edu-RecWell-TeamRecWell` beside
 * `OneDrive-purdue.edu`). The longest tenant that fits wins; null: his own OneDrive.
 */
export function tenantOfSynced(name: string, tenants: readonly string[]): string | null {
  const fits = tenants.filter((t) => t !== name && name.startsWith(`${t}-`) && name.length > t.length + 1)
  return fits.sort((a, b) => b.length - a.length)[0] ?? null
}

/** Every team has a General channel, and its folder sits at the top of the team's library: the one sign on disk that the top folders are channels. */
const hasChannels = (dirs: readonly string[]): boolean => dirs.some((d) => d.toLowerCase() === 'general')

/** What OneDrive syncs here, as it lies on disk, in either of the two layouts docs/agents/work-files.md describes. */
function found(host: string): TeamsLibrary[] {
  const base = cloudDir(host)
  const out: TeamsLibrary[] = []
  const tops = dirsIn(base)
  // `OneDrive-<name>` folders, less the older layout's SharedLibraries and a consumer OneDrive (no Teams file).
  const names = tops.map((top) => /^OneDrive-(.+)$/.exec(top)?.[1]).filter((n): n is string => !!n && !n.startsWith('SharedLibraries-') && n !== 'Personal')
  for (const top of tops) {
    const shared = /^OneDrive-SharedLibraries-(.+)$/.exec(top)
    const mine = /^OneDrive-(.+)$/.exec(top)
    if (shared) {
      for (const name of dirsIn(join(base, top))) {
        const path = join(base, top, name)
        const { team, library } = splitLibraryName(name)
        const channels = library === null || TEAM_LIBRARIES.test(library)
        out.push({ id: libraryId(host, path), host, path, team, library: channels ? null : library, tenant: shared[1]!, kind: channels ? 'channels' : 'library', channels: channels ? dirsIn(path) : [], web: null, found: true })
      }
    } else if (mine && names.includes(mine[1]!)) {
      const path = join(base, top)
      const tenant = tenantOfSynced(mine[1]!, names)
      if (!tenant) {
        // His own OneDrive, which holds the shortcuts he adds to My files.
        out.push({ id: libraryId(host, path), host, path, team: 'My files', library: null, tenant: mine[1]!, kind: 'mine', channels: [], web: null, found: true })
        continue
      }
      // A synced library: its name as OneDrive wrote it. Site and library are joined by a dash, as a name's own dashes and
      // its dropped spaces are, so the two cannot be told apart from the name alone; nothing is guessed.
      const dirs = dirsIn(path)
      const channels = hasChannels(dirs)
      out.push({ id: libraryId(host, path), host, path, team: mine[1]!.slice(tenant.length + 1), library: null, tenant, kind: channels ? 'channels' : 'library', channels: channels ? dirs : [], web: null, found: true })
    }
  }
  return out
}

/**
 * Every library on this host, his edits laid over what was found, by team then library. Each is
 * named by its real path (a folder he added through a link, as an older OneDrive's `~/<Tenant>` is,
 * lands on the library it points to), so every entry's path starts with its library's.
 */
export function librariesOf(db: DatabaseSync, host: string): TeamsLibrary[] {
  const roots = rootsOf(db).map((r) => ({ ...r, folder: real(r.folder) ?? r.folder }))
  const edit = new Map(roots.map((r) => [r.folder, r]))
  const libs: TeamsLibrary[] = []
  const known = new Set<string>()
  for (const l of found(host)) {
    const path = real(l.path)
    if (!path || known.has(path) || edit.get(path)?.off) continue
    known.add(path)
    libs.push({ ...l, id: libraryId(host, path), path })
  }
  for (const r of roots) {
    if (r.off || known.has(r.folder) || !real(r.folder)) continue
    known.add(r.folder)
    const { team, library } = splitLibraryName(basename(r.folder))
    libs.push({ id: libraryId(host, r.folder), host, path: r.folder, team, library, tenant: null, kind: 'folder', channels: [], web: null, found: false })
  }
  for (const l of libs) l.web = edit.get(l.path)?.web ?? null
  return libs.sort((a, b) => a.team.localeCompare(b.team) || (a.library ?? '').localeCompare(b.library ?? ''))
}

/** A folder found here that he turned off: listed in Settings so he can turn it on again. */
export const offFolders = (db: DatabaseSync): string[] => rootsOf(db).filter((r) => r.off).map((r) => r.folder)

const real = (path: string): string | null => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
const within = (path: string, dir: string): boolean => {
  const r = relative(dir, path)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !r.startsWith(sep) && !/^[a-zA-Z]:/.test(r))
}

/**
 * The library a path lies in, by its real path, or null: the one fence every Teams file read and
 * open passes. A link out of a library, or `..`, leaves it.
 */
export function libraryOf(libs: readonly TeamsLibrary[], path: string): { library: TeamsLibrary; path: string } | null {
  const at = real(path)
  if (!at) return null
  for (const library of libs) {
    const root = real(library.path)
    if (root && within(at, root)) return { library, path: at }
  }
  return null
}

/** Whether a file's bytes are on this disk: OneDrive's cloud-only file (macOS's "dataless") has its full size and no blocks. */
export const isLocal = (s: Pick<Stats, 'size' | 'blocks'>): boolean => s.size === 0 || s.blocks > 0

const OFFICE_ZIP = /\.(docx|docm|xlsx|xlsm|pptx|pptm)$/i
const whoCache = new Map<string, string | null>()
/** Who last saved an Office file, from its own properties; read only from a file already on disk, so a list never downloads one. */
function whoOf(path: string, s: Stats): string | null {
  if (!OFFICE_ZIP.test(path) || !isLocal(s)) return null
  const key = `${path}\u0000${s.mtimeMs}\u0000${s.size}`
  if (whoCache.has(key)) return whoCache.get(key)!
  const core = zipEntries(path, ['docProps/core.xml'], 256 * 1024).get('docProps/core.xml')
  const name = core ? (/<cp:lastModifiedBy>([^<]*)<\/cp:lastModifiedBy>/.exec(core)?.[1] ?? /<dc:creator>([^<]*)<\/dc:creator>/.exec(core)?.[1] ?? null) : null
  const who = name ? decodeXml(name).trim() || null : null
  if (whoCache.size > 5000) whoCache.clear()
  whoCache.set(key, who)
  return who
}

export function entryOf(library: string, path: string, s: Stats = statSync(path)): TeamsEntry {
  const dir = s.isDirectory()
  const name = basename(path)
  return { name, path, library, kind: dir ? 'folder' : teamsKindOf(name), size: dir ? 0 : s.size, modified: Math.round(s.mtimeMs), local: dir || isLocal(s), by: dir ? null : whoOf(path, s) }
}

/** One folder: folders first, then files, each by name. */
export function listFolder(library: TeamsLibrary, dir: string): TeamsEntry[] {
  const out: TeamsEntry[] = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (hidden(d.name) || d.isSymbolicLink()) continue
    try {
      out.push(entryOf(library.id, join(dir, d.name)))
    } catch {
      // Gone between the list and the stat.
    }
  }
  return out.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name))
}

export const SEARCH_MAX = 200
const SEARCH_DIRS = 20_000
const SEARCH_HITS = 1_000
const SEARCH_MS = 15_000

/**
 * Files and folders whose names hold every word of `query`, newest first; `more`: the walk stopped
 * before the end (20,000 folders, 1,000 names or 15 seconds). It reads names only and yields between
 * folders, so a walk over a library OneDrive has not listed yet never holds the host; only the hits
 * shown are looked at closer.
 */
export async function searchLibraries(libs: readonly TeamsLibrary[], query: string, kind?: TeamsFileKind, now = Date.now): Promise<{ entries: TeamsEntry[]; more: boolean }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits: { library: string; path: string }[] = []
  const until = now() + SEARCH_MS
  let dirs = 0
  let more = false
  walk: for (const library of libs) {
    const queue = [library.path]
    while (queue.length) {
      if (++dirs > SEARCH_DIRS || hits.length >= SEARCH_HITS || now() > until) {
        more = true
        break walk
      }
      const dir = queue.shift()!
      let items
      try {
        items = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const d of items) {
        if (hidden(d.name) || d.isSymbolicLink()) continue
        const path = join(dir, d.name)
        if (d.isDirectory()) queue.push(path)
        const name = d.name.toLowerCase()
        if (!words.every((w) => name.includes(w))) continue
        if (kind && (d.isDirectory() ? 'folder' : teamsKindOf(d.name)) !== kind) continue
        hits.push({ library: library.id, path })
      }
    }
  }
  const stated: { hit: { library: string; path: string }; s: Stats }[] = []
  for (const hit of hits) {
    try {
      stated.push({ hit, s: await stat(hit.path) })
    } catch {
      continue
    }
  }
  stated.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
  return { entries: stated.slice(0, SEARCH_MAX).map(({ hit, s }) => entryOf(hit.library, hit.path, s)), more: more || stated.length > SEARCH_MAX }
}

export const FETCH_MS = 10 * 60_000

/** Reads the file to its end, which makes OneDrive download one it keeps in the cloud; answers it as it is now. */
export async function fetchFile(library: string, path: string, signal?: AbortSignal): Promise<TeamsEntry> {
  const before = statSync(path)
  if (before.isDirectory()) throw new Error('That is a folder.')
  if (signal?.aborted) throw new Error('cancelled')
  if (!isLocal(before)) {
    await new Promise<void>((done, fail) => {
      const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
      const timer = setTimeout(() => stream.destroy(new Error('OneDrive did not download the file in 10 minutes.')), FETCH_MS)
      const stop = () => stream.destroy(new Error('cancelled'))
      signal?.addEventListener('abort', stop, { once: true })
      stream.on('data', () => {})
      stream.on('error', (err) => (clearTimeout(timer), signal?.removeEventListener('abort', stop), fail(err)))
      stream.on('end', () => (clearTimeout(timer), signal?.removeEventListener('abort', stop), done()))
    })
  }
  return entryOf(library, path)
}

export const TEXT_MAX = 200_000
/** The most a Word file or deck may be for its text to be read (checked before it downloads). */
const OFFICE_TEXT_MAX = 256 * 1024 * 1024
const decodeXml = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
    if (named[e.toLowerCase()]) return named[e.toLowerCase()]!
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : m
  })
/** The text runs of an Office part, a line per paragraph. */
const runsOf = (xml: string, tag: 'w' | 'a'): string =>
  xml
    .split(new RegExp(`</${tag}:p>`))
    .map((p) => [...p.matchAll(new RegExp(`<${tag}:t(?:\\s[^>]*)?>([^<]*)</${tag}:t>`, 'g'))].map((m) => decodeXml(m[1]!)).join(''))
    .filter((line) => line.trim())
    .join('\n')

/**
 * A file's text, for a thread that asked to read it: a Word file's paragraphs, a deck's slides in
 * order, a text file as it is. A workbook is read through Excel (`office_range_read`), a PDF in the
 * canvas; both say so. Reading downloads a cloud-only file.
 */
export async function readText(path: string): Promise<{ text: string; truncated: boolean }> {
  const kind = teamsKindOf(path)
  const cut = (text: string) => ({ text: text.slice(0, TEXT_MAX), truncated: text.length > TEXT_MAX })
  if (kind === 'text' || /\.csv$/i.test(path)) {
    // Only the head is read: a log or a CSV may run to gigabytes, and OneDrive downloads what is read.
    const file = await open(path, 'r')
    try {
      const buf = Buffer.alloc(TEXT_MAX * 4)
      const { bytesRead } = await file.read(buf, 0, buf.length, 0)
      const text = buf.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')
      const { size } = await file.stat()
      return { text: text.slice(0, TEXT_MAX), truncated: text.length > TEXT_MAX || size > bytesRead }
    } finally {
      await file.close()
    }
  }
  if (statSync(path).size > OFFICE_TEXT_MAX) throw new Error(`${basename(path)} is too big to read here: open it in its app.`)
  if (/\.(docx|docm)$/i.test(path)) {
    await fetchFile('', path)
    const xml = zipEntries(path, ['word/document.xml'], 64 * 1024 * 1024).get('word/document.xml')
    if (xml === undefined) throw new Error('That Word file could not be read.')
    return cut(runsOf(xml, 'w'))
  }
  if (/\.(pptx|pptm)$/i.test(path)) {
    await fetchFile('', path)
    const slides = [...zipEntries(path, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n), 16 * 1024 * 1024)].sort(([a], [b]) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
    if (!slides.length) throw new Error('That deck could not be read.')
    return cut(slides.map(([, xml], i) => `Slide ${i + 1}\n${runsOf(xml, 'a')}`).join('\n\n'))
  }
  throw noText(basename(path))
}

/** Why a file of this name has no text to read here, in the words a thread acts on. */
export function noText(name: string): Error {
  const kind = teamsKindOf(name)
  if (kind === 'workbook') return new Error('A workbook is read through Excel: open it with teams_open, then read a range with office_range_read.')
  if (kind === 'pdf') return new Error('A PDF is read in the canvas: open it with teams_open, then use the pdf tools.')
  return new Error(`${name} has no text to read.`)
}

/**
 * OneDrive's own folders on this host as a place Teams files come from (`TeamsPlace`): none on a host
 * with no CloudStorage folder (the box: null), nothing synced yet, his own files only, or libraries.
 */
export function foldersPlace(host: string): TeamsPlace | null {
  if (!real(cloudDir(host))) return null
  const libs = found(host)
  if (!libs.length) return { kind: 'folders', state: 'no-onedrive', account: null }
  return { kind: 'folders', state: libs.some((l) => l.kind !== 'mine') ? 'ok' : 'no-libraries', account: null }
}

export const BYTES_MAX = 48 * 1024 * 1024
