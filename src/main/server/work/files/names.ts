import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { FilesListing } from '@shared/contract-work-files'
import { canvasSourcePath, type CanvasSource } from '@shared/work'
import { matchesName, nameWords, NAMES_MOST, rankName } from '@shared/work/fileSearch'
import { kindOfEntry, PLACE, type EntryKind, type FileEntry, type FilePlace, type FolderRef } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { isGuestPath } from '../office/vm/files'
import { vmState } from '../office/vm/office'
import type { Mark, MarkStore } from './marks'
import { folderTrail } from './places/folder'
import { librariesHere, vmLibrariesHere } from './places/libraries'
import { libraryTrail, placeOfPath, placesIn, type LibraryPlace } from './places/teams'
import { admitCaller, locate, NO_WORKSPACE, PEER_LIBRARIES, vmFor, workspaceHere, type Located } from './policy'
import type { TabStore } from './tabs'

/**
 * The names table (`work_files_names`, docs/agents/work-files.md "Search and Go to"): every file and folder
 * this host has listed or found for a workspace, by name, so Go to answers as he types from the database
 * alone, never a walk and never a call to the Windows VM. A row holds the thing's key, where it is (`ref`, the
 * same `{ file } | { folder }` a mark holds), its name, its place, its kind and when it changed. Nothing of a
 * file's bytes.
 *
 * Rows are written after an answer is sent (`feedNames`), never in its way. A row leaves when its file is gone
 * or its library is no longer listed (turned off, removed, signed out): at the `places` answer that no longer
 * lists it (`forgetGonePlaces`), and at any answer that finds it so.
 */

type NamedAt = { file: CanvasSource } | { folder: FolderRef }

interface Row {
  ref_key: string
  ref: string
  name: string
  place: string
  kind: string
  changed: number | null
}

/** Whether a caller could name a path of this host itself (handle.ts's own rule): a key by the listener's fence, a file in the VM by the guest-path rule. */
export const reachesPath = (ctx: Pick<WorkCtx, 'reaches'>, by: Caller, path: string): boolean => by.kind !== 'remote' || !!by.peer || (isGuestPath(path) && process.platform !== 'win32') || ctx.reaches(by, path)

/** His window, for the questions asked as the host itself: is this still there for anyone. */
const HOST_SELF: Caller = { kind: 'local', caps: [] }

/**
 * The library places a caller may reach on this host, from what is kept: OneDrive's folders here, and the
 * VM's libraries as last read. Never a wake and never a read behind (`teamsPlaces` may start one; this never does).
 */
export function listedLibraries(ctx: Pick<WorkCtx, 'db' | 'host' | 'reaches' | 'scopeOf' | 'settings'>, by: Caller): LibraryPlace[] {
  const places = librariesHere(ctx).flatMap((l) => placesIn(l, { state: 'ok' }))
  const vm = vmState()
  if (vmFor(ctx, by) && vm && !vm.cannot && vm.state !== 'none' && vm.state !== 'setting-up') places.push(...vmLibrariesHere(ctx).flatMap((l) => placesIn(l, { state: vm.state === 'awake' ? 'ok' : 'asleep' })))
  return places.filter((p) => reachesPath(ctx, by, p.top))
}

/** The ids a row's place may carry and still be listed: each place's, and its library's (a file at a team library's top, outside every channel). */
const idsOf = (places: readonly { id: string }[]): Set<string> => new Set(places.flatMap((p) => [p.id, p.id.split('/')[0]!]))

/** The place a located thing lies in, as its row and its `where` say it. */
export function placeOf(located: Located, libraries: readonly LibraryPlace[]): LibraryPlace | null {
  if (located.in !== 'library') return null
  return placeOfPath(libraries, located.library, located.path) ?? placesIn({ ...located.library, kind: located.library.kind === 'channels' ? 'library' : located.library.kind, channels: [] }, { state: 'ok' })[0]!
}

/** Whether `path` is `dir` or under it, as a library's own computer spells paths (the VM's case-blind, with backslashes). */
const inside = (path: string, dir: string): boolean => {
  if (isGuestPath(dir)) {
    const [p, d] = [path.toLowerCase(), dir.toLowerCase().replace(/\\+$/, '')]
    return p === d || p.startsWith(`${d}\\`)
  }
  return path === dir || path.startsWith(`${dir.replace(/\/+$/, '')}/`)
}

const parentOf = (path: string): string => (isGuestPath(path) ? path.slice(0, Math.max(path.lastIndexOf('\\'), 2)) : dirname(path))

