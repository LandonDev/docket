import type { LifeosHost } from '../../work/lifeos/ctx'
import type { LifeosSession } from '../../work/lifeos/session'
import { faultOf, redact, type LifeosTransport } from '../../work/lifeos/transport'
import { enrollWords } from './enrollWords'
import { tokenDigest } from './gave'

/**
 * TempCode's own Work sign-in on a computer being set up (plan §6): the
 * `tempcode` code from the giver's sealed letter is traded once with
 * `auth:enrollRedeem {code, owner}` (open, no identity) for a device token,
 * which is kept along `work.lifeos.setToken`'s path in-process
 * (`LifeosSession.setToken`: kept only if LifeOS trades it).
 *
 * It never displaces a session this computer already holds: `setToken`
 * revokes the session it replaces, so the state is checked first, before the
 * code is used, and again once LifeOS answers. The token and the code are
 * never logged or answered.
 */

/** `token` is the sha256 of the device token saved (gave.ts): Remove signs out only that one. */
export type WorkSignInAnswer = { outcome: 'signed-in'; token?: string } | { outcome: 'already-signed-in' } | { outcome: 'failed'; reason: string }

export interface WorkSignInDeps {
  /** an open LifeOS call (the Work pillar's transport) */
  open: LifeosTransport['open']
  session: Pick<LifeosSession, 'state' | 'setToken'>
}

export const workSignInDepsOf = (host: Pick<LifeosHost, 'open' | 'session'>): WorkSignInDeps => ({ open: host.open, session: host.session })

const TOKEN = /^lo_[A-Za-z0-9_-]{43}$/

/** States in which this computer holds a session of its own: a token LifeOS has not refused. */
const holds = (state: string): boolean => state === 'connecting' || state === 'connected' || state === 'unreachable'

/**
 * `attempt`, saved by the caller before the first try, makes the redemption repeatable: LifeOS answers the
 * same code and attempt again for the same session, so a reply lost on the way is recovered by Retry (F20).
 */
export async function signInWork(input: { code: string; owner: string; attempt?: string }, deps: WorkSignInDeps): Promise<WorkSignInAnswer> {
  const before = deps.session.state().state
  if (before === 'off') return { outcome: 'failed', reason: 'Work is off on this computer' }
  if (holds(before)) return { outcome: 'already-signed-in' }
  let answer: { token: string; owner: string }
  try {
    answer = await deps.open<{ token: string; owner: string }>('auth:enrollRedeem', { code: input.code.trim(), owner: input.owner, ...(input.attempt ? { attempt: input.attempt } : {}) })
  } catch (err) {
    const code = (err as { data?: { code?: unknown } } | null)?.data?.code
    if (typeof code === 'string') return { outcome: 'failed', reason: enrollWords(code) }
    return { outcome: 'failed', reason: faultOf(err) === 'unreachable' ? 'LifeOS is unreachable' : 'LifeOS did not take the sign-in code' }
  }
  if (answer?.owner !== input.owner) return { outcome: 'failed', reason: enrollWords('wrong owner') }
  if (!TOKEN.test(answer.token ?? '')) return { outcome: 'failed', reason: enrollWords('bad-response') }
  // A sign-in that landed while LifeOS answered (a pairing approved) is his: it stays.
  if (holds(deps.session.state().state)) return { outcome: 'already-signed-in' }
  try {
    await deps.session.setToken(answer.token)
  } catch (err) {
    return { outcome: 'failed', reason: redact(err instanceof Error ? err.message : String(err)) }
  }
  return { outcome: 'signed-in', token: tokenDigest(answer.token) }
}
