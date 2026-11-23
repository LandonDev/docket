import { countedSpan, LEFT, stepWeek, type HostPoint, type ReviewBefore, type ReviewBody, type ReviewEvent, type ReviewLifeos, type ReviewSent, type SlippedRow } from '@shared/work/review'
import type { SectorKey } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { WorkCtx } from '../modules'
import { meetingsSlipped, preppedAfter } from './followup'
import { eventById, eventsBetween, ownAddresses } from './gather/calendar'
import { jobsOf, type Asked } from './gather/common'
import { fileFacts } from './gather/files'
import { heldFacts } from './gather/held'
import { answeredBetween, sentBetween, waitingPast } from './gather/mail'
import { doneBetween, pastDue } from './gather/tasks'
import { scanThreads, type ThreadFacts } from './gather/threads'
import { carriedMeetings, hiddenKeys } from './store'

/**
 * Makes this host's part of one week (docs/agents/work-review.md "The gather"): every source is asked on its own, and
 * one that fails is left out and named in `left`, so the page stands on what did answer. Nothing here is a model's:
 * each number is a row some store holds.
 */

export type MakeAsk = {
  from: number
  to: number
  tz: string
  now: number
  by: 'routine' | 'owner'
  /** a thread's tool: its own job alone, by workspace and sector */
  only?: { workspaceId: string | null; sector: SectorKey | null }
  signal?: AbortSignal
}

export type Made = { body: ReviewBody; cost: ThreadFacts['cost'] | null }

/** One source's answer, or null with its line added to `left`. */
async function ask<T>(ctx: WorkCtx, left: string[], line: string, what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run()
  } catch (err) {
    ctx.log(`review: ${what} did not answer: ${errorText(err)}`)
    if (!left.includes(line)) left.push(line)
    return null
  }
}

