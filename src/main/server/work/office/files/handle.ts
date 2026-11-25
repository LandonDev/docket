import { execFile } from 'node:child_process'
import { createHash, randomUUID, type Hash } from 'node:crypto'
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { FILES_PIECE_MAX, teamsAppOf, teamsKindOf, type TeamsEntry, type TeamsLibrary } from '@shared/contract-work-office'
import { canvasSourcePath, filesPaneOf, filesPaneWorkspace, handled, NOT_HANDLED, type CanvasItem, type CanvasSource, type Handled } from '@shared/work'
import type { ClientRequest } from '@shared/contract'
import { FenceError } from '../../../remote/fence'
import { macBridgeLandingRoot } from '../../../macBridgeLanding'
import { forgetLibraries } from '../../files/places/libraries'
import type { Caller, WorkCtx } from '../../modules'
import { copyKeptIn, dropCopyRecords } from '../../files/copyKept'
import { importFolderOf } from '../../files/imports'
import { workspaceHere } from '../../files/policy'
import { readPiece, readWhole } from '../../files/save'
import type { OfficeCarrier } from '../carrier'
import { BYTES_MAX, copyAllowed, entryOf, fetchFile, foldersPlace, librariesOf, libraryOf, listFolder, offFolders, readText, rootsOf, searchLibraries, SEARCH_MAX, setCopyAllowed, setRoots } from './library'
import { driveOf } from './reach'
import { folderReader } from '../../files/places/winDir'
import { zipEntries } from './zip'
import { NOT_SET_UP } from '../../winvm/keeper'
import { isGuestPath, lastReadFailure, missingLibraries, readVmBehind, refreshVm, resetSyncAsks, setWantedLibraries, storedStatus, vmBytes, vmFetch, vmLibraries, vmLibraryOf, vmList, vmOfficeStatus, vmOpen, vmPlace, vmSearch, vmStat, vmText, wantedLibraries } from '../vm/files'
import { vmAllowed, vmKey, vmState } from '../vm/office'
import { vmCall } from '../vm/link'
import { followSignIn, numberLine, OFFICE_WORD_LINE, oneWatchAtATime, readNumber, SIGN_IN_LINES, walkOfficeSignIn, walkSignIn, type SignInReached } from '../vm/signin'
import type { TeamsLibrariesAnswer, TeamsPlace, VmSignInAnswer, VmSyncLibrary } from '@shared/contract-work-office'

/**
 * The Teams files' wire (`work.office.files*`, docs/agents/work-teams-files.md). Every method that names a
 * file takes it as a `{at: 'file'}` source on this host, and every one passes the same fence: the
 * file's real path lies in a library this host lists (`libraryOf`). A remote key must also be able to
 * name it itself (the listener's fence); a call from another host of his, over the host link, is held
 * to the libraries alone, under this host's bridge policy for it.
 */

const NOT_TEAMS = 'That is not in a Teams folder on this host (Settings → Work → Teams files).'
const NOT_VM = 'This workspace may not use the Windows VM (its Work settings: Computer use on the Windows VM).'
const ONLY_OWNER = 'Only the owner signs in on the Windows VM or chooses what it syncs.'

/** What `filesHandle` needs of the pillar besides the files: the carrier of this host, the VM's Office, and his address where Outlook here knows it. */
export interface FilesDeps {
  carrier(): OfficeCarrier | null
  /** opens an Office file in its app in the Windows VM; absent where the pillar has no VM carrier (a test) */
  vmOpenOffice?: (app: 'excel' | 'word' | 'powerpoint', path: string) => Promise<void>
  ownAccount?: () => string | null
}

/** A test's short waits for the sign-in walk; with them set the walk sleeps no time and nothing follows it. */
let pace: { first: number; page: number; list: number } | null = null
export const setSignInPace = (waits: { first: number; page: number; list: number } | null): void => void (pace = waits)

/** One watch of a sign-in at a time (vm/signin.ts `followSignIn`, `oneWatchAtATime`); none under a test's pace. */
const watch = oneWatchAtATime()
function follow(ctx: WorkCtx, account: () => Promise<string | null>, what: string, afterSignIn?: () => Promise<void>): void {
  if (pace) return
  watch(() =>
    followSignIn({ call: vmCall, account, afterSignIn })
      .then((end) => ctx.log(`office: the Windows VM's ${what} sign-in ${end === 'signed-in' ? 'went through' : 'was not finished in six minutes'}`))
      .catch((err) => ctx.log(`office: following the sign-in failed: ${err instanceof Error ? err.message : String(err)}`))
  )
}

/** Where a sign-in walk stopped, in words; at the number, the number itself when the page names it. */
async function signInLine(reached: SignInReached): Promise<{ line: string; number?: string }> {
  const number = reached === 'number' ? await readNumber({ call: vmCall }) : null
  return number ? { line: numberLine(number), number } : { line: SIGN_IN_LINES[reached] }
}

/** How fresh the VM's kept status must be for a list to use it without reading an awake machine again. */
const VM_FRESH_MS = 15_000

