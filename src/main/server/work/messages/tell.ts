import { firstWords, SOURCE_NAME, type ChatRow } from '@shared/work/messages'
import type { Tell, TellKind } from '@shared/work/tell'
import type { WorkCtx } from '../modules'

/**
 * Telling him of news (docs/agents/work-messages.md "The digest"). The
 * digest owns telling: this pillar only says a conversation now waits on
 * him (`ctx.tell`) and takes it back once it no longer does (`tell.done`),
 * by one key a conversation. It raises no toast, sound or badge itself.
 *
 * The digest's rule decides whether a tell interrupts or waits for the
 * day's one notice; this pillar never says `by`.
 */

/** The one kind this pillar tells, listed on the module's `tells`. */
export const CHAT_TELLS: TellKind[] = [{ kind: 'messages.new', group: 'people', name: 'New messages' }]

/** The digest's `ctx.tell`; a context made without one (an older test rig) tells nothing. */
export const tellOf = (ctx: WorkCtx): WorkCtx['tell'] | undefined => (ctx as Partial<Pick<WorkCtx, 'tell'>>).tell

export const tellKey = (chatId: string): string => `messages:${chatId}`

/** "Dana Lee wrote in Slack"; in a channel or a group, where: "Dana Lee wrote in #builds". */
export function tellOfChat(workspaceId: string, row: ChatRow): Tell {
  const where = row.kind === 'direct' ? SOURCE_NAME[row.source] : row.name
  const detail = firstWords(row.lastText)
  return { kind: 'messages.new', workspaceId, title: `${row.lastWho || row.name} wrote in ${where}`, ...(detail ? { detail } : {}), open: { view: 'messages', workspaceId, at: row._id }, key: tellKey(row._id) }
}
