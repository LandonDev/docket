import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { FileOrigin, FileRef } from '@shared/contract-work-files'
import type { TeamsLibrary } from '@shared/contract-work-office'
import { canvasSourcePath, type CanvasSource } from '@shared/work'
import { PLACE, questionFor, refusal, type FileEntry, type FilePlace, type FileVerb } from '@shared/work/files'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { cloudDirOf, libraryOf } from '../office/files/library'
import { isGuestPath, vmLibraryOf } from '../office/vm/files'
import { vmAllowed, vmState } from '../office/vm/office'
import { librariesHere, vmLibrariesHere } from './places/libraries'
import { accountsHeld } from './places/drive'
import { isSavingCopy } from './copyKept'

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
  /** in a Google Drive of one of the workspace's accounts: a folder (`folderId`, Drive's `root` for its top) or a file (`mime` set) */
  | { in: 'drive'; workspace: WorkspaceRow; account: string; id: string; mime?: string }

export const NOT_HERE = 'That file is on another host: ask that host.'
export const NOT_REACHED = "That is not in this workspace's folder or a library it may use."
export const NO_WORKSPACE = 'No such Work workspace on this host.'
export const THREAD_ELSEWHERE = "A thread reaches only its own workspace's files."
export const PEER_LIBRARIES = "Another host reaches only this host's libraries."
export const NOT_DRIVE = "That Google account is not one of this workspace's."
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
 * A Drive folder or a Google file must be of a Google account this workspace has (its sector's, as LifeOS files it,
 * read before by `driveAccounts`); no other host reaches it, and a remote key only when it may name the workspace's
 * own folder. Whether this client may see the id is Google's to say, with that account's `drive.file` token.
 */