/**
 * The VM's libraries and its place, for a list: always what was kept, at once. Behind the answer an
 * awake machine whose status is stale (or whose last read failed) is read again, and one never read
 * is woken for its first read (`readVmBehind`: one read at a time, a change pushed). A person's window
 * never waits on it; a thread, or another host asking for one, has no screen to repaint and waits for
 * the first read alone.
 */
async function vmListing(ctx: WorkCtx, by: Caller): Promise<{ libraries: TeamsLibrary[]; place: TeamsPlace | null }> {
  const state = vmState()
  if (!state || state.cannot || state.state === 'none' || state.state === 'setting-up') return { libraries: [], place: vmPlace(ctx.db, state) }
  const stored = storedStatus(ctx.db)
  const stale = !!stored && state.state === 'awake' && (lastReadFailure(ctx.db) !== null || Date.now() - stored.at > VM_FRESH_MS)
  if (!stored || stale) {
    const read = readVmBehind(ctx, { wake: !stored })
    if (!stored && (by.kind === 'model' || (by.kind === 'remote' && !!by.peer))) await read
  }
  return { libraries: vmLibraries(ctx.db, ctx.host), place: vmPlace(ctx.db, state) }
}

/** Whether the caller may use what is in the VM: a thread only where its workspace turns the VM on; his own windows always. */
const vmFor = (ctx: WorkCtx, by: Caller): boolean => {
  if (by.kind !== 'model') return true
  // a host that keeps no VM has nothing to ask a thread's workspace about
  if (!vmState()) return false
  const scope = by.sessionId ? ctx.scopeOf(by.sessionId) : null
  return !!scope && vmAllowed(ctx, scope)
}

async function librariesAnswer(ctx: WorkCtx, by: Caller, cached = false): Promise<TeamsLibrariesAnswer> {
  const own = librariesOf(ctx.db, ctx.host)
  const vm = !vmFor(ctx, by)
    ? { libraries: [], place: null }
    : cached
      ? { libraries: cachedVmLibraries(ctx), place: vmPlace(ctx.db, vmState()) }
      : await vmListing(ctx, by)
  const folders = foldersPlace(ctx.host)
  // A folder he added himself is a library too: the place then has something to show.
  const places = [...(folders ? [own.some((l) => l.kind !== 'mine') && folders.state !== 'ok' ? { ...folders, state: 'ok' as const } : folders] : []), ...(vm.place ? [vm.place] : [])]
  // A folder on a mapped drive read row by row (no folder reader here) says so, so a slow list is never a mystery.
  const reader = own.some((l) => driveOf(l.path)) ? folderReader() : null
  const mine = reader?.mode === 'row by row' ? own.map((l) => (driveOf(l.path) ? { ...l, slow: reader.words } : l)) : own
  return { host: ctx.host, libraries: [...mine, ...vm.libraries], roots: rootsOf(ctx.db), off: offFolders(ctx.db), places }
}

/** Opens a file in its own app here: the Office carrier for an Office file, else the system's opener. A test hands its own. */
let opener = (path: string): Promise<void> =>
  new Promise((done, fail) => {
    const [cmd, args] = process.platform === 'darwin' ? ['/usr/bin/open', [path]] : process.platform === 'win32' ? ['explorer.exe', [path]] : [null, []]
    if (!cmd) return fail(new Error('A file opens in its app on a Mac or a Windows PC.'))
    execFile(cmd, args as string[], (err) => (err && process.platform !== 'win32' ? fail(err) : done()))
  })
export const setFilesOpener = (fn: (path: string) => Promise<void>): void => void (opener = fn)

/** The file a source names here, inside a library, or a refusal. */
export function admitted(ctx: WorkCtx, by: Caller, method: string, source: CanvasSource): { library: TeamsLibrary; path: string } {
  const path = source.at === 'file' ? source.path : source.at === 'microsoft' && source.ref.kind === 'path' ? source.ref.path : null
  if (path === null) throw new Error('A Teams file is named by its path on its host.')
  if (source.at !== 'thread' && 'host' in source && source.host !== ctx.host) throw new Error('That file is on another host: ask that host.')
  if (isGuestPath(path) && process.platform !== 'win32') {
    // A file in the Windows VM this host keeps: no path of this host's disk, so the listener's fence has nothing to
    // say of it. It must lie in a library OneDrive syncs there, and a thread needs its workspace's switch.
    if (!vmFor(ctx, by)) throw new Error(NOT_VM)
    const inVm = vmLibraryOf(vmLibraries(ctx.db, ctx.host), path)
    if (!inVm) throw new Error(NOT_TEAMS)
    return inVm
  }
  const found = libraryOf(librariesOf(ctx.db, ctx.host), path)
  if (!found) throw new Error(NOT_TEAMS)
  if (by.kind === 'remote' && !by.peer && !ctx.reaches(by, found.path)) throw new FenceError(method)
  return found
}

/** Opens an entry in its app on this host. */
/**
 * The desktop searches under way, by who asked and their words: a window that typed on names the words it replaces,
 * and that walk stops at once (the library walk between folders, the VM's ask at its door).
 */
