import type { Capability, Principal } from '@shared/capabilities'
import type { DeviceIdentity, GiverRecord } from '@shared/contract-devices'

/**
 * The giver: the one computer whose Accounts page signs in, the only key
 * that may introduce, hand off or withdraw an account on another computer
 * (docs/agents/pc-setup.md). The box records it as its key id and the
 * computer's device identity. `give` is never stored on a key row: a
 * principal holds it while its key is the recorded giver's
 * (`withGive`), so moving the giver takes effect on live sockets at once.
 *
 * The cut-over: the first boot of this build stamps `devices.upgradeAt` and
 * ends every pairing offer minted before it. The Mac's first link after the
 * upgrade claims the giver (`devices.claimGiver`), which the box allows
 * while none is set and only to an admin key that existed before the
 * upgrade; every such key was already full trust, so this is no weaker than
 * before. After that only `devices.setGiver`, local to the box
 * (`tc-local`), moves it.
 *
 * Until a giver is recorded the box is in its legacy stretch: a Mac one
 * release behind never claims, so every admin key made before the upgrade
 * keeps today's powers (`give` included) and its handoffs may name no id.
 * The first claim ends the stretch for good.
 */

export const GIVER_SETTING = 'devices.giver'
export const UPGRADE_SETTING = 'devices.upgradeAt'

export interface GiverStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string | null): void
}

export interface GiverAuth {
  getKey(id: string): { id: string; caps: Capability[]; createdAt: number; revokedAt: number | null } | null
  /** End every open pairing offer; returns how many. */
  endOpenPairings(): number
}

export class Givers {
  private cached: GiverRecord | null | undefined

  constructor(
    private readonly store: GiverStore,
    private readonly auth: GiverAuth,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (line) => console.log(`[devices] ${line}`)
  ) {}

  /**
   * Stamp the upgrade once and end the pairing offers made before it. Idempotent.
   * `at` is a proof's seam (TEMP_CODE_DEVICES_UPGRADE_AT, isolated instances only), so a
   * key made during the run counts as one made before the upgrade.
   */
  cutOver(at?: number): void {
    if (this.store.getSetting(UPGRADE_SETTING)) return
    const ended = this.auth.endOpenPairings()
    this.store.setSetting(UPGRADE_SETTING, String(at ?? this.now()))
    this.log(`upgrade stamped; ${ended} pairing offer${ended === 1 ? '' : 's'} made before it ended`)
  }

  upgradeAt(): number | null {
    const raw = this.store.getSetting(UPGRADE_SETTING)
    return raw ? Number(raw) : null
  }

  giver(): GiverRecord | null {
    if (this.cached !== undefined) return this.cached
    const raw = this.store.getSetting(GIVER_SETTING)
    let parsed: GiverRecord | null = null
    try {
      parsed = raw ? (JSON.parse(raw) as GiverRecord) : null
    } catch {
      parsed = null
    }
    this.cached = parsed
    return parsed
  }

  private write(record: GiverRecord | null): void {
    this.store.setSetting(GIVER_SETTING, record ? JSON.stringify(record) : null)
    this.cached = record
  }

  /** Whether this key is the giver's, and its key still live. */
  isGiver(keyId: string): boolean {
    const g = this.giver()
    if (!g || g.keyId !== keyId) return false
    const key = this.auth.getKey(keyId)
    return !!key && key.revokedAt === null
  }

  /** No giver recorded yet: the stretch where a Mac one release behind still syncs as it did. */
  legacy(): boolean {
    return this.giver() === null
  }

  /** An admin key made before the upgrade stamp, live: today's full trust. */
  private preUpgradeAdmin(keyId: string): boolean {
    const key = this.auth.getKey(keyId)
    const upgradeAt = this.upgradeAt()
    return !!key && key.revokedAt === null && key.caps.includes('admin') && !key.caps.includes('device') && upgradeAt !== null && key.createdAt < upgradeAt
  }

  /** The caps a remote principal acts with: its key's, plus `give` while it is the giver's (or, in the legacy stretch, an old admin key). */
  withGive(principal: Principal & { kind: 'remote' }): Capability[] {
    const caps = principal.caps.filter((c) => c !== 'give')
    const gives = this.legacy() ? this.preUpgradeAdmin(principal.keyId) : this.isGiver(principal.keyId)
    return gives ? [...caps, 'give'] : caps
  }

  /** The Mac's first link after the upgrade. Repeats from the giver itself answer ok. */
  claim(principal: Principal & { kind: 'remote' }, identity: DeviceIdentity, name: string): { ok: true; giver: GiverRecord } | { ok: false; error: string } {
    const current = this.giver()
    if (current) {
      if (current.keyId !== principal.keyId) return { ok: false, error: 'another computer is the giver; change it on the box with tc-local devices.setGiver' }
      if (current.identity.signPublic !== identity.signPublic) return { ok: false, error: 'this key is the giver under another identity; change it on the box with tc-local devices.setGiver' }
      return { ok: true, giver: current }
    }
    const key = this.auth.getKey(principal.keyId)
    const upgradeAt = this.upgradeAt()
    if (!key || key.revokedAt !== null) return { ok: false, error: 'unknown key' }
    if (!key.caps.includes('admin') || key.caps.includes('device')) return { ok: false, error: 'only an admin key may claim the giver' }
    if (upgradeAt === null || key.createdAt >= upgradeAt) return { ok: false, error: 'only a key made before this upgrade may claim the giver; set it on the box with tc-local devices.setGiver' }
    const record: GiverRecord = { keyId: key.id, identity, name, at: this.now() }
    this.write(record)
    this.log(`giver claimed by key ${key.id} (${name})`)
    return { ok: true, giver: record }
  }

  /** The box's own say (tc-local): make this key the giver, or clear it. */
  set(keyId: string | null, identity?: DeviceIdentity, name?: string): GiverRecord | null {
    if (keyId === null) {
      this.write(null)
      this.log('giver cleared')
      return null
    }
    const key = this.auth.getKey(keyId)
    if (!key || key.revokedAt !== null) throw new Error(`unknown key: ${keyId}`)
    if (key.caps.includes('device')) throw new Error('a given computer cannot be the giver')
    const prior = this.giver()
    const record: GiverRecord = {
      keyId,
      identity: identity ?? (prior?.keyId === keyId ? prior.identity : { signPublic: '', sealPublic: '' }),
      name: name ?? prior?.name ?? keyId,
      at: this.now()
    }
    this.write(record)
    this.log(`giver set to key ${keyId}`)
    return record
  }
}
