import { describe, expect, it } from 'vitest'
import type { Capability } from '@shared/capabilities'
import { capabilityRefusal } from '@shared/capabilities'
import { generateDeviceKeys, signBytes } from '@shared/devices/keys'
import { Givers, GIVER_SETTING, claimsGiver, giverMoveBytes } from './giver'
import { DeviceIdentities, memoryIdentityStore } from './identity'

function rig(keys: Array<{ id: string; caps: Capability[]; createdAt: number; revokedAt?: number | null }>, openPairings = 2) {
  const settings = new Map<string, string>()
  let pairings = openPairings
  let now = 1_000
  const store = { getSetting: (k: string) => settings.get(k) ?? null, setSetting: (k: string, v: string | null) => (v === null ? settings.delete(k) : settings.set(k, v)) }
  const auth = {
    getKey: (id: string) => {
      const k = keys.find((x) => x.id === id)
      return k ? { id: k.id, caps: k.caps, createdAt: k.createdAt, revokedAt: k.revokedAt ?? null } : null
    },
    endOpenPairings: () => {
      const n = pairings
      pairings = 0
      return n
    }
  }
  const givers = new Givers(store, auth, () => now, () => {})
  return { givers, settings, store, auth, pairings: () => pairings, tick: (ms: number) => (now += ms) }
}
const principal = (keyId: string, caps: Capability[]) => ({ kind: 'remote' as const, keyId, name: keyId, audience: 'client' as const, caps })
const identity = { signPublic: 'mac-sign', sealPublic: 'mac-seal' }

