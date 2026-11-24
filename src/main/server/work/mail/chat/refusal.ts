import { lifeosAllowed, MAIL_CHAT_POWERS, MAIL_CHAT_REFUSAL, workAllowed } from '@shared/work/mailChat'
import type { CallAsk, WorkCtx } from '../../modules'
import { mailChatHere, mailChatOf } from './find'

/**
 * The narrowing of a mail chat (docs/agents/work-mail.md "The chat beside the
 * mail"): it reads, and writes drafts, and nothing else. Every other call is
 * refused with words the model reads, which send it to `mail_offer`.
 */

/** What the model reads in place of a refused call's answer. */
export const refusalWords = (tool: string): string => `${tool} is not available in a mail chat. ${MAIL_CHAT_REFUSAL}`

/**
 * `WorkModule.callRefusal` for a mail chat and every thread under it. LifeOS
 * tools pass by the allow-list, Work tools by name, and any other add-on's
 * tool not at all: none of them is on the list.
 */
export function chatCallRefusal(ctx: Pick<WorkCtx, 'db'>, call: CallAsk): string | null {
  if (!MAIL_CHAT_POWERS.narrow) return null
  if (!mailChatOf(ctx.db, call.sessionId)) return null
  if (call.via === 'work') return workAllowed(call.tool) ? null : refusalWords(call.tool)
  return call.server === 'lifeos' && lifeosAllowed(call.tool) ? null : refusalWords(call.tool)
}

/** `WorkModule.harnessDenied`: a mail chat's harness has no shell, no file writes and no web. */
export function chatHarnessDenied(sessionId: string): string[] {
  if (!MAIL_CHAT_POWERS.narrow || !mailChatHere(sessionId)) return []
  return [...MAIL_CHAT_POWERS.harness]
}
