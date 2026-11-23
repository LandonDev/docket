import type { FileDone, FileMakeKind, FileOrigin, FileRef } from '@shared/contract-work-files'
import { freeName, refKey, UNTITLED, type FileEntry, type FileVerb, type FolderRef } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { DRIVE_ROOT, driveOf, type DriveItem, type DriveMakeKind } from '../google/drive'
import { accountOfPlace, DRIVE_NEW, driveChanged, driveEntry, driveFacts, drivePlace, driveTop, folderShared, itemShared, kindOfItem } from './places/drive'
import { admitWrite, changeDigest, locate, type Located, type WorkspaceRow } from './policy'
import { trashInDrive } from './trash'
import { checkName, fileLocked, runOp, withFileLocks } from './write'

/**
 * New, rename, move and delete in a Google Drive (docs/agents/work-files.md "Google Drive"), each one Drive call
 * through the google pillar's `drive.file` token, after the one door. The door asks Drive whether others can open
 * each thing now: its own sharing, a folder it lies in that is shared, and the folder a move or New puts it in. So
 * a thread's change to a shared Drive file is held (`file.act`) and one to his own runs with its Result and Undo,
 * as in the workspace's folder. Each runs under its operation id (`runOp`) with the file's lock by its key.
 */

const PLACE_ITSELF = 'A place itself cannot be renamed or moved.'
const WRITING = 'A thread is writing in this file. Try when it is done.'
const NOT_A_FOLDER = 'That is a file, not a folder.'
const GONE = (what: string): string => `${what} is not there any more, or TempCode may not see it.`
/** One change names a Drive and some other place: a Google file lives in Google Drive. */
export const DRIVE_APART = 'A Google file lives in Google Drive. Change Drive files apart from files elsewhere.'

type DriveAt = Located & { in: 'drive' }

const isDriveRef = (ref: unknown): boolean => {
  const r = ref as { at?: string; id?: string } | undefined
  return !!r && (r.at === 'drive' || r.at === 'google' || (r.at === 'place' && typeof r.id === 'string' && accountOfPlace(r.id) !== null))
}

/** Whether a request names a Drive anywhere: its folder, its file, its things or where they go. */
export function namesDrive(params: object): boolean {
  const p = params as { at?: unknown; ref?: unknown; refs?: unknown; to?: unknown }
  return isDriveRef(p.at) || isDriveRef(p.ref) || isDriveRef(p.to) || (Array.isArray(p.refs) && p.refs.some(isDriveRef))
}

/** A Drive place's id as its top folder; any other ref as it is. */
export const driveRefOf = <R extends FileRef>(ref: R): R | FolderRef => (ref.at === 'place' && accountOfPlace(ref.id) ? driveTop(accountOfPlace(ref.id)!) : ref)

function located(ctx: WorkCtx, by: Caller, workspaceId: string, ref: FileRef, method: string): DriveAt {
  const at = locate(ctx, by, workspaceId, driveRefOf(ref), method)
  if (at.in !== 'drive') throw new Error(DRIVE_APART)
  return at
}

/** A thing as Drive says it is now: the top of a place has no facts of its own. */
async function factsNow(ctx: WorkCtx, at: DriveAt): Promise<DriveItem | null> {
  if (at.id === DRIVE_ROOT) return null
  try {
    const item = await driveOf(ctx, at.account).facts(at.id)
    if (item.trashed) throw new Error(GONE('That'))
    return item
  } catch (err) {
    if ((err as { code?: string }).code === 'not-found') throw new Error(GONE('That'))
    throw err
  }
}

export interface DriveThing {
  at: DriveAt
  /** null for a place's top */
  item: DriveItem | null
  name: string
  shared: boolean
}

async function thingOf(ctx: WorkCtx, at: DriveAt): Promise<DriveThing> {
  const item = await factsNow(ctx, at)
  return { at, item, name: item?.name ?? at.account, shared: item ? await itemShared(ctx, at.account, item) : false }
}

export interface DriveAsk {
  workspaceId: string
  refs: FileRef[]
  to?: FolderRef
  name?: string
  asked?: boolean
  origin?: FileOrigin
}

