import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'
import { GUEST_ROLES, guestTableOf, SHARE_REFUSALS, type GuestRole } from './work/guestRoles'

/**
 * The guests pillar's wire (docs/agents/work-guests.md). Its methods are
 * `work.guests.<verb>` and its push `work.guests`; src/shared/work/wire.ts has
 * the helpers and the rules.
 *
 * A guest link lets one named person open one LifeOS document or sheet, or
 * one TempCode document or sheet kept as a file, on the hosted page, with no
 * sign-in, to view, comment or edit, until it ends or the owner revokes it
 * (architecture §8.6); or one LifeOS project, to
 * view: its tasks, and its documents and sheets read-only
 * (src/shared/work/guestProjection.ts). The rows live on the host that
 * serves LifeOS's documents (the box); any other host answers
 * `served elsewhere: <env>` and the client asks that one (§19).
 */

export { GUEST_ROLES, type GuestRole } from './work/guestRoles'

/** A LifeOS document, sheet or project. */
export const LifeosGuestSourceSchema = z.object({ at: z.literal('lifeos'), table: z.enum(['docs', 'sheets', 'projects']), id: z.string().regex(/^[A-Za-z0-9]{1,64}$/) })
/**
 * A TempCode document or sheet kept as a file (`.tcdoc`, `.tcsheet`), named as the item that shows it names it: its
 * host and its path there. The host that has the file makes the link, and only one whose pages a guest can reach.
 */
export const FileGuestSourceSchema = z.object({ at: z.literal('file'), host: z.string().min(1).max(200), path: z.string().min(1).max(4096) })
/** What a link can be for: a LifeOS document, sheet or project, or a document or sheet kept as a file. */
export const GuestSourceSchema = z.union([LifeosGuestSourceSchema, FileGuestSourceSchema])
export type GuestSource = z.infer<typeof GuestSourceSchema>
export type LifeosGuestSource = z.infer<typeof LifeosGuestSourceSchema>
export type FileGuestSource = z.infer<typeof FileGuestSourceSchema>

/**
 * A link's item as its row keeps it: a file's with its kind and an id of its own (a digest of the path, so a list
 * can key it and the phone, which reads `at`, `table` and `id`, reads it as any other row).
 */
export type GuestLinkSource = LifeosGuestSource | (FileGuestSource & { table: 'docs' | 'sheets'; id: string })

export { guestRolesOf, guestTableOf } from './work/guestRoles'

/**
 * What the owner's own hosted editor can open: a LifeOS document or sheet, or a document or sheet kept as a
 * file, named by the canvas item that shows it (a thread's, or a Files tab's), never by a path.
 */
export const TicketSourceSchema = z.union([LifeosGuestSourceSchema, z.object({ at: z.literal('item'), itemId: z.string().min(1).max(100) })])
export type TicketSource = z.infer<typeof TicketSourceSchema>

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
  source: GuestLinkSource
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
/** The phone's name for one press of Create link, answered once (guests/attempts.ts). */
const attempt = z.string().min(8).max(64)

