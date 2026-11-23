import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { FileOrigin, FileRef } from '@shared/contract-work-files'
import type { TeamsLibrary } from '@shared/contract-work-office'
import { canvasSourcePath, type CanvasSource } from '@shared/work'
import { questionFor, refusal, type FileEntry, type FilePlace, type FileVerb } from '@shared/work/files'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { cloudDirOf, libraryOf } from '../office/files/library'
import { isGuestPath, vmLibraryOf } from '../office/vm/files'
import { vmAllowed, vmState } from '../office/vm/office'
import { librariesHere, vmLibrariesHere } from './places/libraries'

/**
 * The one door of the Files place (docs/agents/work-files.md "One door for every change"). Every method that
 * names a file or a folder resolves it here against the caller's own workspace (`locate`), and every verb that
 * changes anything passes `admitWrite` first. The same file answers `sharedOf(source)` for every other Work
 * tool that writes a file by path.
 *
 * | Caller | His own place | A place others can open |
 * |---|---|---|
 * | this host's window | yes | yes, after the window's own question |
 * | a remote key (a phone, a far window) | with `operate` | only with `approve` |
 * | a thread (`model`) | yes, with a results row and Undo (from F5; refused before) | never: it becomes a held `file.act` |
 * | another host of his (`peer`) | only with where the change began (`origin`) | the same |
 */

export interface WorkspaceRow {
  id: string
  name: string
  /** its folder on this host */
  path: string
  sector: string | null
}

/** The Work workspace of this id on this host, or null: a code workspace is none of Files' business. */
export function workspaceHere(db: DatabaseSync, id: string): WorkspaceRow | null {
  const row = db.prepare(`SELECT id, name, path, kind, sector FROM workspaces WHERE id = ?`).get(id) as { id: string; name: string; path: string; kind: string | null; sector: string | null } | undefined
  return row && row.kind === 'work' && row.path ? { id: row.id, name: row.name, path: row.path, sector: row.sector ?? null } : null
}

const real = (path: string): string | null => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
/** Whether `path` is `dir` or under it, both as given (the caller passes real paths). */
export const within = (path: string, dir: string): boolean => {
  const r = relative(dir, path)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !r.startsWith(sep) && !/^[a-zA-Z]:/.test(r))
}

/** Where a ref lies, once it has passed the fence for its caller. */
export type Located =
  /** in the workspace's own folder on this host: `path` and `root` are real paths */
  | { in: 'folder'; workspace: WorkspaceRow; path: string; root: string }
  /** in a library OneDrive syncs on this host, or in the Windows VM it keeps (`library.vm`, a guest path) */
  | { in: 'library'; library: TeamsLibrary; path: string }
  /** a place's top, or a lens: one of the workspace's own (`folder`, `home`, `trash`, …) or a library's id */
  | { in: 'place'; id: string }

export const NOT_HERE = 'That file is on another host: ask that host.'
export const NOT_REACHED = "That is not in this workspace's folder or a library it may use."
export const NO_WORKSPACE = 'No such Work workspace on this host.'
export const THREAD_ELSEWHERE = "A thread reaches only its own workspace's files."
export const PEER_LIBRARIES = "Another host reaches only this host's libraries."
export const NOT_VM = 'This workspace may not use the Windows VM (its Work settings: Computer use on the Windows VM).'

/** Whether the caller may use what is in the Windows VM: a thread only where its workspace turns the VM on; his own windows always. */
export function vmFor(ctx: Pick<WorkCtx, 'scopeOf' | 'settings'>, by: Caller): boolean {
  if (by.kind !== 'model') return true
  if (!vmState()) return false
  const scope = by.sessionId ? ctx.scopeOf(by.sessionId) : null
  return !!scope && vmAllowed(ctx, scope)
}

/**
 * The fence by caller, before any ref is looked at: a thread names only its own workspace (a Work Chat has
 * none, so it reaches no place at all), and whoever asks, the workspace's own rows (tabs, marks, Trash) are
 * kept only where the workspace lives.
 */
export function admitCaller(ctx: Pick<WorkCtx, 'scopeOf'>, by: Caller, workspaceId: string): void {
  if (by.kind !== 'model') return
  const scope = by.sessionId ? ctx.scopeOf(by.sessionId) : null
  if (!scope || scope.workspaceId !== workspaceId) throw new Error(THREAD_ELSEWHERE)
}

/**
 * Resolves a file or folder against the caller's own workspace, or refuses. A path must lie, by its real
 * spelling, in that workspace's folder or in a library of this host (a link out, or `..`, leaves both); a
 * file in the Windows VM must lie in a library OneDrive syncs there. Then the caller's own row:
 *  - a thread: its own workspace only, the VM only where its workspace turns it on;
 *  - another host of his: the libraries alone, under this host's bridge policy for it;
 *  - a remote key: only what the listener's fence lets it name (`ctx.reaches`, by the real path). A file in
 *    the VM is no path of this host's disk: the listener passes it for the verbs that may carry one, and it
 *    is held to OneDrive's mounts here.
 */
