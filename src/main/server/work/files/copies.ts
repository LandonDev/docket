import { createHash, randomUUID } from 'node:crypto'
import { takePieces, writeBackInPieces, type PieceRef } from './pieces'
import { constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CopyBack, FileOrigin, FileTab, WrittenBack } from '@shared/contract-work-files'
import { filesPaneOf, type CanvasItem, type CanvasKind, type CanvasSource } from '@shared/work'
import { COPY_ACROSS_MAX, freeName, refKey, splitName } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { copyAllowed } from '../office/files/library'
import { vmList } from '../office/vm/files'
import { VmUnreachable } from '../office/vm/link'
import { vmState } from '../office/vm/office'
import { hostReadOf } from '../peer'
import { admitChange, doorPlace, filesState, vmWhere } from './handle'
import { forgetVmList, libraryKey } from './places/teams'
import { admitCaller, admitWrite, locate, type DoorPlace } from './policy'
import { saveCopy, saveFile, versionWord, workDone } from './save'
import { uploadPending, uploadWrote } from './uploads'
import { keepBody, sameBody } from './body'
import { makeBytes } from './verbs'
import { farMoved } from './moved'
import { guestChange, guestOp, vmReadVersioned, vmSave } from './vmVerbs'
import { FileRefused, OpLost, runOp, versionOf, withFileLocks } from './write'
import { bytesSink, copyFolderOf, farBytes, type FarPiece } from '../office/files/handle'
import { copyFolderTaken } from './copyKept'

/**
 * A copy saves back (docs/agents/work-files.md "A copy saves back"). A Files tab's copy of a file on another
 * computer of his, or in this host's Windows VM, whose kind edits the copy's own bytes (`copySavesBack`), sends what
 * he changed to the file where it lies, by the version the copy was read at, through that file's own door: never
 * over a file that changed there. Two things ask for a send, and both meet in `sendBack`: `saveFile` replacing the
 * copy (`onFileSaved`, the sheet and the `file` kind), and his window once the copy's kind says it saved
 * (`work.files.copyBack`, every kind that takes part, the deck among them). One send a copy is in flight; one asked
 * while it runs runs once after it, with the newest bytes. Bytes go only when they differ from what the file holds.
 */

export interface CopyRow {
  id: string
  workspace_id: string
  /** the file's own host: another host of his, or this one for a file in its Windows VM */
  host: string
  /** the file's path there (a guest path in the VM) */
  path: string
  vm: number
  /** the copy's real path here, and its folder */
  copy: string
  dir: string
  name: string
  kind: string
  /** the file's version as last read or written */
  version: string
  /** the sha256 of the bytes the file holds as last read or written */
  sent: string
  state: CopyBack['is']
  detail: string | null
  saved_at: number | null
  changed_at: number | null
  closed: number
  at: number
  /** how many times an editor replaced the copy's bytes (`copySaved`) */
  writes: number
  /** the last of those writes the file is known to hold */
  held: number
  /** a Keep Both press whose answer has not come back (`KeepPress` as JSON), else null */
  keep_press: string | null
}

/** A Keep Both press under way: its op id, the hash of the bytes it sent and the copy's writes they held. */
type KeepPress = { op: string; sha: string; writes: number }

/** His window: what the workspace's host itself sends as when the press was his. */
const LOCAL: Caller = { kind: 'local', caps: ['read', 'operate', 'approve'] }
/** How long a closed tab's copy waits for its kind's last save before it is sent and let go (a test sets it to 0). */
export const copyTiming = { grace: 3000 }
/** One read of the guest's file, as `copyIn` reads one. */
const PIECE = 4 * 1024 * 1024
const TOO_BIG = (name: string): string => `${name} is over ${COPY_ACROSS_MAX / 1024 / 1024} MB, too big to send back.`
export const NOT_SAVING = "This copy's changes stay here."
const ONLY_HOST = "A copy is sent back by the workspace's own host."
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
/** The lock every editor of a copy here takes as it saves it (`saveFile` with the copy's `refKey`). */
const copyKey = (ctx: Pick<WorkCtx, 'host'>, copy: string): string => refKey({ at: 'file', host: ctx.host, path: copy })
const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT'
export const RELOAD_EDITED = 'This copy was edited since you chose Reload, so nothing was dropped.'
const RELOAD_MOVED = 'The file moved while it reloaded, so nothing was dropped.'
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// ── the record ────────────────────────────────────────────────────────

const row = (ctx: Pick<WorkCtx, 'db'>, id: string): CopyRow | null => (ctx.db.prepare(`SELECT * FROM work_files_copies WHERE id = ?`).get(id) as CopyRow | undefined) ?? null

/** The record of a copy of this file in the workspace, by where the file lies. */
export const copyRecord = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string, host: string, path: string): CopyRow | null =>
  (ctx.db.prepare(`SELECT * FROM work_files_copies WHERE workspace_id = ? AND host = ? AND path = ?`).get(workspaceId, host, path) as CopyRow | undefined) ?? null

/** The record whose copy is this path here, in the workspace. */
export const copyAt = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string, path: string): CopyRow | null =>
  (ctx.db.prepare(`SELECT * FROM work_files_copies WHERE workspace_id = ? AND copy = ?`).get(workspaceId, real(path)) as CopyRow | undefined) ?? null

