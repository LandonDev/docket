import { z, type ZodType } from 'zod'
import type { PillarId, SectorKey } from './ids'

/**
 * The hold's wire: the kinds of outward act, a held item as every client
 * lists it, and the definition a pillar registers for a kind it owns. The
 * store (`work_held_acts`), the press and the grants are milestone 10's.
 */

export const ACT_KINDS = [
  'mail.send',
  'calendar.op',
  'teams.post',
  'office.mail.send',
  'office.calendar.op',
  'share.guestLink',
  'share.google',
  'form.publish',
  'frameio.post',
  'portal.submit',
  'computer.act',
  'addon.call'
] as const
export type ActKind = (typeof ACT_KINDS)[number]
export const ActKindSchema = z.enum(ACT_KINDS)

/** The pillar whose folder holds each kind's view (`work/<pillar>/act.ts`, milestone 9). */
export const ACT_PILLAR: Record<ActKind, PillarId> = {
  'mail.send': 'mail',
  'calendar.op': 'agenda',
  'teams.post': 'browser',
  'office.mail.send': 'office',
  'office.calendar.op': 'office',
  'share.guestLink': 'guests',
  'share.google': 'google',
  'form.publish': 'forms',
  'frameio.post': 'frameio',
  'portal.submit': 'browser',
  'computer.act': 'outbox',
  'addon.call': 'outbox'
}

/** Where a held item's row lives: this host's `work_held_acts`, or LifeOS's own tables. */
export type HeldRef = { at: 'host'; id: string } | { at: 'lifeos'; table: 'outbox' | 'calendarOps'; id: string }
export const HeldRefSchema = z.discriminatedUnion('at', [
  z.object({ at: z.literal('host'), id: z.string() }),
  z.object({ at: z.literal('lifeos'), table: z.enum(['outbox', 'calendarOps']), id: z.string() })
])

export const HELD_STATES = ['held', 'live', 'sending', 'sent', 'failed', 'discarded', 'stale'] as const
export type HeldState = (typeof HELD_STATES)[number]

/** One held act as `work.outbox.list` answers it: host rows and LifeOS-held items alike. */
export interface HeldItem {
  ref: HeldRef
  kind: ActKind
  workspaceId: string | null
  sessionId: string | null
  sector: SectorKey | null
  /** "Send to Dana Lee: Re: budget" */
  summary: string
  /** "Send" */
  verb: string
  account: string | null
  state: HeldState
  /** exactly what will go, in the kind's own schema */
  payload: unknown
  createdAt: number
  decidedBy: string | null
  decidedAt: number | null
}
export const HeldItemSchema = z.object({
  ref: HeldRefSchema,
  kind: ActKindSchema,
  workspaceId: z.string().nullable(),
  sessionId: z.string().nullable(),
  sector: z.string().nullable(),
  summary: z.string(),
  verb: z.string(),
  account: z.string().nullable(),
  state: z.enum(HELD_STATES),
  payload: z.unknown(),
  createdAt: z.number().int(),
  decidedBy: z.string().nullable(),
  decidedAt: z.number().int().nullable()
})

/** What carrying an act out left behind: a line for Sent, and what to open. */
export interface ActResult {
  summary: string
  /** JSON: what to open (a sent mail, a posted message's picture) */
  ref?: unknown
}

/** The inverse call of a write that lasts (`work_results.undo`): a tool of a pillar, with its arguments. */
export interface UndoSpec {
  pillar: PillarId
  verb: string
  args: unknown
  /** "Remove the task" */
  label?: string
}

/**
 * One kind of outward act, over the context its `execute` gets. A pillar
 * registers its kinds through `WorkModule.acts`; the Outbox holds, shows
 * and carries them out. A module writes `ActKindDef<P, M>`
 * (src/main/server/work/modules.ts), which is this with the host's `ActCtx`.
 */
export interface ActKindDefOf<P, M, C> {
  kind: ActKind
  /** where the held row lives */
  store: 'host' | 'lifeos'
  /** exactly what will go */
  payload: ZodType<P>
  /** what a grant may fix: a recipient, a domain, a channel, a tool */
  matcher?: ZodType<M>
  /** "Send to Dana Lee: Re: budget", "Send" */
  words(p: P): { summary: string; verb: string }
  matches?(m: M, p: P): boolean
  /** host-side; once per run key */
  execute(p: P, ctx: C): Promise<ActResult>
  /** null: "Sent mail cannot be taken back" */
  wayBack?: (r: ActResult) => UndoSpec | null
}
