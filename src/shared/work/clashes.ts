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

export interface ClashList {
  clashes: Clash[]
  leaves: Leave[]
}

export interface ClashWordsOpts {
  /** IANA zone the times are read in; absent: this machine's */
  timeZone?: string
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
function format(kind: 'time' | 'day', timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone ?? ''}`
  let f = formats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', kind === 'time' ? { hour: 'numeric', minute: '2-digit', timeZone } : { weekday: 'short', timeZone })
    formats.set(key, f)
  }
  return f
}
/** "6:00 PM", with an ordinary space where ICU puts a narrow no-break one. */
export const clockOf = (at: number, opts: ClashWordsOpts = {}): string => format('time', opts.timeZone).format(at).replace(/[  ]/g, ' ')
const dayOf = (at: number, opts: ClashWordsOpts): string => format('day', opts.timeZone).format(at)

/** "38 min", "1 hr", "1 hr 10 min". */
function durationOf(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m} min`
  return m % 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m / 60} hr`
}

const rough = (clash: Clash): boolean => clash.measured === false
/** "15 min short", "About 15 min short" for a drive worked out without the map. */
function shortWords(clash: Clash): string {
  const short = clash.shortBy !== undefined ? `${Math.max(1, Math.round(clash.shortBy))} min short` : 'Not enough time'
  return rough(clash) ? `About ${short.charAt(0).toLowerCase()}${short.slice(1)}` : short
}

/**
 * The one line on an event's row, from that event's side (`eventId`; any id
 * but the earlier event's reads as the later one): "Overlaps Varsity
 * Basketball (Ref), 6:00 PM"; "15 min short after Staff meeting (Purdue)"
 * on the later event, "… before …" on the earlier.
 */
export function clashLine(clash: Clash, eventId: string, opts: ClashWordsOpts = {}): string {
  const earlier = eventId === clash.a.eventId
  const other = earlier ? clash.b : clash.a
  const named = `${other.title} (${labelOf(other.sector, opts)})`
  if (clash.kind === 'overlap') return `Overlaps ${named}, ${clockOf(other.startsAt, opts)}`
  return `${shortWords(clash)} ${earlier ? 'before' : 'after'} ${named}`
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
  const n = Math.max(1, Math.round(clash.shortBy))
  return `${rough(clash) ? 'About ' : ''}${n} ${n === 1 ? 'minute' : 'minutes'} short`
}

/**
 * The digest's row: "Varsity Basketball overlaps Staff meeting" (the later
 * first) or "15 min short between Staff meeting and Varsity Basketball",
 * then "Thu 6:00 PM, Ref and Purdue": the later event's day and start and
 * the jobs, one name when both are one job.
 */
export function tellWords(clash: Clash, opts: ClashWordsOpts = {}): { title: string; detail: string } {
  const { a, b } = clash
  const title = clash.kind === 'overlap' ? `${b.title} overlaps ${a.title}` : `${shortWords(clash)} between ${a.title} and ${b.title}`
  const jobs = a.sector === b.sector ? labelOf(b.sector, opts) : `${labelOf(b.sector, opts)} and ${labelOf(a.sector, opts)}`
  return { title, detail: `${dayOf(b.startsAt, opts)} ${clockOf(b.startsAt, opts)}, ${jobs}` }
}

/** "Leave 4:35 PM". */
export const leaveLine = (leave: Leave, opts: ClashWordsOpts = {}): string => `Leave ${clockOf(leave.leaveAt, opts)}`
