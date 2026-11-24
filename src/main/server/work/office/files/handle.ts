import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { teamsAppOf, teamsKindOf, type TeamsEntry, type TeamsLibrary } from '@shared/contract-work-office'
import { canvasSourcePath, filesPaneOf, filesPaneWorkspace, handled, NOT_HANDLED, type CanvasItem, type CanvasSource, type Handled } from '@shared/work'
import type { ClientRequest } from '@shared/contract'
import { FenceError } from '../../../remote/fence'
import { macBridgeLandingRoot } from '../../../macBridgeLanding'
import type { Caller, WorkCtx } from '../../modules'
import { copyKeptIn, dropCopyRecords } from '../../files/copyKept'
import { importFolderOf } from '../../files/imports'
import { workspaceHere } from '../../files/policy'
import { readWhole } from '../../files/save'
import type { OfficeCarrier } from '../carrier'
import { BYTES_MAX, copyAllowed, entryOf, fetchFile, foldersPlace, librariesOf, libraryOf, listFolder, offFolders, readText, rootsOf, searchLibraries, SEARCH_MAX, setCopyAllowed, setRoots } from './library'
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

async function librariesAnswer(ctx: WorkCtx, by: Caller): Promise<TeamsLibrariesAnswer> {
  const own = librariesOf(ctx.db, ctx.host)
  const vm = vmFor(ctx, by) ? await vmListing(ctx, by) : { libraries: [], place: null }
  const folders = foldersPlace(ctx.host)
  // A folder he added himself is a library too: the place then has something to show.
  const places = [...(folders ? [own.some((l) => l.kind !== 'mine') && folders.state !== 'ok' ? { ...folders, state: 'ok' as const } : folders] : []), ...(vm.place ? [vm.place] : [])]
  return { host: ctx.host, libraries: [...own, ...vm.libraries], roots: rootsOf(ctx.db), off: offFolders(ctx.db), places }
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

/** Whether this host's Windows VM is set up: a Files pane is his own window, which needs nothing more of it. */
const vmSetUp = (): boolean => {
  const s = vmState()
  return !!s && !s.cannot && s.state !== 'none'
}

/**
 * Writes a copy into its folder, never through a link: the owner's folder and the source's folder must be folders,
 * and the file itself is opened without following one, so a link put there by anything else never carries the
 * bytes out of the copies.
 */
function writeCopy(dataDir: string, sessionId: string, dir: string, path: string, bytes: Buffer): void {
  for (const folder of [copyDirOf(dataDir, sessionId), dir]) if (!lstatSync(folder).isDirectory()) throw new Error('The copy\'s folder is not a folder: nothing was copied.')
  let fd: number
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('The copy\'s place is a link: nothing was copied.')
    throw err
  }
  try {
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

/**
 * Copies a file from another host, or out of this host's Windows VM, into the owner's attachments here, when its
 * workspace allows it. The owner is a Work thread, or the Files pane of a Work workspace here (a file opened in a tab).
 */
export async function copyIn(ctx: WorkCtx, sessionId: string, source: CanvasSource, signal?: AbortSignal): Promise<{ source: CanvasSource; entry: TeamsEntry; version?: string }> {
  const pane = filesPaneWorkspace(sessionId)
  const scope = pane === null ? ctx.scopeOf(sessionId) : null
  if (pane === null && !scope) throw new Error(`thread ${sessionId} is not a Work thread here`)
  if (pane !== null && !workspaceHere(ctx.db, pane)) throw new Error('No such Work workspace on this host.')
  const workspaceId = pane ?? scope!.workspaceId
  if (!workspaceId || !copyAllowed(ctx.db, workspaceId)) throw new Error('This workspace keeps Teams files where they are: turn on Copy Teams files in its settings to open one here.')
  if (source.at !== 'file') throw new Error('A copy comes from a file on another host.')
  // The file's version comes from the same look as its bytes, so a copy that saves back names exactly what it read.
  let got: { name: string; bytes: Buffer; version?: string }
  if (source.host === ctx.host) {
    // A file in this host's Windows VM comes out of the guest the same way: a snapshot in the thread's own folder.
    if (!isGuestPath(source.path)) throw new Error('A copy comes from a file on another host.')
    if (scope ? !vmAllowed(ctx, scope) : !vmSetUp()) throw new Error(NOT_VM)
    const inVm = vmLibraryOf(vmLibraries(ctx.db, ctx.host), source.path)
    if (!inVm) throw new Error(NOT_TEAMS)
    const name = inVm.path.slice(inVm.path.lastIndexOf('\\') + 1)
    got = pane === null ? { name, bytes: await vmBytes(inVm.path, BYTES_MAX, signal) } : { name, ...(await vmVersioned(inVm.path, signal)) }
  } else {
    const far = (await ctx.peer.call({ scope: scope ?? { sessionId, workspaceId }, signal }, source.host).call('office', 'filesRead', { source, as: 'bytes' })) as { name: string; data: string; version?: string }
    got = { name: far.name, bytes: Buffer.from(far.data, 'base64'), ...(typeof far.version === 'string' ? { version: far.version } : {}) }
  }
  // One folder per source file, so two files of one name in one owner's copies never share a folder.
  const dir = copyFolderOf(ctx.dataDir, sessionId, source)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, basename(got.name))
  writeCopy(ctx.dataDir, sessionId, dir, path, got.bytes)
  return { source: { at: 'file', host: ctx.host, path }, entry: entryOf('', path), ...(got.version ? { version: got.version } : {}) }
}

/** One read of the guest's piece of a file, with the version the helper reads (`size:mtime:sha256`). */
type GuestPiece = { data: string; size: number; eof: boolean; version: string }
const PIECE = 4 * 1024 * 1024

/**
 * A file in the VM read whole for a Files tab's copy, with its version: every piece is read with the helper's
 * version, and a piece of another version means the file changed while it was read (read once more, then refused).
 */
async function vmVersioned(path: string, signal?: AbortSignal): Promise<{ bytes: Buffer; version: string }> {
  for (let tries = 0; ; tries++) {
    const entry = (await vmCall('files.stat', { path }, { signal })) as { dir?: boolean; size: number; name: string }
    if (entry.dir) throw new Error('That is a folder.')
    if (entry.size > BYTES_MAX) throw new Error(`${entry.name} is over ${Math.round(BYTES_MAX / 1024 / 1024)} MB: open it in its app.`)
    const parts: Buffer[] = []
    let version: string | null = null
    let offset = 0
    let same = true
    for (;;) {
      const got = (await vmCall('files.read', { path, offset, length: PIECE, version: true }, { signal })) as GuestPiece
      if (version !== null && got.version !== version) {
        same = false
        break
      }
      version = got.version
      const buf = Buffer.from(got.data, 'base64')
      parts.push(buf)
      offset += buf.length
      if (got.eof || !buf.length) break
      if (offset > BYTES_MAX) throw new Error(`${entry.name} grew past ${Math.round(BYTES_MAX / 1024 / 1024)} MB while it was read.`)
    }
    if (same && version !== null) return { bytes: Buffer.concat(parts), version }
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
      return handled(await librariesAnswer(ctx, by))
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
      const [a, b] = await Promise.all([searchLibraries(fenced, p.query as string, p.kind as never), vmSearch(inVm, p.query as string, p.kind as never, signal)])
      const entries = [...a.entries, ...b.entries].sort((x, y) => y.modified - x.modified)
      return handled({ entries: entries.slice(0, SEARCH_MAX), more: a.more || b.more || entries.length > SEARCH_MAX })
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
        if (statSync(path).size > BYTES_MAX) throw new Error(`${basename(path)} is over ${BYTES_MAX / 1024 / 1024} MB: open it in its app.`)
        await fetchFile('', path, signal)
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

