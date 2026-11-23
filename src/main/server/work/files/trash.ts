import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync, type Stats } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { FileDone, FileRef } from '@shared/contract-work-files'
import { freeName, kindOfEntry, LIST_PAGE_MAX, PLACE, refKey, refusal, type FileEntry } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { doorPlace, filesState } from './handle'
import { libraryKey, teamsPlaces } from './places/teams'
import { vmRecycle } from './vmVerbs'
import { folderEntry, folderName } from './places/folder'
import { dropName } from './names'
import { locate, within, type WorkspaceRow } from './policy'
import { isGuestPath } from '../office/vm/files'
import { DRIVE_ROOT, driveOf, type DriveItem } from '../google/drive'
import { driveChanged, driveEntry, drivePlaceId, itemShared, kindOfItem } from './places/drive'
import { FileRefused, fileLocked, moveNoReplace, OpLost, runOp, withFileLocks } from './write'

/**
 * Trash for the workspace's own folder (docs/agents/work-files.md "Trash"). A delete is journalled in
 * `work_files_trash`: the row is written first (`moving`), the bytes move to
 * `<dataDir>/work-files/trash/<workspaceId>/<id>/<name>`, outside the folder so no thread's walk finds them,
 * and the row becomes `held`. Put back and Empty Trash each claim a row with one UPDATE that names the one state
 * it may leave (`held`), so a restore and a purge racing for a row never both win. `settleTrash` finishes or
 * undoes what a dead process left half done, and rows held 30 days are purged.
 */

export const TRASH_DAYS = 30
const DAY = 24 * 60 * 60 * 1000

type TrashCtx = Pick<WorkCtx, 'db' | 'host' | 'dataDir' | 'push' | 'log' | 'canvas'>
type LocateCtx = TrashCtx & Pick<WorkCtx, 'reaches' | 'scopeOf' | 'settings'>

export interface TrashRow {
  id: string
  workspace_id: string
  /** JSON: the file as it was, `{at:'file', host, path}` */
  ref: string
  name: string
  place: string
  /** JSON: the folder it lay in */
  was_at: string
  state: 'moving' | 'held' | 'restoring' | 'purging'
  held_at: number | null
  deleted_at: number
  by: string
  /** set for a row whose file sits in a provider's own bin (no bytes here) */
  provider: string | null
}

export const NOT_IN_TRASH = 'That is not in Trash any more.'
const WRITING = refusal({ id: PLACE.folder, kind: 'folder', name: '', host: '', env: '', shared: false, can: ['trash'], state: { state: 'ok' } }, 'trash', { name: '', kind: 'other', state: { is: 'writing' } })!.text

/** Where Trash keeps bytes on this host: under the data folder, never in a place. */
export const trashRoot = (dataDir: string): string => join(dataDir, 'work-files', 'trash')
const binOf = (dataDir: string, workspaceId: string, id: string): string => join(trashRoot(dataDir), workspaceId, id)
const pathOf = (json: string): string => (JSON.parse(json) as { path: string }).path
/** A row whose file sits in a Google Drive's own bin: its ref is a Google file or a Drive folder. */
const DRIVE_BIN = 'drive'
const inDriveBin = (row: Pick<TrashRow, 'provider'>): boolean => row.provider === DRIVE_BIN
const textOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const lstatOr = (path: string): Stats | null => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** The real path of a workspace's folder, or the refusal when it is gone. */
export function rootOf(workspace: WorkspaceRow): string {
  try {
    return realpathSync(workspace.path)
  } catch {
    throw new Error(`${workspace.name}'s folder is not there any more.`)
  }
}

