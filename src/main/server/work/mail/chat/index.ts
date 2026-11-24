import type { ClientRequest } from '@shared/contract'
import { handled, NOT_HANDLED, type Handled } from '@shared/work'
import type { Caller, WorkCtx } from '../../modules'
import { adoptChat } from './adopt'
import { findChats } from './find'

/**
 * The chat beside the mail, on the host (docs/agents/work-mail.md "The chat
 * beside the mail"): a Work thread his window marks as a mail chat before its
 * first message. It reads mail and writes drafts; every other change comes
 * back as a `mail_offer` card for his press. The mail module mounts each part
 * (mail/index.ts).
 */

export { ensureChatTables, dropChats } from './find'
export { chatCallRefusal, chatHarnessDenied } from './refusal'
export { chatPreambleOf } from './preamble'
export { offerTool } from './offer'

/** `work.mail.chat.*`, or unhandled. */
export async function handleChat(req: ClientRequest, ctx: WorkCtx, by: Caller): Promise<Handled> {
  switch (req.method) {
    case 'work.mail.chat.adopt': {
      const { workspaceId, sessionId, kind, mailThreadId } = req.params
      return handled(await adoptChat(ctx, by, { workspaceId, sessionId, kind, ...(mailThreadId ? { mailThreadId } : {}) }))
    }
    case 'work.mail.chat.find':
      return handled(findChats(ctx, req.params.workspaceId, req.params.mailThreadId))
    default:
      return NOT_HANDLED
  }
}
