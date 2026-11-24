import type { SectorKey } from './ids'

/**
 * Clashes across jobs (docs/agents/work-clashes.md): the shapes both sides
 * read and the words a clash is shown in. LifeOS finds a clash (two events
 * at once, or two he cannot drive between in time); the host maps it to
 * these shapes and the screens say it with these words. Pure, and no zod:
 * the renderer may load this before zod.
 */

/** What an event allows as a way out of a clash: decline and propose for an invitation, move for his own event, late when someone on it can be written to. */
export type ClashWay = 'decline' | 'propose' | 'move' | 'late'
/** A stop for a drive: an event's place, a place as text, or the job's start (home unless he set another). */
export type ClashStop = { event: string } | { place: string } | { start: true }

/** One event of a clash. */
export interface ClashSide {
  eventId: string
  sector: SectorKey
  /** this host's Work workspace for the sector, when it has one */
  workspaceId?: string
  title: string
  startsAt: number
  endsAt: number
  /** the place as the map names it */
  place?: string
  /** the place as the calendar wrote it */
  location?: string
  /** the point is a town's centre, or the job's start standing in */
  rough?: 'town' | 'start'
  /** someone else is on it with an address: a change on its calendar is mailed to them */
  guests?: boolean
  can: ClashWay[]
}

/** Two events he cannot both make: `a` the earlier, `b` the later. */
export interface Clash {
  /** '<a's event id>-<b's event id>' */
  id: string
  kind: 'overlap' | 'drive'
  a: ClashSide
  b: ClashSide
  /** the drive from a to b */
  minutes?: number
  miles?: number
  /** false: a straight line with a road factor, worded "about" */
  measured?: boolean
  /** a drive clash: the minutes he is short by */
  shortBy?: number
}

/** When to leave for an event, from where he will be. */
export interface Leave {
  eventId: string
  leaveAt: number
  minutes?: number
  miles?: number
  /** from the job's start place, or from the event before */
  from: 'start' | 'event'
  fromTitle?: string
  measured: boolean
}

/** `work.clashes.answer`'s reply: `queued` when the act was handed to LifeOS's sender for a calendar (it has not reached the calendar yet), false when the change was written in LifeOS itself and is done. */
export interface ClashAnswered {
  queued: boolean
}

export interface ClashList {
  clashes: Clash[]
  leaves: Leave[]
}

/** One event of a clash as LifeOS answers it (`clashes:range`). */
export interface LifeosSide {
  eventId: string
  sector: SectorKey
  title: string
  startsAt: number
  endsAt: number
  location?: string
  place?: string
  rough?: 'town' | 'start'
  guests?: boolean
  can: ClashWay[]
}
export interface LifeosClash {
  id: string
  kind: 'overlap' | 'drive'
  a: LifeosSide
  b: LifeosSide
  minutes?: number
  metres?: number
  measured?: boolean
  shortBy?: number
}
export interface LifeosLeave {
  eventId: string
  leaveAt: number
  minutes?: number
  metres?: number
  measured: boolean
  from: 'start' | 'event'
  fromEventId?: string
  fromTitle?: string
}
export interface LifeosRange {
  clashes: LifeosClash[]
  leaves: LifeosLeave[]
}

/** An event with no end, or an end before its start, runs this long in LifeOS's clash rule (its `CLASH_NO_END_MS`). */
export const CLASH_NO_END_MS = 3_600_000

/** An event's end as LifeOS's clash rule counts it (its `eventEnd`): the row's own end when that is not before its start, else an hour on. */
export const clashEnd = (event: { startsAt: number; endsAt?: number | undefined }): number =>
  event.endsAt !== undefined && event.endsAt >= event.startsAt ? event.endsAt : event.startsAt + CLASH_NO_END_MS

/**
 * Whether an event's row, read again (`events:get`), still has the times a clash's side showed: its start, and
 * its end as the clash rule counts it, so an end taken away reads as an hour on (a change) and an event that
 * never had one is not refused for ever. A row with no start says nothing either way: undefined.
 */
export function sameTimes(row: { startsAt?: number | undefined; endsAt?: number | undefined }, side: { startsAt: number; endsAt: number }): boolean | undefined {
  if (typeof row.startsAt !== 'number') return undefined
  return row.startsAt === side.startsAt && clashEnd({ startsAt: row.startsAt, endsAt: row.endsAt }) === side.endsAt
}

/** Whether someone else is on an event with an address, as LifeOS's clash rule says `guests`: a change on its calendar is mailed to them. */
export const hasGuests = (row: { attendees?: readonly { address: string }[] | undefined }): boolean => row.attendees?.some((a) => a.address.includes('@')) ?? false

/** A job's Work workspace where the reader is, when it has one. */
type HomeOf = (sector: SectorKey) => string | undefined

const sideFrom = (s: LifeosSide, home: HomeOf | undefined): ClashSide => {
  const workspaceId = home?.(s.sector)
  return {
    eventId: s.eventId,
    sector: s.sector,
    ...(workspaceId ? { workspaceId } : {}),
    title: s.title,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    ...(s.place !== undefined ? { place: s.place } : {}),
    ...(s.location !== undefined ? { location: s.location } : {}),
    ...(s.rough !== undefined ? { rough: s.rough } : {}),
    ...(s.guests ? { guests: true } : {}),
    can: [...(s.can ?? [])]
  }
}

