import type { SearchHit } from '@shared/work/search'
import { WORK_MODULES, type WorkModule } from '../../modules'
import { askPillar } from '../ask'
import type { SearchSource } from '../source'

/**
 * Chat messages, which are Messages' to find (docs/agents/work-search.md
 * "Files and Messages"): search asks `work.messages.search`, a job in reach
 * at a time, and opens a hit in the Messages view at the message. Absent
 * until that pillar answers. Once its module lists its own `search` line
 * this source stands down, and it is deleted when that line is on master.
 */

/** One hit as `work.messages.search` answers it (SEAMS "messages"). */
export interface MessageRow {
  chatId: string
  messageId: string
  /** the conversation's name */
  chat: string
  who: string
  text: string
  at: number
  source?: string
}

const hitOf = (row: MessageRow, workspaceId: string): SearchHit => ({
  key: `message:${row.messageId}`,
  kind: 'message',
  title: row.chat || row.who,
  ...(row.who ? { detail: row.who } : {}),
  ...(row.text ? { snippet: row.text } : {}),
  at: row.at,
  workspaceId,
  open: { to: 'view', view: 'messages', with: { chat: row.chatId, message: row.messageId } }
})

export function messageSource(modules: readonly WorkModule[] = WORK_MODULES): SearchSource {
  return {
    kind: 'message',
    label: 'Messages',
    tier: 'network',
    async search(ask, ctx) {
      const each = await Promise.all(
        ask.reach.workspaces.map(async (w) =>
          ((await askPillar<{ hits?: MessageRow[] }>(ctx, modules, 'work.messages.search', { workspaceId: w.id, query: ask.text, limit: ask.limit + 1 }, ask.by, ask.signal))?.hits ?? []).map((row) => hitOf(row, w.id))
        )
      )
      // Newest first across the jobs: a chat's own order is by time.
      return each
        .flat()
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
        .slice(0, ask.limit + 1)
    }
  }
}
