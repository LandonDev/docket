import { MENTION_PER_KIND, mentionExcerpt, mentionMatches } from '@shared/work'
import type { MentionSource } from '../modules'
import { RoutineStore } from './store'

/** The workspace's routines, for the composer's `@` (docs/agents/work-canvas.md "Mentions"). A Work Chat has none. */
export const routineMentions: MentionSource[] = [
  {
    kind: 'routine',
    async search(text, reach, ctx) {
      if (!reach.workspaceId) return []
      return new RoutineStore(ctx.db)
        .list(reach.workspaceId)
        .filter((r) => !r.proposed && !r.ended && mentionMatches(text, r.name, r.prompt))
        .slice(0, MENTION_PER_KIND)
        .map((r) => ({ chip: { kind: 'routine', label: r.name, ref: { at: 'work', pillar: 'routines', id: r.id }, excerpt: mentionExcerpt(r.prompt) }, at: r.nextAt ?? undefined }))
    }
  }
]
