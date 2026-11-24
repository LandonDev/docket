import { afterEach, describe, expect, it } from 'vitest'
import { generateDeviceKeys, signBytes } from '@shared/devices/keys'
import { PeerCalls, PeerOfflineError } from '../remote/peerCalls'
import { WorkSettingsStore } from '../work/settings'
import { ownerDesktops } from '../work/scope'
import { reachableHosts } from '../work/office/files/tools'
import { deviceBindingsHook, liveBinding, mayRoute, proofBytes } from './binding'
import { makeBox } from './boxTestkit'

afterEach(() => {
  deviceBindingsHook.current = null
})

describe('a device socket proves itself', () => {
  it('is refused everything but devices.challenge and peer.register until its proof verifies', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const p = box.principalOf(pc)
    for (const method of ['accounts.pull', 'devices.mail', 'devices.ack', 'peer.reply', 'relay.frames']) expect(box.bindings.socketRefusal(p, 1, method)).toMatch(/needs this socket's proof/)
    expect(box.bindings.socketRefusal(p, 1, 'devices.challenge')).toBeNull()
    expect(box.bindings.socketRefusal(p, 1, 'peer.register')).toBeNull()
    expect(box.prove(pc, 1)).toBeNull()
    expect(box.bindings.provedEnv(1)).toBe('env_pc')
    expect(box.bindings.socketRefusal(p, 1, 'accounts.pull')).toBeNull()
    // The proof is the connection's own: another socket of the same key is still unproved.
    expect(box.bindings.socketRefusal(p, 2, 'accounts.pull')).not.toBeNull()
    box.bindings.dropConnection(1)
    expect(box.bindings.provedEnv(1)).toBeNull()
  })

  it("a window's socket opened with a ticket the proved socket minted starts proved; a bearer's own ticket does not", async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const p = box.principalOf(pc)
    expect(box.prove(pc, 1)).toBeNull()
    const window = box.auth.consumeTicket(box.auth.mintTicket(p, box.bindings.provedEnv(1)!).ticket)!
    expect(window.provedEnv).toBe('env_pc')
    expect(box.bindings.adoptProof(2, window)).toBe(true)
    expect(box.bindings.socketRefusal(window, 2, 'session.create')).toBeNull()
    // A stolen bearer mints at /api/ticket: no proof rides it.
    const stolen = box.auth.consumeTicket(box.auth.mintTicket(p).ticket)!
    expect(box.bindings.adoptProof(3, stolen)).toBe(false)
    expect(box.bindings.socketRefusal(stolen, 3, 'session.create')).toMatch(/needs this socket's proof/)
    // A proved ticket outlives no Remove: the binding must still be live.
    const later = box.auth.mintTicket(p, 'env_pc').ticket
    box.farewell.remove('env_pc')
    expect(box.auth.consumeTicket(later)).toBeNull()
    expect(box.bindings.adoptProof(4, { ...window })).toBe(false)
  })

  it('refuses a proof by another key, one with no challenge, one spent already, and one for another env id', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const p = box.principalOf(pc)
    const { nonce } = box.bindings.challenge(1, p)
    const forged = signBytes(generateDeviceKeys().signPrivate, proofBytes(nonce, 'env_pc', pc.keyId))
    expect(box.bindings.registerRefusal(1, p, { from: 'env_pc', proof: forged })).toMatch(/does not verify/)
    // The nonce went with that try.
    const good = signBytes(pc.keys.signPrivate, proofBytes(nonce, 'env_pc', pc.keyId))
    expect(box.bindings.registerRefusal(1, p, { from: 'env_pc', proof: good })).toMatch(/devices.challenge on this socket first/)
    expect(box.bindings.registerRefusal(3, p, { from: 'env_pc', proof: good })).toMatch(/devices.challenge on this socket first/)
    box.bindings.challenge(1, p)
    expect(box.bindings.registerRefusal(1, p, { from: 'env_other' })).toMatch(/binds env_pc, not env_other/)
    expect(() => box.bindings.challenge(1, { ...p, caps: ['admin'] })).toThrow(/given computer's/)
  })

  it('a second key claiming a bound env id is refused, whatever it holds; an unbound env id registers as before', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const admin = { kind: 'remote' as const, keyId: box.giverKey.id, name: 'Mac', audience: 'client' as const, caps: ['admin' as const] }
    expect(box.bindings.registerRefusal(1, admin, { from: 'env_pc' })).toMatch(/another key may not register/)
    expect(box.bindings.registerRefusal(1, admin, { from: 'env_mac' })).toBeNull()
    const two = await box.computer('env_two')
    const p2 = box.principalOf(two)
    const { nonce } = box.bindings.challenge(1, p2)
    expect(box.bindings.registerRefusal(1, p2, { from: 'env_pc', proof: signBytes(two.keys.signPrivate, proofBytes(nonce, 'env_pc', two.keyId)) })).toMatch(/bound to another key/)
    void pc
  })

  it("a pending claim shuts no host out of its own id: it registers and routes as before", async () => {
    const box = await makeBox()
    const made = await box.auth.createKey({ name: 'x', audience: 'client', caps: ['pending'], createdBy: 'test' })
    const keys = generateDeviceKeys()
    expect(box.bindings.bindPending({ envId: 'env_mac', keyId: made.key.id, identity: { signPublic: keys.signPublic, sealPublic: keys.sealPublic }, generation: 1, name: 'x' }).ok).toBe(true)
    const admin = { kind: 'remote' as const, keyId: box.giverKey.id, name: 'Mac', audience: 'client' as const, caps: ['admin' as const] }
    expect(box.bindings.registerRefusal(1, admin, { from: 'env_mac' })).toBeNull()
    expect(box.bindings.mayRoute('env_mac')).toBe(true)
  })

  it('a device speaks only for the env id its socket proved (headroom, pulls); another key speaks for the host it names', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    const p = box.principalOf(pc)
    expect(box.bindings.speakerFor(1, p, 'env_mac')).toBeNull()
    expect(box.prove(pc, 1)).toBeNull()
    expect(box.bindings.speakerFor(1, p, 'env_mac')).toBe('env_pc')
    const admin = { kind: 'remote' as const, keyId: box.giverKey.id, name: 'Mac', audience: 'client' as const, caps: ['admin' as const] }
    expect(box.bindings.speakerFor(2, admin, 'env_mac')).toBe('env_mac')
  })

  it('a stopped computer still proves; a removing one does not', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    box.mailbox.post(box.letter(pc, 1, 'stop'))
    expect(box.prove(pc, 1)).toBeNull()
    box.farewell.remove('env_pc')
    expect(box.prove(pc, 2)).toMatch(/is removing/)
    // and a key in farewell is refused everything on a socket
    expect(box.bindings.socketRefusal(box.principalOf(pc), 1, 'peer.register')).toMatch(/farewell/)
  })
})

