import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, realpathSync, statSync, type Stats } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { teamsKindOf, type TeamsEntry, type TeamsFileKind, type TeamsLibrary, type TeamsRoot } from '@shared/contract-work-office'
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

/** What OneDrive syncs here, as it lies on disk. */
function found(host: string): TeamsLibrary[] {
  const base = cloudDir(host)
  const out: TeamsLibrary[] = []
  for (const top of dirsIn(base)) {
    const shared = /^OneDrive-SharedLibraries-(.+)$/.exec(top)
    const mine = /^OneDrive-(.+)$/.exec(top)
    if (shared) {
      for (const name of dirsIn(join(base, top))) {
        const path = join(base, top, name)
        const { team, library } = splitLibraryName(name)
        const channels = library === null || TEAM_LIBRARIES.test(library)
        out.push({ id: libraryId(host, path), host, path, team, library: channels ? null : library, tenant: shared[1]!, kind: channels ? 'channels' : 'library', channels: channels ? dirsIn(path) : [], web: null, found: true })
      }
    } else if (mine) {
      const path = join(base, top)
      out.push({ id: libraryId(host, path), host, path, team: 'My files', library: null, tenant: mine[1]!, kind: 'mine', channels: [], web: null, found: true })
    }
  }
  return out
}

/** Every library on this host, his edits laid over what was found, by team then library. */
export function librariesOf(db: DatabaseSync, host: string): TeamsLibrary[] {
  const roots = rootsOf(db)
  const edit = new Map(roots.map((r) => [r.folder, r]))
  const libs = found(host).filter((l) => !edit.get(l.path)?.off)
  const known = new Set(libs.map((l) => l.path))
  for (const r of roots) {
    if (r.off || known.has(r.folder)) continue
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
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && !/^[a-zA-Z]:/.test(r))
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

/** Files and folders whose names hold every word of `query`, newest first; `more`: the walk stopped before the end. */
export function searchLibraries(libs: readonly TeamsLibrary[], query: string, kind?: TeamsFileKind): { entries: TeamsEntry[]; more: boolean } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits: TeamsEntry[] = []
  let dirs = 0
  let more = false
  for (const library of libs) {
    const queue = [library.path]
    while (queue.length) {
      if (++dirs > SEARCH_DIRS) {
        more = true
        break
      }
      const dir = queue.shift()!
      let items
      try {
        items = readdirSync(dir, { withFileTypes: true })
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
        try {
          hits.push(entryOf(library.id, path))
        } catch {
          continue
        }
      }
    }
  }
  hits.sort((a, b) => b.modified - a.modified)
  return { entries: hits.slice(0, SEARCH_MAX), more: more || hits.length > SEARCH_MAX }
}

export const FETCH_MS = 10 * 60_000

/** Reads the file to its end, which makes OneDrive download one it keeps in the cloud; answers it as it is now. */
export async function fetchFile(library: string, path: string, signal?: AbortSignal): Promise<TeamsEntry> {
  const before = statSync(path)
  if (before.isDirectory()) throw new Error('That is a folder.')
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
    await fetchFile('', path)
    return cut((await readFile(path, 'utf8')).replace(/^﻿/, ''))
  }
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
  if (kind === 'workbook') throw new Error('A workbook is read through Excel: open it with teams_open, then read a range with office_range_read.')
  if (kind === 'pdf') throw new Error('A PDF is read in the canvas: open it with teams_open, then use the pdf tools.')
  throw new Error(`${basename(path)} has no text to read.`)
}

export const BYTES_MAX = 48 * 1024 * 1024
