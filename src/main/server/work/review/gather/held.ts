import type { OutboxItem } from '@shared/contract-work-outbox'
import { HELD_SLIPS_MS, type HostPoint, type ShippedRow, type SlippedRow } from '@shared/work/review'
import { WORK_MODULES, type Caller, type WorkCtx } from '../../modules'
import { jobIndex, text, type Asked, type Jobs } from './common'

/**
 * Held items, from the Outbox's own list on this host (its module's `handle`, as the mail pillar reaches routines):
 * the ones that have waited a day or more, the ones that went out on his press in the week, and each press as a sign
 * he was at the desk. A held mail that was sent is listed once, as the mail LifeOS holds, so it is left out of what
 * shipped here.
 */

/** The host's own call into another pillar: a person at this machine, since nothing a thread asked for reaches here. */
export const HOST: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }

const MAIL_KINDS = new Set(['mail.send', 'office.mail.send'])
const MOST = 500

export async function outboxCall<T>(ctx: WorkCtx, method: string, params: unknown, by: Caller = HOST): Promise<T> {
  const outbox = WORK_MODULES.find((m) => m.id === 'outbox')
  if (!outbox?.handle) throw new Error('The Outbox is not running on this host')
  const answer = await outbox.handle({ id: 'review', method, params } as never, ctx, by)
  if (!answer.handled) throw new Error('The Outbox did not take the call')
  return answer.result as T
}

export const heldKey = (ref: OutboxItem['ref']): string => (ref.at === 'host' ? `held:host:${ref.id}` : `held:lifeos:${ref.table}:${ref.id}`)

/**
 * `part`: a list came back full at its cap, so it may not hold everything: the waiting list past its 500th item, or
 * the decided list (newest first) whose oldest item was decided after the span began. What was read counts; a kept
 * row past the cut is not called dealt with, and no "nothing" stands on it.
 */
export type HeldFacts = { slipped: SlippedRow[]; shipped: ShippedRow[]; points: HostPoint[]; before: HostPoint[]; part: boolean }

export async function heldFacts(ctx: WorkCtx, asked: Asked, jobs: Jobs, hidden: ReadonlySet<string>): Promise<HeldFacts> {
  const waiting = (await outboxCall<{ items: OutboxItem[] }>(ctx, 'work.outbox.list', { show: 'waiting', limit: MOST })).items
  const decided = (await outboxCall<{ items: OutboxItem[] }>(ctx, 'work.outbox.list', { show: 'decided', limit: MOST })).items
  const since = Math.min(asked.from, asked.before.from)
  // The Outbox's list has no cursor for decided items: a full one that does not reach back past the span's start may
  // have left some of the span's out.
  const reaches = decided.some((i) => Math.min(i.updatedAt, i.decidedAt ?? i.updatedAt) < since)
  const part = waiting.length >= MOST || (decided.length >= MOST && !reaches)
  const out: HeldFacts = { slipped: [], shipped: [], points: [], before: [], part }
  const jobOf = (i: OutboxItem): number | null => jobIndex(jobs, i.workspaceId, i.sector)
  for (const i of waiting) {
    const key = heldKey(i.ref)
    // A thread's tool reads its own job alone; the page lists a held item whether or not a job is found for it.
    if (asked.only !== undefined && jobOf(i) === null) continue
    if ((i.state !== 'held' && i.state !== 'failed') || i.createdAt > asked.cut - HELD_SLIPS_MS || hidden.has(key)) continue
    out.slipped.push({ key, ref: { kind: 'held', ref: i.ref }, sector: i.sector, workspaceId: i.workspaceId, title: text(i.summary) || 'A held item', at: i.createdAt, people: [], others: 0, open: true })
  }
  for (const i of decided) {
    const job = jobOf(i)
    if (job === null || i.decidedAt === null || !i.decidedBy?.startsWith('owner')) continue
    if (i.decidedAt >= asked.from && i.decidedAt < asked.to) {
      out.points.push([i.decidedAt, job, 'pressed'])
      if (i.state === 'sent' && !MAIL_KINDS.has(i.kind))
        out.shipped.push({ key: heldKey(i.ref), kind: 'approved', sector: i.sector, workspaceId: i.workspaceId, title: text(i.summary) || 'A held item', who: null, at: i.decidedAt, open: { at: 'held', ref: i.ref } })
    } else if (i.decidedAt >= asked.before.from && i.decidedAt < asked.before.to) out.before.push([i.decidedAt, job, 'pressed'])
  }
  return out
}