const getRow = (ctx: Pick<WorkCtx, 'db'>, id: string): TrashRow | undefined => ctx.db.prepare(`SELECT * FROM work_files_trash WHERE id = ?`).get(id) as TrashRow | undefined
const dropRow = (ctx: Pick<WorkCtx, 'db'>, id: string): void => void ctx.db.prepare(`DELETE FROM work_files_trash WHERE id = ?`).run(id)
const holdRow = (ctx: Pick<WorkCtx, 'db'>, id: string, from: TrashRow['state']): void => void ctx.db.prepare(`UPDATE work_files_trash SET state = 'held', held_at = COALESCE(held_at, ?) WHERE id = ? AND state = ?`).run(Date.now(), id, from)
/** The claim: the row leaves `held` for `to` only if it is still held, and only for its own workspace. One caller wins. */
const claim = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string, id: string, to: 'restoring' | 'purging'): boolean =>
  Number(ctx.db.prepare(`UPDATE work_files_trash SET state = ? WHERE id = ? AND workspace_id = ? AND state = 'held'`).run(to, id, workspaceId).changes) === 1

/** A folder's listing changed: what was kept of it goes, and the windows that could name it hear so. */
function changed(ctx: TrashCtx, workspaceId: string, dir: string | null): void {
  const state = filesState(ctx)
  try {
    if (dir !== null) {
      state.lister.forget(dir)
      ctx.push({ push: 'work.files', workspaceId, at: refKey({ at: 'file', host: ctx.host, path: dir }) }, { need: 'read', path: dir })
    }
    ctx.push({ push: 'work.files', workspaceId, at: refKey({ at: 'place', id: PLACE.trash }) }, { need: 'read' })
  } catch (err) {
    ctx.log(`files: a Trash push failed: ${textOf(err)}`)
  }
}

/** A row's bytes are gone or still in place, and the row with them: whatever a half-done delete left is put right. */
async function settleMoving(ctx: TrashCtx, row: TrashRow): Promise<'held' | 'undone'> {
  if (inDriveBin(row)) {
    // A Drive delete a dead process left half asked: this host cannot tell whether Drive's bin took it, so no row
    // stands for it (the file is in its folder or in Drive's bin, which he can open; never lost).
    dropRow(ctx, row.id)
    return 'undone'
  }
  const source = lstatOr(pathOf(row.ref))
  if (row.provider) {
    // A delete in the Windows VM that a dead process left half asked: this disk cannot tell whether it reached the
    // Recycle Bin there, so no row stands for it (the file is in its folder or in the bin, never lost).
    const guest = isGuestPath(pathOf(row.ref)) && process.platform !== 'win32'
    if (source || guest) dropRow(ctx, row.id)
    else holdRow(ctx, row.id, 'moving')
    return source || guest ? 'undone' : 'held'
  }
  const bin = binOf(ctx.dataDir, row.workspace_id, row.id)
  const held = lstatOr(join(bin, row.name))
  // A folder copied to another disk whose source was half removed: both are kept, nothing is lost.
  const both = !!held && !!source && held.isDirectory() && source.isDirectory() && readdirSync(join(bin, row.name)).length > 0
  if (held && (!source || both)) {
    holdRow(ctx, row.id, 'moving')
    if (both) ctx.log(`files: ${row.name} is in Trash and part of it is still in its folder; both were kept`)
    return 'held'
  }
  // Nothing moved, or a copy was cut short: the file is still where it was.
  dropRow(ctx, row.id)
  await rm(bin, { recursive: true, force: true })
  return 'undone'
}

/** Closes the Files tabs that show this file, or anything inside this folder: their items go with them. */
function closeTabsOn(ctx: TrashCtx, workspace: WorkspaceRow, root: string, path: string): void {
  const state = filesState(ctx)
  const key = refKey({ at: 'file', host: ctx.host, path })
  for (const tab of state.tabs.list(workspace.id).tabs) {
    if (tab.kind !== 'file' || !tab.key || !(tab.key === key || tab.key.startsWith(`${key}${sep}`))) continue
    state.tabs.tabClose(workspace.id, tab.id, { at: { at: 'place', id: PLACE.folder }, name: folderName(workspace, root, root) })
  }
  state.tabs.sidesDrop(workspace.id, key, sep)
  state.tabs.seatsDrop(workspace.id, key, sep)
}

