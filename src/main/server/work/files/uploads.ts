import { execFile } from 'node:child_process'
import type { CanvasSource } from '@shared/work'
import { filesPaneOf } from '@shared/work'
import type { CloudBack, FileTab, FileUploaded } from '@shared/contract-work-files'
import type { Caller, WorkCtx } from '../modules'
import { storedStatus, vmSynced } from '../office/vm/files'
import { vmState } from '../office/vm/office'
import { filesState } from './handle'
import { locate } from './policy'

/**
 * Saved is not uploaded (docs/agents/work-files.md "Saved is not uploaded"). A save of ours into a folder OneDrive
 * syncs puts the bytes on that computer; the file in Teams changes only once OneDrive uploads them. One record a file,
 * kept by the workspace's host after each write through `deliver` (copies.ts: a copy's send, a Word file's save), for
 * decks, workbooks, text and Word alike, looked at until OneDrive has it: in the Windows VM through the helper's `sync`
 * (the cloud filter's own in-sync mark, read from the listing), on another host of his through `work.files.uploaded`
 * (a Mac's File Provider item: uploaded and not uploading). Nothing here wakes the VM; while an upload there is still
 * owed the keeper does not put it to sleep (`uploadsOwed`).
 */

/**
 * `every`: between looks, and before the first look at another host's file (a Mac says the old version is uploaded for
 * about 0.6 s after a write). `late`: an upload not done this long after the write is told as late (OneDrive took 1.3
 * to 1.8 s in the VM and 0.8 to 2.9 s on the Mac on 2026-11-24, F-edits-lost.md "Saved is not uploaded"). `give`: after this
 * the file is looked at no more, and the VM may sleep again.
 */
export const uploadTiming = { every: 2000, late: 60_000, give: 30 * 60_000 }

interface Upload {
  workspaceId: string
  host: string
  path: string
  vm: boolean
  /** when our save wrote the bytes, or when a tab from before a restart was first seen */
  wrote: number
  /** when the save went, as the line says it */
  saved: number
  /** none yet for another host's file: told only once that host says it lies in a folder OneDrive syncs */
  cloud?: CloudBack
  /** still asked: until OneDrive has it, the computer says it cannot tell, or `give` runs out */
  looking: boolean
  /** found on a tab after a restart, not seen written: a sleeping VM leaves it unknown, never late */
  seeded?: boolean
}
const uploads = new Map<string, Upload>()
const keyOf = (workspaceId: string, host: string, path: string): string => `${workspaceId}\0${host}\0${path}`
let timer: ReturnType<typeof setTimeout> | null = null
let queue: Promise<void> = Promise.resolve()

/** A save of ours wrote the file: it is looked at until OneDrive has it. */
export function uploadWrote(ctx: WorkCtx, r: { workspace_id: string; host: string; path: string; vm: number | boolean }, now = Date.now()): void {
  const vm = !!r.vm
  uploads.set(keyOf(r.workspace_id, r.host, r.path), { workspaceId: r.workspace_id, host: r.host, path: r.path, vm, wrote: now, saved: now, looking: true, ...(vm ? { cloud: { is: 'uploading', at: now } } : {}) })
  filesState(ctx).tabs.touch(r.workspace_id)
  soon(ctx, vm ? 0 : uploadTiming.every)
}

/** What OneDrive has done with a file our save wrote, for its tab; none before a write of ours. */
export function cloudOf(workspaceId: string, host: string, path: string): CloudBack | undefined {
  return uploads.get(keyOf(workspaceId, host, path))?.cloud
}

/**
 * A tab of a file in a library that a save wrote before this host started (its save time on the tab): looked at once
 * more, so its line says what OneDrive did rather than Saved to Teams.
 */
export function seedUpload(ctx: WorkCtx, workspaceId: string, tab: Pick<FileTab, 'copyOf'>, savedAt: number | undefined, now = Date.now()): void {
  if (!tab.copyOf || savedAt === undefined || uploads.has(keyOf(workspaceId, tab.copyOf.host, tab.copyOf.path))) return
  // its clock starts now: late and the looking's end count from this look, the line's time is the save's
  const vm = !!tab.copyOf.vm
  uploads.set(keyOf(workspaceId, tab.copyOf.host, tab.copyOf.path), { workspaceId, host: tab.copyOf.host, path: tab.copyOf.path, vm, wrote: now, saved: savedAt, looking: true, seeded: true, ...(vm ? { cloud: { is: 'unknown', at: savedAt } } : {}) })
  soon(ctx, 0)
}

/** Whether a write of ours in the VM is still owed to the cloud and still looked at: the keeper keeps the VM awake for it. */
export function uploadsOwed(now = Date.now()): boolean {
  for (const u of uploads.values()) if (u.vm && owed(u, now)) return true
  return false
}

const owed = (u: Upload, now: number): boolean => u.looking && now - u.wrote < uploadTiming.give

function soon(ctx: WorkCtx, ms: number): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void lookAll(ctx).finally(() => {
      if ([...uploads.values()].some((u) => owed(u, Date.now()))) soon(ctx, uploadTiming.every)
    })
  }, ms)
  timer.unref?.()
}

