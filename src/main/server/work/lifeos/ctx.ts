import { notBuilt, type HostId, type SectorKey } from '@shared/work'
import type { CtxPart } from '../ctx'

/**
 * `ctx.lifeos` and `ctx.links`: the host's side of LifeOS. A stub:
 * milestone 7 builds the pairing client, the device token in the vault, the
 * host's Convex client, sector keys and the thread links.
 */

/** The host's device session against LifeOS's Convex, as a pillar calls it. Milestone 7 makes it the Convex client's own type. */
export interface LifeosClient {
  query<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>
  mutation<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>
  action<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>
}

/** A LifeOS `workLinks` row: the link between a thread and its task, mail or event. TempCode keeps no copy. */
export interface WorkLink {
  sector: SectorKey
  entity: { table: string; id: string }
  host: HostId
  threadId: string
  title: string
  state: 'open' | 'done'
  at: number
}

export const lifeosPart: CtxPart<'lifeos' | 'links'> = () => ({
  lifeos: {
    connected: notBuilt('ctx.lifeos.connected', 7),
    owner: notBuilt('ctx.lifeos.owner', 7),
    jwt: notBuilt('ctx.lifeos.jwt', 7),
    subscribe: notBuilt('ctx.lifeos.subscribe', 7)
  },
  links: {
    link: notBuilt('ctx.links.link', 7),
    forThread: notBuilt('ctx.links.forThread', 7),
    completeFor: notBuilt('ctx.links.completeFor', 7)
  }
})