export const GuestsRequestSchemas = [
  /** Every link made on this host, live ones first; ended and revoked ones for a week. */
  request('work.guests.list', z.object({})),
  /** One item's links, for its Share sheet. */
  request('work.guests.forItem', z.object({ source: GuestSourceSchema })),
  /**
   * The owner's own link: shown once in the answer, kept only as a hash. `attempt` (the phone's): a repeat of the key
   * makes no second link; it answers `GuestCreatedAgain`, the link with no address, since the address is never kept.
   */
  request('work.guests.create', z.object({ source: GuestSourceSchema, title: GuestTitleSchema, name: GuestNameSchema, role: z.enum(GUEST_ROLES), expiresAt: z.number().int(), attempt: attempt.optional() })),
  /** → GuestAttemptAnswer: what became of a Create link named by its `attempt` key, read without making anything. */
  request('work.guests.attempt', z.object({ attempt })),
  /** A new address for a live link, shown once: the one before opens nothing from now on. */
  request('work.guests.rekey', z.object({ linkId })),
  /** Revoked at once: the guest's sockets close within a second. */
  request('work.guests.revoke', z.object({ linkId })),
  /** What a live link lets its guest do, changed at once: the guest's page opens again as the new role; the address stays. */
  request('work.guests.setRole', z.object({ linkId, role: z.enum(GUEST_ROLES) })),
  /**
   * The origin guest pages are served on (`https://share.landonhale.com`), or null for the host's own. Taken only
   * once that origin has answered as this very host's Work service, so a wrong name cannot break links.
   */
  request('work.guests.setOrigin', z.object({ origin: z.string().max(200).nullable() })),
  /** The owner's own hosted editor (`/w/open#t=<ticket>`), for the phone: a ticket that opens once, within two minutes. */
  request('work.guests.ticket', z.object({ source: TicketSourceSchema, title: GuestTitleSchema }))
] as const

export interface GuestCreated {
  link: GuestLinkRow
  /** the address with its secret: never stored, never shown again */
  url: string
}

/**
 * A repeat of a Create link's attempt key once the first has answered: the link it made, as it stands now, and no
 * address, which was shown once and kept only as a hash. Replace address… makes a new one.
 */
export interface GuestCreatedAgain {
  link: GuestLinkRow
  again: true
}

/** What became of a Create link by its attempt key: made (the link's id), refused, or cut off by a restart, in the host's words. */
export interface GuestAttemptAnswer {
  state: 'none' | 'making' | 'made' | 'refused' | 'unknown'
  linkId?: string
  words?: string
}

export type GuestsPush = { push: 'work.guests' }

export const GUESTS_CAPS = {
  'work.guests.list': 'read',
  'work.guests.forItem': 'read',
  // Letting someone outside in is an outward act: a key must be able to approve one.
  'work.guests.create': 'approve',
  'work.guests.rekey': 'approve',
  // Says whether a press made a link: as much as making it may know.
  'work.guests.attempt': 'approve',
  'work.guests.revoke': 'operate',
  // A role can widen what someone outside may do: as making the link, a key that may approve.
  'work.guests.setRole': 'approve',
  // Where every guest's page is served from: the host's own setting, as its other addresses are.
  'work.guests.setOrigin': 'admin',
  'work.guests.ticket': 'operate'
} satisfies CapsOf<typeof GuestsRequestSchemas>
export const GUESTS_RELAY = {} satisfies RelayOf<typeof GuestsRequestSchemas>

/** What `share.guestLink` holds: exactly the link that will be made. */
export const GuestLinkActSchema = z.object({
  source: GuestSourceSchema,
  /** a file's id when the thread asked (`fileLinkId` of its resolved path): his press makes the link only for that same file */
  fileId: z.string().max(64).optional(),
  /** the id that file carried inside it then (guests/fileIdent.ts): another file put at the same path since is not the one he was asked about */
  fileUid: z.string().max(64).optional(),
  title: GuestTitleSchema,
  name: GuestNameSchema,
  role: z.enum(GUEST_ROLES),
  expiresAt: z.number().int()
})
export type GuestLinkAct = z.infer<typeof GuestLinkActSchema>

/** Why a link cannot be made as asked, in words a screen shows; null when it can. */
export function guestRefusal(p: { source: GuestSource; role: GuestRole; expiresAt: number }, now = Date.now()): string | null {
  const table = guestTableOf(p.source)
  if (!table) return SHARE_REFUSALS.other
  if (table === 'projects' && p.role !== 'view') return 'A project link can view.'
  if (table === 'sheets' && p.role === 'comment') return 'A sheet link can view or edit.'
  if (p.expiresAt < now + GUEST_MIN_MS) return 'A link ends at least an hour from now.'
  if (p.expiresAt > now + GUEST_MAX_MS) return 'A link ends within a year.'
  return null
}