/** Where a located thing lives, as a result row says it: its place's id and name, and the folders down to it. */
export function whereOf(ctx: Pick<WorkCtx, 'host'>, located: Located, place: LibraryPlace | null): FileEntry['where'] | undefined {
  if (located.in === 'folder') {
    const dir = located.path === located.root ? located.root : dirname(located.path)
    return { place: PLACE.folder, name: located.workspace.name, trail: folderTrail(ctx.host, located.workspace, located.root, dir).slice(1).map((c) => c.name) }
  }
  if (located.in !== 'library' || !place) return undefined
  const below = located.path.length > place.top.length
  return { place: place.place.id, name: place.place.name, trail: below ? libraryTrail(place, parentOf(located.path)).slice(1).map((c) => c.name) : [] }
}

// ── writing ───────────────────────────────────────────────────────────

const UPSERT = `INSERT INTO work_files_names (workspace_id, ref_key, ref, name, place, kind, changed) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (workspace_id, ref_key) DO UPDATE SET ref = excluded.ref, name = excluded.name, place = excluded.place, kind = excluded.kind, changed = excluded.changed`
const statements = new WeakMap<DatabaseSync, ReturnType<DatabaseSync['prepare']>>()

/** One named row to keep: the entry as answered, and the id of the place it lies in. */
export interface NameRow {
  entry: FileEntry
  place: string
}

/** Writes rows now, in one savepoint, through one prepared statement. A row that names neither a file nor a folder is skipped. */
export function putNames(db: DatabaseSync, workspaceId: string, rows: readonly NameRow[]): void {
  if (!rows.length) return
  let upsert = statements.get(db)
  if (!upsert) statements.set(db, (upsert = db.prepare(UPSERT)))
  db.exec('SAVEPOINT files_names')
  try {
    for (const { entry, place } of rows) {
      const at: NamedAt | null = entry.ref ? { file: entry.ref } : entry.folder ? { folder: entry.folder } : null
      if (at) upsert.run(workspaceId, entry.key, JSON.stringify(at), entry.name, place, entry.kind, entry.changed ?? null)
    }
    db.exec('RELEASE files_names')
  } catch (err) {
    db.exec('ROLLBACK TO files_names')
    db.exec('RELEASE files_names')
    throw err
  }
}

