import { afterEach, describe, expect, it, vi } from 'vitest'
import { capabilityRefusal, type Principal } from '@shared/capabilities'
import type { DevicesPush, SetupItems } from '@shared/contract-devices'
import { openLetter } from '@shared/devices/envelope'
import { deriveLinkKeys, generateDeviceKeys, signBytes } from '@shared/devices/keys'
import { bundleDigest, claimBytes, parseSetupLink, SetupLinkError, setupWords } from '@shared/devices/setupLink'
import { makeBox } from '../boxTestkit'
import { GiverDevices } from '../giverDevices'
import { DeviceIdentities, memoryIdentityStore } from '../identity'
import type { Pins } from '../given'
import { SetupError, SetupPairings } from '../setupPairings'
import { SetupLinks, type LifeosGrant, type MakeLinkDeps } from './makeLink'
import { SetupRefused, SetupThisPc } from './useLink'

const ORIGIN = 'https://box.example'
const ALL: SetupItems = { accounts: true, lifeos: true, reader: true, folders: true }
// Fakes shaped like LifeOS's one-time codes (lifeosEnroll.ts checks this shape).
const LIFEOS_CODES = { desktop: `loe_${'D'.repeat(43)}`, tempcode: `loe_${'T'.repeat(43)}` }

const memoryStore = () => {
  const m = new Map<string, string>()
  return { m, getSetting: (k: string) => m.get(k) ?? null, setSetting: (k: string, v: string | null) => void (v === null ? m.delete(k) : m.set(k, v)) }
}
const memorySecrets = () => {
  const m = new Map<string, string>()
  return { m, read: (n: string) => m.get(n) ?? null, write: (n: string, raw: string) => void m.set(n, raw), clear: (n: string) => void m.delete(n) }
}