/**
 * The door for a change in a Drive. Each thing's sharing is read from Drive now; a move or New into a folder others
 * can open is a change others see too. Then the grammar and the caller's row (`admitWrite`): his window runs it, a
 * remote key needs `approve` for a shared thing, a thread's shared change is held, another host is refused by
 * `locate`. Answers the verdict and what each ref named.
 */
export async function admitDrive(ctx: WorkCtx, by: Caller, verb: FileVerb, p: DriveAsk, method: string): Promise<{ verdict: 'run' | 'hold'; things: DriveThing[]; to: DriveThing | null }> {
  const to = p.to ? await thingOf(ctx, located(ctx, by, p.workspaceId, p.to, method)) : null
  if (to?.item && !to.item.folder) throw new Error(NOT_A_FOLDER)
  const things: DriveThing[] = []
  let verdict: 'run' | 'hold' = 'run'
  for (const ref of p.refs) {
    const thing = await thingOf(ctx, located(ctx, by, p.workspaceId, ref, method))
    things.push(thing)
    const kind = thing.item ? kindOfItem(thing.item) : 'folder'
    const got = admitWrite(by, {
      verb,
      from: drivePlace(ctx.host, thing.at.account),
      to: to ? drivePlace(ctx.host, to.at.account) : null,
      entry: { name: thing.name, kind, shared: thing.shared || !!to?.shared },
      asked: p.asked,
      origin: p.origin,
      digest: changeDigest({ verb, refs: p.refs, to: p.to, name: p.name })
    })
    if (got === 'hold') verdict = 'hold'
  }
  return { verdict, things, to }
}

/** What the journal keeps of a Drive change: the same shapes as a disk's (verbs.ts), so a retry is known by them. */
const journal = (verb: 'make' | 'rename' | 'move', p: { at?: FolderRef; kind?: FileMakeKind; name?: string; ref?: FileRef; refs?: FileRef[]; to?: FolderRef }): unknown =>
  verb === 'make' ? { at: p.at, kind: p.kind, name: p.name ?? null, from: null } : verb === 'rename' ? { ref: p.ref, name: p.name } : { refs: p.refs, to: p.to }

/**
 * What a Drive change did: a rename or a move also keeps what each thing was before (its key, its name, its
 * folders) in the journal's row, since Drive's ids carry no path to go back to. Undo reads it there.
 */
export type DriveDone = FileDone & { before?: { key: string; name: string; parents: string[] }[] }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const keyOfItem = (account: string, item: DriveItem): string => refKey(item.folder ? { at: 'drive', account, folderId: item.id } : { at: 'google', account, fileId: item.id, mime: item.mimeType })

/** New in a Drive folder: an empty Google Doc, Sheet, deck or a folder, under a name nothing there that TempCode sees has. */
export async function driveMake(ctx: WorkCtx, by: Caller, p: { workspaceId: string; op: string; at: FolderRef; kind: FileMakeKind; name?: string; from?: unknown }, method: string): Promise<FileDone> {
  const at = located(ctx, by, p.workspaceId, p.at, method)
  if (at.mime) throw new Error(NOT_A_FOLDER)
  if (!(DRIVE_NEW as readonly string[]).includes(p.kind)) throw new Error(`A text file cannot be made in ${at.account}. Make a Google Doc instead.`)
  if (p.from) throw new Error('A Drive file is made blank here. Make one from a template in Google Drive.')
  const named = p.name?.trim()
  if (named) checkName(named)
  return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'make', refs: journal('make', p) }, async () => {
    const drive = driveOf(ctx, at.account)
    const names = new Set((await drive.children(at.id)).items.map((i) => i.name.normalize('NFC').toLowerCase()))
    const name = freeName(named ?? UNTITLED[p.kind], (n) => names.has(n.normalize('NFC').toLowerCase()))
    const made = await drive.make(p.kind as DriveMakeKind, name, at.id)
    driveChanged(ctx, p.workspaceId, at.account, [at.id])
    return { entries: [driveEntry(at.account, made, made.shared || (await folderShared(ctx, at.account, at.id)))], refused: [], op: p.op } satisfies FileDone
  })
}

