import type { HeldRef } from './acts'
import type { SectorKey } from './ids'

/**
 * The weekly review's rules (docs/agents/work-review.md): what a week is, how
 * evidence becomes hours, when the week before is worth a line, what is kept
 * once a week is over, and every word the page says about them. Pure: no zod,
 * no node, no clock of its own. The window, the host's tool and the tests all
 * read the same functions, so a number is worked out in one place.
 *
 * Two kinds of time are never mixed. Calendar time is measured: an event's
 * own length. Desk time is an estimate from what he did in TempCode, and it
 * always says "about".
 */

// --- the rulings, each one constant --------------------------------------------------------

/** The week's first day: 1 is Monday (0 would be Sunday), so a weekend of games stays whole. */
export const WEEK_STARTS = 1
/** Things he did less than this apart are one sitting. */
export const SITTING_GAP_MS = 20 * 60_000
/** A sitting is taken to have begun this long before its first sign. */
export const LEAD_MS = 5 * 60_000
/** An estimate is said to the quarter hour. */
export const QUARTER_MS = 15 * 60_000
/** The week before is worth a line only when the hours moved by this share and by this much. */
export const COMPARE_SHARE = 0.25
export const COMPARE_MS = 2 * 60 * 60_000
/** A held item has slipped once it has waited this long. */
export const HELD_SLIPS_MS = 24 * 60 * 60_000
/** Rows a job shows in Shipped before "Show all". */
export const SHIPPED_SHOWN = 5

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// --- the week ------------------------------------------------------------------------------

/** One week, `[from, to)` in epoch ms, cut at midnight on the wall clock of a time zone. */
export type ReviewWeek = { from: number; to: number }

