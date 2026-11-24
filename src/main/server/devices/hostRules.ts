import type { Principal } from '@shared/capabilities'
import { RELAY_METHODS } from '@shared/contract-relay'

/**
 * Two rules every host applies itself, whatever a carrier says
 * (docs/agents/pc-setup.md):
 * - A relayed lane's request runs only when its method is in RELAY_METHODS
 *   here: the box forwards only those, and this host does not take the
 *   box's word for it (nor for the caps it names).
 * - On a given computer (a PC or a second Mac set up from the giver), no
 *   remote principal reads an owner's LifeOS session or calls a method that
 *   carries a credential; the local window still does.
 */

export function relayedRefusal(principal: Principal, method: string): string | null {
  if (principal.kind !== 'remote' || !principal.via) return null
  return method in RELAY_METHODS ? null : `forbidden: ${method} is not carried by a relayed lane`
}

/** Never for a remote principal on a given computer. */
export const GIVEN_HOST_LOCAL: ReadonlySet<string> = new Set([
  'work.lifeos.jwt',
  'work.lifeos.pairStart',
  'work.lifeos.pairCancel',
  'work.lifeos.signOut',
  'work.lifeos.link',
  'accounts.push',
  'accounts.pull',
  'accounts.confirm',
  'accounts.released',
  'accounts.removed',
  'accounts.refreshLocal',
  'addons.grant.setFields',
  'addons.grant.clear',
  'addons.grant.refresh',
  'linear.setToken'
])

/** Whether this host is a given computer; set once its pinned giver is on file (devices/given.ts). */
export const givenHost: { current: () => boolean } = { current: () => false }

export function givenHostRefusal(principal: Principal, method: string): string | null {
  if (principal.kind !== 'remote' || !givenHost.current()) return null
  return GIVEN_HOST_LOCAL.has(method) ? `forbidden: ${method} is this computer's own` : null
}
