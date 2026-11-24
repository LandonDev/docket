import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, vault } from 'aliax-core'
import type { Transfer } from 'aliax-core/sync'
import { ADDON_SERVICE } from '@shared/addonGrant'
import { DeviceAckSchema, FAREWELL_CLOSE, LEASE_MS, farewellPayload, peerProofPayload, type DeviceAck } from '@shared/contract-devices'
import type { LetterAccount, LetterKind } from '@shared/devices/envelope'
import { canonicalJson, generateDeviceKeys, verifyBytes, type DeviceKeys } from '@shared/devices/keys'
import { admit } from './admission'
import { letterFor, type GivenComputer as GiverRow } from './giverDevices'
import { givenHost } from './hostRules'
import { DeviceIdentities, memoryIdentityStore } from './identity'
import { DENY_PREFIX, GIVEN_SETTING, GivenComputer, PINS_NAME, WIPE_SETTING, type GivenDeps } from './given'
import { AccountSync } from '../remote/accountSync'
import { AccountsService } from '../accounts'
import { environmentKey, listEnvironments, sealEnvironmentKey, sealedEnvironmentKeys, updateEnvironment } from '../remote/environments'

vi.mock('aliax-core/keychain', () => ({
  readPassword: async () => {
    throw new Error('no keychain in tests')
  },
  writePassword: async () => {}
}))

const ME = 'env_pc'
const BOX = 'env_box'
const GIVER_ENV = 'env_mac'
const BOX_KEY = 'tc_k1.fake-secret-value'
const T0 = 1_800_000_000_000
const staticBlob = (tag: string): string => JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: `fake-${tag}`, expiresAt: T0 + 365 * 86_400_000 } }), oauthAccount: { accountUuid: tag } })

function memStore() {
  const m = new Map<string, string>()
  return {
    map: m,
    getSetting: (k: string) => m.get(k) ?? null,
    setSetting: (k: string, v: string | null) => void (v === null ? m.delete(k) : m.set(k, v)),
    settingsWithPrefix: (p: string): Map<string, string> => new Map([...m].filter(([k]) => k.startsWith(p)))
  }
}

let dataDir: string
let now: number
let giver: DeviceKeys
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tc-given-'))
  configure({
    dataDir,
    fetch: async (url) => {
      throw new Error(`unexpected fetch ${url}`)
    },
    secrets: { mode: 'fileKey', path: join(dataDir, 'vault.key') },
    environmentId: ME
  })
  now = T0
  giver = generateDeviceKeys()
  givenHost.current = () => false
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  sealedEnvironmentKeys.read = () => null
})

interface Rig {
  given: GivenComputer
  store: ReturnType<typeof memStore>
  identity: DeviceIdentities
  calls: string[]
  acks: DeviceAck[]
  logs: string[]
  mailbox: { letter: unknown }
  deps: GivenDeps
}

function rig(over: Partial<GivenDeps> = {}, shared?: Pick<Rig, 'store' | 'identity'>): Rig {
  const store = shared?.store ?? memStore()
  const identity = shared?.identity ?? new DeviceIdentities(memoryIdentityStore())
  const calls: string[] = []
  const acks: DeviceAck[] = []
  const logs: string[] = []
  const mailbox = { letter: null as unknown }
  const request = async <T,>(method: string, params?: unknown): Promise<T> => {
    calls.push(method)
    if (method === 'devices.challenge') return { nonce: 'nonce-1' } as T
    if (method === 'devices.mail') return { letter: mailbox.letter, removal: null } as T
    if (method === 'devices.ack') {
      acks.push((params as { ack: DeviceAck }).ack)
      return { ok: true } as T
    }
    throw new Error(`unexpected ${method}`)
  }
  const deps: GivenDeps = {
    environmentId: ME,
    store,
    identity,
    link: (id) => (id === BOX ? request : null),
    refreshNow: () => void calls.push('refreshNow'),
    changed: () => {},
    pull: (id) => void calls.push(`pull ${id}`),
    endHandles: (provider, name) => void calls.push(`endHandles ${provider} ${name}`),
    clearGatewayCache: (service) => void calls.push(`clearGatewayCache ${service}`),
    dropFiles: (service, name) => void calls.push(`dropFiles ${service} ${name}`),
    now: () => now,
    log: (l) => void logs.push(l),
    ...over
  }
  return { given: new GivenComputer(deps), store, identity, calls, acks, logs, mailbox, deps }
}

const pin = (r: Rig, generation = 1, signPublic = giver.signPublic) =>
  r.given.pinGiver({ giver: { signPublic, name: "Landon's MacBook", envId: GIVER_ENV }, box: { envId: BOX, origin: 'https://box.example' }, boxKey: BOX_KEY, generation })