/** A copy just made, of a file read at `version` whose bytes hash to `sha256`: what was sent before is forgotten. */
export function recordCopy(ctx: Pick<WorkCtx, 'db'>, c: { workspaceId: string; host: string; path: string; vm: boolean; copy: string; name: string; kind: CanvasKind; version: string; sha256: string }): CopyRow {
  const copy = real(c.copy)
  ctx.db
    .prepare(
      `INSERT INTO work_files_copies (id, workspace_id, host, path, vm, copy, dir, name, kind, version, sent, state, detail, saved_at, changed_at, closed, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', NULL, NULL, NULL, 0, ?)
       ON CONFLICT (workspace_id, host, path) DO UPDATE SET copy = excluded.copy, dir = excluded.dir, name = excluded.name, kind = excluded.kind,
         version = excluded.version, sent = excluded.sent, state = 'ok', detail = NULL, saved_at = NULL, changed_at = NULL, closed = 0, at = excluded.at,
         held = work_files_copies.writes, keep_press = NULL`
    )
    .run(randomUUID(), c.workspaceId, c.host, c.path, c.vm ? 1 : 0, copy, dirname(copy), c.name, c.kind, c.version, c.sha256, Date.now())
  return copyRecord(ctx, c.workspaceId, c.host, c.path)!
}

/** How sending stands, as a tab says it, with the copy's writes and the last one its file holds. */
export function backOf(r: CopyRow): CopyBack {
  const at = r.state === 'changed' ? r.changed_at : r.state === 'ok' ? r.saved_at : null
  return { is: r.state, ...(at ? { at } : {}), ...(r.state === 'refused' && r.detail ? { detail: r.detail } : {}), writes: r.writes, held: r.held }
}

/** Each copy of the workspace that saves back, by where its file lies (`host\0path`). */
export function backsOf(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): Map<string, CopyBack> {
  const rows = ctx.db.prepare(`SELECT * FROM work_files_copies WHERE workspace_id = ?`).all(workspaceId) as unknown as CopyRow[]
  return new Map(rows.map((r) => [`${r.host}\0${r.path}`, backOf(r)]))
}

/** Something a tab says changed: every window asks the tabs again (a copy's state rides its tab). */
function said(ctx: WorkCtx, workspaceId: string): void {
  try {
    filesState(ctx).tabs.touch(workspaceId)
  } catch (err) {
    ctx.log(`files: a copy's state was not said: ${message(err)}`)
  }
}

function setState(ctx: WorkCtx, r: CopyRow, state: CopyBack['is'], o: { detail?: string; changedAt?: number } = {}): void {
  ctx.db.prepare(`UPDATE work_files_copies SET state = ?, detail = ?, changed_at = ? WHERE id = ?`).run(state, o.detail ?? null, o.changedAt ?? null, r.id)
  said(ctx, r.workspace_id)
}

/** The copy and its record go: its tab closed and nothing waits, he discarded what waited, or the copy itself is gone. */
function letGo(ctx: WorkCtx, r: CopyRow): void {
  ctx.db.prepare(`DELETE FROM work_files_copies WHERE id = ?`).run(r.id)
  // Only a copy whose tab is closed takes its folder with it; an open tab's item still shows it.
  if (r.closed) rmSync(r.dir, { recursive: true, force: true })
  said(ctx, r.workspace_id)
}

// ── the one send ──────────────────────────────────────────────────────

/** Whether a send failed because the other computer did not answer, rather than refused. */
export const unreachable = (err: unknown): boolean =>
  err instanceof VmUnreachable || err instanceof OpLost || (err as { name?: string })?.name === 'PeerOfflineError' || /offline|no live link|timed out|timeout|unreachable|not answer|ECONNRE|socket hang up/i.test(message(err))

/** The copy's bytes sent to the file's own host, over it by version, or beside it under the keep-both name. */
export async function deliver(ctx: WorkCtx, r: Pick<CopyRow, 'workspace_id' | 'host' | 'path' | 'vm' | 'name' | 'version'>, data: Buffer, keep: boolean, op?: string): Promise<WrittenBack> {
  // From the moment new bytes leave for the file, what OneDrive did with the last ones is not told of it (uploads.ts).
  if (!keep) uploadPending(ctx, r)
  let got = await deliverOnce(ctx, r, data, keep, op)
  // SharePoint's own rewrite of an Office file in a Teams library, seconds after its upload, is no one's edit
  // (body.ts): found changed with its body as we last read or wrote it, the file is written over by its new version.
  if (!keep && 'conflict' in got && !('gone' in got.conflict)) {
    const now = await freshBytes(ctx, r).catch(() => null)
    // A send whose answer was lost landed all the same: the file holds these very bytes, so it holds this write, at
    // the version it has now. Never a change made there, and nothing to send again.
    if (now && sha(now.data) === sha(data)) got = { version: now.version, changed: Number(now.version.split(':')[1]) || got.conflict.changed }
    else if (now && sameBody(ctx, r, now.data)) got = await deliverOnce(ctx, { ...r, version: now.version }, data, keep)
  }
  // What that computer holds now is not yet the file in Teams: OneDrive's upload is followed from here (uploads.ts).
  if ('version' in got) {
    keepBody(ctx, r, data)
    uploadWrote(ctx, r)
  } else if ('copy' in got) {
    keepBody(ctx, { ...r, path: got.copy.path }, data)
    uploadWrote(ctx, { ...r, path: got.copy.path })
  }
  return got
}

