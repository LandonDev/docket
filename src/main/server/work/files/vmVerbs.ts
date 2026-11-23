import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { FileDone, FileMakeKind } from '@shared/contract-work-files'
import { freeName, UNTITLED, type FileEntry } from '@shared/work/files'
import type { WorkCtx } from '../modules'
import { entryOfGuest, vmList, type GuestEntry } from '../office/vm/files'
import { vmCall, VmUnreachable } from '../office/vm/link'
import { filesState, withMarks } from './handle'
import { fileMakerFor } from './hooks'
import { formIn, MAKER_KIND } from './make'
import { fileMoved } from './moved'
import { forgetVmList, libraryEntry, libraryKey, rowOfGuest, type LibraryPlace } from './places/teams'
import type { DoorPlace } from './policy'
import { fileLocked, FileRefused, OpLost, withFileLocks } from './write'

/**
 * New, rename, move, edit and delete in a library OneDrive syncs in the Windows VM this host keeps
 * (docs/agents/work-files.md "The Windows VM's verbs"). The verbs of verbs.ts and trash.ts come here once the
 * door has admitted the change and their own operation id is journalled (`runOp`): each thing is changed by the
 * guest's helper (native/tc-office-win/TcOffice.cs, `files.mkdir`, `files.rename`, `files.move`, `files.write`,
 * `files.recycle`), which holds both ends to OneDrive's mounts again and journals the change under an operation id
 * made from this one. An answer lost on the way back is asked again by that same id, which the helper answers
 * without doing it twice; lost again, it is `OpLost`, and the same id from the caller asks once more.
 */

/** A located file or folder in the VM: its place there and its key. */
export interface VmWhere {
  path: string
  place: DoorPlace
  library: LibraryPlace
  key: string
}

const WRITING = 'A thread is writing in this file. Try when it is done.'
const PLACE_ITSELF = 'A place itself cannot be renamed or moved.'
export const VM_NO_TEMPLATE = 'A file in the Windows VM is made blank. Make it from a template in your workspace\'s folder.'

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('\\'))
const baseOf = (path: string): string => path.slice(path.lastIndexOf('\\') + 1)
const inDir = (dir: string, name: string): string => `${dir.replace(/\\+$/, '')}\\${name}`
const sameGuest = (a: string, b: string): boolean => a.replace(/\\+$/, '').toLowerCase() === b.replace(/\\+$/, '').toLowerCase()
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Whether a thing is a place's own top (a channel's folder, a library's): never renamed, moved or deleted. */
export const isTop = (w: VmWhere): boolean => sameGuest(w.path, w.library.top) || sameGuest(w.path, w.library.library.path)

/** The guest's operation id for one thing of a change: the change's own id, and the thing's place in it. */
export const guestOp = (op: string, i = 0): string => `tc-files:${op}:${i}`

/** How long one change in the guest may take: a recycle of a big folder is the longest. */
const CHANGE_MS = 120_000

/**
 * One change in the guest, under its operation id. A lost answer (the link dropped after the request went, the
 * machine did not answer in time) is asked once more with the same id: the helper's journal answers what the first
 * did, or does it now if it never arrived. Lost twice, nothing is known here: `OpLost`.
 */
export async function guestChange<T>(verb: string, args: Record<string, unknown> & { op: string }, signal?: AbortSignal): Promise<T> {
  try {
    return (await vmCall(verb, args, { timeoutMs: CHANGE_MS, signal })) as T
  } catch (err) {
    if (!(err instanceof VmUnreachable)) throw err
  }
  try {
    return (await vmCall(verb, args, { timeoutMs: CHANGE_MS, signal })) as T
  } catch (again) {
    if (again instanceof VmUnreachable) throw new OpLost(`${again.message} Try again: the same change is asked of it once.`)
    throw again
  }
}

/** A thing the guest answered, as a listing row of its place, with his marks. */
function entryOf(ctx: WorkCtx, workspaceId: string, at: LibraryPlace, e: GuestEntry): FileEntry {
  return withMarks(filesState(ctx), workspaceId, [libraryEntry(at, dirOf(e.path), rowOfGuest(entryOfGuest(at.library.id, e)))])[0]!
}