/** One look at every upload still owed, after any look already under way. */
export function lookAll(ctx: WorkCtx, now: () => number = Date.now): Promise<void> {
  const next = queue.then(async () => {
    for (const u of [...uploads.values()]) {
      if (!owed(u, now())) continue
      const was = JSON.stringify(u.cloud)
      const got = await look(ctx, u, now)
      // another host's file in no folder OneDrive syncs: nothing to tell of it, and it is asked no more
      if (got === null) {
        u.looking = false
        continue
      }
      u.cloud = got.cloud
      u.looking = got.looking
      if (JSON.stringify(u.cloud) !== was) filesState(ctx).tabs.touch(u.workspaceId)
    }
  })
  queue = next.catch(() => {})
  return next
}

async function look(ctx: WorkCtx, u: Upload, now: () => number): Promise<{ cloud: CloudBack | undefined; looking: boolean } | null> {
  const late = now() - u.wrote >= uploadTiming.late
  const at = u.saved
  // Asleep, the VM is not woken to be asked: OneDrive there uploads once it wakes.
  if (u.vm && vmState()?.state !== 'awake') return { cloud: u.seeded || !late ? u.cloud : { is: 'late', at, why: 'asleep' }, looking: true }
  let uploaded: boolean | null | 'outside'
  try {
    uploaded = u.vm ? await vmSynced(u.path) : await askHost(ctx, u)
  } catch {
    // Not answering, or the file went (a move, a delete): what was known stands until the next look.
    return { cloud: u.cloud, looking: true }
  }
  if (uploaded === 'outside') return null
  if (uploaded === null) return { cloud: { is: 'unknown', at }, looking: false }
  if (uploaded) return { cloud: { is: 'uploaded', at: now() }, looking: false }
  if (!late) return { cloud: { is: 'uploading', at }, looking: true }
  const onedrive = u.vm ? storedStatus(ctx.db)?.status.onedrive : undefined
  const why = onedrive && !onedrive.running ? 'stopped' : onedrive && !onedrive.account ? 'signed-out' : undefined
  return { cloud: { is: 'late', at, ...(why ? { why } : {}) }, looking: true }
}

/** Another host of his: its own reading of the file it holds (`work.files.uploaded`); an older one that has no such verb cannot say. */
async function askHost(ctx: WorkCtx, u: Upload): Promise<boolean | null | 'outside'> {
  const far = ctx.peer.call({ scope: { sessionId: filesPaneOf(u.workspaceId), workspaceId: u.workspaceId } } as never, u.host)
  try {
    const got = (await far.call('files', 'uploaded', { workspaceId: u.workspaceId, ref: { at: 'file', host: u.host, path: u.path } })) as FileUploaded
    return got.outside ? 'outside' : got.uploaded
  } catch (err) {
    if (/unknown method|no such method|not handled/i.test(err instanceof Error ? err.message : String(err))) return null
    throw err
  }
}

// ── the file's own host ───────────────────────────────────────────────

/**
 * `work.files.uploaded`, run where the file lies, for the workspace's host after its write: whether OneDrive here has
 * the file of a library here as it lies. On a Mac, the File Provider item's own keys (uploaded, and not uploading); a
 * computer that cannot read them says null.
 */
export async function uploadedHere(ctx: WorkCtx, by: Caller, p: { workspaceId: string; ref: CanvasSource }, method: string): Promise<FileUploaded> {
  if (by.kind !== 'remote' || !by.peer) throw new Error("Only the workspace's own host asks this.")
  if (p.ref.at !== 'file') return { uploaded: null, outside: true }
  const at = locate(ctx, by, p.workspaceId, p.ref, method)
  if (at.in !== 'library' || at.library.vm) return { uploaded: null, outside: true }
  return { uploaded: await uploadReader(p.ref.path) }
}

/**
 * Reads a Mac's File Provider item for a path: `in`, `pending`, or `none` where it is no such item. JXA, so no prompt
 * and no build of ours: the keys are Foundation's, cached values dropped first. Tried on his Mac on 2026-11-24.
 */
export const MAC_UPLOAD_STATE = `ObjC.import('Foundation')
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0])
  url.removeAllCachedResourceValues
  const up = Ref(), ing = Ref()
  if (!url.getResourceValueForKeyError(up, $.NSURLUbiquitousItemIsUploadedKey, null)) return 'none'
  url.getResourceValueForKeyError(ing, $.NSURLUbiquitousItemIsUploadingKey, null)
  const uploaded = ObjC.unwrap(up[0]), uploading = ObjC.unwrap(ing[0])
  if (uploaded === undefined || uploaded === null) return 'none'
  return uploaded && !uploading ? 'in' : 'pending'
}`

function macUploaded(path: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', MAC_UPLOAD_STATE, path], { timeout: 10_000 }, (err, out) => {
      const said = String(out ?? '').trim()
      resolve(err || said === 'none' || !said ? null : said === 'in')
    })
  })
}

const hereReader = (path: string): Promise<boolean | null> => (process.platform === 'darwin' ? macUploaded(path) : Promise.resolve(null))
let uploadReader = hereReader
/** A test's own reading of this host's files; null puts the real one back. */
export function setUploadReader(fn: ((path: string) => Promise<boolean | null>) | null): void {
  uploadReader = fn ?? hereReader
}

/** Every record goes (tests; Work turned off). */
export function forgetUploads(): void {
  uploads.clear()
  if (timer) clearTimeout(timer)
  timer = null
}
