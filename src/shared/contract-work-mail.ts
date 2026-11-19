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

/** What the composer saved and he pressed Send on: the host refuses a row that says anything else. */
export const MailSeenSchema = z.object({
  to: z.array(z.string().max(320)).max(500),
  cc: z.array(z.string().max(320)).max(500),
  bcc: z.array(z.string().max(320)).max(500),
  subject: z.string().max(2_000),
  text: z.string().max(2_000_000)
})
export type MailSeen = z.infer<typeof MailSeenSchema>

export const MailRequestSchemas = [
  /**
   * → { id, via }: sends the `outbox` row as LifeOS holds it now, only if it still says what the
   * composer saved (`seen`: who it goes to, the subject and the words). `sendAt` schedules the
   * owner's own mail; a held draft goes now or not at all.
   */
  request('work.mail.send', z.object({ id: z.string().min(1).max(64), sendAt: z.number().int().positive().optional(), seen: MailSeenSchema }))
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
