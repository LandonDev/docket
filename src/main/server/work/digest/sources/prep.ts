import type { PrepUpcoming } from '@shared/contract-work-prep'
import { timeIn } from '../clock'
import type { Source } from './index'

/**
 * Meetings, from the prep pillar's read (it tells nothing itself and keeps
 * no clock; SEAMS.md "prep"): `work.prep.upcoming` lists timed events with
 * someone else on them in this host's linked workspaces.
 *
 * - `starting`: each minute, a meeting that begins within ten minutes is
 *   told with its start as its clock, so it interrupts. Its key is the
 *   event and its start, the same on every host that holds the job, so two
 *   hosts tell it once and a meeting that moved is told again. Once it has
 *   begun it leaves the read, and its row and toast go with it.
 * - `ready`: when the day's digest is made, a brief that is ready for a
 *   meeting in the next day waits in it.
 */

const MINUTE = 60_000
/** How long before its start a meeting is told. */
export const STARTS_WITHIN_MS = 10 * MINUTE
const DAY = 24 * 60 * MINUTE

const names = (m: Pick<PrepUpcoming, 'with'>): string | undefined => {
  const who = m.with.filter(Boolean)
  if (who.length === 0) return undefined
  return `With ${who.length === 1 ? who[0] : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`}`
}

export const prepStarting: Source = {
  id: 'prep.starting',
  pillar: 'prep',
  every: MINUTE,
  prefix: 'prep:',
  async read(env, now) {
    const { meetings } = await env.call<{ meetings: PrepUpcoming[] }>('work.prep.upcoming', { from: now, to: now + STARTS_WITHIN_MS })
    return meetings
      .filter((m) => m.startsAt > now && m.startsAt - now <= STARTS_WITHIN_MS)
      .map((m) => {
        const detail = names(m)
        return {
          kind: 'prep.starting',
          workspaceId: m.workspaceId,
          // The clock time, not "in 10 min": the row is read later, in the list.
          title: `${m.title} starts at ${timeIn(env.zone, m.startsAt)}`,
          ...(detail ? { detail } : {}),
          key: `prep:${m.eventId}:${m.startsAt}`,
          open: { view: 'prep', workspaceId: m.workspaceId, at: m.eventId },
          by: m.startsAt
        }
      })
  }
}

export const prepReady: Source = {
  id: 'prep.ready',
  pillar: 'prep',
  every: 0,
  async read(env, now) {
    const { meetings } = await env.call<{ meetings: PrepUpcoming[] }>('work.prep.upcoming', { from: now, to: now + DAY })
    return meetings
      .filter((m) => m.state === 'briefed')
      .map((m) => {
        const who = names(m)
        return {
          kind: 'prep.ready',
          workspaceId: m.workspaceId,
          title: `Prep is ready for ${m.title}`,
          detail: who ? `${timeIn(env.zone, m.startsAt)}, ${who.charAt(0).toLowerCase()}${who.slice(1)}` : timeIn(env.zone, m.startsAt),
          key: `prep-ready:${m.eventId}:${env.day}`,
          open: { view: 'prep', workspaceId: m.workspaceId, at: m.eventId }
        }
      })
  }
}
