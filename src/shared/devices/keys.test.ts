import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  deriveLinkKeys,
  fingerprint,
  generateDeviceKeys,
  openSealed,
  openWithKey,
  sealTo,
  sealWithKey,
  signBytes,
  threeWords,
  verifyBytes
} from './keys'

const data = Buffer.from('test message')
const aad = Buffer.from('test header')

describe('device keys', () => {
  it('generates distinct key pairs with raw public keys and PKCS8 private keys', () => {
    const keys = generateDeviceKeys()
    const other = generateDeviceKeys()
    expect(keys.signPublic).not.toBe(other.signPublic)
    expect(keys.sealPublic).not.toBe(other.sealPublic)
    expect(Buffer.from(keys.signPublic, 'base64url')).toHaveLength(32)
    expect(Buffer.from(keys.sealPublic, 'base64url')).toHaveLength(32)
    expect(Buffer.from(keys.signPrivate, 'base64url').subarray(0, 16).toString('hex')).toBe(
      '302e020100300506032b657004220420'
    )
    expect(Buffer.from(keys.sealPrivate, 'base64url').subarray(0, 16).toString('hex')).toBe(
      '302e020100300506032b656e04220420'
    )
  })

  it('fingerprints the raw signing key', () => {
    const { signPublic } = generateDeviceKeys()
    const expected = createHash('sha256').update(Buffer.from(signPublic, 'base64url')).digest('hex')
    expect(fingerprint(signPublic)).toBe(expected.slice(0, 32))
  })

  it('only verifies the original bytes with the signing public key', () => {
    const keys = generateDeviceKeys()
    const signature = signBytes(keys.signPrivate, data)
    expect(verifyBytes(keys.signPublic, data, signature)).toBe(true)
    expect(verifyBytes(keys.signPublic, Buffer.from('Test message'), signature)).toBe(false)
    expect(verifyBytes(generateDeviceKeys().signPublic, data, signature)).toBe(false)
  })

  it('rejects the Ed25519 identity point as a signing key', () => {
    const identity = Buffer.alloc(32)
    identity[0] = 1
    const signature = Buffer.alloc(64)
    signature[0] = 1
    expect(verifyBytes(identity.toString('base64url'), data, signature.toString('base64url'))).toBe(
      false
    )
  })

  it('returns false for malformed signatures, public keys and data', () => {
    const keys = generateDeviceKeys()
    const signature = signBytes(keys.signPrivate, data)
    expect(verifyBytes(keys.signPublic, data, '%%%')).toBe(false)
    expect(verifyBytes(keys.signPublic, data, signature + '=')).toBe(false)
    expect(verifyBytes(keys.signPublic, data, signature.slice(0, -1))).toBe(false)
    expect(verifyBytes(keys.signPublic + '=', data, signature)).toBe(false)
    expect(verifyBytes('', data, signature)).toBe(false)
    expect(verifyBytes(keys.signPublic, null as never, signature)).toBe(false)
  })
})

describe('canonical JSON', () => {
  it('sorts keys at every depth and preserves array positions', () => {
    const value = { z: undefined, a: [{ d: 1, c: 2 }, undefined, 'last'], 2: true, 10: false }
    const reordered = { 10: false, a: [{ c: 2, d: 1 }, undefined, 'last'], 2: true }
    expect(canonicalJson(value)).toBe('{"10":false,"2":true,"a":[{"c":2,"d":1},null,"last"]}')
    expect(canonicalJson(reordered)).toBe(canonicalJson(value))
  })

  it('keeps a JSON property named __proto__ and escapes keys and values', () => {
    const value = JSON.parse('{"z":1,"__proto__":{"y":2,"a":3}}')
    expect(canonicalJson({ ...value, 'a"': '\n' })).toBe(
      '{"__proto__":{"a":3,"y":2},"a\\"":"\\n","z":1}'
    )
  })
})

describe('setup link keys', () => {
  it('derives both keys deterministically with the protocol labels', () => {
    const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
    const keys = deriveLinkKeys(secret)
    const other = deriveLinkKeys(Buffer.alloc(32, 77))
    expect(deriveLinkKeys(Buffer.from(secret))).toEqual(keys)
    expect(other.bundleKey).not.toEqual(keys.bundleKey)
    expect(other.verifier.public).not.toBe(keys.verifier.public)
    expect(other.verifier.private).not.toBe(keys.verifier.private)
    expect(keys.bundleKey.toString('hex')).toBe(
      'da28bdebe0e1401d380766bf0bbcee37528283632654a969d8ed8740c1ba0655'
    )
    expect(Buffer.from(keys.verifier.private, 'base64url').toString('hex')).toBe(
      '302e020100300506032b6570042204206e2787c8dc3dc884f44161c71639a79db7f03ef4b56b3ea9e014ab69f1dc7640'
    )
    expect(verifyBytes(keys.verifier.public, data, signBytes(keys.verifier.private, data))).toBe(
      true
    )
    expect(() => deriveLinkKeys(Buffer.alloc(31))).toThrow('Invalid link secret length')
  })
})

