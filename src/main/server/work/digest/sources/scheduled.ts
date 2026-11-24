import type { Tell } from '@shared/work/tell'
import type { Source } from './index'

/**
 * A mail he scheduled that did not go (docs/agents/work-mail.md "Send later"): LifeOS tries a
 * route that is down for its grace, then fails the mail, keeps it in Scheduled and raises its own
 * alert. Work tells it too, once a mail, in the job of its sector, until he sends it again or
 * takes it back (then the row is done). It reads LifeOS's Scheduled list on the host's owner session.
 */

interface ScheduledRow {
  _id: string
  status: string
  scheduled?: boolean
  sendAt?: number
  sector?: string
  error?: string
  message?: { kind?: string; subject?: string }
}

/** "8:00 AM" on the digest's clock, or "Tue 8:00 AM" when it was another day. */
function when(at: number, zone: string, now: number): string {
  const day = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).format(ms)
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(at)
  return day(at) === day(now) ? clock : `${new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(at)} ${clock}`
}

export const missedTitle = (subject: string | undefined, at: string): string => {
  const words = subject?.trim()
  return words ? `"${words}" did not go at ${at}` : `A scheduled mail did not go at ${at}`
}

export const scheduled: Source = {
  id: 'scheduled',
  pillar: 'mail',
  // A missed mail is worth knowing within minutes, not at tomorrow's digest.
  every: 5 * 60_000,
  prefix: 'mail-missed:',
  async read(env, now) {
    // LifeOS out of reach throws, so every row already told stays as it is rather than being called done.
    if (!env.ctx.lifeos.connected()) throw new Error('LifeOS is not connected')
    const rows = (await env.ctx.lifeos.owner().query<ScheduledRow[] | null>('compose:list', { view: 'scheduled' })) ?? []
    const tells: Tell[] = []
    for (const ws of env.workspaces()) {
      for (const row of rows) {
        if (row.status !== 'failed' || row.scheduled !== true || row.sector !== ws.sector || row.message?.kind !== 'mail') continue
        tells.push({
          kind: 'mail.missed',
          workspaceId: ws.id,
          title: missedTitle(row.message.subject, typeof row.sendAt === 'number' ? when(row.sendAt, env.zone, now) : 'its time'),
          ...(row.error ? { detail: row.error } : {}),
          key: `mail-missed:${row._id}`,
          open: { view: 'mail', workspaceId: ws.id }
        })
      }
    }
    return tells
  }
}
