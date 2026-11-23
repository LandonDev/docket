import { describe, expect, it } from 'vitest'
import { clashLine, clashTime, clashTitle, driveLine, leaveLine, milesOf, tellWords, timeNear, type Clash, type ClashSide } from './clashes'

/** The words a clash is shown in, on made-up events, read in one zone (EST in November). */

const ZONE = { timeZone: 'America/Indiana/Indianapolis' }
const at = (day: number, hour: number, minute = 0): number => Date.UTC(2026, 10, day, hour + 5, minute)

const side = (over: Partial<ClashSide>): ClashSide => ({ eventId: 'e', sector: 'life', title: 'Event', startsAt: 0, endsAt: 0, can: [], ...over })
const staff = side({ eventId: 'e_staff', sector: 'purdue', title: 'Staff meeting', startsAt: at(26, 16), endsAt: at(26, 18, 30) })
const game = side({ eventId: 'e_game', sector: 'ref', title: 'Varsity Basketball', startsAt: at(26, 18), endsAt: at(26, 20), place: 'Maple Ridge High School, Cedar Falls, IN' })
const overlap: Clash = { id: 'e_staff-e_game', kind: 'overlap', a: staff, b: game }
const drive: Clash = { id: 'e_staff-e_game', kind: 'drive', a: { ...staff, endsAt: at(26, 17) }, b: game, minutes: 38, miles: 24, measured: true, shortBy: 15 }

describe('milesOf', () => {
  it('gives one decimal under ten miles and whole miles from ten up', () => {
    expect(milesOf(1609.344)).toBe(1)
    expect(milesOf(5000)).toBe(3.1)
    expect(milesOf(0)).toBe(0)
    expect(milesOf(16093.44)).toBe(10)
    expect(milesOf(38_624)).toBe(24)
  })
})

describe('clashLine', () => {
  it("says an overlap with the other event's title, job and start", () => {
    expect(clashLine(overlap, 'e_staff', ZONE)).toBe('Overlaps Varsity Basketball (Ref), 6:00 PM')
    expect(clashLine(overlap, 'e_game', ZONE)).toBe('Overlaps Staff meeting (Purdue), 4:00 PM')
  })
  it('says a drive clash as after on the later event and before on the earlier', () => {
    expect(clashLine(drive, 'e_game', ZONE)).toBe('15 min short after Staff meeting (Purdue)')
    expect(clashLine(drive, 'e_staff', ZONE)).toBe('15 min short before Varsity Basketball (Ref)')
  })
  it('says about for a drive worked out without the map', () => {
    expect(clashLine({ ...drive, measured: false }, 'e_game', ZONE)).toBe('About 15 min short after Staff meeting (Purdue)')
  })
  it('rounds a shortfall worked out without the map to five minutes, never under five, as its drive line is rounded', () => {
    expect(clashLine({ ...drive, measured: false, shortBy: 12 }, 'e_game', ZONE)).toBe('About 10 min short after Staff meeting (Purdue)')
    expect(clashTitle({ ...drive, measured: false, shortBy: 13 })).toBe('About 15 minutes short')
    expect(clashTitle({ ...drive, measured: false, shortBy: 1 })).toBe('About 5 minutes short')
    // A measured shortfall is said to the minute.
    expect(clashTitle({ ...drive, shortBy: 12 })).toBe('12 minutes short')
  })
  it('leaves the job out when the other event is the same job, since the page is that job', () => {
    const jv = side({ eventId: 'e_jv', sector: 'ref', title: 'JV Basketball', startsAt: at(26, 17), endsAt: at(26, 19) })
    expect(clashLine({ id: 'e_jv-e_game', kind: 'overlap', a: jv, b: game }, 'e_game', ZONE)).toBe('Overlaps JV Basketball, 5:00 PM')
  })
  it("names the other event's weekday when it starts on another day than this one", () => {
    const late = side({ eventId: 'e_late', sector: 'ref', title: 'Late game', startsAt: at(25, 23), endsAt: at(26, 1, 30) })
    const early = side({ eventId: 'e_early', sector: 'life', title: 'Airport run', startsAt: at(26, 1), endsAt: at(26, 2) })
    const clash: Clash = { id: 'e_late-e_early', kind: 'overlap', a: late, b: early }
    expect(clashLine(clash, 'e_early', ZONE)).toBe('Overlaps Late game (Ref), Wed 11:00 PM')
    expect(clashLine(clash, 'e_late', ZONE)).toBe('Overlaps Airport run (Life), Thu 1:00 AM')
  })
  it('names the weekday against the day the row sits under, when a list shows it under another day than its start', () => {
    // Both start Wednesday night and run past midnight: under Thursday, a bare "11:30 PM" would read as Thursday's.
    const shift = side({ eventId: 'e_shift', sector: 'life', title: 'Shift', startsAt: at(25, 23, 30), endsAt: at(26, 3) })
    const game2 = side({ eventId: 'e_night', sector: 'ref', title: 'Night game', startsAt: at(25, 22), endsAt: at(26, 0, 30) })
    const clash: Clash = { id: 'e_night-e_shift', kind: 'overlap', a: game2, b: shift }
    expect(clashLine(clash, 'e_night', ZONE)).toBe('Overlaps Shift (Life), 11:30 PM')
    expect(clashLine(clash, 'e_night', { ...ZONE, on: at(26, 0) })).toBe('Overlaps Shift (Life), Wed 11:30 PM')
  })
  it("names the other event's date, not its weekday, a week or more off: the weekday would read as the nearer one", () => {
    // A block of eight days overlaps a stand-up on its first Thursday and the one a week on.
    const block = side({ eventId: 'e_block', sector: 'purdue', title: 'Training', startsAt: at(19, 8), endsAt: at(26, 12) })
    const first = side({ eventId: 'e_first', sector: 'ref', title: 'Stand-up', startsAt: at(19, 9), endsAt: at(19, 10) })
    const second = side({ eventId: 'e_second', sector: 'ref', title: 'Stand-up', startsAt: at(26, 9), endsAt: at(26, 10) })
    expect(clashLine({ id: 'e_block-e_first', kind: 'overlap', a: block, b: first }, 'e_block', ZONE)).toBe('Overlaps Stand-up (Ref), 9:00 AM')
    expect(clashLine({ id: 'e_block-e_second', kind: 'overlap', a: block, b: second }, 'e_block', ZONE)).toBe('Overlaps Stand-up (Ref), Nov 26, 9:00 AM')
    expect(clashTime({ id: 'e_block-e_second', kind: 'overlap', a: block, b: second }, 'e_block', { ...ZONE, on: at(21, 12) })).toBe('Thu 9:00 AM')
    // Beside a day: that day's time bare, six days off by weekday, seven by date, either side.
    expect(timeNear(at(26, 9), at(26, 23), ZONE)).toBe('9:00 AM')
    expect(timeNear(at(20, 9), at(26, 9), ZONE)).toBe('Fri 9:00 AM')
    expect(timeNear(at(19, 8), at(26, 9), ZONE)).toBe('Nov 19, 8:00 AM')
    expect(timeNear(at(26, 9), at(19, 9), ZONE)).toBe('Nov 26, 9:00 AM')
  })
  it("takes a job's name when given one, and uses ordinary spaces in times", () => {
    const line = clashLine(overlap, 'e_staff', { ...ZONE, label: (s) => (s === 'ref' ? 'Refereeing' : s) })
    expect(line).toBe('Overlaps Varsity Basketball (Refereeing), 6:00 PM')
    expect(line).not.toMatch(/[  ]/)
  })
})