const computerOf = (r: Rig, generation = 1, envId = ME): GiverRow => ({ envId, name: 'PC', identity: r.identity.publicIdentity(), generation, seq: 0, state: 'active', accounts: true })

const claude = (account: string, name = `${account}@x`): { account: LetterAccount; meta: Record<string, unknown> } => ({
  account: { service: 'claude-code', account, kind: 'static', secret: staticBlob(account) },
  meta: { [`claude-code:${account}`]: { name, email: name, createdAt: 1 } }
})
const codex = (account: string): { account: LetterAccount; meta: Record<string, unknown> } => ({
  account: { service: 'codex', account, kind: 'access', owner: BOX },
  meta: { [`codex:${account}`]: { name: `${account}@codex`, createdAt: 1 } }
})

function letter(r: Rig, seq: number, kind: LetterKind, grants: { account: LetterAccount; meta: Record<string, unknown> }[] = [], o: { generation?: number; envId?: string; giverKeys?: DeviceKeys; extra?: Record<string, unknown> } = {}) {
  const extra = o.extra ?? (kind === 'manifest' ? { meta: Object.assign({}, ...grants.map((g) => g.meta)) } : undefined)
  return letterFor({ computer: computerOf(r, o.generation ?? 1, o.envId), giver: o.giverKeys ?? giver, kind, seq, now, accounts: grants.map((g) => g.account), ...(extra ? { extra } : {}) })
}

const names = (service: 'claude-code' | 'codex') => vault.profiles(service).map((p) => p.name).sort()

describe('the pins', () => {
  it('seals the giver, the box and its key in the vault, never in a settings row', async () => {
    const sealed: string[] = []
    const r = rig({ sealEnvironmentKey: (id) => void sealed.push(id) })
    await pin(r)
    expect(JSON.parse(vault.readSecret(ADDON_SERVICE, PINS_NAME)!)).toMatchObject({ giver: { signPublic: giver.signPublic }, box: { envId: BOX }, boxKey: BOX_KEY, generation: 1 })
    expect([...r.store.map.values()].join('\n')).not.toContain('fake-secret-value')
    expect(vault.profiles(ADDON_SERVICE)).toEqual([])
    expect(sealed).toEqual([BOX])
    expect(givenHost.current()).toBe(true)
    expect(r.given.boxKeyFor(BOX)).toBe(BOX_KEY)
    expect(r.given.boxKeyFor('env_other')).toBeNull()
  })

  it("takes a saved box environment's key out of its row and reads it back from the pins", async () => {
    const store = memStore()
    store.setSetting(`remote.environments.${BOX}`, JSON.stringify({ name: 'box', routes: [{ url: 'wss://box.example/ws', kind: 'tunnel' }], addedAt: 1, caps: ['device'], keyName: 'PC', key: BOX_KEY }))
    const r = rig({ sealEnvironmentKey: (id) => void sealEnvironmentKey(store, id) }, { store, identity: new DeviceIdentities(memoryIdentityStore()) })
    sealedEnvironmentKeys.read = (id) => r.given.boxKeyFor(id)
    await pin(r)
    expect(store.getSetting(`remote.environments.${BOX}`)).not.toContain('fake-secret-value')
    expect(environmentKey(store, BOX)).toBe(BOX_KEY)
    expect(listEnvironments(store)[0]).toMatchObject({ id: BOX, keyId: 'k1' })
    updateEnvironment(store, { id: BOX, name: 'The box' })
    expect(store.getSetting(`remote.environments.${BOX}`)).not.toContain('fake-secret-value')
    sealedEnvironmentKeys.read = () => null
    expect(environmentKey(store, BOX)).toBeNull()
  })

  it('proves the device key in peer.register on the box link alone', async () => {
    const r = rig()
    await pin(r)
    const request = r.deps.link(BOX)!
    const proof = await r.given.proofFor(BOX, request)
    const payload = Buffer.from(canonicalJson(peerProofPayload({ nonce: 'nonce-1', from: ME, keyId: 'k1' })))
    expect(verifyBytes(r.identity.publicIdentity().signPublic, payload, proof!)).toBe(true)
    expect(await r.given.proofFor('env_other', request)).toBeNull()
  })
})

