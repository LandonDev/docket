import { allows, type Principal } from '@shared/capabilities'
import type { UserTextBy } from '@shared/events'

/**
 * Who a socket's message is from (events.ts UserTextBySchema): the owner at a
 * window of this host, or a paired key, counted as the owner's only when it is
 * a client key (a device, a host's desktop) that could approve as it wrote. A
 * key of the MCP facade is another agent's, whatever it may do.
 */
export function userTextByOf(principal: Principal): UserTextBy {
  if (principal.kind === 'local') return { kind: 'owner' }
  return { kind: 'key', keyId: principal.keyId, owner: principal.audience === 'client' && allows(principal.caps, 'approve') }
}