/** `op`: Keep Both's press, kept across a lost answer, so the file's computer answers it again rather than make a second file. */
async function deliverOnce(ctx: WorkCtx, r: Pick<CopyRow, 'workspace_id' | 'host' | 'path' | 'vm' | 'name' | 'version'>, data: Buffer, keep: boolean, op?: string): Promise<WrittenBack> {
  const ref: CanvasSource = { at: 'file', host: r.host, path: r.path }
  if (r.vm) {
    // The Windows VM's file: through this host's own door for his edit of that library, then the guest's versioned write.
    const at = locate(ctx, LOCAL, r.workspace_id, ref, 'work.files.copyBack')
    if (at.in !== 'library' || !at.library.vm) throw new Error(NOT_SAVING)
    admitChange(ctx, LOCAL, 'edit', { workspaceId: r.workspace_id, refs: [ref] }, 'work.files.copyBack')
    const w = vmWhere(ctx, LOCAL, at)
    if (!keep) return vmSave(ctx, r.workspace_id, w, data, r.version, randomUUID())
    const dir = r.path.slice(0, r.path.lastIndexOf('\\'))
    const names = new Set((await vmList(w.library.library, dir)).map((e) => e.name.toLowerCase()))
    const { stem, ext } = splitName(r.name)
    const name = freeName(`${stem} (mine)${ext}`, (n) => names.has(n.toLowerCase()))
    const made = await guestChange<{ entry: { path: string } }>('files.write', { dir, name, data: data.toString('base64'), op: guestOp(op ?? randomUUID()) })
    forgetVmList(w.library.library.id, dir)
    const now = await vmReadVersioned(made.entry.path, 0, 1)
    return { copy: { path: made.entry.path, name: basename(made.entry.path.replaceAll('\\', '/')), version: now.version, changed: now.changed } }
  }
  // Another host of his: its own module runs the save, as his window's press there would (`writeBack`).
  const origin: FileOrigin = { from: 'window' }
  const far = ctx.peer.call({ scope: { sessionId: filesPaneOf(r.workspace_id), workspaceId: r.workspace_id } } as never, r.host)
  // In pieces when it is over one (pieces.ts): never the whole file as one frame of the peer link.
  return (await writeBackInPieces((method, params) => far.call('files', method, params), { workspaceId: r.workspace_id, ref, version: r.version, origin, ...(keep ? { copy: true, ...(op ? { op } : {}) } : {}) }, data)) as WrittenBack
}

/** One look: the copy's bytes as they lie, sent when they differ from what the file holds. */
async function sendOnce(ctx: WorkCtx, id: string): Promise<void> {
  // An editor's work on the copy under way (his last edit, sent as the tab closed) lands first: what it writes is sent.
  const was = row(ctx, id)
  if (was) await workDone(was.copy)
  const r = row(ctx, id)
  // A file that changed there, or went, waits for his Reload or Keep Both: nothing is sent over it.
  if (!r || r.state === 'changed' || r.state === 'gone') return
  let data: Buffer
  try {
    data = await readFile(r.copy)
  } catch (err) {
    // The copy went (Copy Teams files turned off, the workspace gone): so does what was kept of it. A copy that is there
    // and could not be read keeps its record: it is looked at again (`retryWaiting`), never let go unread.
    if (missing(err)) return letGo(ctx, r)
    return ctx.log(`files: a copy could not be read to send it: ${message(err)}`)
  }
  const hash = sha(data)
  if (hash === r.sent) {
    // The file holds these bytes already: the writes up to this look are in it, and that is known now.
    if (r.held < r.writes) ctx.db.prepare(`UPDATE work_files_copies SET held = ?, saved_at = ? WHERE id = ?`).run(r.writes, Date.now(), r.id)
    if (r.closed) return letGoIfHeld(ctx, r.id)
    if (r.state !== 'ok') setState(ctx, r, 'ok')
    else if (r.held < r.writes) said(ctx, r.workspace_id)
    return
  }
  if (data.length > COPY_ACROSS_MAX) return setState(ctx, r, 'refused', { detail: TOO_BIG(r.name) })
  setState(ctx, r, 'sending')
  let got: WrittenBack
  try {
    got = await deliver(ctx, r, data, false)
  } catch (err) {
    // No answer: the changes wait here and are sent when it answers. A refusal says its own sentence.
    if (unreachable(err)) return setState(ctx, r, 'away')
    return setState(ctx, r, 'refused', { detail: message(err) })
  }
  // The file was renamed or moved while this send was on its way (`copiesMoved`, `fileMoved`): its answer is of the old
  // path, never this record's. The copy is sent again, to where the file lies now.
  if (row(ctx, r.id)?.path !== r.path) {
    const flight = flights.get(r.id)
    if (flight) flight.again = true
    return
  }
  if ('conflict' in got) return 'gone' in got.conflict ? setState(ctx, r, 'gone') : setState(ctx, r, 'changed', { changedAt: got.conflict.changed })
  if (!('version' in got)) return setState(ctx, r, 'refused', { detail: 'The other computer answered something else.' })
  // The bytes read after write `r.writes` landed: the file holds that write (a later one asks for its own send).
  ctx.db.prepare(`UPDATE work_files_copies SET version = ?, sent = ?, state = 'ok', detail = NULL, saved_at = ?, changed_at = NULL, held = MAX(held, ?) WHERE id = ?`).run(got.version, hash, Date.now(), r.writes, r.id)
  if (row(ctx, r.id)?.closed) return letGoIfHeld(ctx, r.id)
  said(ctx, r.workspace_id)
}

