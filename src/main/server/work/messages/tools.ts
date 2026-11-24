import { z } from 'zod'
import { errorText, workText, type SectorKey, type WorkScope } from '@shared/work'
import { AGENT_CHAT_SECTORS, CHAT_REPLY_MAX, CHAT_ROUTES, fileMarkers, firstWords, SOURCE_NAME, type ChatHit, type ChatMessage, type ChatRow } from '@shared/work/messages'
import type { ToolCtx, WorkTool } from '../modules'
import { ChatReplySchema, pinnedReplyTo } from './held'
import { chatIn, linkedWorkspaces } from './lifeos'
import { pushDrafts, saveDraft } from './replies'
import { watchOf } from './watch'
import { zoneOf } from '../clashes/zone'

/**
 * A Work thread's two chat tools (docs/agents/work-messages.md "Threads"):
 * `messages_read` reads its sector's conversations as the owner, marks
 * nothing read and refuses another sector's whatever LifeOS answered;
 * `messages_draft_reply` holds a reply for his press, or, where nothing
 * here can send, keeps it as a draft he copies. A thread never sends chat.
 */

export const PREAMBLE = 'Chat: read this job\'s conversations with messages_read. To answer one, use messages_draft_reply: the reply waits for the owner\'s press. You never send chat.'

/** Whether a thread of this scope reads chat: one with a sector the owner left in `AGENT_CHAT_SECTORS`. */
export const readsChat = (scope: Pick<WorkScope, 'sector'>): scope is { sector: SectorKey } => !!scope.sector && AGENT_CHAT_SECTORS.includes(scope.sector)

const failed = (text: string) => ({ ...workText(text), isError: true as const })
const notHere = (chat: string) => failed(`No conversation ${chat} in this job's chat. Read the list with messages_read.`)