const formats = new Map<string, Intl.DateTimeFormat>()
function format(key: string, tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${key}:${tz}`
  let f = formats.get(id)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options })
    formats.set(id, f)
  }
  return f
}

/** The wall clock of `tz` at `at`, as if it were UTC. */
function wall(tz: string, at: number): number {
  const f = format('wall', tz, { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, Number(x.value)])) as Record<string, number>
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!)
}

/** The instant the wall clock of `tz` reads `local` (a wall time written as UTC); a time a clock change skips lands just past the gap. */
function instant(tz: string, local: number): number {
  const a = local - (wall(tz, local) - local)
  const b = local - (wall(tz, a) - a)
  for (const at of [b, a]) if (wall(tz, at) === local) return at
  return Math.max(a, b)
}

/** Whether this runtime knows the zone. */
export function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The week that holds `at`, in `tz`. A week with a clock change in it is 167 or 169 hours long. */
export function weekOf(at: number, tz: string): ReviewWeek {
  const local = wall(tz, at)
  const midnight = Math.floor(local / DAY) * DAY
  const back = (new Date(midnight).getUTCDay() - WEEK_STARTS + 7) % 7
  const first = midnight - back * DAY
  return { from: instant(tz, first), to: instant(tz, first + 7 * DAY) }
}

/** The week `by` weeks after (or, negative, before) `week`. */
export function stepWeek(week: ReviewWeek, by: number, tz: string): ReviewWeek {
  const first = Math.floor(wall(tz, week.from) / DAY) * DAY + by * 7 * DAY
  return { from: instant(tz, first), to: instant(tz, first + 7 * DAY) }
}

/**
 * The week a host names by its first moment, in `tz`. A host cuts weeks in its own zone: Monday midnight in Tokyo is
 * still Sunday in New York, so the week is found from the middle of the one named, which lies in the same week in
 * every zone.
 */
export const weekNamed = (from: number, tz: string): ReviewWeek => weekOf(from + 3.5 * DAY, tz)

/** The week that holds a civil day ("2026-11-22") in `tz`, read as that day in `tz` and not as UTC's; null for no such day. */
export function weekOfDay(day: string, tz: string): ReviewWeek | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
  if (Number.isNaN(local) || new Date(local).toISOString().slice(0, 10) !== day) return null
  return weekOf(instant(tz, local), tz)
}

/** Whether `[from, to)` is a whole week of `tz`: the only span a host keeps. */
export const isWeek = (from: number, to: number, tz: string): boolean => {
  const w = weekOf(from, tz)
  return w.from === from && w.to === to
}

/** The first moment of the day `days` after the day that holds `at`. */
export function dayStart(at: number, tz: string, days = 0): number {
  return instant(tz, Math.floor(wall(tz, at) / DAY) * DAY + days * DAY)
}

/** The local day that holds `at`, as "2026-11-16": how Money names the days of a span. */
export function localDay(at: number, tz: string): string {
  return new Date(Math.floor(wall(tz, at) / DAY) * DAY).toISOString().slice(0, 10)
}

// --- the facts a host answers ---------------------------------------------------------------

/** A job on one host: a Work workspace. Jobs of one sector on several hosts are one job. */
export type ReviewJob = { workspaceId: string; sector: SectorKey | null; name: string }

/** What a point is a sign of: a message he wrote, a mail he sent, a held item he pressed, a document he changed. */
export const POINT_KINDS = ['said', 'sent', 'pressed', 'edited'] as const
export type PointKind = (typeof POINT_KINDS)[number]
/** One sign that he was at the desk: when, which of the body's `jobs` (its index), and what. */
export type HostPoint = [at: number, job: number, kind: PointKind]

export type ReviewEvent = {
  id: string
  sector: SectorKey
  title: string
  startsAt: number
  endsAt: number | null
  allDay: boolean
  declined: boolean
  hidden: boolean
  /** the others on it, by name (or address), his own left out; eight at most */
  people: string[]
  /** how many others there are in all */
  others: number
  /** their addresses, lower case, for the follow-up rule; twenty at most */
  addresses: string[]
}
export type ReviewSent = { id: string; threadId: string; subject: string; to: string[]; addresses: string[]; at: number; sector: SectorKey }
export type ReviewDone = { id: string; title: string; at: number; sector: SectorKey }
export type ReviewAnswer = { threadId: string; subject: string; by: string; at: number; sector: SectorKey }

/** LifeOS's facts for the week, every sector: the same from every host, so the window takes them once. */
export type ReviewLifeos = {
  events: ReviewEvent[]
  sent: ReviewSent[]
  done: ReviewDone[]
  answered: ReviewAnswer[]
  /** answers are kept from this moment on; null: none has been kept yet. A week that ended before it shows no Answered rows. */
  answeredSince: number | null
}

export type SlippedKind = 'task' | 'mail' | 'held' | 'meeting'
/** What a press on a slipped row names: the row's own thing, where it lives. */
export type SlippedRef =
  | { kind: 'task'; id: string; dueAt: number }
  | { kind: 'mail'; threadId: string; since: number }
  | { kind: 'held'; ref: HeldRef }
  | { kind: 'meeting'; eventId: string }

export type SlippedRow = {
  /** `task:<id>`, `mail:<thread>:<since>`, `held:<at>:<id>`, `meeting:<event>`: one thing, one key */
  key: string
  ref: SlippedRef
  sector: SectorKey | null
  /** a held item's workspace on its host; null for LifeOS's things */
  workspaceId: string | null
  /** the thing's own name: a task's title, a mail's subject, a meeting's name, a held item's summary */
  title: string
  /** what the detail is said from: when it was due, sent, held or began */
  at: number
  /** whom the mail went to, or who else was at the meeting; empty for the rest */
  people: string[]
  others: number
  /** in the window's merge alone: the row's source did not answer this time, so it stands as last known and its presses wait */
  unchecked?: boolean
  /** still open when last read; false: dealt with since the week was kept */
  open: boolean
}

export type ShippedKind = 'sent' | 'finished' | 'answered' | 'approved'
export type ShippedRow = {
  key: string
  kind: ShippedKind
  sector: SectorKey | null
  workspaceId: string | null
  /** the mail's subject, the task's title, the held item's summary */
  title: string
  /** whom it went to, or who answered */
  who: string | null
  at: number
  /** what a press opens */
  open: { at: 'task'; id: string } | { at: 'mail'; threadId: string } | { at: 'held'; ref: HeldRef } | null
}

/** The week before, cut to the same span, as bare facts: enough for `hoursOf` and nothing more. */
export type ReviewBefore = {
  from: number
  to: number
  /** counted calendar spans by sector, and the mails he sent; null when LifeOS did not answer */
  lifeos: { events: { sector: SectorKey; from: number; to: number }[]; sent: { at: number; sector: SectorKey }[] } | null
  points: HostPoint[]
}

/** One host's part of one week (`work.review.week`). */
export type ReviewBody = {
  host: string
  from: number
  to: number
  tz: string
  madeAt: number
  by: 'routine' | 'owner'
  /** the week had ended when this was made */
  over: boolean
  jobs: ReviewJob[]
  lifeos: ReviewLifeos | null
  points: HostPoint[]
  /** how long this host's threads worked, per job (an index of `jobs`) */
  ran: [job: number, ms: number][]
  slipped: { at: number; rows: SlippedRow[] }
  /** what went out from this host on his press; LifeOS's own (mail, tasks, answers) are read from `lifeos` */
  shipped: ShippedRow[]
  before: ReviewBefore | null
  /** the sources that did not answer, in plain words */
  left: string[]
  /** the events whose page in this host's Prep holds notes or an outcome: a meeting any host names is followed up */
  prepped?: string[]
}

// --- hours ----------------------------------------------------------------------------------

/** A job across hosts: a sector, or, for a workspace with none, a key of its own. */
export type JobKey = string
export const jobKey = (host: string, job: Pick<ReviewJob, 'workspaceId' | 'sector'>): JobKey => job.sector ?? `~${host}:${job.workspaceId}`

export type Span = { from: number; to: number }
export type Point = { at: number; job: JobKey; kind: PointKind }

/** The part of an event that counts as calendar time: none when he declined it, hid it, or it lasts all day or has no end. */
export function countedSpan(e: Pick<ReviewEvent, 'startsAt' | 'endsAt' | 'allDay' | 'declined' | 'hidden'>): Span | null {
  if (e.declined || e.allDay || e.hidden || e.endsAt === null || e.endsAt <= e.startsAt) return null
  return { from: e.startsAt, to: e.endsAt }
}

const clip = (s: Span, within: Span): Span | null => {
  const from = Math.max(s.from, within.from)
  const to = Math.min(s.to, within.to)
  return to > from ? { from, to } : null
}

/** Spans joined where they touch or overlap, in order. */
export function joinSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = []
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1]
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to)
    else out.push({ ...s })
  }
  return out
}

const lengthOf = (spans: readonly Span[]): number => spans.reduce((n, s) => n + (s.to - s.from), 0)

/** `span` less every part of it that lies under one of `under` (joined, in order). */
function less(span: Span, under: readonly Span[]): Span[] {
  const out: Span[] = []
  let from = span.from
  for (const u of under) {
    if (u.to <= from) continue
    if (u.from >= span.to) break
    if (u.from > from) out.push({ from, to: u.from })
    from = Math.max(from, u.to)
    if (from >= span.to) break
  }
  if (from < span.to) out.push({ from, to: span.to })
  return out
}

/**
 * The estimate's blocks. Points less than `SITTING_GAP_MS` apart, whatever
 * their jobs, are one sitting. Each gap inside a sitting goes to the job of
 * its later point (he was working toward that), and `LEAD_MS` leads the
 * sitting's first point. So one point alone is five minutes.
 */
export function deskBlocks(points: readonly Point[]): (Span & { job: JobKey })[] {
  const out: (Span & { job: JobKey })[] = []
  let last: number | null = null
  for (const p of [...points].sort((a, b) => a.at - b.at)) {
    if (last !== null && p.at - last < SITTING_GAP_MS) {
      if (p.at > last) out.push({ job: p.job, from: last, to: p.at })
    } else {
      out.push({ job: p.job, from: p.at - LEAD_MS, to: p.at })
    }
    last = p.at
  }
  return out
}

export type HourFacts = {
  /** every job, in the order they are listed: a job with nothing is still a row */
  jobs: readonly JobKey[]
  /** the span that counts: the week, cut to now while it runs */
  span: Span
  /** counted calendar spans (`countedSpan`), each under its job; one whose job is not listed counts for no job but still hides desk time */
  events: readonly (Span & { job: JobKey })[]
  points: readonly Point[]
  ran: readonly { job: JobKey; ms: number }[]
}

export type JobHours = {
  job: JobKey
  /** measured: his events' own length, overlaps inside the job counted once */
  calendarMs: number
  /** estimated: sittings, less what a counted event already covers */
  deskMs: number
  /** measured, and never part of his hours: how long the job's threads worked */
  ranMs: number
  /** how many events were counted */
  events: number
  /** what the estimate stands on */
  stands: Record<PointKind, number>
}

/** A job's hours from the merged facts. The one place a number on the page is worked out. */
export function hoursOf(f: HourFacts): JobHours[] {
  const rows = new Map<JobKey, JobHours>()
  for (const job of f.jobs) rows.set(job, { job, calendarMs: 0, deskMs: 0, ranMs: 0, events: 0, stands: { said: 0, sent: 0, pressed: 0, edited: 0 } })

  const byJob = new Map<JobKey, Span[]>()
  const all: Span[] = []
  for (const e of f.events) {
    const cut = clip(e, f.span)
    if (!cut) continue
    all.push(cut)
    const row = rows.get(e.job)
    if (!row) continue
    row.events++
    const list = byJob.get(e.job)
    if (list) list.push(cut)
    else byJob.set(e.job, [cut])
  }
  for (const [job, spans] of byJob) rows.get(job)!.calendarMs = lengthOf(joinSpans(spans))

  // No hour counts twice: desk time under any counted event, of any job, is dropped.
  const covered = joinSpans(all)
  const inSpan = f.points.filter((p) => p.at >= f.span.from && p.at < f.span.to)
  for (const p of inSpan) {
    const row = rows.get(p.job)
    if (row) row.stands[p.kind]++
  }
  for (const block of deskBlocks(inSpan)) {
    const row = rows.get(block.job)
    const cut = clip(block, f.span)
    if (!row || !cut) continue
    row.deskMs += lengthOf(less(cut, covered))
  }
  for (const r of f.ran) {
    const row = rows.get(r.job)
    if (row) row.ranMs += r.ms
  }
  return [...rows.values()]
}

/** His hours in a job: calendar plus desk. Threads' run time is never added. */
export const totalMs = (h: Pick<JobHours, 'calendarMs' | 'deskMs'>): number => h.calendarMs + h.deskMs

// --- the words for hours --------------------------------------------------------------------

const hm = (minutes: number): string => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} m`
  return m === 0 ? `${h} h` : `${h} h ${m} m`
}

