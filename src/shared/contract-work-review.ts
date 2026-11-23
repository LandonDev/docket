import { z } from 'zod'
import { HeldRefSchema } from './work/acts'
import { POINT_KINDS, SETTLE_HOWS, type ReviewBody, type SlippedRef } from './work/review'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The weekly review's wire (docs/agents/work-review.md). Its methods are
 * `work.review.<verb>`; src/shared/work/wire.ts has the helpers and the rules.
 *
 * A review is one page above the workspaces, so no method names a workspace:
 * each host answers for its own part of a week (`work.review.week`) and the
 * window merges the parts by sector (src/shared/work/review.ts `mergeReview`).
 * The types and every rule that turns facts into hours and words live in that
 * file, which holds no zod; the schemas here are held to its types.
 *
 * Every method but `ready` needs a key that may approve, and all but `ready`
 * refuse a thread's own call: a review shows every job at once, which no
 * thread may read. A thread has the read-only tool `week_review`, which
 * answers for its own job alone.
 */

const at = z.number().int().nonnegative()
const sector = z.string().min(1).max(64)
const id = z.string().min(1).max(200)
const words = z.string().max(2_000)
const names = z.array(z.string().max(320)).max(20)

export const SlippedRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), id, dueAt: at }),
  z.object({ kind: z.literal('mail'), threadId: id, since: at }),
  z.object({ kind: z.literal('held'), ref: HeldRefSchema }),
  z.object({ kind: z.literal('meeting'), eventId: id })
]) satisfies z.ZodType<SlippedRef>

const SlippedRowSchema = z.object({
  key: z.string().max(400),
  ref: SlippedRefSchema,
  sector: sector.nullable(),
  workspaceId: id.nullable(),
  title: words,
  at,
  people: names,
  others: z.number().int().nonnegative(),
  open: z.boolean()
})

const ShippedRowSchema = z.object({
  key: z.string().max(400),
  kind: z.enum(['sent', 'finished', 'answered', 'approved']),
  sector: sector.nullable(),
  workspaceId: id.nullable(),
  title: words,
  who: z.string().max(400).nullable(),
  at,
  open: z
    .discriminatedUnion('at', [
      z.object({ at: z.literal('task'), id }),
      z.object({ at: z.literal('mail'), threadId: id }),
      z.object({ at: z.literal('held'), ref: HeldRefSchema })
    ])
    .nullable()
})

const PointSchema = z.tuple([at, z.number().int().nonnegative(), z.enum(POINT_KINDS)])

/** One host's part of one week: what `work.review.week` answers and what the host keeps. */
export const ReviewBodySchema = z.object({
  host: z.string(),
  from: at,
  to: at,
  tz: z.string().max(64),
  madeAt: at,
  by: z.enum(['routine', 'owner']),
  over: z.boolean(),
  jobs: z.array(z.object({ workspaceId: id, sector: sector.nullable(), name: z.string().max(400) })),
  lifeos: z
    .object({
      events: z.array(
        z.object({ id, sector, title: words, startsAt: at, endsAt: at.nullable(), allDay: z.boolean(), declined: z.boolean(), hidden: z.boolean(), people: names, others: z.number().int().nonnegative(), addresses: names })
      ),
      sent: z.array(z.object({ id, threadId: id, subject: words, to: names, addresses: names, at, sector })),
      done: z.array(z.object({ id, title: words, at, sector })),
      answered: z.array(z.object({ threadId: id, subject: words, by: z.string().max(400), at, sector })),
      answeredSince: at.nullable()
    })
    .nullable(),
  points: z.array(PointSchema),
  ran: z.array(z.tuple([z.number().int().nonnegative(), z.number().nonnegative()])),
  slipped: z.object({ at, rows: z.array(SlippedRowSchema) }),
  shipped: z.array(ShippedRowSchema),
  before: z
    .object({
      from: at,
      to: at,
      lifeos: z.object({ events: z.array(z.object({ sector, from: at, to: at })), sent: z.array(z.object({ at, sector })) }).nullable(),
      points: z.array(PointSchema)
    })
    .nullable(),
  left: z.array(z.string().max(400))
}) satisfies z.ZodType<ReviewBody>

/** A week this host kept, for looking back. */
export interface ReviewKept {
  from: number
  to: number
  tz: string
  madeAt: number
  by: 'routine' | 'owner'
}

/** What a press on a slipped row did: `undo` takes it back while the host still holds it; `sessionId` is the thread a nudge started. */
export interface ReviewSettled {
  undo: string | null
  sessionId?: string
}

/** The newest review the Friday routine made that he has not opened; null: none. */
export type ReviewReady = { from: number; madeAt: number } | null

/** The routine that makes the review on this host, for the menu's row that opens it in Routines; null: none (he removed it, or no workspace is linked). */
export type ReviewRoutine = { workspaceId: string; routineId: string; words: string } | null

const week = { from: at, to: at, tz: z.string().min(1).max(64) }

export const ReviewRequestSchemas = [
  /**
   * → ReviewBody: this host's part of the week `[from, to)` of `tz`, which must be a whole week (Monday to Sunday). A
   * week that is not over is made again; one that is over keeps what slipped as it stood at its last make inside the
   * week. A thread's own call is refused.
   */
  request('work.review.week', z.object(week)),
  /** → { weeks: ReviewKept[], tz }: the weeks this host kept, newest first, 120 at most, and the time zone its routine makes weeks in (LifeOS's, else the machine's), so a window asks for the same weeks */
  request('work.review.list', z.object({}).optional()),
  /**
   * → ReviewSettled: his press on a slipped row. `now`: a task is done, a waiting mail gets a nudge drafted (held as
   * every draft). `later`: next week. `drop`: a task is dropped, a wait dismissed, a held item discarded, a meeting
   * needs nothing. It calls the thing's own write and nothing else; it never sends or releases a held item. `sector`
   * names the job for a nudge's thread. A thread's own call is refused.
   */
  request('work.review.settle', z.object({ row: SlippedRefSchema, how: z.enum(SETTLE_HOWS), tz: z.string().min(1).max(64), sector: sector.optional() })),
  /** → { ok: true }: takes a press back, once, while the host still holds its token */
  request('work.review.undo', z.object({ token: z.string().min(1).max(64) })),
  /** → ReviewReady */
  request('work.review.ready', z.object({}).optional()),
  /** → { ok: true }: he opened the week's review; `ready` no longer names it */
  request('work.review.seen', z.object({ from: at })),
  /** → ReviewRoutine */
  request('work.review.routine', z.object({}).optional())
] as const

/** A review was made on this host by its routine, or opened: a screen that shows `ready` asks again. */
export type ReviewPush = { push: 'work.review'; from: number; madeAt: number; seen: boolean }

export const REVIEW_CAPS = {
  'work.review.week': 'approve',
  'work.review.list': 'approve',
  'work.review.settle': 'approve',
  'work.review.undo': 'approve',
  'work.review.ready': 'read',
  'work.review.seen': 'approve',
  'work.review.routine': 'approve'
} satisfies CapsOf<typeof ReviewRequestSchemas>

/** Every method answers for the host it is asked on, and a relayed lane may carry it there as any other. */
export const REVIEW_RELAY = {} satisfies RelayOf<typeof ReviewRequestSchemas>
