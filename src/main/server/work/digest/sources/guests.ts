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
 * only once that read's tells are kept: a job whose list failed, came back
 * in part, or came back with LifeOS's error beside it is read from the same
 * time again at the next digest. A row is keyed by the document and its
 * edit (`editedAt`), so an edit read twice is one row.
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
    const from = new Map<string, number>()
    const keys = new Map<string, string[]>()
    for (const ws of env.workspaces()) {
      // Each job from its own last whole read: a job whose read failed today looks back to then tomorrow, so an edit
      // made while its list could not be read is told late rather than never.
      const kept = Number(env.kept?.get(keptKey(ws.id)) ?? NaN)
      const since = Number.isFinite(kept) ? kept : fallback
      next.set(ws.id, since)
      from.set(ws.id, since)
      keys.set(ws.id, [])
      let found: FindAnswer
      try {
        found = await env.call<FindAnswer>('work.docs.find', { workspaceId: ws.id, refresh: true })
      } catch {
        // The docs pillar could not list this job: nothing is told for it today.
        continue
      }
      // Whole only when every place was read and LifeOS's part carried no error (Docs answers that beside the list).
      if (found.complete && !found.lifeos) next.set(ws.id, now)
      for (const entry of found.entries) {
        if (entry.lastBy !== 'guest' || entry.editedAt <= since) continue
        // Keyed by the document and its edit: the same edit read again, by a partial read today and a whole one
        // tomorrow, or in the seconds between the digest's time and LifeOS's answer, is the same row, never news twice.
        const key = `guest-edit:${entry.key}:${entry.editedAt}`
        keys.get(ws.id)!.push(key)
        tells.push({ kind: 'docs.guest', workspaceId: ws.id, title: guestTitle(entry.title), key, open: { view: 'docs', workspaceId: ws.id, at: entry.key } })
      }
    }
    return {
      tells,
      // A job whose every tell the ledger kept moves on; one with a tell it did not keep stays where it read from,
      // written down so a later digest's time does not stand in for it.
      done: (accepted) =>
        next.forEach((at, id) => env.kept?.set(keptKey(id), String(keys.get(id)!.every(accepted) ? at : from.get(id)!)))
    }
  }
}

const keptKey = (workspaceId: string): string => `guests.since:${workspaceId}`
