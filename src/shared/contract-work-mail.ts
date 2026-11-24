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

/** A file the mail carries, as the composer saved it: its storage id (a forwarded part's is `part:<id>`) and its name. */
export const MailSeenFileSchema = z.object({ id: z.string().max(200), name: z.string().max(1_000) })

/**
 * What the composer saved and he pressed Send on: the host refuses a row that says anything else. `html`,
 * `attachments`, `accountId` and `from` are optional so an older client still parses; the host then refuses a row
 * that has any of them.
 */
export const MailSeenSchema = z.object({
  to: z.array(z.string().max(320)).max(500),
  cc: z.array(z.string().max(320)).max(500),
  bcc: z.array(z.string().max(320)).max(500),
  subject: z.string().max(2_000),
  text: z.string().max(2_000_000),
  html: z.string().max(4_000_000).optional(),
  attachments: z.array(MailSeenFileSchema).max(500).optional(),
  /** The account it goes from and the From it shows: a row moved to another sender after the save is refused. */
  accountId: z.string().max(200).optional(),
  from: z.object({ name: z.string().max(1_000).optional(), address: z.string().max(320) }).optional()
})
export type MailSeen = z.infer<typeof MailSeenSchema>

/** An IANA zone name: "America/Chicago", "UTC". */
const ZoneSchema = z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/)

export const MailRequestSchemas = [
  /**
   * → { id, via }: sends the `outbox` row as LifeOS holds it now, only if it still says what the
   * composer saved (`seen`: who it goes to, the subject and the words). `sendAt` schedules it, in
   * `sendZone` (the IANA zone he picked it in), held back if they reply first with
   * `cancelIfReply`: his own mail as it is, a held draft as his own from then on (his press with a
   * time is his send for that instant). `waited`: the window already waited
   * out the undo time for this held draft (the composer's toast, with Undo), so LifeOS need not
   * queue it a second time. It means nothing for his own mail, which keeps LifeOS's queue.
   */
  request(
    'work.mail.send',
    z.object({
      id: z.string().min(1).max(64),
      sendAt: z.number().int().positive().optional(),
      sendZone: ZoneSchema.optional(),
      cancelIfReply: z.boolean().optional(),
      seen: MailSeenSchema,
      waited: z.boolean().optional()
    })
  ),
  /** → null: his press moves a scheduled mail to another time or zone; it stays scheduled. */
  request(
    'work.mail.reschedule',
    z.object({ id: z.string().min(1).max(64), sendAt: z.number().int().positive(), sendZone: ZoneSchema.optional(), cancelIfReply: z.boolean().optional() })
  ),
  /** → { sendAt }: his press sends a scheduled mail now; it goes after LifeOS's undo time, so Undo still takes it back. */
  request('work.mail.sendNow', z.object({ id: z.string().min(1).max(64) })),
  /** → { back }: his press takes a scheduled mail back to a draft; false when it is already on its way. */
  request('work.mail.cancel', z.object({ id: z.string().min(1).max(64) })),
  /**
   * → { sessionId }: his press on Waiting on's Draft a nudge. Starts a Work thread in the workspace, linked
   * to the mail, that drafts a follow-up in that mail thread; the draft is held as every draft is. A thread's
   * own call is refused, and so is a mail outside the workspace's sector.
   */
  request('work.mail.nudge', z.object({ workspaceId: z.string().min(1).max(64), threadId: z.string().min(1).max(64) })),
  /** → MailWaiting: the workspace's Waiting on settings. */
  request('work.mail.waiting', z.object({ workspaceId: z.string().min(1).max(64) })),
  /**
   * → MailWaiting: `days` is how many working days a mail that asked a question waits before it is listed
   * (LifeOS keeps it per sector); `routine` turns on or off the routine that drafts nudges by itself. A person's call only.
   */
  request('work.mail.setWaiting', z.object({ workspaceId: z.string().min(1).max(64), days: z.number().int().min(1).max(30).optional(), routine: z.boolean().optional() }))
] as const

/** A workspace's Waiting on: `days` null when LifeOS did not answer (`error` says why). */
export interface MailWaiting {
  days: number | null
  /** The nudge routine is on: it drafts a nudge by itself when a mail passes its time, which spends model use. */
  routine: boolean
  routineId?: string
  error?: string
}

/** How a send went: through the hold (a thread's draft) or as the owner's own mail. */
export interface MailSendAnswer {
  id: string
  via: 'hold' | 'owner'
}

export type MailPush = never

export const MAIL_CAPS = {
  'work.mail.send': 'approve',
  'work.mail.reschedule': 'approve',
  'work.mail.sendNow': 'approve',
  'work.mail.cancel': 'approve',
  'work.mail.nudge': 'operate',
  'work.mail.waiting': 'read',
  'work.mail.setWaiting': 'admin'
} satisfies CapsOf<typeof MailRequestSchemas>
export const MAIL_RELAY = {} satisfies RelayOf<typeof MailRequestSchemas>
