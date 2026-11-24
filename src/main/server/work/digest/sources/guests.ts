import type { FindAnswer } from '@shared/contract-work-docs'
import type { Tell } from '@shared/work/tell'
import type { Source } from './index'

/**
 * A guest edited a document (docs/agents/work-docs.md "Finding documents"):
 * one row a document a day, for each whose last edit since the last digest
 * was a guest's. Read from the docs pillar's own list, `work.docs.find`, a
 * job at a time: its entries say who last changed each (`lastBy`) and when.
 *
 * The list names no guest (`FindEntry` has `lastBy: 'guest'`, never who), so
 * every row says "A guest edited …". `guestTitle` takes a name for the day
 * the list carries one.
 */

const DAY = 86_400_000

export const guestTitle = (title: string, guest?: string): string => `${guest?.trim() || 'A guest'} edited ${title}`

export const guests: Source = {
  id: 'guests',
  pillar: 'docs',
  every: 0,
  async read(env, now) {
    const since = env.since > 0 ? env.since : now - DAY
    const tells: Tell[] = []
    for (const ws of env.workspaces()) {
      let found: FindAnswer
      try {
        found = await env.call<FindAnswer>('work.docs.find', { workspaceId: ws.id, refresh: true })
      } catch {
        // The docs pillar could not list this job: nothing is told for it today.
        continue
      }
      for (const entry of found.entries) {
        if (entry.lastBy !== 'guest' || entry.editedAt <= since) continue
        tells.push({ kind: 'docs.guest', workspaceId: ws.id, title: guestTitle(entry.title), key: `guest-edit:${entry.key}:${env.day}`, open: { view: 'docs', workspaceId: ws.id, at: entry.key } })
      }
    }
    return tells
  }
}
