import type { CalendarOffer } from '@shared/contract-work-money'
import type { WorkCtx } from '../modules'
import { eventMarks, lastFee, milesTo, type Books, type Workspace } from './store'

/**
 * Pay and mileage from the calendar (docs/agents/work-money.md "From the
 * calendar"). The host reads the job's sector's events of the last 60 days
 * as the owner, at most every ten minutes, and offers each ended one once:
 * a game or a paid item (it has a `role` or an `amount`), unless he set the
 * books to offer every event or none. Money writes nothing of money to
 * LifeOS; the one thing asked there on its behalf is a drive's length, by
 * the clashes pillar's own call.
 */

type Ctx = Pick<WorkCtx, 'db' | 'lifeos' | 'log'>

/** A LifeOS event, as far as Money reads it. */
export interface CalendarEvent {
  _id: string
  title: string
  startsAt: number
  endsAt?: number
  location?: string
  role?: string
  amount?: { cents: number; currency: string }
}

const DAY_MS = 24 * 3600_000
export const CALENDAR_DAYS = 60
const FRESH_MS = 10 * 60_000

const cache = new Map<string, { at: number; events: CalendarEvent[] }>()
/** Forgets what was read, so the next ask reads again (a test, or Work turned off and on). */
export const forgetCalendar = (): void => {
  cache.clear()
  drives.clear()
}

/** The job's events of the last 60 days that have ended, the oldest first. Nothing when the job has no sector or LifeOS does not answer. */
export async function endedEvents(ctx: Ctx, ws: Workspace, now = Date.now()): Promise<CalendarEvent[]> {
  if (!ws.sector || !ctx.lifeos.connected()) return []
  const held = cache.get(ws.id)
  let events = held && now - held.at < FRESH_MS ? held.events : null
  if (!events) {
    try {
      events = await ctx.lifeos.owner().query<CalendarEvent[]>('events:range', { from: now - CALENDAR_DAYS * DAY_MS, to: now, sector: ws.sector })
      cache.set(ws.id, { at: now, events })
    } catch (err) {
      ctx.log(`money: the calendar was not read (${String(err)})`)
      // What was read before still stands; with nothing read, nothing is offered.
      events = held?.events ?? []
    }
  }
  return events.filter((e) => (e.endsAt ?? e.startsAt) <= now).sort((a, b) => a.startsAt - b.startsAt)
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** The day an event started, on this host's clock. */
export const dayOfEvent = (startsAt: number): string => {
  const d = new Date(startsAt)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** One currency: an amount in another is not read as a fee. */
const usd = (e: CalendarEvent): number | null => (e.amount && e.amount.currency.toUpperCase() === 'USD' && e.amount.cents > 0 ? e.amount.cents : null)

/**
 * An event as an offer. The fee is the event's own amount, else the last
 * fee he gave an event with the same role, else not known. The miles are
 * the ones he gave that place before; else Clashes' measure of the drive
 * (`withDrives`); else not known: he types them once, and they are kept by
 * place.
 */
export function offerOf(ctx: Pick<WorkCtx, 'db'>, ws: Workspace, e: CalendarEvent): CalendarOffer {
  const place = e.location?.trim() || null
  const miles = place ? milesTo(ctx, place) : null
  return {
    eventId: e._id,
    date: dayOfEvent(e.startsAt),
    title: e.title,
    place,
    fee: usd(e) ?? (e.role ? lastFee(ctx, ws.id, e.role) : null),
    miles,
    // Miles he typed or accepted for this place are his own word.
    measured: miles !== null
  }
}

/** A drive there and back, as Clashes measured it; `measured` false: one leg or both is a straight line on the map, not a road. */
interface Drive {
  miles: number
  measured: boolean
}
const drives = new Map<string, Drive | null>()
/** One leg of a drive, as the clashes pillar's `milesBetween` answers it. A test hands in its own. */
type Measure = (ctx: WorkCtx, workspaceId: string, from: { start: true } | { event: string }, to: { start: true } | { event: string }) => Promise<{ miles: number; measured: boolean } | null>
let measure: Measure | null = null
export const setMeasure = (m: Measure | null): void => void (measure = m)
/** The most drives one read asks Clashes for: the rest are asked on the next. */
const DRIVES_A_READ = 6
const DRIVE_MS = 5_000

/**
 * The miles to an event's place and back, from Clashes (`milesBetween`, two
 * legs), kept for the life of the process. Null when Clashes is not on this
 * host, a stop has no point on the map, or it did not answer in time: he
 * then types the miles, once.
 */
async function driveTo(ctx: WorkCtx, ws: Workspace, eventId: string): Promise<Drive | null> {
  const key = `${ws.id}:${eventId}`
  if (drives.has(key)) return drives.get(key)!
  let drive: Drive | null = null
  try {
    const milesBetween = measure ?? (await import('../clashes/api')).milesBetween
    const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), DRIVE_MS).unref?.())
    const legs = await Promise.race([Promise.all([milesBetween(ctx, ws.id, { start: true }, { event: eventId }), milesBetween(ctx, ws.id, { event: eventId }, { start: true })]), late])
    // Not answered in time: not kept, so the next read asks again.
    if (!legs) return null
    const [out, back] = legs
    if (out && back) drive = { miles: Math.round((out.miles + back.miles) * 10) / 10, measured: out.measured && back.measured }
  } catch {
    return null
  }
  drives.set(key, drive)
  return drive
}

/** Fills the miles of offers that have a place and none he gave, from Clashes. An estimate is marked so: it is his to check, never added with one press. */
async function withDrives(ctx: Ctx, ws: Workspace, list: CalendarOffer[]): Promise<CalendarOffer[]> {
  let asked = 0
  return Promise.all(
    list.map(async (o) => {
      if (o.miles !== null || !o.place) return o
      const known = drives.has(`${ws.id}:${o.eventId}`)
      if (!known && asked++ >= DRIVES_A_READ) return o
      const drive = await driveTo(ctx as WorkCtx, ws, o.eventId)
      return drive && drive.miles > 0 ? { ...o, miles: drive.miles, measured: drive.measured } : o
    })
  )
}

/** What the view offers: ended events not yet added or skipped, by the books' rule. */
export async function offers(ctx: Ctx, ws: Workspace, books: Books | null, now = Date.now()): Promise<CalendarOffer[]> {
  const rule = books?.calendar ?? 'games'
  if (rule === 'off') return []
  const marks = eventMarks(ctx, ws.id)
  const list = (await endedEvents(ctx, ws, now)).filter((e) => (marks.get(e._id)?.state ?? 'adding') === 'adding' && (rule === 'all' || !!e.role || usd(e) !== null)).map((e) => offerOf(ctx, ws, e))
  return withDrives(ctx, ws, list)
}

/** The job's ended events that name a place, the latest first: what Add → Trip… lists. */
export async function placed(ctx: Ctx, ws: Workspace, now = Date.now()): Promise<CalendarOffer[]> {
  return withDrives(
    ctx,
    ws,
    (await endedEvents(ctx, ws, now))
      .filter((e) => e.location?.trim())
      .reverse()
      .map((e) => offerOf(ctx, ws, e))
  )
}

/** The role of an event he was offered, for the fee an added one teaches. */
export const roleOf = (workspaceId: string, eventId: string): string | null => cache.get(workspaceId)?.events.find((e) => e._id === eventId)?.role ?? null
