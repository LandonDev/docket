import type { LifeosClient, LifeosHost } from '../../work/lifeos/ctx'
import { faultWords } from '../../work/lifeos/transport'

/**
 * The giver's side of LifeOS on a computer being set up (plan §5, §6): the
 * Mac, after Allow, prepares a sign-in with `auth:enrollCreate` through its
 * own Work LifeOS session (a `tempcode` session of every sector), which
 * answers one one-time code per use. The codes go sealed to the new
 * computer; the enrollment id is kept for Remove and Cancel, which withdraw
 * it with `auth:enrollRevoke` (its unused codes, the sessions they made and
 * their keys).
 *
 * Nothing here logs. A code leaves only in the answer; an error carries
 * LifeOS's words, redacted (`loe_` is a secret shape there).
 */

export type EnrollUse = 'desktop' | 'tempcode'

export interface Enrollment {
  enrollment: string
  expiresAt: number
  codes: Partial<Record<EnrollUse, string>>
}

/** `not-signed-in`: this host's Work holds no live LifeOS session, so the setup dialog turns the LifeOS row off. */
export type EnrollAnswer = ({ ok: true } & Enrollment) | { ok: false; reason: 'not-signed-in' }

export interface EnrollDeps {
  /** the owner's client while this host's Work is connected to LifeOS, else null */
  owner: () => LifeosClient | null
  /** this host's own session's proof (LifeOSSession.localProof): LifeOS mints a sign-in only for the session that holds its device token */
  localProof?: () => { token: string } | null
}

/** The deps on a running host: its own LifeOS session. */
export const enrollDepsOf = (host: Pick<LifeosHost, 'session'>): EnrollDeps => ({
  owner: () => (host.session.connected() ? host.session.owner() : null),
  localProof: () => host.session.localProof()
})

const CODE = /^loe_[A-Za-z0-9_-]{43}$/

export async function mintEnrollment(input: { name: string; uses: EnrollUse[]; ttlMs?: number }, deps: EnrollDeps): Promise<EnrollAnswer> {
  const owner = deps.owner()
  if (!owner) return { ok: false, reason: 'not-signed-in' }
  const name = input.name.trim().slice(0, 80)
  const uses = [...new Set(input.uses)]
  if (!name) throw new Error('A computer being set up needs a name')
  if (!uses.length) throw new Error('A sign-in needs at least one use')
  let answer: Enrollment
  try {
    answer = await owner.action<Enrollment>('auth:enrollCreate', { name, uses, ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}), ...(deps.localProof?.() ?? {}) })
  } catch (err) {
    throw new Error(`LifeOS did not prepare the sign-in: ${faultWords(err)}`)
  }
  for (const use of uses) if (!CODE.test(answer.codes[use] ?? '')) throw new Error(`LifeOS gave no ${use} code`)
  return { ok: true, enrollment: answer.enrollment, expiresAt: answer.expiresAt, codes: answer.codes }
}

/** Withdraws a prepared sign-in: its unused codes, the sessions it made, their keys. */
export async function revokeEnrollment(enrollment: string, deps: EnrollDeps): Promise<{ ok: true } | { ok: false; reason: 'not-signed-in' }> {
  const owner = deps.owner()
  if (!owner) return { ok: false, reason: 'not-signed-in' }
  try {
    await owner.mutation('auth:enrollRevoke', { enrollment })
  } catch (err) {
    throw new Error(`LifeOS did not withdraw the sign-in: ${faultWords(err)}`)
  }
  return { ok: true }
}