/**
 * A closed tab's copy goes only once its file holds the copy's latest write: a write that landed while a send was on
 * its way (counted, or found in the bytes) keeps the copy, and its send runs next, never a let-go that takes it. The
 * last look and the let-go hold the copy's lock, so an editor's save under way lands first and is seen; a copy that
 * is there and cannot be read is kept, and looked at again.
 */
async function letGoIfHeld(ctx: WorkCtx, id: string): Promise<void> {
  const r = row(ctx, id)
  if (!r) return
  const owed = await withFileLocks([copyKey(ctx, r.copy)], async () => {
    await workDone(r.copy)
    let now: Buffer | null = null
    try {
      now = await readFile(r.copy)
    } catch (err) {
      if (!missing(err)) {
        ctx.log(`files: a closed copy could not be read, and is kept: ${message(err)}`)
        return false
      }
    }
    const after = row(ctx, id)
    if (!after) return false
    if (after.held >= after.writes && (!now || sha(now) === after.sent)) {
      letGo(ctx, after)
      return false
    }
    return true
  })
  if (!owed) return
  const flight = flights.get(id)
  if (flight) flight.again = true
  else void sendBack(ctx, id)
}

const flights = new Map<string, { run: Promise<void>; again: boolean }>()

/**
 * Sends a copy back when its bytes differ from what its file holds. One send a copy at a time: asked while one
 * runs, it is run once more after it, reading the copy then, so the newest bytes go and nothing goes twice.
 */
export function sendBack(ctx: WorkCtx, id: string): Promise<void> {
  const flying = flights.get(id)
  if (flying) {
    flying.again = true
    return flying.run
  }
  const flight = { run: Promise.resolve(), again: false }
  flight.run = (async () => {
    try {
      do {
        flight.again = false
        try {
          await sendOnce(ctx, id)
        } catch (err) {
          ctx.log(`files: a copy was not sent back: ${message(err)}`)
        }
      } while (flight.again)
    } finally {
      flights.delete(id)
    }
  })()
  flights.set(id, flight)
  return flight.run
}

/** `saveFile` replaced a file: when it is a copy that saves back, that is one more write of it, and it is sent. */
export function copySaved(ctx: WorkCtx, path: string): void {
  const r = ctx.db.prepare(`SELECT id FROM work_files_copies WHERE copy = ?`).get(real(path)) as { id: string } | undefined
  if (!r) return
  ctx.db.prepare(`UPDATE work_files_copies SET writes = writes + 1 WHERE id = ?`).run(r.id)
  void sendBack(ctx, r.id)
}

/**
 * Copies whose changes have not reached their file are sent again once their computer answers: another host when its
 * link is up, the VM once it is awake (a send never wakes it from here). That is a copy whose computer did not answer,
 * a send a dead process left under way, a closed tab's copy, and one found at start to hold bytes its file does not.
 */
export function retryWaiting(ctx: WorkCtx, hosts?: readonly string[]): void {
  const rows = ctx.db.prepare(`SELECT * FROM work_files_copies WHERE state IN ('away', 'sending') OR (closed = 1 AND state = 'ok')`).all() as unknown as CopyRow[]
  const changed = changedAtStart.size ? (ctx.db.prepare(`SELECT * FROM work_files_copies WHERE state = 'ok' AND closed = 0`).all() as unknown as CopyRow[]).filter((r) => changedAtStart.has(r.id)) : []
  if (!rows.length && !changed.length) return
  const up = new Set(hosts ?? hostReadOf(ctx)?.hosts() ?? [])
  const awake = vmState()?.state === 'awake'
  for (const r of [...rows, ...changed]) {
    if (flights.has(r.id) || !(r.vm ? awake : up.has(r.host))) continue
    changedAtStart.delete(r.id)
    void sendBack(ctx, r.id)
  }
}
/** Open copies found at start holding bytes their file does not: no window asked before the host stopped. */
const changedAtStart = new Set<string>()

/**
 * At start: a send a dead process left under way did not land as far as this host knows; it waits as unanswered. An
 * open copy whose bytes differ from what its file holds (his edit, and the host stopped before it was sent) is sent
 * as soon as its computer answers: nothing he changed waits on his window asking again.
 */
export function settleCopies(ctx: Pick<WorkCtx, 'db'>): void {
  ctx.db.prepare(`UPDATE work_files_copies SET state = 'away' WHERE state = 'sending'`).run()
  const open = ctx.db.prepare(`SELECT id, copy, sent FROM work_files_copies WHERE state = 'ok' AND closed = 0`).all() as unknown as Pick<CopyRow, 'id' | 'copy' | 'sent'>[]
  for (const r of open) {
    try {
      if (sha(readFileSync(r.copy)) !== r.sent) changedAtStart.add(r.id)
    } catch {
      // no copy: nothing of his is in it
    }
  }
}

/** A copy's item went: by its tab's close, or any other way (the pane's Close, a host's check of strays at start). */
function copyLeft(ctx: WorkCtx, r: CopyRow): void {
  ctx.db.prepare(`UPDATE work_files_copies SET closed = 1 WHERE id = ?`).run(r.id)
  // The kind's last save may still be landing as its body goes: it is looked at once that has had time.
  const later = setTimeout(() => void sendBack(ctx, r.id), copyTiming.grace)
  later.unref?.()
}