/** Each changed folder: what was kept of its listing goes, and every window that may read hears that it changed (a guest path is named by any key that may read, as a listing is). */
function said(ctx: WorkCtx, workspaceId: string, at: LibraryPlace, dirs: Iterable<string>): void {
  for (const dir of new Set(dirs)) {
    forgetVmList(at.library.id, dir)
    try {
      ctx.push({ push: 'work.files', workspaceId, at: libraryKey(at, dir) }, { need: 'read' })
    } catch (err) {
      ctx.log(`files: a changed folder's push failed: ${message(err)}`)
    }
  }
}

/** New in a VM folder: a folder, a text file, or an Office file a maker writes, named as on this host, never over anything. */
export async function vmMake(ctx: WorkCtx, workspaceId: string, folder: VmWhere, p: { kind: FileMakeKind; name?: string; op: string }): Promise<FileDone> {
  const form = formIn(folder.place, p.kind)
  const ext = form ? `.${form}` : ''
  const named = p.name?.trim()
  const wanted = named ? (ext && !named.toLowerCase().endsWith(ext) ? `${named}${ext}` : named) : `${UNTITLED[p.kind]}${ext}`
  // NTFS and OneDrive read names case-blind: the free name is found so.
  const names = new Set((await vmList(folder.library.library, folder.path)).map((e) => e.name.normalize('NFC').toLowerCase()))
  const name = freeName(wanted, (n) => names.has(n.normalize('NFC').toLowerCase()))
  const made = await withFileLocks([libraryKey(folder.library, inDir(folder.path, name))], async () => {
    if (p.kind === 'folder') return (await guestChange<{ entry: GuestEntry }>('files.mkdir', { dir: folder.path, name, op: guestOp(p.op) })).entry
    const data = p.kind === 'text' || !form ? Buffer.alloc(0) : await makerBytes(ctx, p.kind, form, name.slice(0, name.length - ext.length))
    return (await guestChange<{ entry: GuestEntry }>('files.write', { dir: folder.path, name, data: data.toString('base64'), op: guestOp(p.op) })).entry
  })
  said(ctx, workspaceId, folder.library, [folder.path])
  return { entries: [entryOf(ctx, workspaceId, folder.library, made)], refused: [], op: p.op }
}

