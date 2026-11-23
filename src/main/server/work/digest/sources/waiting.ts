import type { Tell } from '@shared/work/tell'
import type { Source } from './index'

/**
 * Waiting on (docs/agents/work-mail.md "Waiting on"): mail he sent that no
 * one answered and whose time has come. One row a job a day while any
 * waits. The mail pillar has no method that lists or counts the waits (its
 * `work.mail.waiting` answers the settings), so this reads what its own
 * `mail_waiting` tool reads: LifeOS's `mailWaits:list` for the sector, on the
 * host's owner session, the rows of that sector only.
 */

const PAGE = 100
/** Pages read at most a job: past this the count is what was read. */
const PAGES = 10

interface WaitPage {
  page: { sector?: string; waiting: { dueAt: number } }[]
  isDone?: boolean
  continueCursor?: string
}

export const waitingTitle = (count: number): string => (count === 1 ? '1 sent mail has no answer' : `${count} sent mails have no answer`)

export const waiting: Source = {
  id: 'waiting',
  pillar: 'mail',
  every: 0,
  async read(env, now) {
    if (!env.ctx.lifeos.connected()) return []
    const owner = env.ctx.lifeos.owner()
    const tells: Tell[] = []
    for (const ws of env.workspaces()) {
      let count = 0
      try {
        let cursor: string | null = null
        for (let i = 0; i < PAGES; i++) {
          const got: WaitPage | null = await owner.query<WaitPage | null>('mailWaits:list', { sector: ws.sector, paginationOpts: { numItems: PAGE, cursor } })
          count += (got?.page ?? []).filter((r) => r.sector === ws.sector && r.waiting.dueAt <= now).length
          if (!got || got.isDone !== false || !got.continueCursor) break
          cursor = got.continueCursor
        }
      } catch {
        // LifeOS did not answer for this job: it says nothing today rather than a wrong count.
        continue
      }
      if (count > 0) tells.push({ kind: 'mail.waiting', workspaceId: ws.id, title: waitingTitle(count), key: `mail-waiting:${ws.id}:${env.day}`, open: { view: 'mail', workspaceId: ws.id } })
    }
    return tells
  }
}
