import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { KeyWrap, SecretsMode } from 'aliax-core'

/** What Electron's safeStorage gives the wrap: on Windows DPAPI for the current user. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(sealed: Buffer): string
}

/**
 * The key file's password sealed for this OS user. Both directions throw
 * while safeStorage is not ready (before `whenReady`), which the core takes
 * as a lock it may lift on a later read, never as a reason to make a new key.
 */
export function safeStorageWrap(store: SafeStorageLike): KeyWrap {
  const ready = (): void => {
    if (!store.isEncryptionAvailable()) throw new Error('safeStorage is not available yet')
  }
  return {
    seal: (bytes) => {
      ready()
      return store.encryptString(bytes.toString('utf8'))
    },
    open: (bytes) => {
      ready()
      return Buffer.from(store.decryptString(bytes), 'utf8')
    }
  }
}

/**
 * How this host seals the vault. macOS (not isolated): the Keychain item
 * Aliax's safeStorage made, so both apps read one vault. Windows: a key file
 * whose password safeStorage seals for this user, so a copied
 * `%APPDATA%\aliax` opens for nobody else. Linux (the box) and an isolated
 * vault elsewhere: the plain key file, mode 0600.
 */
export function secretsModeFor(platform: NodeJS.Platform, isolated: boolean, store: SafeStorageLike): SecretsMode {
  if (platform === 'darwin' && !isolated) return { mode: 'chromiumKey', keychainItem: 'aliax Safe Storage' }
  if (platform === 'win32') return { mode: 'fileKey', wrap: safeStorageWrap(store) }
  return { mode: 'fileKey' }
}

/**
 * Start fresh on a vault that will not open: move what is there aside, whole,
 * into `locked-<time>` beside it, so a new vault is made on the next read and
 * nothing is deleted (a restored profile could still open the old one).
 * Returns the folder it moved them to, or null when there was nothing.
 */
export function setVaultAside(dataDir: string, now: number): string | null {
  const parts = ['vault.key', 'secrets', 'profiles.json'].filter((p) => existsSync(join(dataDir, p)))
  if (parts.length === 0) return null
  const aside = join(dataDir, `locked-${new Date(now).toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(aside, { recursive: true, mode: 0o700 })
  for (const p of parts) renameSync(join(dataDir, p), join(aside, p))
  return aside
}
