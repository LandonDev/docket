import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { lstat, opendir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileSearchFilter, FilesListing, SavedFileSearch } from '@shared/contract-work-files'
import type { TeamsEntry, TeamsLibrary } from '@shared/contract-work-office'
import { kindOk, matchesName, nameWords, passesFilter, SEARCH_PAGE, searchOfView, viewOfSearch, wants } from '@shared/work/fileSearch'
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
import { searchLifeos, withProjects } from './places/lifeos'
import { libraryKey, type LibraryPlace } from './places/teams'
import { admitCaller, workspaceHere, type WorkspaceRow } from './policy'

export { passesFilter }

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
const DEFAULT_CAPS = { dirs: 20_000, hits: 2_000, ms: 10_000, sourceMs: 20_000, textFiles: 200, textBytes: 512 * 1024, keptMs: 30_000, kept: 8, firstMs: 300, partMs: 25_000 }
/** `firstMs`: how long the first page waits for places beside the names held; `partMs`: how long an ask for the next part waits. */
const CAPS = { ...DEFAULT_CAPS }
export const setSearchCaps = (caps: Partial<typeof CAPS> | null): void => void Object.assign(CAPS, caps ?? DEFAULT_CAPS)
/** What the walks did, for the tests and the bench to count. */
export const searchCounts = { folders: 0, texts: 0, runs: 0 }

const TEXT_FILE = /\.(md|markdown|txt|csv)$/i
/** TempCode's own documents and sheets: their words stay with their own readers (docs/find.ts), so a search matches their names. */
const OWN_FILE = /\.(tcdoc|tcsheet)$/i
/** How a search names them where it searched them by name only. */
export const OWN_BY_NAME = 'TempCode documents and sheets'
const CANCELLED = 'cancelled'

/** One row found, and the id of the place it lies in. */
export interface Hit {
  entry: FileEntry
  place: string
}

/** What one source answers: its rows, whether it stopped before its end, the places it left asleep, and those it searched by name only. */
export interface SourceAnswer {
  hits: Hit[]
  more?: boolean
  asleep?: string[]
  /** places whose files it matched by name alone, never the words inside them (a library has no content index here) */
  byName?: string[]
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
  /** a TempCode document or sheet not matched by name, whose words a search here never reads (`OWN_BY_NAME`) */
  sealed: boolean
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
  let sealed = false
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
        else if (o.texts && OWN_FILE.test(d.name)) sealed = true
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
    await turn()
  }
  return { names, texts, more, sealed }
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

/**
 * The workspace's folder: its names, and the words in his small text files. A `.tcdoc`'s text is not read here (docs/find.ts
 * keeps its reader to itself), nor a `.tcsheet`'s: where the folder holds one its name alone could not match, the answer
 * says they were searched by name only (`OWN_BY_NAME`).
 */
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
  return { hits, more: walked.more, ...(walked.sealed ? { byName: [OWN_BY_NAME] } : {}) }
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

/** The names of the library places a source searches, for its `byName`. */
const libraryNames = (s: SearchScope, vm: boolean): string[] => [...new Set(s.libraries.filter((l) => !!l.library.vm === vm && wants(s.filter, l.place.id)).map((l) => l.place.name))]

const librariesOfScope = (s: SearchScope, vm: boolean): TeamsLibrary[] => {
  const out = new Map<string, TeamsLibrary>()
  for (const l of s.libraries) if (!!l.library.vm === vm && wants(s.filter, l.place.id)) out.set(l.library.id, l.library)
  return [...out.values()]
}

/** The libraries OneDrive syncs on this disk, through the office pillar's walk (names only; nothing downloads). */
const librarySource: PlaceSource = async (s) => {
  const libs = librariesOfScope(s, false)
  if (!libs.length) return { hits: [] }
  const got = await bounded(s.ctx, 'the libraries', searchLibraries(libs, s.words.join(' '), undefined, Date.now, { signal: s.signal, who: !!s.filter.who }), s.signal)
  if (!got) return { hits: [], more: true }
  const byId = new Map(libs.map((l) => [l.id, l]))
  const hits = got.entries.flatMap((e) => {
    const library = byId.get(e.library)
    // A key's reach is judged by the real path of each row, not the library alone.
    return library && reachesPath(s.ctx, s.rowsBy, e.path) ? (libraryHit(s, e, library) ?? []) : []
  })
  return { hits, more: got.more, byName: libraryNames(s, false) }
}

