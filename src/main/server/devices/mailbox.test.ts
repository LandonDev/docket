import { describe, expect, it } from 'vitest'
import { LETTER_CAP } from '@shared/devices/envelope'
import { generateDeviceKeys } from '@shared/devices/keys'
import { makeBox } from './boxTestkit'

const queue = (db: Awaited<ReturnType<typeof makeBox>>['db'], envId: string): number[] =>
  (db.prepare(`SELECT seq FROM device_mail WHERE env_id = ? ORDER BY seq`).all(envId) as { seq: number }[]).map((r) => r.seq)

describe('devices.activate', () => {
  it('binds the computer active, makes its key a device key and tells the giver', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    expect(pc.binding).toMatchObject({ envId: 'env_pc', keyId: pc.keyId, generation: 1, state: 'active', seq: null })
    expect(box.auth.getKey(pc.keyId)!.caps).toEqual(['approve', 'device', 'operate', 'read'])
    expect(box.toGiver).toEqual([{ push: 'device-joined', envId: 'env_pc' }])
    // The same binding again answers ok; another identity, key or generation on the env id is refused.
    expect(box.mailbox.activate({ envId: 'env_pc', keyId: pc.keyId, identity: pc.binding.identity, generation: 1, name: 'env_pc' }).binding.envId).toBe('env_pc')
    const other = generateDeviceKeys()
    expect(() => box.mailbox.activate({ envId: 'env_pc', keyId: pc.keyId, identity: { signPublic: other.signPublic, sealPublic: other.sealPublic }, generation: 2, name: 'x' })).toThrow(/bound under another/)
  })

  it('refuses a retired env id, the giver\'s key, an admin key and a key that binds another computer', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const { removalId } = box.farewell.remove('env_pc')
    box.farewell.handle(box.principalOf(pc), { op: 'receipt', removalId, signature: box.receipt(pc, removalId) })
    const fresh = (await box.auth.createKey({ name: 'again', audience: 'client', caps: ['read'], createdBy: 'test' })).key
    const keys = generateDeviceKeys()
    const identity = { signPublic: keys.signPublic, sealPublic: keys.sealPublic }
    // The same identity again is refused (a new identity at a higher generation is the one way back: binding.test.ts).
    const old = { signPublic: pc.keys.signPublic, sealPublic: pc.keys.sealPublic }
    expect(() => box.mailbox.activate({ envId: 'env_pc', keyId: fresh.id, identity: old, generation: 2, name: 'again' })).toThrow(/admitted again only under a new identity/)
    expect(() => box.mailbox.activate({ envId: 'env_x', keyId: box.giverKey.id, identity, generation: 1, name: 'x' })).toThrow(/giver/)
    const admin = (await box.auth.createKey({ name: 'phone', audience: 'client', caps: ['admin'], createdBy: 'test' })).key
    expect(() => box.mailbox.activate({ envId: 'env_x', keyId: admin.id, identity, generation: 1, name: 'x' })).toThrow(/not a pending/)
    const second = await box.computer('env_two')
    expect(() => box.mailbox.activate({ envId: 'env_three', keyId: second.keyId, identity, generation: 1, name: 'x' })).toThrow(/already binds env_two/)
  })
})

describe('RemoteAuth.setCaps', () => {
  it('replaces a live key\'s caps and drops the tickets minted under the old set', async () => {
    const box = await makeBox()
    const made = await box.auth.createKey({ name: 'pending', audience: 'client', caps: ['read'], createdBy: 'test' })
    const principal = (await box.auth.verifyToken(made.token))!
    const { ticket } = box.auth.mintTicket(principal)
    expect(box.auth.setCaps(made.key.id, ['device', 'operate']).caps).toEqual(['device', 'operate', 'read'])
    expect(box.auth.consumeTicket(ticket)).toBeNull()
    expect((await box.auth.verifyToken(made.token))!.caps).toEqual(['device', 'operate', 'read'])
    box.auth.revokeKey(made.key.id)
    expect(() => box.auth.setCaps(made.key.id, ['read'])).toThrow(/unknown key/)
  })
})

