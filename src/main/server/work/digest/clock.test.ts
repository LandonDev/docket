import { describe, expect, it } from 'vitest'
import { dayOf, lastDigest, nextDigest, zoneOr } from './clock'

/** The digest's time in a zone the host is not in, across a clock change. */

const NY = 'America/New_York'
const at = (iso: string): number => Date.parse(iso)

describe('the next digest', () => {
  it('is 8:00 on the wall clock of the zone, whatever zone the host runs in', () => {
    // 03:00 UTC on Nov 23 is 10 PM on Nov 22 in New York: the next 8:00 there is Nov 23 at 13:00 UTC.
    expect(nextDigest('08:00', NY, at('2026-11-23T03:00:00Z'))).toBe(at('2026-11-23T13:00:00Z'))
    expect(nextDigest('08:00', 'UTC', at('2026-11-23T03:00:00Z'))).toBe(at('2026-11-23T08:00:00Z'))
    expect(nextDigest('08:00', 'America/Chicago', at('2026-11-23T03:00:00Z'))).toBe(at('2026-11-23T14:00:00Z'))
  })
  it('is strictly after: at the time itself, tomorrow', () => {
    expect(nextDigest('08:00', NY, at('2026-11-23T13:00:00Z'))).toBe(at('2026-11-24T13:00:00Z'))
  })
  it('keeps the wall time across a clock change', () => {
    // Clocks go forward in New York on Mar 14 2027: 8:00 EST is 13:00 UTC, 8:00 EDT is 12:00 UTC.
    expect(nextDigest('08:00', NY, at('2027-03-13T14:00:00Z'))).toBe(at('2027-03-14T12:00:00Z'))
    // Back on Nov 7 2027.
    expect(nextDigest('08:00', NY, at('2027-11-06T13:00:00Z'))).toBe(at('2027-11-07T13:00:00Z'))
  })
})

describe('the last digest', () => {
  it('is the latest time at or before now', () => {
    expect(lastDigest('08:00', NY, at('2026-11-23T13:00:00Z'))).toBe(at('2026-11-23T13:00:00Z'))
    expect(lastDigest('08:00', NY, at('2026-11-23T12:59:59Z'))).toBe(at('2026-11-22T13:00:00Z'))
    expect(lastDigest('08:00', NY, at('2026-11-25T02:00:00Z'))).toBe(at('2026-11-24T13:00:00Z'))
    expect(lastDigest('08:00', NY, at('2027-03-14T18:00:00Z'))).toBe(at('2027-03-14T12:00:00Z'))
  })
})

describe('the day', () => {
  it('is the date on the wall clock of the zone', () => {
    expect(dayOf(NY, at('2026-11-23T03:00:00Z'))).toBe('2026-11-22')
    expect(dayOf('UTC', at('2026-11-23T03:00:00Z'))).toBe('2026-11-23')
    expect(dayOf(NY, at('2026-11-23T13:00:00Z'))).toBe('2026-11-23')
  })
  it("falls back to the host's own zone for one the runtime does not know", () => {
    expect(zoneOr('America/New_York')).toBe('America/New_York')
    expect(zoneOr('Mars/Olympus')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(zoneOr(null)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})