describe('letters a given computer refuses', () => {
  it('drops a wrong addressee, generation or giver, and a lower seq, logging seq and reason only', async () => {
    const r = rig()
    await pin(r)
    const secretTag = 'u-secret-tag'
    expect(await r.given.apply(letter(r, 1, 'manifest', [claude(secretTag)], { envId: 'env_elsewhere' }))).toBe(false)
    expect(await r.given.apply(letter(r, 1, 'manifest', [claude(secretTag)], { generation: 2 }))).toBe(false)
    expect(await r.given.apply(letter(r, 1, 'manifest', [claude(secretTag)], { giverKeys: generateDeviceKeys() }))).toBe(false)
    expect(await r.given.apply(letter(r, 5, 'manifest', [claude('u1')]))).toBe(true)
    expect(await r.given.apply(letter(r, 4, 'manifest', []))).toBe(false)
    expect(await r.given.apply(letter(r, 5, 'manifest', []))).toBe(false)
    expect(r.logs.filter((l) => l.includes(': dropped ('))).toEqual([
      'letter 1: dropped (wrong-addressee)',
      'letter 1: dropped (wrong-generation)',
      'letter 1: dropped (wrong-giver)',
      'letter 4: dropped (stale-seq)',
      'letter 5: dropped (stale-seq)'
    ])
    expect(r.logs.join('\n')).not.toContain(secretTag)
    expect(r.logs.join('\n')).not.toContain('fake-')
    expect(names('claude-code')).toEqual(['u1@x'])
  })

  it('opens nothing before a giver is pinned', async () => {
    const r = rig()
    expect(await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))).toBe(false)
    expect(r.logs).toEqual(['letter 1: dropped (no giver pinned)'])
  })
})

describe('applying manifests', () => {
  it('adds what a manifest gives, acks it signed, and later drops what a newer one leaves out', async () => {
    const r = rig()
    await pin(r)
    vault.upsertProfile('claude-code', { name: 'mine@x', accountId: 'own1', createdAt: 1, static: true })
    vault.saveSecret('claude-code', 'mine@x', staticBlob('own1'), 'sync')
    expect(await r.given.apply(letter(r, 1, 'manifest', [claude('u1'), codex('c1')]))).toBe(true)
    expect(names('claude-code')).toEqual(['mine@x', 'u1@x'])
    expect(vault.readSecret('claude-code', 'u1@x')).toBe(staticBlob('u1'))
    expect(vault.profiles('codex')).toMatchObject([{ name: 'c1@codex', accountId: 'c1', owner: BOX }])
    expect(vault.readSecret('codex', 'c1@codex')).toBeNull()
    expect(r.calls).toContain(`pull ${BOX}`)
    const ack = r.acks[0]
    expect(DeviceAckSchema.parse(ack)).toBeTruthy()
    expect(ack).toMatchObject({ envId: ME, seq: 1, holds: [{ service: 'claude-code', account: 'u1' }, { service: 'codex', account: 'c1' }], own: [{ service: 'claude-code', account: 'own1' }] })
    const { signature, ...fields } = ack
    expect(verifyBytes(r.identity.publicIdentity().signPublic, Buffer.from(canonicalJson(fields)), signature)).toBe(true)
    expect(r.given.state()?.unacked).toBeUndefined()

    now += 1_000
    r.calls.length = 0
    expect(await r.given.apply(letter(r, 2, 'manifest', [codex('c1')]))).toBe(true)
    expect(names('claude-code')).toEqual(['mine@x'])
    expect(r.store.getSetting(`${DENY_PREFIX}claude-code:u1`)).not.toBeNull()
    expect(r.acks[1].holds).toEqual([{ service: 'codex', account: 'c1' }])
    // The drop sequence, in order: refuse turns (held), end handles, delete, clear the gateway, delete tagged files.
    expect(r.calls.slice(0, 3)).toEqual(['endHandles claude u1@x', 'clearGatewayCache claude-code', 'dropFiles claude-code u1@x'])
    expect(vault.readSecret('claude-code', 'mine@x')).toBe(staticBlob('own1'))
  })

  it('drops a given row by its name even after a repair relabelled its account', async () => {
    const r = rig()
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))
    vault.upsertProfile('claude-code', { ...vault.profiles('claude-code')[0], accountId: 'u1-repaired' })
    await r.given.apply(letter(r, 2, 'stop'))
    expect(names('claude-code')).toEqual([])
  })

  it('holds a row out of routing while it is dropped', async () => {
    const seen: string[][] = []
    const r = rig({ endHandles: () => void seen.push(r.given.held('claude')) })
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))
    expect(r.given.held('claude')).toEqual([])
    await r.given.apply(letter(r, 2, 'stop'))
    expect(seen).toEqual([['u1@x']])
    expect(r.given.held('claude')).toEqual([])
    expect(names('claude-code')).toEqual([])
  })

  it('a stop drops every given row and keeps the link', async () => {
    const r = rig()
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1'), codex('c1')]))
    await r.given.apply(letter(r, 2, 'stop'))
    expect(names('claude-code')).toEqual([])
    expect(names('codex')).toEqual([])
    expect(r.given.state()).toMatchObject({ lastSeq: 2, rows: [], grants: [] })
    expect(r.given.isGiven()).toBe(true)
    expect(r.acks.at(-1)).toMatchObject({ seq: 2, holds: [] })
    // A fresh manifest after it gives again, and lifts the marker.
    await r.given.apply(letter(r, 3, 'manifest', [claude('u1')]))
    expect(names('claude-code')).toEqual(['u1@x'])
    expect(r.store.getSetting(`${DENY_PREFIX}claude-code:u1`)).toBeNull()
  })

  it('never applies a grant over an own row, and never admits one that matches a row it refreshes itself', async () => {
    const r = rig()
    await pin(r)
    vault.upsertProfile('claude-code', { name: 'mine@x', accountId: 'u1', createdAt: 1, static: true })
    vault.saveSecret('claude-code', 'mine@x', staticBlob('mine'), 'sync')
    vault.upsertProfile('codex', { name: 'mycodex', accountId: 'c1', createdAt: 1 })
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1'), codex('c1'), codex('c2')]))
    expect(names('claude-code')).toEqual(['mine@x'])
    expect(vault.readSecret('claude-code', 'mine@x')).toBe(staticBlob('mine'))
    expect(names('codex')).toEqual(['c2@codex', 'mycodex'])
    expect(r.given.admitted()).toEqual([{ service: 'codex', account: 'c2', kind: 'access', owner: BOX }])
    expect(r.acks[0].own).toEqual([
      { service: 'claude-code', account: 'u1' },
      { service: 'codex', account: 'c1' }
    ])
    // Own rows are never given rows: the sync may push them as before.
    expect(r.given.isGivenRow('codex', 'mycodex')).toBe(false)
    expect(r.given.isGivenRow('codex', 'c2@codex')).toBe(true)
  })

  it('names a given row apart from an own row of the same name', async () => {
    const r = rig()
    await pin(r)
    vault.upsertProfile('claude-code', { name: 'u1@x', accountId: 'other', createdAt: 1, static: true })
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))
    expect(names('claude-code')).toEqual(['u1@x', 'u1@x (2)'])
    expect(r.given.isGivenRow('claude-code', 'u1@x (2)')).toBe(true)
  })
})

