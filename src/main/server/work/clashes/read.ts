import type { ClashLeave, ClashMiles } from '@shared/contract-work-clashes'
import { clashFrom, leaveFrom, listFrom, milesOf, type Clash, type ClashAnswered, type ClashList, type ClashStop, type LifeosClash, type LifeosRange } from '@shared/work/clashes'

export type { LifeosClash, LifeosLeave, LifeosRange, LifeosSide } from '@shared/work/clashes'
import { errorText, type SectorKey } from '@shared/work/ids'
import type { Caller, WorkCtx } from '../modules'

/**
 * What the pillar reads from LifeOS and how it says it on the wire. LifeOS
 * finds the clashes (`clashes:range`) and measures the drives (`legs:ask`);
 * this file maps their answers, adds this host's workspace for each job and
 * turns metres into miles. Every call runs on the owner session.
 */

export const WORK_OFF = 'Work is off on this host.'
const HOUR = 3600_000

export function workOn(ctx: WorkCtx): void {
  if (!ctx.enabled()) throw new Error(WORK_OFF)
}

/** A LifeOS refusal in its own words: a ConvexError's data, else the error's message. */
export function lifeosWords(err: unknown): string {
  const data = (err as { data?: unknown } | null)?.data
  if (typeof data === 'string' && data) return data
  const message = data && typeof data === 'object' ? (data as { message?: unknown }).message : undefined
  if (typeof message === 'string' && message) return message
  return errorText(err).replace(/^.*?ConvexError:\s*/s, '')
}
/** Runs a LifeOS call; a refusal comes back as an error in its words. */
export async function asked<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    throw new Error(lifeosWords(err))
  }
}

/** This host's Work workspace for each sector: the first made, as capture picks it. */
export function homesOf(ctx: Pick<WorkCtx, 'db'>): Map<SectorKey, string> {
  const rows = ctx.db.prepare("SELECT id, sector FROM workspaces WHERE kind = 'work' AND sector IS NOT NULL ORDER BY created_at").all() as { id: string; sector: string }[]
  const homes = new Map<SectorKey, string>()
  for (const row of rows) if (!homes.has(row.sector)) homes.set(row.sector, row.id)
  return homes
}

export const clashOf = (c: LifeosClash, homes: Map<SectorKey, string>): Clash => clashFrom(c, (sector) => homes.get(sector))
export const leaveOf = leaveFrom
export const listOf = (range: LifeosRange | null | undefined, homes: Map<SectorKey, string>): ClashList => listFrom(range, (sector) => homes.get(sector))

export const rangeOf = (ctx: WorkCtx, from: number, to: number): Promise<LifeosRange | null> =>
  asked(() => ctx.lifeos.owner().query<LifeosRange | null>('clashes:range', { from, to }))

/** `work.clashes.list`: every job's clashes and leaves over the span. */
export async function listClashes(ctx: WorkCtx, from: number, to: number): Promise<ClashList> {
  workOn(ctx)
  if (to <= from) throw new Error('The span ends before it starts.')
  return listOf(await rangeOf(ctx, from, to), homesOf(ctx))
}

/** `work.clashes.leave`: when to leave for one event; null when there is nothing to say. */
export async function leaveFor(ctx: WorkCtx, eventId: string): Promise<ClashLeave | null> {
  workOn(ctx)
  const event = await asked(() => ctx.lifeos.owner().query<{ startsAt?: number } | null>('events:get', { id: eventId }))
  if (!event || typeof event.startsAt !== 'number') return null
  const range = await rangeOf(ctx, event.startsAt - HOUR, event.startsAt + HOUR)
  const found = range?.leaves.find((l) => l.eventId === eventId)
  if (!found) return null
  const { eventId: _, ...leave } = leaveOf(found)
  return leave
}

/** The job a workspace on this host is: it must be a Work workspace with a sector. */
export function sectorOfWorkspace(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): SectorKey {
  const row = ctx.db.prepare('SELECT kind, sector FROM workspaces WHERE id = ?').get(workspaceId) as { kind: string | null; sector: string | null } | undefined
  if (!row) throw new Error('No such workspace on this computer.')
  if (row.kind !== 'work' || !row.sector) throw new Error('Only a Work workspace linked to a job has drives to measure.')
  return row.sector
}

