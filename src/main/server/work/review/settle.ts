import { randomBytes } from 'node:crypto'
import type { ReviewSettled } from '@shared/contract-work-review'
import type { SectorKey } from '@shared/work'
import { weekOf, type SettleHow, type SlippedRef } from '@shared/work/review'
import { WORK_MODULES, type Caller, type WorkCtx } from '../modules'
import { heldKey, outboxCall } from './gather/held'
import { dropMark, setMark } from './store'

/**
 * His press on a slipped row (docs/agents/work-review.md "The presses"). Each press calls the thing's own write and
 * nothing else: a task's `tasks:complete`, `tasks:update` or `tasks:drop`; a waiting mail's nudge, `mailWaits:putOff`
 * or `mailWaits:dismiss`; a held item's discard. The review declares no act kind and sends nothing: a nudge is a draft
 * held like every draft, and a held item's own Send stays in the Outbox. "Next week" on a held item or a meeting, and
 * "None needed" on a meeting, are marks of the review's own.
 *
 * Only a person who may approve presses: a thread's own call is refused before anything is read.
 */

export const NOT_A_PERSON = 'Only you can settle what slipped: a thread cannot.'
export const OPEN_IN_OUTBOX = 'Open it in the Outbox: the review never sends a held item.'
export const NO_JOB_HERE = 'No workspace of that job is on this host'
export const UNDO_GONE = 'That can no longer be taken back here.'
const DROP_REASON = 'Dropped in the weekly review'

const HOUR = 60 * 60_000
/** A date with no time means 9:00 in LifeOS, so a thing moved to next week is due Monday at nine. */
const MONDAY_AT = 9 * HOUR

export function mustBePerson(by: Caller): void {
  if (by.kind === 'model' || !by.caps.includes('approve')) throw new Error(NOT_A_PERSON)
}

/** The first moment of next week in `tz`, counted from `now`. */
export const nextWeek = (now: number, tz: string): number => weekOf(now, tz).to

// A press's way back, held in memory for a while: the toast that offers it lasts seconds.
type Undo = { run: () => Promise<void>; at: number }
const UNDO_FOR_MS = 30 * 60_000
const UNDO_MOST = 100
const undos = new Map<string, Undo>()

function keepUndo(run: () => Promise<void>, now: number): string {
  for (const [token, u] of undos) if (now - u.at > UNDO_FOR_MS || undos.size >= UNDO_MOST) undos.delete(token)
  const token = randomBytes(12).toString('base64url')
  undos.set(token, { run, at: now })
  return token
}

export async function undo(by: Caller, token: string, now: number): Promise<{ ok: true }> {
  mustBePerson(by)
  const u = undos.get(token)
  // Taken out before it runs: a second press, or two windows, never run it twice.
  undos.delete(token)
  if (!u || now - u.at > UNDO_FOR_MS) throw new Error(UNDO_GONE)
  await u.run()
  return { ok: true }
}

/** For a test: the tokens held now. */
export const undoCount = (): number => undos.size
export const forgetUndos = (): void => undos.clear()

async function mailCall<T>(ctx: WorkCtx, by: Caller, method: string, params: unknown): Promise<T> {
  const mail = WORK_MODULES.find((m) => m.id === 'mail')
  if (!mail?.handle) throw new Error('Mail is not running on this host')
  const answer = await mail.handle({ id: 'review', method, params } as never, ctx, by)
  if (!answer.handled) throw new Error('Mail did not take the call')
  return answer.result as T
}

/** This host's Work workspace for a sector: where a nudge's thread is started. */
function workspaceOf(ctx: WorkCtx, sector: SectorKey | undefined): string {
  const row = sector ? (ctx.db.prepare(`SELECT id FROM workspaces WHERE kind = 'work' AND sector = ? ORDER BY created_at, id LIMIT 1`).get(sector) as { id: string } | undefined) : undefined
  if (!row) throw new Error(NO_JOB_HERE)
  return row.id
}

export async function settle(ctx: WorkCtx, by: Caller, p: { row: SlippedRef; how: SettleHow; tz: string; sector?: SectorKey }, now: number): Promise<ReviewSettled> {
  mustBePerson(by)
  const { row, how } = p
  const monday = nextWeek(now, p.tz)
  const kept = (run: () => Promise<void>): ReviewSettled => ({ undo: keepUndo(run, now) })

  if (row.kind === 'task') {
    const owner = ctx.lifeos.owner()
    if (how === 'now') {
      await owner.mutation('tasks:complete', { id: row.id })
      return kept(async () => void (await owner.mutation('tasks:reopen', { id: row.id })))
    }
    if (how === 'later') {
      await owner.mutation('tasks:update', { id: row.id, patch: { dueAt: monday + MONDAY_AT } })
      return kept(async () => void (await owner.mutation('tasks:update', { id: row.id, patch: { dueAt: row.dueAt } })))
    }
    await owner.mutation('tasks:drop', { id: row.id, reason: DROP_REASON })
    return kept(async () => void (await owner.mutation('tasks:reopen', { id: row.id })))
  }

  if (row.kind === 'mail') {
    if (how === 'now') {
      // A draft, held like every draft: nothing is sent here, and there is nothing to take back.
      const { sessionId } = await mailCall<{ sessionId: string }>(ctx, by, 'work.mail.nudge', { workspaceId: workspaceOf(ctx, p.sector), threadId: row.threadId })
      return { undo: null, sessionId }
    }
    const owner = ctx.lifeos.owner()
    const was =
      how === 'later'
        ? await owner.mutation<{ state: string; dueAt: number } | null>('mailWaits:putOff', { threadId: row.threadId, until: monday + MONDAY_AT, since: row.since })
        : await owner.mutation<{ state: string; dueAt: number } | null>('mailWaits:dismiss', { threadId: row.threadId, since: row.since })
    if (!was) return { undo: null }
    return kept(async () => void (await owner.mutation('mailWaits:putBack', { threadId: row.threadId, state: was.state, dueAt: was.dueAt, since: row.since })))
  }

  if (row.kind === 'held') {
    if (how === 'now') throw new Error(OPEN_IN_OUTBOX)
    if (how === 'drop') {
      // The Outbox's own discard, as his press there: it never goes, and that cannot be taken back.
      await outboxCall(ctx, 'work.outbox.discard', { ref: row.ref }, by)
      return { undo: null }
    }
    const key = heldKey(row.ref)
    setMark(ctx.db, { key, how: 'later', until: monday }, now)
    return kept(async () => dropMark(ctx.db, key))
  }

  // A meeting: following up is a thread he starts in the window, so only the two marks land here.
  if (how === 'now') throw new Error('Start the follow-up from the page: it opens a new thread about the meeting.')
  const key = `meeting:${row.eventId}`
  setMark(ctx.db, { key, how, until: how === 'later' ? monday : null }, now)
  return kept(async () => dropMark(ctx.db, key))
}
