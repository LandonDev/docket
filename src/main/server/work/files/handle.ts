import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile as readBytes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ClientRequest } from '@shared/contract'
import { isFileForm } from '@shared/work/fileForms'
import type { FileBytes, FileCrumb, FileDone, FilePage, FileRef, FileSaved, FilesListing, FilesOpened, FilesPlaces, FilesTabs, FileTab } from '@shared/contract-work-files'
import { teamsCanvasOf, teamsKindOf } from '@shared/contract-work-office'
import { canvasSourcePath, filesPaneOf, handled, NOT_HANDLED, type CanvasItem, type CanvasKind, type CanvasSource, type Handled } from '@shared/work'
import { copySavesBack, DEFAULT_SORT, extOf, freeName, kindOfEntry, PLACE, refKey, refusal, seatOf, splitName, type FileEntry, type FilePlace, type FileSort, type FileVerb, type FolderRef } from '@shared/work/files'
import { sheetImportFormat } from '@shared/work/sheetFormats'
import { fencedItem, itemPath } from '../canvas/store'
import type { Caller, WorkCtx } from '../modules'
import { copyIn, threadsHolding } from '../office/files/handle'
import { copyAllowed, fetchFile, rootsOf, whoOf } from '../office/files/library'
import { probeDrives } from '../office/files/reach'
import { copyWaits } from './copyKept'
import { saveAsWord } from './saveAsWord'
import { isWordFile, keptDoc, recordWord, wordAuto, wordBacksOf, wordRow, wordSave } from './word'
import { admitOwner, backsOf, copyAt, copyBack, copyClosing, copyKeep, copyRecord, copyReload, recordCopy, reopened, writeBack } from './copies'
import { isGuestPath, vmFetch, vmList, vmStat, vmVerbs } from '../office/vm/files'
import { chooseSeat, fileMakerFor } from './hooks'
import { MarkStore, type Mark, type Marked } from './marks'
import { feedListing, forgetGonePlaces, listedLibraries, namesAnswer, placeOf, whereOf } from './names'
import { dropSearch, savedSearches, saveSearch, searchFiles } from './search'
import { DiskLister, entryOfRow, type DiskPage, type DiskRow } from './places/disk'
import { folderEntry, folderName, folderPlace, folderTrail } from './places/folder'
import { forgetLibraries } from './places/libraries'
import { forgetVmList, libraryEntry, libraryKey, libraryTrail, placeOfPath, placesIn, teamsPlaces, vmPage, type LibraryPlace } from './places/teams'
import { admitCaller, admitWrite, changeDigest, isLifeosRef, locate, locatedShared, NEEDS_PRESS, NO_WORKSPACE, OWN_ONLY, pressesFor, SHARED_BYTES, sharedOf, PEER_LIBRARIES, workspaceHere, type DoorPlace, type Located, type WorkspaceRow } from './policy'
import { keepMail, lifeosPlace, lifeosPlaces, lifeosTrash, listLifeos, makeLifeos, moveLifeos, openLifeos, renameLifeos, restoreLifeos, setProject, statLifeos, trashLifeos, waitingRows, withProjects } from './places/lifeos'
import { READ_MAX, readFile, saveCopy, saveFile } from './save'
import { guestChange, guestOp, vmReadVersioned, vmSave, type VmWhere } from './vmVerbs'
import { TabStore } from './tabs'
import { copyVerb, makeFolderRef, makeVerb, moveVerb, offeredIn, renameVerb, replayed } from './verbs'
import { purgeRows, restoreRows, trashEntries, trashFiles } from './trash'
import { beginUpload } from './upload'
import { previewOf, thumbsOf } from './preview'
import { driveOf, googleSeated, googleSeatOf } from '../google/drive'
import { accountOfPlace, driveAccounts, driveList, drivePlace, driveStat, driveTop, itemShared } from './places/drive'
import { admitDrive, DRIVE_APART, driveMake, driveMove, driveRename, driveTrash, namesDrive } from './driveVerbs'
import { archiveListing } from './zipdir'
import { waitingFiles, withWaiting } from './waiting'

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

/** The workspace's own rows (tabs, marks) are kept only where it lives, and are no thread's and no other host's to change. */
export function ownRows(ctx: Pick<WorkCtx, 'db' | 'scopeOf'>, by: Caller, workspaceId: string, o: { threads?: boolean } = {}): WorkspaceRow {
  if (by.kind === 'model' && !o.threads) throw new Error(THREADS_NO_TABS)
  admitCaller(ctx, by, workspaceId)
  if (by.peer) throw new Error(PEER_LIBRARIES)
  const workspace = workspaceHere(ctx.db, workspaceId)
  if (!workspace) throw new Error(NO_WORKSPACE)
  return workspace
}

/**
 * The rows a delete and its Put back keep here: the workspace's own, or, for a workspace another host keeps, a stand-in
 * that holds only library rows (a delete in a library on this disk, asked by his window of the file's own host).
 */
function binRows(ctx: Pick<WorkCtx, 'db' | 'scopeOf'>, by: Caller, workspaceId: string, o: { peer?: boolean } = {}): WorkspaceRow {
  if (by.kind === 'model') throw new Error(THREADS_NO_TABS)
  admitCaller(ctx, by, workspaceId)
  // Another host of his reaches only this host's libraries, and changes one only with where the change began (the door, before this).
  if (by.peer && !o.peer) throw new Error(PEER_LIBRARIES)
  return workspaceHere(ctx.db, workspaceId) ?? { id: workspaceId, name: '', path: '', sector: null }
}

/** Whether a caller could name a path of this host itself: everyone but a remote key always; a key by the listener's fence, and a file in the Windows VM by the guest-path rule. */
const reaches = (ctx: Pick<WorkCtx, 'reaches'>, by: Caller, path: string): boolean => by.kind !== 'remote' || !!by.peer || (isGuestPath(path) && process.platform !== 'win32') || ctx.reaches(by, path)

/** The library places a caller may list: all of them, less the ones a remote key could not name. */
function libraryPlaces(ctx: WorkCtx, by: Caller): { places: LibraryPlace[]; sources: FilesPlaces['sources'] } {
  const { places, sources } = teamsPlaces(ctx, by)
  return { places: places.filter((p) => reaches(ctx, by, p.top)), sources }
}

const lens = (id: string, kind: FilePlace['kind'], name: string, host: string): FilePlace => ({ id, kind, name, host: '', env: host, shared: false, can: [], state: { state: 'ok' }, root: { at: 'place', id } })

/**
 * The workspace's Google Drives, one place per account it has: for his window, its threads, and a key that may
 * name the workspace's folder; never another host's. None while LifeOS has not said which accounts it has.
 */
async function drivePlaces(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow | null): Promise<FilePlace[]> {
  if (!workspace || by.peer || !reaches(ctx, by, workspace.path)) return []
  return (await driveAccounts(ctx, workspace.sector)).map((account) => drivePlace(ctx.host, account))
}

function placesAnswer(ctx: WorkCtx, by: Caller, workspaceId: string): FilesPlaces {
  admitCaller(ctx, by, workspaceId)
  const state = filesState(ctx)
  const workspace = by.peer ? null : workspaceHere(ctx.db, workspaceId)
  const own: FilePlace[] = []
  if (workspace && reaches(ctx, by, workspace.path)) own.push(folderOf(ctx, by, workspace))
  const { places, sources } = libraryPlaces(ctx, by)
  // His marks are the workspace's own rows: listed where it lives, and never to a thread.
  const marks = workspace && by.kind !== 'model' ? [lens(PLACE.home, 'home', 'Home', ctx.host), lens(PLACE.recent, 'recent', 'Recent', ctx.host), lens(PLACE.starred, 'starred', 'Starred', ctx.host), lens(PLACE.made, 'made', 'Made by threads', ctx.host), { ...lens(PLACE.trash, 'trash', 'Trash', ctx.host), can: ['restore', 'purge'] as FileVerb[] }] : []
  // What New offers is said with each place that makes anything, so a menu never offers what this host would refuse.
  const offered = (place: FilePlace): FilePlace => (place.can.includes('make') && !place.makes ? { ...place, makes: offeredIn(place) } : place)
  return { host: ctx.host, places: [...marks, ...own.map(offered), ...places.map((p) => offered(p.place))], rev: workspace ? state.tabs.rev(workspaceId) : 0, sources }
}

/**
 * The workspace's own folder as a caller is shown it. His window here keeps `shared: false`, which is what its questions
 * read (the door reads the real paths itself, `locatedShared`); any other caller (a phone, a far window, a thread) is
 * told the host's one answer, so a workspace kept in OneDrive reads as a place others can open there, facts only.
 */
