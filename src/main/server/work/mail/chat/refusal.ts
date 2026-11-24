import { lifeosAllowed, MAIL_CHAT_POWERS, MAIL_CHAT_REFUSAL, workAllowed } from '@shared/work/mailChat'
import type { CallAsk, WorkCtx } from '../../modules'
import { mailChatHere, mailChatOf } from './find'

/**
 * The narrowing of a mail chat (docs/agents/work-mail.md "The chat beside the
 * mail"): it reads, and writes drafts, and nothing else. Every other call is
 * refused with words the model reads, which send it to `mail_offer`.
 */

/** A mail chat's draft_mail with a draft_id: changing a draft is a proposal he takes or leaves. */
export const REWRITE_REFUSAL = 'In a mail chat draft_mail writes a new draft only. To change a draft, use update_mail_draft and offer it with mail_offer {rewrite}: he takes it or leaves it.'

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
  // A draft is written new: LifeOS lets a key rewrite any draft it made, another thread's and one he edited since among them.
  if (call.server === 'lifeos' && call.tool === 'draft_mail' && call.args?.draft_id != null) return REWRITE_REFUSAL
  return call.server === 'lifeos' && lifeosAllowed(call.tool) ? null : refusalWords(call.tool)
}

/** `WorkModule.harnessDenied`: a mail chat's harness has no shell, no file writes and no web. */
export function chatHarnessDenied(sessionId: string): string[] {
  if (!MAIL_CHAT_POWERS.narrow || !mailChatHere(sessionId)) return []
  return [...MAIL_CHAT_POWERS.harness]
}
