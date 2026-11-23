import type { Schedule } from '@shared/contract-work-routines'
import { knownZone, nextAt } from '../routines/schedule'

/**
 * When the digest is: one wall time a day ("08:00") in a zone, the last
 * desktop's. The box may run in UTC, so the host's own zone is only the
 * answer until a desktop has said where it is.
 */

const HOUR = 3_600_000
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

const scheduleOf = (at: string): Schedule => {
  const [hour, minute] = at.split(':').map(Number) as [number, number]
  return { every: 'week', days: EVERY_DAY, hour, minute }
}

export const hostZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** `zone` when this runtime knows it, else the host's own. */
export const zoneOr = (zone: string | null | undefined): string => (zone && knownZone(zone) ? zone : hostZone())

export { knownZone }

/** The first digest time strictly after `after`. */
export const nextDigest = (at: string, zone: string, after: number): number => nextAt(scheduleOf(at), zone, after)

/** The latest digest time at or before `now`. */
export function lastDigest(at: string, zone: string, now: number): number {
  const s = scheduleOf(at)
  let last = nextAt(s, zone, now - 49 * HOUR)
  for (let next = nextAt(s, zone, last); next <= now; next = nextAt(s, zone, next)) last = next
  return last
}

const days = new Map<string, Intl.DateTimeFormat>()

/** The date on the wall clock of `zone` at `at`: '2026-11-23'. */
export function dayOf(zone: string, at: number): string {
  let f = days.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    days.set(zone, f)
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>
  return `${p.year}-${p.month}-${p.day}`
}