function folderOf(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow): FilePlace {
  const place = folderPlace(ctx.host, workspace)
  return by.kind !== 'local' && sharedOf(ctx, { at: 'file', host: ctx.host, path: workspace.path }) ? { ...place, shared: true } : place
}
/** A row of the workspace's folder as a caller is shown it: marked shared where the host calls its folder so, for a caller that is not his window here. */
const sharedFor = (ctx: WorkCtx, by: Caller, at: Located, entry: FileEntry): FileEntry => (by.kind !== 'local' && locatedShared(ctx, at) ? { ...entry, shared: true } : entry)

/** The door's view of where a located thing lies. A file at a team library's own top, outside every channel, is in the library taken as one place. */
export function doorPlace(ctx: WorkCtx, by: Caller, at: Located): { place: DoorPlace; library?: LibraryPlace } {
  if (at.in === 'folder') return { place: folderPlace(ctx.host, at.workspace) }
  if (at.in === 'drive') return { place: drivePlace(ctx.host, at.account) }
  if (at.in === 'library') {
    const all = teamsPlaces(ctx, by).places
    const library = placeOfPath(all, at.library, at.path) ?? placesIn({ ...at.library, kind: at.library.kind === 'channels' ? 'library' : at.library.kind, channels: [] }, { state: 'ok' }, vmVerbs(ctx.db))[0]!
    return { place: library.place, library }
  }
  throw new Error(NOT_BUILT_PLACE)
}

/** A mark as a row of a lens, when the caller could name what it points at. */
function markEntry(ctx: WorkCtx, by: Caller, m: Mark, workspace: WorkspaceRow, libraries: readonly LibraryPlace[]): FileEntry | null {
  const at = 'file' in m.at ? m.at.file : m.at.folder
  // A Drive's things carry no path: a key hears of them only where it reaches their place, the workspace's folder.
  if ((at.at === 'google' || at.at === 'drive') && !reaches(ctx, by, workspace.path)) return null
  const path = at.at === 'file' ? at.path : at.at === 'microsoft' && at.ref.kind === 'path' ? at.ref.path : null
  // A file of this host out of a key's reach is left out; one on another host is that host's to fence when it is opened.
  if (path !== null && (at as { host: string }).host === ctx.host && !reaches(ctx, by, path)) return null
  const folder = 'folder' in m.at
  return {
    key: m.key,
    ref: folder ? null : (at as CanvasSource),
    folder: folder ? (at as FolderRef) : null,
    name: m.name,
    kind: folder ? 'folder' : at.at === 'lifeos' ? (at.table === 'sheets' ? 'sheet' : 'document') : kindOfEntry(m.name, at.at === 'mail' ? at.contentType : undefined).kind,
    ...homeOf(ctx, by, workspace, at, libraries),
    ...(m.openedAt ? { changed: m.openedAt } : {}),
    ...(m.starred ? { starred: true } : {}),
    ...(m.madeBy ? { madeBy: m.madeBy, fresh: m.seenAt === null } : {})
  }
}

/**
 * A lens row's home and sharing, as its folder's listing would give them (round 2): a file of this host is located
 * for the caller and said where it lies (`whereOf`), shared where its place is or the host's one answer says so
 * (`locatedShared`, for any caller but his window, as the folder's own rows); a Google file is in its account's
 * Drive, always shared. Nothing for a file of another host or one the caller may no longer name.
 */
function homeOf(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow, at: CanvasSource | FolderRef, libraries: readonly LibraryPlace[]): Pick<FileEntry, 'where' | 'shared'> {
  if (at.at === 'google' || at.at === 'drive') {
    const place = drivePlace(ctx.host, at.account)
    return { where: { place: place.id, name: place.name, trail: [] }, shared: true }
  }
  const path = at.at === 'file' ? at.path : at.at === 'microsoft' && at.ref.kind === 'path' ? at.ref.path : null
  if (path === null || (at as { host: string }).host !== ctx.host) return {}
  try {
    const located = locate(ctx, by, workspace.id, { at: 'file', host: ctx.host, path }, 'work.files.list')
    const where = whereOf(ctx, located, placeOf(located, libraries))
    const shared = located.in === 'library' || (by.kind !== 'local' && locatedShared(ctx, located))
    return { ...(where ? { where } : {}), ...(shared ? { shared: true } : {}) }
  } catch {
    return {}
  }
}