/** The box, the giver (a Mac) and one computer being set up, wired in memory; HTTP is a fake fetch onto the box's routes. */
const worlds: { pc: SetupThisPc }[] = []
async function makeWorld(opts: { platform?: NodeJS.Platform; lifeos?: LifeosGrant | null | 'throws'; envId?: string; consoleLogs?: boolean; taken?: (envId: string) => boolean } = {}) {
  const quiet = opts.consoleLogs ? undefined : () => {}
  const box = await makeBox()
  const setup = new SetupPairings(box.db, { auth: box.auth, bindings: box.bindings, toGiver: (p) => box.toGiver.push(p), taken: opts.taken, finishRemoval: (e) => void box.farewell.finish(e), now: () => box.clock.now, log: quiet })
  box.auth.setSetupHooks({ revoke: (id) => setup.revoke(id), sweep: () => setup.expire() })
  const calls: string[] = []
  /** The giver's admin link to the box (index.ts boxLink); `swap` lets a test be a box that lies. */
  const boxLink = {
    envId: 'env_box',
    swap: null as null | ((claim: Record<string, unknown>) => Record<string, unknown>),
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push(method)
      const p = params as Record<string, never>
      const answer = ((): unknown => {
        if (method === 'remote.status') return { origin: ORIGIN }
        if (method === 'remote.pairings.create') return setup.create({ ...(p.setup as { verifier: string; bundle: string; name: string }), createdBy: box.giverKey.id })
        if (method === 'remote.pairings.revoke') return box.auth.revokePairing(p.id)
        if (method === 'devices.setupProof') {
          const out = setup.proof(p.pairingId)
          return boxLink.swap && out.claim ? { claim: boxLink.swap(out.claim as unknown as Record<string, unknown>) } : out
        }
        if (method === 'devices.activate') {
          setup.expire()
          return box.mailbox.activate(params as never)
        }
        if (method === 'devices.post') return box.mailbox.post(p.letter)
        throw new Error(`no ${method}`)
      })()
      return answer as T
    }
  }
  const giverStore = memoryStore()
  const giverSecrets = memorySecrets()
  const giverPushes: DevicesPush[] = []
  const giverDevices = new GiverDevices({ store: giverStore, keys: () => box.giverKeys, source: { profiles: () => [], readSecret: () => null }, box: () => boxLink, log: quiet })
  const desktops: [string, string][] = []
  const giver = new SetupLinks({
    environmentId: 'env_mac',
    giverName: () => "Landon's MacBook",
    identity: () => ({ signPublic: box.giverKeys.signPublic, sealPublic: box.giverKeys.sealPublic }),
    box: () => boxLink,
    secrets: giverSecrets,
    store: giverStore,
    computers: giverDevices,
    lifeos: async () => {
      if (opts.lifeos === 'throws') throw new Error('LifeOS did not prepare the sign-in: Server Error')
      return opts.lifeos === undefined ? { enrollment: 'enr_1', owner: 'owner_1', codes: LIFEOS_CODES } : opts.lifeos
    },
    workOn: () => true,
    addDesktop: async (w, env) => void desktops.push([w, env]),
    push: (p) => giverPushes.push(p),
    now: () => box.clock.now,
    log: quiet
  })

  // The box's routes as listener.ts answers them.
  const fetch = vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body)
    try {
      let out: unknown
      if (path === '/api/setup/peek') out = setup.peek(body, '10.0.0.9')
      else if (path === '/api/setup/challenge') out = setup.challenge(body, '10.0.0.9')
      else if (path === '/api/setup/claim') out = await setup.claim(body, '10.0.0.9')
      else if (path === '/api/setup/status') {
        const principal = await box.auth.verifyToken(init.headers.authorization.replace('Bearer ', ''))
        if (!principal) return new Response(JSON.stringify({ error: 'invalid key' }), { status: 401 })
        out = setup.status(principal)
      } else return new Response('{}', { status: 404 })
      return new Response(JSON.stringify(out), { status: 200 })
    } catch (err) {
      if (err instanceof SetupError) return new Response(JSON.stringify({ error: err.message, ...err.extra }), { status: err.status })
      throw err
    }
  })

  const envId = opts.envId ?? 'env_pc'
  const identities = new DeviceIdentities(memoryIdentityStore())
  let pins: Pins | null = null
  const pcStore = memoryStore()
  const codes = (() => {
    let held: string | null = null
    return { read: () => held, write: (r: string) => void (held = r), clear: () => void (held = null) }
  })()
  const pcPushes: DevicesPush[] = []
  const installs: unknown[] = []
  const workSignIns: unknown[] = []
  const saved: { origin: string; key: string }[] = []
  const pc = new SetupThisPc({
    environmentId: envId,
    allowHttp: false,
    platform: opts.platform ?? 'win32',
    fetch: fetch as unknown as typeof globalThis.fetch,
    identity: identities,
    given: {
      pins: () => pins,
      pinGiver: async (input) => void (pins = { v: 1, ...input, at: box.clock.now }),
      abandon: async () => void (pins = null)
    },
    savedHosts: () => saved.map(() => ({ id: 'env_box' })),
    saveBox: async (origin, key) => void saved.push({ origin, key }),
    store: pcStore,
    codes,
    installLifeos: async (input) => (installs.push(input), { ok: true }),
    signInWork: async (input) => (workSignIns.push(input), { outcome: 'signed-in' }),
    setWork: () => {},
    addFolders: (paths) => paths,
    push: (p) => pcPushes.push(p),
    sleep: () => new Promise((ok) => setTimeout(ok, 1)),
    log: quiet
  })
  worlds.push({ pc })

  /** What the PC's given.ts does with its newest letter: open it against its pins and hand setup the extra. */
  const deliver = (lastSeq = 0) => {
    const { letter } = box.mailbox.mail(envId)
    const keys = identities.keys()
    const opened = openLetter(letter!, { envId, sealPublic: keys.sealPublic, sealPrivate: keys.sealPrivate, generation: pins!.generation, giver: pins!.giver.signPublic, lastSeq })
    if (!opened.ok) throw new Error(opened.reason)
    pc.onApplied(opened.header.kind as 'activate' | 'manifest', opened.body.extra)
    return opened
  }
  /** The giver hears the box's push about a claim. */
  const joined = async () => {
    const p = box.toGiver.find((x) => x.push === 'device-joined' && 'pairingId' in x && x.pairingId) as { pairingId: string } | undefined
    if (p) await giver.onJoined(p.pairingId)
  }
  const settle = () => new Promise((ok) => setTimeout(ok, 0))

  return { box, setup, boxLink, calls, giver, giverDevices, giverStore, giverSecrets, giverPushes, desktops, fetch, pc, pcStore, pcPushes, installs, workSignIns, saved, identities, codes, deliver, joined, settle, envId, pins: () => pins }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const w of worlds.splice(0)) w.pc.close()
})
const allowState = (w: { pc: SetupThisPc }) => w.pc.state()!.steps.find((s) => s.step === 'allow')!.state

