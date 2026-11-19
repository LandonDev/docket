import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The guests pillar's wire (docs/agents/work-guests.md). Its methods are
 * `work.guests.<verb>` and its push `work.guests`; src/shared/work/wire.ts has
 * the helpers and the rules.
 *
 * A guest link lets one named person open one LifeOS document or sheet on
 * the hosted page, with no sign-in, to view, comment or edit, until it ends
 * or the owner revokes it (architecture §8.6). The rows live on the host that
 * serves LifeOS's documents (the box); any other host answers
 * `served elsewhere: <env>` and the client asks that one (§19).
 */

export const GUEST_ROLES = ['view', 'comment', 'edit'] as const
export type GuestRole = (typeof GUEST_ROLES)[number]

/** What a link can be for: a LifeOS document or a LifeOS sheet. A file is moved to LifeOS first. */
export const GuestSourceSchema = z.object({ at: z.literal('lifeos'), table: z.enum(['docs', 'sheets']), id: z.string().regex(/^[A-Za-z0-9]{1,64}$/) })
export type GuestSource = z.infer<typeof GuestSourceSchema>

/** Ends: at least an hour away, at most a year. Thirty days unless he picks. */
export const GUEST_DEFAULT_DAYS = 30
export const GUEST_MIN_MS = 60 * 60_000
export const GUEST_MAX_MS = 366 * 24 * 60 * 60_000
/** An ended or revoked link stays listed this long, muted, so he can make it again. */
export const GUEST_KEEP_MS = 7 * 24 * 60 * 60_000

export const GuestNameSchema = z.string().trim().min(1).max(80)
export const GuestTitleSchema = z.string().trim().min(1).max(200)

export interface GuestLinkRow {
  id: string
  /** the one person it is for */
  name: string
  source: GuestSource
  /** the item's title when the link was made */
  title: string
  role: GuestRole
  createdAt: number
  expiresAt: number
  revokedAt: number | null
  /** who made it: the owner in the dialog, or his press on an agent's request */
  by: 'owner' | 'agent'
  /** when the guest last opened it, and how many of their sockets are open now; null when the service is not running */
  lastOpenedAt: number | null
  open: number
}

const linkId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)

export const GuestsRequestSchemas = [
  /** Every link made on this host, live ones first; ended and revoked ones for a week. */
  request('work.guests.list', z.object({})),
  /** One item's links, for its Share popover. */
  request('work.guests.forItem', z.object({ source: GuestSourceSchema })),
  /** The owner's own link: shown once in the answer, kept only as a hash. */
  request('work.guests.create', z.object({ source: GuestSourceSchema, title: GuestTitleSchema, name: GuestNameSchema, role: z.enum(GUEST_ROLES), expiresAt: z.number().int() })),
  /** Revoked at once: the guest's sockets close within a second. */
  request('work.guests.revoke', z.object({ linkId })),
  /** The owner's own hosted editor (`/w/open#t=<ticket>`), for the phone: a ticket that opens once, within two minutes. */
  request('work.guests.ticket', z.object({ source: GuestSourceSchema, title: GuestTitleSchema }))
] as const

export interface GuestCreated {
  link: GuestLinkRow
  /** the address with its secret: never stored, never shown again */
  url: string
}

export type GuestsPush = { push: 'work.guests' }

export const GUESTS_CAPS = {
  'work.guests.list': 'read',
  'work.guests.forItem': 'read',
  // Letting someone outside in is an outward act: a key must be able to approve one.
  'work.guests.create': 'approve',
  'work.guests.revoke': 'operate',
  'work.guests.ticket': 'operate'
} satisfies CapsOf<typeof GuestsRequestSchemas>
export const GUESTS_RELAY = {} satisfies RelayOf<typeof GuestsRequestSchemas>

/** What `share.guestLink` holds: exactly the link that will be made. */
export const GuestLinkActSchema = z.object({
  source: GuestSourceSchema,
  title: GuestTitleSchema,
  name: GuestNameSchema,
  role: z.enum(GUEST_ROLES),
  expiresAt: z.number().int()
})
export type GuestLinkAct = z.infer<typeof GuestLinkActSchema>

/** Why a link cannot be made as asked, in words a screen shows; null when it can. */
export function guestRefusal(p: { source: GuestSource; role: GuestRole; expiresAt: number }, now = Date.now()): string | null {
  if (p.source.table === 'sheets' && p.role === 'comment') return 'A sheet link can view or edit.'
  if (p.expiresAt < now + GUEST_MIN_MS) return 'A link ends at least an hour from now.'
  if (p.expiresAt > now + GUEST_MAX_MS) return 'A link ends within a year.'
  return null
}