/**
 * Items of a Files pane went, however they went. A recorded copy among them is kept with its record and sent, and goes
 * only once nothing waits in it (`letGo`): an item no tab shows any more never takes his unsent changes with it. A copy
 * another open item still shows (Keep Both re-seated it) is left as it is.
 */
export function copiesLeft(ctx: WorkCtx, items: readonly CanvasItem[]): void {
  const find = ctx.db.prepare(`SELECT * FROM work_files_copies WHERE copy = ?`)
  for (const item of items) {
    if (item.source.at !== 'file' || item.source.host !== ctx.host) continue
    const r = find.get(real(item.source.path)) as CopyRow | undefined
    if (!r) continue
    const shown = ctx.canvas.forSession(item.sessionId).some((open) => open.id !== item.id && open.source.at === 'file' && real(open.source.path) === r.copy)
    if (!shown) copyLeft(ctx, r)
  }
}

// ── his window ────────────────────────────────────────────────────────

/**
 * His own edit of the file a copy is of: his window, or a key that may approve, since others can open that file
 * (the door's own rule, `admitWrite`). A thread never: it changes files through the `files_*` tools alone.
 */
export function admitOwner(by: Caller, r: Pick<CopyRow, 'name' | 'host'>): void {
  const place: DoorPlace = { id: 'copy', kind: 'teams', name: r.name, host: r.host, env: r.host, shared: true, can: ['edit'], state: { state: 'ok' } }
  if (admitWrite(by, { verb: 'edit', from: place }) === 'hold') throw new Error('A thread changes files with the files_* tools.')
}

/** The copy record a tab shows, for a caller of the workspace's own host. */
export function recordOfTab(ctx: WorkCtx, by: Caller, workspaceId: string, tabId: string): { tab: FileTab; r: CopyRow } {
  admitCaller(ctx, by, workspaceId)
  const tab = filesState(ctx).tabs.list(workspaceId).tabs.find((t) => t.id === tabId)
  const r = tab?.copyOf ? copyRecord(ctx, workspaceId, tab.copyOf.host, tab.copyOf.path) : null
  if (!tab || !r) throw new Error(NOT_SAVING)
  return { tab, r }
}

/** `work.files.copyBack`: the kind saved; what the copy holds goes to its file when it differs. */
export async function copyBack(ctx: WorkCtx, by: Caller, p: { workspaceId: string; tabId: string }): Promise<CopyBack> {
  const { r } = recordOfTab(ctx, by, p.workspaceId, p.tabId)
  admitOwner(by, r)
  await sendBack(ctx, r.id)
  const now = row(ctx, r.id)
  return now ? backOf(now) : { is: 'ok' }
}

/** The file's bytes and its version as its own computer has them now, from one look; nothing is written here. */
export async function freshBytes(ctx: WorkCtx, r: Pick<CopyRow, 'workspace_id' | 'host' | 'path' | 'vm' | 'name'>, signal?: AbortSignal): Promise<{ data: Buffer; version: string }> {
  if (!copyAllowed(ctx.db, r.workspace_id)) throw new Error('This workspace keeps Teams files where they are: turn on Copy Teams files in its settings to open one here.')
  const ref: CanvasSource = { at: 'file', host: r.host, path: r.path }
  if (r.vm) {
    // The guest's file, still in a library OneDrive syncs there, read in pieces by the helper's version.
    const at = locate(ctx, LOCAL, r.workspace_id, ref, 'work.files.copyReload')
    if (at.in !== 'library' || !at.library.vm) throw new Error(NOT_SAVING)
    const parts: Buffer[] = []
    let version: string | undefined
    for (let offset = 0; ; ) {
      const got = await vmReadVersioned(r.path, offset, PIECE, version, signal)
      version = got.version
      const buf = Buffer.from(got.data, 'base64')
      parts.push(buf)
      offset += buf.length
      if (got.end || !buf.length) break
      if (offset > COPY_ACROSS_MAX) throw new Error(TOO_BIG(r.name))
    }
    return { data: Buffer.concat(parts), version: version! }
  }
  const far = ctx.peer.call({ scope: { sessionId: filesPaneOf(r.workspace_id), workspaceId: r.workspace_id }, signal } as never, r.host)
  const sink = bytesSink()
  const version = await farBytes((params) => far.call('office', 'filesRead', { source: ref, as: 'bytes', ...params }) as Promise<FarPiece>, sink)
  if (typeof version !== 'string') throw new Error('The other computer runs an older TempCode: update it to reload here.')
  return { data: sink.bytes(), version }
}

/**
 * The file's version as it is on its computer now, with as little of it as a read carries (its first byte): what a save
 * asks before it decides whether it must pull the whole file. Null from a host a build behind, which names no version
 * of a piece.
 */
export async function freshVersion(ctx: WorkCtx, r: Pick<CopyRow, 'workspace_id' | 'host' | 'path' | 'vm' | 'name'>, signal?: AbortSignal): Promise<string | null> {
  if (!copyAllowed(ctx.db, r.workspace_id)) throw new Error('This workspace keeps Teams files where they are: turn on Copy Teams files in its settings to open one here.')
  const ref: CanvasSource = { at: 'file', host: r.host, path: r.path }
  if (r.vm) {
    const at = locate(ctx, LOCAL, r.workspace_id, ref, 'work.files.copyReload')
    if (at.in !== 'library' || !at.library.vm) throw new Error(NOT_SAVING)
    return (await vmReadVersioned(r.path, 0, 1, undefined, signal)).version
  }
  const far = ctx.peer.call({ scope: { sessionId: filesPaneOf(r.workspace_id), workspaceId: r.workspace_id }, signal } as never, r.host)
  const got = (await far.call('office', 'filesRead', { source: ref, as: 'bytes', offset: 0, length: 1 })) as FarPiece
  return typeof got.version === 'string' && typeof got.size === 'number' ? got.version : null
}