/** One file or folder of the workspace's folder (a real path inside `root`) to Trash. Answers its row's id. */
async function trashOne(ctx: TrashCtx, workspace: WorkspaceRow, root: string, path: string, locked = false): Promise<string> {
  const key = refKey({ at: 'file', host: ctx.host, path })
  // A move across places holds the file's lock already (`locked`): it is that move's own delete, not a second writer.
  if (!locked && fileLocked(key)) throw new FileRefused('busy', WRITING)
  const under = locked ? <T,>(_keys: readonly string[], fn: () => Promise<T>): Promise<T> => fn() : withFileLocks
  return under([key], async () => {
    closeTabsOn(ctx, workspace, root, path)
    // Go to forgets it at once, and everything under a folder.
    dropName(ctx.db, workspace.id, key)
    const id = randomUUID()
    const name = basename(path)
    const file = { at: 'file', host: ctx.host, path }
    ctx.db
      .prepare(`INSERT INTO work_files_trash (id, workspace_id, ref, name, place, was_at, state, deleted_at, by) VALUES (?, ?, ?, ?, ?, ?, 'moving', ?, 'owner')`)
      .run(id, workspace.id, JSON.stringify(file), name, PLACE.folder, JSON.stringify({ ...file, path: dirname(path) }), Date.now())
    try {
      const bin = binOf(ctx.dataDir, workspace.id, id)
      await mkdir(dirname(bin), { recursive: true, mode: 0o700 })
      await mkdir(bin, { mode: 0o700 })
      await moveNoReplace({ roots: [root, trashRoot(ctx.dataDir)] }, path, bin, name)
    } catch (e) {
      // Whatever got as far as Trash is settled as the boot check would: nothing is lost either way.
      await settleMoving(ctx, getRow(ctx, id)!)
      if (getRow(ctx, id)?.state !== 'held') throw e
    }
    holdRow(ctx, id, 'moving')
    changed(ctx, workspace.id, dirname(path))
    return id
  })
}

/** `work.files.trash`: each ref, already through the door, to Trash. What could not go is said file by file. */
export function trashFiles(ctx: LocateCtx, by: Caller, workspaceId: string, refs: FileRef[], op: string): Promise<FileDone> {
  return runOp(ctx.db, { id: op, workspaceId, verb: 'trash', refs }, async () => {
    const trashed: string[] = []
    const refused: FileDone['refused'] = []
    for (const [i, ref] of refs.entries()) {
      const at = locate(ctx, by, workspaceId, ref, 'work.files.trash')
      if (at.in === 'library' && at.library.vm) {
        // A delete in the Windows VM goes to its Recycle Bin (vmVerbs.ts); the door has let it through only where the place's `can` holds `trash`.
        try {
          const { library } = doorPlace(ctx as WorkCtx, by, at)
          trashed.push(await vmRecycle(ctx as WorkCtx, workspaceId, { path: at.path, place: library!.place, library: library!, key: libraryKey(library!, at.path) }, op, i))
        } catch (e) {
          if (e instanceof OpLost) throw e
          refused.push({ name: at.path.slice(at.path.lastIndexOf('\\') + 1), text: textOf(e) })
        }
        continue
      }
      if (at.in !== 'folder') {
        refused.push({ name: at.in === 'place' || at.in === 'drive' ? at.id : basename(at.path), text: 'Only a file of the workspace\'s folder goes to Trash here.' })
        continue
      }
      try {
        trashed.push(await trashOne(ctx, at.workspace, at.root, at.path))
      } catch (e) {
        refused.push({ name: basename(at.path), text: textOf(e) })
      }
    }
    return { entries: [], refused, trashed, op }
  })
}