/** A time in his zone, named, so a thread on a host in another zone never reads his day an hour off. */
const whenIn =
  (timeZone: string) =>
  (at: number): string =>
    new Date(at).toLocaleString('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
type When = ReturnType<typeof whenIn>

/** One conversation as a line of the list. */
const chatLine = (when: When) => (c: ChatRow): string =>
  `- ${c.name} (${SOURCE_NAME[c.source]}${c.accountName ? `, ${c.accountName}` : ''}${c.unread ? ', unread' : ''}), ${when(c.lastAt)}: ${c.lastFromMe ? 'You' : c.lastWho}: “${firstWords(c.lastText, 120)}”; conversation ${c._id}`

/** One message as a plain line: when, who, the words, what it answers, its files and its id (what `reply_to` takes). */
const messageLine = (when: When) => (m: ChatMessage): string => {
  const words = fileMarkers(m.text, m.files ?? [])
  const answers = m.replyTo ? ` (replying to ${m.replyTo.who}: “${firstWords(m.replyTo.text)}”)` : ''
  const files = m.files?.length ? ` [files: ${m.files.map((f) => f.name).join(', ')}]` : ''
  const reply = m.reply ? ` (${m.reply.status === 'failed' ? `not sent${m.reply.error ? `: ${m.reply.error}` : ''}` : m.reply.status})` : ''
  return `[${when(m.sentAt)}] ${m.who.me ? 'You' : m.who.name}${answers}: ${words || '(no words)'}${files}${reply}; message ${m._id}`
}

const hitLine = (when: When) => (h: ChatHit): string => `- ${h.chat} (${SOURCE_NAME[h.source]}), ${when(h.at)}, ${h.who}: “${firstWords(h.text, 160)}”; conversation ${h.chatId}, message ${h.messageId}`

const ReadInput = z.object({
  chat: z.string().trim().min(1).max(64).optional().describe("a conversation's id, from the list: its messages"),
  query: z.string().trim().min(1).max(200).optional().describe("words to find in this job's messages"),
  before: z.string().min(1).max(500).optional().describe('the cursor a longer answer gave, for the page after it'),
  limit: z.number().int().min(1).max(100).optional()
})

export const readTool: WorkTool = {
  name: 'messages_read',
  description:
    "Read this job's chat (Slack, Discord, iMessage, Teams) as LifeOS holds it. With nothing: its conversations, newest first, each with its id. With `chat`: that conversation's messages, oldest to newest. With `query`: the messages that hold the words. Read only: it marks nothing read.",
  input: ReadInput,
  readOnly: true,
  async run(args, ctx) {
    const { chat, query, before, limit } = args as z.infer<typeof ReadInput>
    if (!readsChat(ctx.scope)) return failed("This thread's job has no chat it may read.")
    const sector = ctx.scope.sector
    if (!ctx.lifeos.connected()) return failed('LifeOS is not connected.')
    const owner = ctx.lifeos.owner()
    try {
      const when = whenIn(await zoneOf(ctx))
      if (chat) {
        const got = await chatIn(ctx, chat, sector)
        if (!got) return notHere(chat)
        const page = await owner.query<{ page: ChatMessage[]; isDone: boolean; continueCursor: string }>('chats:messages', { chatId: chat, paginationOpts: { numItems: limit ?? 50, cursor: before ?? null } })
        const lines = [...(page?.page ?? [])].reverse().map(messageLine(when))
        const head = `${got.chat.name} in ${SOURCE_NAME[got.chat.source]}${got.chat.accountName ? `, ${got.chat.accountName}` : ''} (conversation ${got.chat._id}), oldest to newest; a message's id is what reply_to takes:`
        const more = page && !page.isDone ? `\nOlder messages: messages_read with chat ${chat} and before "${page.continueCursor}".` : ''
        return workText(lines.length ? `${head}\n${lines.join('\n')}${more}` : `${got.chat.name} in ${SOURCE_NAME[got.chat.source]} has no messages LifeOS holds.`)
      }
      if (query) {
        const hits = (await owner.query<(ChatHit & { sector?: string })[]>('chats:search', { sector, text: query, limit: limit ?? 20 })) ?? []
        const mine = hits.filter((h) => h.sector === sector)
        return workText(mine.length ? [`Messages that hold “${query}”, newest first:`, ...mine.map(hitLine(when))].join('\n') : `No message in this job's chat holds “${query}”.`)
      }
      const page = await owner.query<{ page: ChatRow[]; isDone: boolean; continueCursor: string }>('chats:list', { sector, filter: 'all', paginationOpts: { numItems: limit ?? 30, cursor: before ?? null } })
      const rows = (page?.page ?? []).filter((c) => c.sector === sector)
      const more = page && !page.isDone ? `\nMore: messages_read with before "${page.continueCursor}".` : ''
      return workText(rows.length ? `${['Conversations, newest first:', ...rows.map(chatLine(when))].join('\n')}${more}` : "This job's chat has no conversations.")
    } catch (err) {
      return failed(`LifeOS did not answer: ${errorText(err)}`)
    }
  }
}

const DraftInput = z.object({
  chat: z.string().trim().min(1).max(64).describe("the conversation's id, from messages_read"),
  text: z.string().trim().min(1).max(CHAT_REPLY_MAX).describe('the reply, exactly as it should go'),
  reply_to: z.string().trim().min(1).max(64).optional().describe("the message it answers (a Slack thread); absent: the conversation's newest")
})

/** The Work workspace a thread's draft is kept in: its own, else this host's workspace of its sector. */
const draftHome = (ctx: ToolCtx, sector: SectorKey): string | null => ctx.scope.workspaceId ?? linkedWorkspaces(ctx).find((w) => w.sector === sector)?.id ?? null

export const draftTool: WorkTool = {
  name: 'messages_draft_reply',
  description:
    "Answer a conversation of this job's chat. The reply is held: nothing is sent until the owner presses Send. Where nothing here can send (Discord, Teams) it is kept as a draft in the conversation for him to copy. Never send chat any other way.",
  input: DraftInput,
  readOnly: false,
  async run(args, ctx) {
    const { chat, text, reply_to } = args as z.infer<typeof DraftInput>
    if (!readsChat(ctx.scope)) return failed("This thread's job has no chat it may answer.")
    const sector = ctx.scope.sector
    if (!ctx.lifeos.connected()) return failed('LifeOS is not connected.')
    let got
    try {
      got = await chatIn(ctx, chat, sector)
    } catch (err) {
      return failed(`LifeOS did not answer: ${errorText(err)}`)
    }
    if (!got) return notHere(chat)
    const source = got.chat.source
    // A route is the source's, not LifeOS's word now: a Mac asleep now may be awake at his press, which reads it again.
    if (CHAT_ROUTES[source] === 'lifeos') {
      const replyTo = pinnedReplyTo(source, reply_to, got.chat)
      const payload = ChatReplySchema.parse({ chatId: got.chat._id, ...(replyTo ? { replyTo } : {}), source, chat: got.chat.name, text })
      const item = ctx.held.create({ kind: 'chat.reply', sessionId: ctx.sessionId, payload })
      return workText(`Held: ${item.summary}. It waits for the owner's press; nothing is sent until then. This is a finished step, not a failure: carry on.`)
    }
    const workspaceId = draftHome(ctx, sector)
    if (!workspaceId) return failed(`Nothing can send to ${SOURCE_NAME[source]} from here, and this job has no workspace on this host to keep a draft in. Give him the text in your reply.`)
    saveDraft(ctx, { workspaceId, chatId: got.chat._id, sessionId: ctx.sessionId, text })
    await pushDrafts(ctx, workspaceId, watchOf(ctx)?.unreadOf(workspaceId))
    return workText(`Saved as a draft in the conversation: nothing can send to ${SOURCE_NAME[source]} from here, the owner will copy it.`)
  }
}

export const messagesTools = (scope: WorkScope): WorkTool[] => (readsChat(scope) ? [readTool, draftTool] : [])
