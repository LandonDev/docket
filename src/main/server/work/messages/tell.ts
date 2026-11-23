import { firstWords, SOURCE_NAME, type ChatRow } from '@shared/work/messages'
import type { WorkCtx } from '../modules'

/**
 * Telling him of news (docs/agents/work-messages.md "The digest"). The
 * digest owns telling: this pillar only says a conversation now waits on
 * him (`ctx.tell`) and takes it back once it no longer does (`tell.done`),
 * by one key a conversation. It raises no toast, sound or badge itself.
 *
 * `tell` belongs to the digest's build, which is not on master yet: until
 * its `WorkCtx.tell` lands, the call is typed here and does nothing where
 * the context has none. Its `tells` entry on the module waits for it too.
 */

export interface ChatTell {
  kind: 'messages.new'
  workspaceId: string
  title: string
  detail?: string
  open: { view: 'messages'; workspaceId: string; at: string }
  key: string
}
export type Teller = ((t: ChatTell) => void) & { done(key: string): void }

/** The digest's `ctx.tell`, when this host's context has one. */
export const tellOf = (ctx: WorkCtx): Teller | undefined => (ctx as WorkCtx & { tell?: Teller }).tell

export const tellKey = (chatId: string): string => `messages:${chatId}`

/** "Dana Lee wrote in Slack"; in a channel or a group, where: "Dana Lee wrote in #builds". */
export function tellOfChat(workspaceId: string, row: ChatRow): ChatTell {
  const where = row.kind === 'direct' ? SOURCE_NAME[row.source] : row.name
  const detail = firstWords(row.lastText)
  return { kind: 'messages.new', workspaceId, title: `${row.lastWho || row.name} wrote in ${where}`, ...(detail ? { detail } : {}), open: { view: 'messages', workspaceId, at: row._id }, key: tellKey(row._id) }
}