export function locate(ctx: Pick<WorkCtx, 'db' | 'host' | 'reaches' | 'scopeOf' | 'settings'>, by: Caller, workspaceId: string, ref: FileRef, method: string): Located {
  admitCaller(ctx, by, workspaceId)
  if (ref.at === 'place') {
    if (by.peer) throw new Error(PEER_LIBRARIES)
    return { in: 'place', id: ref.id }
  }
  if (ref.at === 'drive' || ref.at === 'google') {
    if (by.peer) throw new Error(PEER_LIBRARIES)
    const workspace = workspaceHere(ctx.db, workspaceId)
    if (!workspace) throw new Error(NO_WORKSPACE)
    const account = ref.account.toLowerCase()
    if (!accountsHeld(ctx.db, workspace.sector).includes(account)) throw new Error(NOT_DRIVE)
    if (by.kind === 'remote' && !ctx.reaches(by, workspace.path)) throw new FenceError(method)
    return { in: 'drive', workspace, account, ...(ref.at === 'drive' ? { id: ref.folderId } : { id: ref.fileId, mime: ref.mime }) }
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

export const NO_SECTOR = 'This workspace is not linked to a LifeOS sector.'
export const MAIL_NEEDS_APPROVE = 'Files from his mail are read with approve: this key may not.'

/** A ref the LifeOS adapter answers (files/places/lifeos.ts): a LifeOS row, a project, a mail's file, or one of their places. */
export function isLifeosRef(ref: FileRef): boolean {
  if (ref.at === 'lifeos' || ref.at === 'project' || ref.at === 'mail') return true
  return ref.at === 'place' && (ref.id === PLACE.lifeos || ref.id === PLACE.mail || ref.id.startsWith('project:'))
}

/**
 * The door's rows for a LifeOS ref, before the id is looked at: a thread names only its own workspace, another
 * host of his reaches nothing of LifeOS (each host reads LifeOS with its own session), the workspace must live
 * here and be linked to a sector, and a remote key reads files of his mail only with `approve`, as reading his
 * mail needs. Answers the workspace with its sector; the adapter then holds the id to that sector
 * (`lifeosRow`), for every caller.
 */
export function locateLifeos(ctx: Pick<WorkCtx, 'db' | 'scopeOf'>, by: Caller, workspaceId: string, ref: FileRef): WorkspaceRow & { sector: string } {
  admitCaller(ctx, by, workspaceId)
  if (by.peer) throw new Error(PEER_LIBRARIES)
  const workspace = workspaceHere(ctx.db, workspaceId)
  if (!workspace) throw new Error(NO_WORKSPACE)
  if (!workspace.sector) throw new Error(NO_SECTOR)
  const mail = ref.at === 'mail' || (ref.at === 'place' && ref.id === PLACE.mail)
  if (mail && by.kind === 'remote' && !by.caps.includes('approve')) throw new Error(MAIL_NEEDS_APPROVE)
  return { ...workspace, sector: workspace.sector }
}

/**
 * Others can open it by its spelling alone: it lives in OneDrive, SharePoint or Teams, by URL or in a folder synced from
 * there, on a Mac or under Windows, or on a disk that is not this computer's own: a network share, a mounted volume
 * (`/Volumes/…`, `/mnt/…`, `/media/…`, `/net/…`) or a Windows drive other than C:, which is how a mapped share reads. A
 * file of his on such a disk waits for him too: what cannot be told apart is treated as shared. Office's own test
 * (office/shared.ts `fileShared`) and `sharedOf` both ask it.
 */
export const sharedKey = (key: string): boolean => {
  const k = key.replace(/\\/g, '/')
  // A network share (\\server\share\…) is others' to open as surely as OneDrive (milestone 50's hold review).
  if (/^https?:\/\//i.test(k) || k.startsWith('//') || /\/Library\/CloudStorage\/|\/OneDrive( |-|\/|$)/i.test(k)) return true
  return /^\/(Volumes|mnt|media|net)\//i.test(k) || /^[a-bd-z]:\//i.test(k)
}

/**
 * Whether other people can open what a source names: a file in a Teams or OneDrive library (on this host or in
 * its Windows VM), a Microsoft file by its address, a Google file (by its source alone the host cannot tell its
 * sharing, which only Drive says: the Files place asks Drive, `itemShared`), a file on another host (this one cannot
 * tell), a file on a disk others reach or in a folder named for OneDrive (`sharedKey`), and a file in any cloud folder
 * of this computer that is not a listed library (it cannot tell either). Each is judged by the path's real spelling,
 * and a path not made yet by its nearest folder that is, so a link to a library, or a new file in one, is the
 * library's. A file anywhere else on this disk is his own: the workspace's folder, a copy he allowed, an import, an
 * item's own folder, what the app keeps for him (looked at last, so a data folder kept in a synced place is still
 * that place's). A LifeOS row is shared while LifeOS says so, which its own pillar reads from the row; by its source
 * alone it is his own. A Files tab's copy that saves back to a file others can open (copies.ts), and what lies beside
 * it in its folder, is as shared as that file: an editor's own hold for a shared file holds there too.
 */
export function sharedOf(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, source: CanvasSource): boolean {
  if (source.at === 'google') return true
  if (source.at === 'microsoft' && source.ref.kind === 'url') return true
  const path = canvasSourcePath(source)
  if (path === null) return false
  if ((source as { host: string }).host !== ctx.host) return true
  if (isGuestPath(path) && process.platform !== 'win32') return true
  const at = realish(path)
  if (sharedKey(path) || sharedKey(at)) return true
  // (A context with no database, as some pillars' tests make, has no list of libraries to read.)
  if (ctx.db && librariesHere(ctx).some((library) => inside(at, library.path))) return true
  if (inside(at, cloudDirOf(ctx.host))) return true
  // What the app keeps for him is his own: a Files tab's copy that saves back is the file it saves to.
  if (inside(at, ctx.dataDir)) return isSavingCopy(ctx.db, at)
  return false
}

/** Whether a real path lies in a folder, by the folder's own real path; a folder that is not there holds nothing. */
const inside = (at: string, dir: string): boolean => {
  const root = real(dir)
  return !!root && within(at, root)
}

/**
 * Whether others can open where a located thing lies, by its real path: a library always; the workspace's own
 * folder, or a folder in it, where `sharedOf` says so (a workspace kept in OneDrive, on a network share, a library
 * reached inside it). The place a thing lies in says only what kind of place it is, which the window's questions
 * read; this is what the hold and a key's `approve` read. Null for a lens or a Drive's thing: Drive says its own.
 */
export function locatedShared(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, at: Located): boolean {
  if (at.in === 'library') return true
  if (at.in === 'folder') return sharedOf(ctx, { at: 'file', host: ctx.host, path: at.path })
  return false
}

/**
 * Whether a caller stands for his press on a file others can open: his window on this host, or a key he gave
 * `approve`. Another host of his never does (a peer's call carries no press, work/peer.ts), nor a thread. Taking an
 * agent's change into such a file, seeing what waits on it, and changing it from a key are for these callers alone.
 */
export const pressesFor = (by: Caller): boolean => by.kind === 'local' || (by.kind === 'remote' && !by.peer && by.caps.includes('approve'))
export const NEEDS_PRESS = 'Others can open this file: only his own window, or a key that may approve, does that.'

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

/**
 * The digest that binds a held act to exactly one change: its workspace, its verb, the things it names, where they go,
 * the name they take and, for New, the kind it makes. A host that runs a held act for another checks it before it runs.
 */
export function changeDigest(change: { workspaceId: string; verb: FileVerb; refs: readonly unknown[]; to?: unknown; name?: string; kind?: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([change.workspaceId, change.verb, change.refs, change.to ?? null, change.name ?? null, change.kind ?? null]))
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
  /**
   * others can open one end of it by its real path (`locatedShared`), whatever its place says it is: a workspace
   * kept in OneDrive. The hold and a key's `approve` read it; his window's question reads the places alone.
   */
  othersOpen?: boolean
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
  const shared = from.shared || !!entry?.shared || (!!to && to.shared) || !!change.othersOpen
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

/** The generic `fs.*` verbs that change a disk, and every path each one names. */
const FS_WRITES: Record<string, (p: Record<string, string>) => string[]> = {
  'fs.createPath': (p) => [p.parent!, join(p.parent!, p.name!)],
  'fs.renamePath': (p) => [p.path!, join(dirname(p.path!), p.name!)],
  'fs.deletePath': (p) => [p.path!],
  'fs.copyPath': (p) => [p.from!, p.destParent!],
  'fs.movePath': (p) => [p.from!, p.destParent!],
  'fs.writeText': (p) => [p.path!]
}
export const FS_SHARED = 'That is in a place others can open (Teams, OneDrive): change it in Files, where the change is asked first.'

/** A path by its real spelling, where the path itself may not be made yet: its nearest folder that is, and the rest. */
function realish(path: string): string {
  const named = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  const rest: string[] = []
  let at = named
  for (let i = 0; i < 64; i++) {
    const found = real(at)
    if (found) return join(found, ...rest.reverse())
    const up = dirname(at)
    if (up === at) break
    rest.push(basename(at))
    at = up
  }
  return named
}

/**
 * The listener's last word on a remote key's `fs.*` write (src/main/server/index.ts, after the root fence): a path
 * inside a library others can open (`sharedOf`) is refused, wherever the roots let it through (a Work workspace
 * kept inside a OneDrive folder, a project at the home folder). Files' own verbs are the way to change such a place,
 * and they ask first or hold. Null for any other method or path.
 */
export function fsPathRefusal(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, method: string, params: unknown): string | null {
  const paths = FS_WRITES[method]
  if (!paths || !params || typeof params !== 'object') return null
  for (const path of paths(params as Record<string, string>)) {
    if (typeof path !== 'string' || !path) continue
    if (sharedOf(ctx, { at: 'file', host: ctx.host, path: realish(path) })) return FS_SHARED
  }
  return null
}
