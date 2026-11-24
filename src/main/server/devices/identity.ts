import { vault } from 'aliax-core'
import { ADDON_SERVICE } from '@shared/addonGrant'
import { generateDeviceKeys, type DeviceKeys } from '@shared/devices/keys'
import type { DeviceIdentity } from '@shared/contract-devices'

/**
 * This install's device identity: an Ed25519 key to sign and an X25519 key
 * to be sealed to (shared/devices/keys.ts), made once on first need and kept
 * in this host's own vault as a bare secret with no profile entry, like the
 * LifeOS device token (work/lifeos/deviceToken.ts): nothing that walks
 * profiles sees it, so the account sync never sends it anywhere. The giver
 * signs its letters with it; a given computer is sealed to it.
 */
export const IDENTITY_NAME = '~device-identity'

interface StoredIdentity {
  v: 1
  keys: DeviceKeys
  at: number
}

export interface IdentityStore {
  read(): string | null
  write(raw: string): void
  clear(): void
}

export const vaultIdentityStore: IdentityStore = {
  read: () => vault.readSecret(ADDON_SERVICE, IDENTITY_NAME),
  write: (raw) => vault.saveSecret(ADDON_SERVICE, IDENTITY_NAME, raw, 'sync'),
  clear: () => vault.deleteProfile(ADDON_SERVICE, IDENTITY_NAME)
}

export function memoryIdentityStore(): IdentityStore {
  let held: string | null = null
  return { read: () => held, write: (raw) => void (held = raw), clear: () => void (held = null) }
}

const parse = (raw: string | null): DeviceKeys | null => {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as StoredIdentity
    const k = s?.keys
    return s?.v === 1 && k && [k.signPublic, k.signPrivate, k.sealPublic, k.sealPrivate].every((x) => typeof x === 'string' && x.length > 0) ? k : null
  } catch {
    return null
  }
}

export class DeviceIdentities {
  private cached: DeviceKeys | null = null
  constructor(
    private readonly store: IdentityStore = vaultIdentityStore,
    private readonly now: () => number = Date.now
  ) {}

  /** The keys, made and sealed in the vault the first time. Throws when the vault is locked: no identity is made over one. */
  keys(): DeviceKeys {
    if (this.cached) return this.cached
    const found = parse(this.store.read())
    if (found) return (this.cached = found)
    const keys = generateDeviceKeys()
    this.store.write(JSON.stringify({ v: 1, keys, at: this.now() } satisfies StoredIdentity))
    return (this.cached = keys)
  }

  /** The public half another computer pins. */
  publicIdentity(): DeviceIdentity {
    const k = this.keys()
    return { signPublic: k.signPublic, sealPublic: k.sealPublic }
  }

  /** Retire it (Remove's last step, Start fresh on a given computer): the next need makes a new one. */
  retire(): void {
    this.store.clear()
    this.cached = null
  }
}
