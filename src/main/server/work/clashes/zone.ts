import type { WorkCtx } from '../modules'

/** His day, in his time zone: LifeOS's `settings.timezone`, else this host's. */

const DAY = 86_400_000

export const hostZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const parts = new Map<string, Intl.DateTimeFormat>()
const partsOf = (zone: string): Intl.DateTimeFormat => {
  let f = parts.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    parts.set(zone, f)
  }
  return f
}

export function knownZone(zone: string): boolean {
  try {
    partsOf(zone)
    return true
  } catch {
    return false
  }
}

/** How far the zone's wall clock is ahead of UTC at `at`, to the minute. */
function offsetAt(zone: string, at: number): number {
  const p = Object.fromEntries(partsOf(zone).formatToParts(at).map((x) => [x.type, Number(x.value)])) as Record<string, number>
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!) - Math.floor(at / 60_000) * 60_000
}

/** The instant his day began, the day `at` falls in. */
export function startOfDay(at: number, zone: string): number {
  const midnight = Math.floor((at + offsetAt(zone, at)) / DAY) * DAY
  const guess = midnight - offsetAt(zone, at)
  return midnight - offsetAt(zone, guess)
}

/** Whether two instants fall on one day of his. */
export const sameDay = (x: number, y: number, zone: string): boolean => startOfDay(x, zone) === startOfDay(y, zone)

/** His zone from LifeOS's settings; this host's when LifeOS does not say or does not answer. */
export async function zoneOf(ctx: WorkCtx): Promise<string> {
  try {
    const settings = await ctx.lifeos.owner().query<{ timezone?: unknown } | null>('settings:get', {})
    const zone = settings?.timezone
    if (typeof zone === 'string' && zone && knownZone(zone)) return zone
  } catch {
    // LifeOS away: the host's own clock
  }
  return hostZone()
}