describe('the giver cut-over', () => {
  it('stamps the upgrade once and ends the pairing offers made before it', () => {
    const r = rig([])
    r.givers.cutOver()
    expect(r.pairings()).toBe(0)
    expect(r.givers.upgradeAt()).toBe(1_000)
    r.tick(5_000)
    r.givers.cutOver()
    expect(r.givers.upgradeAt()).toBe(1_000)
  })

  it('the first claim from an admin key made before the upgrade wins; repeats answer ok; nobody else may claim', () => {
    const r = rig([
      { id: 'mac', caps: ['admin', 'read'], createdAt: 10 },
      { id: 'rig', caps: ['admin', 'read'], createdAt: 20 },
      { id: 'new', caps: ['admin', 'read'], createdAt: 5_000 }
    ])
    r.givers.cutOver()
    r.tick(1_000)
    expect(r.givers.claim(principal('new', ['admin', 'read']), identity, 'Fresh').ok).toBe(false)
    expect(r.givers.claim(principal('mac', ['admin', 'read']), identity, 'MacBook').ok).toBe(true)
    expect(r.givers.claim(principal('mac', ['admin', 'read']), identity, 'MacBook').ok).toBe(true)
    expect(r.givers.claim(principal('rig', ['admin', 'read']), { signPublic: 'x', sealPublic: 'y' }, 'Rig')).toMatchObject({ ok: false })
    // the same key under another identity is refused too
    expect(r.givers.claim(principal('mac', ['admin', 'read']), { signPublic: 'other', sealPublic: 'y' }, 'MacBook').ok).toBe(false)
    expect(JSON.parse(r.settings.get(GIVER_SETTING)!)).toMatchObject({ keyId: 'mac', identity, name: 'MacBook' })
  })

  it("after a re-pair the giver's own identity moves the record to its new key, once the old key is revoked; nobody else can", () => {
    const keys: Array<{ id: string; caps: Capability[]; createdAt: number; revokedAt?: number | null }> = [
      { id: 'mac', caps: ['admin', 'read'], createdAt: 10 },
      { id: 'mac2', caps: ['admin', 'read'], createdAt: 5_000 },
      { id: 'rig', caps: ['admin', 'read'], createdAt: 20 }
    ]
    const r = rig(keys)
    const mac = generateDeviceKeys()
    const id = { signPublic: mac.signPublic, sealPublic: mac.sealPublic }
    r.givers.cutOver()
    r.tick(1_000)
    expect(r.givers.claim(principal('mac', ['admin', 'read']), id, 'MacBook').ok).toBe(true)
    const proof = signBytes(mac.signPrivate, giverMoveBytes('mac2'))
    // While the old key lives the record stays.
    expect(r.givers.claim(principal('mac2', ['admin', 'read']), id, 'MacBook', proof).ok).toBe(false)
    keys[0].revokedAt = 2_000
    // Another key, or one with no proof by the giver's identity, cannot take it.
    expect(r.givers.claim(principal('rig', ['admin', 'read']), id, 'Rig', proof).ok).toBe(false)
    expect(r.givers.claim(principal('mac2', ['admin', 'read']), id, 'MacBook').ok).toBe(false)
    expect(r.givers.claim(principal('mac2', ['admin', 'read']), id, 'MacBook', proof)).toMatchObject({ ok: true, giver: { keyId: 'mac2', identity: id } })
    expect(r.givers.isGiver('mac2')).toBe(true)
  })

  it('a device key, a client key and a claim before the stamp are refused', () => {
    const r = rig([
      { id: 'pc', caps: ['device', 'operate', 'read'], createdAt: 10 },
      { id: 'phone', caps: ['operate', 'read'], createdAt: 10 }
    ])
    expect(r.givers.claim(principal('pc', ['admin', 'read']), identity, 'PC').ok).toBe(false)
    r.givers.cutOver()
    expect(r.givers.claim(principal('pc', ['device', 'read']), identity, 'PC').ok).toBe(false)
    expect(r.givers.claim(principal('phone', ['operate', 'read']), identity, 'Phone').ok).toBe(false)
  })

  it('give follows the record: only the giver\'s key pushes, takes over or hands off, and a revoked giver key loses it', () => {
    const keys = [
      { id: 'mac', caps: ['admin', 'read'] as Capability[], createdAt: 10, revokedAt: null as number | null },
      { id: 'rig', caps: ['admin', 'read'] as Capability[], createdAt: 20 }
    ]
    const r = rig(keys)
    r.givers.cutOver()
    r.givers.claim(principal('mac', ['admin', 'read']), identity, 'MacBook')
    const mac = r.givers.withGive(principal('mac', ['admin', 'read']))
    const other = r.givers.withGive(principal('rig', ['admin', 'read']))
    for (const method of ['accounts.push', 'accounts.removed', 'accounts.confirm', 'accounts.released'] as const) {
      expect(capabilityRefusal(mac, { method })).toBeNull()
      expect(capabilityRefusal(other, { method })).toMatch(/needs give/)
    }
    expect(capabilityRefusal(other, { method: 'accounts.pull', params: { takeOver: true } })).toMatch(/needs give/)
    expect(capabilityRefusal(mac, { method: 'accounts.pull', params: { takeOver: true } })).toBeNull()
    // a key that claims give on its own row gets nothing from it
    expect(r.givers.withGive(principal('rig', ['admin', 'give', 'read']))).not.toContain('give')
    keys[0].revokedAt = 99
    expect(r.givers.withGive(principal('mac', ['admin', 'read']))).not.toContain('give')
  })

  it('the box moves the giver itself, never to a given computer', () => {
    const r = rig([
      { id: 'mac', caps: ['admin', 'read'], createdAt: 10 },
      { id: 'mac2', caps: ['admin', 'read'], createdAt: 50_000 },
      { id: 'pc', caps: ['device', 'read'], createdAt: 10 }
    ])
    r.givers.cutOver()
    r.givers.claim(principal('mac', ['admin', 'read']), identity, 'MacBook')
    expect(() => r.givers.set('pc')).toThrow(/given computer/)
    expect(r.givers.set('mac2', undefined, 'New Mac')?.keyId).toBe('mac2')
    expect(r.givers.isGiver('mac')).toBe(false)
    expect(r.givers.set(null)).toBeNull()
    expect(r.givers.giver()).toBeNull()
  })

  it('a key the box named the giver fills in its identity on its first claim, and only that key; then it is fixed', () => {
    const r = rig([
      { id: 'mac', caps: ['admin', 'read'], createdAt: 10 },
      { id: 'mac2', caps: ['admin', 'read'], createdAt: 50_000 }
    ])
    r.givers.cutOver()
    r.givers.set('mac2', undefined, 'New Mac')
    expect(r.givers.giver()?.identity.signPublic).toBe('')
    expect(r.givers.claim(principal('mac', ['admin', 'read']), identity, 'MacBook').ok).toBe(false)
    const claimed = r.givers.claim(principal('mac2', ['admin', 'read']), { signPublic: 'mac2-sign', sealPublic: 'mac2-seal' }, 'New Mac')
    expect(claimed.ok && claimed.giver.identity.signPublic).toBe('mac2-sign')
    expect(r.givers.giver()?.identity.signPublic).toBe('mac2-sign')
    expect(r.givers.claim(principal('mac2', ['admin', 'read']), identity, 'New Mac').ok).toBe(false)
  })
})

