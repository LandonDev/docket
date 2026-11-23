import { formatMoney } from '@shared/work/money'
import { dayWords, factsOf, madeWords, mergeReview, nothingWords, shippedWords, slippedDetail, totalWords, weekWords, type ReviewBody } from '@shared/work/review'

/**
 * A week's review for one job, as the `week_review` tool tells it to a thread: the same numbers by the same rules as
 * the page (`mergeReview`, `hoursOf`), in plain lines, each said as what it is.
 */

const ROWS = 40
const UNREAD = 'Not known: some of it could not be read.'

/** `money`: the job's own sums for the week from Money (cents), when its ledger has any. */
export function reviewText(body: ReviewBody, now: number, money: { in: number; out: number } | null = null): string {
  const r = mergeReview([{ environmentId: body.host, body }], now)
  const job = r?.jobs[0]
  if (!r || !job) return 'There is nothing to review: this thread is in no job.'
  const week = { from: r.from, to: r.to }
  const hours = r.hours.find((h) => h.job === job.key)
  const made = madeWords(r, r.tz, now)
  const lines: string[] = [`${weekWords(week, r.tz)}, ${job.name}. ${made}${made.endsWith('.') ? '' : '.'}`, 'This is one job on this host: what LifeOS holds for its sector and what this host saw. Other jobs are not shown to a thread.', '']

  lines.push('Hours')
  const total = hours ? totalWords(hours) : null
  if (!hours || !total) lines.push(`- ${nothingWords(r.known)}.`)
  else {
    const f = factsOf(hours)
    lines.push(`- In all: ${total}`)
    if (r.known.calendar) lines.push(`- On the calendar (measured): ${f.calendar}${f.calendarDetail ? `, ${f.calendarDetail}` : ''}`)
    if (f.desk) lines.push(`- At the desk (an estimate, never a measure): ${f.desk}${f.deskDetail ? `, from ${f.deskDetail}` : ''}`)
  }
  const ran = hours ? factsOf(hours).ran : null
  if (ran) lines.push(`- Threads ran (measured; not his hours): ${ran}`)
  if (money && (money.in > 0 || money.out > 0)) lines.push(`- Money (the job's ledger, as Money sums it): ${formatMoney(money.in)} in, ${formatMoney(money.out)} out`)
  const compare = r.compare.find((c) => c.job === job.key)
  if (compare) lines.push(`- The week before: ${compare.words}`)

  lines.push('', `Shipped (${r.shipped.length})`)
  // "Nothing" only where every source answered; what is missing is named under "Not counted".
  if (!r.shipped.length) lines.push(r.known.shipped ? '- Nothing went out.' : `- ${UNREAD}`)
  for (const s of r.shipped.slice(0, ROWS)) {
    const w = shippedWords(s)
    lines.push(`- ${w.lead}${w.title}${w.tail}, ${dayWords(s.at, week, r.tz)}`)
  }
  if (r.shipped.length > ROWS) lines.push(`- and ${r.shipped.length - ROWS} more`)

  const open = r.slipped.filter((s) => s.open)
  lines.push('', `Slipped (${open.length})`)
  if (!open.length) lines.push(r.known.slipped ? '- Nothing slipped.' : `- ${UNREAD}`)
  for (const s of open.slice(0, ROWS)) lines.push(`- ${s.title}, ${slippedDetail(s, week, r.tz)}`)
  if (open.length > ROWS) lines.push(`- and ${open.length - ROWS} more`)

  if (r.left.length) lines.push('', `Not counted: ${r.left.join(' ')}`)
  return lines.join('\n')
}
