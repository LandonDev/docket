import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/** The vault's files, a migration's half-made set included: all of them go aside, or the next open finishes the migration into the new vault (F23). */
const VAULT_PARTS = ['vault.key', 'vault.key.next', 'secrets', 'secrets.next', 'secrets.old', 'profiles.json']

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Start fresh on a vault that will not open: move what is there aside, whole,
 * into `locked-<time>` beside it, so a new vault is made on the next read and
 * nothing is deleted (a restored profile could still open the old one).
 * Under aliax-core's lock file (`vault.key.lock`, the same {pid, at, id}): a
 * process that holds it (Aliax open on the same vault) makes Start fresh
 * refuse, and one that died leaves a lock that is cleared. Returns the folder
 * it moved them to, or null when there was nothing.
 */
export function setVaultAside(dataDir: string, now: number): string | null {
  const lock = join(dataDir, 'vault.key.lock')
  const mine = JSON.stringify({ pid: process.pid, at: Date.now(), id: randomBytes(8).toString('hex') })
  for (let tries = 0; ; tries++) {
    try {
      writeFileSync(lock, mine, { flag: 'wx', mode: 0o600 })
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let held: { pid?: unknown } = {}
      try {
        held = JSON.parse(readFileSync(lock, 'utf8')) as { pid?: unknown }
      } catch {
        // half written: a live writer
      }
      if (tries === 0 && typeof held.pid === 'number' && !pidAlive(held.pid)) {
        rmSync(lock, { force: true })
        continue
      }
      throw new Error('Another app is using the vault. Quit it and press Start fresh again.')
    }
  }
  try {
    const parts = VAULT_PARTS.filter((p) => existsSync(join(dataDir, p)))
    if (parts.length === 0) return null
    const aside = join(dataDir, `locked-${new Date(now).toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(aside, { recursive: true, mode: 0o700 })
    for (const p of parts) renameSync(join(dataDir, p), join(aside, p))
    return aside
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === mine) rmSync(lock, { force: true })
    } catch {
      // gone already
    }
  }
}
