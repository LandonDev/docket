import { MENTION_PER_KIND, type MentionHit } from '@shared/work'
import { fileChipOf } from '@shared/work/files'
import type { MentionSource } from '../modules'
import { filesState } from './handle'
import { namesAnswer } from './names'

/**
 * The composer's `@` for a file (docs/agents/work-files.md "Agents"): names across the workspace's places for the
 * typed words, his recents first, five at most, each a `file` chip. Read from the names table and his marks
 * (`namesAnswer`, names.ts), so it never walks a folder and never wakes the Windows VM, and every row is checked
 * for the caller there: a remote key hears only of files it could name itself. Only a Work workspace's own thread
 * is offered its files (`reach.workspaceId`, from the thread's row); a Work Chat has no places, and a code thread
 * is asked LifeOS's kinds alone. A caller the router did not name, and another host of his, hear of none.
 */
export const fileMentions: MentionSource[] = [
  {
    kind: 'file',
    async search(text, reach, ctx, by) {
      if (!by || by.peer || !reach.work || !reach.workspaceId) return []
      const { entries } = namesAnswer(ctx, by, { workspaceId: reach.workspaceId, text }, filesState(ctx), 'work.canvas.mentions')
      const hits: MentionHit[] = []
      for (const entry of entries) {
        const chip = fileChipOf(entry)
        if (!chip) continue
        const where = entry.where ? [entry.where.name, ...entry.where.trail].filter(Boolean).join(' › ') : ''
        hits.push({ chip, ...(where ? { detail: where } : {}), ...(entry.changed ? { at: entry.changed } : {}) })
        if (hits.length >= MENTION_PER_KIND) break
      }
      return hits
    }
  }
]