/**
 * The libraries in the Windows VM, through the guest's own walk. A search wakes no one's VM, whoever asks (his window,
 * a remote key, a thread, another host of his): waking it is his press alone, so a sleeping VM's places are named in
 * `asleep`.
 */
const vmSource: PlaceSource = async (s) => {
  const libs = librariesOfScope(s, true)
  if (!libs.length) return { hits: [] }
  if (vmState()?.state !== 'awake') {
    const names = s.libraries.filter((l) => l.library.vm && wants(s.filter, l.place.id)).map((l) => l.place.name)
    return { hits: [], more: true, asleep: [...new Set(names)] }
  }
  const got = await bounded(s.ctx, 'the Windows VM', vmSearch(libs, s.words.join(' '), undefined, s.signal), s.signal)
  if (!got) return { hits: [], more: true }
  const byId = new Map(libs.map((l) => [l.id, l]))
  return { hits: got.entries.flatMap((e) => (byId.has(e.library) ? (libraryHit(s, e, byId.get(e.library)!) ?? []) : [])), more: got.more, byName: libraryNames(s, true) }
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

/**
 * Every place's search, and its name on the line that says it is still being searched (none for the names this host
 * holds, which answer at once). A later place adds its own here.
 */
const SOURCES: { run: PlaceSource; label: (s: SearchScope) => string | null }[] = [
  { run: namesSource, label: () => null },
  { run: folderSource, label: (s) => s.workspace?.name ?? null },
  { run: librarySource, label: () => 'Teams files' },
  { run: vmSource, label: () => 'the Windows VM' },
  { run: lifeosSource, label: () => 'LifeOS' }
]

// ── the whole search ──────────────────────────────────────────────────

/**
 * One search as it runs: the rows each place has answered so far (the names this host holds first; a walk's row
 * takes the place of the same row from the names), the places still searched, and how many have answered. Each
 * place has its own deadline and its own stop: at its deadline its walk stops and it says it stopped short (`more`);
 * the whole run stops when the search it belongs to is replaced, or when no one waits on it any more.
 */
interface Live {
  hits: Map<string, Hit>
  more: boolean
  asleep: Set<string>
  /** the places searched by name only */
  byName: Set<string>
  /** the places still searched, by their index in `SOURCES` */
  pending: Map<number, string>
  parts: number
  /** the names this host holds have answered */
  named: boolean
  done: boolean
  finished: Promise<void>
  controller: AbortController
  /** told each time a place answers */
  listeners: Set<() => void>
  /** callers waiting on it now */
  waiters: number
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

function start(s: SearchScope): Live {
  searchCounts.runs++
  const controller = new AbortController()
  const live: Live = { hits: new Map(), more: false, asleep: new Set(), byName: new Set(), pending: new Map(), parts: 0, named: false, done: false, finished: Promise.resolve(), controller, listeners: new Set(), waiters: 0 }
  const tell = (): void => {
    for (const listener of [...live.listeners]) listener()
  }
  const runs = SOURCES.map(async (source, i) => {
    const label = source.label(s)
    if (label) live.pending.set(i, label)
    // Its own stop: at its deadline, or when the whole search stops.
    const own = new AbortController()
    const off = (): void => own.abort()
    controller.signal.addEventListener('abort', off, { once: true })
    const timer = setTimeout(() => {
      live.more = true
      own.abort()
    }, CAPS.sourceMs)
    timer.unref?.()
    let answer: SourceAnswer | null = null
    try {
      answer = await source.run({ ...s, signal: own.signal })
    } catch (err) {
      // Stopped at its deadline, or failed: one place never fails the search.
      if (!(err instanceof Error && err.message === CANCELLED)) s.ctx.log(`files: a search source failed: ${err instanceof Error ? err.message : String(err)}`)
      if (!controller.signal.aborted) live.more = true
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', off)
    }
    if (controller.signal.aborted) return
    if (answer) {
      for (const hit of answer.hits) if (i !== 0 || !live.hits.has(hit.entry.key)) live.hits.set(hit.entry.key, hit)
      if (answer.more) live.more = true
      for (const name of answer.asleep ?? []) live.asleep.add(name)
      for (const name of answer.byName ?? []) live.byName.add(name)
    }
    if (i === 0) live.named = true
    live.pending.delete(i)
    live.parts++
    tell()
  })
  live.finished = Promise.all(runs).then(() => {
    live.done = true
    tell()
  })
  return live
}

/** The rows as they stand: marked, held to the filter, in order. */
async function rowsOf(s: SearchScope, live: Live, marks: MarkStore | null): Promise<Hit[]> {
  let hits = [...live.hits.values()]
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
  return hits.filter((h) => passesFilter(h.entry, h.place, s.filter, owner)).sort((a, b) => order(a.entry, b.entry))
}

/**
 * Waits on a run until `ready` says so, it ends, `ms` pass, or the caller goes. A caller that goes while no one else
 * waits stops the run, unless it has ended.
 */
async function waitOn(live: Live, ready: () => boolean, ms: number, signal: AbortSignal | undefined, gone: () => void): Promise<void> {
  if (ready() || live.done) return
  live.waiters++
  try {
    await new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (ready() || live.done) finish()
      }
      const timer = ms === Infinity ? undefined : setTimeout(() => finish(), ms)
      timer?.unref?.()
      const aborted = (): void => finish(new Error(CANCELLED))
      const finish = (err?: Error): void => {
        clearTimeout(timer)
        live.listeners.delete(check)
        signal?.removeEventListener('abort', aborted)
        if (err) reject(err)
        else resolve()
      }
      live.listeners.add(check)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  } finally {
    live.waiters--
    if (signal?.aborted && !live.waiters && !live.done) gone()
  }
}

/** Searches kept for the next page and the next part: 30 seconds, eight at most, the least used first. */
/** `owners`: the searches that asked for this walk first (a tab, a window): a replacement stops it only with its last. */
const kept = new WeakMap<object, Map<string, { at: number; live: Live; words: string; who: string; owners: number; released: Set<string> }>>()

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
 * remote key only what it could name. A caller that sends `seen` takes the search in parts: asked with 0, the first
 * page answers once the names this host holds are in, with the places that answer within `CAPS.firstMs`, naming the
 * rest in `pending`; asked again with the `parts` it saw, it answers once another place has. A slow or stopped place
 * never holds the rows already found. A caller that sends none has the whole search in one answer.
 */
export async function searchFiles(
  ctx: WorkCtx,
  by: Caller,
  p: { workspaceId: string; query: string; filter?: FileSearchFilter; cursor?: string; seen?: number; replaces?: string },
  marks: MarkStore,
  method: string,
  signal?: AbortSignal
): Promise<FilesListing> {
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
  const s: SearchScope = { ctx, by, rowsBy: remoteKey ? HOST_ROWS : by, workspaceId: p.workspaceId, workspace, folder, words: nameWords(p.query), filter, libraries: listedLibraries(ctx, by), method }
  const who = `${p.workspaceId}\u0000${callerKey(s)}`
  const words = s.words.join(' ')
  const keyOf = (w: readonly string[]): string => JSON.stringify([p.workspaceId, callerKey(s), w, Object.fromEntries(Object.entries(filter).sort(([a], [b]) => a.localeCompare(b)))])
  const key = keyOf(s.words)
  const tag = createHash('sha1').update(key).digest('base64url').slice(0, 12)
  const from = p.cursor ? decode(p.cursor) : null
  if (p.cursor && (!from || from.h !== tag)) return { entries: [], stale: true }

  const cache = kept.get(ctx.db) ?? kept.set(ctx.db, new Map()).get(ctx.db)!
  // The search this one takes the place of in the same tab: its walks stop now.
  if (p.replaces !== undefined) {
    const was = nameWords(p.replaces)
    // Two tabs or windows searching the same words share one walk (Sol round 1, S11): it stops with its last owner.
    // Released is the walk of this search's own words and filters alone, and once for each search that replaces it,
    // so a retried replacement releases nothing more (Sol round 2, S11).
    const oldKey = keyOf(was)
    const v = was.join(' ') !== words ? cache.get(oldKey) : undefined
    if (v && !v.live.done && !v.released.has(key)) {
      v.released.add(key)
      if (--v.owners <= 0) {
        v.live.controller.abort()
        cache.delete(oldKey)
      }
    }
  }
  const now = Date.now()
  for (const [k, v] of cache) if (now - v.at > CAPS.keptMs) cache.delete(k)
  let entry = cache.get(key)
  // A search's first ask (no cursor, no part seen yet) is one more owner of its walk; its later asks are not.
  const firstAsk = !p.cursor && !p.seen
  if (!entry || entry.live.controller.signal.aborted) {
    const live = start(s)
    entry = { at: now, live, words, who, owners: 1, released: new Set() }
    cache.set(key, entry)
    while (cache.size > CAPS.kept) cache.delete(cache.keys().next().value!)
    // What a walk found feeds the names table once, as a search's first page always has: names, never a new feed.
    if (workspace)
      void live.finished.then(() => {
        if (live.controller.signal.aborted) return
        // LifeOS's rows are read from LifeOS each time: the names table keeps only what lies on a disk.
        const hits = [...live.hits.values()].filter((h) => h.place !== PLACE.lifeos)
        if (hits.length) feedNames(ctx, p.workspaceId, (): NameRow[] => hits)
      })
  } else {
    // A Map keeps insertion order: a search used again goes to the end.
    if (firstAsk) entry.owners++
    cache.delete(key)
    cache.set(key, entry)
  }
  const live = entry.live
  const mine = entry
  const gone = (): void => {
    live.controller.abort()
    if (cache.get(key) === mine) cache.delete(key)
  }
  // A later page is cut from the whole search, held to each place's deadline.
  if (p.cursor) await waitOn(live, () => false, Infinity, signal, gone)
  else {
    if (p.seen === undefined) {
      // A caller that takes no parts (a thread, the phone, a window a release behind) has the whole search, as before.
      await waitOn(live, () => false, Infinity, signal, gone)
    } else if (p.seen === 0) {
      // The names this host holds first, with whatever places answer in a moment beside them.
      await waitOn(live, () => live.named, Infinity, signal, gone)
      await waitOn(live, () => !live.pending.size, CAPS.firstMs, signal, gone)
    } else {
      // Asked again: once another place has answered.
      const seen = p.seen
      await waitOn(live, () => live.parts > seen, CAPS.partMs, signal, gone)
    }
  }
  stop(signal)
  if (live.controller.signal.aborted) throw new Error(CANCELLED)

  const all = await rowsOf(s, live, workspace ? marks : null)
  stop(signal)
  // A remote key's rows are judged again on each page: what it may name is its own.
  const rows = remoteKey ? all.filter((h) => keyMayName(ctx, by, h.entry)) : all
  let first = 0
  if (from) {
    const last = { changed: from.c, key: from.k } as FileEntry
    first = rows.findIndex((h) => order(h.entry, last) > 0)
    if (first < 0) first = rows.length
  }
  const page = rows.slice(first, first + SEARCH_PAGE)
  const end = page.at(-1)
  const next = first + page.length < rows.length && end ? encode({ h: tag, c: end.entry.changed ?? 0, k: end.entry.key }) : undefined
  const pending = live.done ? [] : [...new Set(live.pending.values())]
  return {
    entries: page.map((h) => h.entry),
    ...(next ? { next } : {}),
    ...(live.more ? { more: true as const } : {}),
    ...(live.asleep.size ? { asleep: [...live.asleep] } : {}),
    ...(live.byName.size ? { byName: [...live.byName] } : {}),
    ...(!p.cursor ? { parts: live.parts, ...(pending.length ? { pending } : {}) } : {})
  }
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
