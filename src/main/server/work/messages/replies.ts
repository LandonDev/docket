import { randomUUID } from 'node:crypto'
import type { MessagesDraftsAnswer, MessagesSendAnswer } from '@shared/contract-work-messages'
import { errorText, type SectorKey } from '@shared/work'
import { OWN_REPLY_HELD, REPLY_MAY_HAVE_GONE, type ChatDraft, type ChatMessage } from '@shared/work/messages'
import type { Caller, WorkCtx } from '../modules'
import { ChatReplySchema, pinnedReplyTo } from './held'
import { chatIn, isRefusal, NO_CHAT, refusalWords, unread, workSector } from './lifeos'

/**
 * His presses on a reply (docs/agents/work-messages.md "Replies"): his own
 * Send, Undo inside LifeOS's undo time, Retry of a failed one, and the
 * drafts threads left for conversations nothing here can send to. Each is a
 * person's: a thread's call is refused, and each is fenced to the
 * workspace's sector before LifeOS hears of it.
 */

export const NOT_A_PERSON = 'only a person can send, take back or drop a chat reply'
export const NOT_HERE = 'That reply is not in this conversation'

function mustBe(by: Caller, cap: 'approve' | 'operate'): void {
  if (by.kind === 'model' || !by.caps.includes(cap)) throw new Error(NOT_A_PERSON)
}

/** LifeOS's answer to a reply, its refusal in its own words. */
async function lifeosSays<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    throw new Error(refusalWords(err))
  }
}

/**
 * His own reply. LifeOS queues it for its undo time and answers its outbox
 * row. With `OWN_REPLY_HELD` on it waits in the Outbox instead, as a
 * thread's draft does, and the answer names the held item.
 */
export async function sendReply(ctx: WorkCtx, by: Caller, p: { workspaceId: string; chatId: string; replyTo?: string; text: string }, held: boolean = OWN_REPLY_HELD): Promise<MessagesSendAnswer> {
  mustBe(by, 'approve')
  const sector = workSector(ctx, p.workspaceId)
  const got = await chatIn(ctx, p.chatId, sector)
  if (!got) throw new Error(NO_CHAT)
  if (held) {
    const replyTo = pinnedReplyTo(got.chat.source, p.replyTo, got.chat)
    const payload = ChatReplySchema.parse({ chatId: p.chatId, ...(replyTo ? { replyTo } : {}), source: got.chat.source, chat: got.chat.name, text: p.text })
    const item = ctx.held.create({ kind: 'chat.reply', sessionId: null, payload })
    return { id: item.ref.id }
  }
  // No session to LifeOS throws here, before anything could reach it.
  const owner = ctx.lifeos.owner()
  try {
    return { id: await owner.mutation<string>('chats:reply', { chatId: p.chatId, ...(p.replyTo ? { replyTo: p.replyTo } : {}), text: p.text }) }
  } catch (err) {
    // LifeOS said no in its own words, and queued nothing. Any other fault may or may not have reached it: the window must
    // not offer the words to a plain Send again (REPLY_MAY_HAVE_GONE).
    if (isRefusal(err)) throw new Error(refusalWords(err))
    throw new Error(`${REPLY_MAY_HAVE_GONE}: ${refusalWords(err)}`)
  }
}

/** How far back a reply he takes back or retries is looked for: his queued and failed replies ride in as his own rows. */
const REPLY_PAGE = 100

/**
 * The fence for a reply LifeOS names by its outbox row: the conversation must
 * be this workspace's, and the row one of its replies.
 */
async function replyOf(ctx: WorkCtx, sector: SectorKey, chatId: string, outboxId: string): Promise<void> {
  if (!(await chatIn(ctx, chatId, sector))) throw new Error(NO_CHAT)
  const page = await ctx.lifeos.owner().query<{ page: ChatMessage[] }>('chats:messages', { chatId, paginationOpts: { numItems: REPLY_PAGE, cursor: null } })
  if (!(page?.page ?? []).some((m) => m.reply?.outboxId === outboxId)) throw new Error(NOT_HERE)
}

