import { countedSpan, type ReviewEvent, type ReviewSent, type SlippedRow } from '@shared/work/review'
import { WORK_MODULES, type WorkCtx } from '../modules'
import { HOST } from './gather/held'

/**
 * Whether a meeting was followed up. A rule of thumb, kept in this one function: a meeting he was at with someone
 * else is followed up once he has sent a mail to any of them after it ended, or once its page in Prep holds notes
 * or an outcome (`prepped`: Prep's state `after`). The page says what is true of the rule, "nothing sent after", and
 * never that he forgot.
 */
export function followedUp(event: Pick<ReviewEvent, 'id' | 'endsAt' | 'addresses'>, sentSince: readonly Pick<ReviewSent, 'at' | 'addresses'>[], prepped: ReadonlySet<string> = new Set()): boolean {
  if (event.endsAt === null || prepped.has(event.id)) return true
  const there = new Set(event.addresses)
  return sentSince.some((m) => m.at >= event.endsAt! && m.addresses.some((a) => there.has(a)))
}

/**
 * The meetings Prep says he has dealt with: the events of the span whose page on this host holds notes or an
 * outcome (`work.prep.upcoming`, state `after`), asked through Prep's own `handle`. A host with no Prep, or one
 * that does not answer, has none: the mail rule stands alone.
 */
export async function preppedAfter(ctx: WorkCtx, from: number, to: number): Promise<Set<string>> {
  const prep = WORK_MODULES.find((m) => (m.id as string) === 'prep')
  if (!prep?.handle || to <= from) return new Set()
  try {
    const answer = await prep.handle({ id: 'review', method: 'work.prep.upcoming', params: { from, to } } as never, ctx, HOST)
    if (!answer.handled) return new Set()
    const meetings = (answer.result as { meetings?: { eventId: string; state: string }[] }).meetings ?? []
    return new Set(meetings.filter((m) => m.state === 'after').map((m) => m.eventId))
  } catch {
    return new Set()
  }
}

/**
 * The meetings of the week that slipped: ended by `cut`, counted on the calendar (so not declined, hidden or all
 * day), with someone else on it, not followed up, and not marked by him.
 */
export function meetingsSlipped(
  events: readonly ReviewEvent[],
  sentSince: readonly Pick<ReviewSent, 'at' | 'addresses'>[],
  span: { from: number; cut: number },
  hidden: ReadonlySet<string>,
  prepped: ReadonlySet<string> = new Set(),
  /** meetings of an earlier week he put off to this one (`carriedMeetings`): listed whenever they ended */
  carried: ReadonlySet<string> = new Set()
): SlippedRow[] {
  const out: SlippedRow[] = []
  const seen = new Set<string>()
  for (const e of events) {
    const key = `meeting:${e.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const inSpan = e.endsAt !== null && e.endsAt > span.from
    if (!countedSpan(e) || e.others === 0 || e.endsAt === null || e.endsAt > span.cut || (!inSpan && !carried.has(e.id)) || hidden.has(key)) continue
    if (followedUp(e, sentSince, prepped)) continue
    out.push({ key, ref: { kind: 'meeting', eventId: e.id }, sector: e.sector, workspaceId: null, title: e.title, at: e.startsAt, people: e.people, others: e.others, open: true })
  }
  return out
}
