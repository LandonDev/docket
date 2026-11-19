import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The mail pillar's wire (docs/agents/work-mail.md). Its methods are
 * `work.mail.<verb>`; src/shared/work/wire.ts has the helpers and the rules.
 *
 * TempCode's composer never sends through LifeOS itself: its Send saves the
 * draft and then asks the host, which carries out the press as the owner.
 * A draft one of this host's threads made goes through the hold
 * (`work.outbox.send`, so the claim, the linked task and the record are the
 * hold's); the owner's own mail goes as his `compose.send`. Either way the
 * HTML is cleaned by the outgoing rules first.
 */
export const MailRequestSchemas = [
  /** → { id, via }: sends the `outbox` row as LifeOS holds it now. `sendAt` schedules the owner's own mail; a held draft goes now or not at all. */
  request('work.mail.send', z.object({ id: z.string().min(1).max(64), sendAt: z.number().int().positive().optional() }))
] as const

/** How a send went: through the hold (a thread's draft) or as the owner's own mail. */
export interface MailSendAnswer {
  id: string
  via: 'hold' | 'owner'
}

export type MailPush = never

export const MAIL_CAPS = {
  'work.mail.send': 'approve'
} satisfies CapsOf<typeof MailRequestSchemas>
export const MAIL_RELAY = {} satisfies RelayOf<typeof MailRequestSchemas>
