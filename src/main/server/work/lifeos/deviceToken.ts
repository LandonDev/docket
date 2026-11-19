import { vault } from 'aliax-core'
import { ADDON_SERVICE } from '@shared/addonGrant'

/**
 * This host's LifeOS device token, sealed in its own vault (architecture §5:
 * it rides the `addon` service, no new aliax-core id). It is a bare sealed
 * secret with no profile entry, so nothing that walks profiles sees it: the
 * account sync never sends it to another host and the add-on grant sweep
 * never deletes it. Its name cannot be an add-on id (those are `ad_` and
 * twelve characters). It is kept with the LifeOS address it was issued by,
 * and handed only to that address.
 */
export const DEVICE_TOKEN_NAME = '~lifeos-device'

export interface StoredDevice {
  v: 1
  token: string
  /** the LifeOS deployment that issued it */
  url: string
  at: number
}

export interface DeviceTokenStore {
  read(): StoredDevice | null
  write(device: StoredDevice): void
  clear(): void
}

let warned = false
export const vaultDeviceToken: DeviceTokenStore = {
  read() {
    let raw: string | null
    try {
      raw = vault.readSecret(ADDON_SERVICE, DEVICE_TOKEN_NAME)
    } catch {
      if (!warned) console.warn('[work] lifeos: the device token could not be read from the vault')
      warned = true
      return null
    }
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as StoredDevice
      return parsed.v === 1 && typeof parsed.token === 'string' && typeof parsed.url === 'string' ? parsed : null
    } catch {
      return null
    }
  },
  write(device) {
    vault.saveSecret(ADDON_SERVICE, DEVICE_TOKEN_NAME, JSON.stringify(device))
  },
  clear() {
    vault.deleteProfile(ADDON_SERVICE, DEVICE_TOKEN_NAME)
  }
}

/** A store in memory, for tests and an in-process proof. */
export function memoryDeviceToken(initial: StoredDevice | null = null): DeviceTokenStore & { current(): StoredDevice | null } {
  let held = initial
  return {
    read: () => held,
    write: (d) => void (held = d),
    clear: () => void (held = null),
    current: () => held
  }
}
