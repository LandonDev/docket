import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { lstat, opendir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileSearchFilter, FilesListing, SavedFileSearch } from '@shared/contract-work-files'
import type { TeamsEntry, TeamsLibrary } from '@shared/contract-work-office'
import { WITHIN_MS } from '@shared/work/docFind'
import { matchesName, nameWords, SEARCH_PAGE, searchOfView, viewOfSearch } from '@shared/work/fileSearch'
import { kindOfEntry, PLACE, type FileEntry } from '@shared/work/files'
import { dropView, keepText, listViews, saveView } from '../docs/find'
import type { Caller, WorkCtx } from '../modules'
import { searchLibraries, whoOf } from '../office/files/library'
import { vmSearch } from '../office/vm/files'
import { vmState } from '../office/vm/office'
import { WORK_OWNER_NAME_SETTING } from '../preamble'
import type { MarkStore } from './marks'
import { checkRow, feedNames, listedLibraries, nameRows, placeOf, reachesPath, whereOf, type NameRow } from './names'
import { bytesHere, entryOfRow, hiddenName, type DiskRow } from './places/disk'
import { LIFEOS_BY, searchLifeos, withProjects } from './places/lifeos'
import { libraryKey, type LibraryPlace } from './places/teams'
import { admitCaller, workspaceHere, type WorkspaceRow } from './policy'

/**
 * Search in the Files place (`work.files.search`, docs/agents/work-files.md "Search and Go to"): names in
 * every place of this host the caller may reach, and words inside small files of his own.
 *
 * Each source runs at once beside the others, with its own deadline, and gives the event loop a turn as it
 * goes; a hit is one row whichever source found it (by its key):
 *  - the names table: what this host listed or found before, at once;
 *  - a walk of the workspace's folder: names streamed folder by folder (`opendir`), hidden names and links
 *    left out as a listing leaves them; and the text of a `.md`, `.txt` or `.csv` of 512 KB or less whose
 *    bytes are here;
 *  - the office pillar's walk of the libraries on this disk (`searchLibraries`);
 *  - the guest's own walk in the Windows VM (`vmSearch`), only while it is awake or for a caller that has no
 *    window to keep painting; a window's search never wakes it, and names the places it left out (`asleep`).
 *
 * A later place (LifeOS, Google Drive, mail) is one more source: a function of the shape `PlaceSource` below,
 * added to `SOURCES`. It answers rows with their place's id, honours the signal, and holds to its own deadline.
 *
 * Results are kept 30 seconds per caller, query and filter, so the next page runs nothing again.
 */

/** The caps of one search; a test narrows them. */
const CAPS = { dirs: 20_000, hits: 2_000, ms: 10_000, sourceMs: 20_000, textFiles: 200, textBytes: 512 * 1024, keptMs: 30_000, kept: 8 }
export const setSearchCaps = (caps: Partial<typeof CAPS> | null): void => void Object.assign(CAPS, caps ?? { dirs: 20_000, hits: 2_000, ms: 10_000, sourceMs: 20_000, textFiles: 200, textBytes: 512 * 1024, keptMs: 30_000, kept: 8 })
/** What the walks did, for the tests and the bench to count. */
export const searchCounts = { folders: 0, texts: 0, runs: 0 }

const TEXT_FILE = /\.(md|markdown|txt|csv)$/i
const CANCELLED = 'cancelled'

/** One row found, and the id of the place it lies in. */
export interface Hit {
  entry: FileEntry
  place: string
}

/** What one source answers: its rows, whether it stopped before its end, and the places it left asleep. */
export interface SourceAnswer {
  hits: Hit[]
  more?: boolean
  asleep?: string[]
}