/** An estimate to the quarter hour; anything seen at all is at least one quarter. */
export const toQuarter = (ms: number): number => (ms <= 0 ? 0 : Math.max(QUARTER_MS, Math.round(ms / QUARTER_MS) * QUARTER_MS))

/**
 * A length of time in words. A measure reads to the minute ("6 h 30 m"); an
 * estimate reads to the quarter hour and always says "about" ("about 4 h 30
 * m"). The two are told apart by this argument alone, so no caller can drop
 * the "about".
 */
export function hoursWords(ms: number, kind: 'measured' | 'estimate'): string {
  if (kind === 'estimate') return `about ${hm(toQuarter(ms) / MINUTE)}`
  return hm(Math.max(0, Math.round(ms / MINUTE)))
}

/** A job's total: an estimate as soon as any of it is; null when there is nothing to say. */
export function totalWords(h: Pick<JobHours, 'calendarMs' | 'deskMs'>): string | null {
  if (totalMs(h) <= 0) return null
  return h.deskMs > 0 ? hoursWords(totalMs(h), 'estimate') : hoursWords(h.calendarMs, 'measured')
}

/** A job with nothing all week. It names no week: the page may show one that is long over. */
export const NOTHING_SEEN = 'Nothing seen'
/** The same row while the calendar could not be read: only the desk is known to be empty. */
export const NO_DESK_SEEN = 'No desk time seen'
/** While what desk time stands on could not all be read (threads, a host): only the calendar is known to be empty. */
export const NO_CALENDAR_SEEN = 'Nothing on the calendar'
/** Neither was read. */
export const NOT_KNOWN = 'Not known'
/** What a job with no hours reads: "nothing" only of what was read. */
export const nothingWords = (known: { calendar: boolean; desk: boolean }): string => (known.calendar ? (known.desk ? NOTHING_SEEN : NO_CALENDAR_SEEN) : known.desk ? NO_DESK_SEEN : NOT_KNOWN)
export const CALENDAR_NOTE = 'Calendar time is measured.'
export const DESK_NOTE = 'Desk time is an estimate from what you did in TempCode.'
export const HOURS_NOTE = `${CALENDAR_NOTE} ${DESK_NOTE}`

const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** What the estimate stands on: "28 messages, 9 mails sent, 4 document edits"; null when on nothing. */
export function standsWords(stands: Record<PointKind, number>): string | null {
  const parts = [
    stands.said && count(stands.said, 'message', 'messages'),
    stands.sent && count(stands.sent, 'mail sent', 'mails sent'),
    stands.pressed && count(stands.pressed, 'held item decided', 'held items decided'),
    stands.edited && count(stands.edited, 'document edit', 'document edits')
  ].filter((x): x is string => !!x)
  return parts.length ? parts.join(', ') : null
}

