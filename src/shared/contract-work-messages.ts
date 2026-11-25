import { z } from 'zod'
import type { ChatDraft, ChatHit, ChatWaiting } from './work/messages'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The messages pillar's wire (docs/agents/work-messages.md). Its methods are
 * `work.messages.<verb>`; src/shared/work/wire.ts has the helpers and the rules.
 *
 * The window reads conversations straight from LifeOS on its own sector
 * session and writes only the read mark there. Every send goes through the
 * host, which acts as the owner and fences each call to the workspace's
 * sector by hand.
 */

const id = z.string().min(1).max(64)
const workspaceId = id
/** The phone's key for one press of his Send: a repeat of it is answered as the first was, never sent again. */
const attempt = z.string().min(8).max(64)

export const MessagesRequestSchemas = [
  /**
   * → { id }: his own reply, typed and sent by his press: LifeOS queues it for its undo time. `replyTo` names the
   * message it answers (a Slack thread); without it the reply answers the conversation's newest message from
   * someone else. A thread's call is refused: an agent's reply is `messages_draft_reply`, which is held. `attempt`
   * (the phone's) makes the host answer a repeat of the key with the first answer for a day, never sending again.
   */
  request('work.messages.send', z.object({ workspaceId, chatId: id, replyTo: id.optional(), text: z.string().min(1).max(4000), attempt: attempt.optional() })),
  /**
   * → MessagesAttemptAnswer: what became of a Send named by its `attempt` key, read without sending anything (the
   * phone's read-back of a press whose answer was lost). `none`: this host never heard the key for this job.
   */
  request('work.messages.attempt', z.object({ workspaceId, attempt })),
  /**
   * → { text }: takes back a reply still inside its undo time, and answers its words. `chatId` is the conversation it
   * is in: the host checks it is the workspace's and that the reply is one of its own before LifeOS hears of it.
   */
  request('work.messages.undo', z.object({ workspaceId, chatId: id, id })),
  /** → {}: sends a failed reply again; `chatId` as for `undo`. */
  request('work.messages.retry', z.object({ workspaceId, chatId: id, id })),
  /** → { hits: ChatHit[] }: this job's messages that hold the words, newest first. */
  request('work.messages.search', z.object({ workspaceId, query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).optional() })),
  /** → { rows: ChatWaiting[] }: conversations whose newest message is someone else's, written to him, unread and unanswered. */
  request('work.messages.unanswered', z.object({ workspaceId })),
  /** → MessagesUnread */
  request('work.messages.unread', z.object({ workspaceId })),
  /** → { drafts: ChatDraft[] }: threads' drafts for conversations nothing here can send to; one conversation's, or the workspace's. */
  request('work.messages.drafts', z.object({ workspaceId, chatId: id.optional() })),
  /** → {}: drops one such draft: he copied it, or does not want it. */
  request('work.messages.dropDraft', z.object({ workspaceId, id }))
] as const

export interface MessagesSendAnswer {
  /** LifeOS's outbox row: what `undo` and `retry` name */
  id: string
}
/** What became of a Send by its attempt key: sent (LifeOS's outbox row), refused or may have gone in the host's words. */
export interface MessagesAttemptAnswer {
  state: 'none' | 'sending' | 'sent' | 'refused' | 'unknown'
  /** the reply's outbox row, when sent */
  id?: string
  /** the host's words, when refused or unknown */
  words?: string
}
export interface MessagesSearchAnswer {
  hits: ChatHit[]
}
export interface MessagesUnansweredAnswer {
  rows: ChatWaiting[]
}
export interface MessagesUnread {
  unread: number
  /** when the newest unread message was written */
  newest?: number
}
export interface MessagesDraftsAnswer {
  drafts: ChatDraft[]
}

/** A workspace's unread count moved, or a thread's draft came or went (`drafts` is how many copy-only drafts wait). */
export type MessagesPush = { push: 'work.messages'; workspaceId: string; unread: number; drafts?: number }

export const MESSAGES_CAPS = {
  'work.messages.send': 'approve',
  'work.messages.undo': 'approve',
  'work.messages.retry': 'approve',
  'work.messages.attempt': 'approve',
  'work.messages.search': 'read',
  'work.messages.unanswered': 'read',
  'work.messages.unread': 'read',
  'work.messages.drafts': 'read',
  'work.messages.dropDraft': 'operate'
} satisfies CapsOf<typeof MessagesRequestSchemas>
export const MESSAGES_RELAY = {} satisfies RelayOf<typeof MessagesRequestSchemas>
