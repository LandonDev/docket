import type { Schedule } from '@shared/contract-work-routines'
import { instantIn, wallIn } from '../clock'

export { knownZone } from '../clock'

/**
 * When a schedule fires, in its own time zone: "weekdays at 7:00 AM" is
 * 7:00 on the wall clock of `tz` whatever the host's zone and across a
 * daylight-saving change. A repeat every so many minutes counts from the
 * epoch, so its times do not drift with restarts.
 */

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** The first time the schedule fires strictly after `after`. */
export function nextAt(s: Schedule, tz: string, after: number): number {
  if (s.every === 'minutes') {
    const step = s.interval * MINUTE
    return (Math.floor(after / step) + 1) * step
  }
  const today = Math.floor(wallIn(tz, after) / DAY) * DAY
  for (let i = 0; i <= 8; i++) {
    const day = today + i * DAY
    if (!s.days.includes(new Date(day).getUTCDay())) continue
    const at = instantIn(tz, day + (s.hour * 60 + s.minute) * MINUTE)
    if (at > after) return at
  }
  throw new Error('a weekly schedule with no day')
}

/** How many times the schedule was due from `from` (itself due) up to `until`, at most `cap`. */
export function dueCount(s: Schedule, tz: string, from: number, until: number, cap = 10_000): number {
  let n = 0
  for (let at = from; at <= until && n < cap; at = nextAt(s, tz, at)) n++
  return n
}