/** A job's three facts, each said as what it is. */
export function factsOf(h: JobHours): { calendar: string; calendarDetail: string | null; desk: string | null; deskDetail: string | null; ran: string | null } {
  return {
    calendar: h.calendarMs > 0 ? hoursWords(h.calendarMs, 'measured') : 'Nothing',
    calendarDetail: h.events ? count(h.events, 'event', 'events') : null,
    desk: h.deskMs > 0 ? hoursWords(h.deskMs, 'estimate') : null,
    deskDetail: standsWords(h.stands),
    ran: h.ranMs >= MINUTE ? hoursWords(h.ranMs, 'measured') : null
  }
}

// --- the week before ------------------------------------------------------------------------

export type Comparison = { job: JobKey; words: string }

/**
 * The week before, said only where it says something: a job whose hours moved
 * by a quarter and by two hours, or one with two hours or more then and
 * nothing now. `running`: this week is not over, so `before` holds the same
 * span of last week and the words say so. A week that is over is compared
 * with "the week before", since the page may show it long after.
 */
export function compareWeeks(now: readonly JobHours[], before: readonly JobHours[], running: boolean): Comparison[] {
  const then = new Map(before.map((h) => [h.job, h]))
  const tail = running ? ' by this point last week' : ' the week before'
  const out: Comparison[] = []
  for (const h of now) {
    const b = then.get(h.job)
    if (!b) continue
    const cur = totalMs(h)
    const was = totalMs(b)
    const said = totalWords(b)
    if (cur <= 0) {
      if (was >= COMPARE_MS && said) out.push({ job: h.job, words: `${said}${tail}` })
      continue
    }
    const moved = Math.abs(cur - was)
    if (moved < COMPARE_MS || moved < was * COMPARE_SHARE) continue
    if (!said) out.push({ job: h.job, words: `nothing${tail}` })
    else out.push({ job: h.job, words: `${cur > was ? 'up' : 'down'} from ${said}${running ? tail : ''}` })
  }
  return out
}

// --- what is kept ---------------------------------------------------------------------------

/** Whether a body's read could say anything of a slipped row: false when the row's own source did not answer in it. */
export function uncheckedIn(body: Pick<ReviewBody, 'left' | 'lifeos'>, r: Pick<SlippedRow, 'ref'>): boolean {
  const left = (line: string): boolean => body.left.includes(line)
  // A list cut at its cap says nothing of a row past the cut: a part read is a read that failed for every row it missed.
  if (r.ref.kind === 'held') return left(LEFT.held) || left(LEFT.heldPart)
  if (!body.lifeos || left(LEFT.lifeos)) return true
  if (r.ref.kind === 'task') return left(LEFT.tasks)
  if (r.ref.kind === 'mail') return left(LEFT.mail) || left(LEFT.mailPart)
  return left(LEFT.calendar) || left(LEFT.mail)
}

/**
 * A waiting mail's key: its thread and the moment the wait began. A new wait on the same thread (he wrote again) is
 * another thing, so a kept row never looks open, or is pressed, on the strength of a newer wait.
 */
export const waitKey = (threadId: string, since: number): string => `mail:${threadId}:${since}`
/** A slipped row's one identity across makes: a week kept before mail keys named the wait is matched by its ref. */
const rowId = (r: Pick<SlippedRow, 'key' | 'ref'>): string => (r.ref.kind === 'mail' ? waitKey(r.ref.threadId, r.ref.since) : r.key)

/** A kept event cut to the moment it was read: what lay past that was a plan then, never measured time. */
const readTo = (events: readonly ReviewEvent[], at: number): ReviewEvent[] =>
  events.flatMap((e) => (e.startsAt >= at ? [] : [{ ...e, endsAt: e.endsAt === null ? null : Math.min(e.endsAt, at) }]))

/** `fresh`'s rows with `kept`'s added where `fresh` has none of the same key. */
function union<T>(fresh: readonly T[], kept: readonly T[], key: (x: T) => string): T[] {
  const have = new Set(fresh.map(key))
  return [...fresh, ...kept.filter((x) => !have.has(key(x)))]
}

/** `fresh`'s points with each of `kept`'s that it lacks, the job found again by workspace (the two may list jobs apart). */
function unionPoints(fresh: ReviewBody, kept: ReviewBody, f: readonly HostPoint[], k: readonly HostPoint[]): HostPoint[] {
  const index = new Map(fresh.jobs.map((j, i) => [j.workspaceId, i]))
  const counts = new Map<string, number>()
  const id = (p: HostPoint): string => `${p[0]}:${p[1]}:${p[2]}`
  for (const p of f) counts.set(id(p), (counts.get(id(p)) ?? 0) + 1)
  const out = [...f]
  for (const [at, job, kind] of k) {
    const i = index.get(kept.jobs[job]?.workspaceId ?? '')
    if (i === undefined) continue
    const p: HostPoint = [at, i, kind]
    const n = counts.get(id(p)) ?? 0
    // Each kept point is matched to one fresh point of the same value at most, so two edits in one moment stay two.
    if (n > 0) counts.set(id(p), n - 1)
    else out.push(p)
  }
  return out.sort((a, b) => a[0] - b[0])
}

/**
 * The facts of `kept` that a later read of the same week lost. Every fact carries a time already past when it was
 * kept, so a read that failed, came back cut at its cap, or no longer finds a thing (a decided item past the
 * Outbox's newest 500, a document closed) must not lower what was counted: desk points, run time and what shipped on
 * this host are joined, never replaced. LifeOS's facts are taken from the fresh read where its source answered, and
 * from the kept one where it did not: a calendar may change after a read (a meeting cancelled), so it is the one
 * list replaced and not joined, and a kept calendar is cut to the moment it was read.
 */