/** Marks the page's rows he starred, and the ones a thread made that he has not opened. */
export function withMarks(state: FilesState, workspaceId: string, entries: FileEntry[]): FileEntry[] {
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
    if (at.id === PLACE.recent || at.id === PLACE.starred || at.id === PLACE.made) {
      const workspace = ownRows(ctx, by, p.workspaceId)
      const marks = at.id === PLACE.recent ? state.marks.recent(p.workspaceId) : at.id === PLACE.starred ? state.marks.starred(p.workspaceId) : state.marks.made(p.workspaceId)
      const libraries = listedLibraries(ctx, by)
      const entries = marks.flatMap((m) => markEntry(ctx, by, m, workspace, libraries) ?? [])
      return { entries: p.foldersOnly ? entries.filter((e) => e.kind === 'folder') : entries, place: at.id, trail: [{ name: at.id === PLACE.recent ? 'Recent' : at.id === PLACE.starred ? 'Starred' : 'Made by threads', at: { at: 'place', id: at.id } }] }
    }
    if (at.id === PLACE.trash) {
      // Trash holds files, not folders to go into: a folder in it is one row.
      const workspace = ownRows(ctx, by, p.workspaceId)
      return { entries: p.foldersOnly ? [] : trashEntries(ctx, by, workspace), place: at.id, trail: [{ name: 'Trash', at: { at: 'place', id: at.id } }] }
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
    const rows = page.rows.map((row) => folderEntry(ctx.host, path, row))
    const shown = by.kind !== 'local' && locatedShared(ctx, at) ? rows.map((e) => ({ ...e, shared: true })) : rows
    return listing(page, withMarks(state, workspace.id, shown), first ? { place: PLACE.folder, trail: folderTrail(ctx.host, workspace, root, path) } : {})
  }
  if (at.in === 'drive') {
    if (at.mime) throw new Error('That is a file, not a folder.')
    const got = await driveList(ctx, drivePlace(ctx.host, at.account), at.account, at.id, { sort, cursor: p.cursor, foldersOnly: p.foldersOnly, signal })
    return got.stale ? got : { ...got, entries: withMarks(state, p.workspaceId, got.entries) }
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
async function statOne(ctx: WorkCtx, by: Caller, workspaceId: string, ref: FileRef, method: string, signal?: AbortSignal, o: { who?: boolean } = {}): Promise<FileEntry | null> {
  let at: Located
  try {
    at = locate(ctx, by, workspaceId, ref, method)
  } catch {
    return null
  }
  const state = filesState(ctx)
  if (at.in === 'drive') return driveStat(ctx, at.account, at.id)
  if (at.in === 'folder') {
    const row = await state.lister.row(at.path)
    if (!row) return null
    const entry = sharedFor(ctx, by, at, entryOfRow(row, ctx.host, at.path, refKey({ at: 'file', host: ctx.host, path: at.path })))
    return o.who === false ? entry : withWho(entry, at.path, row)
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
  if (!row) return null
  const entry: FileEntry = { ...entryOfRow(row, ctx.host, at.path, libraryKey(place!, at.path)), shared: true }
  return o.who === false ? entry : withWho(entry, at.path, row)
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
export function openAs(ctx: WorkCtx, at: Located, name: string, as?: CanvasKind): { kind: CanvasKind; source: CanvasSource } {
  if (at.in === 'drive') throw new Error(DRIVE_APART)
  const file: CanvasSource | null = at.in === 'place' ? null : { at: 'file', host: ctx.host, path: at.path }
  // Every file opens: its kind's viewer, else the `file` kind (text to edit, its facts for the rest).
  if (at.in === 'folder') return { kind: as ?? seatOf(name), source: file! }
  if (at.in === 'library') {
    // A form an editor's build says it edits in place (`registerFileMaker`'s forms) opens as the file it is, in that
    // editor, and saves back through `saveFile`: no Office app stands behind it.
    const form = extOf(name)
    const own = kindOfEntry(name).canvas
    if (!as && own && isFileForm(form) && fileMakerFor(own, form)) return { kind: own, source: file! }
    // So does a form the sheet editor opens as an Excel copy of its own making (an .xls, .ods or .tsv: sheets/formatsIn.ts):
    // the copy is its tab's alone, under the preview scratch, and the file changes only by his press, through `saveFile`.
    if (!as && own === 'sheet' && sheetImportFormat(name)) return { kind: own, source: file! }
    // Else an Office file in a library has its app behind it; anything else is the file it is.
    const found = teamsCanvasOf({ name, path: at.path, kind: teamsKindOf(name) }, ctx.host)
    if (as) return { kind: as, source: found && as === found.kind ? found.source : file! }
    // A library's sound is played by the `file` kind, never transcribed as a meeting.
    return found ?? { kind: 'file', source: file! }
  }
  throw new Error(NOT_BUILT_PLACE)
}

type OpenAsk = { workspaceId: string; ref: CanvasSource; name?: string; as?: CanvasKind; opener?: string; beside?: string; side?: string; key?: string }

/**
 * A file that is no file of this disk, opened in a tab: one on another host of his, or in this host's Windows VM.
 * It opens as a copy made here, in the pane's own folder, where the workspace's Copy Teams files allows one
 * (`copyIn` refuses otherwise, in the sentence the window offers its press for); the tab says whose copy it is.
 * The copy is read only in effect: changes stay in it, and it goes when its tab closes.
 */
async function openCopy(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow, p: OpenAsk, file: { host: string; path: string }, signal?: AbortSignal): Promise<FilesOpened> {
  const state = filesState(ctx)
  const name = p.name ?? nameOfPath(file.path)
  const key = p.key ?? refKey({ at: 'file', ...file })
  const cut = (item: CanvasItem): CanvasItem => fencedItem(item, (path) => reaches(ctx, by, path))
  const tabNow = (): FilesOpened | null => {
    const was = state.tabs.tabOf(workspace.id, key)
    // The key is the caller's word: it answers a tab only when that tab is this very file's copy, so naming another
    // tab's key with a file of some other host never shows what that tab holds.
    if (was && (was.copyOf?.host !== file.host || was.copyOf.path !== file.path)) throw new Error(KEY_TAKEN)
    const shown = was?.itemId ? ctx.canvas.get(was.itemId) : null
    return was && shown ? { ...tabsFor(ctx, by, workspace.id), tabId: was.id, item: cut(shown) } : null
  }
  const already = tabNow()
  if (already) return already
  // Two windows opening the file at once make its copy one after the other, and the second looks again first: a
  // tab the first made, and the edits it took meanwhile, are answered as they are, never read over from the file.
  return oneCopyAtATime(workspace.id, file, async () => {
    const again = tabNow()
    if (again) return again
    const seat = await copySeat(ctx, workspace.id, file, name, p.as, signal)
    const { tabId, item } = state.tabs.openFile(workspace.id, { key, name, ...seat }, p.opener)
    state.marks.seen(workspace.id, key, { file: { at: 'file', ...file } }, name)
    return { ...tabsFor(ctx, by, workspace.id), tabId, item: cut(item) }
  })
}
const nameOfPath = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** What a copy's tab shows: the Word file's kept document, the copy that waits, or a copy made now. */
async function copySeat(ctx: WorkCtx, workspaceId: string, file: { host: string; path: string }, name: string, as: CanvasKind | undefined, signal?: AbortSignal): Promise<{ kind: CanvasKind; source: CanvasSource; copyOf: { host: string; path: string; vm?: boolean } }> {
  const vm = file.host === ctx.host
  const copyOf = { host: file.host, path: file.path, ...(vm ? { vm: true } : {}) }
  // A copy is the file it is, with no app behind it; a copy of a library's sound is played, not transcribed.
  const kind = as ?? (kindOfEntry(name).kind === 'audio' ? 'file' : seatOf(name))
  const back = copySavesBack(kind, name)
  // A Word file opened as a document before: the document his edits are kept in opens again, and nothing is read
  // over it (word.ts). Its tab still names the Word file, which Save as Word writes.
  const word = kind === 'document' && isWordFile(name)
  const kept = word ? keptDoc(ctx, workspaceId, file.host, file.path) : null
  if (kept && copyAllowed(ctx.db, workspaceId)) return { kind, source: { at: 'file', host: ctx.host, path: kept.doc! }, copyOf }
  // A copy whose changes have not reached its file (its tab closed, its computer did not answer, or its bytes are not
  // what the file holds) is opened again as it is: it is never read over from the file while they wait.
  const waiting = back ? copyRecord(ctx, workspaceId, file.host, file.path) : null
  if (waiting && copyWaits(waiting) && existsSync(waiting.copy) && copyAllowed(ctx.db, workspaceId)) {
    reopened(ctx, waiting)
    return { kind, source: { at: 'file', host: ctx.host, path: waiting.copy }, copyOf }
  }
  // A copy is a file of its own: its marks are its own, so a thread that holds the original never takes its open.
  const copy = await copyIn(ctx, filesPaneOf(workspaceId), { at: 'file', ...file }, signal)
  // A kind that edits the copy's own bytes saves back to the file: the record holds where it lies and what it held.
  const path = (copy.source as { path: string }).path
  if (back && copy.version) recordCopy(ctx, { workspaceId, host: file.host, path: file.path, vm, copy: path, name, kind, version: copy.version, sha256: createHash('sha256').update(await readBytes(path)).digest('hex') })
  else if (waiting) ctx.db.prepare(`DELETE FROM work_files_copies WHERE id = ?`).run(waiting.id)
  // A Word file: the version it was read at, which Save as Word writes over, and the document made of it is kept.
  if (word && copy.version) recordWord(ctx, { workspaceId, host: file.host, path: file.path, vm, name, version: copy.version, sha: createHash('sha256').update(await readBytes(path)).digest('hex') })
  return { kind, source: copy.source, copyOf }
}
const KEY_TAKEN = 'That key names another file that is open.'

/** The copy of one file of the workspace being made, read or replaced now: the next waits for it (`copyIn` writes one path a file). */
const making = new Map<string, Promise<unknown>>()
async function oneCopyAtATime<T>(workspaceId: string, file: { host: string; path: string }, run: () => Promise<T>): Promise<T> {
  const key = `${workspaceId}\0${file.host}\0${file.path}`
  const mine = (making.get(key) ?? Promise.resolve()).catch(() => undefined).then(run)
  const tail = mine.catch(() => undefined)
  making.set(key, tail)
  try {
    return await mine
  } finally {
    if (making.get(key) === tail) making.delete(key)
  }
}

async function open(ctx: WorkCtx, by: Caller, p: OpenAsk, method: string, signal?: AbortSignal): Promise<FilesOpened> {
  const workspace = ownRows(ctx, by, p.workspaceId)
  const state = filesState(ctx)
  if (isLifeosRef(p.ref)) {
    // A LifeOS document or sheet, or a mail's file: seated in its kind with its own source (places/lifeos.ts).
    const made = await openLifeos(ctx, by, p.workspaceId, p.ref)
    const { tabId, item } = state.tabs.openFile(workspace.id, { key: made.key, name: made.name, kind: p.as ?? made.kind, source: made.source }, p.opener)
    state.marks.seen(workspace.id, made.key, { file: made.source }, made.name)
    return { ...tabsFor(ctx, by, workspace.id), tabId, item }
  }
  // A pillar may seat the file its own way first (hooks.ts `registerSeatChooser`: a shared Office file remembered as Live).
  const chosen = await chooseSeat(ctx, by, p, signal)
  if (chosen) {
    const { tabId, item } = state.tabs.openFile(workspace.id, chosen, p.opener)
    state.marks.seen(workspace.id, chosen.key, { file: { at: 'file', ...chosen.file } }, chosen.name)
    return { ...tabsFor(ctx, by, workspace.id), tabId, item: fencedItem(item, (path) => reaches(ctx, by, path)) }
  }
  const named = canvasSourcePath(p.ref)
  if (named !== null && ((p.ref as { host: string }).host !== ctx.host || (isGuestPath(named) && process.platform !== 'win32'))) {
    // A file in the VM is still held to OneDrive's mounts there, and to the caller's reach, before any byte moves.
    if ((p.ref as { host: string }).host === ctx.host) locate(ctx, by, p.workspaceId, p.ref, method)
    // The Beside seat and a tab's side show a file where it lies; a copy is a tab's, which says whose copy it is.
    if (p.beside || p.side) throw new Error(BESIDE_HERE)
    return openCopy(ctx, by, workspace, p, { host: (p.ref as { host: string }).host, path: named }, signal)
  }
  const at = locate(ctx, by, p.workspaceId, p.ref, method)
  if (at.in === 'place') throw new Error('A place is listed, not opened.')
  if (at.in === 'drive') return openGoogle(ctx, by, workspace, at, p)
  const inVm = at.in === 'library' && !!at.library.vm
  if (!inVm && statSync(at.path).isDirectory()) throw new Error('That is a folder: it opens in its tab.')
  const name = inVm ? at.path.slice(at.path.lastIndexOf('\\') + 1) : basename(at.path)
  const { library } = doorPlace(ctx, by, at)
  const key = library ? libraryKey(library, at.path) : refKey({ at: 'file', host: ctx.host, path: at.path })
  const made = openAs(ctx, at, name, p.as)
  // A file of this disk opens in its tab even when a thread shows it: a PDF, a video and a deck keep their marks and
  // their state by the file (canvas/fileKey.ts, slides `deckKey`), so the tab and the thread share them.
  if (p.beside) {
    // No tab is made and none is selected: the window's one seat shows this file now, and the file it showed goes.
    const seated = state.tabs.seat(workspace.id, p.beside, { key, name, kind: made.kind, source: made.source })
    state.marks.seen(workspace.id, key, { file: { at: 'file', host: ctx.host, path: at.path } }, name)
    return { ...tabsFor(ctx, by, workspace.id), ...(seated.tabId ? { tabId: seated.tabId } : {}), item: fencedItem(seated.item, (path) => reaches(ctx, by, path)) }
  }
  const { tabId, item } = p.side ? state.tabs.openSide(workspace.id, p.side, { key, name, kind: made.kind, source: made.source }) : state.tabs.openFile(workspace.id, { key, name, kind: made.kind, source: made.source }, p.opener)
  state.marks.seen(workspace.id, key, { file: { at: 'file', host: ctx.host, path: at.path } }, name)
  return { ...tabsFor(ctx, by, workspace.id), tabId, item: fencedItem(item, (path) => reaches(ctx, by, path)) }
}
export const BESIDE_HERE = 'A file on another computer opens in a tab of its own.'

/** His window: what a reseat runs as when no caller is named. */
const HIS: Caller = { kind: 'local', caps: ['read', 'operate', 'approve'] }

/**
 * A Files tab's file opened fresh in its own tab, as `open` seats it when no pillar has a word (a live tab back to Edit
 * here): a copy for a file of another computer or the VM, else its kind on this host. The tab and its key stay; its
 * item is replaced. Answers the new item.
 */
export async function reseat(ctx: WorkCtx, workspaceId: string, tabId: string, by: Caller = HIS, signal?: AbortSignal): Promise<CanvasItem> {
  ownRows(ctx, by, workspaceId)
  const state = filesState(ctx)
  const tab = state.tabs.list(workspaceId).tabs.find((t) => t.id === tabId && t.kind === 'file')
  const item = tab?.itemId ? ctx.canvas.get(tab.itemId) : null
  if (!tab || !item) throw new Error('That tab is closed.')
  // The file he opened: the other computer's the tab stands for, else the one its key was marked with.
  const marked = tab.key ? state.marks.of(workspaceId, [tab.key]).get(tab.key)?.at : undefined
  const file = tab.copyOf ?? (marked && 'file' in marked && marked.file.at === 'file' ? marked.file : null)
  if (!file) throw new Error('That tab names no file to open here.')
  const name = nameOfPath(file.path)
  const copyOf = tab.copyOf
  const seat = copyOf ? await oneCopyAtATime(workspaceId, copyOf, () => copySeat(ctx, workspaceId, copyOf, name, undefined, signal)) : openAs(ctx, locate(ctx, by, workspaceId, { at: 'file', host: file.host, path: file.path }, 'work.files.open'), name)
  const word = tab.copyOf ? wordRow(ctx, workspaceId, file.host, file.path) : null
  const next = ctx.canvas.replace(item.sessionId, item.id, seat.kind, seat.source, name)
  // word.ts `wordFollowed` takes the first document to replace a Word copy's item for the one made of it: a fresh copy is not.
  if (word && !word.doc && wordRow(ctx, workspaceId, file.host, file.path)?.doc) recordWord(ctx, { workspaceId, host: word.host, path: word.path, vm: !!word.vm, name: word.name, version: word.version, sha: word.sha as string })
  return next
}

/**
 * A Google file in a Files tab: its kind's item on the workspace's Files pane, with no thread, and never twice
 * (opening it again selects its tab). The google pillar keeps its row and polls its version while it is open. A
 * picked file that is no Doc, Sheet or deck (a PDF, a workbook) shows its facts, with Open in Drive. A deck
 * a thread already shows opens in that thread: a Google deck is no file of this disk, so the slides pillar keeps its
 * review state by item (`deckKey`), and two seats on it would each write that state.
 */
async function openGoogle(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow, at: Located & { in: 'drive' }, p: OpenAsk): Promise<FilesOpened> {
  if (!at.mime) throw new Error('That is a folder: it opens in its tab.')
  const state = filesState(ctx)
  const seat = await googleSeatOf(ctx, at.account, at.id, { facts: true })
  const key = refKey(seat.source)
  if (seat.kind === 'slides') {
    const holding = sameSource(ctx, workspace.id, seat.source)[0]
    if (holding) return { ...tabsFor(ctx, by, workspace.id), held: { sessionId: holding.sessionId, itemId: holding.itemId } }
  }
  const file = { key, name: seat.name, kind: seat.kind, source: seat.source }
  const opened = p.beside ? state.tabs.seat(workspace.id, p.beside, file) : state.tabs.openFile(workspace.id, file, p.opener)
  googleSeated(ctx, seat, opened.item.id)
  state.marks.seen(workspace.id, key, { file: seat.source }, seat.name)
  return { ...tabsFor(ctx, by, workspace.id), ...(opened.tabId ? { tabId: opened.tabId } : {}), item: opened.item }
}

/** The tabs as a caller may see them: a remote key hears of none that stands on, or holds, a file of this host it could not name. */
function tabsFor(ctx: WorkCtx, by: Caller, workspaceId: string): FilesTabs {
  const state = filesState(ctx)
  const listed = state.tabs.list(workspaceId)
  // A copy that saves back says how that stands on its tab.
  const backs = backsOf(ctx, workspaceId)
  // A Word file opened as its document says how the Word file stands (word.ts).
  const words = wordBacksOf(ctx, workspaceId)
  const all =
    backs.size || words.size
      ? {
          rev: listed.rev,
          tabs: listed.tabs.map((t) => {
            const at = t.copyOf ? `${t.copyOf.host}\0${t.copyOf.path}` : ''
            return backs.has(at) ? { ...t, back: backs.get(at)! } : words.has(at) ? { ...t, word: words.get(at)! } : t
          })
        }
      : listed
  if (by.kind !== 'remote' || by.peer) return all
  const tabs = all.tabs.filter((tab: FileTab) => {
    if (tab.kind === 'page') {
      const at = tab.page!.at
      return !(at.at === 'file' && at.host === ctx.host && !reaches(ctx, by, at.path))
    }
    const item = tab.itemId ? ctx.canvas.get(tab.itemId) : null
    const path = item ? itemPath(item) : null
    return path === null || reaches(ctx, by, path)
  })
  // A file at a tab's side that the key could not name is left out of the tab it is told of.
  const cut = tabs.map((tab: FileTab) => {
    if (!tab.side) return tab
    const item = ctx.canvas.get(tab.side.itemId)
    const path = item ? canvasSourcePath(item.source) : null
    if (path === null || reaches(ctx, by, path)) return tab
    const { side: _hidden, ...rest } = tab
    return rest
  })
  return { rev: all.rev, tabs: cut }
}

/** A page a tab may stand on: a place or lens of the workspace, a folder of this host the caller could name, or a folder of another host (only its address is kept here; that host fences it when it is listed). */
function admitPage(ctx: WorkCtx, by: Caller, workspaceId: string, page: FilePage, method: string): void {
  const at = page.at
  if (at.at === 'file' && at.host === ctx.host) locate(ctx, by, workspaceId, at, method)
}

/** What a mark holds for a ref: a file to open or a folder to list. A path on this host is looked at; anywhere else the words decide. */
function markedOf(ctx: WorkCtx, by: Caller, workspaceId: string, ref: FileRef, method: string): { key: string; at: Marked } {
  // A Drive folder or a Google file must be of the workspace's own accounts, as any change to it must.
  if (ref.at === 'drive' || ref.at === 'google') locate(ctx, by, workspaceId, ref, method)
  if (ref.at === 'drive' || ref.at === 'project' || ref.at === 'place') return { key: refKey(ref), at: { folder: ref } }
  const path = canvasSourcePath(ref as CanvasSource)
  if (path === null || (ref as { host: string }).host !== ctx.host) return { key: refKey(ref), at: { file: ref as CanvasSource } }
  const at = locate(ctx, by, workspaceId, ref, method)
  if (at.in === 'place' || at.in === 'drive') return { key: refKey(ref), at: { folder: ref as FolderRef } }
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
export function admitChange(ctx: WorkCtx, by: Caller, verb: FileVerb, p: { workspaceId: string; refs: FileRef[]; to?: FolderRef; name?: string; kind?: string; from?: FileRef; asked?: boolean; origin?: Parameters<typeof admitWrite>[1]['origin'] }, method: string): 'run' | 'hold' {
  admitCaller(ctx, by, p.workspaceId)
  const into = p.to ? locate(ctx, by, p.workspaceId, p.to.at === 'place' ? placeRoot(ctx, by, p.workspaceId, p.to.id) : p.to, method) : null
  const to = into ? doorPlace(ctx, by, into).place : null
  let verdict: 'run' | 'hold' = 'run'
  for (const ref of p.refs) {
    const at = locate(ctx, by, p.workspaceId, ref.at === 'place' ? placeRoot(ctx, by, p.workspaceId, ref.id) : ref, method)
    const from = doorPlace(ctx, by, at).place
    if (at.in === 'drive') {
      // A Drive's things are asked of Drive (`admitDrive`); here only what its grammar refuses outright.
      const no = refusal(from, verb, null, to)
      throw new Error(no?.text ?? DRIVE_APART)
    }
    const name = at.in === 'place' ? '' : basename(at.path)
    // Both ends by their real paths: a workspace kept in OneDrive, or a library reached inside it, is others' to open.
    const othersOpen = locatedShared(ctx, at) || (!!into && locatedShared(ctx, into))
    const got = admitWrite(by, { verb, from, to, entry: { name, kind: kindOfEntry(name).kind }, asked: p.asked, origin: p.origin, digest: changeDigest({ workspaceId: p.workspaceId, verb, refs: p.refs, to: p.to, name: p.name, kind: p.kind, template: p.from }), othersOpen })
    if (got === 'hold') verdict = 'hold'
  }
  return verdict
}

/** The root folder of a place of the workspace, for a verb that names the place itself. */
export function placeRoot(ctx: WorkCtx, by: Caller, workspaceId: string, id: string): FolderRef {
  if (id === PLACE.folder) {
    const workspace = workspaceHere(ctx.db, workspaceId)
    if (!workspace) throw new Error(NO_WORKSPACE)
    return folderPlace(ctx.host, workspace).root
  }
  const account = accountOfPlace(id)
  if (account) return driveTop(account)
  const found = libraryPlaces(ctx, by).places.find((l) => l.place.id === id)
  if (!found) throw new Error(NOT_BUILT_PLACE)
  return found.place.root
}

const LIBRARY_BYTES = SHARED_BYTES
const VM_BYTES = 'A file in the Windows VM is read as its copy. Open it first.'

/** The roots a file's bytes are read or replaced within: the folder or the library it was located in. A file in the VM is no file of this disk. */
function bytesFence(ctx: WorkCtx, by: Caller, at: Located): { roots: string[]; path: string } {
  // The workspace's own folder kept where others open it (OneDrive, a network share) is read as a library is.
  if (at.in === 'folder') {
    if (by.kind !== 'local' && locatedShared(ctx, at)) throw new Error(LIBRARY_BYTES)
    return { roots: [at.root], path: at.path }
  }
  if (at.in === 'drive') throw new Error('A Google file is read in its own tab, from Google.')
  if (at.in !== 'library') throw new Error('A place is listed, not read.')
  if (at.library.vm) throw new Error(VM_BYTES)
  // A shared library's bytes go to his own window alone: never to a thread, a remote key or another host by this door.
  if (by.kind !== 'local') throw new Error(LIBRARY_BYTES)
  return { roots: [at.library.path], path: at.path }
}

/** A Files tab's own copy of a file on another computer, read for his window: the copy lies in the pane's folder, which no place lists. null when the item is no such copy. */
async function readCopy(ctx: WorkCtx, by: Caller, p: { workspaceId: string; ref: CanvasSource; itemId: string; offset: number; length: number; version?: string }): Promise<FileBytes | null> {
  if (by.kind === 'model' || by.peer || !workspaceHere(ctx.db, p.workspaceId)) return null
  const tab = filesState(ctx).tabs.list(p.workspaceId).tabs.find((t) => t.itemId === p.itemId)
  if (!tab?.copyOf) return null
  admitCaller(ctx, by, p.workspaceId)
  // His own window, here or reaching this host with a key that may approve (his Mac's window on the box), as a copy's
  // save is his (copies.ts `admitOwner`); never a read key or another host.
  if (by.kind !== 'local' && !(by.kind === 'remote' && by.caps.includes('approve'))) throw new Error(LIBRARY_BYTES)
  const item = ctx.canvas.get(p.itemId)
  const path = item ? canvasSourcePath(item.source) : null
  if (!item || item.sessionId !== filesPaneOf(p.workspaceId) || path === null || refKey(item.source) !== refKey(p.ref)) throw new Error('That tab holds no copy to read.')
  // A copy that saves back is edited here, and its saves go to the file (copies.ts); any other stays as it was read.
  const saving = copyAt(ctx, p.workspaceId, path)
  return { ...(await readFile({ roots: [dirname(path)] }, path, p.offset, p.length, p.version)), ...(saving ? {} : { locked: COPY_LOCKED }) }
}
const COPY_LOCKED = 'This is a copy. Changes are made where the file is kept.'
const COPY_KEEP_THERE = 'This copy changed here. Reload it, then make your change again.'

/** An editor's save of a text file (`work.files.write`): through the door as `edit`, then by version. */
async function write(ctx: WorkCtx, by: Caller, p: { workspaceId: string; ref: CanvasSource; text: string; version: string; copy?: boolean; origin?: Parameters<typeof admitWrite>[1]['origin'] }, method: string, signal?: AbortSignal): Promise<FileSaved> {
  const data = Buffer.from(p.text, 'utf8')
  // A Files tab's copy that saves back: written through the door by version, and the save sends it on (copies.ts).
  const own = canvasSourcePath(p.ref)
  const saving = own !== null && (p.ref as { host: string }).host === ctx.host && !by.peer && workspaceHere(ctx.db, p.workspaceId) ? copyAt(ctx, p.workspaceId, own) : null
  if (saving) {
    admitCaller(ctx, by, p.workspaceId)
    admitOwner(by, saving)
    if (p.copy) throw new Error(COPY_KEEP_THERE)
    return saveFile({ roots: [saving.dir] }, refKey({ at: 'file', host: ctx.host, path: saving.copy }), saving.copy, data, p.version)
  }
  if (p.copy) {
    // His text kept beside the file is asked of the folder: the file itself may be gone, which is why he keeps a copy.
    const named = canvasSourcePath(p.ref)
    if (named === null) throw new Error(NOT_BUILT_PLACE)
    // A guest path's folder is cut at its own separator.
    const guest = isGuestPath(named) && process.platform !== 'win32'
    const folder: FolderRef = { at: 'file', host: (p.ref as { host: string }).host, path: guest ? named.slice(0, named.lastIndexOf('\\')) : dirname(named) }
    if (admitChange(ctx, by, 'edit', { workspaceId: p.workspaceId, refs: [folder], origin: p.origin }, method) === 'hold') throw new Error(HELD_NOT_YET)
    const inDir = locate(ctx, by, p.workspaceId, folder, method)
    if (inDir.in === 'library' && inDir.library.vm) {
      const copy = await vmSaveCopy(vmWhere(ctx, by, inDir), named.slice(named.lastIndexOf('\\') + 1), data, by)
      const entry = await statOne(ctx, by, p.workspaceId, { at: 'file', host: ctx.host, path: copy }, method, signal)
      if (!entry) throw new Error('The copy was made and could not be read back.')
      return { copy: entry }
    }
    const dir = bytesFence(ctx, by, inDir)
    const made = await saveCopy({ roots: dir.roots }, join(dir.path, basename(named)), data)
    const entry = await statOne(ctx, by, p.workspaceId, { at: 'file', host: ctx.host, path: made }, method, signal)
    if (!entry) throw new Error('The copy was made and could not be read back.')
    return { copy: entry }
  }
  let at: Located
  try {
    if (admitChange(ctx, by, 'edit', { workspaceId: p.workspaceId, refs: [p.ref], origin: p.origin }, method) === 'hold') throw new Error(HELD_NOT_YET)
    at = locate(ctx, by, p.workspaceId, p.ref, method)
  } catch (err) {
    // A file that is gone is the save's conflict, never a file made again under its old name.
    if (err instanceof Error && / is not there any more\.$/.test(err.message)) return { conflict: { gone: true } }
    throw err
  }
  if (at.in === 'library' && at.library.vm) {
    if (by.kind !== 'local') throw new Error(LIBRARY_BYTES)
    return vmSave(ctx, p.workspaceId, vmWhere(ctx, by, at), data, p.version, randomUUID())
  }
  const { roots, path } = bytesFence(ctx, by, at)
  const { library } = doorPlace(ctx, by, at)
  const key = library ? libraryKey(library, path) : refKey({ at: 'file', host: ctx.host, path })
  return saveFile({ roots }, key, path, data, p.version)
}

/** A located thing in the VM, as vmVerbs.ts takes it. */
export function vmWhere(ctx: WorkCtx, by: Caller, at: Located & { in: 'library' }): VmWhere {
  const { place, library } = doorPlace(ctx, by, at)
  return { path: at.path, place, library: library!, key: libraryKey(library!, at.path) }
}

/** His edits kept beside a file in the VM that changed under them: "Name (mine).ext" in its folder there, never over anything. Answers its guest path. */
async function vmSaveCopy(dir: VmWhere, name: string, data: Uint8Array, by: Caller): Promise<string> {
  if (by.kind !== 'local') throw new Error(LIBRARY_BYTES)
  const names = new Set((await vmList(dir.library.library, dir.path)).map((e) => e.name.toLowerCase()))
  const { stem, ext } = splitName(name)
  const free = freeName(`${stem} (mine)${ext}`, (n) => names.has(n.toLowerCase()))
  const made = await guestChange<{ entry: { path: string } }>('files.write', { dir: dir.path, name: free, data: Buffer.from(data).toString('base64'), op: guestOp(randomUUID()) })
  forgetVmList(dir.library.library.id, dir.path)
  return made.entry.path
}

const HELD_NOT_YET = 'A change others will see waits for his press, which Files cannot hold yet.'
/** A change the door would hold for his press (a thread's, in a shared place) is held by the `files_*` tools as a `file.act`, never run from the wire. */
export const HELD_BY_TOOLS = 'Others can open that place: a thread\'s change there is held for his press through the files_* tools.'
const held = (verdict: 'run' | 'hold'): void => {
  if (verdict === 'hold') throw new Error(HELD_BY_TOOLS)
}
const MAY_NOT = (what: string): string => `This key may not ${what}.`
/** A thread changes files only through the `files_*` tools (files/tools.ts), which give a run its Result and Undo and hold a shared change: never by the wire. */
export const THREADS_BY_TOOLS = 'A thread changes files with the files_* tools.'
const CHANGES: ReadonlySet<string> = new Set(['make', 'rename', 'move', 'copy', 'trash', 'upload', 'write', 'restore', 'purge', 'project', 'copyBack', 'copyReload', 'copyKeep', 'wordSave', 'wordAuto', 'writeBack', 'saveAsWord'].map((v) => `work.files.${v}`))
/** Whether an operation id is in the journal already (`runOp` then answers it, and checks it is the same change). */
const journalled = (db: DatabaseSync, op: string, workspaceId: string, verb: FileVerb): boolean => !!db.prepare(`SELECT 1 FROM work_files_ops WHERE id = ? AND workspace_id = ? AND verb = ?`).get(op, workspaceId, verb)
/** How many rows each of Home's lists shows. */
const HOME_MOST = 12


/**
 * LifeOS, From mail and a project's lens (places/lifeos.ts), in one place: the requests that name only such refs
 * are answered here, and the ones that mix them with the disk's (places, Trash, Home, a move, a delete, Put back)
 * add LifeOS's part to the disk's answer. Null: the disk's code answers alone.
 */
async function lifeosCase(ctx: WorkCtx, by: Caller, m: string, p: Record<string, unknown> & { workspaceId: string }, signal?: AbortSignal): Promise<Handled | null> {
  const refs = (p.refs as FileRef[] | undefined) ?? []
  const workspace = (): WorkspaceRow | null => (by.peer ? null : workspaceHere(ctx.db, p.workspaceId))
  switch (m) {
    case 'work.files.places': {
      // Each drive a folder he added lies on is looked at first, within a short deadline: one that is gone shows as not reachable, never holds the answer.
      if (await probeDrives(rootsOf(ctx.db).map((r) => r.folder))) forgetLibraries(ctx.db)
      const got = placesAnswer(ctx, by, p.workspaceId)
      const ws = workspace()
      if (ws) got.places.push(...(await lifeosPlaces(ctx, by, ws)))
      // A Google Drive per account of the workspace, after LifeOS.
      got.places.push(...(await drivePlaces(ctx, by, ws)))
      // His window hears of every place: a library it no longer lists takes its names with it.
      if (by.kind === 'local') forgetGonePlaces(ctx, p.workspaceId, got.places)
      return handled(got)
    }
    case 'work.files.list': {
      const at = p.at as FolderRef
      if (isLifeosRef(at)) {
        const got = await listLifeos(ctx, by, p as never)
        return handled({ ...got, entries: withMarks(filesState(ctx), p.workspaceId, got.entries) })
      }
      const got = await list(ctx, by, p as never, m, signal)
      feedListing(ctx, by, p.workspaceId, at, got)
      const ws = workspace()
      // Trash lists LifeOS's own trash beside the folder's, each put back by its own place.
      if (at.at === 'place' && at.id === PLACE.trash && ws && !p.foldersOnly && by.kind !== 'model') {
        const more = await lifeosTrash(ctx, ws)
        return handled({ ...got, entries: [...got.entries, ...more].sort((a, b) => (b.changed ?? 0) - (a.changed ?? 0)) })
      }
      // A workbook with an agent's suggestions waiting says how many, from the pillars' own tables (waiting.ts).
      return handled({ ...got, entries: withWaiting(ctx, await withProjects(ctx, ws, got.entries)) })
    }
    case 'work.files.home': {
      const ws = ownRows(ctx, by, p.workspaceId)
      const lens = async (id: string): Promise<FileEntry[]> => withWaiting(ctx, (await list(ctx, by, { workspaceId: p.workspaceId, at: { at: 'place', id } }, m, signal)).entries.slice(0, HOME_MOST))
      // Waiting on you: a thread's change held for his press (each row names its Outbox item) and this host's files with
      // suggestions waiting (waiting.ts), then LifeOS rows with suggestions waiting and mail's files not kept.
      const libraries = listedLibraries(ctx, by)
      // A row as it is now, where it lies: stated, never read (no "last saved by" from inside the file).
      const entryAt = async (ref: CanvasSource): Promise<FileEntry | null> => {
        const entry = await statOne(ctx, by, p.workspaceId, ref, m, signal, { who: false })
        if (!entry) return null
        const at = locate(ctx, by, p.workspaceId, ref, m)
        const where = whereOf(ctx, at, placeOf(at, libraries))
        return where ? { ...entry, where } : entry
      }
      // Whether the caller could name a ref of this host now: the door's own look, so a held act it could not reach is never told of.
      const mayName = (ref: FileRef): boolean => {
        try {
          locate(ctx, by, p.workspaceId, ref.at === 'place' ? placeRoot(ctx, by, p.workspaceId, ref.id) : ref, m)
          return true
        } catch {
          return false
        }
      }
      const here = await waitingFiles(ctx, by, p.workspaceId, HOME_MOST, entryAt, mayName)
      const keys = new Set(here.map((e) => e.key))
      const lifeos = (await waitingRows(ctx, by, ws, HOME_MOST)).filter((e) => !keys.has(e.key))
      const waiting = withMarks(filesState(ctx), p.workspaceId, [...here, ...lifeos].slice(0, HOME_MOST))
      return handled({ waiting, starred: await lens(PLACE.starred), recent: await lens(PLACE.recent) })
    }
    case 'work.files.make':
      return isLifeosRef(p.at as FolderRef) ? handled(await makeLifeos(ctx, by, p as never)) : null
    case 'work.files.upload':
      // LifeOS takes no file: the grammar's own sentence ("Nothing can be uploaded in LifeOS from here.").
      if (isLifeosRef(p.at as FolderRef)) admitWrite(by, { verb: 'upload', from: lifeosPlace(ctx, false) })
      return null
    case 'work.files.rename':
      return isLifeosRef(p.ref as FileRef) ? handled(await renameLifeos(ctx, by, p as never)) : null
    case 'work.files.move':
      return refs.some(isLifeosRef) || isLifeosRef(p.to as FolderRef) ? handled(await moveLifeos(ctx, by, p as never)) : null
    case 'work.files.copy': {
      if (refs.some((r) => r.at === 'mail')) {
        // Keep: a mail's file into a folder of the workspace.
        const folderOf = (to: FolderRef) => {
          const at = locate(ctx, by, p.workspaceId, to.at === 'place' ? placeRoot(ctx, by, p.workspaceId, to.id) : to, m)
          if (at.in !== 'folder') throw new Error("A mail's file is kept in your workspace's folder.")
          return { place: doorPlace(ctx, by, at).place, dir: at.path, root: at.root }
        }
        return handled(await keepMail(ctx, by, p as never, folderOf))
      }
      if (refs.some(isLifeosRef)) throw new Error('A LifeOS document lives in LifeOS. Export a copy instead.')
      if (isLifeosRef(p.to as FolderRef)) throw new Error('Only a LifeOS document lives in LifeOS. Make one there instead.')
      return null
    }
    case 'work.files.trash': {
      const mine = refs.filter(isLifeosRef)
      if (!mine.length) return null
      const lifeos = await trashLifeos(ctx, by, { ...(p as never as { workspaceId: string; op: string; asked?: boolean }), refs: mine, op: `${p.op as string}:lifeos` })
      const rest = refs.filter((r) => !isLifeosRef(r))
      if (!rest.length) return handled({ ...lifeos, op: p.op })
      const disk = (await filesHandle({ method: m, params: { ...p, refs: rest } } as unknown as ClientRequest, ctx, by, signal)) as { result: FileDone }
      const done = disk.result
      return handled({ ...done, refused: [...lifeos.refused, ...done.refused], trashed: [...(done.trashed ?? []), ...(lifeos.trashed ?? [])] })
    }
    case 'work.files.restore': {
      const ids = p.ids as string[]
      const mine = ids.filter((id) => id.startsWith('lifeos:'))
      if (!mine.length) return null
      const lifeos = await restoreLifeos(ctx, by, p.workspaceId, mine)
      const rest = ids.filter((id) => !id.startsWith('lifeos:'))
      const done: FileDone = rest.length ? await restoreRows(ctx, by, ownRows(ctx, by, p.workspaceId), rest, p.op as string) : { entries: [], refused: [], op: p.op as string }
      return handled({ ...done, entries: [...done.entries, ...lifeos.entries], refused: [...done.refused, ...lifeos.refused] })
    }
    case 'work.files.stat': {
      if (!(p.refs as FileRef[]).some(isLifeosRef)) return null
      const entries: (FileEntry | null)[] = []
      for (const ref of p.refs as FileRef[]) {
        if (isLifeosRef(ref)) entries.push(ref.at === 'lifeos' ? await statLifeos(ctx, by, p.workspaceId, ref) : null)
        else entries.push(await statOne(ctx, by, p.workspaceId, ref, m, signal))
      }
      const marked = new Map(withMarks(filesState(ctx), p.workspaceId, entries.filter((e): e is FileEntry => e !== null)).map((e) => [e.key, e]))
      return handled({ entries: entries.map((e) => (e ? marked.get(e.key)! : null)) })
    }
    case 'work.files.project': {
      // Add to a project…, Take out of this project: asked of the door as an edit of the file's place.
      const door = (ref: FileRef): DoorPlace => {
        const path = canvasSourcePath(ref as CanvasSource)
        if (path !== null && (ref as { host: string }).host === ctx.host) return doorPlace(ctx, by, locate(ctx, by, p.workspaceId, ref, m)).place
        // A file on another host, or a Google or Microsoft file by its address: a place others may open.
        return { id: 'elsewhere', kind: 'drive', name: 'that place', host: '', env: ctx.host, shared: true, can: ['edit'], state: { state: 'ok' } }
      }
      const name = (ref: CanvasSource): string => (ref.at === 'microsoft' ? ref.name : (canvasSourcePath(ref)?.split(/[\\/]/).pop() ?? 'File'))
      return handled(await setProject(ctx, by, p as never, door, name))
    }
  }
  return null
}

export async function filesHandle(req: ClientRequest, ctx: WorkCtx, by: Caller, signal?: AbortSignal): Promise<Handled> {
  const m = req.method
  if (!m.startsWith('work.files.')) return NOT_HANDLED
  const p = ((req as { params?: unknown }).params ?? {}) as Record<string, unknown> & { workspaceId: string }
  if (by.kind === 'model' && CHANGES.has(m)) {
    // The fence's own sentence first: a thread of another workspace is told that.
    admitCaller(ctx, by, p.workspaceId)
    throw new Error(THREADS_BY_TOOLS)
  }
  // A Drive ref is checked against the workspace's Google accounts: they are read (or kept) before it is located.
  if (m !== 'work.files.places' && namesDrive(p)) {
    admitCaller(ctx, by, p.workspaceId)
    await driveAccounts(ctx, workspaceHere(ctx.db, p.workspaceId)?.sector ?? null)
  }
  const lifeos = await lifeosCase(ctx, by, m, p, signal)
  if (lifeos) return lifeos
  switch (m) {
    case 'work.files.names':
      return handled(namesAnswer(ctx, by, p as never, filesState(ctx), m))
    case 'work.files.search':
      return handled(await searchFiles(ctx, by, p as never, filesState(ctx).marks, m, signal))
    case 'work.files.searches':
      ownRows(ctx, by, p.workspaceId)
      return handled(savedSearches(ctx, p.workspaceId))
    case 'work.files.saveSearch':
      ownRows(ctx, by, p.workspaceId)
      return handled(saveSearch(ctx, p as never))
    case 'work.files.dropSearch':
      ownRows(ctx, by, p.workspaceId)
      dropSearch(ctx, p.workspaceId, p.id as string)
      return handled(null)
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
      if ((path !== null && (ref as { host: string }).host === ctx.host) || ref.at === 'google') locate(ctx, by, p.workspaceId, ref, m)
      const threads = path !== null ? threadsHolding(ctx, p.workspaceId, { at: 'file', host: (ref as { host: string }).host, path }, (one) => reaches(ctx, by, one)) : sameSource(ctx, p.workspaceId, ref)
      return handled({ threads })
    }
    case 'work.files.fetch': {
      const at = locate(ctx, by, p.workspaceId, p.ref as CanvasSource, m)
      if (at.in === 'place' || at.in === 'drive') throw new Error('A place is listed, not fetched.')
      if (at.in === 'library') {
        if (at.library.vm) await vmFetch(at.library.id, at.path, signal)
        else await fetchFile(at.library.id, at.path, signal)
      }
      return handled({ entry: await statOne(ctx, by, p.workspaceId, p.ref as CanvasSource, m, signal) })
    }
    case 'work.files.read': {
      const copy = p.itemId ? await readCopy(ctx, by, p as never) : null
      if (copy) return handled(copy)
      const at = locate(ctx, by, p.workspaceId, p.ref as CanvasSource, m)
      let bytes: FileBytes
      if (at.in === 'library' && at.library.vm) {
        // A file in the VM, read through its helper for his own window, with the version a save there checks; never one kept in the cloud (that would download it).
        if (by.kind !== 'local') throw new Error(LIBRARY_BYTES)
        const e = await vmStat(at.library.id, at.path, signal)
        if (e.kind === 'folder') throw new Error('That is not a file.')
        if (!e.local) throw new Error('This file is kept in the cloud. Download it first.')
        bytes = await vmReadVersioned(at.path, p.offset as number, Math.min(p.length as number, READ_MAX), p.version as string | undefined, signal)
      } else {
        const { roots, path } = bytesFence(ctx, by, at)
        bytes = await readFile({ roots }, path, p.offset as number, p.length as number, p.version as string | undefined)
      }
      // Whether a save would be taken is asked of the door now, so an editor never offers what the host will refuse.
      let locked: string | undefined
      try {
        if (by.kind === 'model') locked = THREADS_BY_TOOLS
        else if (admitChange(ctx, by, 'edit', { workspaceId: p.workspaceId, refs: [p.ref as CanvasSource] }, m) === 'hold') locked = HELD_NOT_YET
      } catch (err) {
        locked = err instanceof Error ? err.message : String(err)
      }
      return handled({ ...bytes, ...(locked ? { locked } : {}) })
    }
    // Pictures and an archive's listing (preview.ts, zipdir.ts): each locates its file for the caller itself.
    case 'work.files.preview':
      return handled(await previewOf(ctx, by, p as never, m, signal))
    case 'work.files.thumbs':
      return handled(await thumbsOf(ctx, by, p as never, m, signal))
    case 'work.files.archive': {
      const { roots, path } = bytesFence(ctx, by, locate(ctx, by, p.workspaceId, p.ref as CanvasSource, m))
      return handled(await archiveListing({ roots }, path))
    }
    case 'work.files.write':
      return handled(await write(ctx, by, p as never, m, signal))
    case 'work.files.tabs':
      ownRows(ctx, by, p.workspaceId)
      return handled(tabsFor(ctx, by, p.workspaceId))
    case 'work.files.open':
      return handled(await open(ctx, by, p as never, m, signal))
    case 'work.files.tabOpen': {
      ownRows(ctx, by, p.workspaceId)
      admitPage(ctx, by, p.workspaceId, p.page as FilePage, m)
      const made = filesState(ctx).tabs.tabOpen(p.workspaceId, p.page as FilePage, p.after as string | undefined, p.first === true)
      return handled({ ...tabsFor(ctx, by, p.workspaceId), tabId: made.tabId })
    }
    case 'work.files.tabClose': {
      const workspace = ownRows(ctx, by, p.workspaceId)
      const tab = p.side === true ? undefined : filesState(ctx).tabs.list(p.workspaceId).tabs.find((t) => t.id === p.tabId)
      // Discard drops his changes to a file others can open before they reach it: his press alone, as his Reload's.
      if (p.discard === true && tab?.copyOf && copyRecord(ctx, p.workspaceId, tab.copyOf.host, tab.copyOf.path) && !pressesFor(by)) throw new Error(NEEDS_PRESS)
      // A copy whose changes have not reached its file is kept, and sent, until they have; Discard drops them.
      if (p.side !== true) copyClosing(ctx, p.workspaceId, tab, p.discard === true)
      // The last tab closed becomes the workspace's folder: the place is never left with none.
      filesState(ctx).tabs.tabClose(p.workspaceId, p.tabId as string, { at: { at: 'place', id: PLACE.folder }, name: folderName(workspace, workspace.path, workspace.path) }, p.side === true)
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
    // A copy saves back (copies.ts): his window's three presses, and the file's own host's verb.
    case 'work.files.copyBack':
      ownRows(ctx, by, p.workspaceId)
      return handled(await copyBack(ctx, by, p as never))
    case 'work.files.copyReload':
      ownRows(ctx, by, p.workspaceId)
      await copyReload(ctx, by, p as never, signal)
      return handled(tabsFor(ctx, by, p.workspaceId))
    case 'work.files.wordSave':
      return handled(await wordSave(ctx, by, p as never))
    case 'work.files.wordAuto':
      wordAuto(ctx, by, p as never)
      return handled(tabsFor(ctx, by, p.workspaceId))
    case 'work.files.copyKeep':
      ownRows(ctx, by, p.workspaceId)
      await copyKeep(ctx, by, p as never)
      return handled(tabsFor(ctx, by, p.workspaceId))
    case 'work.files.writeBack':
      return handled(await writeBack(ctx, by, p as never, m))
    case 'work.files.saveAsWord':
      return handled(await saveAsWord(ctx, by, p as never, m))
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
    // The verbs: each passes the door first, so what the door refuses is refused before anything is read or written.
    case 'work.files.make': {
      const ask = { ...(p as unknown as Parameters<typeof makeVerb>[2]), at: makeFolderRef(ctx, by, p.at as FolderRef) }
      const again = replayed(ctx, by, 'make', ask as never)
      if (again) return handled(await again)
      if (namesDrive(ask)) {
        held((await admitDrive(ctx, by, 'make', { ...ask, refs: [ask.at] }, m)).verdict)
        return handled(await driveMake(ctx, by, ask, m))
      }
      held(admitChange(ctx, by, 'make', { ...ask, refs: [ask.at] }, m))
      return handled(await makeVerb(ctx, by, ask, m))
    }
    case 'work.files.upload': {
      const to = p.at as FolderRef
      // The door, at begin and again at commit, for this same caller.
      const into = (): Located => {
        admitChange(ctx, by, 'upload', { ...p, refs: [to] } as never, m)
        const at = locate(ctx, by, p.workspaceId, to.at === 'place' ? placeRoot(ctx, by, p.workspaceId, to.id) : to, m)
        // Save to TempCode keeps a file in a place of his own: a workspace kept in OneDrive is none, whoever presses.
        if (p.own === true && locatedShared(ctx, at)) throw new Error(OWN_ONLY)
        return at
      }
      return handled(await beginUpload(ctx, by, p as never, { into, entryOf: (path) => statOne(ctx, by, p.workspaceId, { at: 'file', host: ctx.host, path }, m) }))
    }
    case 'work.files.rename': {
      const again = replayed(ctx, by, 'rename', p as never)
      if (again) return handled(await again)
      if (namesDrive(p)) {
        held((await admitDrive(ctx, by, 'rename', { ...p, refs: [p.ref as FileRef] } as never, m)).verdict)
        return handled(await driveRename(ctx, by, p as never, m))
      }
      held(admitChange(ctx, by, 'rename', { ...p, refs: [p.ref as FileRef] } as never, m))
      return handled(await renameVerb(ctx, by, p as never, m))
    }
    case 'work.files.move':
    case 'work.files.copy': {
      const verb = m === 'work.files.move' ? 'move' : 'copy'
      const again = replayed(ctx, by, verb, p as never)
      if (again) return handled(await again)
      if (namesDrive(p)) {
        held((await admitDrive(ctx, by, verb, p as never, m)).verdict)
        if (verb === 'copy') throw new Error(DRIVE_APART)
        return handled(await driveMove(ctx, by, p as never, m))
      }
      held(admitChange(ctx, by, verb, p as never, m))
      return handled(await (verb === 'move' ? moveVerb : copyVerb)(ctx, by, p as never, m))
    }
    case 'work.files.trash':
      // The door for every ref before anything moves: one it refuses refuses the whole change. A retry of a change
      // already journalled answers what it did (its files are gone by then), held to the same workspace, verb and refs.
      if (namesDrive(p)) {
        if (!(p.refs as FileRef[]).every((ref) => namesDrive({ ref }))) throw new Error(DRIVE_APART)
        if (!journalled(ctx.db, p.op as string, p.workspaceId, 'trash')) held((await admitDrive(ctx, by, 'trash', p as never, m)).verdict)
        return handled(await driveTrash(ctx, by, ownRows(ctx, by, p.workspaceId), p.refs as FileRef[], p.op as string))
      }
      if (!journalled(ctx.db, p.op as string, p.workspaceId, 'trash')) held(admitChange(ctx, by, 'trash', p as never, m))
      // A library's delete may come for a workspace another host keeps (his window asks the file's own host): its row is kept here.
      binRows(ctx, by, p.workspaceId, { peer: true })
      return handled(await trashFiles(ctx, by, p.workspaceId, p.refs as FileRef[], p.op as string))
    case 'work.files.restore': {
      const workspace = binRows(ctx, by, p.workspaceId)
      if (by.kind === 'remote' && !by.caps.includes('operate')) throw new Error(MAY_NOT('put files back'))
      // Put back changes a place others can open as a delete there does: his press alone, for the whole batch.
      if (!pressesFor(by) && (await restoresShared(ctx, p.workspaceId, p.ids as string[]))) throw new Error(NEEDS_PRESS)
      return handled(await restoreRows(ctx, by, workspace, p.ids as string[], p.op as string))
    }
    case 'work.files.purge': {
      const workspace = ownRows(ctx, by, p.workspaceId)
      if (by.kind === 'remote' && !by.caps.includes('approve')) throw new Error(MAY_NOT('empty Trash'))
      return handled(await purgeRows(ctx, by, workspace, p.ids as string[] | undefined))
    }
  }
  return NOT_HANDLED
}

/**
 * Whether Put back of these Trash rows would put something back where others can open it: a row of a library (it lies
 * in that computer's own bin), one whose folder others can open by its real path (a workspace kept in OneDrive), and
 * a Drive file Drive says is shared, or of whose sharing it says nothing now.
 */
async function restoresShared(ctx: WorkCtx, workspaceId: string, ids: readonly string[]): Promise<boolean> {
  const get = ctx.db.prepare(`SELECT ref, provider FROM work_files_trash WHERE id = ? AND workspace_id = ? AND state = 'held'`)
  for (const id of ids) {
    const row = get.get(id, workspaceId) as { ref: string; provider: string | null } | undefined
    if (!row) continue
    if (row.provider === 'drive') {
      const at = JSON.parse(row.ref) as { at: 'drive'; account: string; folderId: string } | { at: 'google'; account: string; fileId: string }
      const shared = await driveOf(ctx, at.account)
        .facts(at.at === 'drive' ? at.folderId : at.fileId)
        .then((item) => itemShared(ctx, at.account, item))
        .catch(() => true)
      if (shared) return true
    } else if (row.provider || sharedOf(ctx, JSON.parse(row.ref) as CanvasSource)) return true
  }
  return false
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
    // An item shown at a tab's side: the tab stays, and shows its own file alone.
    else state.tabs.sideGone(itemId)
  }
}

/** A deleted workspace: its tabs, its marks and what Trash, the journal and Go to kept of it go. */
export function removeWorkspace(ctx: Pick<WorkCtx, 'db' | 'push' | 'log' | 'canvas'>, workspaceId: string): void {
  const state = filesState(ctx)
  state.tabs.removeWorkspace(workspaceId)
  state.marks.removeWorkspace(workspaceId)
  for (const table of ['work_files_trash', 'work_files_ops', 'work_files_names', 'work_files_kept', 'work_files_copies']) ctx.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId)
}
