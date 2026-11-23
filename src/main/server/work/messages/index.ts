import type { DatabaseSync } from 'node:sqlite'
import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkCtx, WorkModule } from '../modules'
import { messagesHealth } from './health'
import { searchChats, unanswered, unread, workSector } from './lifeos'
import { ChatWatch } from './watch'

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

/** The live watch of each running context, so the workspace hooks reach it. */
const watches = new Map<WorkCtx, ChatWatch>()

export const messages: WorkModule = {
  id: 'messages',
  ensure: ensureMessagesTables,
  async handle(req, ctx) {
    switch (req.method) {
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
  start(ctx) {
    const watch = new ChatWatch(ctx)
    watches.set(ctx, watch)
    return () => {
      watch.stop()
      if (watches.get(ctx) === watch) watches.delete(ctx)
    }
  },
  workspaceCreated(_workspaceId, ctx) {
    watches.get(ctx)?.follow()
  },
  workspaceRemoved(workspaceId, ctx) {
    watches.get(ctx)?.drop(workspaceId)
  },
  health: messagesHealth
}
