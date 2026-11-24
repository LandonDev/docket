import { hasRefresh, type Transfer } from 'aliax-core/sync'
import type { ServiceId } from 'aliax-core'
import type { Grant } from '@shared/devices/envelope'

/**
 * One admission check for every account that arrives at, or leaves, this
 * host (docs/agents/pc-setup.md): a giver's push, a pull's answer, an
 * owner's rotation push, the answer to askOwner, a takeover, and the box's
 * own export to a puller.
 *
 * - An account lands only on the row of the same service and account id.
 *   aliax-core would also match a row by email; a transfer whose id is
 *   unknown here but whose email names another row is refused, so no copy
 *   lands on another account's row (or onto an own sign-in) by its address.
 * - A new account never takes a storage name a row on file has, in any case.
 * - Under the peer policy (everything but the giver's push) only a row
 *   already on file takes it.
 * - A holder never receives a refresh token: only a handoff carries one,
 *   and only where a handoff may arrive (the giver's push to the box, the
 *   answer to the giver's own takeover). Anything else with one is refused,
 *   never quietly stripped.
 * - A given computer (its manifest's grants in `admitted`) takes only what
 *   the manifest names: the exact service, account id and kind, and for an
 *   access copy the owner the manifest records.
 */

export type ReceivePath = 'push' | 'pull' | 'rotation' | 'askOwner' | 'takeover' | 'export'

export interface AdmissionContext {
  path: ReceivePath
  /** 'admin': the giver's push, which may introduce an account; 'peer': only a row on file. */
  policy: 'admin' | 'peer'
  /** The grants a given computer's manifest names; undefined on the giver and the box. */
  admitted?: readonly Grant[]
}

export type AdmissionRefusal = 'email-match' | 'name-taken' | 'unknown-account' | 'refresh-token' | 'not-admitted' | 'kind' | 'owner'
export type Admission = { ok: true } | { ok: false; reason: AdmissionRefusal }

export interface RowOnFile {
  accountId: string
  email?: string
  name?: string
}

const HANDOFF_PATHS: ReadonlySet<ReceivePath> = new Set(['push', 'takeover'])

export function admit(t: Pick<Transfer, 'service' | 'mode' | 'blob' | 'profile'>, ctx: AdmissionContext, onFile: readonly RowOnFile[]): Admission {
  const exact = onFile.find((p) => p.accountId === t.profile.accountId)
  if (!exact && ctx.path !== 'export') {
    const email = t.profile.email?.toLowerCase()
    if (email && onFile.some((p) => p.email?.toLowerCase() === email)) return { ok: false, reason: 'email-match' }
    // A new account under a storage name a row already has, in any case (one vault file on Windows), would land on that row (F25).
    const name = t.profile.name.toLowerCase()
    if (onFile.some((p) => p.name?.toLowerCase() === name)) return { ok: false, reason: 'name-taken' }
    if (ctx.policy === 'peer') return { ok: false, reason: 'unknown-account' }
  }
  const refresh = hasRefresh(t.service as ServiceId, t.blob)
  if (t.mode === 'handoff') {
    if (!HANDOFF_PATHS.has(ctx.path) || (ctx.path === 'push' && ctx.policy !== 'admin') || ctx.admitted) return { ok: false, reason: 'refresh-token' }
  } else if (refresh) return { ok: false, reason: 'refresh-token' }
  if (ctx.admitted) {
    const grant = ctx.admitted.find((g) => g.service === t.service && g.account === t.profile.accountId)
    if (!grant) return { ok: false, reason: 'not-admitted' }
    const kind = t.profile.static ? 'static' : 'access'
    if (grant.kind !== kind) return { ok: false, reason: 'kind' }
    if (kind === 'access' && (grant.owner ?? null) !== (t.profile.owner ?? null)) return { ok: false, reason: 'owner' }
  }
  return { ok: true }
}