/** For a move across places, once its copy is checked and with the file's lock held by that move: the source, a file of the workspace's folder, goes to Trash. Journalled under its own id within `op`, so a retry does it once. Answers its row id. */
export function trashAfterMove(ctx: TrashCtx, workspace: WorkspaceRow, path: string, op: string): Promise<string> {
  const id = `${op}/trash/${createHash('sha256').update(path).digest('hex').slice(0, 16)}`
  return runOp(ctx.db, { id, workspaceId: workspace.id, verb: 'trash', refs: [path] }, async () => {
    const root = rootOf(workspace)
    const real = realpathSync(path)
    if (!within(real, root) || real === root) throw new FileRefused('outside', "Only a file of the workspace's folder goes to Trash here.")
    return trashOne(ctx, workspace, root, real, true)
  })
}

/** Whether a caller could name where a row's file lay: a remote key hears of no row it could not. A Drive row is the workspace's, which a key reaches by its folder (`locate`). */
const visible = (ctx: Pick<WorkCtx, 'reaches'>, by: Caller, row: TrashRow, workspace?: Pick<WorkspaceRow, 'path'>): boolean =>
  by.kind !== 'remote' || !!by.peer || (inDriveBin(row) ? !!workspace && ctx.reaches(by, workspace.path) : ctx.reaches(by, pathOf(row.ref)))

/** The folders from the workspace's top down to `dir`, by name. */
const trailOf = (root: string, dir: string): string[] => relative(root, dir).split(sep).filter((part) => part && part !== '..')

/** The Trash lens: the workspace's held rows, newest first, as rows that name where each was. */
export function trashEntries(ctx: LocateCtx, by: Caller, workspace: WorkspaceRow): FileEntry[] {
  const rows = ctx.db.prepare(`SELECT * FROM work_files_trash WHERE workspace_id = ? AND state = 'held' ORDER BY deleted_at DESC, id LIMIT ?`).all(workspace.id, LIST_PAGE_MAX) as unknown as TrashRow[]
  const root = rootOf(workspace)
  // A row of a delete in the Windows VM names its place there and the folders below that place's top.
  const vmPlaces = rows.some((row) => row.provider && isGuestPath(pathOf(row.ref)) && process.platform !== 'win32') ? teamsPlaces(ctx, by).places : []
  const whereOf = (row: TrashRow): NonNullable<FileEntry['where']> => {
    if (inDriveBin(row)) {
      const at = JSON.parse(row.was_at) as { account: string; trail?: string[] }
      return { place: row.place, name: at.account, trail: at.trail ?? [] }
    }
    const was = pathOf(row.was_at)
    const vm = vmPlaces.find((p) => p.place.id === row.place)
    if (vm) return { place: row.place, name: vm.place.name, trail: was.slice(vm.top.length).split('\\').filter(Boolean) }
    return { place: row.place, name: workspace.name, trail: trailOf(root, was) }
  }
  return rows
    .filter((row) => visible(ctx, by, row, workspace))
    .map((row) => {
      const held = row.provider ? null : lstatOr(join(binOf(ctx.dataDir, workspace.id, row.id), row.name))
      const drive = inDriveBin(row) ? (JSON.parse(row.ref) as { at: string; mime?: string }) : null
      const dir = !!held?.isDirectory() || drive?.at === 'drive'
      return {
        key: `trash:${row.id}`,
        ref: null,
        folder: null,
        name: row.name,
        kind: drive ? kindOfItem({ name: row.name, mimeType: drive.mime ?? '', folder: dir }) : dir ? 'folder' : kindOfEntry(row.name).kind,
        ...(held && !dir ? { size: held.size } : {}),
        changed: row.deleted_at,
        where: whereOf(row)
      }
    })
}