function keepFacts(kept: ReviewBody, fresh: ReviewBody): ReviewBody {
  const failed = (line: string): boolean => fresh.left.includes(line)
  const was = kept.lifeos ? { ...kept.lifeos, events: kept.over ? kept.lifeos.events : readTo(kept.lifeos.events, kept.madeAt) } : null
  let lifeos = fresh.lifeos
  if (!lifeos) lifeos = was
  else if (was) {
    lifeos = {
      events: failed(LEFT.calendar) ? was.events : lifeos.events,
      sent: union(lifeos.sent, was.sent, (m) => m.id),
      done: union(lifeos.done, was.done, (t) => t.id),
      answered: union(lifeos.answered, was.answered, (a) => `${a.threadId}:${a.at}`),
      answeredSince: lifeos.answeredSince ?? was.answeredSince
    }
  }
  const ran = new Map(fresh.ran)
  const index = new Map(fresh.jobs.map((j, i) => [j.workspaceId, i]))
  for (const [job, ms] of kept.ran) {
    const i = index.get(kept.jobs[job]?.workspaceId ?? '')
    if (i !== undefined) ran.set(i, Math.max(ran.get(i) ?? 0, ms))
  }
  const before =
    fresh.before && kept.before && kept.before.from === fresh.before.from
      ? { ...fresh.before, points: unionPoints(fresh, kept, fresh.before.points, kept.before.points.filter((p) => p[0] < fresh.before!.to)) }
      : fresh.before
  return {
    ...fresh,
    lifeos,
    points: unionPoints(fresh, kept, fresh.points, kept.points),
    ran: [...ran].sort((a, b) => a[0] - b[0]),
    shipped: union(fresh.shipped, kept.shipped.filter((r) => !r.workspaceId || index.has(r.workspaceId)), (r) => r.key),
    before
  }
}

/**
 * What a host answers for a week, from what it kept and what it just read.
 *
 * 1. A week that is not over is made again each time: the fresh body stands
 *    and replaces the kept one, with the kept rows of any source that did
 *    not answer this time carried as they last stood.
 * 2. Once the week is over, hours and what shipped are still the fresh ones
 *    (their facts carry times), but what slipped stays as it stood at the last
 *    make inside the week. A week first asked for after it ended has no such
 *    make: it shows what is still open from it, as of now.
 * 3. Each kept slipped row is checked against what is open now: one dealt
 *    with since reads `open: false`. A row whose source did not answer this
 *    time, or came back cut at its cap (`left`), is not checked: it keeps what
 *    was last known of it, so a read that failed never makes a thing look
 *    dealt with.
 * 4. Facts already kept are never lowered by a later read (`keepFacts`): a
 *    read that failed or was cut is said in `left`, and the figures stand on
 *    what was counted before as well as what was read now.
 *
 * `fresh.slipped.rows` is what had slipped by the week's end and is open now.
 */
export function mergeKept(kept: ReviewBody | null, fresh: ReviewBody, now: number): ReviewBody {
  if (!kept || kept.from !== fresh.from) return fresh
  const unknown = (r: SlippedRow): boolean => uncheckedIn(fresh, r)
  const facts = keepFacts(kept, fresh)
  if (now < fresh.to) {
    // Made again inside the week: the fresh body stands, but a read that failed must not wipe what the last make
    // knew, or Monday has nothing to look back on. The rows it could not check ride along as they last stood.
    if (fresh.left.length === 0) return facts
    const have = new Set(fresh.slipped.rows.map(rowId))
    const carried = kept.slipped.rows.filter((r) => unknown(r) && !have.has(rowId(r)))
    return carried.length === 0 ? facts : { ...facts, slipped: { at: fresh.slipped.at, rows: [...fresh.slipped.rows, ...carried] } }
  }
  if (kept.slipped.at >= kept.to) return facts
  const open = new Set(fresh.slipped.rows.map(rowId))
  return { ...facts, by: kept.by, slipped: { at: kept.slipped.at, rows: kept.slipped.rows.map((r) => (unknown(r) ? r : { ...r, open: open.has(rowId(r)) })) } }
}

// --- one review from every host's part ------------------------------------------------------

/** `stale`: the host did not answer this time, and this is what it answered before. */
export type ReviewPart = { environmentId: string; body: ReviewBody; stale?: boolean }
export type MergedJob = {
  key: JobKey
  sector: SectorKey | null
  name: string
  /** where the job's workspaces are, the first one first */
  at: { environmentId: string; workspaceId: string }[]
}
export type Placed<T> = T & { job: JobKey; environmentId: string }
export type MergedReview = {
  from: number
  to: number
  tz: string
  madeAt: number
  by: 'routine' | 'owner'
  over: boolean
  jobs: MergedJob[]
  hours: JobHours[]
  compare: Comparison[]
  shipped: Placed<ShippedRow>[]
  slipped: Placed<SlippedRow>[]
  /** when what slipped was read */
  slippedAt: number
  /** whether answers were kept for all of this week; false: the week may hold answers nobody kept, so none is no news */
  answersKept: boolean
  /** the host LifeOS's facts were taken from; null: no host had them */
  lifeosFrom: string | null
  left: string[]
  /**
   * What an empty list means: true only where every source of it answered, so "nothing" is known. `calendar`:
   * calendar time was read; `desk`: every host answered with its threads, held items and document history, and
   * LifeOS with the mail he sent; `shipped`: mail, tasks and every host's held items were; `slipped`: tasks, mail, the
   * calendar and every host's held items were.
   */
  known: { calendar: boolean; desk: boolean; shipped: boolean; slipped: boolean }
}

/** The name a sector's job goes by when no workspace of it is on a host that answered. */
export type SectorNames = (sector: SectorKey) => string

/**
 * The job a host's row is filed under: its workspace's, when that workspace is of the row's own sector, else its
 * sector's. A held item can name the workspace it was made in and a sector it has since been moved to: the sector is
 * the item's own, so it wins, and one job's thing is never shown under another.
 */
export function rowJob(body: Pick<ReviewBody, 'host' | 'jobs'>, r: { workspaceId: string | null; sector: SectorKey | null }): JobKey | null {
  const j = r.workspaceId ? body.jobs.find((x) => x.workspaceId === r.workspaceId && (!r.sector || x.sector === r.sector)) : undefined
  return j ? jobKey(body.host, j) : r.sector
}