describe('a sign-in made on the given computer (F15)', () => {
  it('a local sign-in that lands on a given row makes it this computer\'s own: Stop and a newer manifest keep it', async () => {
    const r = rig()
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [codex('c1')]))
    expect(r.given.isGivenRow('codex', 'c1@codex')).toBe(true)
    // The PC signs in to the same account by hand: the capture saves its own grant on the row (aliax-core saveCaptured).
    vault.upsertProfile('codex', { ...vault.profiles('codex')[0], static: false, owner: undefined })
    vault.saveSecret('codex', 'c1@codex', JSON.stringify({ tokens: { refresh_token: 'mine' } }), 'sync')
    expect(r.given.isGivenRow('codex', 'c1@codex')).toBe(false)
    expect(r.given.admitted()).toEqual([])
    await r.given.apply(letter(r, 2, 'manifest', [codex('c1')]))
    expect(vault.profiles('codex')[0].owner).toBeUndefined()
    await r.given.apply(letter(r, 3, 'stop'))
    expect(names('codex')).toEqual(['c1@codex'])
    expect(vault.readSecret('codex', 'c1@codex')).toContain('mine')
  })

  it('names a given row apart from an own row whose name differs only by case', async () => {
    const r = rig()
    await pin(r)
    vault.upsertProfile('claude-code', { name: 'U1@X', accountId: 'other', createdAt: 1, static: true })
    vault.saveSecret('claude-code', 'U1@X', staticBlob('other'), 'sync')
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))
    expect(names('claude-code')).toEqual(['U1@X', 'u1@x (2)'])
    expect(vault.readSecret('claude-code', 'U1@X')).toBe(staticBlob('other'))
  })
})

describe('the activate letter (F20)', () => {
  it("saves LifeOS's codes before the seq: a save that fails leaves the letter to apply again", async () => {
    let fail = true
    const seen: unknown[] = []
    const r = rig({
      onApplied: (kind, extra) => {
        if (fail) throw new Error('vault locked')
        seen.push([kind, extra])
      }
    })
    await pin(r)
    const extra = { box: { envId: BOX }, lifeos: { owner: 'o', codes: { tempcode: 'loe_x' } } }
    await expect(r.given.apply(letter(r, 1, 'activate', [], { extra }))).rejects.toThrow('vault locked')
    expect(r.given.state()?.lastSeq ?? 0).toBe(0)
    fail = false
    expect(await r.given.apply(letter(r, 1, 'activate', [], { extra }))).toBe(true)
    expect(seen).toEqual([['activate', extra]])
    expect(r.given.state()?.lastSeq).toBe(1)
  })
})

