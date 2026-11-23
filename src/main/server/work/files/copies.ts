import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CopyBack, FileOrigin, FileTab, WrittenBack } from '@shared/contract-work-files'
import { filesPaneOf, type CanvasKind, type CanvasSource } from '@shared/work'
import { COPY_ACROSS_MAX, freeName, splitName } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { copyIn } from '../office/files/handle'
import { vmList } from '../office/vm/files'
import { VmUnreachable } from '../office/vm/link'
import { vmState } from '../office/vm/office'
import { hostReadOf } from '../peer'
import { admitChange, doorPlace, filesState, vmWhere } from './handle'
import { forgetVmList, libraryKey } from './places/teams'
import { admitCaller, admitWrite, locate, type DoorPlace } from './policy'
import { saveCopy, saveFile, versionWord } from './save'
import { guestChange, guestOp, vmReadVersioned, vmSave } from './vmVerbs'
import { FileRefused, OpLost, versionOf } from './write'

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
}

/** His window: what the workspace's host itself sends as when the press was his. */
const LOCAL: Caller = { kind: 'local', caps: ['read', 'operate', 'approve'] }
/** How long a closed tab's copy waits for its kind's last save before it is sent and let go (a test sets it to 0). */
export const copyTiming = { grace: 3000 }
const TOO_BIG = (name: string): string => `${name} is over ${COPY_ACROSS_MAX / 1024 / 1024} MB, too big to send back.`
export const NOT_SAVING = "This copy's changes stay here."
const ONLY_HOST = "A copy is sent back by the workspace's own host."
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
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
         version = excluded.version, sent = excluded.sent, state = 'ok', detail = NULL, saved_at = NULL, changed_at = NULL, closed = 0, at = excluded.at`
    )
    .run(randomUUID(), c.workspaceId, c.host, c.path, c.vm ? 1 : 0, copy, dirname(copy), c.name, c.kind, c.version, c.sha256, Date.now())
  return copyRecord(ctx, c.workspaceId, c.host, c.path)!
}

/** How sending stands, as a tab says it. */
export function backOf(r: CopyRow): CopyBack {
  const at = r.state === 'changed' ? r.changed_at : r.state === 'ok' ? r.saved_at : null
  return { is: r.state, ...(at ? { at } : {}), ...(r.state === 'refused' && r.detail ? { detail: r.detail } : {}) }
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
async function deliver(ctx: WorkCtx, r: CopyRow, data: Buffer, keep: boolean): Promise<WrittenBack> {
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
    const made = await guestChange<{ entry: { path: string } }>('files.write', { dir, name, data: data.toString('base64'), op: guestOp(randomUUID()) })
    forgetVmList(w.library.library.id, dir)
    const now = await vmReadVersioned(made.entry.path, 0, 1)
    return { copy: { path: made.entry.path, name: basename(made.entry.path.replaceAll('\\', '/')), version: now.version, changed: now.changed } }
  }
  // Another host of his: its own module runs the save, as his window's press there would (`writeBack`).
  const origin: FileOrigin = { from: 'window' }
  const far = ctx.peer.call({ scope: { sessionId: filesPaneOf(r.workspace_id), workspaceId: r.workspace_id } } as never, r.host)
  return (await far.call('files', 'writeBack', { workspaceId: r.workspace_id, ref, data: data.toString('base64'), version: r.version, origin, ...(keep ? { copy: true } : {}) })) as WrittenBack
}

/** One look: the copy's bytes as they lie, sent when they differ from what the file holds. */
async function sendOnce(ctx: WorkCtx, id: string): Promise<void> {
  const r = row(ctx, id)
  // A file that changed there, or went, waits for his Reload or Keep Both: nothing is sent over it.
  if (!r || r.state === 'changed' || r.state === 'gone') return
  let data: Buffer
  try {
    data = await readFile(r.copy)
  } catch {
    // The copy went (Copy Teams files turned off, the workspace gone): so does what was kept of it.
    return letGo(ctx, r)
  }
  const hash = sha(data)
  if (hash === r.sent) {
    if (r.closed) return letGo(ctx, r)
    if (r.state !== 'ok') setState(ctx, r, 'ok')
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
  if ('conflict' in got) return 'gone' in got.conflict ? setState(ctx, r, 'gone') : setState(ctx, r, 'changed', { changedAt: got.conflict.changed })
  if (!('version' in got)) return setState(ctx, r, 'refused', { detail: 'The other computer answered something else.' })
  ctx.db.prepare(`UPDATE work_files_copies SET version = ?, sent = ?, state = 'ok', detail = NULL, saved_at = ?, changed_at = NULL WHERE id = ?`).run(got.version, hash, Date.now(), r.id)
  const after = row(ctx, r.id)
  if (after?.closed) return letGo(ctx, after)
  said(ctx, r.workspace_id)
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

/** `saveFile` replaced a file: when it is a copy that saves back, it is sent. */
export function copySaved(ctx: WorkCtx, path: string): void {
  const r = ctx.db.prepare(`SELECT id FROM work_files_copies WHERE copy = ?`).get(real(path)) as { id: string } | undefined
  if (r) void sendBack(ctx, r.id)
}

/**
 * Copies whose computer did not answer are sent again once it does: another host when its link is up, the VM once
 * it is awake (a send never wakes it from here). A send a dead process left under way is tried again too.
 */
export function retryWaiting(ctx: WorkCtx, hosts?: readonly string[]): void {
  const rows = ctx.db.prepare(`SELECT * FROM work_files_copies WHERE state IN ('away', 'sending') OR (closed = 1 AND state = 'ok')`).all() as unknown as CopyRow[]
  if (!rows.length) return
  const up = new Set(hosts ?? hostReadOf(ctx)?.hosts() ?? [])
  const awake = vmState()?.state === 'awake'
  for (const r of rows) if (!flights.has(r.id) && (r.vm ? awake : up.has(r.host))) void sendBack(ctx, r.id)
}

/** At start: a send a dead process left under way did not land as far as this host knows; it waits as unanswered. */
export function settleCopies(ctx: Pick<WorkCtx, 'db'>): void {
  ctx.db.prepare(`UPDATE work_files_copies SET state = 'away' WHERE state = 'sending'`).run()
}

// ── his window ────────────────────────────────────────────────────────

/**
 * His own edit of the file a copy is of: his window, or a key that may approve, since others can open that file
 * (the door's own rule, `admitWrite`). A thread never: it changes files through the `files_*` tools alone.
 */
export function admitOwner(by: Caller, r: CopyRow): void {
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

/** `work.files.copyReload`: the file as it is on its computer now, read into the copy's place; what was not sent is dropped. */
export async function copyReload(ctx: WorkCtx, by: Caller, p: { workspaceId: string; tabId: string }, signal?: AbortSignal): Promise<void> {
  const { tab, r } = recordOfTab(ctx, by, p.workspaceId, p.tabId)
  admitOwner(by, r)
  await flights.get(r.id)?.run
  const made = await copyIn(ctx, filesPaneOf(p.workspaceId), { at: 'file', host: r.host, path: r.path }, signal)
  if (!made.version) throw new Error('The other computer runs an older TempCode: update it to reload here.')
  const copy = (made.source as { path: string }).path
  const data = await readFile(copy)
  recordCopy(ctx, { workspaceId: p.workspaceId, host: r.host, path: r.path, vm: !!r.vm, copy, name: tab.name, kind: r.kind as CanvasKind, version: made.version, sha256: sha(data) })
  said(ctx, p.workspaceId)
}

/**
 * `work.files.copyKeep`, Keep Both: his copy saved beside the file that changed, under the keep-both name
 * ("Roster (mine).xlsx"), on the file's own computer through the same door; the tab then shows that new file.
 */
export async function copyKeep(ctx: WorkCtx, by: Caller, p: { workspaceId: string; tabId: string }): Promise<void> {
  const { tab, r } = recordOfTab(ctx, by, p.workspaceId, p.tabId)
  admitOwner(by, r)
  await flights.get(r.id)?.run
  const data = await readFile(r.copy)
  if (data.length > COPY_ACROSS_MAX) throw new Error(TOO_BIG(r.name))
  const got = await deliver(ctx, r, data, true)
  if (!('copy' in got)) throw new Error('The other computer did not keep the copy.')
  const made = got.copy
  ctx.db
    .prepare(`UPDATE work_files_copies SET path = ?, name = ?, version = ?, sent = ?, state = 'ok', detail = NULL, saved_at = ?, changed_at = NULL WHERE id = ?`)
    .run(made.path, made.name, made.version, sha(data), Date.now(), r.id)
  const copyOf = { host: r.host, path: made.path, ...(r.vm ? { vm: true } : {}) }
  filesState(ctx).tabs.repoint(p.workspaceId, tab.id, { name: made.name, copyOf })
  if (tab.itemId) {
    const item = ctx.canvas.get(tab.itemId)
    if (item) ctx.canvas.replace(item.sessionId, item.id, item.kind, item.source, made.name)
  }
}

/** A copy tab closes: with `discard` what waits goes with it; else the copy is kept and sent, then let go. */
export function copyClosing(ctx: WorkCtx, workspaceId: string, tab: FileTab | undefined, discard: boolean): void {
  const r = tab?.copyOf ? copyRecord(ctx, workspaceId, tab.copyOf.host, tab.copyOf.path) : null
  if (!r) return
  if (discard) {
    // He chose to drop what waits: the copy goes with its tab, now.
    ctx.db.prepare(`DELETE FROM work_files_copies WHERE id = ?`).run(r.id)
    rmSync(r.dir, { recursive: true, force: true })
    return
  }
  ctx.db.prepare(`UPDATE work_files_copies SET closed = 1 WHERE id = ?`).run(r.id)
  // The kind's last save may still be landing as its body goes: it is looked at once that has had time.
  const later = setTimeout(() => void sendBack(ctx, r.id), copyTiming.grace)
  later.unref?.()
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
 * keep-both name, never over anything.
 */
export async function writeBack(ctx: WorkCtx, by: Caller, p: { workspaceId: string; ref: CanvasSource; data: string; version: string; copy?: boolean; origin: FileOrigin }, method: string): Promise<WrittenBack> {
  if (by.kind !== 'remote' || !by.peer) throw new Error(ONLY_HOST)
  const data = Buffer.from(p.data, 'base64')
  if (data.length > COPY_ACROSS_MAX) throw new Error(TOO_BIG(basename(p.ref.at === 'file' ? p.ref.path : 'This file')))
  if (p.ref.at !== 'file') throw new Error('A copy goes back to a file on a disk.')
  const path = p.ref.path
  if (p.copy) {
    const folder = { at: 'file' as const, host: p.ref.host, path: dirname(path) }
    admitChange(ctx, by, 'edit', { workspaceId: p.workspaceId, refs: [folder], origin: p.origin }, method)
    const at = locate(ctx, by, p.workspaceId, folder, method)
    if (at.in !== 'library' || at.library.vm) throw new Error("Another host reaches only this host's libraries.")
    const made = await saveCopy({ roots: [at.library.path] }, join(at.path, basename(path)), data)
    const v = await versionOf(made)
    return { copy: { path: made, name: basename(made), version: versionWord(v), changed: Math.round(v.mtimeMs) } }
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
