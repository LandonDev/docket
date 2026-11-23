import type { DatabaseSync } from 'node:sqlite'
import { handled, NOT_HANDLED } from '@shared/work'
import type { ActKindDef, WorkModule } from '../modules'
import { registerCanvasFetcher } from '../canvas/fetch'
import { chatFileFetcher } from './file'
import { messagesHealth } from './health'
import { chatReplyKind } from './held'
import { searchChats, unanswered, unread, workSector } from './lifeos'
import { chatMentions } from './mentions'
import { draftsOf, dropDraft, dropWorkspaceDrafts, pushDrafts, retryReply, sendReply, undoReply } from './replies'
import { chatSearch, messageSearch } from './search'
import { CHAT_TELLS } from './tell'
import { messagesTools, PREAMBLE, readsChat } from './tools'
import { startWatch, watchOf } from './watch'

/**
 * The messages pillar's server module (docs/agents/work-messages.md). LifeOS
 * holds his chat; the Messages view reads it on its own sector session. The
 * host answers what a window must not read for itself (the one search,
 * Today's list, the unread count and its push) and Connections' rows,
 * each fenced by hand to the workspace's sector.
 */

export function ensureMessagesTables(db: DatabaseSync): void {
  // A thread's draft for a conversation nothing here can send to: he copies it. Kept by workspace, not by thread:
  // a draft outlives the thread that wrote it.
  db.exec(`CREATE TABLE IF NOT EXISTS work_messages_drafts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    session_id TEXT,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS work_messages_drafts_chat ON work_messages_drafts (workspace_id, chat_id)')
}

export const messages: WorkModule = {
  id: 'messages',
  ensure: ensureMessagesTables,
  async handle(req, ctx, by) {
    switch (req.method) {
      case 'work.messages.send': {
        const { workspaceId, chatId, replyTo, text } = req.params
        return handled(await sendReply(ctx, by, { workspaceId, chatId, text, ...(replyTo ? { replyTo } : {}) }))
      }
      case 'work.messages.undo':
        return handled(await undoReply(ctx, by, req.params))
      case 'work.messages.retry':
        return handled(await retryReply(ctx, by, req.params))
      case 'work.messages.drafts':
        return handled(draftsOf(ctx, req.params.workspaceId, req.params.chatId))
      case 'work.messages.dropDraft': {
        const { workspaceId } = req.params
        if (dropDraft(ctx, by, req.params)) await pushDrafts(ctx, workspaceId, watchOf(ctx)?.unreadOf(workspaceId))
        return handled({})
      }
      case 'work.messages.search': {
        const { workspaceId, query, limit } = req.params
        return handled(await searchChats(ctx, workSector(ctx, workspaceId), query, limit))
      }
      case 'work.messages.unanswered':
        return handled(await unanswered(ctx, workSector(ctx, req.params.workspaceId)))
      case 'work.messages.unread':
        return handled(await unread(ctx, workSector(ctx, req.params.workspaceId)))
      default:
        return NOT_HANDLED
    }
  },
  tools: messagesTools,
  acts: [chatReplyKind as unknown as ActKindDef],
  mentions: [chatMentions],
  search: [messageSearch, chatSearch],
  tells: CHAT_TELLS,
  preamble: (scope) => (readsChat(scope) ? PREAMBLE : null),
  start(ctx) {
    // A chat's picture or file opened beside its conversation is fetched here (file.ts).
    const offFetch = registerCanvasFetcher(chatFileFetcher)
    const offWatch = startWatch(ctx)
    return () => {
      offFetch()
      offWatch()
    }
  },
  workspaceCreated(_workspaceId, ctx) {
    watchOf(ctx)?.follow()
  },
  // A draft outlives the thread that wrote it (`sessionsRemoved` drops nothing); it goes with its workspace.
  workspaceRemoved(workspaceId, ctx) {
    watchOf(ctx)?.drop(workspaceId)
    dropWorkspaceDrafts(ctx, workspaceId)
  },
  health: messagesHealth
}
