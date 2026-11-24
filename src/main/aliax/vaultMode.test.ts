import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configure, vault } from 'aliax-core'
import { safeStorageWrap, secretsModeFor, setVaultAside, type SafeStorageLike } from './vaultMode'

/** DPAPI's stand-in: a per-user tag, and not ready until the app is. */
function fakeStore(user: string, ready = true): SafeStorageLike & { ready: boolean } {
  return {
    ready,
    isEncryptionAvailable() {
      return this.ready
    },
    encryptString: (plain) => Buffer.from(`${user}|${plain}`),
    decryptString: (sealed) => {
      const [who, plain] = sealed.toString().split('|')
      if (who !== user) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return plain
    }
  }
}

const dirs: string[] = []
afterEach(() => {
  vault.resetKeyCache()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tc-vault-mode-'))
  dirs.push(d)
  return d
}
const noFetch = async (): Promise<Response> => {
  throw new Error('no fetch')
}

describe('secretsModeFor', () => {
  it('keeps the Mac on the Keychain and the box on its plain key file', () => {
    const store = fakeStore('me')
    expect(secretsModeFor('darwin', false, store)).toEqual({ mode: 'chromiumKey', keychainItem: 'aliax Safe Storage' })
    expect(secretsModeFor('darwin', true, store)).toEqual({ mode: 'fileKey' })
    expect(secretsModeFor('linux', false, store)).toEqual({ mode: 'fileKey' })
  })

  it('seals the key file for the user on Windows, an isolated vault included', () => {
    for (const isolated of [false, true]) {
      const mode = secretsModeFor('win32', isolated, fakeStore('me'))
      expect(mode.mode).toBe('fileKey')
      expect(mode.mode === 'fileKey' && mode.wrap).toBeTruthy()
    }
  })
})

describe('the Windows vault through safeStorage', () => {
  it('makes a sealed key, reads it back, and locks for another user without rewriting it', () => {
    const dataDir = temp()
    configure({ dataDir, fetch: noFetch, secrets: secretsModeFor('win32', true, fakeStore('tcuser')) })
    vault.resetKeyCache()
    vault.saveSecret('claude-code', 'fake', 'fake-token')
    const key = readFileSync(join(dataDir, 'vault.key'), 'utf8')
    expect(key.startsWith('aliax-wrap:v1:')).toBe(true)
    configure({ dataDir, fetch: noFetch, secrets: secretsModeFor('win32', true, fakeStore('tcuser2')) })
    vault.resetKeyCache()
    expect(vault.vaultLockReason()).toBe('unwrap')
    expect(readFileSync(join(dataDir, 'vault.key'), 'utf8')).toBe(key)
  })

  it('is locked before safeStorage is ready and opens once it is, the key unchanged', () => {
    const dataDir = temp()
    const store = fakeStore('tcuser')
    configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey', wrap: safeStorageWrap(store) } })
    vault.resetKeyCache()
    vault.saveSecret('codex', 'fake', 'x')
    const key = readFileSync(join(dataDir, 'vault.key'), 'utf8')
    vault.resetKeyCache()
    store.ready = false
    expect(vault.vaultLockReason()).toBe('unwrap')
    store.ready = true
    expect(vault.readSecret('codex', 'fake')).toBe('x')
    expect(readFileSync(join(dataDir, 'vault.key'), 'utf8')).toBe(key)
  })
})

describe('setVaultAside (Start fresh)', () => {
  it('moves the key, the secrets and the profiles aside whole, and a new vault opens after', () => {
    const dataDir = temp()
    writeFileSync(join(dataDir, 'vault.key'), 'garbage')
    mkdirSync(join(dataDir, 'secrets'))
    writeFileSync(join(dataDir, 'secrets', 'codex__a.bin'), 'v10sealed')
    writeFileSync(join(dataDir, 'profiles.json'), '{}')
    writeFileSync(join(dataDir, 'settings.json'), '{"kept":true}')
    const aside = setVaultAside(dataDir, Date.UTC(2026, 10, 23, 12))
    expect(aside).toMatch(/locked-2026-11-23T12-00-00-000Z$/)
    expect(readFileSync(join(aside!, 'secrets', 'codex__a.bin'), 'utf8')).toBe('v10sealed')
    expect(existsSync(join(dataDir, 'vault.key'))).toBe(false)
    expect(readFileSync(join(dataDir, 'settings.json'), 'utf8')).toBe('{"kept":true}')
    configure({ dataDir, fetch: noFetch, secrets: secretsModeFor('win32', true, fakeStore('tcuser')) })
    vault.resetKeyCache()
    expect(vault.vaultLockReason()).toBeNull()
    expect(setVaultAside(temp(), 0)).toBeNull()
  })
})