describe('sealing with a symmetric key', () => {
  const key = Buffer.alloc(32, 12)

  it('seals with a fresh IV and accepts empty plaintext without AAD', () => {
    const sealed = sealWithKey(key, data, aad)
    expect(openWithKey(key, sealed, aad)).toEqual(data)
    const iv = Buffer.from(sealed, 'base64url').subarray(0, 12)
    const nextIv = Buffer.from(sealWithKey(key, data, aad), 'base64url').subarray(0, 12)
    expect(nextIv).not.toEqual(iv)
    expect(openWithKey(key, sealWithKey(key, Buffer.alloc(0)))).toEqual(Buffer.alloc(0))
  })

  it('reads the IV, tag and ciphertext in that order', () => {
    const raw = Buffer.from(
      '000000000000000000000000d0d1c8a799996bf0265b98b5d48ab919cea7403d4d606b6e074ec5d3baf39d18',
      'hex'
    )
    expect(openWithKey(Buffer.alloc(32), raw.toString('base64url'))).toEqual(Buffer.alloc(16))
  })

  it('returns null for the wrong key, AAD or a broken box', () => {
    const sealed = sealWithKey(key, data, aad)
    const changed = Buffer.from(sealed, 'base64url')
    changed[changed.length - 1] ^= 1
    expect(openWithKey(Buffer.alloc(32, 13), sealed, aad)).toBeNull()
    expect(openWithKey(Buffer.alloc(31), sealed, aad)).toBeNull()
    expect(openWithKey(key, sealed)).toBeNull()
    expect(openWithKey(key, sealed, Buffer.from('other header'))).toBeNull()
    expect(openWithKey(key, changed.toString('base64url'), aad)).toBeNull()
    expect(openWithKey(key, '', aad)).toBeNull()
    expect(openWithKey(key, sealed + '!', aad)).toBeNull()
  })
})

describe('sealing to a device', () => {
  it('requires the right recipient key pair and associated data', () => {
    const recipient = generateDeviceKeys()
    const other = generateDeviceKeys()
    const box = sealTo(recipient.sealPublic, data, aad)
    expect(openSealed(recipient.sealPrivate, recipient.sealPublic, box, aad)).toEqual(data)
    expect(openSealed(other.sealPrivate, recipient.sealPublic, box, aad)).toBeNull()
    expect(openSealed(recipient.sealPrivate, other.sealPublic, box, aad)).toBeNull()
    expect(openSealed(recipient.signPrivate, recipient.sealPublic, box, aad)).toBeNull()
    expect(openSealed(recipient.sealPrivate, recipient.sealPublic, box, data)).toBeNull()
    expect(
      openSealed(recipient.sealPrivate, recipient.sealPublic, { ...box, ephemeral: 'bad' }, aad)
    ).toBeNull()
  })

  it('opens an independently generated X25519 and HKDF test vector', () => {
    const privateKey = 'MC4CAQAwBQYDK2VuBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f'
    const publicKey = 'j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8'
    const box = {
      ephemeral: 'NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ',
      sealed: 'AAECAwQFBgcICQoLgu_UkWeNPEY_DYJp4m7NrB_un2l6VKVljW1r1g'
    }
    expect(openSealed(privateKey, publicKey, box, aad)).toEqual(data)
  })

  it('makes a fresh ephemeral key for each box', () => {
    const recipient = generateDeviceKeys()
    const first = sealTo(recipient.sealPublic, data, aad)
    const second = sealTo(recipient.sealPublic, data, aad)
    expect(Buffer.from(first.ephemeral, 'base64url')).toHaveLength(32)
    expect(first.ephemeral).not.toBe(second.ephemeral)
  })
})

describe('setup words', () => {
  it('uses the same 256 distinct words at all three digest positions', () => {
    const words = new Map<number, string>()
    for (let i = 0; i < 4096; i++) {
      const material = `device claim ${i}`
      const digest = createHash('sha256').update(material).digest()
      const result = threeWords(material)
      expect(result).toEqual(threeWords(material))
      for (let position = 0; position < 3; position++) {
        const index = digest[position]
        const word = result[position]
        expect(word).toMatch(/^[a-z]{3,6}$/)
        if (words.has(index)) expect(word).toBe(words.get(index))
        words.set(index, word)
      }
      if (words.size === 256) break
    }
    expect(words.size).toBe(256)
    expect(new Set(words.values()).size).toBe(256)
  })
})