export function locate(ctx: Pick<WorkCtx, 'db' | 'host' | 'reaches' | 'scopeOf' | 'settings'>, by: Caller, workspaceId: string, ref: FileRef, method: string): Located {
  admitCaller(ctx, by, workspaceId)
  if (ref.at === 'place') {
    if (by.peer) throw new Error(PEER_LIBRARIES)
    return { in: 'place', id: ref.id }
  }
  const path = ref.at === 'file' ? ref.path : ref.at === 'microsoft' && ref.ref.kind === 'path' ? ref.ref.path : null
  if (path === null) throw new Error('That place is not read by this build yet.')
  if ((ref as { host: string }).host !== ctx.host) throw new Error(NOT_HERE)
  if (isGuestPath(path) && process.platform !== 'win32') {
    if (!vmFor(ctx, by)) throw new Error(NOT_VM)
    const inVm = vmLibraryOf(vmLibrariesHere(ctx), path)
    if (!inVm) throw new Error(NOT_REACHED)
    return { in: 'library', ...inVm }
  }
  const at = real(path)
  if (!at) throw new Error(`${path.slice(path.lastIndexOf(sep) + 1)} is not there any more.`)
  const workspace = workspaceHere(ctx.db, workspaceId)
  const root = workspace ? real(workspace.path) : null
  if (workspace && root && within(at, root)) {
    if (by.peer) throw new Error(PEER_LIBRARIES)
    if (by.kind === 'remote' && !ctx.reaches(by, at)) throw new FenceError(method)
    return { in: 'folder', workspace, path: at, root }
  }
  const found = libraryOf(librariesHere(ctx), at)
  if (!found) throw new Error(NOT_REACHED)
  if (by.kind === 'remote' && !by.peer && !ctx.reaches(by, found.path)) throw new FenceError(method)
  return { in: 'library', ...found }
}

/**
 * Whether other people can open what a source names: a file in a Teams or OneDrive library (on this host or in
 * its Windows VM), a Microsoft file by its address, a Google file, a file on another host (this one cannot
 * tell), and a file in any cloud folder of this computer that is not a listed library (it cannot tell either).
 * A file anywhere else on this disk is his own: the workspace's folder, a copy he allowed, an import, an item's
 * own folder. A LifeOS row is shared while LifeOS says so, which its own pillar reads from the row; by its
 * source alone it is his own.
 */
export function sharedOf(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, source: CanvasSource): boolean {
  if (source.at === 'google') return true
  if (source.at === 'microsoft' && source.ref.kind === 'url') return true
  const path = canvasSourcePath(source)
  if (path === null) return false
  if ((source as { host: string }).host !== ctx.host) return true
  if (isGuestPath(path) && process.platform !== 'win32') return true
  const at = real(path) ?? path
  // What the app keeps for him is his own, wherever the data folder lies.
  const data = real(ctx.dataDir) ?? ctx.dataDir
  if (within(at, data)) return false
  if (libraryOf(librariesHere(ctx), at)) return true
  const cloud = real(cloudDirOf(ctx.host))
  return !!cloud && within(at, cloud)
}

/** What the door needs to know of one end of a change. */
export type DoorPlace = Pick<FilePlace, 'id' | 'kind' | 'name' | 'host' | 'env' | 'shared' | 'can' | 'state' | 'vm' | 'group'>

/** Threads change files through the files tools, with a results row and Undo or a held act: built in F5. Until then every thread's change is refused. */
let threadsMayWrite = false
export const setThreadsMayWrite = (on: boolean): void => void (threadsMayWrite = on)
export const THREADS_NOT_YET = 'A thread cannot change files through Files yet.'
export const ASK_FIRST = 'Others can open that place: the window asks before this change.'
export const NEEDS_APPROVE = 'Others can open that place: this key may not change it.'
export const PEER_NO_ORIGIN = 'A change from another host of his must say where it began.'
export const PEER_WRONG_ACT = 'That held act is not for this change.'

/** The digest that binds a held act to exactly one change: its verb, the things it names, where they go and the name they take. */
export function changeDigest(change: { verb: FileVerb; refs: readonly unknown[]; to?: unknown; name?: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([change.verb, change.refs, change.to ?? null, change.name ?? null]))
    .digest('hex')
}

export interface Change {
  verb: FileVerb
  /** where the thing lives now; for `make` and `upload`, where it is to be made */
  from: DoorPlace
  /** where a move or copy lands, when it is another place */
  to?: DoorPlace | null
  entry?: Pick<FileEntry, 'name' | 'size' | 'state' | 'kind' | 'shared'> | null
  /** the window's own question was asked and answered yes */
  asked?: boolean
  origin?: FileOrigin
  /** the change itself, for a held act's digest */
  digest?: string
}

/**
 * Whether a change runs now (`run`) or waits for his press as a held act (`hold`); anything else throws its one
 * sentence. The grammar's own refusals come first (`refusal`, src/shared/work/files.ts), so the host never does
 * what a menu would not offer; then the caller's row of the table above.
 */
export function admitWrite(by: Caller, change: Change): 'run' | 'hold' {
  const { verb, from, to, entry } = change
  const no = refusal(from, verb, entry, to)
  if (no) throw new Error(no.text)
  const shared = from.shared || !!entry?.shared || (!!to && to.shared)
  if (by.kind === 'model') {
    if (!threadsMayWrite) throw new Error(THREADS_NOT_YET)
    return shared ? 'hold' : 'run'
  }
  if (by.kind === 'remote' && by.peer) {
    const origin = change.origin
    if (!origin) throw new Error(PEER_NO_ORIGIN)
    if (origin.from === 'act' && (!change.digest || origin.digest !== change.digest)) throw new Error(PEER_WRONG_ACT)
    // A held act was his press on exactly this change; a window's press is still asked its question.
    if (origin.from === 'act') return 'run'
  }
  if (by.kind === 'remote' && !by.peer && shared && !by.caps.includes('approve')) throw new Error(NEEDS_APPROVE)
  if (questionFor(from, verb, entry, to) !== null && !change.asked) throw new Error(ASK_FIRST)
  return 'run'
}