export async function makeWeek(ctx: WorkCtx, a: MakeAsk): Promise<Made> {
  const cut = Math.min(a.now, a.to)
  const prev = stepWeek(a, -1, a.tz)
  const asked: Asked = {
    from: a.from,
    to: a.to,
    tz: a.tz,
    now: a.now,
    cut,
    before: { from: prev.from, to: Math.min(prev.to, prev.from + Math.max(0, cut - a.from)) },
    ...(a.only ? { only: a.only.sector } : {}),
    ...(a.signal ? { signal: a.signal } : {})
  }
  const jobs = jobsOf(ctx.db, a.only)
  const hidden = hiddenKeys(ctx.db, a.now)
  const left: string[] = []

  let lifeos: ReviewLifeos | null = null
  let beforeLifeos: ReviewBefore['lifeos'] = null
  const slipped: SlippedRow[] = []
  if (!ctx.lifeos.connected()) left.push(LEFT.lifeos)
  else {
    const owner = ctx.lifeos.owner()
    const lifeosLeft: string[] = []
    const self = (await ask(ctx, [], '', 'his mail addresses', () => ownAddresses(owner))) ?? new Set<string>()
    const [events, eventsBefore, sent, sentAfter, sentBefore, done, answered, due, waits] = await Promise.all([
      ask(ctx, lifeosLeft, LEFT.calendar, 'the calendar', () => eventsBetween(owner, a.from, a.to, self, asked)),
      ask(ctx, [], '', 'last week’s calendar', () => eventsBetween(owner, asked.before.from, asked.before.to, self, asked)),
      ask(ctx, lifeosLeft, LEFT.mail, 'sent mail', () => sentBetween(owner, a.from, a.to, asked)),
      // A meeting's follow-up may have gone after the week ended.
      ask(ctx, [], '', 'mail sent since', () => sentBetween(owner, a.to, a.now, asked)),
      ask(ctx, [], '', 'last week’s sent mail', () => sentBetween(owner, asked.before.from, asked.before.to, asked)),
      ask(ctx, lifeosLeft, LEFT.tasks, 'finished tasks', () => doneBetween(owner, a.from, a.to, asked)),
      ask(ctx, lifeosLeft, LEFT.mail, 'answered mail', () => answeredBetween(owner, a.from, a.to, asked)),
      ask(ctx, lifeosLeft, LEFT.tasks, 'tasks past due', () => pastDue(owner, cut, asked)),
      ask(ctx, lifeosLeft, LEFT.mail, 'waiting mail', () => waitingPast(owner, cut, asked))
    ])
    if (!events && !sent && !done && !answered && !due && !waits) left.push(LEFT.lifeos)
    else {
      left.push(...lifeosLeft)
      lifeos = { events: events ?? [], sent: sent ?? [], done: done ?? [], answered: answered?.rows ?? [], answeredSince: answered?.answeredSince ?? null }
      slipped.push(...(due ?? []), ...(waits ?? []))
      // Without the sent mail nobody can say a meeting was not followed up, so none is listed.
      if (events && sent) {
        // A meeting he put off to "next week" ended in a week that is over: the week that holds now lists it again,
        // judged by the mail sent since it ended.
        const carried = a.now >= a.from && a.now < a.to ? carriedMeetings(ctx.db, a.now).filter((id) => !events.some((e) => e.id === id)) : []
        const back = (await Promise.all(carried.map((id) => eventById(owner, id, self, asked)))).filter((e): e is ReviewEvent => e !== null)
        const earliest = Math.min(a.from, ...back.map((e) => e.endsAt ?? a.from))
        const sentEarlier = back.length ? ((await ask(ctx, [], '', 'mail sent since a put-off meeting', () => sentBetween(owner, earliest, a.from, asked))) ?? []) : []
        const prepped = await preppedAfter(ctx, earliest, cut)
        slipped.push(...meetingsSlipped([...events, ...back], [...sentEarlier, ...sent, ...(sentAfter ?? [])], { from: a.from, cut }, hidden, prepped, new Set(back.map((e) => e.id))))
      }
      if (eventsBefore || sentBefore) beforeLifeos = { events: spansOf(eventsBefore ?? [], asked.before), sent: (sentBefore ?? []).map((m: ReviewSent) => ({ at: m.at, sector: m.sector })) }
    }
  }

  const held = await ask(ctx, left, LEFT.held, 'the Outbox', () => heldFacts(ctx, asked, jobs, hidden))
  const threads = await ask(ctx, left, LEFT.threads, 'the threads', () => scanThreads(ctx.db, { from: a.from, to: cut }, asked.before.to > asked.before.from ? asked.before : null, jobs, a.signal))
  const files = await ask(ctx, left, LEFT.files, 'document history', () => fileFacts(ctx, asked, jobs))
  slipped.push(...(held?.slipped ?? []))

  const points: HostPoint[] = [...(threads?.points ?? []), ...(held?.points ?? []), ...(files?.points ?? [])].sort((x, y) => x[0] - y[0])
  const before: HostPoint[] = [...(threads?.before ?? []), ...(held?.before ?? []), ...(files?.before ?? [])].sort((x, y) => x[0] - y[0])
  const body: ReviewBody = {
    host: ctx.host,
    from: a.from,
    to: a.to,
    tz: a.tz,
    madeAt: a.now,
    by: a.by,
    over: a.now >= a.to,
    jobs: jobs.list,
    lifeos,
    points,
    ran: threads?.ran ?? [],
    slipped: { at: a.now, rows: slipped },
    shipped: held?.shipped ?? [],
    before: asked.before.to > asked.before.from ? { from: asked.before.from, to: asked.before.to, lifeos: beforeLifeos, points: before } : null,
    left
  }
  return { body, cost: threads?.cost ?? null }
}

/** Last week's counted events as bare spans, cut to the span compared. */
function spansOf(events: readonly ReviewEvent[], span: { from: number; to: number }): { sector: SectorKey; from: number; to: number }[] {
  return events.flatMap((e) => {
    const s = countedSpan(e)
    if (!s) return []
    const from = Math.max(s.from, span.from)
    const to = Math.min(s.to, span.to)
    return to > from ? [{ sector: e.sector, from, to }] : []
  })
}