/** A held row's bytes back where they were, or at the folder's top when that folder is gone, under a free name. */
async function putBack(ctx: TrashCtx, workspace: WorkspaceRow, root: string, row: TrashRow): Promise<FileEntry> {
  if (inDriveBin(row)) return untrashInDrive(ctx, workspace, row)
  if (row.provider) throw new Error('Put it back from the recycle bin.')
  const from = join(binOf(ctx.dataDir, workspace.id, row.id), row.name)
  const was = pathOf(row.was_at)
  let dir = root
  try {
    const real = realpathSync(was)
    if (within(real, root) && statSync(real).isDirectory()) dir = real
  } catch {
    // its folder is gone: the top it is
  }
  const fence = { roots: [root, trashRoot(ctx.dataDir)] }
  let path = ''
  for (let tries = 0; !path; tries++) {
    const name = freeName(row.name, (n) => lstatOr(join(dir, n)) !== null, ' (restored)')
    try {
      path = await moveNoReplace(fence, from, dir, name)
    } catch (e) {
      // Another writer took the name between the look and the move: look again.
      if (!(e instanceof FileRefused && e.code === 'taken' && tries < 3)) throw e
    }
  }
  dropRow(ctx, row.id)
  await rm(binOf(ctx.dataDir, workspace.id, row.id), { recursive: true, force: true })
  changed(ctx, workspace.id, dir)
  const got = await filesState(ctx).lister.row(path)
  const entry = got ? folderEntry(ctx.host, dir, got) : { key: refKey({ at: 'file', host: ctx.host, path }), ref: { at: 'file' as const, host: ctx.host, path }, folder: null, name: basename(path), kind: kindOfEntry(basename(path)).kind }
  return { ...entry, where: { place: PLACE.folder, name: workspace.name, trail: trailOf(root, dir) } }
}

/** `work.files.restore`: Put back. A row of another workspace, one not held, or one the caller could not name, is that id's refusal. */
export function restoreRows(ctx: TrashCtx & Pick<WorkCtx, 'reaches'>, by: Caller, workspace: WorkspaceRow, ids: string[], op: string): Promise<FileDone> {
  return runOp(ctx.db, { id: op, workspaceId: workspace.id, verb: 'restore', refs: ids }, async () => {
    const root = rootOf(workspace)
    const entries: FileEntry[] = []
    const refused: FileDone['refused'] = []
    for (const id of ids) {
      const seen = getRow(ctx, id)
      const mine = seen && seen.workspace_id === workspace.id && visible(ctx, by, seen, workspace) ? seen : null
      if (!mine || !claim(ctx, workspace.id, id, 'restoring')) {
        refused.push({ name: mine?.name ?? id, text: NOT_IN_TRASH })
        continue
      }
      try {
        entries.push(await putBack(ctx, workspace, root, mine))
      } catch (e) {
        ctx.db.prepare(`UPDATE work_files_trash SET state = 'held' WHERE id = ? AND state = 'restoring'`).run(id)
        refused.push({ name: mine.name, text: textOf(e) })
      }
    }
    return { entries, refused, op }
  })
}

/** A claimed row (`purging`) and its bytes go for good. */
async function purgeClaimed(ctx: TrashCtx, row: Pick<TrashRow, 'id' | 'workspace_id'>): Promise<void> {
  await rm(binOf(ctx.dataDir, row.workspace_id, row.id), { recursive: true, force: true })
  ctx.db.prepare(`DELETE FROM work_files_trash WHERE id = ? AND state = 'purging'`).run(row.id)
}

/** `work.files.purge`: Empty Trash for the workspace, or only `ids`. Only a row this call claimed is removed. */
export async function purgeRows(ctx: TrashCtx & Pick<WorkCtx, 'reaches'>, by: Caller, workspace: WorkspaceRow, ids?: string[]): Promise<{ purged: number }> {
  const asked = ids ?? (ctx.db.prepare(`SELECT id FROM work_files_trash WHERE workspace_id = ? AND state = 'held'`).all(workspace.id) as { id: string }[]).map((r) => r.id)
  let purged = 0
  for (const id of asked) {
    const row = getRow(ctx, id)
    if (!row || row.workspace_id !== workspace.id || !visible(ctx, by, row, workspace) || !claim(ctx, workspace.id, id, 'purging')) continue
    await purgeClaimed(ctx, row)
    purged++
  }
  if (purged) changed(ctx, workspace.id, null)
  return { purged }
}