describe('the device identity', () => {
  it('is made once, kept, and a new one follows a retire', () => {
    const store = memoryIdentityStore()
    const a = new DeviceIdentities(store)
    const first = a.publicIdentity()
    expect(new DeviceIdentities(store).publicIdentity()).toEqual(first)
    a.retire()
    expect(new DeviceIdentities(store).publicIdentity()).not.toEqual(first)
  })
})

describe('a Mac one release behind (the legacy stretch)', () => {
  it('until a giver claims, every live admin key keeps give, a newer one too; a device key does not', () => {
    const r = rig([
      { id: 'mac', caps: ['admin', 'read'], createdAt: 10 },
      { id: 'new', caps: ['admin', 'read'], createdAt: 5_000 },
      { id: 'pc', caps: ['device', 'read'], createdAt: 10 }
    ])
    r.givers.cutOver()
    expect(r.givers.legacy()).toBe(true)
    const mac = r.givers.withGive(principal('mac', ['admin', 'read']))
    expect(capabilityRefusal(mac, { method: 'accounts.push' })).toBeNull()
    expect(capabilityRefusal(mac, { method: 'accounts.pull', params: { takeOver: true } })).toBeNull()
    expect(capabilityRefusal(mac, { method: 'session.list' })).toBeNull()
    expect(r.givers.withGive(principal('new', ['admin', 'read']))).toContain('give')
    expect(r.givers.withGive(principal('pc', ['device', 'read']))).not.toContain('give')
  })

  it('the first claim ends the stretch for every other key', () => {
    const r = rig([
      { id: 'mac', caps: ['admin', 'read'], createdAt: 10 },
      { id: 'rig', caps: ['admin', 'read'], createdAt: 20 }
    ])
    r.givers.cutOver()
    expect(r.givers.withGive(principal('rig', ['admin', 'read']))).toContain('give')
    r.givers.claim(principal('mac', ['admin', 'read']), identity, 'MacBook')
    expect(r.givers.legacy()).toBe(false)
    expect(r.givers.withGive(principal('rig', ['admin', 'read']))).not.toContain('give')
    expect(r.givers.withGive(principal('mac', ['admin', 'read']))).toContain('give')
  })

  it('a proof may stamp the upgrade later, so its keys count as older', () => {
    const r = rig([{ id: 'k', caps: ['admin', 'read'], createdAt: 2_000 }])
    r.givers.cutOver(9_999)
    expect(r.givers.upgradeAt()).toBe(9_999)
    expect(r.givers.withGive(principal('k', ['admin', 'read']))).toContain('give')
  })

  it('clearing the giver never opens the stretch again', () => {
    const r = rig([
      { id: 'mac', caps: ['admin', 'read'], createdAt: 10 },
      { id: 'rig', caps: ['admin', 'read'], createdAt: 20 }
    ])
    r.givers.cutOver()
    r.givers.claim(principal('mac', ['admin', 'read']), identity, 'MacBook')
    r.givers.set(null)
    expect(r.givers.legacy()).toBe(false)
    expect(r.givers.withGive(principal('rig', ['admin', 'read']))).not.toContain('give')
    expect(r.givers.withGive(principal('mac', ['admin', 'read']))).not.toContain('give')
  })
})

describe('who claims the giver', () => {
  const host = { platform: 'darwin', desktop: true, isolated: false, played: 'darwin', oldWire: false }
  it("a Mac's desktop, and an isolated instance playing a Mac; never a PC, the box or a Mac one release behind", () => {
    expect(claimsGiver(host)).toBe(true)
    expect(claimsGiver({ ...host, desktop: false })).toBe(false)
    expect(claimsGiver({ ...host, platform: 'win32', played: 'win32' })).toBe(false)
    expect(claimsGiver({ ...host, platform: 'linux', desktop: false, played: 'linux', isolated: true })).toBe(false)
    expect(claimsGiver({ ...host, platform: 'linux', desktop: false, played: 'darwin', isolated: true })).toBe(true)
    expect(claimsGiver({ ...host, platform: 'linux', desktop: false, played: 'darwin', isolated: false })).toBe(false)
    expect(claimsGiver({ ...host, isolated: true, oldWire: true })).toBe(false)
  })
})