export async function undoReply(ctx: WorkCtx, by: Caller, p: { workspaceId: string; chatId: string; id: string }): Promise<{ text: string }> {
  mustBe(by, 'approve')
  await replyOf(ctx, workSector(ctx, p.workspaceId), p.chatId, p.id)
  return { text: await lifeosSays(() => ctx.lifeos.owner().mutation<string>('replies:undo', { id: p.id })) }
}

export async function retryReply(ctx: WorkCtx, by: Caller, p: { workspaceId: string; chatId: string; id: string }): Promise<Record<string, never>> {
  mustBe(by, 'approve')
  await replyOf(ctx, workSector(ctx, p.workspaceId), p.chatId, p.id)
  await lifeosSays(() => ctx.lifeos.owner().mutation('replies:retry', { id: p.id }))
  return {}
}

// ── drafts for a conversation with no way to send ──────────────────────

type DraftRow = { id: string; chat_id: string; session_id: string | null; text: string; at: number }

/** The thread's title, while this host still has the thread. */
function threadTitle(ctx: WorkCtx, sessionId: string | null): string | undefined {
  if (!sessionId) return undefined
  try {
    const row = ctx.db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title?: string } | undefined
    return row?.title?.trim() || undefined
  } catch {
    return undefined
  }
}

export function draftsOf(ctx: WorkCtx, workspaceId: string, chatId?: string): MessagesDraftsAnswer {
  workSector(ctx, workspaceId)
  const rows = (
    chatId
      ? ctx.db.prepare('SELECT id, chat_id, session_id, text, at FROM work_messages_drafts WHERE workspace_id = ? AND chat_id = ? ORDER BY at DESC').all(workspaceId, chatId)
      : ctx.db.prepare('SELECT id, chat_id, session_id, text, at FROM work_messages_drafts WHERE workspace_id = ? ORDER BY at DESC').all(workspaceId)
  ) as DraftRow[]
  const drafts = rows.map((r): ChatDraft => {
    const thread = threadTitle(ctx, r.session_id)
    return { id: r.id, chatId: r.chat_id, sessionId: r.session_id, ...(thread ? { thread } : {}), text: r.text, at: r.at }
  })
  return { drafts }
}

const draftCount = (ctx: WorkCtx, workspaceId: string): number =>
  (ctx.db.prepare('SELECT COUNT(*) AS n FROM work_messages_drafts WHERE workspace_id = ?').get(workspaceId) as { n: number }).n

/**
 * Tells every window the workspace's drafts moved. The push carries the
 * unread count too: the last one the watch heard, else LifeOS's now; with
 * neither, no push (the view asks `drafts` when it opens).
 */
export async function pushDrafts(ctx: WorkCtx, workspaceId: string, known: number | undefined): Promise<void> {
  let count = known
  if (count === undefined) {
    try {
      count = (await unread(ctx, workSector(ctx, workspaceId))).unread
    } catch (err) {
      ctx.log(`messages: no drafts push for ${workspaceId}: ${errorText(err)}`)
      return
    }
  }
  ctx.push({ push: 'work.messages', workspaceId, unread: count, drafts: draftCount(ctx, workspaceId) })
}

/** A thread's draft for a conversation with no way to send, kept for him to copy. */
export function saveDraft(ctx: WorkCtx, d: { workspaceId: string; chatId: string; sessionId: string | null; text: string }): string {
  const id = `md_${randomUUID()}`
  ctx.db.prepare('INSERT INTO work_messages_drafts (id, workspace_id, chat_id, session_id, text, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, d.workspaceId, d.chatId, d.sessionId, d.text, Date.now())
  return id
}

/** He copied a draft, or does not want it. Another workspace's id drops nothing. */
export function dropDraft(ctx: WorkCtx, by: Caller, p: { workspaceId: string; id: string }): boolean {
  mustBe(by, 'operate')
  workSector(ctx, p.workspaceId)
  return ctx.db.prepare('DELETE FROM work_messages_drafts WHERE id = ? AND workspace_id = ?').run(p.id, p.workspaceId).changes > 0
}

/** A deleted workspace takes its drafts with it. */
export function dropWorkspaceDrafts(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): void {
  ctx.db.prepare('DELETE FROM work_messages_drafts WHERE workspace_id = ?').run(workspaceId)
}