/**
 * `work.files.copyReload`: the file as it is on its computer now, written into the copy the tab's item already names
 * (after Keep Both that file is another than the one first copied, and its copy stays in the tab's one folder); what
 * was not sent is dropped. Only what the question he answered named is dropped: `writes`, the copy's writes it showed
 * (else those at the press). The file is read first; then, with the copy's lock held, the copy must still be at those
 * writes, or nothing is dropped. The bytes go into a staging file beside the copy and take its place in one rename, so
 * a reader sees the old copy or the new one, never part, and a link there is replaced, never followed.
 */
export async function copyReload(ctx: WorkCtx, by: Caller, p: { workspaceId: string; tabId: string; writes?: number }, signal?: AbortSignal): Promise<void> {
  const { tab, r } = recordOfTab(ctx, by, p.workspaceId, p.tabId)
  admitOwner(by, r)
  await flights.get(r.id)?.run
  const asked = p.writes ?? row(ctx, r.id)?.writes ?? r.writes
  if ((row(ctx, r.id)?.writes ?? r.writes) !== asked) throw new Error(RELOAD_EDITED)
  const fresh = await freshBytes(ctx, r, signal)
  await withFileLocks([copyKey(ctx, r.copy)], async () => {
    await workDone(r.copy)
    const now = row(ctx, r.id)
    if (!now || now.copy !== r.copy || now.path !== r.path) throw new Error(RELOAD_MOVED)
    if (now.writes !== asked) throw new Error(RELOAD_EDITED)
    await replaceWhole(r.copy, fresh.data)
    recordCopy(ctx, { workspaceId: p.workspaceId, host: r.host, path: r.path, vm: !!r.vm, copy: r.copy, name: tab.name, kind: r.kind as CanvasKind, version: fresh.version, sha256: sha(fresh.data) })
  })
  keepBody(ctx, r, fresh.data)
  said(ctx, p.workspaceId)
}