const placePoints = (part: ReviewPart, points: readonly HostPoint[]): Point[] =>
  points.flatMap(([at, job, kind]) => {
    const j = part.body.jobs[job]
    return j ? [{ at, job: jobKey(part.body.host, j), kind }] : []
  })

/**
 * One review from each host's part. LifeOS's facts are the same from every
 * host, so they are taken once: from `home` when it has them, else from the
 * first part that does. Each host adds its own points, run time, held rows
 * and what went out on his press there. Jobs are one per sector; a job is
 * listed whether or not anything was seen, since the empty row is the news.
 */
export function mergeReview(
  parts: readonly ReviewPart[],
  now: number,
  /**
   * `fresh`: false when a host that was asked did not answer this time, so its part is missing or from before.
   * `whole`: false when that, or a host with Work on is off, so not every host's part is here.
   */
  /**
   * `jobs`: every job this window knows of, a host that is off its own too: each is listed though nothing of it was
   * read, since the empty row is the news.
   */
  opts: { home?: string | null; names?: SectorNames; order?: readonly JobKey[]; jobs?: readonly Pick<MergedJob, 'key' | 'sector' | 'name'>[]; fresh?: boolean; whole?: boolean } = {}
): MergedReview | null {
  const first = parts[0]
  if (!first) return null
  // LifeOS's facts from a part that answered this time before one kept from an earlier answer; among those, the one
  // whose own LifeOS reads failed least (a box whose calendar failed does not hide the Mac's whole read); the home
  // first in each.
  const holds = (p: ReviewPart): boolean => !!p.body.lifeos
  const rank = (p: ReviewPart): number => (p.stale ? 100 : 0) + lifeosLines(p) * 2 + (p.environmentId === opts.home ? 0 : 1)
  const source = parts.filter(holds).reduce<ReviewPart | null>((best, p) => (!best || rank(p) < rank(best) ? p : best), null)
  const lifeos = source?.body.lifeos ?? null

  const jobs = new Map<JobKey, MergedJob>()
  for (const part of parts) {
    for (const j of part.body.jobs) {
      const key = jobKey(part.body.host, j)
      const at = { environmentId: part.environmentId, workspaceId: j.workspaceId }
      const have = jobs.get(key)
      if (have) have.at.push(at)
      else jobs.set(key, { key, sector: j.sector, name: j.name, at: [at] })
    }
  }
  // A sector with something to show and no workspace on a host that answered is still a job.
  const seen = (sector: SectorKey): void => {
    if (!jobs.has(sector)) jobs.set(sector, { key: sector, sector, name: opts.names?.(sector) ?? sector, at: [] })
  }
  if (lifeos) {
    for (const e of lifeos.events) if (countedSpan(e)) seen(e.sector)
    for (const x of [...lifeos.sent, ...lifeos.done, ...lifeos.answered]) seen(x.sector)
  }
  // LifeOS's slipped rows are taken once, as its facts are. With LifeOS answering nobody, a kept week still holds
  // them as they last stood (`mergeKept`): they come from the home's part, else the first that has any, so a read
  // that failed does not empty the list it could not check.
  const ofLifeos = (part: ReviewPart): boolean => part.body.slipped.rows.some((r) => r.ref.kind !== 'held')
  const rowsFrom = source ?? parts.find((p) => p.environmentId === opts.home && ofLifeos(p)) ?? parts.find(ofLifeos) ?? null
  const slippedFrom = (part: ReviewPart): SlippedRow[] => part.body.slipped.rows.filter((r) => (r.ref.kind === 'held' ? true : part === rowsFrom))
  for (const part of parts) for (const r of slippedFrom(part)) if (r.sector) seen(r.sector)
  for (const j of opts.jobs ?? []) if (!jobs.has(j.key)) jobs.set(j.key, { ...j, at: [] })

  let list = [...jobs.values()]
  if (opts.order) {
    const rank = new Map(opts.order.map((k, i) => [k, i]))
    list = list.map((j, i) => ({ j, i })).sort((a, b) => (rank.get(a.j.key) ?? 1e6 + a.i) - (rank.get(b.j.key) ?? 1e6 + b.i)).map((x) => x.j)
  }
  const keys = list.map((j) => j.key)

  // A week still running is counted to the moment its facts were read, not to the window's own clock: the page
  // says "So far, made 2:02 PM", the span of the week before was cut there, and a later re-merge of the same
  // answers must not count a meeting on past it.
  // A part made while its week ran is counted to its own read even once the week is over by the clock: Friday's
  // part read on Monday, before Monday's answer lands, must not count the weekend's plans as measured time.
  const asOf = (source ?? first).body
  const read = asOf.madeAt
  const span: Span = { from: first.body.from, to: asOf.over ? first.body.to : Math.max(Math.min(now, read, first.body.to), first.body.from) }
  const events = (lifeos?.events ?? []).flatMap((e) => {
    const s = countedSpan(e)
    return s ? [{ ...s, job: e.sector }] : []
  })
  const points: Point[] = (lifeos?.sent ?? []).map((m) => ({ at: m.at, job: m.sector, kind: 'sent' as const }))
  const ran: { job: JobKey; ms: number }[] = []
  for (const part of parts) {
    points.push(...placePoints(part, part.body.points))
    for (const [job, ms] of part.body.ran) {
      const j = part.body.jobs[job]
      if (j) ran.push({ job: jobKey(part.body.host, j), ms })
    }
  }
  const hours = hoursOf({ jobs: keys, span, events, points, ran })

  const left = [...new Set(parts.flatMap((p) => (p === source || !source ? p.body.left : p.body.left.filter((l) => !LIFEOS_LEFT.has(l)))))]
  const missing = (...lines: string[]): boolean => lines.some((l) => left.includes(l))

  const fresh = opts.fresh !== false
  const whole = fresh && opts.whole !== false
  // The week before, from the same parts by the same rule. With anything unread, in either week, or a host that
  // did not answer this time, a comparison would describe the failure and not his week: none is drawn. A host
  // that is off is out of both weeks alike, so the comparison still holds.
  let compare: Comparison[] = []
  const beforeOf = (source ?? first).body.before
  if (beforeOf && source?.body.before?.lifeos && fresh && left.length === 0) {
    const past: Point[] = source.body.before.lifeos.sent.map((m) => ({ at: m.at, job: m.sector, kind: 'sent' as const }))
    for (const part of parts) if (part.body.before) past.push(...placePoints(part, part.body.before.points))
    const was = hoursOf({
      jobs: keys,
      span: { from: beforeOf.from, to: beforeOf.to },
      events: source.body.before.lifeos.events.map((e) => ({ from: e.from, to: e.to, job: e.sector })),
      points: past,
      ran: []
    })
    compare = compareWeeks(hours, was, !asOf.over)
  }

  const answersKept = !!lifeos && lifeos.answeredSince !== null && lifeos.answeredSince <= first.body.from
  const shipped: Placed<ShippedRow>[] = []
  if (lifeos && source) {
    const env = source.environmentId
    for (const m of lifeos.sent)
      shipped.push({ key: `sent:${m.id}`, kind: 'sent', sector: m.sector, workspaceId: null, title: m.subject, who: peopleWords(m.to, m.to.length), at: m.at, open: { at: 'mail', threadId: m.threadId }, job: m.sector, environmentId: env })
    for (const t of lifeos.done)
      shipped.push({ key: `done:${t.id}`, kind: 'finished', sector: t.sector, workspaceId: null, title: t.title, who: null, at: t.at, open: { at: 'task', id: t.id }, job: t.sector, environmentId: env })
    for (const a of lifeos.answered)
      shipped.push({ key: `answered:${a.threadId}:${a.at}`, kind: 'answered', sector: a.sector, workspaceId: null, title: a.subject, who: a.by, at: a.at, open: { at: 'mail', threadId: a.threadId }, job: a.sector, environmentId: env })
  }
  const slipped: Placed<SlippedRow>[] = []
  const has = new Set<string>()
  // A meeting followed up in Prep on any host: its page lives with the job's workspace, which may not be on the host
  // whose rows are listed. In a week still running it is gone; in one that is over it reads as dealt with since.
  const prepped = new Set(parts.flatMap((p) => p.body.prepped ?? []))
  const over = now >= first.body.to
  for (const part of parts) {
    for (const r of part.body.shipped) {
      const job = rowJob(part.body, r)
      if (job && jobs.has(job)) shipped.push({ ...r, key: `${part.environmentId}:${r.key}`, job, environmentId: part.environmentId })
    }
    for (const r of slippedFrom(part)) {
      const job = rowJob(part.body, r)
      const key = r.ref.kind === 'held' && r.ref.ref.at === 'host' ? `${part.environmentId}:${r.key}` : r.key
      if (!job || !jobs.has(job) || has.has(key)) continue
      has.add(key)
      const followed = r.ref.kind === 'meeting' && prepped.has(r.ref.eventId)
      if (followed && !over) continue
      slipped.push({ ...r, key, job, environmentId: part.environmentId, ...(followed ? { open: false } : part.stale || uncheckedIn(part.body, r) ? { unchecked: true } : {}) })
    }
  }
  shipped.sort((a, b) => b.at - a.at)
  slipped.sort((a, b) => b.at - a.at)

  const made = rowsFrom ?? first
  return {
    from: first.body.from,
    to: first.body.to,
    tz: first.body.tz,
    // A running week's "So far, made" names the moment its hours are counted to; a week that is over, its newest read.
    madeAt: now < first.body.to ? read : Math.max(...parts.map((p) => p.body.madeAt)),
    by: made.body.by,
    over: now >= first.body.to,
    jobs: list,
    hours,
    compare,
    shipped,
    slipped,
    slippedAt: made.body.slipped.at,
    answersKept,
    lifeosFrom: source?.environmentId ?? null,
    left,
    // An answer kept from before is no read of now: "nothing" stands only on LifeOS's facts read this time.
    known: {
      calendar: !!lifeos && !source?.stale && !missing(LEFT.lifeos, LEFT.calendar),
      desk: whole && !!lifeos && !missing(LEFT.lifeos, LEFT.threads, LEFT.held, LEFT.heldPart, LEFT.files, LEFT.filesPart, LEFT.mail),
      shipped: whole && !!lifeos && !missing(LEFT.lifeos, LEFT.mail, LEFT.tasks, LEFT.held, LEFT.heldPart),
      slipped: whole && !!lifeos && !missing(LEFT.lifeos, LEFT.tasks, LEFT.mail, LEFT.mailPart, LEFT.calendar, LEFT.held, LEFT.heldPart)
    }
  }
}

