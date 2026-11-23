import { z } from 'zod'
import { clockOf, driveLine, type ClashWordsOpts } from '@shared/work/clashes'
import { workText, type WorkToolResult } from '@shared/work/tools'
import type { SectorKey } from '@shared/work/ids'
import type { WorkTool } from '../modules'
import { clashOf, lifeosWords, rangeOf, type LifeosClash, type LifeosSide } from './read'
import { startOfDay, zoneOf } from './zone'

/**
 * `clashes_list`: the thread's own job's clashes. Another job's event is
 * that job's name and its times, never its title, people or place: a thread
 * sees its own job and no other (the plan's ruling 4).
 */

const DAY = 86_400_000
const label = (sector: SectorKey): string => sector.charAt(0).toUpperCase() + sector.slice(1)
const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })

const dayFormats = new Map<string, Intl.DateTimeFormat>()
const dayOf = (at: number, zone: string): string => {
  let f = dayFormats.get(zone)
  if (!f) dayFormats.set(zone, (f = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone })))
  return f.format(at)
}

/** One clash as one line, from the job `own`'s side. */
export function clashText(c: LifeosClash, own: SectorKey, zone: string): string {
  const opts: ClashWordsOpts = { timeZone: zone }
  const span = (s: LifeosSide): string => `${clockOf(s.startsAt, opts)} to ${clockOf(s.endsAt, opts)}`
  const side = (s: LifeosSide): string => {
    if (s.sector !== own) return `a ${label(s.sector)} event (${span(s)})`
    const where = s.location ? `, at ${s.location}` : ''
    const ways = s.can.length ? `, can ${s.can.join(', ')}` : ''
    return `${s.title} (${label(s.sector)}, ${span(s)}${where}, event ${s.eventId}${ways})`
  }
  const about = c.measured === false ? 'about ' : ''
  if (c.kind === 'overlap') return `- ${dayOf(c.a.startsAt, zone)}: ${side(c.a)} overlaps ${side(c.b)}.`
  const short = c.shortBy !== undefined ? `${about}${Math.max(1, Math.round(c.shortBy))} min short` : 'not enough time'
  // The drive itself says where the other event is: it is shown only when both events are this job's.
  const drive = c.a.sector === own && c.b.sector === own ? driveLine(clashOf(c, new Map())) : null
  return `- ${dayOf(c.b.startsAt, zone)}: ${short} to drive from ${side(c.a)} to ${side(c.b)}${drive ? ` (${drive})` : ''}.`
}

export const clashesListTool: WorkTool = {
  name: 'clashes_list',
  description:
    "This job's calendar clashes with any of the owner's jobs, from today on: two events at once, or two he cannot drive between in time. Another job's event shows only as that job's name and its times. Read-only: to answer a clash, draft the act with draft_calendar_op or a mail draft, which waits in the Outbox for his press.",
  input: z.object({
    days: z.number().int().min(1).max(14).optional().describe('How many days from today to read: 7 when left out, 14 at most.'),
    sector: z.string().min(1).max(40).optional().describe("Only in a Work Chat, which belongs to no job: the job to read. A workspace's thread reads its own.")
  }),
  readOnly: true,
  run: async (args, ctx) => {
    if (!ctx.enabled()) return fail('Work is off on this host.')
    const a = args as { days?: number; sector?: string }
    const own = ctx.scope.sector
    if (own && a.sector && a.sector !== own) return fail(`This thread reads only the ${own} job's clashes.`)
    if (!own && ctx.scope.workspaceId) return fail('This workspace is linked to no LifeOS sector.')
    const sector = own ?? a.sector
    if (!sector) return fail('Name the job: a Work Chat belongs to none.')
    const days = Math.min(14, Math.max(1, a.days ?? 7))
    try {
      const zone = await zoneOf(ctx)
      const from = startOfDay(Date.now(), zone)
      const range = await rangeOf(ctx, from, from + days * DAY)
      const mine = (range?.clashes ?? []).filter((c) => c.a.sector === sector || c.b.sector === sector)
      const head = `${label(sector)}'s clashes over the next ${days === 1 ? 'day' : `${days} days`}, times in ${zone}:`
      return workText(mine.length ? [head, ...mine.map((c) => clashText(c, sector, zone))].join('\n') : `No clashes for ${label(sector)} over the next ${days === 1 ? 'day' : `${days} days`}.`)
    } catch (err) {
      return fail(`LifeOS did not answer: ${lifeosWords(err)}`)
    }
  }
}