describe('driveLine', () => {
  it('says a measured drive in minutes and miles', () => {
    expect(driveLine(drive)).toBe('38 min drive, 24 mi')
  })
  it('says about, to the nearest five minutes, for one worked out without the map', () => {
    expect(driveLine({ ...drive, minutes: 38, miles: 25, measured: false })).toBe('About 40 min, 25 mi')
  })
  it('gives hours past sixty minutes and leaves miles out when there are none', () => {
    expect(driveLine({ ...drive, minutes: 70, miles: undefined })).toBe('1 hr 10 min drive')
  })
  it('is null with no minutes', () => {
    expect(driveLine(overlap)).toBeNull()
  })
})

describe('clashTitle', () => {
  it('names the fact', () => {
    expect(clashTitle(overlap)).toBe('Two things at once')
    expect(clashTitle(drive)).toBe('15 minutes short')
    expect(clashTitle({ ...drive, measured: false })).toBe('About 15 minutes short')
    expect(clashTitle({ ...drive, shortBy: 1 })).toBe('1 minute short')
  })
})

describe('tellWords', () => {
  it("puts the later event first for an overlap, then its day, start and both jobs", () => {
    expect(tellWords(overlap, ZONE)).toEqual({ title: 'Varsity Basketball overlaps Staff meeting', detail: 'Thu 6:00 PM, Ref and Purdue' })
  })
  it('says a drive clash between the two in time order', () => {
    expect(tellWords(drive, ZONE)).toEqual({ title: '15 min short between Staff meeting and Varsity Basketball', detail: 'Thu 6:00 PM, Ref and Purdue' })
  })
  it('names one job once when both events are its', () => {
    expect(tellWords({ ...overlap, a: { ...staff, sector: 'ref' } }, ZONE).detail).toBe('Thu 6:00 PM, Ref')
  })
})

describe('leaveLine', () => {
  it('says when to leave', () => {
    expect(leaveLine({ eventId: 'e_game', leaveAt: at(26, 16, 35), from: 'start', measured: true }, ZONE)).toBe('Leave 4:35 PM')
  })
})
