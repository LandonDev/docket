import { z } from 'zod'
import { REVIEW_CAPS, type ReviewKept, type ReviewReady } from '@shared/contract-work-review'
import { handled, NOT_HANDLED, workText } from '@shared/work'
import { isWeek, knownZone, localDay, mergeKept, weekOf, type ReviewBody } from '@shared/work/review'
import { WORK_MODULES, type Caller, type WorkCtx, type WorkModule, type WorkTool } from '../modules'
import { HOST } from './gather/held'
import { hostZone, makeJob, READY_TELL, readyKey, routineOf, seedRoutine } from './friday'
import { makeWeek } from './make'
import { mustBePerson, settle, undo } from './settle'
import { ensureReviewTables, keepWeek, keptWeek, keptWeeks, readyWeek, seeWeek } from './store'
import { reviewText } from './words'

/**
 * The weekly review's server module (docs/agents/work-review.md): one page above the workspaces that shows a week
 * across every job. Each host answers for its own part of a week and keeps it; the window merges the parts by sector
 * (src/shared/work/review.ts). Nothing here passes through a model, and nothing here sends: a press on a slipped row
 * calls that thing's own write (settle.ts).
 */

export const NOT_A_WEEK = 'A review is of one whole week, Monday to Sunday'
export const UNKNOWN_ZONE = 'That time zone is not one this host knows'

/** How often a host with no routine yet looks again for a linked workspace and a time zone. */
const SEED_EVERY_MS = 10 * 60_000

/**
 * The mount's own context, kept from `start`. A tool runs with a copy of it (`{...ctx, scope, sessionId, signal}`),
 * and a pillar the review calls through its `handle` (the Outbox) finds itself by the mount's own object, so the
 * tool makes its week on this one.
 */
let home: WorkCtx | null = null

/** One make at a time per week: two windows asking at once share the read. */
const making = new Map<number, Promise<ReviewBody>>()

/**
 * This host's part of a week, made now and kept (`mergeKept` holds the rules for a week that is over). `routine`: the
 * Friday routine asked, so the kept week is ready and unseen.
 */
export function weekFor(ctx: WorkCtx, ask: { from: number; to: number; tz: string; by: 'routine' | 'owner' }, signal?: AbortSignal, now = Date.now()): Promise<ReviewBody> {
  if (!knownZone(ask.tz)) throw new Error(UNKNOWN_ZONE)
  if (!isWeek(ask.from, ask.to, ask.tz)) throw new Error(NOT_A_WEEK)
  const running = making.get(ask.from)
  // A routine's make is its own: it must stamp the week ready, which a shared read for a window would not.
  if (running && ask.by === 'owner') return running
  const run = (async () => {
    const { body } = await makeWeek(ctx, { ...ask, now, ...(signal ? { signal } : {}) })
    const merged = mergeKept(keptWeek(ctx.db, ask.from), body, now)
    keepWeek(ctx.db, merged, ask.by === 'routine')
    return merged
  })()
  making.set(ask.from, run)
  const done = (): void => {
    if (making.get(ask.from) === run) making.delete(ask.from)
  }
  run.then(done, done)
  return run
}

const WeekInput = z.object({
  week: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Any day of the week to review, as YYYY-MM-DD. Leave it out for this week.')
})

const weekReview: WorkTool = {
  name: 'week_review',
  description:
    "Read the weekly review for this thread's own job: his hours (calendar time is measured, desk time is an estimate and says \"about\"), what shipped and what slipped. One job only; it never shows another job. Read only: it changes nothing.",
  input: WeekInput,
  readOnly: true,
  run: async (args, ctx) => {
    const { week } = args as z.infer<typeof WeekInput>
    if (!ctx.scope.workspaceId) return workText('This thread is in no job, and a review is of a job. Open Review in the rail to see every job.')
    const tz = await hostZone(ctx)
    const now = Date.now()
    // Noon keeps the day asked for inside its own week in every zone.
    const at = week ? Date.parse(`${week}T12:00:00Z`) : now
    if (Number.isNaN(at)) return workText('That is not a day: write it as YYYY-MM-DD.')
    const span = weekOf(at, tz)
    // Nothing is kept: a thread's read leaves no mark on what he sees.
    const mount = home ?? ctx
    const { body } = await makeWeek(mount, { ...span, tz, now, by: 'owner', only: { workspaceId: ctx.scope.workspaceId, sector: ctx.scope.sector }, signal: ctx.signal })
    return workText(reviewText(body, now, await jobMoney(mount, ctx.scope.workspaceId, localDay(span.from, tz), localDay(span.to, tz))))
  }
}