describe('admission and deny markers', () => {
  const rotation = (account: string, name: string): Pick<Transfer, 'service' | 'mode' | 'blob' | 'profile'> => ({
    service: 'codex',
    mode: 'access',
    blob: JSON.stringify({ tokens: { access_token: 'fake-a', account_id: account } }),
    profile: { name, accountId: account, createdAt: 1, static: false, owner: BOX }
  })

  it('a deny marker stops a late pull or rotation of a dropped grant, even before the drop commits', async () => {
    const crash = { at: null as null | string }
    const r = rig({
      crashAfter: (step) => {
        if (step === crash.at) throw new Error(`crash after ${step}`)
      }
    })
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [codex('c1')]))
    const onFile = vault.profiles('codex')
    expect(admit(rotation('c1', 'c1@codex'), { path: 'rotation', policy: 'peer', admitted: r.given.admitted() }, onFile)).toEqual({ ok: true })
    crash.at = 'deny'
    await expect(r.given.apply(letter(r, 2, 'stop'))).rejects.toThrow('crash after deny')
    // The grant is still committed, but its marker is down: nothing for it lands.
    expect(r.given.state()?.grants).toHaveLength(1)
    expect(admit(rotation('c1', 'c1@codex'), { path: 'rotation', policy: 'peer', admitted: r.given.admitted() }, onFile)).toEqual({ ok: false, reason: 'not-admitted' })
    expect(admit(rotation('c1', 'c1@codex'), { path: 'pull', policy: 'peer', admitted: r.given.admitted() }, onFile)).toEqual({ ok: false, reason: 'not-admitted' })
  })

  it('admits nothing while the pins and the state disagree, and stays out of the way on a computer nobody gave anything', async () => {
    const r = rig()
    expect(r.given.admitted()).toBeUndefined()
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [codex('c1')]))
    r.store.setSetting(GIVEN_SETTING, JSON.stringify({ ...r.given.state(), generation: 9 }))
    expect(r.given.admitted()).toEqual([])
  })
})

describe('a crash mid-apply', () => {
  for (const step of ['deny', 'reconcile', 'commit'] as const) {
    it(`resumes after a crash after ${step}`, async () => {
      const crash = { on: false }
      const first = rig({
        crashAfter: (s) => {
          if (crash.on && s === step) throw new Error(`crash after ${s}`)
        }
      })
      await pin(first)
      await first.given.apply(letter(first, 1, 'manifest', [claude('u1'), codex('c1')]))
      crash.on = true
      const second = letter(first, 2, 'manifest', [codex('c1'), claude('u2')])
      await expect(first.given.apply(second)).rejects.toThrow(`crash after ${step}`)
      // Restart: the same store, vault and identity; the box hands out the same newest letter.
      const again = rig({}, { store: first.store, identity: first.identity })
      again.given.start()
      again.mailbox.letter = second
      await again.given.linkUp(BOX)
      expect(names('claude-code')).toEqual(['u2@x'])
      expect(names('codex')).toEqual(['c1@codex'])
      expect(again.given.state()).toMatchObject({ lastSeq: 2, rows: [{ account: 'c1' }, { account: 'u2' }] })
      expect(again.given.state()?.unacked).toBeUndefined()
      expect(again.store.getSetting(`${DENY_PREFIX}claude-code:u1`)).not.toBeNull()
      expect(again.acks.at(-1)?.holds).toEqual([
        { service: 'codex', account: 'c1' },
        { service: 'claude-code', account: 'u2' }
      ])
    })
  }

  it('drops a deny-marked row still in the vault at start', async () => {
    const first = rig({
      crashAfter: (s) => {
        if (s === 'deny') throw new Error('crash')
      }
    })
    await pin(first)
    first.deps.crashAfter = undefined
    await first.given.apply(letter(first, 1, 'manifest', [claude('u1')]))
    first.deps.crashAfter = (s) => {
      if (s === 'deny') throw new Error('crash')
    }
    await expect(first.given.apply(letter(first, 2, 'stop'))).rejects.toThrow('crash')
    expect(names('claude-code')).toEqual(['u1@x'])
    const again = rig({}, { store: first.store, identity: first.identity })
    again.given.start()
    await again.given.apply(letter(first, 0, 'stop')).catch(() => false)
    expect(names('claude-code')).toEqual([])
    expect(again.given.state()?.rows).toEqual([])
  })
})

