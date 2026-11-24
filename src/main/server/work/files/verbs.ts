import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { FileDone, FileMakeKind, FileRef } from '@shared/contract-work-files'
import type { CanvasSource } from '@shared/work'
import { extOf, freeName, PLACE, questionFor, refKey, refusal, UNTITLED, type FileEntry, type FolderRef } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { doorPlace, filesState, placeRoot, withMarks } from './handle'
import { fileMakerFor } from './hooks'
import { blankOf, formIn, MAKER_KIND, notOffered, offersIn, templateExts, templateRefused } from './make'
import { fileMoved } from './moved'
import { folderEntry } from './places/folder'
import { trashAfterMove as trashSource } from './trash'
import { libraryEntry, libraryKey, teamsPlaces, type LibraryPlace } from './places/teams'
import { admitCaller, ASK_FIRST, locate, NO_WORKSPACE, workspaceHere, type DoorPlace, type WorkspaceRow } from './policy'
import { isTop, vmMake, vmMove, vmRename, VM_NO_TEMPLATE, type VmWhere } from './vmVerbs'
import { accountOfPlace } from './places/drive'
import { DRIVE_APART } from './driveVerbs'
import { checkName, copyNoReplace, fileLocked, makeFile, makeFolder, moveNoReplace, runOp, withFileLocks, type WriteFence } from './write'

/**
 * New, rename, move and copy (docs/agents/work-files.md "New, rename, move and copy"), for the workspace's folder
 * and a library OneDrive syncs on this host. Each comes here after the door (`admitChange`, handle.ts) and runs
 * under its operation id (`runOp`), with the file's lock held (`withFileLocks`), through write.ts, which never
 * writes over anything. It answers the things as they are now and what could not be done, file by file, and
 * tells each changed folder's watchers.
 */

const NOT_A_FOLDER = 'That is a file, not a folder.'
const NOT_A_FILE = 'That is a folder, not a file.'
const NOT_BUILT_PLACE = 'That place is not read by this build yet.'
const WRITING = 'A thread is writing in this file. Try when it is done.'
const PLACE_ITSELF = 'A place itself cannot be renamed or moved.'

// ── seams ─────────────────────────────────────────────────────────────

/** Puts the source of a move across places in Trash, once its copy is checked (trash.ts). A test may stand in for it. */
export type TrashAfterMove = (ctx: WorkCtx, workspace: WorkspaceRow, sourcePath: string, op: string) => Promise<void>
const TO_TRASH: TrashAfterMove = (ctx, workspace, sourcePath, op) => trashSource(ctx, workspace, sourcePath, op).then(() => undefined)
let trashHook: TrashAfterMove = TO_TRASH
/** Tests only: how a moved file's source goes to Trash; null puts Trash itself back. */
export const setTrashHook = (fn: TrashAfterMove | null): void => void (trashHook = fn ?? TO_TRASH)
export const trashAfterMove: TrashAfterMove = (ctx, workspace, sourcePath, op) => trashHook(ctx, workspace, sourcePath, op)

/** Whether this host has Excel, which stands behind the grid for a library's `.xlsx`: on a Mac, by its app. */
let excelHere = (): boolean => process.platform === 'darwin' && existsSync('/Applications/Microsoft Excel.app')
/** Tests only. */
export const setExcelHere = (fn: (() => boolean) | null): void => void (excelHere = fn ?? (() => process.platform === 'darwin' && existsSync('/Applications/Microsoft Excel.app')))

/** What New offers in a place of this host now: the kinds that open ready to edit there. */
export const offeredIn = (place: Pick<DoorPlace, 'kind' | 'vm' | 'can'>): FileMakeKind[] => offersIn(place, (kind, form) => fileMakerFor(kind, form) !== null, excelHere())

// ── where things are ──────────────────────────────────────────────────

