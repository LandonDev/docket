import type { HealthRow, Lapse } from '@shared/work'
import type { HealthSource, WorkCtx } from '../modules'
import { frameioConfig } from './auth'
import { itemsOf, statusOf } from './live'

/**
 * The frameio pillar's connection (docs/agents/work-frameio.md): signed in
 * or not, and as whom, read from the tokens this host keeps. No network: a
 * refresh token keeps the sign-in going and Adobe does not say here when it
 * ends, so only a sign-in with no refresh token has a known end. A host that
 * never used Frame.io (no sign-in, no webhook address, no item, no sign-in
 * under way) has no row.
 */

const SIGN_IN = { kind: 'page', label: 'Sign in…', page: 'settings:work' } as const
const ROW = { id: 'frameio.signin', pillar: 'frameio', group: 'Frame.io', title: 'Frame.io' } as const

/** The known end of this host's sign-in: the access token's, when nothing renews it. */
function endOf(): number | null {
  const t = frameioConfig.tokens.read()
  return t && !t.refresh && Number.isFinite(t.expiresAt) ? t.expiresAt : null
}

export function frameioRows(ctx: WorkCtx, now = Date.now()): HealthRow[] {
  const status = statusOf(ctx)
  const t = frameioConfig.tokens.read()
  if (!t) {
    const used = !!status.publicUrl || status.pending || !!status.error || itemsOf(ctx.db).length > 0
    return used ? [{ ...ROW, state: 'needs-you', line: 'Not signed in on this host', fix: SIGN_IN }] : []
  }
  const until = endOf()
  // Lapsed with nothing to renew it, or the renewal refused: only a new sign-in helps.
  if ((until !== null && until <= now) || (t.expiresAt <= now && status.error)) return [{ ...ROW, state: 'needs-you', line: 'The sign-in ran out. Sign in again.', fix: SIGN_IN, ...(until !== null ? { until } : {}) }]
  const who = t.user?.email || t.user?.name
  return [{ ...ROW, state: 'working', line: who ? `Signed in as ${who}` : 'Signed in', ...(until !== null ? { until } : {}) }]
}

export const frameioHealth: HealthSource = {
  check: async (ctx) => frameioRows(ctx),
  lapses(): Lapse[] {
    const until = endOf()
    return until === null ? [] : [{ id: ROW.id, pillar: 'frameio', title: 'Frame.io sign-in', until }]
  }
}