describe('the setup link', () => {
  it('is https only; http only under the harness marker', () => {
    const secret = Buffer.alloc(32, 7)
    const link = `https://box.example/setup#v1.ABCDE-FGHJK.${secret.toString('base64url')}`
    expect(parseSetupLink(link)).toMatchObject({ origin: 'https://box.example', code: 'ABCDE-FGHJK' })
    const plain = link.replace('https:', 'http:')
    expect(() => parseSetupLink(plain)).toThrow(SetupLinkError)
    expect(parseSetupLink(plain, { allowHttp: true }).origin).toBe('http://box.example')
    expect(() => parseSetupLink('https://box.example/pair#ABCDE-FGHJK')).toThrow(/not a setup link/)
  })

  it('goes from Make link to Allow to the first manifest, LifeOS and folders', async () => {
    const w = await makeWorld()
    const { link, pairingId } = await w.giver.make({ name: 'Purdue laptop', items: ALL, workspaces: ['ws_work'], seeds: { appearance: { code: 'dark' } } })
    // The box never sees the secret; the giver's vault holds it until the link is used.
    expect(w.giverSecrets.m.size).toBe(1)
    const row = w.box.db.prepare(`SELECT setup FROM remote_pairings WHERE id = ?`).get(pairingId) as { setup: string }
    expect(row.setup).not.toContain(parseSetupLink(link).secret.toString('base64url'))

    const peek = await w.pc.peek(link)
    expect(peek).toMatchObject({ origin: ORIGIN, giver: "Landon's MacBook", items: ALL })
    // Peek moves nothing.
    expect(w.box.bindings.get('env_pc')).toBeNull()

    await w.pc.start(link)
    const binding = w.box.bindings.get('env_pc')!
    expect(binding.state).toBe('pending')
    expect(w.box.auth.getKey(binding.keyId)!.caps).toEqual(['pending', 'read'])
    expect(w.pins()!.generation).toBe(1)
    await w.joined()
    const allow = w.giverPushes.find((p) => p.push === 'device-allow') as { words: string[]; name: string }
    expect(allow.name).toBe('Purdue laptop')
    // Both screens show the same three words.
    expect(w.pc.state()!.words).toEqual(allow.words)

    await w.giver.allow(pairingId)
    expect(w.box.bindings.get('env_pc')!.state).toBe('active')
    expect(w.box.auth.getKey(binding.keyId)!.caps).toEqual(['approve', 'device', 'operate', 'read'])
    expect(w.giverSecrets.m.size).toBe(0)
    expect(w.desktops).toEqual([['ws_work', 'env_pc']])
    // The status ask sees it and the box environment is saved with the same key.
    await vi.waitFor(() => expect(allowState(w)).toBe('done'))
    expect(w.saved).toHaveLength(1)

    // The activate letter carries LifeOS's codes, sealed to the computer; no manifest goes before its ack.
    expect(w.box.mailbox.newest('env_pc')!.kind).toBe('activate')
    const opened = w.deliver()
    expect((opened.body.extra?.lifeos as { codes: unknown }).codes).toEqual(LIFEOS_CODES)
    await w.settle()
    expect(w.installs).toEqual([{ code: LIFEOS_CODES.desktop, owner: 'owner_1', reader: true }])
    expect(w.workSignIns).toEqual([{ code: LIFEOS_CODES.tempcode, owner: 'owner_1', attempt: expect.any(String) }])
    await w.giverDevices.acked('env_pc')
    expect(w.box.mailbox.newest('env_pc')!.kind).toBe('manifest')
    w.deliver(1)
    await w.pc.folders(['J:\\'])
    const state = w.pc.state()!
    expect(state.steps.map((s) => [s.step, s.state])).toEqual([['link', 'done'], ['allow', 'done'], ['accounts', 'done'], ['lifeos', 'done'], ['work', 'done'], ['folders', 'done']])
    expect(state.done).toBe(true)
    expect(state.seeds).toEqual({ appearance: { code: 'dark' }, defaultModels: undefined })
    expect(w.codes.read()).toBeNull()
  })

  it('records what setup itself signed in, for Remove to take back alone, and forgets it with the progress (F16)', async () => {
    const w = await makeWorld()
    const deps = (w.pc as unknown as { deps: { installLifeos: unknown; signInWork: unknown } }).deps
    deps.installLifeos = async () => ({ ok: true, signedIn: true })
    deps.signInWork = async () => ({ outcome: 'signed-in', token: 'digest-1' })
    const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    await w.joined()
    await w.giver.allow(pairingId)
    await vi.waitFor(() => expect(allowState(w)).toBe('done'))
    w.deliver()
    await vi.waitFor(() => expect(JSON.parse(w.pcStore.getSetting('devices.setup.gave') ?? '{}')).toEqual({ reader: true, work: 'digest-1' }))
    await w.pc.halt()
    w.pc.forget()
    expect(w.pcStore.getSetting('devices.setup.gave')).toBeNull()
    expect(w.pc.state()).toBeNull()
  })

  it("Work's redemption carries an attempt saved before its first try, and Retry sends the same one (F20)", async () => {
    const w = await makeWorld()
    const tries: unknown[] = []
    ;(w.pc as unknown as { deps: { signInWork: unknown } }).deps.signInWork = async (input: { attempt?: string }) => {
      tries.push(input.attempt)
      return tries.length === 1 ? { outcome: 'failed', reason: 'LifeOS is unreachable' } : { outcome: 'signed-in' }
    }
    const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    await w.joined()
    await w.giver.allow(pairingId)
    await vi.waitFor(() => expect(allowState(w)).toBe('done'))
    w.deliver()
    await vi.waitFor(() => expect(w.pc.state()!.steps.find((s) => s.step === 'work')!.state).toBe('failed'))
    const attempt = JSON.parse(w.codes.read()!).attempt as string
    expect(attempt).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await w.pc.retry('work')
    await vi.waitFor(() => expect(w.pc.state()!.steps.find((s) => s.step === 'work')!.state).toBe('done'))
    expect(tries).toEqual([attempt, attempt])
  })

  it('a second Mac pastes the same link and gets the same steps, less LifeOS\'s install', async () => {
    const w = await makeWorld({ platform: 'darwin', envId: 'env_mac2' })
    const { link, pairingId } = await w.giver.make({ name: 'Studio Mac', items: ALL, workspaces: [] })
    await w.pc.start(link)
    await w.joined()
    await w.giver.allow(pairingId)
    await vi.waitFor(() => expect(allowState(w)).toBe('done'))
    w.deliver()
    await w.settle()
    expect(w.pc.state()!.steps.map((s) => s.step)).toEqual(['link', 'allow', 'accounts', 'work', 'folders'])
    expect(w.installs).toEqual([])
    expect(w.workSignIns).toHaveLength(1)
  })

  it("says LifeOS did not prepare the sign-in when asking it failed, and that the Mac is not signed in only when it is not", async () => {
    for (const [lifeos, words] of [
      ['throws', "LifeOS did not prepare a sign-in for this computer on Landon's MacBook. Make a new link there."],
      [null, "Landon's MacBook's Work is not signed in to LifeOS. Sign in there, then make a new link."]
    ] as const) {
      const w = await makeWorld({ lifeos })
      const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
      await w.pc.start(link)
      await w.joined()
      await w.giver.allow(pairingId)
      await vi.waitFor(() => expect(allowState(w)).toBe('done'))
      w.deliver()
      await w.settle()
      const steps = w.pc.state()!.steps
      expect(steps.find((s) => s.step === 'lifeos')).toMatchObject({ state: 'failed', reason: words })
      expect(steps.find((s) => s.step === 'work')).toMatchObject({ state: 'failed', reason: words })
      expect(w.installs).toEqual([])
    }
  })

  it('says when a used link was used, and that an ended link ended', async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    // The claimer itself, while its claim may be recovered, hears that it is set up (F21).
    await expect(w.pc.peek(link)).rejects.toThrow(/set up already/)
    w.box.clock.now += 6 * 60_000
    await expect(w.pc.peek(link)).rejects.toThrow(/set up already|was used on/)
    w.box.clock.now -= 6 * 60_000
    // Another computer with the same link: the box says it was used.
    const other = await makeWorld()
    other.fetch.mockImplementation(w.fetch.getMockImplementation()!)
    await expect(other.pc.peek(link)).rejects.toThrow(/was used on/)

    const e = await makeWorld()
    const made = await e.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    e.box.clock.now += 16 * 60_000
    await expect(e.pc.peek(made.link)).rejects.toThrow(/has ended/)
    e.giver.sweep()
    expect(e.giverSecrets.m.size).toBe(0)
  })

  it('a wrong secret opens nothing', async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const wrong = link.replace(/\.[A-Za-z0-9_-]{43}$/, `.${Buffer.alloc(32, 1).toString('base64url')}`)
    await expect(w.pc.peek(wrong)).rejects.toThrow(/does not open/)
    await expect(w.pc.start(wrong)).rejects.toThrow(/does not open/)
    expect(w.box.bindings.get('env_pc')).toBeNull()
  })

  it("a link pasted under another origin than its bundle's box is refused, and no setup request follows a redirect (F22)", async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const moved = link.replace(ORIGIN, 'https://other.example')
    await expect(w.pc.peek(moved)).rejects.toThrow(/another box/)
    expect(w.fetch.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.redirect === 'error')).toBe(true)
    expect(w.box.bindings.get('env_pc')).toBeNull()
  })

  it('a caller with the code alone cannot claim: the verifier signature is checked before the claim', async () => {
    const w = await makeWorld()
    const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const { code } = parseSetupLink(link)
    const { bundle } = w.setup.peek({ code }, '1.1.1.1')
    const { challenge } = w.setup.challenge({ code }, '1.1.1.1')
    const thief = generateDeviceKeys()
    const identity = { signPublic: thief.signPublic, sealPublic: thief.sealPublic }
    const fields = { origin: ORIGIN, pairingId, bundleDigest: bundleDigest(bundle), identity, envId: 'env_thief', challenge }
    // Without the secret it can only sign with a verifier of its own making.
    const guess = deriveLinkKeys(Buffer.alloc(32, 9)).verifier.private
    const body = { code, origin: ORIGIN, envId: 'env_thief', identity, challenge, proof: { verifierSig: signBytes(guess, claimBytes(fields)), deviceSig: signBytes(thief.signPrivate, claimBytes(fields)) } }
    await expect(w.setup.claim(body, '1.1.1.1')).rejects.toThrow(/proof does not verify/)
    expect(w.box.db.prepare(`SELECT consumed_at FROM remote_pairings WHERE id = ?`).get(pairingId)).toEqual({ consumed_at: null })
    expect(w.box.bindings.get('env_thief')).toBeNull()
    // The legacy exchange refuses a setup link's code outright.
    await expect(w.box.auth.exchange(code, { kind: 'key' })).rejects.toThrow(/invalid or expired/)
  })

  it('the giver refuses an identity the box swapped in, and the pending key ends', async () => {
    const w = await makeWorld()
    const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    const planted = generateDeviceKeys()
    w.boxLink.swap = (claim) => ({ ...claim, identity: { signPublic: planted.signPublic, sealPublic: planted.sealPublic } })
    await w.joined()
    expect(w.giverPushes.some((p) => p.push === 'device-allow')).toBe(false)
    expect(w.giverPushes.find((p) => p.push === 'device-link')).toMatchObject({ link: { state: 'refused' } })
    const keyId = (w.setup.proof(pairingId).claim!).keyId
    expect(w.box.auth.getKey(keyId)!.revokedAt).not.toBeNull()
    expect(w.box.bindings.get('env_pc')).toBeNull()
    await expect(w.giver.allow(pairingId)).rejects.toThrow(/Nothing waits/)
  })

  it('without Allow nothing moves, and the pending key ends with the link', async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    await w.joined()
    const keyId = w.box.bindings.get('env_pc')!.keyId
    const principal = { kind: 'remote', keyId, name: 'PC', audience: 'client', caps: ['pending', 'read'] } as const
    // A pending key reaches nothing but its own setup on a socket.
    expect(capabilityRefusal(principal.caps as never, { method: 'accounts.pull' } as never)).toMatch(/waits for Allow/)
    expect(capabilityRefusal(principal.caps as never, { method: 'devices.mail' } as never)).toBeNull()
    expect(w.box.mailbox.admittedFor('env_pc')).toBeNull()
    expect(() => w.box.mailbox.post(w.box.letter({ envId: 'env_pc', keys: w.identities.keys(), generation: 1 } as never, 1))).toThrow(/pending/)
    w.box.clock.now += 16 * 60_000
    await vi.waitFor(() => expect(allowState(w)).toBe('failed'))
    expect(w.box.auth.getKey(keyId)!.revokedAt).not.toBeNull()
    expect(w.box.bindings.get('env_pc')).toBeNull()
    expect(w.pc.state()!.steps.find((s) => s.step === 'allow')).toMatchObject({ state: 'failed' })
    expect(w.pins()).toBeNull()
    expect(w.giverDevices.list()).toEqual([])
  })

  it('Cancel ends the pairing, the pending key and the claim, and puts back a removed computer\'s row', async () => {
    const w = await makeWorld()
    // This install was set up before and removed: its retired row stays retired after a cancelled setup.
    const old = await w.box.computer('env_pc')
    const { removalId } = w.box.farewell.remove('env_pc')
    w.box.farewell.handle(w.box.principalOf(old), { op: 'receipt', removalId, signature: w.box.receipt(old, removalId) })
    const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    const pending = w.box.bindings.get('env_pc')!
    expect(pending).toMatchObject({ state: 'pending', generation: 2 })
    await w.giver.cancel(pairingId)
    expect(w.box.auth.getKey(pending.keyId)!.revokedAt).not.toBeNull()
    expect(w.box.bindings.get('env_pc')).toMatchObject({ state: 'retired', generation: 1, keyId: old.keyId })
    expect(w.giverSecrets.m.size).toBe(0)
    await expect(w.pc.peek(link)).rejects.toThrow()
  })

  it('a lost claim reply: the same device gets the same key id back under a new secret', async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const real = w.fetch.getMockImplementation()!
    let lost = 0
    w.fetch.mockImplementation(async (url, init) => {
      const res = await real(url, init)
      if (new URL(url).pathname === '/api/setup/claim' && lost++ === 0) throw new TypeError('fetch failed')
      return res
    })
    await w.pc.start(link)
    expect(lost).toBe(2)
    const binding = w.box.bindings.get('env_pc')!
    expect(w.pins()!.boxKey.startsWith(`tc_${binding.keyId}.`)).toBe(true)
    expect(await w.box.auth.verifyToken(w.pins()!.boxKey)).not.toBeNull()
    expect(w.box.auth.listKeys().filter((k) => k.caps.includes('pending'))).toHaveLength(1)
  })

  it('a claim replayed after Allow, or past the lost-reply window, never re-keys the computer', async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const real = w.fetch.getMockImplementation()!
    let captured: { url: string; init: RequestInit } | null = null
    w.fetch.mockImplementation(async (url, init) => {
      if (new URL(url).pathname === '/api/setup/claim') captured = { url, init: { ...init } }
      return real(url, init)
    })
    await w.pc.start(link)
    const keyId = w.box.bindings.get('env_pc')!.keyId
    const replay = async () => {
      const body = JSON.parse(String(captured!.init.body))
      return w.setup.claim(body, '10.1.1.1')
    }
    // Before Allow, past the five minutes a lost reply could take: refused.
    w.box.clock.now += 6 * 60_000
    await expect(replay()).rejects.toThrow(/was used/)
    w.box.clock.now -= 6 * 60_000
    w.box.bindings.bind({ envId: 'env_pc', keyId, identity: w.box.bindings.get('env_pc')!.identity, generation: 1, name: 'PC' })
    expect(w.box.bindings.get('env_pc')!.state).toBe('active')
    await expect(replay()).rejects.toThrow(/was used/)
    expect(await w.box.auth.verifyToken(w.pins()!.boxKey)).not.toBeNull()
  })

  it("refuses a claim under an env id that is another host's (the giver's, the box's), and binds nothing", async () => {
    const w = await makeWorld({ envId: 'env_mac', taken: (envId) => envId === 'env_mac' || envId === 'env_box' })
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await expect(w.pc.start(link)).rejects.toThrow()
    expect(w.box.bindings.get('env_mac')).toBeNull()
    expect(w.box.auth.listKeys().filter((k) => k.caps.includes('pending'))).toHaveLength(0)
  })

  it('after Start fresh, a new link sets the same install up again at once: the removal that waits for a receipt ends', async () => {
    const w = await makeWorld()
    const old = await w.box.computer('env_pc')
    w.box.farewell.remove('env_pc')
    // The install pressed Start fresh: its identity is new and no receipt will come.
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    expect(w.box.bindings.get('env_pc')).toMatchObject({ state: 'pending', generation: 2 })
    expect(w.box.auth.getKey(old.keyId)!.revokedAt).not.toBeNull()
    expect(w.box.farewell.inFarewell(old.keyId)).toBe(false)
    expect(w.box.toGiver).toContainEqual({ push: 'device-gone', envId: 'env_pc' })
  })

  it('a claim replayed while Allow lands during its hash never re-keys the allowed computer (F18)', async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const real = w.fetch.getMockImplementation()!
    let captured: string | null = null
    w.fetch.mockImplementation(async (url, init) => {
      if (new URL(url).pathname === '/api/setup/claim') captured = String(init?.body)
      return real(url, init)
    })
    await w.pc.start(link)
    const binding = w.box.bindings.get('env_pc')!
    const prepare = w.box.auth.prepareBearer.bind(w.box.auth)
    w.box.auth.prepareBearer = async () => {
      const out = await prepare()
      w.box.bindings.bind({ envId: 'env_pc', keyId: binding.keyId, identity: binding.identity, generation: binding.generation, name: 'PC' })
      return out
    }
    await expect(w.setup.claim(JSON.parse(captured!), '10.1.1.2')).rejects.toThrow(/was used/)
    expect(await w.box.auth.verifyToken(w.pins()!.boxKey)).not.toBeNull()
  })

  it('rate-limits a code however it is asked', async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const { code } = parseSetupLink(link)
    for (let i = 0; i < 10; i++) w.setup.peek({ code }, `10.0.0.${i}`)
    expect(() => w.setup.peek({ code }, '10.9.9.9')).toThrow(/too many tries/)
    // And an address that guesses codes.
    for (let i = 0; i < 10; i++) expect(() => w.setup.peek({ code: 'ZZZZZ-ZZZZZ' }, '7.7.7.7')).toThrow(/no such setup link/)
    expect(() => w.setup.peek({ code }, '7.7.7.7')).toThrow(/too many tries/)
  })

  it('two Allows at once join the computer once, and a Cancel during Allow waits and changes nothing (F11)', async () => {
    let mints = 0
    const w = await makeWorld()
    ;(w.giver as unknown as { deps: { lifeos: () => Promise<LifeosGrant> } }).deps.lifeos = async () => ({ enrollment: `enr_${++mints}`, owner: 'owner_1', codes: LIFEOS_CODES })
    const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    await w.joined()
    const first = w.giver.allow(pairingId)
    await expect(w.giver.allow(pairingId)).rejects.toThrow(/Nothing waits/)
    const cancel = w.giver.cancel(pairingId)
    await first
    expect(await cancel).toEqual({ ok: false })
    expect(mints).toBe(1)
    expect(w.giverDevices.list()).toHaveLength(1)
    expect(w.giverDevices.list()[0]).toMatchObject({ enrollments: ['enr_1'], seq: 1 })
    expect(w.box.bindings.get('env_pc')!.state).toBe('active')
  })

  it('an Allow a crash cut short after the box joined the computer finishes at the next link up, and owes the lost enrollment (F11)', async () => {
    let mints = 0
    const w = await makeWorld()
    ;(w.giver as unknown as { deps: { lifeos: () => Promise<LifeosGrant> } }).deps.lifeos = async () => ({ enrollment: `enr_${++mints}`, owner: 'owner_1', codes: LIFEOS_CODES })
    const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    await w.joined()
    const add = w.giverDevices.add.bind(w.giverDevices)
    w.giverDevices.add = () => {
      throw new Error('crash')
    }
    await expect(w.giver.allow(pairingId)).rejects.toThrow('crash')
    expect(w.box.bindings.get('env_pc')!.state).toBe('active')
    expect(w.giverDevices.list()).toEqual([])
    w.giverDevices.add = add
    // The next start: a new SetupLinks on the same store and vault.
    const again = new SetupLinks({ ...(w.giver as unknown as { deps: MakeLinkDeps }).deps })
    expect(w.giverSecrets.m.size).toBe(1)
    await again.resume()
    expect(w.giverDevices.list()[0]).toMatchObject({ envId: 'env_pc', enrollments: ['enr_2'] })
    expect(w.giverDevices.owedRevokes()).toEqual([{ enrollment: 'enr_1', name: 'PC' }])
    expect(w.box.mailbox.newest('env_pc')!.kind).toBe('activate')
    expect(again.links()).toEqual([])
    expect(w.giverSecrets.m.size).toBe(0)
  })

  it("a claim whose push the giver missed is found at the box link's next up (F21)", async () => {
    const w = await makeWorld()
    const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    // The giver never heard device-joined: its link was down.
    expect(w.giverPushes.some((p) => p.push === 'device-allow')).toBe(false)
    await w.giver.resume()
    expect(w.giverPushes.find((p) => p.push === 'device-allow')).toMatchObject({ pairingId })
  })

  it('a PC that lost every claim reply resumes the same claim from the same link (F21)', async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const real = w.fetch.getMockImplementation()!
    let lose = true
    w.fetch.mockImplementation(async (url, init) => {
      const res = await real(url, init)
      if (new URL(url).pathname === '/api/setup/claim' && lose) throw new TypeError('fetch failed')
      return res
    })
    await expect(w.pc.start(link)).rejects.toThrow()
    const keyId = w.box.bindings.get('env_pc')!.keyId
    lose = false
    await w.pc.start(link)
    expect(w.pins()!.boxKey.startsWith(`tc_${keyId}.`)).toBe(true)
    expect(await w.box.auth.verifyToken(w.pins()!.boxKey)).not.toBeNull()
    expect(w.box.auth.listKeys().filter((k) => k.caps.includes('pending'))).toHaveLength(1)
  })

  it('a claim body replayed while the claim waits for Allow re-keys nothing: a recovery signs a fresh challenge (F18)', async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const real = w.fetch.getMockImplementation()!
    let captured: string | null = null
    w.fetch.mockImplementation(async (url, init) => {
      if (new URL(url).pathname === '/api/setup/claim') captured = String(init?.body)
      return real(url, init)
    })
    await w.pc.start(link)
    expect(w.box.bindings.get('env_pc')!.state).toBe('pending')
    await expect(w.setup.claim(JSON.parse(captured!), '10.1.1.3')).rejects.toThrow(/was used/)
    expect(await w.box.auth.verifyToken(w.pins()!.boxKey)).not.toBeNull()
    // The words on the PC are the claim's on file, the same the giver shows.
    const claim = w.setup.proof((w.box.toGiver.find((p) => 'pairingId' in p && p.pairingId) as { pairingId: string }).pairingId).claim!
    expect(w.pc.state()!.words).toEqual(setupWords({ origin: claim.origin, pairingId: claim.pairingId, bundleDigest: claim.bundleDigest, identity: claim.identity, envId: claim.envId, challenge: claim.challenge }))
  })

  it("each ask gets its own challenge, and asking for them spends nothing of the claim's tries (F27)", async () => {
    const w = await makeWorld()
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const { code } = parseSetupLink(link)
    const real = w.fetch.getMockImplementation()!
    let first = true
    w.fetch.mockImplementation(async (url, init) => {
      const res = await real(url, init)
      // Someone with the code alone asks for challenges right after the PC got its own.
      if (new URL(url).pathname === '/api/setup/challenge' && first) {
        first = false
        for (let i = 0; i < 9; i++) w.setup.challenge({ code }, `10.2.0.${i}`)
      }
      return res
    })
    await w.pc.start(link)
    expect(w.box.bindings.get('env_pc')!.state).toBe('pending')
  })

  it('Cancel ends the pending binding, its key and the link in one commit (F27)', async () => {
    const w = await makeWorld()
    const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    const revoke = w.box.auth.revokeKey.bind(w.box.auth)
    w.box.auth.revokeKey = () => {
      throw new Error('crash')
    }
    expect(() => w.setup.revoke(pairingId)).toThrow('crash')
    expect(w.box.bindings.get('env_pc')!.state).toBe('pending')
    expect((w.box.db.prepare(`SELECT expires_at FROM remote_pairings WHERE id = ?`).get(pairingId) as { expires_at: number }).expires_at).toBeGreaterThan(w.box.clock.now)
    w.box.auth.revokeKey = revoke
    w.setup.revoke(pairingId)
    expect(w.box.bindings.get('env_pc')).toBeNull()
  })

  it('Allow asks again whether the id is another host\'s, and binds the state and the caps together (F27, F11)', async () => {
    let taken = false
    const w = await makeWorld({ taken: () => taken })
    const { link } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    await w.pc.start(link)
    const b = w.box.bindings.get('env_pc')!
    const params = { envId: 'env_pc', keyId: b.keyId, identity: b.identity, generation: b.generation, name: 'PC' }
    taken = true
    w.box.mailbox['deps'].taken = () => taken
    expect(() => w.box.mailbox.activate(params)).toThrow(/another host's/)
    taken = false
    const setCaps = w.box.auth.setCaps.bind(w.box.auth)
    w.box.auth.setCaps = () => {
      throw new Error('crash')
    }
    expect(() => w.box.mailbox.activate(params)).toThrow('crash')
    expect(w.box.bindings.get('env_pc')!.state).toBe('pending')
    w.box.auth.setCaps = setCaps
    w.box.mailbox.activate(params)
    expect(w.box.bindings.get('env_pc')!.state).toBe('active')
  })
})

