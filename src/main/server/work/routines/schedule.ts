import type { Schedule } from '@shared/contract-work-routines'

/**
 * When a schedule fires, in its own time zone: "weekdays at 7:00 AM" is
 * 7:00 on the wall clock of `tz` whatever the host's zone and across a
 * daylight-saving change. A repeat every so many minutes counts from the
 * epoch, so its times do not drift with restarts.
 */

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

const formats = new Map<string, Intl.DateTimeFormat>()
const formatOf = (tz: string): Intl.DateTimeFormat => {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(tz, f)
  }
  return f
}

/** Whether `tz` is a zone this runtime knows. */
export function knownZone(tz: string): boolean {
  try {
    formatOf(tz)
    return true
  } catch {
    return false
  }
}

/** The wall clock of `tz` at `at`, as if it were UTC. */
function wall(tz: string, at: number): number {
  const p = Object.fromEntries(formatOf(tz).formatToParts(at).map((x) => [x.type, Number(x.value)])) as Record<string, number>
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!)
}

/** The instant the wall clock of `tz` reads `local` (a wall time written as UTC). A time a clock change skips lands an hour later, just past the gap. */
function instant(tz: string, local: number): number {
  const a = local - (wall(tz, local) - local)
  const b = local - (wall(tz, a) - a)
  for (const at of [b, a]) if (wall(tz, at) === local) return at
  return Math.max(a, b)
}

/** The first time the schedule fires strictly after `after`. */
export function nextAt(s: Schedule, tz: string, after: number): number {
  if (s.every === 'minutes') {
    const step = s.interval * MINUTE
    return (Math.floor(after / step) + 1) * step
  }
  const today = Math.floor(wall(tz, after) / DAY) * DAY
  for (let i = 0; i <= 8; i++) {
    const day = today + i * DAY
    if (!s.days.includes(new Date(day).getUTCDay())) continue
    const at = instant(tz, day + (s.hour * 60 + s.minute) * MINUTE)
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