describe('the lease', () => {
  it('pauses the given rows past the lease, says so in one line, and a newer manifest lifts it', async () => {
    const r = rig()
    await pin(r)
    vault.upsertProfile('claude-code', { name: 'mine@x', accountId: 'own1', createdAt: 1, static: true })
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))
    expect(r.given.paused()).toBe(false)
    expect(r.given.snapshotLine()).toEqual({ paused: false, giver: "Landon's MacBook", since: T0 })
    now = T0 + LEASE_MS + 1
    expect(r.given.paused()).toBe(true)
    expect(r.given.held('claude')).toEqual(['u1@x'])
    expect(r.given.snapshotLine()).toEqual({ paused: true, giver: "Landon's MacBook", since: T0 })
    await r.given.apply(letter(r, 2, 'manifest', [claude('u1')]))
    expect(r.given.paused()).toBe(false)
    expect(r.given.held('claude')).toEqual([])
  })

  it('a 30-day lease past the longest timer waits again for its real end, and past it nothing is admitted (F13)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const changed = vi.fn()
      const r = rig({ changed })
      await pin(r)
      await r.given.apply(letter(r, 1, 'manifest', [codex('c1')]))
      expect(r.given.admitted()).toHaveLength(1)
      changed.mockClear()
      // The timer can wait 2^31-1 ms (about 24.9 days) at most: it wakes before the lease ends.
      now = T0 + 2 ** 31
      vi.advanceTimersByTime(2 ** 31)
      expect(r.logs.some((l) => l.includes('the lease ran out'))).toBe(false)
      now = T0 + LEASE_MS + 2
      vi.advanceTimersByTime(LEASE_MS - 2 ** 31 + 2)
      expect(r.logs.some((l) => l.includes('the lease ran out'))).toBe(true)
      expect(r.given.admitted()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('routing skips a held row, and the snapshot carries the line', async () => {
    const accounts = new AccountsService({ usage: async () => [], live: async () => null, owner: () => null, held: (p) => (p === 'claude' ? ['u1@x'] : []), given: () => ({ paused: true, giver: 'Mac', since: 5 }) })
    expect(accounts.outFor('claude')).toEqual(['u1@x'])
    expect(accounts.outMarks()).toContainEqual({ serviceId: 'claude-code', name: 'u1@x', until: null })
    await accounts.rebuildNow()
    expect(accounts.snapshot().given).toEqual({ paused: true, giver: 'Mac', since: 5 })
  })
})

describe('the sync never moves a given row', () => {
  it('refuses to delete one, and never exports one on a pull', async () => {
    const store = memStore()
    const sync = new AccountSync({ environmentId: ME, store, peers: { get: () => undefined, all: () => [] }, nudge: () => {}, givenRow: (_s, name) => name === 'u1@x', log: () => {} })
    vault.upsertProfile('claude-code', { name: 'u1@x', accountId: 'u1', createdAt: 1, static: true })
    vault.saveSecret('claude-code', 'u1@x', staticBlob('u1'), 'sync')
    expect(await sync.deleteProfile('claude-code', 'u1@x')).toMatchObject({ ok: false })
    expect(vault.profiles('claude-code')).toHaveLength(1)
    expect((await sync.handlePull(BOX, { service: 'claude-code' })).transfers).toEqual([])
    sync.close()
  })

  it("the box's tombstones and lists prune given rows alone, never this computer's own sign-ins", async () => {
    const store = memStore()
    const sync = new AccountSync({ environmentId: ME, store, peers: { get: () => undefined, all: () => [] }, nudge: () => {}, admitted: () => [], givenRow: (_s, name) => name === 'given@x', liveAccountId: async () => null, log: () => {} })
    vault.upsertProfile('claude-code', { name: 'mine@x', accountId: 'u1', createdAt: 1, static: true })
    vault.upsertProfile('codex', { name: 'mine-cx', accountId: 'c1', createdAt: 1, owner: BOX })
    vault.upsertProfile('codex', { name: 'given@x', accountId: 'c2', createdAt: 1, owner: BOX })
    const at = now
    const dropped = await sync.prune(BOX, [], [{ service: 'claude-code', accountId: 'u1', at } as never])
    expect(dropped).toBe(1)
    expect(names('claude-code')).toEqual(['mine@x'])
    expect(names('codex')).toEqual(['mine-cx'])
    sync.close()
  })
})

