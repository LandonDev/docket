import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ClientRequest } from '@shared/contract'
import type { FileCrumb, FilePage, FileRef, FilesListing, FilesOpened, FilesPlaces, FilesTabs, FileTab } from '@shared/contract-work-files'
import { teamsCanvasOf, teamsKindOf } from '@shared/contract-work-office'
import { canvasSourcePath, handled, NOT_HANDLED, type CanvasKind, type CanvasSource, type Handled } from '@shared/work'
import { DEFAULT_SORT, kindOfEntry, PLACE, refKey, type FileEntry, type FilePlace, type FileSort, type FileVerb, type FolderRef } from '@shared/work/files'
import { fencedItem } from '../canvas/store'
import type { Caller, WorkCtx } from '../modules'
import { threadsHolding } from '../office/files/handle'
import { fetchFile, whoOf } from '../office/files/library'
import { isGuestPath, vmFetch, vmStat } from '../office/vm/files'
import { MarkStore, type Mark, type Marked } from './marks'
import { DiskLister, entryOfRow, type DiskPage, type DiskRow } from './places/disk'
import { folderEntry, folderName, folderPlace, folderTrail } from './places/folder'
import { libraryEntry, libraryKey, libraryTrail, placeOfPath, placesIn, teamsPlaces, vmPage, type LibraryPlace } from './places/teams'
import { admitCaller, admitWrite, changeDigest, locate, NO_WORKSPACE, PEER_LIBRARIES, workspaceHere, type DoorPlace, type Located, type WorkspaceRow } from './policy'
import { TabStore } from './tabs'

/**
 * The files pillar's wire (`work.files.*`, docs/agents/work-files.md "The wire"). Every method names its
 * workspace, and every file or folder it names is resolved against that workspace for the caller (`locate`,
 * policy.ts) before anything is read. An answer to a remote key holds only what the key could name itself.
 */

/** What the pillar keeps per database: the folder lister, the tabs, the marks. Made on first use, so Work off costs nothing. */
export interface FilesState {
  lister: DiskLister
  tabs: TabStore
  marks: MarkStore
  /** whoever listens for the item replacements, to stop */
  off: (() => void)[]
}
const states = new WeakMap<DatabaseSync, FilesState>()