/** A located file or folder of this host: its place, its key, and the fence root a write in it may touch. */
interface Where {
  path: string
  place: DoorPlace
  library?: LibraryPlace
  /** the place's top: never renamed or moved */
  top: string
  /** the real folder a write here stays inside: the workspace's folder, or the library */
  root: string
  key: string
  /** in a library OneDrive syncs in the Windows VM: a guest path, changed by the guest's helper (vmVerbs.ts) */
  vm?: boolean
}

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function where(ctx: WorkCtx, by: Caller, workspaceId: string, ref: FileRef, method: string): Where {
  const at = locate(ctx, by, workspaceId, ref.at === 'place' ? placeRoot(ctx, by, workspaceId, ref.id) : ref, method)
  if (at.in === 'place') throw new Error(NOT_BUILT_PLACE)
  if (at.in === 'drive') throw new Error(DRIVE_APART)
  const { place, library } = doorPlace(ctx, by, at)
  if (at.in === 'folder') return { path: at.path, place, top: at.root, root: at.root, key: refKey({ at: 'file', host: ctx.host, path: at.path }) }
  if (at.library.vm) return { path: at.path, place, library, top: library!.top, root: at.library.path, key: libraryKey(library!, at.path), vm: true }
  return { path: at.path, place, library, top: real(library!.top), root: real(at.library.path), key: libraryKey(library!, at.path) }
}

/** The key a path would have in the same place as `w`. */
const keyIn = (ctx: WorkCtx, w: Where, path: string): string => (w.library ? libraryKey(w.library, path) : refKey({ at: 'file', host: ctx.host, path }))

/** Where New makes a thing: a folder or a place's top; a lens (Recent, Starred, Home…) means the workspace's folder. */
export function makeFolderRef(ctx: WorkCtx, by: Caller, at: FolderRef): FolderRef {
  if (at.at !== 'place' || at.id === PLACE.folder || accountOfPlace(at.id)) return at
  return teamsPlaces(ctx, by).places.some((l) => l.place.id === at.id) ? at : { at: 'place', id: PLACE.folder }
}

/** A thing as a listing shows it now, or null when it is gone. */
async function entryOf(ctx: WorkCtx, by: Caller, workspaceId: string, path: string, method: string): Promise<FileEntry | null> {
  const w = where(ctx, by, workspaceId, { at: 'file', host: ctx.host, path }, method)
  const row = await filesState(ctx).lister.row(w.path)
  if (!row) return null
  const entry = w.library ? libraryEntry(w.library, dirname(w.path), row) : folderEntry(ctx.host, dirname(w.path), row)
  return withMarks(filesState(ctx), workspaceId, [entry])[0]!
}

