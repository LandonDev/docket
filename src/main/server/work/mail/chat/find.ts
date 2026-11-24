import { registerMoveModule, tableMoveModule } from '../../../sessionMove'
import { ensureNarrowMarks } from '../../narrowing'
import type { DatabaseSync } from 'node:sqlite'
import type { MailChatFound } from '@shared/contract-work-mail'
import type { MailChatKind } from '@shared/work/mailChat'
import type { WorkCtx } from '../../modules'
import { workSector } from '../waiting'

/**
 * The mail chats this host made (docs/agents/work-mail.md "The chat beside
 * the mail"): one row a thread, written by `work.mail.chat.adopt` before its
 * first message, read by the window to find a mail's chat again and by the
 * narrowing on every call the thread makes.
 */

export interface MailChatRow {
  sessionId: string
  workspaceId: string
  kind: MailChatKind
  mailThreadId: string | null
}

/** The database `ensure` was last given: what the module reads where the frame hands it no context (a preamble, a harness's start). */
let known: DatabaseSync | null = null

export function ensureChatTables(db: DatabaseSync): void {
  // First, so a fault below never leaves a mail chat read as an ordinary thread (the harness's denial reads it).
  known = db
  db.exec(`CREATE TABLE IF NOT EXISTS work_mail_chats (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    mail_thread_id TEXT,
    created_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS work_mail_chats_by_mail ON work_mail_chats (workspace_id, mail_thread_id, created_at)')
  // A thread that moves to another host takes its row, so it is a mail chat there too, and the frame's mark with it.
  registerMoveModule(db, tableMoveModule('mail-chats', 'work_mail_chats'))
  // Chats marked before the frame kept marks get theirs now (narrowing.ts).
  ensureNarrowMarks(db)
  db.exec("INSERT OR IGNORE INTO work_narrowed (session_id, module, at) SELECT session_id, 'mail', created_at FROM work_mail_chats")
  registerMoveModule(db, tableMoveModule('narrowed', 'work_narrowed'))
}

type Row = { session_id: string; workspace_id: string; kind: string; mail_thread_id: string | null }
const rowOf = (r: Row): MailChatRow => ({ sessionId: r.session_id, workspaceId: r.workspace_id, kind: r.kind as MailChatKind, mailThreadId: r.mail_thread_id })

/** The thread's own row, or null. */
export function chatRow(db: DatabaseSync, sessionId: string): MailChatRow | null {
  const r = db.prepare('SELECT session_id, workspace_id, kind, mail_thread_id FROM work_mail_chats WHERE session_id = ?').get(sessionId) as Row | undefined
  return r ? rowOf(r) : null
}

/**
 * The mail chat a thread is, or works under: its own row, else the row of the
 * thread above it, its parent's or, for a root thread, the thread that
 * started it (`app_start_thread`), up the chain. A subagent of a mail chat,
 * and a thread it started on this host, are as narrow as the chat.
 */
export function mailChatOf(db: DatabaseSync, sessionId: string): MailChatRow | null {
  const own = chatRow(db, sessionId)
  if (own) return own
  // Asked on every tool call of every thread: a host with no mail chat walks nothing.
  if (!db.prepare('SELECT 1 FROM work_mail_chats LIMIT 1').get()) return null
  const r = db
    .prepare(
      `WITH RECURSIVE up(id, parent, depth) AS (
        SELECT ?, (SELECT COALESCE(parent_id, started_by) FROM sessions WHERE id = ?), 0
        UNION ALL
        SELECT s.id, COALESCE(s.parent_id, s.started_by), up.depth + 1 FROM sessions s JOIN up ON s.id = up.parent WHERE up.depth < 32
      )
      SELECT c.session_id, c.workspace_id, c.kind, c.mail_thread_id FROM up JOIN work_mail_chats c ON c.session_id = up.id ORDER BY up.depth LIMIT 1`
    )
    .get(sessionId, sessionId) as Row | undefined
  return r ? rowOf(r) : null
}

/** `mailChatOf` on the database `ensure` was given; null before it ran. */
export const mailChatHere = (sessionId: string): MailChatRow | null => (known && sessionId ? mailChatOf(known, sessionId) : null)

/** `work.mail.chat.find`: the workspace's mail chats about this mail, newest first. A thread this host no longer has is left out. */
export function findChats(ctx: Pick<WorkCtx, 'db'>, workspaceId: string, mailThreadId: string): MailChatFound {
  workSector(ctx, workspaceId)
  const rows = ctx.db
    .prepare(
      `SELECT c.session_id FROM work_mail_chats c JOIN sessions s ON s.id = c.session_id
       WHERE c.workspace_id = ? AND c.mail_thread_id = ? ORDER BY c.created_at DESC, c.rowid DESC`
    )
    .all(workspaceId, mailThreadId) as { session_id: string }[]
  return { sessionIds: rows.map((r) => r.session_id) }
}

/** Threads were deleted: their rows go. */
export function dropChats(db: DatabaseSync, sessionIds: readonly string[]): void {
  const drop = db.prepare('DELETE FROM work_mail_chats WHERE session_id = ?')
  for (const id of sessionIds) drop.run(id)
}