const deskSearches = new Map<string, Set<{ query: string; controller: AbortController }>>()
const deskCaller = (by: Caller): string => (by.kind === 'model' ? `model:${by.sessionId ?? ''}` : by.peer ? `peer:${by.peer}` : by.kind)
export function deskSearchStarts(by: Caller, query: string, replaces: string | undefined, signal?: AbortSignal): { signal: AbortSignal; done(): void } {
  const who = deskCaller(by)
  const mine = deskSearches.get(who) ?? new Set()
  deskSearches.set(who, mine)
  if (replaces !== undefined) for (const run of mine) if (run.query === replaces && replaces !== query) run.controller.abort()
  const run = { query, controller: new AbortController() }
  mine.add(run)
  const off = (): void => run.controller.abort()
  signal?.addEventListener('abort', off, { once: true })
  if (signal?.aborted) off()
  return {
    signal: run.controller.signal,
    done: () => {
      signal?.removeEventListener('abort', off)
      mine.delete(run)
      if (!mine.size) deskSearches.delete(who)
    }
  }
}

export async function openInApp(carrier: OfficeCarrier | null, entry: Pick<TeamsEntry, 'name' | 'path'>): Promise<void> {
  const app = teamsAppOf(teamsKindOf(entry.name), entry.name)
  // Outlook on the web and the add-in alone open no file on this disk.
  if (app && carrier && carrier.kind !== 'owa' && carrier.kind !== 'addin') return carrier.open(app, { kind: 'path', path: entry.path })
  return opener(entry.path)
}

/** Where a copy he allowed lands: the owner's own corner of this host's attachments (a root a remote key reaches), a thread's or a Files pane's. */
const copiesRoot = (dataDir: string): string => join(macBridgeLandingRoot(dataDir), 'teams-files')
const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_')
export const copyDirOf = (dataDir: string, sessionId: string): string => join(copiesRoot(dataDir), safe(sessionId))

/**
 * Drops the copies of the owners given, or of every thread of a workspace and its Files pane. `keep`: folders of a
 * Files pane's copies whose changes have not reached their file (files/copyKept.ts `dropCopyRecords`), which stay.
 */
export function dropCopies(ctx: Pick<WorkCtx, 'dataDir' | 'scopeOf'>, which: { sessions: string[] } | { workspaceId: string }, keep: ReadonlySet<string> = new Set()): void {
  const root = copiesRoot(ctx.dataDir)
  if (!existsSync(root)) return
  const dirs = 'sessions' in which ? which.sessions.map(safe) : readdirSync(root).filter((dir) => dir === safe(filesPaneOf(which.workspaceId)) || ctx.scopeOf(dir)?.workspaceId === which.workspaceId)
  for (const dir of dirs) {
    const at = join(root, dir)
    const kept = [...keep].filter((k) => dirname(k) === at || dirname(k) === realOr(at))
    if (!kept.length) {
      rmSync(at, { recursive: true, force: true })
      continue
    }
    // A pane whose copies wait: each other copy's folder goes, those stay.
    for (const name of readdirSync(at)) if (!kept.some((k) => basename(k) === name)) rmSync(join(at, name), { recursive: true, force: true })
  }
}

/**
 * Drops the copy behind each closed Files tab: the per-source folder in its pane's copies that holds the item's file.
 * A folder another open tab still shows stays: the document an import made of the copy lies beside it, and its tab
 * took the copy's place.
 */
export function dropItemCopies(ctx: Pick<WorkCtx, 'dataDir' | 'canvas' | 'db'>, items: readonly CanvasItem[]): void {
  for (const item of items) {
    if (filesPaneWorkspace(item.sessionId) === null || item.source.at !== 'file') continue
    const dir = dirname(item.source.path)
    if (dirname(dir) !== copyDirOf(ctx.dataDir, item.sessionId)) continue
    // A copy whose changes have not reached its file yet stays until they do (files/copies.ts drops it then).
    if (copyKeptIn(ctx.db, dir)) continue
    const shown = ctx.canvas.forSession(item.sessionId).some((open) => open.id !== item.id && open.source.at === 'file' && dirname(open.source.path) === dir)
    if (!shown) rmSync(dir, { recursive: true, force: true })
  }
}

/** The folder in an owner's copies that holds the copy of one source file. */
export const copyFolderOf = (dataDir: string, sessionId: string, source: { host: string; path: string }): string =>
  join(copyDirOf(dataDir, sessionId), createHash('sha1').update(`${source.host}\u0000${source.path}`).digest('hex').slice(0, 12))

/** A Word, OpenDocument, RTF, markdown or text file: what the document kind imports into a `.tcdoc` beside it. */
const IMPORTED = /\.(docx|doc|odt|rtf|md|markdown|txt)$/i
/** The importer's own spelling of a name (formats/importer.ts `safeName`), kept here so office loads none of formats. */
const importName = (name: string): string =>
  name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'Document'
const realFolder = (path: string): string => {
  try {
    return realpathSync(dirname(path))
  } catch {
    return dirname(path)
  }
}