/** Each changed folder: what was kept of it goes, and whoever could name it hears that it changed. */
function said(ctx: WorkCtx, by: Caller, workspaceId: string, dirs: Iterable<string>, method: string): void {
  const state = filesState(ctx)
  for (const dir of new Set(dirs)) {
    state.lister.forget(dir)
    try {
      const w = where(ctx, by, workspaceId, { at: 'file', host: ctx.host, path: dir }, method)
      ctx.push({ push: 'work.files', workspaceId, at: w.key }, { need: 'read', path: dir })
    } catch (err) {
      ctx.log(`files: a changed folder's push failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** A name nothing in `dir` has, read case-blind (APFS, NTFS and OneDrive read names so). */
function freeIn(dir: string, name: string): string {
  const names = new Set(readdirSync(dir).map((n) => n.normalize('NFC').toLowerCase()))
  return freeName(name, (n) => names.has(n.normalize('NFC').toLowerCase()))
}

/** A held act's press (`origin.from: 'act'`) makes the name its card showed, or nothing: another free name is no change he saw. */
const pressedAct = (p: { origin?: { from?: string } }): boolean => p.origin?.from === 'act'
export const NAME_TAKEN = (name: string): string => `Something named ${name} is there now, so nothing was made: the press makes only the name it showed.`
export const isNameTaken = (text: string): boolean => /^Something named .+ is there now, so nothing was made: the press makes only the name it showed\.$/.test(text)
/** `name` in `dir`, read case-blind as `freeIn` reads it, or the refusal that it is taken. */
function exactIn(dir: string, name: string): string {
  if (freeIn(dir, name) !== name) throw new Error(NAME_TAKEN(name))
  return name
}

/** A located thing in the VM, as vmVerbs.ts takes it. */
const vmOf = (w: Where): VmWhere => ({ path: w.path, place: w.place, library: w.library!, key: w.key })
/** The grammar's own sentence for a verb a place does not carry out. */
const cannotIn = (place: DoorPlace, verb: 'copy'): string => refusal(place, verb)?.text ?? 'That cannot be done here.'

const fenceOf = (...roots: string[]): WriteFence => ({ roots: [...new Set(roots)] })
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const asFolder = (w: Where): void => {
  if (!statSync(w.path).isDirectory()) throw new Error(NOT_A_FOLDER)
}

// ── the verbs ─────────────────────────────────────────────────────────

interface Change {
  workspaceId: string
  op: string
  /** where the change began: a held act's press is held to the names it showed */
  origin?: { from?: string }
}
type MakeAsk = Change & { at: FolderRef; kind: FileMakeKind; name?: string; from?: CanvasSource; asked?: boolean }
type RenameAsk = Change & { ref: FileRef; name: string }
type MoveAsk = Change & { refs: FileRef[]; to: FolderRef }
type Verb = 'make' | 'rename' | 'move' | 'copy'

/** What the journal keeps of a change, so the same change again is known by it. */
const journalled = (verb: Verb, p: Partial<MakeAsk & RenameAsk & MoveAsk>): unknown =>
  verb === 'make' ? { at: p.at, kind: p.kind, name: p.name ?? null, from: p.from ?? null } : verb === 'rename' ? { ref: p.ref, name: p.name } : { refs: p.refs, to: p.to }

/**
 * A change this operation id already finished answers what it did, before anything is looked up again: after a
 * rename the old name is gone, so a retry that located it first would fail. Only the same change in the same
 * workspace is answered so, never to a thread; anything else goes through the door as new.
 */
export function replayed(ctx: WorkCtx, by: Caller, verb: Verb, p: Change & Partial<MakeAsk & RenameAsk & MoveAsk>): Promise<FileDone> | null {
  if (by.kind === 'model') return null
  admitCaller(ctx, by, p.workspaceId)
  const refs = journalled(verb, p)
  const done = ctx.db.prepare(`SELECT 1 FROM work_files_ops WHERE id = ? AND workspace_id = ? AND verb = ? AND refs = ? AND state != 'running'`).get(p.op, p.workspaceId, verb, JSON.stringify(refs))
  return done ? runOp<FileDone>(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb, refs }, () => Promise.reject(new Error('This change is still under way.'))) : null
}

/**
 * The real path of a file the templates pillar keeps in its scratch folder (`<userData>/work-templates/scratch`),
 * or null: only a regular file that truly lies inside it, whatever links its name passes through.
 */
function templateScratch(ctx: Pick<WorkCtx, 'dataDir' | 'host'>, from: CanvasSource): string | null {
  if (from.at !== 'file' || from.host !== ctx.host) return null
  try {
    const root = realpathSync(join(ctx.dataDir, 'work-templates', 'scratch'))
    const path = realpathSync(from.path)
    return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`) ? path : null
  } catch {
    return null
  }
}

/** New: a document, sheet, deck, text file or folder in the folder, in the form its place keeps, named for its kind unless he named it. */
export async function makeVerb(ctx: WorkCtx, by: Caller, p: MakeAsk, method: string): Promise<FileDone> {
  const folder = where(ctx, by, p.workspaceId, makeFolderRef(ctx, by, p.at), method)
  if (folder.vm) {
    // In the Windows VM: what New offers there, made blank by the guest's helper (a folder there is the guest's to check).
    if (!offersIn(folder.place, (kind, form) => fileMakerFor(kind, form) !== null).includes(p.kind)) throw new Error(notOffered(folder.place, p.kind))
    if (p.from && p.kind !== 'folder') throw new Error(VM_NO_TEMPLATE)
    const named = p.name?.trim()
    if (named) checkName(named)
    return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'make', refs: journalled('make', p) }, () => vmMake(ctx, p.workspaceId, vmOf(folder), { kind: p.kind, name: named, op: p.op }))
  }
  asFolder(folder)
  if (!offersIn(folder.place, (kind, form) => fileMakerFor(kind, form) !== null, excelHere()).includes(p.kind)) throw new Error(notOffered(folder.place, p.kind))
  const form = formIn(folder.place, p.kind)
  let template: string | null = null
  let ext = form ? `.${form}` : ''
  if (p.from && p.kind !== 'folder') {
    // A template the templates pillar filled for this make lies in its own scratch folder, which is no place of the
    // workspace: it is that pillar's to hand over (SEAMS.md "templates"), so it is read where it lies and no rule
    // between places is asked. Anything else is a file of a place, located for the caller as every source is.
    const scratch = templateScratch(ctx, p.from)
    const from = scratch ? { path: scratch, place: folder.place } : where(ctx, by, p.workspaceId, p.from, method)
    if (statSync(from.path).isDirectory()) throw new Error(NOT_A_FILE)
    // A template from another place is a copy of it: Teams files stay in Teams, and one into a shared place is asked first.
    if (from.place.id !== folder.place.id) {
      const no = refusal(from.place, 'copy', null, folder.place)
      if (no) throw new Error(no.text)
      if (questionFor(from.place, 'copy', null, folder.place) !== null && !p.asked) throw new Error(ASK_FIRST)
    }
    const fromExt = extOf(from.path)
    if (!(templateExts(folder.place, p.kind) as readonly string[]).includes(fromExt)) throw new Error(templateRefused(folder.place, p.kind, basename(from.path)))
    template = from.path
    ext = `.${fromExt}`
  }
  const named = p.name?.trim()
  if (named) checkName(named)
  return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'make', refs: journalled('make', p) }, async () => {
    const wanted = named ? (ext && !named.toLowerCase().endsWith(ext) ? `${named}${ext}` : named) : `${UNTITLED[p.kind]}${ext}`
    const name = named && pressedAct(p) ? exactIn(folder.path, wanted) : freeIn(folder.path, wanted)
    const fence = fenceOf(folder.root)
    const made = await withFileLocks([keyIn(ctx, folder, join(folder.path, name))], async () => {
      if (p.kind === 'folder') return makeFolder(fence, folder.path, name)
      if (template) return makeFile(fence, folder.path, name, { from: template })
      const kind = MAKER_KIND[p.kind]
      const maker = kind && form ? fileMakerFor(kind, form) : null
      if (!maker || !form) return makeFile(fence, folder.path, name, blankOf(form!))
      // A maker writes in a private folder of its own; what it wrote is then put in the place, never over anything.
      const stage = join(ctx.dataDir, 'work-files', 'staging', randomUUID())
      mkdirSync(stage, { recursive: true })
      try {
        const staged = join(stage, `blank.${form}`)
        await maker.blank({ form, path: staged, title: name.slice(0, name.length - ext.length) })
        return await makeFile(fence, folder.path, name, { from: staged })
      } finally {
        rmSync(stage, { recursive: true, force: true })
      }
    })
    said(ctx, by, p.workspaceId, [folder.path], method)
    const entry = await entryOf(ctx, by, p.workspaceId, made, method)
    return { entries: entry ? [entry] : [], refused: [], op: p.op } satisfies FileDone
  })
}