describe('liveBinding and every route', () => {
  it('is false once the computer is removed, and each route drops it', async () => {
    const box = await makeBox()
    const pc = await box.computer()
    deviceBindingsHook.current = box.bindings
    expect(liveBinding('env_pc')).toBe(true)
    expect(mayRoute('env_pc')).toBe(true)
    expect(liveBinding('env_mac')).toBe(false)
    expect(mayRoute('env_mac')).toBe(true)

    // Work's settings, ownerDesktops, Files reach and the bridge, with the computer live.
    const rows = new Map<string, string>()
    const store = {
      getSetting: () => null,
      setSetting: () => {},
      getWorkspaceWorkSettings: (id: string) => rows.get(id) ?? null,
      setWorkspaceWorkSettings: (id: string, json: string) => (rows.set(id, json), true)
    }
    const settings = new WorkSettingsStore(store, mayRoute)
    settings.setWorkspace('w1', { mayUseDesktop: ['env_mac', 'env_pc'] })
    const ctx = { host: 'env_box', scope: { workspaceId: 'w1' }, settings: { workspace: (id: string) => settings.workspace(id) } } as unknown as Parameters<typeof reachableHosts>[0]
    const calls = new PeerCalls('env_box', () => {})
    calls.setRoutable(mayRoute)
    calls.register({ connection: 7, keyId: pc.keyId, send: () => {} }, { from: 'env_pc', offers: ['mac-bridge'] })
    expect(settings.workspace('w1').mayUseDesktop).toEqual(['env_mac', 'env_pc'])
    expect(ownerDesktops({ id: 'env_box', platform: 'linux' }, [{ id: 'env_pc', platform: 'win32' }], [{ id: 'env_mac' }], mayRoute)).toEqual(['env_pc', 'env_mac'])
    expect(reachableHosts(ctx)).toEqual(['env_box', 'env_mac', 'env_pc'])
    expect(calls.registeredIds('mac-bridge')).toEqual(['env_pc'])

    const { removalId } = box.farewell.remove('env_pc')
    expect(liveBinding('env_pc')).toBe(false)
    expect(settings.workspace('w1').mayUseDesktop).toEqual(['env_mac'])
    expect(ownerDesktops({ id: 'env_box', platform: 'linux' }, [{ id: 'env_pc', platform: 'win32' }], [{ id: 'env_mac' }], mayRoute)).toEqual(['env_mac'])
    expect(reachableHosts(ctx)).toEqual(['env_box', 'env_mac'])
    expect(calls.registeredIds('mac-bridge')).toEqual([])
    expect(calls.online('env_pc')).toBe(false)
    await expect(calls.call('env_pc', 'mac.run', {} as never, 1000)).rejects.toBeInstanceOf(PeerOfflineError)

    box.farewell.handle(box.principalOf(pc), { op: 'receipt', removalId, signature: box.receipt(pc, removalId) })
    expect(box.bindings.get('env_pc')!.state).toBe('retired')
    expect(liveBinding('env_pc')).toBe(false)
    expect(mayRoute('env_pc')).toBe(false)
    expect(settings.workspace('w1').mayUseDesktop).toEqual(['env_mac'])
  })
})