/** What every source is told: who asks, the words, the filter, the places it may search, the signal. */
export interface SearchScope {
  ctx: WorkCtx
  by: Caller
  workspaceId: string
  /** the workspace, where it lives on this host and the caller may have its rows (not another host of his) */
  workspace: WorkspaceRow | null
  /** its folder by its real path */
  folder: string | null
  /**
   * Who each row is checked as while the search runs. A remote key's rows are checked as the host's own and cut
   * to what the key could name on every page, so one kept search serves each page and nothing it may not name
   * ever leaves the host.
   */
  rowsBy: Caller
  words: string[]
  filter: FileSearchFilter
  libraries: LibraryPlace[]
  signal?: AbortSignal
  method: string
}

/** A place's search: one per kind of place. LifeOS, Google Drive and mail each add one here when they become places. */
export type PlaceSource = (scope: SearchScope) => Promise<SourceAnswer>

const wants = (filter: FileSearchFilter, place: string): boolean => !filter.places?.length || filter.places.includes(place) || filter.places.includes(place.split('/')[0]!)
const kindOk = (filter: FileSearchFilter, kind: FileEntry['kind']): boolean => !filter.kinds?.length || filter.kinds.includes(kind)
const turn = (): Promise<void> => new Promise((next) => setImmediate(next))
const stop = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new Error(CANCELLED)
}

/**
 * A promise held to a deadline and the signal: the deadline answers null (the source stopped before its end),
 * the signal throws. A source that fails answers null too, and is logged: one place down never fails the search.
 */