/** Moves one thing to `dir`/`name` in its own place and carries what hangs on it; a fault in the carrying moves it back. */
async function moveInside(ctx: WorkCtx, w: Where, fence: WriteFence, dir: string, name: string, key: string): Promise<string> {
  const moved = await moveNoReplace(fence, w.path, dir, name)
  if (moved === w.path) return moved
  try {
    fileMoved(ctx, { path: w.path, key: w.key }, { path: moved, key })
  } catch (err) {
    await moveNoReplace(fence, moved, dirname(w.path), basename(w.path)).catch((back) => ctx.log(`files: ${basename(w.path)} could not be moved back after a fault: ${message(back)}`))
    throw err
  }
  return moved
}

/** Rename: the same folder, a new name, never over anything. A name that differs only by case is a rename. */
export async function renameVerb(ctx: WorkCtx, by: Caller, p: RenameAsk, method: string): Promise<FileDone> {
  const w = where(ctx, by, p.workspaceId, p.ref, method)
  if (w.vm ? isTop(vmOf(w)) : w.path === w.top || w.path === w.root) throw new Error(PLACE_ITSELF)
  checkName(p.name)
  if (fileLocked(w.key)) throw new Error(WRITING)
  if (w.vm) return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'rename', refs: journalled('rename', p) }, () => vmRename(ctx, p.workspaceId, vmOf(w), p.name, p.op))
  return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'rename', refs: journalled('rename', p) }, async () => {
    const dir = dirname(w.path)
    const to = join(dir, p.name)
    const key = keyIn(ctx, w, to)
    const moved = await withFileLocks([w.key, key], () => moveInside(ctx, w, fenceOf(w.root), dir, p.name, key))
    said(ctx, by, p.workspaceId, [dir], method)
    const entry = await entryOf(ctx, by, p.workspaceId, moved, method)
    return { entries: entry ? [entry] : [], refused: [], op: p.op } satisfies FileDone
  })
}

/**
 * Move: inside one place each thing is one rename into the folder; a taken name is that thing's refused row and
 * the rest still move. Across places (the workspace's folder into a library) it is a copy, checked, what hangs on
 * the file carried to the copy, then the source to Trash; a failed Trash takes the copy away again.
 */