/** Rows held longer than 30 days go, bytes and all: at start and once a day. Answers how many. */
export async function purgeOld(ctx: TrashCtx, now = Date.now()): Promise<number> {
  const old = ctx.db.prepare(`SELECT id, workspace_id FROM work_files_trash WHERE state = 'held' AND held_at < ?`).all(now - TRASH_DAYS * DAY) as { id: string; workspace_id: string }[]
  let purged = 0
  for (const row of old) {
    if (!claim(ctx, row.workspace_id, row.id, 'purging')) continue
    await purgeClaimed(ctx, row)
    purged++
  }
  return purged
}

/**
 * The boot check: a row a dead process left half done is finished or undone. `moving`: held when its bytes are in
 * Trash, dropped when they are still in place. `restoring`: dropped when its bytes left Trash, else held again.
 * `purging`: purged.
 */
export async function settleTrash(ctx: TrashCtx): Promise<{ held: number; undone: number; restored: number; purged: number }> {
  const out = { held: 0, undone: 0, restored: 0, purged: 0 }
  const rows = ctx.db.prepare(`SELECT * FROM work_files_trash WHERE state IN ('moving', 'restoring', 'purging')`).all() as unknown as TrashRow[]
  for (const row of rows) {
    try {
      if (row.state === 'moving') out[await settleMoving(ctx, row)]++
      else if (row.state === 'purging') {
        await purgeClaimed(ctx, row)
        out.purged++
      } else if (!row.provider && lstatOr(join(binOf(ctx.dataDir, row.workspace_id, row.id), row.name)) === null) {
        dropRow(ctx, row.id)
        await rm(binOf(ctx.dataDir, row.workspace_id, row.id), { recursive: true, force: true })
        out.restored++
      } else {
        // Held again; for a Drive row too: a second Put back of a file Drive already took out of its bin does no harm.
        holdRow(ctx, row.id, 'restoring')
        out.held++
      }
    } catch (err) {
      ctx.log(`files: Trash row ${row.id} could not be settled: ${textOf(err)}`)
    }
  }
  return out
}

/** A deleted workspace's Trash bytes go (its rows go with the workspace's other rows). */
export function removeTrashOf(ctx: Pick<WorkCtx, 'dataDir'>, workspaceId: string): void {
  rmSync(join(trashRoot(ctx.dataDir), workspaceId), { recursive: true, force: true })
}

// ── a place others can open: the provider's own bin (not wired) ─────────

/**
 * Moves a file or folder to the system's own bin: the Finder's Trash on a Mac, the Recycle Bin on Windows, `gio
 * trash` on Linux. OneDrive then takes the delete to the library's own recycle bin.
 */
export function systemBin(path: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', path]]
      : process.platform === 'win32'
        ? [
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              "Add-Type -AssemblyName Microsoft.VisualBasic; $p = $args[0]; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
              path
            ]
          ]
        : ['gio', ['trash', '--', path]]
  return new Promise((resolve, reject) => execFile(cmd as string, args as string[], { timeout: 30_000 }, (err) => (err ? reject(err) : resolve())))
}

/**
 * A delete in a library (Teams, OneDrive) through the provider's own bin: the row is written first, the file goes
 * to the system's bin (`bin`), and the row is held with `provider: 'onedrive'` and no bytes here. NOT reachable
 * yet: a library's `can` has no `trash`, so the grammar refuses first ("Delete it in Teams."). It is turned on only
 * after a live proof, on an account that is not his university's, shows the provider's bin holds a file, a folder
 * and a cloud-only file.
 */