/** The lines a host leaves when a LifeOS read failed. Another host that had LifeOS makes them untrue, so the merge drops them. */
export const LEFT = {
  lifeos: 'LifeOS did not answer, so the calendar, tasks and mail are not counted.',
  calendar: 'The calendar did not answer.',
  tasks: 'Tasks did not answer.',
  mail: 'Mail did not answer.',
  held: 'Held items could not be read.',
  threads: 'Threads could not be read, so desk time may be short.',
  files: 'Document history did not answer, so document edits are not counted.',
  // A list that came back cut at its cap, or a source that answered for some of its things and not the rest: what was
  // read counts, and nothing past it is called settled or empty.
  mailPart: 'Not every waiting mail could be read.',
  heldPart: 'Not every held item could be read, so desk time may be short.',
  filesPart: 'Not every document’s history could be read, so document edits may be short.'
} as const
const LIFEOS_LEFT = new Set<string>([LEFT.lifeos, LEFT.calendar, LEFT.tasks, LEFT.mail, LEFT.mailPart])
/** The lines LifeOS's own reads leave, each of which a host whose read answered it does not repeat. */
const lifeosLines = (p: ReviewPart): number => p.body.left.filter((l) => LIFEOS_LEFT.has(l)).length

/** A host that did not answer: "The Mac is off. Its threads and held items are not counted." */
export const hostOffWords = (name: string): string => `${name} is off. Its threads and held items are not counted.`