describe('Remove', () => {
  const receiptRig = (responses: (() => Response | Promise<Response>)[], over: Partial<GivenDeps> = {}) => {
    const posts: { url: string; body: Record<string, unknown>; auth: string | null }[] = []
    const steps: string[] = []
    const r = rig({
      fetch: (async (url: string, init: RequestInit) => {
        posts.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') })
        const next = responses.shift()
        if (!next) throw new Error('no more answers')
        return next()
      }) as typeof fetch,
      sleep: async () => {},
      clearLifeosToken: () => void steps.push('lifeos token'),
      removeSetupFolders: () => void steps.push('setup folders'),
      lifeosReaderOff: () => void steps.push('reader off'),
      removeEnvironment: (id) => void steps.push(`environment ${id}`),
      ...over
    })
    return { r, posts, steps }
  }
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

  it('wipes what the link gave, posts the signed receipt until it is recorded, then forgets the box, the pins and the identity', async () => {
    const { r, posts, steps } = receiptRig([() => Promise.reject(new Error('offline')), () => new Response('busy', { status: 503 }), ok])
    await pin(r)
    vault.upsertProfile('claude-code', { name: 'mine@x', accountId: 'own1', createdAt: 1, static: true })
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1'), codex('c1')]))
    const identityBefore = r.identity.publicIdentity()
    expect(await r.given.apply(letter(r, 2, 'remove', [], { extra: { removalId: 'rm_1' } }))).toBe(true)
    await r.given.wipe('rm_1')
    expect(names('claude-code')).toEqual(['mine@x'])
    expect(names('codex')).toEqual([])
    expect(steps).toEqual(['lifeos token', 'setup folders', 'reader off', `environment ${BOX}`])
    expect(posts).toHaveLength(3)
    expect(posts[2]).toMatchObject({ url: 'https://box.example/api/farewell', auth: `Bearer ${BOX_KEY}`, body: { op: 'receipt', removalId: 'rm_1' } })
    const payload = Buffer.from(canonicalJson(farewellPayload({ removalId: 'rm_1', envId: ME })))
    expect(verifyBytes(identityBefore.signPublic, payload, posts[2].body.signature as string)).toBe(true)
    expect(vault.readSecret(ADDON_SERVICE, PINS_NAME)).toBeNull()
    expect(r.given.state()).toBeNull()
    expect(r.store.getSetting(WIPE_SETTING)).toBeNull()
    expect(r.store.settingsWithPrefix(DENY_PREFIX).size).toBe(0)
    expect(r.given.isGiven()).toBe(false)
    expect(givenHost.current()).toBe(false)
    expect(r.identity.publicIdentity().signPublic).not.toBe(identityBefore.signPublic)
  })

  it('stops setup first, and a part that fails is run again before the receipt is signed (F16)', async () => {
    let fail = true
    const { r, posts, steps } = receiptRig([ok], {
      haltSetup: () => void steps.push('setup halted'),
      lifeosReaderOff: () => {
        if (fail) throw new Error('purdue.json is locked')
        steps.push('reader off')
      },
      forgetSetup: () => void steps.push('setup forgotten')
    })
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))
    await r.given.apply(letter(r, 2, 'remove', [], { extra: { removalId: 'rm_f' } }))
    await r.given.wipe('rm_f')
    expect(posts).toHaveLength(0)
    expect(steps).toEqual(['setup halted', 'lifeos token', 'setup folders'])
    fail = false
    await r.given.wipe('rm_f')
    // Done parts are not run again.
    expect(steps).toEqual(['setup halted', 'lifeos token', 'setup folders', 'reader off', `environment ${BOX}`, 'setup forgotten'])
    expect(posts.map((p) => p.body.op)).toEqual(['receipt'])
  })

  it('picks the wipe up where a restart stopped it', async () => {
    const { r, posts } = receiptRig([ok])
    await pin(r)
    r.store.setSetting(WIPE_SETTING, JSON.stringify({ removalId: 'rm_2', at: now, step: 'receipt' }))
    r.given.start()
    await r.given.wipe('rm_2')
    expect(posts.map((p) => p.body.op)).toEqual(['receipt'])
    expect(r.given.isGiven()).toBe(false)
  })

  it("reads the removal through /api/farewell after the box's farewell close", async () => {
    const holder: { letter?: unknown } = {}
    const { r, posts } = receiptRig([() => new Response(JSON.stringify({ letter: holder.letter, removal: { removalId: 'rm_3' } }), { status: 200 }), ok])
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))
    holder.letter = letter(r, 2, 'remove', [], { extra: { removalId: 'rm_3' } })
    r.given.onClose(BOX, 1006)
    expect(posts).toHaveLength(0)
    await r.given.farewellMail()
    await r.given.wipe('rm_3')
    expect(posts.map((p) => p.body.op)).toEqual(['mail', 'receipt'])
    expect(names('claude-code')).toEqual([])
    expect(r.given.isGiven()).toBe(false)
    expect(FAREWELL_CLOSE).toBe(4010)
  })

  it('a computer away at Remove: the ticket refusal reads the farewell, and a removal with no letter still wipes', async () => {
    const { r, posts, steps } = receiptRig([() => new Response(JSON.stringify({ letter: null, removal: { removalId: 'rm_4' } }), { status: 200 }), ok])
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))
    r.given.onRefused('env_other')
    expect(posts).toHaveLength(0)
    r.given.onRefused(BOX)
    await vi.waitFor(() => expect(r.given.isGiven()).toBe(false))
    expect(posts.map((p) => p.body.op)).toEqual(['mail', 'receipt'])
    expect(posts[1].body.removalId).toBe('rm_4')
    expect(names('claude-code')).toEqual([])
    expect(steps).toEqual(['lifeos token', 'setup folders', 'reader off', `environment ${BOX}`])
  })

  it('a key the box ended (401) wipes with no receipt to record; "not in farewell" changes nothing; a pending key is never asked', async () => {
    const notIn = receiptRig([() => new Response('not in farewell', { status: 403 })])
    await pin(notIn.r)
    notIn.r.given.onRefused(BOX)
    expect(notIn.posts).toHaveLength(0)
    await notIn.r.given.apply(letter(notIn.r, 1, 'manifest', [claude('u1')]))
    await notIn.r.given.farewellMail()
    expect(notIn.posts).toHaveLength(1)
    expect(notIn.r.given.isGiven()).toBe(true)
    expect(names('claude-code')).toEqual(['u1@x'])
    const ended = receiptRig([() => new Response('', { status: 401 }), () => new Response('', { status: 401 })], { identity: notIn.r.identity, store: notIn.r.store } as Partial<GivenDeps>)
    await ended.r.given.farewellMail()
    await vi.waitFor(() => expect(ended.r.given.isGiven()).toBe(false))
    expect(names('claude-code')).toEqual([])
  })

  it("Start fresh clears setup's progress even before anything was given (F23)", () => {
    const forgot: string[] = []
    const r = rig({ forgetSetup: () => void forgot.push('setup') })
    r.given.startFresh()
    expect(forgot).toEqual(['setup'])
  })

  it('Start fresh retires the identity and forgets the box with no receipt', async () => {
    const { r, posts, steps } = receiptRig([])
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))
    const before = r.identity.publicIdentity().signPublic
    // The old vault, pins and all, was set aside.
    vault.deleteProfile(ADDON_SERVICE, PINS_NAME)
    r.given.startFresh()
    expect(posts).toEqual([])
    expect(steps).toEqual([`environment ${BOX}`])
    expect(r.given.state()).toBeNull()
    expect(r.calls).toContain('dropFiles muse-code null')
    expect(r.identity.publicIdentity().signPublic).not.toBe(before)
  })
})