/** LifeOS's clash as every screen and the wire read it: each side's workspace added, metres as miles. */
export function clashFrom(c: LifeosClash, home?: HomeOf): Clash {
  return {
    id: c.id,
    kind: c.kind,
    a: sideFrom(c.a, home),
    b: sideFrom(c.b, home),
    ...(c.minutes !== undefined ? { minutes: c.minutes } : {}),
    ...(c.metres !== undefined ? { miles: milesOf(c.metres) } : {}),
    ...(c.measured !== undefined ? { measured: c.measured } : {}),
    ...(c.shortBy !== undefined ? { shortBy: c.shortBy } : {})
  }
}

export function leaveFrom(l: LifeosLeave): Leave {
  return {
    eventId: l.eventId,
    leaveAt: l.leaveAt,
    ...(l.minutes !== undefined ? { minutes: l.minutes } : {}),
    ...(l.metres !== undefined ? { miles: milesOf(l.metres) } : {}),
    from: l.from,
    ...(l.fromTitle !== undefined ? { fromTitle: l.fromTitle } : {}),
    measured: l.measured
  }
}

export function listFrom(range: LifeosRange | null | undefined, home?: HomeOf): ClashList {
  return { clashes: (range?.clashes ?? []).map((c) => clashFrom(c, home)), leaves: (range?.leaves ?? []).map(leaveFrom) }
}

export interface ClashWordsOpts {
  /** IANA zone the times are read in; absent: this machine's */
  timeZone?: string
  /** the day the line is read under (any instant of it), when that may not be the event's own start day: a list shows an event that runs past midnight under the next day too */
  on?: number
  /** a job's name; absent: the sector key with a capital (`ref` → Ref) */
  label?: (sector: SectorKey) => string
}

export const METRES_PER_MILE = 1609.344

/** Miles from metres: one decimal under 10 miles, whole miles from 10 up. */
export function milesOf(metres: number): number {
  const miles = metres / METRES_PER_MILE
  return miles < 10 ? Math.round(miles * 10) / 10 : Math.round(miles)
}

const labelOf = (sector: SectorKey, opts: ClashWordsOpts): string => opts.label?.(sector) ?? sector.charAt(0).toUpperCase() + sector.slice(1)

