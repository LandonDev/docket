import type { WorkCtx } from './modules'

export { dateIn, dayOf, timeIn, zoneName } from '../../../shared/work/clock'

export const hostZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const zones = new Set<string>()

export function knownZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false
  if (zones.has(zone)) return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    zones.add(zone)
    return true
  } catch {
    return false
  }
}

/** The owner's last settings and desktop, held by this Work mount. */
export function workClock(host = hostZone()) {
  let lifeos: string | null = null
  let desktop: string | null = null
  const listeners = new Set<(zone: string) => void>()
  const clock = {
    lifeos: () => lifeos,
    desktop: () => desktop,
    host,
    set(from: 'lifeos' | 'desktop', value: unknown) {
      const before = hisZone({ clock })
      const zone = knownZone(value) ? value : null
      if (from === 'lifeos') lifeos = zone
      else desktop = zone
      const next = hisZone({ clock })
      if (next !== before) for (const fn of listeners) fn(next)
    },
    onChange(fn: (zone: string) => void): () => void {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    }
  }
  return clock
}

/** The owner's zone from cache alone, then the last desktop's, then the host's. */
export function hisZone({ clock }: Pick<WorkCtx, 'clock'>): string {
  return clock?.lifeos() ?? clock?.desktop() ?? clock?.host ?? hostZone()
}

const formats = new Map<string, Intl.DateTimeFormat>()
const formatOf = (tz: string): Intl.DateTimeFormat => {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(tz, f)
  }
  return f
}

/** The wall clock of `tz` at `at`, as if it were UTC. */
export function wallIn(tz: string, at: number): number {
  const p = Object.fromEntries(formatOf(tz).formatToParts(at).map((x) => [x.type, Number(x.value)])) as Record<string, number>
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!, new Date(at).getUTCMilliseconds())
}

/** The instant the wall clock of `tz` reads `local` (a wall time written as UTC). A time a clock change skips lands an hour later, just past the gap. */
export function instantIn(tz: string, local: number): number {
  const a = local - (wallIn(tz, local) - local)
  const b = local - (wallIn(tz, a) - a)
  for (const at of [b, a]) if (wallIn(tz, at) === local) return at
  return Math.max(a, b)
}