describe('the link', () => {
  it('reads its mail on link up and on a device-mail push, and leaves other pushes alone', async () => {
    const r = rig()
    await pin(r)
    r.mailbox.letter = letter(r, 1, 'manifest', [claude('u1')])
    await r.given.linkUp(BOX)
    expect(names('claude-code')).toEqual(['u1@x'])
    expect(r.given.onPeerPush(BOX, { push: 'account' })).toBe(false)
    r.mailbox.letter = letter(r, 2, 'stop')
    expect(r.given.onPeerPush(BOX, { push: 'device-mail' })).toBe(true)
    await vi.waitFor(() => expect(names('claude-code')).toEqual([]))
    await r.given.linkUp('env_other')
    expect(r.calls.filter((c) => c === 'devices.mail')).toHaveLength(2)
  })

  it("mints the window's box ticket on its proved link, never by bearer", async () => {
    const r = rig({ link: (id) => (id === BOX ? (async <T,>(method: string) => (method === 'devices.ticket' ? ({ ticket: 'proved-t', expiresIn: 30 } as T) : Promise.reject(new Error(method)))) : null) })
    expect(r.given.windowTicket(BOX)).toBeNull()
    await pin(r)
    await expect(r.given.windowTicket(BOX)).resolves.toEqual({ ticket: 'proved-t', expiresIn: 30 })
    expect(r.given.windowTicket('env_other')).toBeNull()
  })

  it('a new generation drops every row the old one gave', async () => {
    const r = rig()
    await pin(r)
    await r.given.apply(letter(r, 1, 'manifest', [claude('u1')]))
    await pin(r, 2)
    expect(names('claude-code')).toEqual([])
    expect(r.given.state()).toMatchObject({ generation: 2, lastSeq: 0, rows: [] })
    expect(r.store.settingsWithPrefix(DENY_PREFIX).size).toBe(0)
    expect(await r.given.apply(letter(r, 1, 'manifest', [claude('u1')], { generation: 2 }))).toBe(true)
  })
})
