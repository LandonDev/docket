import { describe, expect, it } from 'vitest'
import type { LifeosState } from '@shared/contract-work-lifeos'
import type { LifeosClient } from '../../work/lifeos/ctx'
import { FakeLifeos } from '../../work/lifeos/fakeLifeos'
import { mintEnrollment, revokeEnrollment, type EnrollDeps } from './lifeosEnroll'
import { signInWork, type WorkSignInDeps } from './workSignIn'

/** The Mac's own Work client on the fake: a connection whose JWT the fake issued, and its device token's proof. */
async function macOwner(fake: FakeLifeos): Promise<LifeosClient & { deps: EnrollDeps }> {
  const token = fake.device()
  const { jwt } = await fake.open<{ jwt: string }>('auth:token', { token })
  const client = fake.connect(async () => jwt, () => {})
  return Object.assign(client, { deps: { owner: () => client, localProof: () => ({ token }) } })
}

/** A PC's session as far as the sign-in sees it: its state, and setToken as the handler calls it. */
function pcSession(fake: FakeLifeos, state: LifeosState['state']) {
  const kept: string[] = []
  let current: LifeosState = state === 'connected' ? { state, ownerId: 'landon', since: 1 } : ({ state } as LifeosState)
  return {
    kept,
    session: {
      state: () => current,
      async setToken(token: string) {
        await fake.open('auth:token', { token })
        kept.push(token)
        current = { state: 'connected', ownerId: 'landon', since: 2 }
      }
    } satisfies WorkSignInDeps['session']
  }
}

describe("the giver's enrollment", () => {
  it('mints both codes through the Mac’s own session and withdraws them, ending what they made', async () => {
    const fake = new FakeLifeos()
    const owner = await macOwner(fake)
    const deps: EnrollDeps = owner.deps
    const minted = await mintEnrollment({ name: ' Purdue laptop ', uses: ['desktop', 'tempcode'] }, deps)
    expect(minted).toMatchObject({ ok: true, enrollment: 'enr_1', codes: { desktop: expect.stringMatching(/^loe_/), tempcode: expect.stringMatching(/^loe_/) } })
    expect(fake.calls.find((c) => c.fn === 'auth:enrollCreate')!.args).toMatchObject({ name: 'Purdue laptop', uses: ['desktop', 'tempcode'] })
    if (!minted.ok) throw new Error('not minted')
    const { token } = await fake.open<{ token: string }>('auth:enrollRedeem', { code: minted.codes.tempcode, owner: 'landon' })
    expect(await revokeEnrollment(minted.enrollment, deps)).toEqual({ ok: true })
    await expect(fake.open('auth:token', { token })).rejects.toMatchObject({ data: { code: 'invalid-token' } })
    await expect(fake.open('auth:enrollRedeem', { code: minted.codes.desktop, owner: 'landon' })).rejects.toMatchObject({ data: { code: 'enroll-cancelled' } })
  })

  it("answers a typed not-signed-in when the Mac's Work holds no LifeOS session, and asks nothing", async () => {
    expect(await mintEnrollment({ name: 'PC', uses: ['desktop'] }, { owner: () => null })).toEqual({ ok: false, reason: 'not-signed-in' })
    expect(await revokeEnrollment('enr_1', { owner: () => null })).toEqual({ ok: false, reason: 'not-signed-in' })
  })

  it('a refusal (an enrolled Mac session) reads in words with no code in them', async () => {
    const fake = new FakeLifeos()
    const owner = await macOwner(fake)
    fake.enrolled = true
    await expect(mintEnrollment({ name: 'PC', uses: ['desktop'] }, owner.deps)).rejects.toThrow(/^LifeOS did not prepare the sign-in: ConvexError: forbidden$/)
  })

  it("mints only with the Mac's own device token: the same session's JWT alone, which a phone may hold, mints nothing (F02)", async () => {
    const fake = new FakeLifeos()
    const owner = await macOwner(fake)
    await expect(mintEnrollment({ name: 'PC', uses: ['desktop'] }, { owner: () => owner })).rejects.toThrow(/forbidden/)
    await expect(mintEnrollment({ name: 'PC', uses: ['desktop'] }, { owner: () => owner, localProof: () => ({ token: fake.device() }) })).rejects.toThrow(/forbidden/)
    expect(fake.enrollments).toEqual([])
    expect(await mintEnrollment({ name: 'PC', uses: ['desktop'] }, owner.deps)).toMatchObject({ ok: true })
  })
})