/** Writes rows after the answer in hand is sent: never in its way. A failure is logged, and the next list writes them again. */
export function feedNames(ctx: Pick<WorkCtx, 'db' | 'log'>, workspaceId: string, rows: () => readonly NameRow[]): void {
  setImmediate(() => {
    try {
      putNames(ctx.db, workspaceId, rows())
    } catch (err) {
      ctx.log(`files: the names of a page could not be kept: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/**
 * A page a `list` answered, kept by name: the workspace's own folder's rows and a library's, each under the
 * place it lies in. A lens (Recent, Starred) lists marks, not a place, and is not kept.
 */
export function feedListing(ctx: WorkCtx, by: Caller, workspaceId: string, at: FolderRef, listing: FilesListing): void {
  if (!listing.entries.length || (at.at === 'place' && (at.id === PLACE.recent || at.id === PLACE.starred))) return
  feedNames(ctx, workspaceId, () => {
    if (!workspaceHere(ctx.db, workspaceId)) return []
    const libraries = listedLibraries(ctx, by)
    const out: NameRow[] = []
    for (const entry of listing.entries) {
      const ref = entry.ref ?? entry.folder
      const path = ref && ref.at !== 'drive' && ref.at !== 'project' && ref.at !== 'place' ? canvasSourcePath(ref as CanvasSource) : null
      if (path === null) continue
      if (!entry.shared) {
        out.push({ entry, place: PLACE.folder })
        continue
      }
      // Each row's own place: a channel's folder at a team library's top is that channel; a file beside it, the library.
      const place = libraries.filter((l) => inside(path, l.top)).sort((a, b) => b.top.length - a.top.length)[0]
      const library = place ? null : libraries.find((l) => inside(path, l.library.path))
      if (place || library) out.push({ entry, place: place ? place.place.id : library!.library.id })
    }
    return out
  })
}

/** A library left: its rows go. */
export function forgetPlaceNames(db: DatabaseSync, workspaceId: string, placeId: string): void {
  db.prepare(`DELETE FROM work_files_names WHERE workspace_id = ? AND place = ?`).run(workspaceId, placeId)
}

/**
 * What a `places` answer for his window listed, against the places the table holds rows of: the rows of every
 * place no longer listed go. One DISTINCT query, run after the answer is sent.
 */
export function forgetGonePlaces(ctx: Pick<WorkCtx, 'db' | 'log'>, workspaceId: string, places: readonly Pick<FilePlace, 'id' | 'kind'>[]): void {
  setImmediate(() => {
    try {
      const listed = idsOf(places)
      const held = ctx.db.prepare(`SELECT DISTINCT place FROM work_files_names WHERE workspace_id = ?`).all(workspaceId) as { place: string }[]
      for (const { place } of held) if (place !== PLACE.folder && !listed.has(place)) forgetPlaceNames(ctx.db, workspaceId, place)
    } catch (err) {
      ctx.log(`files: gone places' names could not be dropped: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/** A file or folder was renamed or moved by a verb: its row takes the new key and name. The rows under a folder go, and come back when it is listed. */
export function renameName(db: DatabaseSync, workspaceId: string, oldKey: string, entry: FileEntry, place?: string): void {
  const was = db.prepare(`SELECT place FROM work_files_names WHERE workspace_id = ? AND ref_key = ?`).get(workspaceId, oldKey) as { place: string } | undefined
  dropName(db, workspaceId, oldKey)
  const at = place ?? was?.place
  if (at) putNames(db, workspaceId, [{ entry, place: at }])
}

/** A file or folder went (deleted, moved out): its row goes, and every row under it. */
export function dropName(db: DatabaseSync, workspaceId: string, key: string): void {
  const under = `${key.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`
  db.prepare(`DELETE FROM work_files_names WHERE workspace_id = ? AND (ref_key = ? OR ref_key LIKE ? ESCAPE '\\')`).run(workspaceId, key, under)
}

// ── reading ───────────────────────────────────────────────────────────

const like = (word: string): string => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
/** How many rows of the table are looked at for one answer, at most. */
const CANDIDATES = 200

/** A row of the table as an entry. */
function entryOfRow(row: Row): FileEntry | null {
  let at: NamedAt
  try {
    at = JSON.parse(row.ref) as NamedAt
  } catch {
    return null
  }
  const file = 'file' in at ? at.file : null
  const folder = 'folder' in at ? at.folder : null
  if (!file && !folder) return null
  return { key: row.ref_key, ref: file, folder, name: row.name, kind: row.kind as EntryKind, ...(row.changed !== null ? { changed: row.changed } : {}) }
}

/** The rows of the table whose names hold every word, the likeliest first: a name that starts with the first word, then the newest. */
export function nameRows(db: DatabaseSync, workspaceId: string, words: readonly string[], o: { most?: number; places?: readonly string[] } = {}): (FileEntry & { place: string })[] {
  const args: (string | number)[] = [workspaceId, ...words.map(like)]
  const places = o.places?.length ? ` AND place IN (${o.places.map(() => '?').join(', ')})` : ''
  if (o.places?.length) args.push(...o.places)
  const first = words[0] ? `(name LIKE ? ESCAPE '\\') DESC, ` : ''
  if (words[0]) args.push(`${words[0].replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  args.push(o.most ?? CANDIDATES)
  const rows = db
    .prepare(`SELECT ref_key, ref, name, place, kind, changed FROM work_files_names WHERE workspace_id = ?${words.map(() => ` AND name LIKE ? ESCAPE '\\'`).join('')}${places} ORDER BY ${first}changed DESC LIMIT ?`)
    .all(...args) as unknown as Row[]
  return rows.flatMap((row) => {
    const e = entryOfRow(row)
    // SQLite's LIKE folds only ASCII: the words are held to the name again here.
    return e && matchesName(e.name, words) ? [{ ...e, place: row.place }] : []
  })
}

const pathOfRef = (ref: CanvasSource | FolderRef): { host: string; path: string } | null => {
  if (ref.at === 'drive' || ref.at === 'project' || ref.at === 'place') return null
  const path = canvasSourcePath(ref as CanvasSource)
  return path === null ? null : { host: (ref as { host: string }).host, path }
}

/**
 * Whether a row may be answered to this caller, and where it lives: a thing of this host is located for the
 * caller (what throws is dropped), and its library must still be listed. What is gone for everyone, or lies in
 * a library no longer listed, leaves the table too.
 */
export function checkRow(ctx: WorkCtx, by: Caller, workspaceId: string, entry: FileEntry, o: { place?: string; listed: Set<string>; libraries: readonly LibraryPlace[]; method: string }): FileEntry | null {
  const ref = entry.ref ?? entry.folder
  const at = ref ? pathOfRef(ref) : null
  // A thing on another host is that host's to fence when it is opened.
  if (!at || at.host !== ctx.host) return entry
  let located: Located
  try {
    located = locate(ctx, by, workspaceId, ref!, o.method)
  } catch {
    if (o.place !== undefined) {
      try {
        locate(ctx, HOST_SELF, workspaceId, ref!, o.method)
      } catch {
        // Gone for everyone: the row goes, and every row of its place where the host lists the place no more.
        if (o.place !== PLACE.folder && !idsOf(listedLibraries(ctx, HOST_SELF).map((l) => l.place)).has(o.place)) forgetPlaceNames(ctx.db, workspaceId, o.place)
        else dropName(ctx.db, workspaceId, entry.key)
      }
    }
    return null
  }
  if (located.in === 'place') return null
  const place = placeOf(located, o.libraries)
  if (located.in === 'library') {
    const id = place?.place.id ?? o.place ?? ''
    if (!o.listed.has(id)) {
      // Not listed for this caller; where the host itself lists it no more, its rows go.
      if (o.place !== undefined && !idsOf(listedLibraries(ctx, HOST_SELF).map((l) => l.place)).has(id)) forgetPlaceNames(ctx.db, workspaceId, o.place)
      return null
    }
  }
  const where = whereOf(ctx, located, place)
  return { ...entry, ...(located.in === 'library' ? { shared: true } : {}), ...(where ? { where } : {}) }
}

/** A mark (a recent) as a row, when it names a file or folder. */
function markRow(m: Mark): FileEntry {
  const folder = 'folder' in m.at
  const ref = 'file' in m.at ? m.at.file : null
  return {
    key: m.key,
    ref,
    folder: folder ? (m.at as { folder: FolderRef }).folder : null,
    name: m.name,
    kind: folder ? 'folder' : kindOfEntry(m.name).kind,
    ...(m.openedAt ? { changed: m.openedAt } : {}),
    ...(m.starred ? { starred: true } : {}),
    ...(m.madeBy ? { madeBy: m.madeBy, fresh: m.seenAt === null } : {})
  }
}

/**
 * Go to's list (`work.files.names`): 20 rows at most, at once, from the database alone. The open tabs and
 * recents first (not for a thread: they are his own), then the names that hold every word, ranked. No words:
 * the recents alone. Every row is checked for the caller before it is answered (`checkRow`).
 */
export function namesAnswer(ctx: WorkCtx, by: Caller, p: { workspaceId: string; text: string }, state: { marks: MarkStore; tabs: TabStore }, method: string): { entries: FileEntry[] } {
  admitCaller(ctx, by, p.workspaceId)
  if (by.peer) throw new Error(PEER_LIBRARIES)
  if (!workspaceHere(ctx.db, p.workspaceId)) throw new Error(NO_WORKSPACE)
  const words = nameWords(p.text)
  const libraries = listedLibraries(ctx, by)
  const listed = idsOf(libraries.map((l) => l.place))
  const out = new Map<string, FileEntry>()
  const take = (entry: FileEntry | null, place?: string): void => {
    if (!entry || out.size >= NAMES_MOST || out.has(entry.key)) return
    const checked = checkRow(ctx, by, p.workspaceId, entry, { place, listed, libraries, method })
    if (checked) out.set(checked.key, checked)
  }
  if (by.kind !== 'model') {
    if (words.length) {
      for (const tab of state.tabs.list(p.workspaceId).tabs) {
        if (tab.kind !== 'file' || !tab.key || !matchesName(tab.name, words)) continue
        const item = tab.itemId ? ctx.canvas.get(tab.itemId) : null
        const ref: CanvasSource | null = tab.copyOf ? { at: 'file', host: tab.copyOf.host, path: tab.copyOf.path } : (item?.source ?? null)
        if (ref && ref.at !== 'thread') take({ key: tab.key, ref, folder: null, name: tab.name, kind: kindOfEntry(tab.name).kind })
      }
    }
    for (const m of state.marks.recent(p.workspaceId)) if (matchesName(m.name, words)) take(markRow(m))
  }
  if (words.length) {
    const rows = nameRows(ctx.db, p.workspaceId, words)
    rows.sort((a, b) => rankName(b.name, words) - rankName(a.name, words) || (b.changed ?? 0) - (a.changed ?? 0))
    for (const { place, ...entry } of rows) {
      if (out.size >= NAMES_MOST) break
      take(entry, place)
    }
  }
  const marks = state.marks.of(p.workspaceId, [...out.keys()])
  return {
    entries: [...out.values()].map((e) => {
      const m = marks.get(e.key)
      return m ? { ...e, ...(m.starred ? { starred: true } : {}), ...(m.madeBy ? { madeBy: m.madeBy, fresh: m.seenAt === null } : {}) } : e
    })
  }
}
