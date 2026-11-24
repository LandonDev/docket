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
 *
 * Each job is read from the time of its own last whole read (`kept`), moved
 * only once that read's tells are kept: a job whose list failed or came back
 * in part is read from the same time again at the next digest.
 */

const DAY = 86_400_000

export const guestTitle = (title: string, guest?: string): string => `${guest?.trim() || 'A guest'} edited ${title}`

export const guests: Source = {
  id: 'guests',
  pillar: 'docs',
  every: 0,
  async read(env, now) {
    const fallback = env.since > 0 ? env.since : now - DAY
    const tells: Tell[] = []
    /** each job's cutoff once its tells are kept: the read's time after a whole read, else the one it read from */
    const next = new Map<string, number>()
    for (const ws of env.workspaces()) {
      // Each job from its own last whole read: a job whose read failed today looks back to then tomorrow, so an edit
      // made while its list could not be read is told late rather than never.
      const since = env.kept?.get(keptKey(ws.id)) ?? fallback
      next.set(ws.id, since)
      let found: FindAnswer
      try {
        found = await env.call<FindAnswer>('work.docs.find', { workspaceId: ws.id, refresh: true })
      } catch {
        // The docs pillar could not list this job: nothing is told for it today.
        continue
      }
      if (found.complete) next.set(ws.id, now)
      for (const entry of found.entries) {
        if (entry.lastBy !== 'guest' || entry.editedAt <= since) continue
        tells.push({ kind: 'docs.guest', workspaceId: ws.id, title: guestTitle(entry.title), key: `guest-edit:${entry.key}:${env.day}`, open: { view: 'docs', workspaceId: ws.id, at: entry.key } })
      }
    }
    return { tells, done: () => next.forEach((at, id) => env.kept?.set(keptKey(id), at)) }
  }
}

const keptKey = (workspaceId: string): string => `guests.since:${workspaceId}`