const formats = new Map<string, Intl.DateTimeFormat>()
const SHAPES = {
  time: { hour: 'numeric', minute: '2-digit' },
  day: { weekday: 'short' },
  date: { month: 'short', day: 'numeric' },
  dayDate: { weekday: 'short', month: 'short', day: 'numeric' },
  ymd: { year: 'numeric', month: 'numeric', day: 'numeric' },
} as const
function format(kind: keyof typeof SHAPES, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone ?? ''}`
  let f = formats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { ...SHAPES[kind], timeZone })
    formats.set(key, f)
  }
  return f
}
/** "6:00 PM", with an ordinary space where ICU puts a narrow no-break one. */
export const clockOf = (at: number, opts: ClashWordsOpts = {}): string => format('time', opts.timeZone).format(at).replace(/[  ]/g, ' ')
const dayOf = (at: number, opts: ClashWordsOpts): string => format('day', opts.timeZone).format(at)
/** The calendar day an instant falls on in the zone, counted in days, so two can be told a week apart. */
function dayNumber(at: number, opts: ClashWordsOpts): number {
  const parts = format('ymd', opts.timeZone).formatToParts(at)
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000
}
/**
 * A time as it is said beside a day (any instant of it): "6:00 PM" on that
 * day, "Wed 11:00 PM" within three days either side, and "Jan 7, 8:00 AM"
 * further off. A weekday reads as the nearest day of that name, and within
 * three days that is always the true one; so any seven days in a row read
 * as seven different words.
 */
export function timeNear(at: number, on: number, opts: ClashWordsOpts = {}): string {
  const apart = Math.abs(dayNumber(at, opts) - dayNumber(on, opts))
  const lead = apart === 0 ? '' : apart <= 3 ? `${dayOf(at, opts)} ` : `${format('date', opts.timeZone).format(at)}, `
  return `${lead}${isSecond(at, opts) ? 'second ' : ''}${clockOf(at, opts)}`
}
/** Whether an instant is the second time its clock shows, where the clocks go back (an hour in most zones, half an hour in a few): said as "second 1:30 AM", since the clock alone names two instants. */
export const isSecond = (at: number, opts: ClashWordsOpts = {}): boolean => [3_600_000, 1_800_000].some((back) => clockOf(at - back, opts) === clockOf(at, opts))

/** "38 min", "1 hr", "1 hr 10 min". */
function durationOf(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m} min`
  return m % 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m / 60} hr`
}

const rough = (clash: Clash): boolean => clash.measured === false
/** The minutes he is short by; to the nearest five, and never under five, for a drive worked out without the map, as its drive line is. */
const shortMinutes = (clash: Clash, by: number): number => (rough(clash) ? Math.max(5, Math.round(by / 5) * 5) : Math.max(1, Math.round(by)))
/** "15 min short", "About 15 min short" for a drive worked out without the map. */
function shortWords(clash: Clash): string {
  const short = clash.shortBy !== undefined ? `${shortMinutes(clash, clash.shortBy)} min short` : 'Not enough time'
  return rough(clash) ? `About ${short.charAt(0).toLowerCase()}${short.slice(1)}` : short
}

/**
 * The one line on an event's row, from that event's side (`eventId`; any id
 * but the earlier event's reads as the later one): "Overlaps Varsity
 * Basketball (Ref), 6:00 PM"; "15 min short after Staff meeting (Purdue)"
 * on the later event, "… before …" on the earlier. The other event's job is
 * named only when it is another job than this one's, and its time takes its
 * weekday when it starts on another day than the one the line is read under
 * ("Wed 11:00 PM"): the row's own start day, or `opts.on` when the list
 * shows the row under another.
 */
export function clashLine(clash: Clash, eventId: string, opts: ClashWordsOpts = {}): string {
  const earlier = eventId === clash.a.eventId
  const [own, other] = earlier ? [clash.a, clash.b] : [clash.b, clash.a]
  const named = other.sector === own.sector ? other.title : `${other.title} (${labelOf(other.sector, opts)})`
  if (clash.kind === 'overlap') return `Overlaps ${named}, ${clashTime(clash, eventId, opts)}`
  return `${shortWords(clash)} ${earlier ? 'before' : 'after'} ${named}`
}

/**
 * An event's lines, one a clash, as `clashLine` says each; two drive clashes
 * that would read alike (two later events of one name) each take the other
 * event's start, as the menu says it: "15 min short before Site visit (Ref),
 * 10:30 AM".
 */
export function clashLines(clashes: readonly Clash[], eventId: string, opts: ClashWordsOpts = {}): string[] {
  const lines = clashes.map((clash) => clashLine(clash, eventId, opts))
  return lines.map((line, i) => (clashes[i]!.kind === 'drive' && lines.indexOf(line) !== lines.lastIndexOf(line) ? `${line}, ${clashTime(clashes[i]!, eventId, opts)}` : line))
}

/** The other event's start as a line says it: "6:00 PM", with its weekday when it starts on another day than the one the line is read under ("Wed 11:00 PM"), or its date more than three days off ("Jan 14, 9:00 AM"). */
export function clashTime(clash: Clash, eventId: string, opts: ClashWordsOpts = {}): string {
  const [own, other] = eventId === clash.a.eventId ? [clash.a, clash.b] : [clash.b, clash.a]
  return timeNear(other.startsAt, opts.on ?? own.startsAt, opts)
}

/** "38 min drive, 24 mi"; "About 40 min, 25 mi" without the map (to the nearest five minutes); null with no minutes. */
export function driveLine(clash: Clash): string | null {
  if (clash.minutes === undefined) return null
  const miles = clash.miles !== undefined ? `, ${clash.miles} mi` : ''
  if (rough(clash)) return `About ${durationOf(Math.max(5, Math.round(clash.minutes / 5) * 5))}${miles}`
  return `${durationOf(clash.minutes)} drive${miles}`
}

/** The Clash dialog's title: "Two things at once", "15 minutes short", "About 15 minutes short". */
export function clashTitle(clash: Clash): string {
  if (clash.kind === 'overlap') return 'Two things at once'
  if (clash.shortBy === undefined) return 'Not enough time'
  const n = shortMinutes(clash, clash.shortBy)
  return `${rough(clash) ? 'About ' : ''}${n} ${n === 1 ? 'minute' : 'minutes'} short`
}

/**
 * The digest's row: "Varsity Basketball overlaps Staff meeting" (the later
 * first) or "15 min short between Staff meeting and Varsity Basketball",
 * then "Thu, Nov 26, 6:00 PM, Ref and Purdue": the later event's date and
 * start and the jobs, one name when both are one job. Always the date: a
 * clash is told up to two weeks ahead and read hours later, when a weekday
 * alone reads as this week's.
 */
export function tellWords(clash: Clash, opts: ClashWordsOpts = {}): { title: string; detail: string } {
  const { a, b } = clash
  const title = clash.kind === 'overlap' ? `${b.title} overlaps ${a.title}` : `${shortWords(clash)} between ${a.title} and ${b.title}`
  const jobs = a.sector === b.sector ? labelOf(b.sector, opts) : `${labelOf(b.sector, opts)} and ${labelOf(a.sector, opts)}`
  return { title, detail: `${format('dayDate', opts.timeZone).format(b.startsAt)}, ${isSecond(b.startsAt, opts) ? 'second ' : ''}${clockOf(b.startsAt, opts)}, ${jobs}` }
}

/** "Leave 4:35 PM". */
export const leaveLine = (leave: Leave, opts: ClashWordsOpts = {}): string => `Leave ${clockOf(leave.leaveAt, opts)}`