// --- the words for rows ---------------------------------------------------------------------

/** "Dana Reyes", "Dana Reyes and Sam Park", "Dana Reyes and 3 others"; null for nobody. `total` counts those not named too. */
export function peopleWords(names: readonly string[], total: number): string | null {
  const first = names[0]
  if (!first) return null
  if (total <= 1) return first
  if (total === 2 && names[1]) return `${first} and ${names[1]}`
  return `${first} and ${count(total - 1, 'other', 'others')}`
}

/** "Week of Nov 16". */
/** The words a week's name opens with: a header short of room keeps the day alone. */
export const WEEK_OF = 'Week of '
export const weekWords = (week: Pick<ReviewWeek, 'from'>, tz: string): string => `${WEEK_OF}${format('md', tz, { month: 'short', day: 'numeric' }).format(week.from)}`

const clock = (at: number, tz: string): string => format('clock', tz, { hour: 'numeric', minute: '2-digit' }).format(at)
const weekday = (at: number, tz: string): string => format('wd', tz, { weekday: 'short' }).format(at)
const monthDay = (at: number, tz: string): string => format('md', tz, { month: 'short', day: 'numeric' }).format(at)

/** A day as the week's rows say it: its name inside the week shown ("Thu"), its date outside it ("Nov 12"). */
export const dayWords = (at: number, week: ReviewWeek, tz: string): string => (at >= week.from && at < week.to ? weekday(at, tz) : monthDay(at, tz))

/**
 * The page's first line. "So far, made 2:02 PM" while the week runs; "Made Fri 4:00 PM" once it is over, which is
 * when what slipped was last read inside the week; and for a week nobody made in its own time, that what slipped is
 * as of today.
 */
export function madeWords(r: Pick<MergedReview, 'madeAt' | 'over' | 'slippedAt' | 'to'>, tz: string, now: number): string {
  if (r.over && r.slippedAt >= r.to) return 'Not made in its week. What slipped is as of today.'
  const at = r.over ? r.slippedAt : r.madeAt
  const days = Math.round((dayStart(now, tz) - dayStart(at, tz)) / DAY)
  const day = days === 0 ? '' : days > 0 && days < 7 ? `${weekday(at, tz)} ` : `${monthDay(at, tz)}, `
  return `${r.over ? 'Made' : 'So far, made'} ${day}${clock(at, tz)}`
}

/** A shipped row, led by what happened: "Sent Budget v2 to Dana Reyes". The title is its own part so the page can weigh it. */
export function shippedWords(r: Pick<ShippedRow, 'kind' | 'title' | 'who'>): { lead: string; title: string; tail: string } {
  if (r.kind === 'sent') return { lead: 'Sent ', title: r.title, tail: r.who ? ` to ${r.who}` : '' }
  if (r.kind === 'finished') return { lead: 'Finished ', title: r.title, tail: '' }
  if (r.kind === 'answered') return { lead: `${r.who ?? 'Someone'} answered `, title: r.title, tail: '' }
  return { lead: 'Approved ', title: r.title, tail: '' }
}

/**
 * A slipped row's one muted detail: "due Tue", "sent Nov 12 to Dana Reyes", "held since Tue", "Thu 2:00 PM with Dana
 * Reyes and 3 others, nothing sent after". The meeting's rule is a rule of thumb, so the row says what is true of it.
 */
export function slippedDetail(r: Pick<SlippedRow, 'ref' | 'at' | 'people' | 'others'>, week: ReviewWeek, tz: string): string {
  const day = dayWords(r.at, week, tz)
  const who = peopleWords(r.people, r.others)
  if (r.ref.kind === 'task') return `due ${day}`
  if (r.ref.kind === 'mail') return who ? `sent ${day} to ${who}` : `sent ${day}`
  if (r.ref.kind === 'held') return `held since ${day}`
  return `${day} ${clock(r.at, tz)}${who ? ` with ${who}` : ''}, nothing sent after`
}

/** The three presses a slipped row offers, by kind, in order: now, next week, drop. */
export const SETTLE_HOWS = ['now', 'later', 'drop'] as const
export type SettleHow = (typeof SETTLE_HOWS)[number]
export const SETTLE_WORDS: Record<SlippedKind, Record<SettleHow, string>> = {
  task: { now: 'Done', later: 'Next week', drop: 'Drop' },
  mail: { now: 'Nudge', later: 'Next week', drop: 'Stop waiting' },
  held: { now: 'Open', later: 'Next week', drop: 'Discard' },
  meeting: { now: 'Follow up', later: 'Next week', drop: 'None needed' }
}
/** What the toast says once a press has landed. */
export const SETTLED_WORDS: Record<SlippedKind, Record<SettleHow, string>> = {
  task: { now: 'Marked done', later: 'Moved to next week', drop: 'Dropped' },
  mail: { now: 'Drafting a nudge', later: 'Put off to next week', drop: 'Stopped waiting' },
  held: { now: '', later: 'Put off to next week', drop: 'Discarded' },
  meeting: { now: '', later: 'Put off to next week', drop: 'Marked as needing nothing' }
}

/** The headings of the Slipped section's groups for one job: this week's rows lead and older tasks fold behind "12 older". */
export function splitOlder<T extends Pick<SlippedRow, 'ref' | 'at'>>(rows: readonly T[], week: ReviewWeek): { lead: T[]; older: T[] } {
  const lead: T[] = []
  const older: T[] = []
  for (const r of rows) (r.ref.kind === 'task' && r.at < week.from ? older : lead).push(r)
  return { lead, older }
}