describe('never logged', () => {
  it('no link, code, secret or LifeOS code reaches a log line, an error text or a settings row', async () => {
    const lines: string[] = []
    const capture = (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture)
    const w = await makeWorld({ consoleLogs: true })
    const errors: string[] = []
    const keep = async (p: Promise<unknown>) => p.catch((err: Error) => void errors.push(`${err.message} ${err.stack}`))
    const { link, pairingId } = await w.giver.make({ name: 'PC', items: ALL, workspaces: [] })
    const { code, secret } = parseSetupLink(link)
    // Error paths: a link cut short, a wrong secret, http, a used link, a bad Allow, a pairing link's parser.
    await keep(w.pc.peek(link.slice(0, -5)))
    await keep(w.pc.peek(link.replace(/\.[A-Za-z0-9_-]{43}$/, `.${Buffer.alloc(32, 3).toString('base64url')}`)))
    await keep(w.pc.peek(link.replace('https:', 'http:')))
    await w.pc.start(link)
    await keep(w.pc.start(link))
    await w.joined()
    await w.giver.allow(pairingId)
    await keep(w.giver.allow(pairingId))
    await vi.waitFor(() => expect(allowState(w)).toBe('done'))
    w.deliver()
    await w.settle()
    const { parsePairingLink } = await import('../../remote/environments')
    try {
      parsePairingLink(link)
    } catch (err) {
      errors.push(`${(err as Error).message}`)
    }
    try {
      w.setup.peek({ code }, '1.2.3.4')
    } catch (err) {
      errors.push(`${(err as Error).message}`)
    }
    expect(errors.length).toBeGreaterThan(4)
    const persisted = [...w.giverStore.m.values(), ...w.pcStore.m.values(), JSON.stringify(w.box.db.prepare(`SELECT * FROM remote_pairings`).all())]
    const haystack = [...lines, ...errors, ...persisted, ...w.pcPushes.map((p) => JSON.stringify(p)), ...w.giverPushes.map((p) => JSON.stringify(p))].join('\n')
    for (const needle of [link, code, code.replace('-', ''), secret.toString('base64url'), LIFEOS_CODES.desktop, LIFEOS_CODES.tempcode]) {
      expect(haystack.includes(needle)).toBe(false)
    }
    expect(SetupRefused).toBeDefined()
  })
})

describe('principal shape', () => {
  it('a pending key is refused every HTTP-backed admin method', () => {
    const caps: Extract<Principal, { kind: 'remote' }>['caps'] = ['pending', 'read']
    for (const method of ['remote.keys.list', 'devices.list', 'accounts.headroom', 'session.list']) expect(capabilityRefusal(caps, { method } as never)).not.toBeNull()
  })
})
