import type { ReviewRoutine } from '@shared/contract-work-review'
import type { RoutineRow } from '@shared/contract-work-routines'
import { errorText } from '@shared/work/ids'
import { knownZone, weekOf, weekWords, type ReviewBody } from '@shared/work/review'
import { WORK_MODULES, type RoutineJob, type WorkCtx } from '../modules'
import { HOST } from './gather/held'
import { readyWeek, setSeeded, setupOf } from './store'

/**
 * Friday (docs/agents/work-review.md "Friday"): the review is made by a routine that runs a host job, with no model
 * and no thread. The review seeds that routine once on a host that holds a linked Work workspace, in the Life
 * workspace or else the first, Fridays at 4:00 PM in LifeOS's time zone. It is an ordinary routine from then on: he
 * moves it, pauses it or removes it in Routines, and one he removed is never made again.
 */

export const MAKE_JOB = 'review.make'
export const ROUTINE_NAME = 'Weekly review'
/** Fridays at 4:00 PM. */
export const ROUTINE_RRULE = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0'
const LIFE = 'life'

/** The one kind of news the review tells: its module lists it (`tells`), in the digest's group `review`. */
export const READY_TELL = 'review.ready'
/** A week's tell and Today's row share this key, so one thing is one row everywhere. */
export const readyKey = (from: number): string => `review:${from}`

async function routinesCall<T>(ctx: WorkCtx, method: string, params: unknown): Promise<T> {
  const routines = WORK_MODULES.find((m) => m.id === 'routines')
  if (!routines?.handle) throw new Error('Routines are not running on this host')
  const answer = await routines.handle({ id: 'review', method, params } as never, ctx, HOST)
  if (!answer.handled) throw new Error('Routines did not take the call')
  return answer.result as T
}

/** LifeOS's own time zone; null while it has not said one this host knows. */
export async function lifeosZone(ctx: WorkCtx): Promise<string | null> {
  if (!ctx.lifeos.connected()) return null
  try {
    const tz = (await ctx.lifeos.owner().query<{ timezone?: string } | null>('settings:get', {}))?.timezone
    return tz && knownZone(tz) ? tz : null
  } catch {
    return null
  }
}

/** This host's own time zone: LifeOS's when it says one, else the machine's. */
export const hostZone = async (ctx: WorkCtx): Promise<string> => (await lifeosZone(ctx)) ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')

let seeding: Promise<void> | null = null

/**
 * Makes the Friday routine, once. It waits for a linked Work workspace and for a time zone: LifeOS's, or `tz`, the
 * zone of the first window that opened a review. Nothing is made twice: the row that says it was made is written in
 * the same breath as the routine's id comes back, and two callers share one make.
 */
export function seedRoutine(ctx: WorkCtx, tz?: string, now = Date.now()): Promise<void> {
  if (setupOf(ctx.db).seededAt !== null) return Promise.resolve()
  seeding ??= (async () => {
    try {
      const rows = ctx.db.prepare(`SELECT id, sector FROM workspaces WHERE kind = 'work' AND sector IS NOT NULL AND sector != '' ORDER BY created_at, id`).all() as { id: string; sector: string }[]
      const home = rows.find((r) => r.sector === LIFE) ?? rows[0]
      if (!home) return
      const zone = (await lifeosZone(ctx)) ?? (tz && knownZone(tz) ? tz : null)
      if (!zone || setupOf(ctx.db).seededAt !== null) return
      const made = await routinesCall<RoutineRow>(ctx, 'work.routines.save', { workspaceId: home.id, name: ROUTINE_NAME, prompt: '', job: MAKE_JOB, trigger: { on: 'schedule', rrule: ROUTINE_RRULE, tz: zone }, ends: { kind: 'never' } })
      setSeeded(ctx.db, now, made.id, home.id)
    } catch (err) {
      ctx.log(`review: the weekly routine was not made: ${errorText(err)}`)
    } finally {
      seeding = null
    }
  })()
  return seeding
}

/** The routine as the page's menu names it; null once he removed it, or before one was made. */
export async function routineOf(ctx: WorkCtx): Promise<ReviewRoutine> {
  const setup = setupOf(ctx.db)
  if (!setup.routineId || !setup.workspaceId) return null
  try {
    const { routines } = await routinesCall<{ routines: RoutineRow[] }>(ctx, 'work.routines.list', { workspaceId: setup.workspaceId })
    const row = routines.find((r) => r.id === setup.routineId)
    return row ? { workspaceId: row.workspaceId, routineId: row.id, words: row.enabled ? row.words : `${row.words}, paused` } : null
  } catch {
    return null
  }
}

const slippedWords = (body: ReviewBody): string => {
  const n = body.slipped.rows.filter((r) => r.open).length
  return n === 0 ? 'Nothing slipped' : n === 1 ? '1 thing slipped' : `${n} things slipped`
}

/**
 * The job the routine runs: this week's review, made and kept, then told once through the digest (no `by`: nothing
 * is too late, so it waits for the day's one notice), with a press that opens the page at that week. `make` is the module's own
 * `weekFor`, handed in so this file and the module do not import each other.
 */
export function makeJob(make: (ctx: WorkCtx, ask: { from: number; to: number; tz: string; by: 'routine' }, now: number) => Promise<ReviewBody>): RoutineJob {
  return {
    id: MAKE_JOB,
    name: 'Makes the week’s review: your hours, what shipped and what slipped, with no model',
    async run(ctx, { firedAt }) {
      const tz = await hostZone(ctx)
      const week = weekOf(firedAt, tz)
      const told = readyWeek(ctx.db)?.from === week.from
      const body = await make(ctx, { ...week, tz, by: 'routine' }, firedAt)
      ctx.push({ push: 'work.review', from: week.from, madeAt: body.madeAt, seen: false })
      // Told once a week: a second run of the same week (Run now) makes it again and tells nobody.
      if (!told) ctx.tell({ kind: READY_TELL, workspaceId: null, title: 'Your week is ready to review', detail: weekWords(week, tz), key: readyKey(week.from), open: { place: 'review', at: String(week.from) } })
      return { words: `${weekWords(week, tz)}: ${slippedWords(body).toLowerCase()}`, open: { place: 'review', at: week.from } }
    }
  }
}
