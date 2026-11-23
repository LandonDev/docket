import { countedSpan, type ReviewEvent, type ReviewSent, type SlippedRow } from '@shared/work/review'

/**
 * Whether a meeting was followed up. A rule of thumb, kept in this one function so a better answer can replace it
 * (Prep's, once it is on master: docs/agents/work-review.md "Borders"): a meeting he was at with someone else is
 * followed up once he has sent a mail to any of them after it ended. The page says what is true of the rule, "nothing
 * sent after", and never that he forgot.
 */
export function followedUp(event: Pick<ReviewEvent, 'endsAt' | 'addresses'>, sentSince: readonly Pick<ReviewSent, 'at' | 'addresses'>[]): boolean {
  if (event.endsAt === null) return true
  const there = new Set(event.addresses)
  return sentSince.some((m) => m.at >= event.endsAt! && m.addresses.some((a) => there.has(a)))
}

/**
 * The meetings of the week that slipped: ended by `cut`, counted on the calendar (so not declined, hidden or all
 * day), with someone else on it, not followed up, and not marked by him.
 */
export function meetingsSlipped(events: readonly ReviewEvent[], sentSince: readonly Pick<ReviewSent, 'at' | 'addresses'>[], span: { from: number; cut: number }, hidden: ReadonlySet<string>): SlippedRow[] {
  const out: SlippedRow[] = []
  for (const e of events) {
    const key = `meeting:${e.id}`
    if (!countedSpan(e) || e.others === 0 || e.endsAt === null || e.endsAt > span.cut || e.endsAt <= span.from || hidden.has(key)) continue
    if (followedUp(e, sentSince)) continue
    out.push({ key, ref: { kind: 'meeting', eventId: e.id }, sector: e.sector, workspaceId: null, title: e.title, at: e.startsAt, people: e.people, others: e.others, open: true })
  }
  return out
}