async function bounded<T>(ctx: Pick<WorkCtx, 'log'>, what: string, run: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      run.catch((err: unknown) => {
        if (err instanceof Error && err.message === CANCELLED) throw err
        ctx.log(`files: the search of ${what} failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }),
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), CAPS.sourceMs)
        timer.unref?.()
      }),
      new Promise<never>((_, fail) => {
        if (!signal) return
        onAbort = () => fail(new Error(CANCELLED))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

// ── the workspace's folder ────────────────────────────────────────────

interface Walked {
  /** names that hold every word */
  names: { path: string; row: DiskRow }[]
  /** files whose text may be read: a kind of text, not matched by name */
  texts: string[]
  more: boolean
}

/**
 * The names under a folder that hold every word, streamed folder by folder, a turn of the event loop between
 * folders. Bounded: `CAPS.dirs` folders, `CAPS.hits` hits, `CAPS.ms`. Hidden names and links are left out, as
 * a listing leaves them; a link is never followed.
 */
export async function walkNames(root: string, words: readonly string[], o: { signal?: AbortSignal; kinds?: FileSearchFilter['kinds']; texts?: boolean } = {}): Promise<Walked> {
  const names: Walked['names'] = []
  const texts: string[] = []
  const queue = [root]
  const until = Date.now() + CAPS.ms
  let dirs = 0
  let more = false
  while (queue.length) {
    stop(o.signal)
    if (dirs >= CAPS.dirs || names.length >= CAPS.hits || Date.now() > until) {
      more = true
      break
    }
    const dir = queue.shift()!
    dirs++
    searchCounts.folders++
    let handle
    try {
      handle = await opendir(dir, { bufferSize: 256 })
    } catch {
      continue
    }
    try {
      for await (const d of handle) {
        stop(o.signal)
        if (hiddenName(d.name) || d.isSymbolicLink()) continue
        const isDir = d.isDirectory()
        if (!isDir && !d.isFile()) continue
        const path = join(dir, d.name)
        if (isDir) queue.push(path)
        const kind = isDir ? 'folder' : kindOfEntry(d.name).kind
        if (matchesName(d.name, words)) {
          if ((!o.kinds?.length || o.kinds.includes(kind)) && names.length < CAPS.hits) names.push({ path, row: { name: d.name, dir: isDir, kind } })
        } else if (o.texts && !isDir && TEXT_FILE.test(d.name) && texts.length < CAPS.hits) texts.push(path)
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
    await turn()
  }
  return { names, texts, more }
}

/** Looks at rows closer (time, size, whether the bytes are here), 64 at a time. Never a read of a file's bytes. */
async function lookAt(rows: { path: string; row: DiskRow }[], signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < rows.length; i += 64) {
    stop(signal)
    await Promise.all(
      rows.slice(i, i + 64).map(async ({ path, row }) => {
        try {
          const s = await lstat(path)
          row.changed = Math.round(s.mtimeMs)
          if (!row.dir) {
            row.size = s.size
            row.local = bytesHere(s)
          }
        } catch {
          // Gone since the walk: it keeps its name and says nothing more.
        }
        row.stated = true
      })
    )
  }
}

/** Text read for searches, by path and change time, shared by every workspace of this host; the least read goes first past its cap. */
const texts = new Map<string, { mtime: number; text: string }>()

/**
 * The files among `paths` whose text holds every word: only a file of `CAPS.textBytes` or less whose bytes are
 * on this disk (never one a cloud app keeps elsewhere: reading it would download it), the newest
 * `CAPS.textFiles` of them.
 */
async function textHits(paths: string[], words: readonly string[], o: { signal?: AbortSignal; kinds?: FileSearchFilter['kinds'] }): Promise<{ path: string; row: DiskRow }[]> {
  const rows = paths.map((path) => {
    const name = path.slice(path.lastIndexOf('/') + 1)
    return { path, row: { name, dir: false, kind: kindOfEntry(name).kind } as DiskRow }
  })
  const fit = rows.filter((r) => !o.kinds?.length || o.kinds.includes(r.row.kind))
  await lookAt(fit, o.signal)
  const readable = fit.filter((r) => r.row.local === true && (r.row.size ?? Infinity) <= CAPS.textBytes).sort((a, b) => (b.row.changed ?? 0) - (a.row.changed ?? 0))
  const out: { path: string; row: DiskRow }[] = []
  for (const r of readable.slice(0, CAPS.textFiles)) {
    stop(o.signal)
    let kept = texts.get(r.path)
    if (!kept || kept.mtime !== r.row.changed) {
      try {
        searchCounts.texts++
        kept = { mtime: r.row.changed ?? 0, text: (await readFile(r.path, 'utf8')).slice(0, CAPS.textBytes).toLowerCase() }
      } catch {
        continue
      }
    }
    keepText(texts, r.path, kept)
    if (words.every((w) => kept!.text.includes(w))) out.push(r)
  }
  return out
}

/** The workspace's folder: its names, and the words in his small text files. A `.tcdoc`'s text is not read here (docs/find.ts keeps its reader to itself). */
const folderSource: PlaceSource = async (s) => {
  if (!s.workspace || !s.folder || !wants(s.filter, PLACE.folder)) return { hits: [] }
  const root = s.folder
  const walked = await walkNames(root, s.words, { signal: s.signal, kinds: s.filter.kinds, texts: s.words.length > 0 })
  await lookAt(walked.names, s.signal)
  const found = [...walked.names, ...(walked.texts.length ? await textHits(walked.texts, s.words, { signal: s.signal, kinds: s.filter.kinds }) : [])]
  const host = s.ctx.host
  const workspace = s.workspace
  // A key's denied folders may lie inside its roots: each row is judged, not the folder alone.
  const hits = found
    .filter((f) => reachesPath(s.ctx, s.rowsBy, f.path))
    .map(({ path, row }): Hit => {
      const entry = entryOfRow(row, host, path, `file:${host}:${path}`)
      const where = whereOf(s.ctx, { in: 'folder', workspace, path, root }, null)
      // Who last saved an Office file is read only when asked for, and only from a file whose bytes are here.
      const by = s.filter.who && !row.dir && row.local ? whoIn(path) : null
      return { entry: { ...entry, ...(where ? { where } : {}), ...(by ? { by } : {}) }, place: PLACE.folder }
    })
  return { hits, more: walked.more }
}

const whoIn = (path: string): string | null => {
  try {
    return whoOf(path, statSync(path))
  } catch {
    return null
  }
}

// ── libraries ─────────────────────────────────────────────────────────

/** A library's row as found by a walk, as the wire's entry. */
function libraryHit(s: SearchScope, e: TeamsEntry, library: TeamsLibrary): Hit | null {
  const place = placeOf({ in: 'library', library, path: e.path }, s.libraries)
  if (!place) return null
  const dir = e.kind === 'folder'
  const row: DiskRow = { name: e.name, dir, kind: dir ? 'folder' : kindOfEntry(e.name).kind, changed: e.modified, ...(dir ? {} : { size: e.size, local: e.local }), stated: true }
  const where = whereOf(s.ctx, { in: 'library', library, path: e.path }, place)
  return { entry: { ...entryOfRow(row, library.host, e.path, libraryKey(place, e.path)), shared: true, ...(where ? { where } : {}), ...(e.by ? { by: e.by } : {}) }, place: place.place.id }
}

const librariesOfScope = (s: SearchScope, vm: boolean): TeamsLibrary[] => {
  const out = new Map<string, TeamsLibrary>()
  for (const l of s.libraries) if (!!l.library.vm === vm && wants(s.filter, l.place.id)) out.set(l.library.id, l.library)
  return [...out.values()]
}

/** The libraries OneDrive syncs on this disk, through the office pillar's walk (names only; nothing downloads). */
const librarySource: PlaceSource = async (s) => {
  const libs = librariesOfScope(s, false)
  if (!libs.length) return { hits: [] }
  const got = await bounded(s.ctx, 'the libraries', searchLibraries(libs, s.words.join(' ')), s.signal)
  if (!got) return { hits: [], more: true }
  const byId = new Map(libs.map((l) => [l.id, l]))
  const hits = got.entries.flatMap((e) => {
    const library = byId.get(e.library)
    // A key's reach is judged by the real path of each row, not the library alone.
    return library && reachesPath(s.ctx, s.rowsBy, e.path) ? (libraryHit(s, e, library) ?? []) : []
  })
  return { hits, more: got.more }
}

/**
 * The libraries in the Windows VM, through the guest's own walk. A caller with a window that must never wait
 * (his window, a remote key) does not wake a sleeping VM: its places are named in `asleep`. A thread, or another
 * host of his, has no screen to repaint and may wake it.
 */
const vmSource: PlaceSource = async (s) => {
  const libs = librariesOfScope(s, true)
  if (!libs.length) return { hits: [] }
  const window = s.by.kind === 'local' || (s.by.kind === 'remote' && !s.by.peer)
  if (window && vmState()?.state !== 'awake') {
    const names = s.libraries.filter((l) => l.library.vm && wants(s.filter, l.place.id)).map((l) => l.place.name)
    return { hits: [], more: true, asleep: [...new Set(names)] }
  }
  const got = await bounded(s.ctx, 'the Windows VM', vmSearch(libs, s.words.join(' '), undefined, s.signal), s.signal)
  if (!got) return { hits: [], more: true }
  const byId = new Map(libs.map((l) => [l.id, l]))
  return { hits: got.entries.flatMap((e) => (byId.has(e.library) ? (libraryHit(s, e, byId.get(e.library)!) ?? []) : [])), more: got.more }
}

/** What this host listed or found before (`work_files_names`), each row checked for the caller as Go to checks it. */
const namesSource: PlaceSource = async (s) => {
  if (!s.workspace) return { hits: [] }
  const listed = new Set(s.libraries.flatMap((l) => [l.place.id, l.library.id]))
  const places = s.filter.places?.length ? s.filter.places : undefined
  const rows = nameRows(s.ctx.db, s.workspaceId, s.words, { most: CAPS.hits, ...(places ? { places } : {}) })
  const hits: Hit[] = []
  for (const [i, { place, ...entry }] of rows.entries()) {
    if (i % 200 === 199) {
      stop(s.signal)
      await turn()
    }
    if (!kindOk(s.filter, entry.kind) || !wants(s.filter, place)) continue
    // A library's rows only where it is still listed for the caller.
    if (place === PLACE.folder && !s.folder) continue
    const checked = checkRow(s.ctx, s.rowsBy, s.workspaceId, entry, { place, listed, libraries: s.libraries, method: s.method })
    if (checked) hits.push({ entry: checked, place })
  }
  return { hits }
}

/** LifeOS's documents and sheets of the workspace's sector: titles, and the words of a document (`catalog:search`). Never a thread's or another host's. */
const lifeosSource: PlaceSource = async (s) => {
  if (!s.workspace || s.by.kind === 'model' || !wants(s.filter, PLACE.lifeos)) return { hits: [] }
  const rows = await bounded(s.ctx, 'LifeOS', searchLifeos(s.ctx, s.workspace, s.words, s.filter.who ? { owner: ownerName(s.ctx) } : undefined), s.signal)
  if (!rows) return { hits: [], more: true }
  return { hits: rows.filter((e) => kindOk(s.filter, e.kind)).map((entry) => ({ entry, place: PLACE.lifeos })) }
}

/** Every place's search. A later place adds its own here. */
const SOURCES: PlaceSource[] = [namesSource, folderSource, librarySource, vmSource, lifeosSource]

// ── the whole search ──────────────────────────────────────────────────

interface Result {
  hits: Hit[]
  more: boolean
  asleep: string[]
}

/** Newest change first, then the key: a total order, so a row's change and key are a cursor. */
const order = (a: FileEntry, b: FileEntry): number => (b.changed ?? 0) - (a.changed ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/** His name as Work knows it, for `who: 'me'`. */
function ownerName(ctx: Pick<WorkCtx, 'db'>): string | null {
  try {
    return ((ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(WORK_OWNER_NAME_SETTING) as { value?: string } | undefined)?.value ?? '').trim() || null
  } catch {
    return null
  }
}

/**
 * Whether a row passes the filter. `within` is the change time against a span before `now`. `who` is matched
 * against who last changed it and the thread that made it, where the row says (a LifeOS row says an agent and
 * he in LifeOS's words, `LIFEOS_BY`); a row that cannot say is left out. `review`: suggestions wait in it (LifeOS's rows say);
 * `project`: it is in that project (a LifeOS row's own, or a file linked to it).
 */
export function passesFilter(e: FileEntry, place: string, f: FileSearchFilter, owner: string | null, now = Date.now()): boolean {
  if (!kindOk(f, e.kind) || !wants(f, place)) return false
  if (f.within && (e.changed ?? 0) < now - WITHIN_MS[f.within]) return false
  if (f.after !== undefined && (e.changed ?? 0) < f.after) return false
  if (f.before !== undefined && (e.changed ?? 0) >= f.before) return false
  if (f.shared !== undefined && !!e.shared !== f.shared) return false
  if (f.review && e.state?.is !== 'suggestions') return false
  if (f.project && e.project?.id !== f.project) return false
  if (f.who) {
    const who = f.who.trim().toLowerCase()
    if (who === 'agent') return !!e.madeBy || e.by === LIFEOS_BY.agent
    if (e.madeBy) return false
    if (!e.by) return false
    if (who === 'me') return e.by === LIFEOS_BY.you || (!!owner && e.by.toLowerCase() === owner.toLowerCase())
    return e.by.toLowerCase().includes(who)
  }
  return true
}

async function run(s: SearchScope, marks: MarkStore | null): Promise<Result> {
  searchCounts.runs++
  const answers = await Promise.all(
    SOURCES.map((source) =>
      source(s).catch((err: unknown): SourceAnswer => {
        if (err instanceof Error && err.message === CANCELLED) throw err
        s.ctx.log(`files: a search source failed: ${err instanceof Error ? err.message : String(err)}`)
        return { hits: [], more: true }
      })
    )
  )
  stop(s.signal)
  const merged = new Map<string, Hit>()
  // The names table's rows go first, so what a walk saw now takes their place.
  for (const a of answers) for (const hit of a.hits) merged.set(hit.entry.key, hit)
  let hits = [...merged.values()]
  // A file of a disk linked to a project says so, where the filter asks for one.
  if (s.filter.project && hits.length) {
    const withProject = await withProjects(s.ctx, s.workspace, hits.map((h) => h.entry))
    hits = hits.map((h, i) => ({ ...h, entry: withProject[i]! }))
  }
  if (marks && hits.length) {
    const marked = marks.of(s.workspaceId, hits.map((h) => h.entry.key))
    hits = hits.map((h) => {
      const m = marked.get(h.entry.key)
      return m ? { ...h, entry: { ...h.entry, ...(m.starred ? { starred: true } : {}), ...(m.madeBy ? { madeBy: m.madeBy, fresh: m.seenAt === null } : {}) } } : h
    })
  }
  const owner = s.filter.who ? ownerName(s.ctx) : null
  hits = hits.filter((h) => passesFilter(h.entry, h.place, s.filter, owner)).sort((a, b) => order(a.entry, b.entry))
  return { hits, more: answers.some((a) => a.more), asleep: [...new Set(answers.flatMap((a) => a.asleep ?? []))] }
}

/** Searches kept for the next page: 30 seconds, eight at most, the least used first. */
const kept = new WeakMap<object, Map<string, { at: number; result: Promise<Result> }>>()

interface Cursor {
  /** the search it belongs to */
  h: string
  c: number
  k: string
}
const encode = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url')
function decode(cursor: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor
    return c && typeof c.h === 'string' && typeof c.c === 'number' && typeof c.k === 'string' ? c : null
  } catch {
    return null
  }
}

/** Who a kept search belongs to: the caller's kind and who it is, and the libraries it may search (a thread's VM turned on, a key's reach). */
function callerKey(s: SearchScope): string {
  const { by } = s
  const who = by.kind === 'model' ? `model:${by.sessionId ?? ''}` : by.peer ? `peer:${by.peer}` : by.kind
  return `${who}:${s.libraries.map((l) => l.place.id).sort().join(',')}`
}

/** The host itself, for the rows of a remote key's search (cut to the key on every page). */
const HOST_ROWS: Caller = { kind: 'local', caps: [] }

/**
 * One page of a search (`work.files.search`): `SEARCH_PAGE` rows, newest change first, each saying where it
 * lives. The fence is the list's: his window searches every place of the workspace on this host; a thread its
 * own workspace's, the VM only where its workspace turns it on; another host of his the libraries alone; a
 * remote key only what it could name.
 */
export async function searchFiles(ctx: WorkCtx, by: Caller, p: { workspaceId: string; query: string; filter?: FileSearchFilter; cursor?: string }, marks: MarkStore, method: string, signal?: AbortSignal): Promise<FilesListing> {
  admitCaller(ctx, by, p.workspaceId)
  const workspace = by.peer ? null : workspaceHere(ctx.db, p.workspaceId)
  let folder: string | null = null
  if (workspace) {
    try {
      folder = realpathSync(workspace.path)
    } catch {
      folder = null
    }
  }
  const filter = p.filter ?? {}
  const remoteKey = by.kind === 'remote' && !by.peer
  const s: SearchScope = { ctx, by, rowsBy: remoteKey ? HOST_ROWS : by, workspaceId: p.workspaceId, workspace, folder, words: nameWords(p.query), filter, libraries: listedLibraries(ctx, by), signal, method }
  const key = JSON.stringify([p.workspaceId, callerKey(s), s.words, Object.fromEntries(Object.entries(filter).sort(([a], [b]) => a.localeCompare(b)))])
  const tag = createHash('sha1').update(key).digest('base64url').slice(0, 12)
  const from = p.cursor ? decode(p.cursor) : null
  if (p.cursor && (!from || from.h !== tag)) return { entries: [], stale: true }

  const cache = kept.get(ctx.db) ?? kept.set(ctx.db, new Map()).get(ctx.db)!
  const now = Date.now()
  for (const [k, v] of cache) if (now - v.at > CAPS.keptMs) cache.delete(k)
  let entry = cache.get(key)
  let result: Result
  for (;;) {
    if (!entry) {
      entry = { at: now, result: run(s, workspace ? marks : null) }
      cache.set(key, entry)
      while (cache.size > CAPS.kept) cache.delete(cache.keys().next().value!)
      const mine = entry
      mine.result.catch(() => cache.get(key) === mine && cache.delete(key))
    } else {
      // A Map keeps insertion order: a search used again goes to the end.
      cache.delete(key)
      cache.set(key, entry)
    }
    try {
      result = await entry.result
      break
    } catch (err) {
      // Another caller's search was cancelled under this one: this one runs it again.
      if (!(err instanceof Error && err.message === CANCELLED) || signal?.aborted) throw err
      entry = undefined
    }
  }
  stop(signal)

  if (!p.cursor && workspace && result.hits.length) {
    // LifeOS's rows are read from LifeOS each time: the names table keeps only what lies on a disk.
    const hits = result.hits.filter((h) => h.place !== PLACE.lifeos)
    if (hits.length) feedNames(ctx, p.workspaceId, (): NameRow[] => hits)
  }
  // A remote key's rows are judged again on each page: what it may name is its own.
  const rows = remoteKey ? result.hits.filter((h) => keyMayName(ctx, by, h.entry)) : result.hits
  let start = 0
  if (from) {
    const last = { changed: from.c, key: from.k } as FileEntry
    start = rows.findIndex((h) => order(h.entry, last) > 0)
    if (start < 0) start = rows.length
  }
  const page = rows.slice(start, start + SEARCH_PAGE)
  const end = page.at(-1)
  const next = start + page.length < rows.length && end ? encode({ h: tag, c: end.entry.changed ?? 0, k: end.entry.key }) : undefined
  return { entries: page.map((h) => h.entry), ...(next ? { next } : {}), ...(result.more ? { more: true as const } : {}), ...(result.asleep.length ? { asleep: result.asleep } : {}) }
}

const keyMayName = (ctx: WorkCtx, by: Caller, e: FileEntry): boolean => {
  const ref = e.ref ?? e.folder
  const path = ref && ref.at === 'file' ? ref.path : ref && ref.at === 'microsoft' && ref.ref.kind === 'path' ? ref.ref.path : null
  return path === null || reachesPath(ctx, by, path)
}

/** A test, or a change that makes every kept search wrong, starts again. */
export const forgetSearches = (db: object): void => void kept.delete(db)

// ── saved searches: the docs pillar's saved views ─────────────────────

/** The longest name Docs gives a saved view. */
const VIEW_NAME_MAX = 80

/** The workspace's saved searches: the docs pillar's saved views (`work_docs_views`), through its own store. */
export const savedSearches = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string): { searches: SavedFileSearch[] } => ({ searches: listViews(ctx.db, workspaceId).map(searchOfView) })

/** Saves a search as a saved view, or rewrites one: what only a Docs view said of the view it was is kept. */
export function saveSearch(ctx: Pick<WorkCtx, 'db'>, p: { workspaceId: string; id?: string; name: string; query: string; filter?: FileSearchFilter }): SavedFileSearch {
  const name = p.name.trim()
  if (!name) throw new Error('A saved search needs a name.')
  if (name.length > VIEW_NAME_MAX) throw new Error(`A saved search's name can be ${VIEW_NAME_MAX} characters at most.`)
  const was = p.id ? listViews(ctx.db, p.workspaceId).find((v) => v.id === p.id) : undefined
  if (p.id && !was) throw new Error('That saved search is gone.')
  const view = viewOfSearch({ ...(p.id ? { id: p.id } : {}), name, query: p.query, ...(p.filter ? { filter: p.filter } : {}), ...(was ? { docs: was.spec } : {}) })
  return searchOfView(saveView(ctx.db, p.workspaceId, view))
}

export const dropSearch = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string, id: string): void => dropView(ctx.db, workspaceId, id)