describe('a removed computer set up again', () => {
  it('comes back only under a new identity at a higher generation, never on its env id alone', async () => {
    const box = await makeBox()
    const pc = await box.computer('env_pc')
    const { removalId } = box.farewell.remove('env_pc')
    box.farewell.handle(box.principalOf(pc), { op: 'receipt', removalId, signature: box.receipt(pc, removalId) })
    expect(box.bindings.get('env_pc')!.state).toBe('retired')
    expect(box.bindings.nextGeneration('env_pc')).toBe(2)
    const fresh = generateDeviceKeys()
    const identity = { signPublic: fresh.signPublic, sealPublic: fresh.sealPublic }
    const old = { signPublic: pc.keys.signPublic, sealPublic: pc.keys.sealPublic }
    // The old identity, or the same generation, is refused.
    expect(box.bindings.bind({ envId: 'env_pc', keyId: 'K2', identity: old, generation: 2, name: 'PC' })).toMatchObject({ ok: false })
    expect(box.bindings.bind({ envId: 'env_pc', keyId: 'K2', identity, generation: 1, name: 'PC' })).toMatchObject({ ok: false })
    expect(box.bindings.bindPending({ envId: 'env_pc', keyId: 'K2', identity: old, generation: 2, name: 'PC' })).toMatchObject({ ok: false })
    // A new identity at generation 2: a pending row, with nothing of the old one's letters.
    const pending = box.bindings.bindPending({ envId: 'env_pc', keyId: 'K2', identity, generation: 2, name: 'PC' })
    expect(pending.ok).toBe(true)
    expect(box.bindings.get('env_pc')).toMatchObject({ state: 'pending', generation: 2, seq: null, keyId: 'K2' })
    expect(box.mailbox.newest('env_pc')).toBeNull()
    // A pending row blocks no route (a claim under another host's id would shut it out); a pending key registers nowhere.
    expect(box.bindings.mayRoute('env_pc')).toBe(true)
    // A second claim on the same env id while one is pending is refused; Allow makes it active.
    expect(box.bindings.bindPending({ envId: 'env_pc', keyId: 'K3', identity, generation: 2, name: 'PC' })).toMatchObject({ ok: false })
    expect(box.bindings.bind({ envId: 'env_pc', keyId: 'K2', identity, generation: 2, name: 'PC' })).toMatchObject({ ok: true, binding: { state: 'active' } })
  })
})