/** The job's own sums of money for a span of local days, from Money's wire: null where Money is not on the host, has no ledger for the job, or does not answer. */
async function jobMoney(ctx: WorkCtx, workspaceId: string, from: string, to: string): Promise<{ in: number; out: number } | null> {
  const money = WORK_MODULES.find((m) => (m.id as string) === 'money')
  if (!money?.handle) return null
  try {
    const answer = await money.handle({ id: 'review', method: 'work.money.sums', params: { from, to, workspaceId } } as never, ctx, HOST)
    const row = answer.handled ? (answer.result as { rows?: { workspaceId: string; in: number; out: number }[] }).rows?.find((r) => r.workspaceId === workspaceId) : undefined
    return row ? { in: row.in, out: row.out } : null
  } catch {
    return null
  }
}

export const review: WorkModule = {
  id: 'review',
  ensure: ensureReviewTables,
  async handle(req, ctx, by, signal) {
    if (!(req.method in REVIEW_CAPS)) return NOT_HANDLED
    switch (req.method) {
      case 'work.review.week':
        mustBePerson(by)
        // The first window to open a review gives the Friday routine a time zone when LifeOS has said none.
        void seedRoutine(ctx, req.params.tz)
        return handled(await weekFor(ctx, { ...req.params, by: 'owner' }, signal))
      case 'work.review.list': {
        mustBePerson(by)
        const weeks: ReviewKept[] = keptWeeks(ctx.db)
        // `tz`: the zone this host's routine makes weeks in, so the window asks for the same weeks.
        return handled({ weeks, tz: await hostZone(ctx) })
      }
      case 'work.review.settle':
        return handled(await settle(ctx, by, req.params, Date.now()))
      case 'work.review.undo':
        return handled(await undo(by, req.params.token, Date.now()))
      case 'work.review.ready': {
        // The one read a key that cannot approve may make: that a review waits, and of which week.
        const ready: ReviewReady = by.kind === 'model' ? null : readyWeek(ctx.db)
        return handled(ready)
      }
      case 'work.review.seen': {
        mustBePerson(by)
        return handled(seen(ctx, by, req.params.from))
      }
      case 'work.review.routine':
        mustBePerson(by)
        return handled(await routineOf(ctx))
      default:
        return NOT_HANDLED
    }
  },
  tools: () => [weekReview],
  tells: [{ kind: READY_TELL, group: 'review', name: 'The weekly review' }],
  jobs: [makeJob((ctx, ask, now) => weekFor(ctx, ask, undefined, now))],
  start(ctx) {
    home = ctx
    // The Friday routine is made once, as soon as there is a linked workspace and a time zone.
    void seedRoutine(ctx)
    const again = setInterval(() => void seedRoutine(ctx), SEED_EVERY_MS)
    again.unref?.()
    return () => {
      clearInterval(again)
      if (home === ctx) home = null
    }
  },
  workspaceCreated(_workspaceId, ctx) {
    if (ctx.enabled()) void seedRoutine(ctx)
  }
}

/** He opened a week's review: it is no longer ready, and every screen that said so hears. */
export function seen(ctx: WorkCtx, _by: Caller, from: number, now = Date.now()): { ok: true } {
  if (seeWeek(ctx.db, from, now)) {
    ctx.push({ push: 'work.review', from, madeAt: now, seen: true })
    // It is no longer news: the digest's row goes, and a notice of it is withdrawn.
    ctx.tell.done(readyKey(from))
  }
  return { ok: true }
}