export function filesState(ctx: Pick<WorkCtx, 'db' | 'push' | 'log' | 'canvas'>): FilesState {
  let state = states.get(ctx.db)
  if (state) return state
  const tabs = new TabStore(ctx.db, ctx.canvas, (workspaceId, rev) => {
    try {
      // Tabs hold names only; a client asks for the list again, and gets what it may see.
      ctx.push({ push: 'work.files', workspaceId, tabs: rev }, { need: 'read' })
    } catch (err) {
      ctx.log(`files: the tabs push failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  state = { lister: new DiskLister(), tabs, marks: new MarkStore(ctx.db), off: [ctx.canvas.onReplaced((old, next) => tabs.follow(old, next))] }
  states.set(ctx.db, state)
  return state
}

/** Stops what a state watches and listens to; the next use makes a fresh one. */
export function closeFilesState(db: DatabaseSync): void {
  const state = states.get(db)
  if (!state) return
  state.lister.close()
  for (const off of state.off) off()
  states.delete(db)
}

const THREADS_NO_TABS = 'A thread opens a file beside itself with canvas_open; the tabs of Files are his own.'
const NOT_BUILT_PLACE = 'That place is not read by this build yet.'
const OPENS_IN_APP = (name: string): string => `${name} opens in its own app.`

/** The workspace's own rows (tabs, marks) are kept only where it lives, and are no thread's and no other host's to change. */
function ownRows(ctx: Pick<WorkCtx, 'db' | 'scopeOf'>, by: Caller, workspaceId: string, o: { threads?: boolean } = {}): WorkspaceRow {
  if (by.kind === 'model' && !o.threads) throw new Error(THREADS_NO_TABS)
  admitCaller(ctx, by, workspaceId)
  if (by.peer) throw new Error(PEER_LIBRARIES)
  const workspace = workspaceHere(ctx.db, workspaceId)
  if (!workspace) throw new Error(NO_WORKSPACE)
  return workspace
}

/** Whether a caller could name a path of this host itself: everyone but a remote key always; a key by the listener's fence, and a file in the Windows VM by the guest-path rule. */
const reaches = (ctx: Pick<WorkCtx, 'reaches'>, by: Caller, path: string): boolean => by.kind !== 'remote' || !!by.peer || (isGuestPath(path) && process.platform !== 'win32') || ctx.reaches(by, path)

/** The library places a caller may list: all of them, less the ones a remote key could not name. */
function libraryPlaces(ctx: WorkCtx, by: Caller): { places: LibraryPlace[]; sources: FilesPlaces['sources'] } {
  const { places, sources } = teamsPlaces(ctx, by)
  return { places: places.filter((p) => reaches(ctx, by, p.top)), sources }
}

const lens = (id: string, kind: FilePlace['kind'], name: string, host: string): FilePlace => ({ id, kind, name, host: '', env: host, shared: false, can: [], state: { state: 'ok' }, root: { at: 'place', id } })

function placesAnswer(ctx: WorkCtx, by: Caller, workspaceId: string): FilesPlaces {
  admitCaller(ctx, by, workspaceId)
  const state = filesState(ctx)
  const workspace = by.peer ? null : workspaceHere(ctx.db, workspaceId)
  const own: FilePlace[] = []
  if (workspace && reaches(ctx, by, workspace.path)) own.push(folderPlace(ctx.host, workspace))
  const { places, sources } = libraryPlaces(ctx, by)
  // His marks are the workspace's own rows: listed where it lives, and never to a thread.
  const marks = workspace && by.kind !== 'model' ? [lens(PLACE.recent, 'recent', 'Recent', ctx.host), lens(PLACE.starred, 'starred', 'Starred', ctx.host)] : []
  return { host: ctx.host, places: [...marks, ...own, ...places.map((p) => p.place)], rev: workspace ? state.tabs.rev(workspaceId) : 0, sources }
}

/** The door's view of where a located thing lies. A file at a team library's own top, outside every channel, is in the library taken as one place. */
function doorPlace(ctx: WorkCtx, by: Caller, at: Located): { place: DoorPlace; library?: LibraryPlace } {
  if (at.in === 'folder') return { place: folderPlace(ctx.host, at.workspace) }
  if (at.in === 'library') {
    const all = teamsPlaces(ctx, by).places
    const library = placeOfPath(all, at.library, at.path) ?? placesIn({ ...at.library, kind: at.library.kind === 'channels' ? 'library' : at.library.kind, channels: [] }, { state: 'ok' })[0]!
    return { place: library.place, library }
  }
  throw new Error(NOT_BUILT_PLACE)
}

/** A mark as a row of a lens, when the caller could name what it points at. */
function markEntry(ctx: WorkCtx, by: Caller, m: Mark): FileEntry | null {
  const at = 'file' in m.at ? m.at.file : m.at.folder
  const path = at.at === 'file' ? at.path : at.at === 'microsoft' && at.ref.kind === 'path' ? at.ref.path : null
  // A file of this host out of a key's reach is left out; one on another host is that host's to fence when it is opened.
  if (path !== null && (at as { host: string }).host === ctx.host && !reaches(ctx, by, path)) return null
  const folder = 'folder' in m.at
  return {
    key: m.key,
    ref: folder ? null : (at as CanvasSource),
    folder: folder ? (at as FolderRef) : null,
    name: m.name,
    kind: folder ? 'folder' : kindOfEntry(m.name).kind,
    ...(m.openedAt ? { changed: m.openedAt } : {}),
    ...(m.starred ? { starred: true } : {}),
    ...(m.madeBy ? { madeBy: m.madeBy, fresh: m.seenAt === null } : {})
  }
}

/** Marks the page's rows he starred, and the ones a thread made that he has not opened. */
function withMarks(state: FilesState, workspaceId: string, entries: FileEntry[]): FileEntry[] {
  const marks = state.marks.of(
    workspaceId,
    entries.map((e) => e.key)
  )
  if (!marks.size) return entries
  return entries.map((e) => {
    const m = marks.get(e.key)
    return m ? { ...e, ...(m.starred ? { starred: true } : {}), ...(m.madeBy ? { madeBy: m.madeBy, fresh: m.seenAt === null } : {}) } : e
  })
}

async function list(ctx: WorkCtx, by: Caller, p: { workspaceId: string; at: FolderRef; cursor?: string; sort?: FileSort; foldersOnly?: boolean }, method: string, signal?: AbortSignal): Promise<FilesListing> {
  const state = filesState(ctx)
  const sort = p.sort ?? DEFAULT_SORT
  let at = locate(ctx, by, p.workspaceId, p.at, method)
  const first = !p.cursor
  if (at.in === 'place') {
    if (at.id === PLACE.recent || at.id === PLACE.starred) {
      ownRows(ctx, by, p.workspaceId)
      const marks = at.id === PLACE.recent ? state.marks.recent(p.workspaceId) : state.marks.starred(p.workspaceId)
      const entries = marks.flatMap((m) => markEntry(ctx, by, m) ?? [])
      return { entries: p.foldersOnly ? entries.filter((e) => e.kind === 'folder') : entries, place: at.id, trail: [{ name: at.id === PLACE.recent ? 'Recent' : 'Starred', at: { at: 'place', id: at.id } }] }
    }
    // A place's top is its root folder: listed as that folder.
    at = locate(ctx, by, p.workspaceId, placeRoot(ctx, by, p.workspaceId, at.id), method)
  }
  if (at.in === 'folder') {
    const { workspace, root, path } = at
    const page = await state.lister.page(path, { sort, cursor: p.cursor, foldersOnly: p.foldersOnly, signal })
    if (first && !page.stale) {
      // While a tab shows the folder, a name added or removed in it is said, only to callers that could name the folder.
      state.lister.watch(path, () => {
        try {
          ctx.push({ push: 'work.files', workspaceId: workspace.id, at: refKey({ at: 'file', host: ctx.host, path }) }, { need: 'read', path })
        } catch (err) {
          ctx.log(`files: a folder's push failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
    }
    return listing(page, withMarks(state, workspace.id, page.rows.map((row) => folderEntry(ctx.host, path, row))), first ? { place: PLACE.folder, trail: folderTrail(ctx.host, workspace, root, path) } : {})
  }
  if (at.in !== 'library') throw new Error(NOT_BUILT_PLACE)
  const { library, path } = at
  const { library: place } = doorPlace(ctx, by, at)
  const page = library.vm ? await vmPage(library, path, { sort, cursor: p.cursor, foldersOnly: p.foldersOnly, signal }) : await state.lister.page(path, { sort, cursor: p.cursor, foldersOnly: p.foldersOnly, signal })
  if (first && !page.stale && !library.vm) {
    state.lister.watch(path, () => {
      try {
        ctx.push({ push: 'work.files', workspaceId: p.workspaceId, at: libraryKey(place!, path) }, { need: 'read', path })
      } catch (err) {
        ctx.log(`files: a folder's push failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }
  const entries = page.rows.map((row) => libraryEntry(place!, path, row))
  return listing(page, withMarks(state, p.workspaceId, entries), first ? { place: place!.place.id, trail: libraryTrail(place!, path), ...(place!.place.state.at && place!.place.state.state !== 'ok' ? { asOf: place!.place.state.at } : {}) } : {})
}

const listing = (page: DiskPage, entries: FileEntry[], head: { place?: string; trail?: FileCrumb[]; asOf?: number }): FilesListing =>
  page.stale ? { entries: [], stale: true } : { entries, ...(page.next ? { next: page.next } : {}), ...head }

/** One row again, looked at now, with who last saved it where its file says: what a list leaves for the rows on screen. */
async function statOne(ctx: WorkCtx, by: Caller, workspaceId: string, ref: FileRef, method: string, signal?: AbortSignal): Promise<FileEntry | null> {
  let at: Located
  try {
    at = locate(ctx, by, workspaceId, ref, method)
  } catch {
    return null
  }
  const state = filesState(ctx)
  if (at.in === 'folder') {
    const row = await state.lister.row(at.path)
    return row ? withWho(entryOfRow(row, ctx.host, at.path, refKey({ at: 'file', host: ctx.host, path: at.path })), at.path, row) : null
  }
  if (at.in !== 'library') return null
  const { library: place } = doorPlace(ctx, by, at)
  if (at.library.vm) {
    try {
      const e = await vmStat(at.library.id, at.path, signal)
      const row: DiskRow = { name: e.name, dir: e.kind === 'folder', kind: e.kind === 'folder' ? 'folder' : kindOfEntry(e.name).kind, changed: e.modified, ...(e.kind === 'folder' ? {} : { size: e.size, local: e.local }), stated: true }
      return { ...entryOfRow(row, ctx.host, at.path, libraryKey(place!, at.path)), shared: true }
    } catch {
      return null
    }
  }
  const row = await state.lister.row(at.path)
  return row ? withWho({ ...entryOfRow(row, ctx.host, at.path, libraryKey(place!, at.path)), shared: true }, at.path, row) : null
}

/** Who last saved an Office file, from its own properties: read only from a file whose bytes are already here, so it never downloads one. */
function withWho(entry: FileEntry, path: string, row: DiskRow): FileEntry {
  if (row.dir || row.local === false) return entry
  try {
    const who = whoOf(path, statSync(path))
    return who ? { ...entry, by: who } : entry
  } catch {
    return entry
  }
}

/** What a file opens as in a tab here: its canvas kind and the source its item names. */
function openAs(ctx: WorkCtx, at: Located, name: string, as?: CanvasKind): { kind: CanvasKind; source: CanvasSource } {
  if (at.in === 'folder') {
    const kind = as ?? kindOfEntry(name).canvas
    if (!kind) throw new Error(OPENS_IN_APP(name))
    return { kind, source: { at: 'file', host: ctx.host, path: at.path } }
  }
  if (at.in === 'library') {
    // A file in the VM is no file of this disk: it opens as a copy, or in its app there (the window's own open rules).
    if (at.library.vm) throw new Error(`${name} is in the Windows VM: it opens as a copy, or in its app there.`)
    const found = teamsCanvasOf({ name, path: at.path, kind: teamsKindOf(name) }, ctx.host)
    if (as && found) return { kind: as, source: as === found.kind ? found.source : { at: 'file', host: ctx.host, path: at.path } }
    if (!found) throw new Error(OPENS_IN_APP(name))
    return found
  }
  throw new Error(NOT_BUILT_PLACE)
}

/** The kinds that keep a file's marks by item, so two seats on one file would each write them: a file of these a thread already holds opens in that thread. */
const MARKS_BY_ITEM: readonly CanvasKind[] = ['pdf', 'slides', 'media']

function open(ctx: WorkCtx, by: Caller, p: { workspaceId: string; ref: CanvasSource; name?: string; as?: CanvasKind; opener?: string; beside?: string }, method: string): FilesOpened {
  const workspace = ownRows(ctx, by, p.workspaceId)
  if (p.beside) throw new Error('The Beside seat is not built yet.')
  const state = filesState(ctx)
  const at = locate(ctx, by, p.workspaceId, p.ref, method)
  if (at.in === 'place') throw new Error('A place is listed, not opened.')
  const inVm = at.in === 'library' && !!at.library.vm
  if (!inVm && statSync(at.path).isDirectory()) throw new Error('That is a folder: it opens in its tab.')
  const name = inVm ? at.path.slice(at.path.lastIndexOf('\\') + 1) : basename(at.path)
  const { library } = doorPlace(ctx, by, at)
  const key = library ? libraryKey(library, at.path) : refKey({ at: 'file', host: ctx.host, path: at.path })
  const made = openAs(ctx, at, name, p.as)
  if (MARKS_BY_ITEM.includes(made.kind)) {
    const holding = threadsHolding(ctx, workspace.id, { at: 'file', host: ctx.host, path: at.path })[0]
    if (holding) return { ...state.tabs.list(workspace.id), held: { sessionId: holding.sessionId, itemId: holding.itemId } }
  }
  const { tabId, item } = state.tabs.openFile(workspace.id, { key, name, kind: made.kind, source: made.source }, p.opener)
  state.marks.seen(workspace.id, key, { file: { at: 'file', host: ctx.host, path: at.path } }, name)
  return { ...tabsFor(ctx, by, workspace.id), tabId, item: fencedItem(item, (path) => reaches(ctx, by, path)) }
}

/** The tabs as a caller may see them: a remote key hears of none that stands on, or holds, a file of this host it could not name. */
function tabsFor(ctx: WorkCtx, by: Caller, workspaceId: string): FilesTabs {
  const state = filesState(ctx)
  const all = state.tabs.list(workspaceId)
  if (by.kind !== 'remote' || by.peer) return all
  const tabs = all.tabs.filter((tab: FileTab) => {
    if (tab.kind === 'page') {
      const at = tab.page!.at
      return !(at.at === 'file' && at.host === ctx.host && !reaches(ctx, by, at.path))
    }
    const item = tab.itemId ? ctx.canvas.get(tab.itemId) : null
    const path = item ? canvasSourcePath(item.source) : null
    return path === null || reaches(ctx, by, path)
  })
  return { rev: all.rev, tabs }
}

/** A page a tab may stand on: a place or lens of the workspace, a folder of this host the caller could name, or a folder of another host (only its address is kept here; that host fences it when it is listed). */
function admitPage(ctx: WorkCtx, by: Caller, workspaceId: string, page: FilePage, method: string): void {
  const at = page.at
  if (at.at === 'file' && at.host === ctx.host) locate(ctx, by, workspaceId, at, method)
}

/** What a mark holds for a ref: a file to open or a folder to list. A path on this host is looked at; anywhere else the words decide. */
function markedOf(ctx: WorkCtx, by: Caller, workspaceId: string, ref: FileRef, method: string): { key: string; at: Marked } {
  if (ref.at === 'drive' || ref.at === 'project' || ref.at === 'place') return { key: refKey(ref), at: { folder: ref } }
  const path = canvasSourcePath(ref as CanvasSource)
  if (path === null || (ref as { host: string }).host !== ctx.host) return { key: refKey(ref), at: { file: ref as CanvasSource } }
  const at = locate(ctx, by, workspaceId, ref, method)
  if (at.in === 'place') return { key: refKey(ref), at: { folder: ref as FolderRef } }
  const { library } = doorPlace(ctx, by, at)
  const key = library ? libraryKey(library, at.path) : refKey({ at: 'file', host: ctx.host, path: at.path })
  const here = { at: 'file' as const, host: ctx.host, path: at.path }
  const dir = at.in === 'library' && at.library.vm ? false : statSync(at.path).isDirectory()
  return { key, at: dir ? { folder: here } : { file: here } }
}

/**
 * A change before its verb is built: the thing is located and the door decides, so every refusal the door makes
 * is already the answer; what the door admits is not carried out yet.
 */
function admitChange(ctx: WorkCtx, by: Caller, verb: FileVerb, p: { workspaceId: string; refs: FileRef[]; to?: FolderRef; name?: string; asked?: boolean; origin?: Parameters<typeof admitWrite>[1]['origin'] }, method: string): 'run' | 'hold' {
  admitCaller(ctx, by, p.workspaceId)
  const to = p.to ? doorPlace(ctx, by, locate(ctx, by, p.workspaceId, p.to.at === 'place' ? placeRoot(ctx, by, p.workspaceId, p.to.id) : p.to, method)).place : null
  let verdict: 'run' | 'hold' = 'run'
  for (const ref of p.refs) {
    const at = locate(ctx, by, p.workspaceId, ref.at === 'place' ? placeRoot(ctx, by, p.workspaceId, ref.id) : ref, method)
    const from = doorPlace(ctx, by, at).place
    const name = at.in === 'place' ? '' : basename(at.path)
    const got = admitWrite(by, { verb, from, to, entry: { name, kind: kindOfEntry(name).kind }, asked: p.asked, origin: p.origin, digest: changeDigest({ verb, refs: p.refs, to: p.to, name: p.name }) })
    if (got === 'hold') verdict = 'hold'
  }
  return verdict
}

/** The root folder of a place of the workspace, for a verb that names the place itself. */
function placeRoot(ctx: WorkCtx, by: Caller, workspaceId: string, id: string): FolderRef {
  if (id === PLACE.folder) {
    const workspace = workspaceHere(ctx.db, workspaceId)
    if (!workspace) throw new Error(NO_WORKSPACE)
    return folderPlace(ctx.host, workspace).root
  }
  const found = libraryPlaces(ctx, by).places.find((l) => l.place.id === id)
  if (!found) throw new Error(NOT_BUILT_PLACE)
  return found.place.root
}

const NOT_YET = (verb: string): Error => new Error(`Files cannot ${verb} yet: that arrives with its milestone.`)

export async function filesHandle(req: ClientRequest, ctx: WorkCtx, by: Caller, signal?: AbortSignal): Promise<Handled> {
  const m = req.method
  if (!m.startsWith('work.files.')) return NOT_HANDLED
  const p = ((req as { params?: unknown }).params ?? {}) as Record<string, unknown> & { workspaceId: string }
  switch (m) {
    case 'work.files.places':
      return handled(placesAnswer(ctx, by, p.workspaceId))
    case 'work.files.list':
      return handled(await list(ctx, by, p as never, m, signal))
    case 'work.files.stat': {
      admitCaller(ctx, by, p.workspaceId)
      const state = filesState(ctx)
      const entries: (FileEntry | null)[] = []
      for (const ref of p.refs as FileRef[]) {
        if (signal?.aborted) throw new Error('cancelled')
        entries.push(await statOne(ctx, by, p.workspaceId, ref, m, signal))
        // A zip is read per Office file: the host's other work gets a turn between rows.
        await new Promise((next) => setImmediate(next))
      }
      const found = entries.filter((e): e is FileEntry => e !== null)
      const marked = new Map(withMarks(state, p.workspaceId, found).map((e) => [e.key, e]))
      return handled({ entries: entries.map((e) => (e ? marked.get(e.key)! : null)) })
    }
    case 'work.files.threads': {
      admitCaller(ctx, by, p.workspaceId)
      const ref = p.ref as CanvasSource
      const path = canvasSourcePath(ref)
      // A file is located for the caller first: nobody learns which threads hold a file they could not name.
      if (path !== null && (ref as { host: string }).host === ctx.host) locate(ctx, by, p.workspaceId, ref, m)
      const threads = path !== null ? threadsHolding(ctx, p.workspaceId, { at: 'file', host: (ref as { host: string }).host, path }) : sameSource(ctx, p.workspaceId, ref)
      return handled({ threads })
    }
    case 'work.files.fetch': {
      const at = locate(ctx, by, p.workspaceId, p.ref as CanvasSource, m)
      if (at.in === 'place') throw new Error('A place is listed, not fetched.')
      if (at.in === 'library') {
        if (at.library.vm) await vmFetch(at.library.id, at.path, signal)
        else await fetchFile(at.library.id, at.path, signal)
      }
      return handled({ entry: await statOne(ctx, by, p.workspaceId, p.ref as CanvasSource, m, signal) })
    }
    case 'work.files.tabs':
      ownRows(ctx, by, p.workspaceId)
      return handled(tabsFor(ctx, by, p.workspaceId))
    case 'work.files.open':
      return handled(open(ctx, by, p as never, m))
    case 'work.files.tabOpen': {
      ownRows(ctx, by, p.workspaceId)
      admitPage(ctx, by, p.workspaceId, p.page as FilePage, m)
      const made = filesState(ctx).tabs.tabOpen(p.workspaceId, p.page as FilePage, p.after as string | undefined)
      return handled({ ...tabsFor(ctx, by, p.workspaceId), tabId: made.tabId })
    }
    case 'work.files.tabClose': {
      const workspace = ownRows(ctx, by, p.workspaceId)
      // The last tab closed becomes the workspace's folder: the place is never left with none.
      filesState(ctx).tabs.tabClose(p.workspaceId, p.tabId as string, { at: { at: 'place', id: PLACE.folder }, name: folderName(workspace, workspace.path, workspace.path) })
      return handled(tabsFor(ctx, by, p.workspaceId))
    }
    case 'work.files.tabMove':
      ownRows(ctx, by, p.workspaceId)
      filesState(ctx).tabs.tabMove(p.workspaceId, p.tabId as string, p.before as string | null)
      return handled(tabsFor(ctx, by, p.workspaceId))
    case 'work.files.tabSet':
      ownRows(ctx, by, p.workspaceId)
      admitPage(ctx, by, p.workspaceId, p.page as FilePage, m)
      filesState(ctx).tabs.tabSet(p.workspaceId, p.tabId as string, p.page as FilePage)
      return handled(tabsFor(ctx, by, p.workspaceId))
    case 'work.files.star': {
      ownRows(ctx, by, p.workspaceId)
      const { key, at } = markedOf(ctx, by, p.workspaceId, p.ref as FileRef, m)
      return handled({ starred: filesState(ctx).marks.star(p.workspaceId, key, at, p.name as string, p.on as boolean) })
    }
    case 'work.files.seen': {
      ownRows(ctx, by, p.workspaceId)
      const { key, at } = markedOf(ctx, by, p.workspaceId, p.ref as FileRef, m)
      filesState(ctx).marks.seen(p.workspaceId, key, at, p.name as string)
      return handled(null)
    }
    // The verbs: the door stands before any of them is built, so what it refuses is refused already.
    case 'work.files.make':
    case 'work.files.upload':
      admitChange(ctx, by, m === 'work.files.make' ? 'make' : 'upload', { ...p, refs: [p.at as FolderRef] } as never, m)
      throw NOT_YET(m === 'work.files.make' ? 'make a file' : 'take an upload')
    case 'work.files.rename':
      admitChange(ctx, by, 'rename', { ...p, refs: [p.ref as FileRef] } as never, m)
      throw NOT_YET('rename')
    case 'work.files.move':
    case 'work.files.copy':
    case 'work.files.trash': {
      const verb = m.slice('work.files.'.length) as 'move' | 'copy' | 'trash'
      admitChange(ctx, by, verb, p as never, m)
      throw NOT_YET(verb === 'trash' ? 'delete' : verb)
    }
    case 'work.files.restore':
    case 'work.files.purge':
      ownRows(ctx, by, p.workspaceId)
      throw NOT_YET(m === 'work.files.restore' ? 'put a file back' : 'empty Trash')
  }
  return NOT_HANDLED
}

/** The workspace's threads whose open items name exactly this source (a LifeOS row, a Google file), newest first. */
function sameSource(ctx: Pick<WorkCtx, 'canvas'>, workspaceId: string, ref: CanvasSource): { sessionId: string; itemId: string; source: CanvasSource }[] {
  const key = refKey(ref)
  const out = new Map<string, { itemId: string; source: CanvasSource }>()
  for (const item of ctx.canvas.forWorkspace(workspaceId, { open: true })) {
    if (!out.has(item.sessionId) && item.source.at !== 'thread' && refKey(item.source) === key) out.set(item.sessionId, { itemId: item.id, source: item.source })
  }
  return [...out].map(([sessionId, held]) => ({ sessionId, ...held }))
}

/** Items of a Files pane went by another way than their tab's close (the pane's own Close): their tabs go too. */
export function itemsGone(ctx: Pick<WorkCtx, 'db' | 'push' | 'log' | 'canvas'>, itemIds: readonly string[]): void {
  const state = filesState(ctx)
  const find = ctx.db.prepare(`SELECT workspace_id, id FROM work_files_tabs WHERE item_id = ?`)
  for (const itemId of itemIds) {
    const row = find.get(itemId) as { workspace_id: string; id: string } | undefined
    if (row) state.tabs.tabClose(row.workspace_id, row.id)
  }
}

/** A deleted workspace: its tabs, its marks and what Trash, the journal and Go to kept of it go. */
export function removeWorkspace(ctx: Pick<WorkCtx, 'db' | 'push' | 'log' | 'canvas'>, workspaceId: string): void {
  const state = filesState(ctx)
  state.tabs.removeWorkspace(workspaceId)
  state.marks.removeWorkspace(workspaceId)
  for (const table of ['work_files_trash', 'work_files_ops', 'work_files_names']) ctx.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId)
}