export async function trashInLibrary(ctx: Pick<WorkCtx, 'db' | 'host'>, o: { workspaceId: string; placeId: string; path: string }, bin: (path: string) => Promise<void> = systemBin): Promise<string> {
  if (!existsSync(o.path)) throw new FileRefused('gone', 'That file or folder is not there any more.')
  const id = randomUUID()
  const file = { at: 'file', host: ctx.host, path: o.path }
  ctx.db
    .prepare(`INSERT INTO work_files_trash (id, workspace_id, ref, name, place, was_at, state, deleted_at, by, provider) VALUES (?, ?, ?, ?, ?, ?, 'moving', ?, 'owner', 'onedrive')`)
    .run(id, o.workspaceId, JSON.stringify(file), basename(o.path), o.placeId, JSON.stringify({ ...file, path: dirname(o.path) }), Date.now())
  try {
    await bin(o.path)
  } catch (e) {
    dropRow(ctx, id)
    throw e
  }
  holdRow(ctx, id, 'moving')
  return id
}

// ── a Google Drive: Drive's own bin ───────────────────────────────────

/**
 * A Drive file or folder to Drive's own bin (`files.update {trashed: true}`), which keeps it 30 days. The row is
 * written first (`moving`), with no bytes here and `provider: 'drive'`; then Drive is asked; then the row is held.
 * Put back is `untrash`, to the folder it was in. Empty Trash drops the row only: Drive empties its own bin, and
 * nothing here deletes a Drive file for good. A tab on the file closes first. Answers the row's id.
 */
export async function trashInDrive(ctx: TrashCtx, workspace: WorkspaceRow, o: { account: string; item: DriveItem; trail: string[] }): Promise<string> {
  const { account, item } = o
  const ref = item.folder ? { at: 'drive' as const, account, folderId: item.id } : { at: 'google' as const, account, fileId: item.id, mime: item.mimeType }
  const key = refKey(ref)
  if (fileLocked(key)) throw new FileRefused('busy', WRITING)
  return withFileLocks([key], async () => {
    const state = filesState(ctx)
    for (const tab of state.tabs.list(workspace.id).tabs) {
      if (tab.kind === 'file' && tab.key === key) state.tabs.tabClose(workspace.id, tab.id, { at: { at: 'place', id: PLACE.folder }, name: folderName(workspace, workspace.path, workspace.path) })
    }
    dropName(ctx.db, workspace.id, key)
    const id = randomUUID()
    const parent = item.parents[0] ?? DRIVE_ROOT
    ctx.db
      .prepare(`INSERT INTO work_files_trash (id, workspace_id, ref, name, place, was_at, state, deleted_at, by, provider) VALUES (?, ?, ?, ?, ?, ?, 'moving', ?, 'owner', ?)`)
      .run(id, workspace.id, JSON.stringify(ref), item.name, drivePlaceId(account), JSON.stringify({ at: 'drive', account, folderId: parent, trail: o.trail }), Date.now(), DRIVE_BIN)
    try {
      await driveOf(ctx as WorkCtx, account).trash(item.id)
    } catch (e) {
      dropRow(ctx, id)
      throw e
    }
    holdRow(ctx, id, 'moving')
    driveChanged(ctx, workspace.id, account, item.parents.length ? item.parents : [DRIVE_ROOT])
    changed(ctx, workspace.id, null)
    return id
  })
}

/** A Drive row put back: Drive takes the file out of its bin, into the folder it was in. */
async function untrashInDrive(ctx: TrashCtx, workspace: WorkspaceRow, row: TrashRow): Promise<FileEntry> {
  const ref = JSON.parse(row.ref) as { at: 'drive'; account: string; folderId: string } | { at: 'google'; account: string; fileId: string }
  const id = ref.at === 'drive' ? ref.folderId : ref.fileId
  const back = await driveOf(ctx as WorkCtx, ref.account).untrash(id)
  dropRow(ctx, row.id)
  driveChanged(ctx, workspace.id, ref.account, back.parents.length ? back.parents : [DRIVE_ROOT])
  changed(ctx, workspace.id, null)
  const was = JSON.parse(row.was_at) as { trail?: string[] }
  return { ...driveEntry(ref.account, back, await itemShared(ctx as WorkCtx, ref.account, back)), where: { place: row.place, name: ref.account, trail: was.trail ?? [] } }
}