describe('devices.post', () => {
  it('checks the giver\'s signature before it reads the header', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const stranger = generateDeviceKeys()
    // Unbound address and a forged signature: the signature is what it names.
    expect(() => box.mailbox.post(box.letter(pc, 1, 'manifest', { signer: stranger, over: { to: 'env_nowhere' } }))).toThrow(/did not sign/)
    const good = box.letter(pc, 1)
    expect(() => box.mailbox.post({ ...good, signature: box.letter(pc, 2).signature })).toThrow(/did not sign/)
    expect(() => box.mailbox.post({ ...good, header: { ...good.header, seq: 7 } })).toThrow(/did not sign/)
    expect(queue(box.db, 'env_pc')).toEqual([])
  })

  it('refuses an unbound or retired computer, another key or generation, a seq not above the last, and a letter over the cap', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    expect(() => box.mailbox.post(box.letter(pc, 1, 'manifest', { over: { to: 'env_nowhere' } }))).toThrow(/not bound/)
    expect(() => box.mailbox.post(box.letter(pc, 1, 'manifest', { over: { toKey: generateDeviceKeys().sealPublic } }))).toThrow(/another key/)
    expect(() => box.mailbox.post(box.letter(pc, 1, 'manifest', { over: { generation: 2 } }))).toThrow(/generation 2/)
    expect(box.mailbox.post(box.letter(pc, 5))).toEqual({ ok: true, superseded: 0 })
    expect(() => box.mailbox.post(box.letter(pc, 5))).toThrow(/not above 5/)
    expect(() => box.mailbox.post(box.letter(pc, 4))).toThrow(/not above 5/)
    const big = box.letter(pc, 6, 'manifest', { grants: [{ service: 'meta', account: 'big', kind: 'static' }], secret: 'x'.repeat(LETTER_CAP) })
    expect(() => box.mailbox.post(big)).toThrow(/over 262144 bytes/)
    const { removalId } = box.farewell.remove('env_pc')
    expect(() => box.mailbox.post(box.letter(pc, 6))).toThrow(/only its remove letter/)
    box.farewell.handle(box.principalOf(pc), { op: 'receipt', removalId, signature: box.receipt(pc, removalId) })
    expect(() => box.mailbox.post(box.letter(pc, 7, 'remove'))).toThrow(/retired/)
  })

  it('the newest letter supersedes the queue, lands in device_state and is pushed to the computer', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    box.mailbox.post(box.letter(pc, 1, 'activate'))
    // Delivery waits on nothing: an unacked letter is superseded too.
    expect(box.mailbox.post(box.letter(pc, 2))).toEqual({ ok: true, superseded: 1 })
    expect(box.mailbox.post(box.letter(pc, 3))).toEqual({ ok: true, superseded: 1 })
    expect(queue(box.db, 'env_pc')).toEqual([3])
    expect(box.mailbox.newest('env_pc')).toMatchObject({ seq: 3, kind: 'manifest' })
    expect(box.bindings.get('env_pc')).toMatchObject({ seq: 3, kind: 'manifest', state: 'active' })
    expect(box.toComputer.map((p) => p.push)).toEqual([1, 2, 3].map((seq) => ({ push: 'device-mail', seq })))
    expect(box.mailbox.mail('env_pc')).toEqual({ letter: box.mailbox.newest('env_pc')!.letter, removal: null })
  })

  it('a stop makes the binding stopped and a manifest after it active again', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    box.mailbox.post(box.letter(pc, 1))
    box.mailbox.post(box.letter(pc, 2, 'stop'))
    expect(box.bindings.get('env_pc')!.state).toBe('stopped')
    box.mailbox.post(box.letter(pc, 3))
    expect(box.bindings.get('env_pc')!.state).toBe('active')
  })
})

describe('devices.ack and the queue', () => {
  it('a signed ack lands on the binding, empties the queue and tells the giver; device_state survives', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const sent = box.letter(pc, 1)
    box.mailbox.post(sent)
    box.toGiver.length = 0
    expect(() => box.mailbox.ack('env_pc', box.ack(pc, sent.header, generateDeviceKeys()))).toThrow(/not signed/)
    expect(() => box.mailbox.ack('env_other', box.ack(pc, sent.header))).toThrow(/not live/)
    expect(() => box.mailbox.ack('env_pc', box.ack(pc, { ...sent.header, seq: 9 }))).toThrow(/no letter 9/)
    expect(() => box.mailbox.ack('env_pc', box.ack(pc, { ...sent.header, id: 'another' }))).toThrow(/another letter/)
    const ack = box.ack(pc, sent.header)
    expect(box.mailbox.ack('env_pc', ack)).toEqual({ ok: true })
    expect(box.bindings.get('env_pc')).toMatchObject({ ack, lastSeenAt: box.clock.now })
    expect(box.toGiver).toEqual([{ push: 'device-acked', envId: 'env_pc' }])
    expect(queue(box.db, 'env_pc')).toEqual([])
    expect(box.mailbox.mail('env_pc').letter).toEqual(sent)
  })

  it('a sweep of the queue never touches device_state', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const sent = box.letter(pc, 1)
    box.mailbox.post(sent)
    box.bindings.noteAck('env_pc', box.ack(pc, sent.header))
    expect(box.mailbox.sweepQueue()).toBe(1)
    expect(queue(box.db, 'env_pc')).toEqual([])
    expect(box.mailbox.newest('env_pc')!.letter).toEqual(sent)
  })
})

describe('admittedFor: the box filters by the newest verified header', () => {
  it('an active manifest admits its grants; no manifest, a stop, a removal or a lapsed lease admit nothing; a host bound to nothing is unfiltered', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    expect(box.mailbox.admittedFor('env_mac')).toBeUndefined()
    expect(box.mailbox.admittedFor('env_pc')).toBeNull()
    box.mailbox.post(box.letter(pc, 1, 'activate'))
    expect(box.mailbox.admittedFor('env_pc')).toBeNull()
    box.mailbox.post(box.letter(pc, 2))
    expect(box.mailbox.admittedFor('env_pc')).toEqual([{ service: 'codex', account: 'acct-1', kind: 'access', owner: 'env_box' }])
    box.clock.now += 31 * 86_400_000
    expect(box.mailbox.admittedFor('env_pc')).toBeNull()
    box.mailbox.post(box.letter(pc, 3))
    expect(box.mailbox.admittedFor('env_pc')).not.toBeNull()
    box.mailbox.post(box.letter(pc, 4, 'stop'))
    expect(box.mailbox.admittedFor('env_pc')).toBeNull()
    box.mailbox.post(box.letter(pc, 5))
    box.farewell.remove('env_pc')
    expect(box.mailbox.admittedFor('env_pc')).toBeNull()
  })
})
