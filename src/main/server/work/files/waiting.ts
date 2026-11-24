import { FileActSchema, type FileAct, type FileRef } from '@shared/contract-work-files'
import type { CanvasSource } from '@shared/work'
import { kindOfEntry, UNTITLED, type FileEntry } from '@shared/work/files'
import type { Caller, WorkCtx } from '../modules'
import { HELD_TABLE, PRESSABLE } from '../outbox/store'
import { fileWaitingHooks } from './hooks'
import { pressesFor } from './policy'

/**
 * What waits on him in a file (docs/agents/work-files.md "Home"): an agent's suggestions, counted by the pillars that
 * keep them by file (`registerFileWaiting`, hooks.ts) and never by reading a file, and a thread's change to a file
 * others can open, held as a `file.act` until his press. The first fills a row's state (`withWaiting`); both fill
 * Home's Waiting on you (`waitingFiles`; LifeOS's rows are places/lifeos.ts `waitingRows`).
 */

/** How many rows of one answer are counted, at most: a page past its first hundred rows is not asked about. */
export const COUNTED_MOST = 100

const hereOf = (ctx: Pick<WorkCtx, 'host'>, ref: CanvasSource): boolean => ref.at === 'file' && ref.host === ctx.host

/**
 * The rows with `state: { is: 'suggestions', count }` where suggestions wait: the files of this host among the first
 * hundred, that show no other state. One question to each pillar for the whole page.
 */
export function withWaiting(ctx: Pick<WorkCtx, 'db' | 'host' | 'log'>, entries: FileEntry[]): FileEntry[] {
  const hooks = fileWaitingHooks()
  if (!hooks.length) return entries
  const asked = entries.slice(0, COUNTED_MOST).flatMap((e, i) => (e.ref && !e.folder && !e.state && hereOf(ctx, e.ref) ? [i] : []))
  if (!asked.length) return entries
  const sources = asked.map((i) => entries[i]!.ref!)
  const sums = asked.map(() => 0)
  for (const hook of hooks) {
    try {
      hook.count(sources, ctx.db).forEach((n, j) => (sums[j]! += n))
    } catch (err) {
      ctx.log(`files: waiting suggestions could not be counted: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!sums.some((n) => n > 0)) return entries
  const out = entries.slice()
  asked.forEach((i, j) => {
    if (sums[j]! > 0) out[i] = { ...out[i]!, state: { is: 'suggestions', count: sums[j]! } }
  })
  return out
}

/** The held `file.act` items of a workspace that still wait for his press, newest first. A payload this build cannot read is left out, and so is everything where the Outbox keeps no table. */
export function heldFileActs(ctx: Pick<WorkCtx, 'db'>, workspaceId: string, most: number): { id: string; act: FileAct }[] {
  let rows: { id: string; payload: string }[]
  try {
    rows = ctx.db
      .prepare(`SELECT id, payload FROM ${HELD_TABLE} WHERE kind = 'file.act' AND workspace_id = ? AND state IN (${PRESSABLE.map(() => '?').join(', ')}) ORDER BY created_at DESC LIMIT ?`)
      .all(workspaceId, ...PRESSABLE, most) as { id: string; payload: string }[]
  } catch {
    return []
  }
  return rows.flatMap((r) => {
    try {
      const got = FileActSchema.safeParse(JSON.parse(r.payload))
      return got.success ? [{ id: r.id, act: got.data }] : []
    } catch {
      return []
    }
  })
}

/**
 * Home's Waiting on you, `most` rows at most: each file a held act names (as it is now, where this host can still
 * find it, else as the act named it), then the files of the workspace with suggestions waiting. `entryAt` answers a
 * ref as the caller's row, or null for one outside the workspace or the caller's reach; it stats, and reads no file.
 * `mayName` says whether the caller could name a ref of this host now (the door's `locate`). A held act is told of
 * only to a caller that could name everything it names: his window every act; a key only an act on this host whose
 * every ref and destination it could name, and only one that may approve, so a key never hears a proposed name, folder
 * or act id of a place beyond its reach, nor one it may not decide.
 */
export async function waitingFiles(ctx: Pick<WorkCtx, 'db' | 'host' | 'log' | 'reaches'>, by: Caller, workspaceId: string, most: number, entryAt: (ref: CanvasSource) => Promise<FileEntry | null>, mayName: (ref: FileRef) => boolean): Promise<FileEntry[]> {
  const out = new Map<string, FileEntry>()
  const put = (e: FileEntry): void => void (out.size < most && !out.has(e.key) && out.set(e.key, e))
  // His press alone hears what a held act would name (round 2): a read or operate key does not, whatever it reaches.
  const sees = (act: FileAct): boolean => by.kind === 'local' || (pressesFor(by) && act.host === ctx.host && [...act.request.refs, ...(act.request.to ? [act.request.to] : [])].every(mayName))
  for (const { id, act } of heldFileActs(ctx, workspaceId, most)) {
    if (!sees(act)) continue
    const held = { id, verb: act.verb }
    const where = { place: act.from.place, name: act.from.name, trail: act.from.trail }
    if (act.verb === 'make') {
      const kind = act.request.kind ?? 'document'
      const name = act.request.name ?? UNTITLED[kind]
      put({ key: `held:${id}`, ref: null, folder: null, name, kind, where, shared: true, held })
      continue
    }
    for (const [i, thing] of act.things.entries()) {
      const ref = act.request.refs[i]
      if (!ref) continue
      const now = act.host === ctx.host && ref.at === 'file' ? await entryAt(ref).catch(() => null) : null
      put(now ? { ...now, held } : { key: thing.key, ref: ref.at === 'file' ? (ref as CanvasSource) : null, folder: null, name: thing.name, kind: kindOfEntry(thing.name).kind, where, shared: true, held })
    }
  }
  for (const hook of fileWaitingHooks()) {
    let files: { source: CanvasSource; count: number }[]
    try {
      files = hook.files(ctx.db, ctx.host, most)
    } catch (err) {
      ctx.log(`files: waiting suggestions could not be listed: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    for (const f of files) {
      if (out.size >= most) break
      const e = await entryAt(f.source).catch(() => null)
      if (e && !e.folder) put({ ...e, state: { is: 'suggestions', count: f.count } })
    }
  }
  return [...out.values()]
}
