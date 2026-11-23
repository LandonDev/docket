import type { SectorKey } from './ids'

/**
 * The messages pillar's names and pure rules (docs/agents/work-messages.md).
 * LifeOS holds his chat; this file names what it answers and the few rules
 * the host and the window share. No zod here: the wire is
 * `contract-work-messages.ts`.
 */

/** The sources that are chat. Mail's (`email`) and the rest never make a conversation. */
export const CHAT_SOURCES = ['slack', 'discord', 'imessage', 'teams'] as const
export type ChatSource = (typeof CHAT_SOURCES)[number]
export const isChatSource = (kind: string): kind is ChatSource => (CHAT_SOURCES as readonly string[]).includes(kind)

/** What a source is called in a sentence: "Sent to Dana Lee in Slack", "Discord last synced Nov 3". */
export const SOURCE_NAME: Record<ChatSource, string> = { slack: 'Slack', discord: 'Discord', imessage: 'iMessage', teams: 'Teams' }
/** The app a conversation opens in: "Open in Messages". */
export const SOURCE_APP: Record<ChatSource, string> = { slack: 'Slack', discord: 'Discord', imessage: 'Messages', teams: 'Teams' }

/**
 * How a reply to each source leaves this app. `lifeos`: LifeOS sends it (and
 * still says no when it cannot: its `route`). `copy`: nothing here can send,
 * so the composer offers Copy. Teams turns to the browser pillar's post by
 * one edit of its row once that post is proven from the box.
 */
export const CHAT_ROUTES: Record<ChatSource, 'lifeos' | 'copy'> = { slack: 'lifeos', imessage: 'lifeos', discord: 'copy', teams: 'copy' }

/** His own typed reply goes on his press. True holds it in the Outbox as an agent's draft is held. */
export const OWN_REPLY_HELD = false

/** The sectors whose chat a Work thread may read with `messages_read`. Take one out to keep its chat from agents. */
export const AGENT_CHAT_SECTORS: readonly SectorKey[] = ['cosmic', 'hypixel', 'purdue', 'ref', 'unify', 'life']

/** The longest a reply may be: LifeOS's own limit. */
export const CHAT_REPLY_MAX = 4000

/** A writer's face in a list row: LifeOS's name and its stored picture's address, when it has one. */
export interface ChatFace {
  name: string
  picture?: string
}

export type ChatKind = 'direct' | 'group' | 'channel'

/** One conversation, as `chats:list` and `chats:get` answer it. */
export interface ChatRow {
  _id: string
  source: ChatSource
  account: string
  accountName?: string
  channel: string
  /** "#builds", "Dana Lee", "Dana, Omar" */
  name: string
  kind: ChatKind
  sector: SectorKey
  lastAt: number
  /** the newest words, cut at 200 */
  lastText: string
  lastWho: string
  lastFromMe: boolean
  /** the newest message from someone else */
  lastInAt?: number
  /** the newest from someone else written to him: a direct message, a mention or a reply to him */
  lastForMeAt?: number
  /** his own newest */
  lastOutAt?: number
  readAt?: number
  /** the service's own read mark, where it gives one (Slack) */
  sourceReadAt?: number
  /** the message a reply answers */
  lastInId?: string
  unread: boolean
  faces: ChatFace[]
  /** where the conversation opens in its own app */
  link?: string
}

/** Whether a reply can go, as LifeOS judges it; `why` is LifeOS's sentence. */
export type ChatRoute = { can: true } | { can: false; why: string }

/** A source's sync state, as `sources:list` and `chats:get` answer it. */
export interface ChatSourceState {
  kind: ChatSource
  label: string
  status: 'idle' | 'ok' | 'error'
  lastSyncAt?: number
  reportedAt?: number
  error?: string
}

/** `chats:get`: the conversation, its source, whether a reply can go, and the other person's address for People. */
export interface ChatDetail {
  chat: ChatRow
  source: ChatSourceState | null
  route: ChatRoute
  /** a direct chat's other person, when LifeOS knows an address for them */
  email?: string
  /** where the conversation opens in its own app */
  link?: string
}

export interface ChatWho {
  name: string
  me: boolean
  personId?: string
  email?: string
  picture?: string
}

export type ChatFileStatus = 'listed' | 'wanted' | 'stored' | 'failed'

/** A picture or file of a message. `url` is LifeOS's own storage address, present once it is stored. */
export interface ChatFile {
  _id: string
  name: string
  contentType?: string
  size?: number
  width?: number
  height?: number
  status: ChatFileStatus
  url?: string
  error?: string
}

/** His reply as LifeOS's outbox holds it: inside its undo time, on its way, sent or failed. */
export interface ChatReplyState {
  outboxId: string
  status: 'queued' | 'sending' | 'sent' | 'failed'
  sendAt?: number
  error?: string
}

/** One message, as `chats:messages` answers it, newest first. A queued or failed reply of his rides in as his own row. */
export interface ChatMessage {
  _id: string
  who: ChatWho
  text: string
  sentAt: number
  editedAt?: number
  permalink?: string
  /** what a Slack thread reply answers: the writer and its first words */
  replyTo?: { who: string; text: string }
  files: ChatFile[]
  reply?: ChatReplyState
}

