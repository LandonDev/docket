import { z } from 'zod'
import { CHAT_REPLY_MAX, CHAT_ROUTES, CHAT_SOURCES, firstWords, replyWhere, SOURCE_NAME, type ChatDetail, type ChatMessage, type ChatSource } from '@shared/work/messages'
import type { LifeosClient } from '../lifeos/ctx'
import type { ActKindDef } from '../modules'
import { ActNotSent, ActStale } from '../outbox/kinds'
import { isRefusal, refusalWords } from './lifeos'

/**
 * A chat reply held for his press (docs/agents/work-messages.md "The hold"):
 * what a thread drafts with `messages_draft_reply`, and his own typed reply
 * when `OWN_REPLY_HELD` is on. On the press the host reads the conversation
 * again as the owner and asks LifeOS to send; LifeOS's own queue, undo time
 * and refusals apply. Nothing here sends anything else.
 */

const id = z.string().trim().min(1).max(64)

export const ChatReplySchema = z.object({
  chatId: id,
  /** the message it answers (a Slack thread); absent: the conversation's newest from someone else */
  replyTo: id.optional(),
  source: z.enum(CHAT_SOURCES),
  /** the conversation's name, as the summary says it */
  chat: z.string().trim().min(1).max(200),
  /** whom it answers, when that is not the conversation's name */
  to: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(CHAT_REPLY_MAX)
})
export type ChatReply = z.infer<typeof ChatReplySchema>

export const CHAT_GONE = 'This conversation is no longer in LifeOS, or it moved to another job. Nothing was sent.'
export const NO_PARENT = 'This Slack reply names no message it answers, so LifeOS could put it under a newer one. Nothing was sent: draft it again.'
export const PARENT_UNREAD = 'LifeOS did not answer with the conversation, so the message this reply answers cannot be fixed. Nothing was held: try again.'

/**
 * The message a Slack reply answers, fixed when it is held, by the rule the Outbox's quote reads (ChatReplyAct.tsx
 * `answeredOf`): the one named; else the conversation's newest from someone else as it stands now; else, a conversation
 * of only his own words, his newest stored message on the newest page (a row still carrying `reply` is an outgoing reply,
 * not a stored message). Slack threads a reply under it, so a message that comes in before his press, his own included,
 * must not take its place. A Slack reply is never held without one: a page that cannot be read, or one with no stored
 * message, throws (`PARENT_UNREAD`, `NO_PARENT`) and nothing is held. Other sources do not thread, and get only what was
 * named.
 */
export async function pinnedReplyTo(owner: Pick<LifeosClient, 'query'>, source: ChatSource, named: string | undefined, chat: Pick<ChatDetail['chat'], '_id' | 'lastInId'>): Promise<string | undefined> {
  if (named || source !== 'slack') return named
  if (chat.lastInId) return chat.lastInId
  const page = await owner.query<{ page: ChatMessage[] } | null>('chats:messages', { chatId: chat._id, paginationOpts: { numItems: 50, cursor: null } }).catch(() => {
    throw new Error(PARENT_UNREAD)
  })
  const mine = page?.page?.find((m) => m.who.me && !m.reply)?._id
  if (!mine) throw new Error(NO_PARENT)
  return mine
}

export const chatReplyKind: ActKindDef<ChatReply, never> = {
  kind: 'chat.reply',
  store: 'host',
  payload: ChatReplySchema,
  // No matcher: a chat reply takes no grant, so every one waits for his press. To let him stop holding replies to
  // one conversation, add `matcher: z.object({ chatId: id })` and `matches: (m, p) => m.chatId === p.chatId` here.
  words: (p) => ({ summary: `${replyWhere(p.source, p.to ?? p.chat)}: “${firstWords(p.text)}”`, verb: 'Send' }),
  // An edit in the Outbox may change the words alone: where it goes and what it answers stay as held.
  keep: (old, next) => ({ ...old, text: next.text }),
  async execute(p, act) {
    const owner = act.lifeos.owner()
    // A read that fails sent nothing: a plain press may try again.
    const got = await owner.query<ChatDetail | null>('chats:get', { id: p.chatId }).catch((err: unknown) => {
      throw new ActNotSent(`LifeOS did not answer: ${refusalWords(err)}`)
    })
    // His own held reply has no thread, so no sector: he chose the conversation in its workspace when he pressed Send.
    if (!got?.chat || (act.item.sector !== null && got.chat.sector !== act.item.sector)) throw new ActStale(CHAT_GONE)
    const source = got.chat.source
    if (CHAT_ROUTES[source] !== 'lifeos') throw new ActNotSent(got.route?.can === false ? got.route.why : `LifeOS can't reply in ${SOURCE_NAME[source]} yet`)
    if (got.route?.can === false) throw new ActNotSent(got.route.why)
    // A Slack reply goes only under the message fixed when it was held (pinnedReplyTo). One with none (held before the pin)
    // would go under whatever LifeOS finds newest at its send, which a message arriving after this read could change: it
    // is stale, never sent.
    if (source === 'slack' && !p.replyTo) throw new ActStale(NO_PARENT)
    let outboxId: string
    try {
      outboxId = await owner.mutation<string>('chats:reply', { chatId: p.chatId, ...(p.replyTo ? { replyTo: p.replyTo } : {}), text: p.text })
    } catch (err) {
      // LifeOS said no in its own words, and queued nothing. Any other fault may or may not have reached it.
      if (isRefusal(err)) throw new ActNotSent(refusalWords(err))
      throw err
    }
    return { summary: `Sent to ${got.chat.name} in ${SOURCE_NAME[source]}`, ref: { at: 'lifeos', table: 'outbox', id: outboxId } }
  },
  wayBack: () => null
}