/** A copy's bytes replaced whole: a staging file made new beside it (never through a link), synced, renamed over it. */
async function replaceWhole(path: string, data: Buffer): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.reload-${randomUUID().slice(0, 8)}`)
  const out = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    try {
      await out.writeFile(data)
      await out.sync()
    } finally {
      await out.close()
    }
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => {})
  }
}

/**
 * `work.files.copyKeep`, Keep Both: his copy saved beside the file that changed, under the keep-both name
 * ("Roster (mine).xlsx"), on the file's own computer through the same door; the tab then shows that new file. The press
 * is kept on the record with an op id before it goes: pressed again after its answer was lost, the same op goes, and
 * the file's computer answers what the first made (`runOp` there, the guest's journal in the VM), never a second file.
 * The record then holds the bytes that press sent; anything written since is sent to the new file after it.
 */
export async function copyKeep(ctx: WorkCtx, by: Caller, p: { workspaceId: string; tabId: string }): Promise<void> {
  const { tab, r } = recordOfTab(ctx, by, p.workspaceId, p.tabId)
  admitOwner(by, r)
  await flights.get(r.id)?.run
  const was = row(ctx, r.id) ?? r
  const data = await readFile(r.copy)
  if (data.length > COPY_ACROSS_MAX) throw new Error(TOO_BIG(r.name))
  const press: KeepPress = was.keep_press ? (JSON.parse(was.keep_press) as KeepPress) : { op: randomUUID(), sha: sha(data), writes: was.writes }
  ctx.db.prepare(`UPDATE work_files_copies SET keep_press = ? WHERE id = ?`).run(JSON.stringify(press), r.id)
  let got: WrittenBack
  try {
    got = await deliver(ctx, r, data, true, press.op)
  } catch (err) {
    // A refusal is the press's answer: the next is a new press. No answer keeps it, to be asked again.
    if (!unreachable(err)) ctx.db.prepare(`UPDATE work_files_copies SET keep_press = NULL WHERE id = ?`).run(r.id)
    throw err
  }
  if (!('copy' in got)) {
    ctx.db.prepare(`UPDATE work_files_copies SET keep_press = NULL WHERE id = ?`).run(r.id)
    throw new Error('The other computer did not keep the copy.')
  }
  const made = got.copy
  ctx.db
    .prepare(`UPDATE work_files_copies SET path = ?, name = ?, version = ?, sent = ?, state = 'ok', detail = NULL, saved_at = ?, changed_at = NULL, held = MAX(held, ?), keep_press = NULL WHERE id = ?`)
    .run(made.path, made.name, made.version, press.sha, Date.now(), press.writes, r.id)
  const copyOf = { host: r.host, path: made.path, ...(r.vm ? { vm: true } : {}) }
  filesState(ctx).tabs.repoint(p.workspaceId, tab.id, { name: made.name, copyOf })
  if (tab.itemId) {
    const item = ctx.canvas.get(tab.itemId)
    if (item) ctx.canvas.replace(item.sessionId, item.id, item.kind, item.source, made.name)
  }
  // Bytes written since the press first went are not in the new file yet: they go now, by its version.
  if (sha(await readFile(r.copy).catch(() => data)) !== press.sha) void sendBack(ctx, r.id)
}

/**
 * `work.files.copiesMoved`: his window renamed or moved files of another host through that host's door; the
 * workspace's copies of them here (the tab's `copyOf`, the copy's record, a Word file's record, a Save As link) follow
 * to where each now lies. His own act: his window, or a key that may approve. A move of this host's own files carries
 * itself (`fileMoved`), so only another host's are taken. Nothing is read or written on a disk: a record pointed at
 * another file still writes only over the version it read, so a wrong pair can never write over that file.
 */
export function copiesMoved(ctx: WorkCtx, by: Caller, p: { workspaceId: string; moves: { from: CanvasSource | { at: string }; to: CanvasSource | { at: string } }[] }): void {
  admitCaller(ctx, by, p.workspaceId)
  let any = false
  for (const m of p.moves) {
    if (m.from.at !== 'file' || m.to.at !== 'file') continue
    const from = m.from as Extract<CanvasSource, { at: 'file' }>
    const to = m.to as Extract<CanvasSource, { at: 'file' }>
    if (from.host !== to.host || from.host === ctx.host || from.path === to.path) continue
    admitOwner(by, { name: basename(to.path), host: to.host })
    any = farMoved(ctx.db, p.workspaceId, from.host, from.path, to.path) || any
  }
  if (any) said(ctx, p.workspaceId)
}

/** A copy tab closes: with `discard` what waits goes with it, now; else the copy is kept and sent, then let go. */
export function copyClosing(ctx: WorkCtx, workspaceId: string, tab: FileTab | undefined, discard: boolean): void {
  const r = tab?.copyOf ? copyRecord(ctx, workspaceId, tab.copyOf.host, tab.copyOf.path) : null
  if (!r) return
  if (!discard) return copyLeft(ctx, r)
  // He chose to drop what waits: the copy goes with its tab, now.
  ctx.db.prepare(`DELETE FROM work_files_copies WHERE id = ?`).run(r.id)
  rmSync(r.dir, { recursive: true, force: true })
}

/**
 * The folder a Files tab's copy of `file` is made in: its own (office/files/handle.ts `copyFolderOf`), or, when a live
 * copy of another file holds that one (Keep Both re-pointed its record, or its file moved and a new one took the old
 * name), the next that none holds. Each live copy has its own file, so opening one never writes over another's bytes.
 * `fresh`: one that is not on the disk either.
 */
export function copyFolderFor(ctx: Pick<WorkCtx, 'db' | 'dataDir'>, workspaceId: string, file: { host: string; path: string }, fresh = false): string {
  for (let n = 0; ; n++) {
    const dir = copyFolderOf(ctx.dataDir, filesPaneOf(workspaceId), file, n)
    if (!copyFolderTaken(ctx.db, workspaceId, dir, file) && !(fresh && existsSync(dir))) return dir
  }
}

/**
 * At start: records an older build left on one copy (Keep Both, then the original opened again, wrote the original's
 * bytes into the kept tab's copy) are each given their own. The newest keeps the copy, whose bytes its open wrote; each
 * other gets a copy of those bytes in a folder of its own, and its tab's item follows. One whose bytes are not what its
 * file holds is marked changed: nothing is sent from it, and his Reload brings its file back (or Keep Both keeps them).
 * Answers how many moved.
 */
export function ownCopyFolders(ctx: WorkCtx): number {
  const shared = ctx.db.prepare(`SELECT workspace_id, copy FROM work_files_copies GROUP BY workspace_id, copy HAVING COUNT(*) > 1`).all() as { workspace_id: string; copy: string }[]
  let moved = 0
  for (const s of shared) {
    const rows = ctx.db.prepare(`SELECT * FROM work_files_copies WHERE workspace_id = ? AND copy = ? ORDER BY at DESC`).all(s.workspace_id, s.copy) as unknown as CopyRow[]
    let bytes: Buffer
    try {
      bytes = readFileSync(s.copy)
    } catch (err) {
      ctx.log(`files: a shared copy could not be read, and is left as it is: ${message(err)}`)
      continue
    }
    for (const r of rows.slice(1)) {
      const dir = copyFolderFor(ctx, r.workspace_id, r, true)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const to = join(dir, basename(r.copy))
      const temp = `${to}.part-${randomUUID().slice(0, 8)}`
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
      renameSync(temp, to)
      const theirs = sha(bytes) === r.sent
      ctx.db.prepare(`UPDATE work_files_copies SET copy = ?, dir = ?, state = ?, changed_at = ? WHERE id = ?`).run(real(to), real(dir), theirs ? r.state : 'changed', theirs ? r.changed_at : Date.now(), r.id)
      // Its tab shows an item of its own copy: one item showed both tabs (an item is one a source), so a new one opens.
      const tabs = filesState(ctx).tabs
      for (const tab of tabs.list(r.workspace_id).tabs) {
        if (tab.copyOf?.host !== r.host || tab.copyOf.path !== r.path || !tab.itemId) continue
        const item = ctx.canvas.get(tab.itemId)
        if (!item) continue
        const mine = ctx.canvas.open(item.sessionId, item.kind, { at: 'file', host: ctx.host, path: real(to) }, item.title)
        tabs.reseat(r.workspace_id, tab.id, mine.id)
      }
      moved++
    }
  }
  if (moved) for (const s of new Set(shared.map((x) => x.workspace_id))) said(ctx, s)
  return moved
}

/** A copy a closed tab kept, opened again: the tab shows it with what waits in it, and it is a tab's again. */
export function reopened(ctx: Pick<WorkCtx, 'db'>, r: CopyRow): void {
  ctx.db.prepare(`UPDATE work_files_copies SET closed = 0 WHERE id = ?`).run(r.id)
}

// ── the file's own host ───────────────────────────────────────────────

/**
 * `work.files.writeBack`, run where the file lies, for the workspace's host sending a copy back. Admitted exactly as
 * his own save of that library file here would be (`admitChange` as `edit`, a peer's change only with its origin),
 * then written by `saveFile` over the file only while it is still `version`, or with `copy` beside it under the
 * keep-both name, never over anything. `into`: Save as Word to… a library folder here: `ref` names the new file,
 * made in its folder under a free name through New's door (`make`), never over anything.
 */
export async function writeBack(ctx: WorkCtx, by: Caller, p: { workspaceId: string; ref: CanvasSource; data: string; pieces?: PieceRef; version: string; copy?: boolean; into?: boolean; op?: string; origin: FileOrigin }, method: string): Promise<WrittenBack> {
  if (by.kind !== 'remote' || !by.peer) throw new Error(ONLY_HOST)
  // Sent in pieces (pieces.ts), kept here for this write alone; the door below admits the write as it always did.
  const data = p.pieces ? takePieces(by, p.workspaceId, p.pieces) : Buffer.from(p.data, 'base64')
  if (data.length > COPY_ACROSS_MAX) throw new Error(TOO_BIG(basename(p.ref.at === 'file' ? p.ref.path : 'This file')))
  if (p.ref.at !== 'file') throw new Error('A copy goes back to a file on a disk.')
  const path = p.ref.path
  if (p.into) {
    // Save as Word to… a folder of this host's (saveAsWord.ts): a new file in it under a free name, through New's door.
    const folder = { at: 'file' as const, host: p.ref.host, path: dirname(path) }
    admitChange(ctx, by, 'make', { workspaceId: p.workspaceId, refs: [folder], origin: p.origin }, method)
    const at = locate(ctx, by, p.workspaceId, folder, method)
    if (at.in !== 'library' || at.library.vm) throw new Error("Another host reaches only this host's libraries.")
    const make = async (): Promise<WrittenBack> => {
      const done = await makeBytes(ctx, by, { workspaceId: p.workspaceId, at: folder, name: basename(path), data, op: p.op ?? randomUUID() }, method)
      const made = done.entries[0]?.ref
      if (made?.at !== 'file') throw new Error('The file was not made.')
      const v = await versionOf(made.path)
      return { copy: { path: made.path, name: basename(made.path), version: versionWord(v), changed: Math.round(v.mtimeMs) } }
    }
    // The press's id: the same press sent again (its answer was lost on the way back) answers the file it made, never a second one.
    return p.op ? runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'writeBack.into', refs: { ref: p.ref } }, make) : make()
  }
  if (p.copy) {
    const folder = { at: 'file' as const, host: p.ref.host, path: dirname(path) }
    admitChange(ctx, by, 'edit', { workspaceId: p.workspaceId, refs: [folder], origin: p.origin }, method)
    const at = locate(ctx, by, p.workspaceId, folder, method)
    if (at.in !== 'library' || at.library.vm) throw new Error("Another host reaches only this host's libraries.")
    const keep = async (): Promise<WrittenBack> => {
      const made = await saveCopy({ roots: [at.library.path] }, join(at.path, basename(path)), data)
      const v = await versionOf(made)
      return { copy: { path: made, name: basename(made), version: versionWord(v), changed: Math.round(v.mtimeMs) } }
    }
    // Keep Both's press asked again after its answer was lost: the file it made is answered, and nothing is made twice.
    return p.op ? runOp(ctx.db, { id: p.op, workspaceId: p.workspaceId, verb: 'writeBack.copy', refs: { ref: p.ref } }, keep) : keep()
  }
  let at: ReturnType<typeof locate>
  try {
    admitChange(ctx, by, 'edit', { workspaceId: p.workspaceId, refs: [p.ref], origin: p.origin }, method)
    at = locate(ctx, by, p.workspaceId, p.ref, method)
  } catch (err) {
    // A file that is gone is the save's conflict, never a file made again under its old name.
    if (err instanceof Error && / is not there any more\.$/.test(err.message)) return { conflict: { gone: true } }
    throw err
  }
  if (at.in !== 'library' || at.library.vm) throw new Error("Another host reaches only this host's libraries.")
  const { library } = doorPlace(ctx, by, at)
  try {
    return await saveFile({ roots: [at.library.path] }, library ? libraryKey(library, at.path) : at.path, at.path, data, p.version)
  } catch (err) {
    if (err instanceof FileRefused && err.code === 'gone') return { conflict: { gone: true } }
    throw err
  }
}

/** A copy's own state, for a test or a proof: null once it is let go. */
export const copyRowOf = (ctx: Pick<WorkCtx, 'db'>, id: string): CopyRow | null => row(ctx, id)

/** The sends under way, for a test that waits for them. */
export const copiesInFlight = (): Promise<void>[] => [...flights.values()].map((f) => f.run)