describe("TempCode's own Work sign-in on the PC", () => {
  async function code(fake: FakeLifeos): Promise<string> {
    const owner = await macOwner(fake)
    const minted = await mintEnrollment({ name: 'PC', uses: ['tempcode'] }, owner.deps)
    if (!minted.ok) throw new Error('not minted')
    return minted.codes.tempcode!
  }

  it('redeems with the owner named and keeps the token along setToken’s path', async () => {
    const fake = new FakeLifeos()
    const pc = pcSession(fake, 'signed-out')
    expect(await signInWork({ code: await code(fake), owner: 'landon' }, { open: (fn, args) => fake.open(fn, args), session: pc.session })).toMatchObject({ outcome: 'signed-in', token: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(fake.calls.find((c) => c.fn === 'auth:enrollRedeem')!.args).toMatchObject({ owner: 'landon' })
    // An attempt, when the caller saved one, rides along for a retry after a lost reply (F20).
    const fake2 = new FakeLifeos()
    await signInWork({ code: await code(fake2), owner: 'landon', attempt: 'a'.repeat(43) }, { open: (fn, args) => fake2.open(fn, args), session: pcSession(fake2, 'signed-out').session })
    expect(fake2.calls.find((c) => c.fn === 'auth:enrollRedeem')!.args).toMatchObject({ attempt: 'a'.repeat(43) })
    expect(pc.kept).toEqual([fake.enrollments[0]!.tokens[0]])
  })

  it('never displaces a session the PC holds: already signed in, and the code is not used', async () => {
    const fake = new FakeLifeos()
    const c = await code(fake)
    for (const state of ['connected', 'connecting', 'unreachable'] as const) {
      const pc = pcSession(fake, state)
      expect(await signInWork({ code: c, owner: 'landon' }, { open: (fn, args) => fake.open(fn, args), session: pc.session })).toEqual({ outcome: 'already-signed-in' })
      expect(pc.kept).toEqual([])
    }
    expect(fake.calls.some((c) => c.fn === 'auth:enrollRedeem')).toBe(false)
  })

  it('a sign-in that lands while LifeOS answers stays: the new token is not kept', async () => {
    const fake = new FakeLifeos()
    const c = await code(fake)
    const pc = pcSession(fake, 'signed-out')
    const open: WorkSignInDeps['open'] = async (fn, args) => {
      const answer = await fake.open(fn, args)
      await pc.session.setToken(fake.device())
      return answer as never
    }
    expect(await signInWork({ code: c, owner: 'landon' }, { open, session: pc.session })).toEqual({ outcome: 'already-signed-in' })
    expect(pc.kept).toHaveLength(1)
  })

  it('refusals in words: another owner, a used code, Work off', async () => {
    const fake = new FakeLifeos()
    const c = await code(fake)
    const open: WorkSignInDeps['open'] = (fn, args) => fake.open(fn, args)
    expect(await signInWork({ code: c, owner: 'someone' }, { open, session: pcSession(fake, 'signed-out').session })).toEqual({ outcome: 'failed', reason: 'This sign-in code belongs to another LifeOS account' })
    expect(await signInWork({ code: c, owner: 'landon' }, { open, session: pcSession(fake, 'off').session })).toEqual({ outcome: 'failed', reason: 'Work is off on this computer' })
    expect(await signInWork({ code: c, owner: 'landon' }, { open, session: pcSession(fake, 'refused').session })).toMatchObject({ outcome: 'signed-in' })
    const again = await signInWork({ code: c, owner: 'landon' }, { open, session: pcSession(fake, 'signed-out').session })
    expect(again).toEqual({ outcome: 'failed', reason: 'This sign-in code was used already' })
    expect(JSON.stringify(again)).not.toContain(c)
  })

  it('an answer for another owner than the one named is refused, whatever LifeOS checked', async () => {
    const fake = new FakeLifeos()
    const pc = pcSession(fake, 'signed-out')
    const open: WorkSignInDeps['open'] = async () => ({ token: `lo_${'b'.repeat(43)}`, owner: 'mallory' }) as never
    expect(await signInWork({ code: await code(fake), owner: 'landon' }, { open, session: pc.session })).toEqual({ outcome: 'failed', reason: 'This sign-in code belongs to another LifeOS account' })
    expect(pc.kept).toEqual([])
  })
})