export async function moveVerb(ctx: WorkCtx, by: Caller, p: MoveAsk, method: string): Promise<FileDone> {
  const to = where(ctx, by, p.workspaceId, p.to, method)
  const all = p.refs.map((ref) => where(ctx, by, p.workspaceId, ref, method))
  if (to.vm || all.some((w) => w.vm)) {
    // Within one place of the VM: the door has refused a move across places, which no VM place takes.
    if (!to.vm || all.some((w) => !w.vm || w.place.id !== to.place.id)) throw new Error('Files in the Windows VM move only within their place.')
    return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'move', refs: journalled('move', p) }, () => vmMove(ctx, p.workspaceId, all.map(vmOf), vmOf(to), p.op))
  }
  asFolder(to)
  const workspace = workspaceHere(ctx.db, p.workspaceId)
  return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'move', refs: journalled('move', p) }, async () => {
    const done: string[] = []
    const refused: FileDone['refused'] = []
    const changed = new Set<string>([to.path])
    for (const w of all) {
      const name = basename(w.path)
      try {
        if (w.path === w.top || w.path === w.root) throw new Error(PLACE_ITSELF)
        if (fileLocked(w.key)) throw new Error(WRITING)
        const key = keyIn(ctx, to, join(to.path, name))
        if (w.place.id === to.place.id) {
          done.push(await withFileLocks([w.key, key], () => moveInside(ctx, w, fenceOf(w.root, to.root), to.path, name, key)))
        } else {
          if (!workspace) throw new Error(NO_WORKSPACE)
          done.push(await withFileLocks([w.key, key], () => moveAcross(ctx, workspace, w, to, name, key, p.op)))
        }
        changed.add(dirname(w.path))
      } catch (err) {
        refused.push({ name, text: message(err) })
      }
    }
    said(ctx, by, p.workspaceId, changed, method)
    const entries = (await Promise.all(done.map((path) => entryOf(ctx, by, p.workspaceId, path, method)))).filter((e): e is FileEntry => e !== null)
    return { entries, refused, op: p.op } satisfies FileDone
  })
}

/** One thing moved to another place: copied and checked, carried, then its source to Trash. */
async function moveAcross(ctx: WorkCtx, workspace: WorkspaceRow, w: Where, to: Where, name: string, key: string, op: string): Promise<string> {
  const copy = await copyNoReplace(fenceOf(w.root, to.root), w.path, to.path, name)
  const drop = (): void => rmSync(copy, { recursive: true, force: true })
  try {
    fileMoved(ctx, { path: w.path, key: w.key }, { path: copy, key })
  } catch (err) {
    drop()
    throw err
  }
  try {
    await trashAfterMove(ctx, workspace, w.path, op)
  } catch (err) {
    // The source stays where it was: what was carried goes back to it, and the copy goes.
    try {
      fileMoved(ctx, { path: copy, key }, { path: w.path, key: w.key })
    } catch (back) {
      ctx.log(`files: what hangs on ${name} could not be carried back: ${message(back)}`)
    }
    drop()
    throw err
  }
  return copy
}

/** Copy: each thing into the folder; a name there already gets the next free one ("Name 2"), since a copy never means to replace. */
export async function copyVerb(ctx: WorkCtx, by: Caller, p: MoveAsk, method: string): Promise<FileDone> {
  const to = where(ctx, by, p.workspaceId, p.to, method)
  if (to.vm) throw new Error(cannotIn(to.place, 'copy'))
  asFolder(to)
  const all = p.refs.map((ref) => where(ctx, by, p.workspaceId, ref, method))
  return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'copy', refs: journalled('copy', p) }, async () => {
    const done: string[] = []
    const refused: FileDone['refused'] = []
    for (const w of all) {
      const name = basename(w.path)
      try {
        if (w.path === w.root) throw new Error('A place itself cannot be copied.')
        const free = pressedAct(p) ? exactIn(to.path, name) : freeIn(to.path, name)
        done.push(await withFileLocks([w.key, keyIn(ctx, to, join(to.path, free))], () => copyNoReplace(fenceOf(w.root, to.root), w.path, to.path, free)))
      } catch (err) {
        refused.push({ name, text: message(err) })
      }
    }
    if (done.length) said(ctx, by, p.workspaceId, [to.path], method)
    const entries = (await Promise.all(done.map((path) => entryOf(ctx, by, p.workspaceId, path, method)))).filter((e): e is FileEntry => e !== null)
    return { entries, refused, op: p.op } satisfies FileDone
  })
}
