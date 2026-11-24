import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject
} from 'node:crypto'

export interface DeviceKeys {
  signPublic: string
  signPrivate: string
  sealPublic: string
  sealPrivate: string
}

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
// Algorithm identifiers and length fields for 32-byte RFC 8410 keys.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex')
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const EMPTY_SALT = Buffer.alloc(0)
const ED25519_FIELD_PRIME = Buffer.from('7f' + 'ff'.repeat(30) + 'ed', 'hex')
// The canonical y-coordinates of the small-order points, in little-endian order.
// https://github.com/jedisct1/libsodium/blob/1.0.19-RELEASE/src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c#L997-L1049
const ED25519_SMALL_ORDER_Y = new Set([
  '00'.repeat(32),
  '01' + '00'.repeat(31),
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ec' + 'ff'.repeat(30) + '7f'
])

function decodeBase64Url(value: string): Buffer {
  if (typeof value !== 'string') throw new Error('Invalid base64url')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error('Invalid base64url')
  return bytes
}

function rawPublic(encoded: string): Buffer {
  const bytes = decodeBase64Url(encoded)
  if (bytes.length !== KEY_BYTES) throw new Error('Invalid public key length')
  return bytes
}

function importPublic(bytes: Buffer, prefix: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([prefix, bytes]), type: 'spki', format: 'der' })
}

function importPrivate(encoded: string, algorithm: 'ed25519' | 'x25519'): KeyObject {
  const key = createPrivateKey({ key: decodeBase64Url(encoded), type: 'pkcs8', format: 'der' })
  if (key.asymmetricKeyType !== algorithm) throw new Error('Invalid private key type')
  return key
}

function exportPublic(key: KeyObject): Buffer {
  return key.export({ type: 'spki', format: 'der' }).subarray(-KEY_BYTES)
}

function exportPrivate(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
}

export function generateDeviceKeys(): DeviceKeys {
  const signing = generateKeyPairSync('ed25519')
  const sealing = generateKeyPairSync('x25519')
  return {
    signPublic: exportPublic(signing.publicKey).toString('base64url'),
    signPrivate: exportPrivate(signing.privateKey),
    sealPublic: exportPublic(sealing.publicKey).toString('base64url'),
    sealPrivate: exportPrivate(sealing.privateKey)
  }
}

export function fingerprint(signPublic: string): string {
  return createHash('sha256').update(rawPublic(signPublic)).digest().subarray(0, 16).toString('hex')
}

export function signBytes(signPrivate: string, data: Buffer): string {
  if (!Buffer.isBuffer(data)) throw new Error('Invalid data to sign')
  return sign(null, data, importPrivate(signPrivate, 'ed25519')).toString('base64url')
}

function isSigningPoint(bytes: Buffer): boolean {
  // Some OpenSSL versions accept small-order public keys. Ignore the x sign bit when checking y.
  const y = Buffer.from(bytes)
  y[31] &= 0x7f
  return (
    !ED25519_SMALL_ORDER_Y.has(y.toString('hex')) && y.reverse().compare(ED25519_FIELD_PRIME) < 0
  )
}

export function verifyBytes(signPublic: string, data: Buffer, sig: string): boolean {
  try {
    if (!Buffer.isBuffer(data)) return false
    const signature = decodeBase64Url(sig)
    if (signature.length !== 64) return false
    const publicKey = rawPublic(signPublic)
    if (!isSigningPoint(publicKey)) return false
    return verify(null, data, importPublic(publicKey, ED25519_SPKI), signature)
  } catch {
    return false
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function sortedJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(sortedJson).join(',') + ']'
  // Assemble object members directly so integer-looking keys also sort lexically.
  const members = Object.keys(value)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + sortedJson(value[key]))
  return '{' + members.join(',') + '}'
}

export function canonicalJson(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) throw new Error('No JSON value')
    return sortedJson(JSON.parse(json))
  } catch {
    throw new Error('Could not encode canonical JSON')
  }
}

function deriveKey(secret: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, salt, info, KEY_BYTES))
}

export function deriveLinkKeys(secret: Buffer): {
  bundleKey: Buffer
  verifier: { public: string; private: string }
} {
  if (!Buffer.isBuffer(secret) || secret.length !== KEY_BYTES)
    throw new Error('Invalid link secret length')
  const bundleKey = deriveKey(secret, EMPTY_SALT, 'tempcode setup bundle v1')
  const seed = deriveKey(secret, EMPTY_SALT, 'tempcode setup verifier v1')
  const pkcs8 = Buffer.concat([ED25519_PKCS8, seed])
  const privateKey = createPrivateKey({ key: pkcs8, type: 'pkcs8', format: 'der' })
  return {
    bundleKey,
    verifier: {
      public: exportPublic(createPublicKey(privateKey)).toString('base64url'),
      private: pkcs8.toString('base64url')
    }
  }
}

export function sealWithKey(key: Buffer, plain: Buffer, aad?: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES)
    throw new Error('Invalid sealing key length')
  if (!Buffer.isBuffer(plain)) throw new Error('Invalid plaintext')
  if (aad !== undefined && !Buffer.isBuffer(aad)) throw new Error('Invalid associated data')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  if (aad !== undefined) cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

export function openWithKey(key: Buffer, sealed: string, aad?: Buffer): Buffer | null {
  try {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) return null
    if (aad !== undefined && !Buffer.isBuffer(aad)) return null
    const bytes = decodeBase64Url(sealed)
    const ciphertextOffset = IV_BYTES + TAG_BYTES
    if (bytes.length < ciphertextOffset) return null
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES), {
      authTagLength: TAG_BYTES
    })
    if (aad !== undefined) decipher.setAAD(aad)
    decipher.setAuthTag(bytes.subarray(IV_BYTES, ciphertextOffset))
    return Buffer.concat([decipher.update(bytes.subarray(ciphertextOffset)), decipher.final()])
  } catch {
    return null
  }
}

function deviceLetterKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return deriveKey(shared, Buffer.concat([ephemeral, recipient]), 'tempcode device letter v1')
}

export function sealTo(
  sealPublic: string,
  plain: Buffer,
  aad: Buffer
): {
  ephemeral: string
  sealed: string
} {
  if (!Buffer.isBuffer(aad)) throw new Error('Invalid associated data')
  const recipient = rawPublic(sealPublic)
  const keyPair = generateKeyPairSync('x25519')
  const ephemeral = exportPublic(keyPair.publicKey)
  const shared = diffieHellman({
    privateKey: keyPair.privateKey,
    publicKey: importPublic(recipient, X25519_SPKI)
  })
  return {
    ephemeral: ephemeral.toString('base64url'),
    sealed: sealWithKey(deviceLetterKey(shared, ephemeral, recipient), plain, aad)
  }
}

export function openSealed(
  sealPrivate: string,
  sealPublicOfMe: string,
  box: { ephemeral: string; sealed: string },
  aad: Buffer
): Buffer | null {
  try {
    if (!Buffer.isBuffer(aad)) return null
    const ephemeral = rawPublic(box.ephemeral)
    const recipient = rawPublic(sealPublicOfMe)
    const shared = diffieHellman({
      privateKey: importPrivate(sealPrivate, 'x25519'),
      publicKey: importPublic(ephemeral, X25519_SPKI)
    })
    return openWithKey(deviceLetterKey(shared, ephemeral, recipient), box.sealed, aad)
  } catch {
    return null
  }
}

// These positions are part of the setup protocol. Keep the order stable.
// prettier-ignore
const WORDS = [
  'acorn', 'actor', 'album', 'alert', 'amber', 'anchor', 'angle', 'apple',
  'apron', 'arrow', 'atlas', 'badge', 'bagel', 'baker', 'bamboo', 'banana',
  'basket', 'bean', 'bench', 'birch', 'bird', 'blank', 'block', 'bloom',
  'bobcat', 'bonus', 'bottle', 'branch', 'bread', 'brick', 'bridge', 'brush',
  'bubble', 'bucket', 'button', 'cabin', 'cable', 'cactus', 'camel', 'candle',
  'candy', 'canoe', 'carpet', 'cart', 'castle', 'cave', 'cedar', 'chain',
  'chair', 'chalk', 'charm', 'chess', 'circle', 'clay', 'clock', 'cloud',
  'clover', 'cobra', 'comet', 'cookie', 'coral', 'cotton', 'crab', 'crane',
  'crate', 'crisp', 'crown', 'cube', 'dance', 'daisy', 'delta', 'denim',
  'desk', 'dill', 'dinner', 'doll', 'doodle', 'drum', 'duck', 'dust',
  'eagle', 'earth', 'echo', 'elbow', 'ember', 'engine', 'fable', 'falcon',
  'fan', 'fern', 'fiber', 'finch', 'flag', 'flame', 'flash', 'flint',
  'flock', 'flute', 'foam', 'forest', 'fork', 'frame', 'frog', 'frost',
  'fruit', 'garden', 'garlic', 'gem', 'ginger', 'glass', 'globe', 'goat',
  'gold', 'gong', 'goose', 'grain', 'grape', 'grass', 'green', 'guitar',
  'hammer', 'harbor', 'hawk', 'hazel', 'helmet', 'heron', 'hedge', 'hill',
  'honey', 'hush', 'igloo', 'ink', 'inlet', 'iris', 'island', 'ivory',
  'jade', 'jar', 'jelly', 'jungle', 'kelp', 'kettle', 'kite', 'label',
  'ladder', 'lake', 'lamp', 'lark', 'lemon', 'lentil', 'lilac', 'lime',
  'linen', 'lion', 'lizard', 'log', 'lotus', 'lunch', 'magnet', 'mango',
  'maple', 'marble', 'mask', 'meadow', 'melon', 'mint', 'mirror', 'mitten',
  'moss', 'mouse', 'mug', 'music', 'napkin', 'nectar', 'nest', 'net',
  'noodle', 'novel', 'oak', 'oats', 'olive', 'onion', 'orbit', 'orchid',
  'otter', 'oven', 'paddle', 'palm', 'panda', 'paper', 'parrot', 'peach',
  'pebble', 'pencil', 'pepper', 'petal', 'piano', 'planet', 'plaid', 'pocket',
  'pond', 'poppy', 'print', 'puffin', 'puzzle', 'rabbit', 'radish', 'raven',
  'ribbon', 'river', 'robin', 'rocket', 'rubber', 'salad', 'salsa', 'sand',
  'scarf', 'shell', 'shelf', 'shield', 'shovel', 'silk', 'silver', 'snail',
  'snow', 'soda', 'spoon', 'stamp', 'star', 'stone', 'storm', 'sugar',
  'swan', 'table', 'thatch', 'tiger', 'timber', 'toast', 'torch', 'towel',
  'track', 'trail', 'trout', 'trunk', 'tulip', 'turtle', 'twig', 'velvet',
  'violet', 'walnut', 'wasp', 'water', 'whisk', 'willow', 'winter', 'zebra'
]

export function threeWords(material: string): [string, string, string] {
  const digest = createHash('sha256').update(material, 'utf8').digest()
  return [WORDS[digest[0]], WORDS[digest[1]], WORDS[digest[2]]]
}