/** A Drive file or folder by a new name; Drive keeps its id, so what hangs on it (its tab, star, recent) follows. `before` keeps the old name for an Undo. */
export async function driveRename(ctx: WorkCtx, by: Caller, p: { workspaceId: string; op: string; ref: FileRef; name: string }, method: string): Promise<DriveDone> {
  const at = located(ctx, by, p.workspaceId, p.ref, method)
  if (at.id === DRIVE_ROOT) throw new Error(PLACE_ITSELF)
  checkName(p.name)
  return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'rename', refs: journal('rename', p) }, async () => {
    const was = await factsNow(ctx, at)
    const key = keyOfItem(at.account, was!)
    if (fileLocked(key)) throw new Error(WRITING)
    const now = await withFileLocks([key], () => driveOf(ctx, at.account).rename(at.id, p.name))
    driveChanged(ctx, p.workspaceId, at.account, now.parents.length ? now.parents : [DRIVE_ROOT])
    return { entries: [driveEntry(at.account, now, await itemShared(ctx, at.account, now))], refused: [], before: [{ key, name: was!.name, parents: was!.parents }], op: p.op } satisfies DriveDone
  })
}

/** Into another folder of the same Drive: one call that adds the new folder and takes the old ones away. A thing already there is left as it is. */
export async function driveMove(ctx: WorkCtx, by: Caller, p: { workspaceId: string; op: string; refs: FileRef[]; to: FolderRef }, method: string): Promise<DriveDone> {
  const to = located(ctx, by, p.workspaceId, p.to, method)
  const all = p.refs.map((ref) => located(ctx, by, p.workspaceId, ref, method))
  return runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'move', refs: journal('move', p) }, async () => {
    const into = await factsNow(ctx, to)
    if (into && !into.folder) throw new Error(NOT_A_FOLDER)
    const intoShared = await folderShared(ctx, to.account, to.id)
    const entries: FileEntry[] = []
    const refused: FileDone['refused'] = []
    const before: NonNullable<DriveDone['before']> = []
    const changed = new Set<string>([to.id])
    for (const at of all) {
      let name = at.id
      try {
        if (at.account !== to.account) throw new Error('A Google file moves only within its own Drive.')
        if (at.id === DRIVE_ROOT) throw new Error(PLACE_ITSELF)
        const item = (await factsNow(ctx, at))!
        name = item.name
        if (at.id === to.id) throw new Error('A folder cannot go inside itself.')
        const key = keyOfItem(at.account, item)
        if (fileLocked(key)) throw new Error(WRITING)
        const target = to.id === DRIVE_ROOT ? 'root' : to.id
        if (item.parents.includes(target)) {
          entries.push(driveEntry(at.account, item, item.shared || intoShared))
          continue
        }
        const moved = await withFileLocks([key], () => driveOf(ctx, at.account).move(at.id, item.parents, target))
        before.push({ key, name: item.name, parents: item.parents })
        for (const parent of item.parents) changed.add(parent)
        entries.push(driveEntry(at.account, moved, moved.shared || intoShared))
      } catch (err) {
        refused.push({ name, text: message(err) })
      }
    }
    driveChanged(ctx, p.workspaceId, to.account, [...changed])
    return { entries, refused, ...(before.length ? { before } : {}), op: p.op } satisfies DriveDone
  })
}

/** To Drive's own bin, each thing through its Trash row (trash.ts `trashInDrive`). What could not go is said thing by thing. */
export function driveTrash(ctx: WorkCtx, by: Caller, workspace: WorkspaceRow, refs: FileRef[], op: string): Promise<FileDone> {
  return runOp(ctx.db, { id: op, workspaceId: workspace.id, verb: 'trash', refs }, async () => {
    const trashed: string[] = []
    const refused: FileDone['refused'] = []
    for (const ref of refs) {
      let name = 'That'
      try {
        const at = located(ctx, by, workspace.id, ref, 'work.files.trash')
        if (at.id === DRIVE_ROOT) throw new Error('A place itself cannot be deleted.')
        const item = (await factsNow(ctx, at))!
        name = item.name
        const parent = item.parents[0] ? await driveFacts(ctx, at.account, item.parents[0]) : null
        trashed.push(await trashInDrive(ctx, workspace, { account: at.account, item, trail: parent ? [parent.name] : [] }))
      } catch (err) {
        refused.push({ name, text: message(err) })
      }
    }
    return { entries: [], refused, trashed, op }
  })
}
