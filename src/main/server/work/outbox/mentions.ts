import { MENTION_PER_KIND, mentionExcerpt, mentionMatches } from '@shared/work'
import type { MentionSource } from '../modules'
import { HeldStore } from './store'

/**
 * What waits in the Outbox, for the composer's `@` (docs/agents/work-canvas.md
 * "Mentions"): the held acts of the thread's workspace (a Work Chat's: those
 * outside every workspace), oldest first, as the Outbox lists them.
 */
export const outboxMentions: MentionSource[] = [
  {
    kind: 'held',
    async search(text, reach, ctx) {
      const rows = new HeldStore(ctx.db).list({ show: 'waiting', ...(reach.workspaceId ? { workspaceId: reach.workspaceId } : {}) })
      return rows
        .filter((row) => (reach.workspaceId ? true : row.workspaceId === null) && mentionMatches(text, row.summary, row.verb))
        .slice(0, MENTION_PER_KIND)
        .map((row) => ({ chip: { kind: 'held', label: row.summary, ref: { at: 'work', pillar: 'outbox', id: row.id }, excerpt: mentionExcerpt(`Item ${row.n}, waiting for the owner's press.`) }, detail: row.verb, at: row.createdAt }))
    }
  }
]