/** `work.clashes.miles`: the drive between two stops for a workspace's job; null when a stop has no point. */
export async function milesFor(ctx: WorkCtx, workspaceId: string, from: ClashStop, to: ClashStop): Promise<ClashMiles | null> {
  workOn(ctx)
  const sector = sectorOfWorkspace(ctx, workspaceId)
  const leg = await asked(() => ctx.lifeos.owner().mutation<{ minutes: number; metres: number; measured: boolean } | null>('legs:ask', { from, to, sector }))
  return leg ? { miles: milesOf(leg.metres), minutes: leg.minutes, measured: leg.measured } : null
}

/** One event of the pair as the dialog showed it at his press. */
export interface ClashSeen {
  eventId: string
  startsAt: number
  endsAt: number
  location?: string | undefined
}

/** `work.clashes.waive`: on, the clash goes quiet; off brings it back. On, what he saw goes with it, and LifeOS refuses a pair that has changed since. */
export async function waive(ctx: WorkCtx, id: string, on: boolean, seen?: readonly ClashSeen[]): Promise<null> {
  workOn(ctx)
  const shown = seen?.map(({ eventId, startsAt, endsAt, location }) => ({ eventId, startsAt, endsAt, ...(location !== undefined ? { location } : {}) }))
  await asked(() => ctx.lifeos.owner().mutation(on ? 'clashes:waive' : 'clashes:unwaive', { id, ...(on && shown ? { seen: shown } : {}) }))
  return null
}

export interface Answer {
  eventId: string
  way: 'decline' | 'propose' | 'move'
  comment?: string
  start?: number
  end?: number
}

export const NOT_HIS = 'Only the owner answers a clash, from the Clash dialog. Draft the act with draft_calendar_op instead; it waits in the Outbox for his press.'

/**
 * `work.clashes.answer`: his own press, sent at once, with no origin, as
 * New event sends (agenda/NewEventDialog.tsx). A thread's call is refused
 * whatever its key may do: its way out is the held tools.
 */
export async function answer(ctx: WorkCtx, a: Answer, by: Caller): Promise<ClashAnswered> {
  if (by.kind === 'model' || !by.caps.includes('approve')) throw new Error(NOT_HIS)
  workOn(ctx)
  const owner = ctx.lifeos.owner()
  const comment = a.comment?.trim() ? { comment: a.comment.trim() } : {}
  // A calendar's act is handed to LifeOS's sender, which takes it to the calendar after this answers: queued, not yet done.
  const send = async (kind: string, payload: Record<string, unknown>): Promise<ClashAnswered> => {
    const id = await asked(() => owner.mutation<string>('calendarOps:save', { kind, eventId: a.eventId, payload }))
    await asked(() => owner.mutation('calendarOps:send', { id, cause: 'press' }))
    return { queued: true }
  }
  if (a.way === 'decline') return send('decline', comment)
  const { start, end } = a
  if (start === undefined || end === undefined) throw new Error(a.way === 'propose' ? 'A new time needs a start and an end.' : 'A move needs a start and an end.')
  if (end <= start) throw new Error('The end must come after the start.')
  if (a.way === 'propose') return send('propose', { proposedStart: start, proposedEnd: end, ...comment })
  const event = await asked(() => owner.query<{ source?: string; startsAt?: number; arriveByAt?: number; leaveByAt?: number } | null>('events:get', { id: a.eventId }))
  if (!event) throw new Error('That event is no longer in LifeOS.')
  // A calendar's own event moves on its calendar; one that lives only in LifeOS moves there, with nothing sent.
  if (event.source === 'gcal' || event.source === 'ics') return send('update', { startsAt: start, endsAt: end })
  // A leave-by he set by hand is a time before its start and moves with it by as much, as LifeOS's own event sheet moves it, and so does its arrive-by: the time he was offered left the arrive-by's lead, and a leave-by left behind would be refused (it must come before the start) or tell him to leave at the old time.
  const shift = event.startsAt === undefined ? 0 : start - event.startsAt
  const moved = (at: number | undefined, key: string): Record<string, number> => (at === undefined || event.startsAt === undefined ? {} : { [key]: at + shift })
  await asked(() => owner.mutation('events:update', { id: a.eventId, patch: { startsAt: start, endsAt: end, ...moved(event.arriveByAt, 'arriveByAt'), ...moved(event.leaveByAt, 'leaveByAt') } }))
  return { queued: false }
}