/** A blank Office file from its kind's maker, written in a private folder here and read back. */
async function makerBytes(ctx: WorkCtx, kind: Exclude<FileMakeKind, 'folder' | 'text'>, form: NonNullable<ReturnType<typeof formIn>>, title: string): Promise<Buffer> {
  const canvasKind = MAKER_KIND[kind]
  const maker = canvasKind ? fileMakerFor(canvasKind, form) : null
  if (!maker) throw new Error(`Nothing here makes a .${form} file for the Windows VM.`)
  const stage = join(ctx.dataDir, 'work-files', 'staging', randomUUID())
  mkdirSync(stage, { recursive: true })
  try {
    const staged = join(stage, `blank.${form}`)
    await maker.blank({ form, path: staged, title })
    return readFileSync(staged)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** Rename in the VM: the same folder, his whole new name, never over anything; what hangs on the file follows it. */
export async function vmRename(ctx: WorkCtx, workspaceId: string, w: VmWhere, name: string, op: string): Promise<FileDone> {
  const dir = dirOf(w.path)
  const to = inDir(dir, name)
  const key = libraryKey(w.library, to)
  const moved = await withFileLocks([w.key, key], async () => {
    const e = (await guestChange<{ entry: GuestEntry }>('files.rename', { path: w.path, name, op: guestOp(op) })).entry
    carry(ctx, w, e, key)
    return e
  })
  said(ctx, workspaceId, w.library, [dir])
  return { entries: [entryOf(ctx, workspaceId, w.library, moved)], refused: [], op }
}

/** Carries what hangs on a moved thing (its items, star, recent, tab) to where the guest says it went. The thing has moved already; a fault here is said, not undone in the guest. */
function carry(ctx: WorkCtx, w: VmWhere, e: GuestEntry, key: string): void {
  if (sameGuest(e.path, w.path) && e.path === w.path) return
  try {
    fileMoved(ctx, { path: w.path, key: w.key }, { path: e.path, key }, { folder: e.dir })
  } catch (err) {
    ctx.log(`files: what hangs on ${baseOf(w.path)} could not follow it in the Windows VM: ${message(err)}`)
  }
}

/** Move inside one place of the VM: each thing one move into the folder; a taken name is that thing's refused row, and the rest still move. */
export async function vmMove(ctx: WorkCtx, workspaceId: string, all: readonly VmWhere[], to: VmWhere, op: string): Promise<FileDone> {
  const done: GuestEntry[] = []
  const refused: FileDone['refused'] = []
  const changed = new Set<string>([to.path])
  for (const [i, w] of all.entries()) {
    const name = baseOf(w.path)
    try {
      if (isTop(w)) throw new Error(PLACE_ITSELF)
      if (fileLocked(w.key)) throw new Error(WRITING)
      const key = libraryKey(to.library, inDir(to.path, name))
      done.push(
        await withFileLocks([w.key, key], async () => {
          const e = (await guestChange<{ entry: GuestEntry }>('files.move', { path: w.path, dir: to.path, op: guestOp(op, i) })).entry
          carry(ctx, w, e, key)
          return e
        })
      )
      changed.add(dirOf(w.path))
    } catch (err) {
      // A lost answer is the whole change's: nothing is said done or refused that is not known.
      if (err instanceof OpLost) throw err
      refused.push({ name, text: message(err) })
    }
  }
  said(ctx, workspaceId, to.library, changed)
  return { entries: done.map((e) => entryOf(ctx, workspaceId, to.library, e)), refused, op }
}

/** What a save in the VM answers: as `saveFile` does on this host (save.ts `Saved`). */
export type VmSaved = { version: string; changed: number } | { conflict: { version: string; changed: number } | { gone: true } }

/** An editor's save of a file in the VM: its bytes replaced only while it is still the version `expect` names, written beside and renamed over it there. */
export async function vmSave(ctx: WorkCtx, workspaceId: string, w: VmWhere, data: Uint8Array, expect: string, op: string): Promise<VmSaved> {
  return withFileLocks([w.key], async () => {
    const got = await guestChange<{ version: string; changed: number; entry: GuestEntry } | { conflict: { version: string; changed: number } | { gone: true } }>('files.write', {
      path: w.path,
      data: Buffer.from(data).toString('base64'),
      expect,
      op: guestOp(op)
    })
    if ('conflict' in got) return { conflict: got.conflict }
    said(ctx, workspaceId, w.library, [dirOf(w.path)])
    return { version: got.version, changed: got.changed }
  })
}

/** A file's bytes and its version, read through the helper for his own window's editor. */
export async function vmReadVersioned(path: string, offset: number, length: number, version?: string, signal?: AbortSignal): Promise<{ data: string; size: number; version: string; changed: number; end: boolean }> {
  const got = (await vmCall('files.read', { path, offset, length, version: true }, { signal })) as { data: string; size: number; eof: boolean; version: string; changed: number }
  if (version !== undefined && version !== got.version) throw new Error('That file changed while it was read. Open it again.')
  return { data: got.data, size: got.size, version: got.version, changed: got.changed, end: got.eof }
}

/**
 * A delete in the VM: to the Windows Recycle Bin, from where OneDrive takes it to the library's own bin; never
 * deleted for good (the helper refuses where Windows would). A row with `provider: 'onedrive'` and no bytes here is
 * kept for each, so Trash lists it; Put back says to put it back from the recycle bin.
 */
export async function vmRecycle(ctx: WorkCtx, workspaceId: string, w: VmWhere, op: string, i: number): Promise<string> {
  if (isTop(w)) throw new FileRefused('busy', 'A place itself cannot be deleted.')
  if (fileLocked(w.key)) throw new FileRefused('busy', WRITING)
  return withFileLocks([w.key], async () => {
    const id = randomUUID()
    const file = { at: 'file', host: ctx.host, path: w.path }
    ctx.db
      .prepare(`INSERT INTO work_files_trash (id, workspace_id, ref, name, place, was_at, state, deleted_at, by, provider) VALUES (?, ?, ?, ?, ?, ?, 'moving', ?, 'owner', 'onedrive')`)
      .run(id, workspaceId, JSON.stringify(file), baseOf(w.path), w.place.id, JSON.stringify({ ...file, path: dirOf(w.path) }), Date.now())
    try {
      await guestChange('files.recycle', { path: w.path, op: guestOp(op, i) })
    } catch (err) {
      // Refused or lost, no row stands for it: the same id again asks the guest, which answers what it did, and that makes the row.
      ctx.db.prepare(`DELETE FROM work_files_trash WHERE id = ?`).run(id)
      throw err
    }
    ctx.db.prepare(`UPDATE work_files_trash SET state = 'held' WHERE id = ? AND state = 'moving'`).run(id)
    said(ctx, workspaceId, w.library, [dirOf(w.path)])
    return id
  })
}
