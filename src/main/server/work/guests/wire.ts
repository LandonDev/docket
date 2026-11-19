import type { GuestRole } from '@shared/contract-work-guests'
import type { ServiceLink } from '../service/wire'

/**
 * What main tells the Work service about each live link and each open
 * ticket, through `supervisor.setLinks` (types only: the service's bundle
 * takes nothing else from here). The service's own checks read the fields
 * of `ServiceLink`; the guest routes read the rest. A link that is revoked
 * or ended is not sent, so it is not live there either.
 */

export interface GuestLinkFacts {
  /** SHA-256 hex of the link's secret */
  secretHash: string
  name: string
  title: string
  /** the owner's name, for the page's line */
  owner: string
  /** a collab token for the link's item, signed by main, `principal: guest:<id>`, `link: <id>`; refreshed before it runs out */
  token: string
  tokenExp: number
}

/** The owner's hosted editor: a ticket that opens once, then a session renewed by a key the service makes. */
export interface OpenPassFacts {
  ticketHash: string
  /** the ticket opens nothing after this */
  ticketUntil: number
  title: string
  token: string
  tokenExp: number
}

export type GuestServiceLink = ServiceLink & { role: GuestRole } & ({ guest: GuestLinkFacts; pass?: never } | { pass: OpenPassFacts; guest?: never })

/** A pass is listed under this prefix, so no guest link id can be one. */
export const PASS_PREFIX = 'open.'