const realOr = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * `Name.tcdoc` or `Name 2.tcdoc` in the folder of `Name.docx`, or in the folder under this host's data the importer
 * keeps for a file others can open (files/imports.ts): the document an import made of it (formats/importer.ts `freePath`),
 * and only one whose own record says so: the importer writes the file it came from into the document's sidecar
 * (`source.name`). A document of his that merely shares the name is another file, and Ask never picks its thread.
 */
const madeOf = (ctx: Pick<WorkCtx, 'dataDir' | 'host'>, path: string, file: string): boolean => {
  if (extname(path) !== '.tcdoc' || !IMPORTED.test(file)) return false
  const imports = importFolderOf(ctx.dataDir, { host: ctx.host, path: realOr(file) })
  if (realFolder(path) !== realFolder(file) && dirname(path) !== imports) return false
  const stem = importName(basename(file, extname(file)))
  const name = basename(path, '.tcdoc')
  if (name !== stem && !(name.startsWith(`${stem} `) && /^ \d+$/.test(name.slice(stem.length)))) return false
  return importedFrom(path) === basename(file)
}

/** The name of the file a `.tcdoc` was imported from, as its sidecar records it; null for one made any other way. */
function importedFrom(path: string): string | null {
  try {
    const raw = zipEntries(path, ['sidecar.json'], 4 * 1024 * 1024).get('sidecar.json')
    const name = raw ? (JSON.parse(raw) as { source?: { name?: unknown } }).source?.name : null
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}

/**
 * The threads of a Work workspace here whose open items show a Teams file, newest first, each with its item: the file
 * itself (in place, or its Office app's), the copy he allowed in the thread's own folder, or the `.tcdoc` a Word file
 * became beside either. The Files view reopens the first of them that is not archived instead of making another.
 * `reaches` is the caller's own reach of a path of this host (a remote key's roots).
 */
export function threadsHolding(ctx: Pick<WorkCtx, 'canvas' | 'dataDir' | 'host'>, workspaceId: string, file: CanvasSource, reaches: (path: string) => boolean = () => true): { sessionId: string; itemId: string; source: CanvasSource }[] {
  if (file.at !== 'file') return []
  const out = new Map<string, { itemId: string; source: CanvasSource }>()
  for (const item of ctx.canvas.forWorkspace(workspaceId, { open: true })) {
    if (out.has(item.sessionId)) continue
    const s = item.source
    const path = canvasSourcePath(s)
    if (path === null || (s.at !== 'file' && s.at !== 'microsoft')) continue
    // A document an import made is found by a path this host stored: one the caller could not name itself is never looked at for it.
    const here = s.host === file.host && (path === file.path || (s.host === ctx.host && reaches(path) && madeOf(ctx, path, file.path)))
    const copy = s.host === ctx.host && s.at === 'file' && dirname(path) === copyFolderOf(ctx.dataDir, item.sessionId, file)
    if (here || copy) out.set(item.sessionId, { itemId: item.id, source: s })
  }
  return [...out].map(([sessionId, held]) => ({ sessionId, ...held }))
}

/** The VM's existing mounts, without reading or waking it. */
export function cachedVmLibraries(ctx: Pick<WorkCtx, 'db' | 'host'>): TeamsLibrary[] {
  const state = vmState()
  return state && !state.cannot && state.state !== 'none' && state.state !== 'setting-up' ? vmLibraries(ctx.db, ctx.host) : []
}

/** Whether this host's Windows VM is set up: a Files pane is his own window, which needs nothing more of it. */
const vmSetUp = (): boolean => {
  const s = vmState()
  return !!s && !s.cannot && s.state !== 'none'
}

/** What the copies did, for the tests to count: each staging file made, and each commit. */
export const copyCounts = { commits: 0, staged: 0 }

/**
 * A copy being written into its folder, never through a link: the owner's folder and the source's folder must be
 * folders, and the bytes go into a staging file of the copy's folder made new (never one already there, never through
 * a link), hashed as they go in, then put in the copy's place in one rename once every piece is in and its version
 * held. A copy that fails, is cancelled or meets a file that changed leaves nothing behind, and the copy that was there
 * before (a tab's earlier copy) stays as it was until the new one is whole.
 */
class Staging {
  private fd: number
  private hash: Hash = createHash('sha256')
  private readonly tmp: string
  /** the bytes as they went in: the body hash reads them, never the disk */
  parts: Buffer[] = []
  size = 0
  constructor(dataDir: string, sessionId: string, dir: string, readonly path: string) {
    for (const folder of [copyDirOf(dataDir, sessionId), dir]) if (!lstatSync(folder).isDirectory()) throw new Error("The copy's folder is not a folder: nothing was copied.")
    // A link where the copy would land is refused, as it always was: nothing is read for it.
    let there: ReturnType<typeof lstatSync> | null = null
    try {
      there = lstatSync(path)
    } catch {
      there = null
    }
    if (there?.isSymbolicLink()) throw new Error("The copy's place is a link: nothing was copied.")
    this.tmp = `${path}.part-${randomUUID().slice(0, 8)}`
    try {
      this.fd = openSync(this.tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOOP' || (err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error("The copy's place is a link: nothing was copied.")
      throw err
    }
    copyCounts.staged++
  }
  write(buf: Buffer): void {
    let at = 0
    while (at < buf.length) at += writeSync(this.fd, buf, at, buf.length - at, this.size + at)
    this.hash.update(buf)
    this.parts.push(buf)
    this.size += buf.length
  }
  /** The SHA-256 of what came in so far, the staging hash left running. */
  sha256(): string {
    return this.hash.copy().digest('hex')
  }
  /** The file changed while it was read: what came in goes, and the read starts again from its first byte. */
  restart(): void {
    closeSync(this.fd)
    this.fd = openSync(this.tmp, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
    this.hash = createHash('sha256')
    this.parts = []
    this.size = 0
  }
  /** Every piece is in: the copy takes its place, and its SHA-256 is the one hashed on the way in. */
  commit(): { sha256: string; bytes: Buffer } {
    closeSync(this.fd)
    this.fd = -1
    // A rename puts the staging file in the path's place, a link there included: the link is replaced, never followed.
    renameSync(this.tmp, this.path)
    copyCounts.commits++
    return { sha256: this.hash.digest('hex'), bytes: Buffer.concat(this.parts, this.size) }
  }
  abort(): void {
    if (this.fd >= 0) closeSync(this.fd)
    this.fd = -1
    try {
      unlinkSync(this.tmp)
    } catch {
      // already gone
    }
  }
}

/**
 * Copies a file from another host, or out of this host's Windows VM, into the owner's attachments here, when its
 * workspace allows it. The owner is a Work thread, or the Files pane of a Work workspace here (a file opened in a tab).
 * One pass: each piece streams into the copy's staging file and its hash as it lands, the file's version is read with
 * the first piece and held to the last, and the copy is handed out with its SHA-256 and the bytes in hand, so nothing
 * reads it back.
 */
export async function copyIn(ctx: WorkCtx, sessionId: string, source: CanvasSource, signal?: AbortSignal, progress?: (done: number, total: number) => void): Promise<{ source: CanvasSource; entry: TeamsEntry; version?: string; sha256: string; bytes: Buffer }> {
  const pane = filesPaneWorkspace(sessionId)
  const scope = pane === null ? ctx.scopeOf(sessionId) : null
  if (pane === null && !scope) throw new Error(`thread ${sessionId} is not a Work thread here`)
  if (pane !== null && !workspaceHere(ctx.db, pane)) throw new Error('No such Work workspace on this host.')
  const workspaceId = pane ?? scope!.workspaceId
  if (!workspaceId || !copyAllowed(ctx.db, workspaceId)) throw new Error('This workspace keeps Teams files where they are: turn on Copy Teams files in its settings to open one here.')
  if (source.at !== 'file') throw new Error('A copy comes from a file on another host.')
  // One folder per source file, so two files of one name in one owner's copies never share a folder.
  const dir = copyFolderOf(ctx.dataDir, sessionId, source)
  let name: string
  let read: (into: Staging) => Promise<string | undefined>
  if (source.host === ctx.host) {
    // A file in this host's Windows VM comes out of the guest the same way: a snapshot in the thread's own folder.
    if (!isGuestPath(source.path)) throw new Error('A copy comes from a file on another host.')
    if (scope ? !vmAllowed(ctx, scope) : !vmSetUp()) throw new Error(NOT_VM)
    const inVm = vmLibraryOf(vmLibraries(ctx.db, ctx.host), source.path)
    if (!inVm) throw new Error(NOT_TEAMS)
    name = inVm.path.slice(inVm.path.lastIndexOf('\\') + 1)
    // A thread's copy is a snapshot with no version (it never saves back); a tab's names the version it read.
    read = pane === null ? async (into) => void into.write(await vmBytes(inVm.path, BYTES_MAX, signal)) : (into) => vmVersioned(inVm.path, into, signal, progress)
  } else {
    const far = await ctx.peer.call({ scope: scope ?? { sessionId, workspaceId }, signal }, source.host)
    const ask = (params: { offset: number; length: number }) => far.call('office', 'filesRead', { source, as: 'bytes', ...params }) as Promise<FarPiece>
    // The far host names the file: its first piece is asked before the staging file is made.
    const head = await ask({ offset: 0, length: FAR_FIRST })
    name = head.name
    read = (into) => farBytes(ask, into, progress, head)
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const staging = new Staging(ctx.dataDir, sessionId, dir, join(dir, basename(name)))
  try {
    const version = await read(staging)
    if (signal?.aborted) throw new Error('cancelled')
    const { sha256, bytes } = staging.commit()
    return { source: { at: 'file', host: ctx.host, path: staging.path }, entry: entryOf('', staging.path), ...(version ? { version } : {}), sha256, bytes }
  } catch (err) {
    staging.abort()
    throw err
  }
}

/** A piece of another host's file as its `filesRead` answers it; a build before pieces answers the whole file, with no `size`. */
export type FarPiece = { name: string; data: string; version?: string; size?: number; end?: boolean }
/** How much a piece of another host's file carries, and how many are asked at once: the link's round trip is paid once a piece, two pieces overlap it. */
export const FAR_PIECE = 4 * 1024 * 1024
/** The first piece is small: the row says how far the copy has got after one round trip, not after 4 MB. */
export const FAR_FIRST = 256 * 1024
const FAR_AHEAD = 2

/**
 * Another host's file read for a copy here, a piece at a time with two asked at once, each written into the copy as
 * it lands, so the bytes cross the link once and the caller can say how far it has got (`progress`). Every piece names
 * the version it was read at: a file that changed while it was read is read once more, then refused. A host a build
 * behind answers the whole file at once. Answers the version read.
 */
export async function farBytes(ask: (params: { offset: number; length: number }) => Promise<FarPiece>, into: { write(buf: Buffer): void; restart(): void }, progress?: (done: number, total: number) => void, first?: FarPiece): Promise<string | undefined> {
  // Each ask's failure is the caller's to see when it waits for it, never an unhandled one when a piece is let go.
  const piece = (offset: number, length = FAR_PIECE): Promise<FarPiece> => {
    const got = ask({ offset, length })
    got.catch(() => undefined)
    return got
  }
  for (let tries = 0; ; tries++) {
    const head = tries === 0 && first ? first : await piece(0, FAR_FIRST)
    if (tries) into.restart()
    into.write(Buffer.from(head.data, 'base64'))
    if (typeof head.size !== 'number' || typeof head.version !== 'string') return typeof head.version === 'string' ? head.version : undefined
    let done = Buffer.byteLength(head.data, 'base64')
    progress?.(done, head.size)
    const offsets: number[] = []
    for (let at = done; at < head.size; at += FAR_PIECE) offsets.push(at)
    const asked: Promise<FarPiece>[] = []
    let next = 0
    const fill = (): void => {
      while (asked.length < FAR_AHEAD && next < offsets.length) asked.push(piece(offsets[next++]!))
    }
    fill()
    let same = true
    while (asked.length) {
      const got = await asked.shift()!
      fill()
      if (got.version !== head.version) {
        same = false
        break
      }
      const bytes = Buffer.from(got.data, 'base64')
      into.write(bytes)
      done += bytes.length
      progress?.(done, head.size)
    }
    if (same && done === head.size) return head.version
    if (tries) throw new Error(`${head.name} changed while it was read. Try again.`)
  }
}

/** A place for a far file's pieces that holds them in memory (a reload's bytes, a test): what `farBytes` writes into. */
export function bytesSink(): { write(buf: Buffer): void; restart(): void; bytes(): Buffer } {
  let parts: Buffer[] = []
  return { write: (buf) => void parts.push(buf), restart: () => void (parts = []), bytes: () => Buffer.concat(parts) }
}

/** One read of the guest's piece of a file, with the version the helper reads (`size:mtime:sha256`). */
type GuestPiece = { data: string; size: number; eof: boolean; version: string }
const PIECE = 4 * 1024 * 1024

/**
 * Whether the bytes staged are the version the helper named (`size:mtime:sha256`): its size, and its SHA-256 where it
 * gives one (a file over the helper's hash cap has none; the cap is above `BYTES_MAX`).
 */
function sameBytes(version: string, into: Staging): boolean {
  const [size, , sha] = version.split(':')
  if (Number.isFinite(Number(size)) && Number(size) !== into.size) return false
  return !sha || !/^[0-9a-f]{64}$/.test(sha) || sha === into.sha256()
}

/** The guest's version of a file (`size:mtime:sha256`), read with one byte of it: the hash the helper makes for a version. */
const guestVersion = async (path: string, signal?: AbortSignal): Promise<string> => ((await vmCall('files.read', { path, offset: 0, length: 1, version: true }, { signal })) as GuestPiece).version

/**
 * A file in the VM read whole for a Files tab's copy, with its version, each piece written into the copy as it lands
 * and said as it goes (`progress`, as a far drive's copy says it). The helper hashes the whole file for a version, so
 * the version is asked with the first piece and once more at the end, never with the pieces between: one that differs
 * means the file changed while it was read (read once more, then refused). Answers the version read.
 */
async function vmVersioned(path: string, into: Staging, signal?: AbortSignal, progress?: (done: number, total: number) => void): Promise<string> {
  for (let tries = 0; ; tries++) {
    const entry = (await vmCall('files.stat', { path }, { signal })) as { dir?: boolean; size: number; name: string }
    if (entry.dir) throw new Error('That is a folder.')
    if (entry.size > BYTES_MAX) throw new Error(`${entry.name} is over ${Math.round(BYTES_MAX / 1024 / 1024)} MB: open it in its app.`)
    if (tries) into.restart()
    let first: string | null = null
    let last: string | null = null
    let offset = 0
    for (;;) {
      // The first piece, and the one that should end the file, carry the version.
      const versioned = offset === 0 || offset + PIECE >= entry.size
      const got = (await vmCall('files.read', { path, offset, length: PIECE, ...(versioned ? { version: true } : {}) }, { signal })) as GuestPiece
      if (offset === 0) first = got.version
      else if (versioned) last = got.version
      const buf = Buffer.from(got.data, 'base64')
      into.write(buf)
      offset += buf.length
      progress?.(offset, Math.max(entry.size, offset))
      if (got.eof || !buf.length) break
      if (offset > BYTES_MAX) throw new Error(`${entry.name} grew past ${Math.round(BYTES_MAX / 1024 / 1024)} MB while it was read.`)
    }
    // A file of one piece was versioned with it; one whose end came on a piece that was not asked for its version is asked once.
    const end = offset <= PIECE ? first : (last ?? (await guestVersion(path, signal)))
    // The helper may answer the end's version from the hash it made for the first piece (kept a minute while the size and
    // change time hold), so the bytes themselves are held to it: the version's SHA-256 must be the one hashed as they came in.
    if (first !== null && end === first && (typeof first !== 'string' || sameBytes(first, into))) return first
    if (tries) throw new Error(`${entry.name} changed while it was read. Try again.`)
  }
}

export async function filesHandle(req: ClientRequest, ctx: WorkCtx, by: Caller, deps: FilesDeps | (() => OfficeCarrier | null), signal?: AbortSignal): Promise<Handled> {
  const d: FilesDeps = typeof deps === 'function' ? { carrier: deps } : deps
  const carrier = d.carrier
  const m = req.method
  const p = (req as { params?: Record<string, unknown> }).params ?? {}
  switch (m) {
    case 'work.office.filesLibraries':
      return handled(await librariesAnswer(ctx, by, p.cached === true))
    case 'work.office.filesList': {
      const { library, path } = admitted(ctx, by, m, p.source as CanvasSource)
      if (library.vm) return handled({ entries: await vmList(library, path, signal) })
      if (!statSync(path).isDirectory()) throw new Error('That is a file, not a folder.')
      return handled({ entries: listFolder(library, path) })
    }
    case 'work.office.filesSearch': {
      const vm = vmFor(ctx, by) ? vmLibraries(ctx.db, ctx.host) : []
      const all = [...librariesOf(ctx.db, ctx.host), ...vm]
      const libs = p.library ? all.filter((l) => l.id === p.library) : all
      if (p.library && !libs.length) throw new Error('No such library on this host.')
      // A remote key searches only what it could name itself; the VM's libraries are no path of this host and are its to search.
      const own = libs.filter((l) => !l.vm)
      const fenced = by.kind === 'remote' && !by.peer ? own.filter((l) => ctx.reaches(by, l.path)) : own
      const inVm = libs.filter((l) => l.vm)
      // The walk stops when its caller goes, or when the same caller's next search names this one as the one it replaces.
      const walk = deskSearchStarts(by, p.query as string, p.replaces as string | undefined, signal)
      try {
        // A search reads names, sizes and times: who last saved a file (read from inside it) is left to the row's own look.
        const [a, b] = await Promise.all([searchLibraries(fenced, p.query as string, p.kind as never, Date.now, { signal: walk.signal, who: false }), vmSearch(inVm, p.query as string, p.kind as never, walk.signal)])
        const entries = [...a.entries, ...b.entries].sort((x, y) => y.modified - x.modified)
        return handled({ entries: entries.slice(0, SEARCH_MAX), more: a.more || b.more || entries.length > SEARCH_MAX })
      } finally {
        walk.done()
      }
    }
    case 'work.office.filesFetch': {
      const { library, path } = admitted(ctx, by, m, p.source as CanvasSource)
      return handled({ entry: library.vm ? await vmFetch(library.id, path, signal) : await fetchFile(library.id, path, signal) })
    }
    case 'work.office.filesRead': {
      const { library, path } = admitted(ctx, by, m, p.source as CanvasSource)
      if (library.vm) {
        // The guest's bytes never leave this host: a copy he allowed is made here (`filesCopy`), not sent to a caller.
        if (p.as === 'bytes') throw new Error("A file in the Windows VM is copied on this host (filesCopy): its bytes go to no caller.")
        return handled({ name: path.slice(path.lastIndexOf('\\') + 1), ...(await vmText(path, signal)) })
      }
      if (p.as === 'bytes') {
        // Bytes leave this host only for another host of his making a copy its workspace allows (it checks its own switch).
        if (!by.peer) throw new Error('A file\'s bytes go only to another host of his, for a copy he allowed.')
        // The size is known before the download: a file too big to copy is never fetched for it.
        if ((await stat(path)).size > BYTES_MAX) throw new Error(`${basename(path)} is over ${BYTES_MAX / 1024 / 1024} MB: open it in its app.`)
        // A piece at a time: the asker streams the copy and says how far it has got (files/copyIn).
        if (typeof p.offset === 'number') return handled({ name: basename(path), ...(await readPiece(path, p.offset, Math.min(typeof p.length === 'number' ? p.length : FILES_PIECE_MAX, FILES_PIECE_MAX))) })
        // A mapped drive keeps nothing in the cloud: the read below is the only one, never a whole read ahead of it.
        if (!driveOf(path)) await fetchFile('', path, signal)
        // Its bytes and its version from one look: a copy that saves back names this version (files/copies.ts).
        const whole = await readWhole(path, BYTES_MAX)
        return handled({ name: basename(path), data: whole.data.toString('base64'), version: whole.version })
      }
      return handled({ name: basename(path), ...(await readText(path)) })
    }
    case 'work.office.filesOpen': {
      const { library, path } = admitted(ctx, by, m, p.source as CanvasSource)
      if (library.vm) {
        if ((await vmStat(library.id, path, signal)).kind === 'folder') throw new Error('That is a folder.')
        await vmOpen(path, d.vmOpenOffice ?? null, signal)
        return handled({ opened: true as const })
      }
      await openInApp(carrier(), entryOf(library.id, path))
      return handled({ opened: true as const })
    }
    case 'work.office.filesSetRoots':
      setRoots(ctx.db, p.roots as never)
      forgetLibraries(ctx.db)
      return handled(await librariesAnswer(ctx, by))
    case 'work.office.vmStatus':
      return handled(vmOfficeStatus(ctx.db, vmState()))
    case 'work.office.vmSignIn': {
      if (by.kind === 'model') throw new Error(ONLY_OWNER)
      const state = vmState()
      if (!state || state.cannot || state.state === 'none') throw new Error(state?.cannot ?? NOT_SET_UP)
      const stored = await refreshVm(ctx.db, { wake: true, signal })
      const signedIn = stored?.status.onedrive.account ?? null
      if (signedIn) {
        // OneDrive is done; a fresh Office asks for its own sign-in in the first app he opens, so Word is opened for it.
        const office = stored!.status.office
        if (office.installed && office.licensed !== true) {
          const reached = await walkOfficeSignIn({ call: vmCall, key: vmKey, ...(pace ? { waits: pace, sleep: async () => {} } : {}) })
          // Office's own state ends the watch: OneDrive's account is there from the start
          follow(ctx, async () => ((await refreshVm(ctx.db, { wake: false }))?.status.office.licensed === true ? signedIn : null), 'Office')
          return handled({ computer: 'vm:windows', account: signedIn, ...(reached === 'word' ? { line: OFFICE_WORD_LINE } : await signInLine(reached)) } satisfies VmSignInAnswer)
        }
        return handled({ computer: 'vm:windows', account: signedIn, line: `The Windows VM is signed in as ${signedIn}.` } satisfies VmSignInAnswer)
      }
      const account = (p.account as string | undefined) ?? d.ownAccount?.() ?? stored?.status.office.account ?? null
      // Walked to the one step that is his: the number for his phone. Nothing here types a password or a code.
      const reached = await walkSignIn(account, { call: vmCall, key: vmKey, ...(pace ? { waits: pace, sleep: async () => {} } : {}) })
      // While he answers on his phone the host answers what Microsoft asks next, so his one approval is enough.
      if (reached === 'number' || reached === 'pending') {
        // once its tutorial is through, the wanted libraries are asked of OneDrive again (it ignored a sync link while the tutorial was open)
        const afterSignIn = async () => {
          resetSyncAsks()
          await refreshVm(ctx.db, { wake: false })
        }
        follow(ctx, async () => (await refreshVm(ctx.db, { wake: false }))?.status.onedrive.account ?? null, 'OneDrive', afterSignIn)
      }
      return handled({ computer: 'vm:windows', account, ...(await signInLine(reached)) } satisfies VmSignInAnswer)
    }
    case 'work.office.vmSync': {
      if (by.kind === 'model') throw new Error(ONLY_OWNER)
      setWantedLibraries(ctx.db, p.libraries as VmSyncLibrary[])
      // An awake, signed-in OneDrive is asked now; otherwise at its next read.
      await refreshVm(ctx.db, { wake: false, signal }).catch(() => null)
      return handled({ wanted: wantedLibraries(ctx.db).length, missing: missingLibraries(ctx.db).length })
    }
    case 'work.office.filesCopyGet':
      return handled({ on: copyAllowed(ctx.db, p.workspaceId as string) })
    case 'work.office.filesCopySet':
      setCopyAllowed(ctx.db, p.workspaceId as string, p.on as boolean)
      // Turned off, the copies its threads hold go too, and with the Files tabs' copies what Files kept of them; a Files
      // tab's copy whose changes have not reached its file stays until they do: only his Discard drops one.
      if (!p.on) dropCopies(ctx, { workspaceId: p.workspaceId as string }, dropCopyRecords(ctx.db, p.workspaceId as string))
      return handled({ on: copyAllowed(ctx.db, p.workspaceId as string) })
    case 'work.office.filesThreads':
      return handled({ threads: threadsHolding(ctx, p.workspaceId as string, p.source as CanvasSource, (path) => by.kind !== 'remote' || !!by.peer || ctx.reaches(by, path)) })
    case 'work.office.filesCopy': {
      const owner = p.sessionId as string
      // His own window copies into a Files pane as well; a thread copies only into itself.
      if (filesPaneWorkspace(owner) !== null && by.kind !== 'model') return handled(await copyIn(ctx, owner, p.source as CanvasSource, signal))
      const scope = ctx.scopeOf(owner)
      if (!scope || (by.kind === 'model' && by.sessionId !== scope.sessionId)) throw new Error('No such Work thread here.')
      return handled(await copyIn(ctx, scope.sessionId, p.source as CanvasSource, signal))
    }
  }
  return NOT_HANDLED
}

