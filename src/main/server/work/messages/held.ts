import { z } from 'zod'
import { CHAT_REPLY_MAX, CHAT_ROUTES, CHAT_SOURCES, firstWords, replyWhere, SOURCE_NAME, type ChatDetail, type ChatSource } from '@shared/work/messages'
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
export const NEW_SINCE = 'A new message came in after this reply was drafted, and the reply names no message it answers. Nothing was sent: draft it again.'

/**
 * The message a Slack reply answers, fixed when it is held: the one named, else the conversation's newest from someone
 * else as it stands now. Slack threads a reply under it, so a message that comes in before his press must not take its
 * place: what the Outbox quotes is what it answers. Other sources do not thread, and get only what was named.
 */
export function pinnedReplyTo(source: ChatSource, named: string | undefined, chat: Pick<ChatDetail['chat'], 'lastInId'>): string | undefined {
  return named ?? (source === 'slack' ? chat.lastInId : undefined)
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
    // A Slack reply held before its parent was fixed (pinnedReplyTo) goes under LifeOS's newest from someone else: once a
    // message has come in since it was held, that is no longer the one it was drafted for, nor the one he may have read.
    if (source === 'slack' && !p.replyTo && (got.chat.lastInAt ?? 0) > act.item.createdAt) throw new ActStale(NEW_SINCE)
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