/** A search hit, for the view's field and the one search. */
export interface ChatHit {
  chatId: string
  messageId: string
  /** the conversation's name */
  chat: string
  who: string
  text: string
  at: number
  source: ChatSource
}

/** A conversation waiting on his answer, for Today. */
export interface ChatWaiting {
  chatId: string
  chat: string
  who: string
  text: string
  at: number
  source: ChatSource
}

/** A thread's draft for a conversation nothing here can send to: he copies it. */
export interface ChatDraft {
  id: string
  chatId: string
  sessionId: string | null
  /** the thread's title, when the host still holds it */
  thread?: string
  text: string
  at: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * How long a source may be silent before the view says so. The box's
 * readers check in each minute; a desktop sleeps at night.
 */
export const CHAT_SILENT_MS: Record<ChatSource, number> = { slack: 15 * MINUTE, discord: 15 * MINUTE, imessage: 36 * HOUR, teams: 36 * HOUR }

/** When a source last checked in or synced: the newer of the two. */
export const lastHeard = (source: Pick<ChatSourceState, 'lastSyncAt' | 'reportedAt'>): number | undefined => {
  const at = Math.max(source.lastSyncAt ?? 0, source.reportedAt ?? 0)
  return at > 0 ? at : undefined
}

/**
 * Whether a source is stale: in error, or silent past its limit. The one
 * rule the view's sync line and Connections' row share. A source that never
 * synced is stale too: nothing has come from it.
 */
export function staleOf(source: Pick<ChatSourceState, 'kind' | 'status' | 'lastSyncAt' | 'reportedAt'>, now: number): boolean {
  if (source.status === 'error') return true
  const heard = lastHeard(source)
  return heard === undefined || now - heard > CHAT_SILENT_MS[source.kind]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Nov 3" for another day, "2:02 PM" for today: when a source was last heard from. */
export function syncWhen(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    const h = d.getHours()
    return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/**
 * A service's rows as one: in error when any is, else as fresh as its
 * freshest. A channel's own row that never synced does not make a workspace
 * that is reading stale; a service whose every row is silent is.
 */
export function serviceState(sources: readonly ChatSourceState[], kind: ChatSource, now: number): { stale: boolean; heard?: number } | null {
  const rows = sources.filter((source) => source.kind === kind)
  if (rows.length === 0) return null
  const heard = rows.reduce<number | undefined>((best, row) => {
    const at = lastHeard(row)
    return at === undefined ? best : best === undefined ? at : Math.max(best, at)
  }, undefined)
  const stale = rows.some((row) => row.status === 'error') || heard === undefined || now - heard > CHAT_SILENT_MS[kind]
  return { stale, ...(heard !== undefined ? { heard } : {}) }
}

/**
 * The sync line: one sentence naming each stale service of the job once, or
 * null when all are fresh. "Discord last synced Nov 3", "Discord last synced
 * Nov 3, iMessage Nov 16", "Teams has not synced".
 */
export function syncLine(sources: readonly ChatSourceState[], now: number): string | null {
  const parts: string[] = []
  let said = false
  for (const kind of CHAT_SOURCES) {
    const state = serviceState(sources, kind, now)
    if (!state?.stale) continue
    if (state.heard === undefined) parts.push(`${SOURCE_NAME[kind]} has not synced`)
    else if (!said) {
      parts.push(`${SOURCE_NAME[kind]} last synced ${syncWhen(state.heard, now)}`)
      said = true
    } else parts.push(`${SOURCE_NAME[kind]} ${syncWhen(state.heard, now)}`)
  }
  return parts.length > 0 ? parts.join(', ') : null
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A message's words less the names LifeOS's readers folded into them, once
 * its files are listed beside it: Slack's `[file: name]`, Discord's
 * `name https://cdn…` line, and iMessage's "Sent an attachment: a, b" when
 * that is all the message says. Words he or anyone wrote are never cut.
 */
export function fileMarkers(text: string, files: readonly Pick<ChatFile, 'name'>[]): string {
  if (files.length === 0) return text
  let out = text
  for (const { name } of files) {
    if (!name) continue
    const n = escapeRe(name)
    out = out.replace(new RegExp(`[ \\t]*\\[file: ${n}\\]`, 'g'), '')
    out = out.replace(new RegExp(`(^|\\n)${n} https?://\\S+(?=\\n|$)`, 'g'), '$1')
  }
  // The line goes only when every name it gives is listed beside the message.
  const listed = new Set(files.map((f) => f.name))
  out = out.replace(/^Sent an attachment: (.*)$/m, (line, names: string) => (names.split(', ').every((name) => listed.has(name)) ? '' : line))
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** The words a held reply and its Sent record lead with: "Reply in Slack to Dana Lee". */
export const replyWhere = (source: ChatSource, chat: string): string => `Reply in ${SOURCE_NAME[source]} to ${chat}`

/** The first words of a text, for a summary or a quote: cut at a word, with an ellipsis. */
export function firstWords(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}
