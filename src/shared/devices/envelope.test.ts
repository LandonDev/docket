import { describe, expect, it } from 'vitest'
import { canonicalJson, generateDeviceKeys, sealTo, signBytes } from './keys'
import {
  LETTER_CAP,
  letterSignedBy,
  letterSize,
  openLetter,
  sealLetter,
  type Letter,
  type LetterBody,
  type LetterHeader,
  type OpenRefusal
} from './envelope'

const giver = generateDeviceKeys()
const recipient = generateDeviceKeys()
const other = generateDeviceKeys()
const me = {
  envId: 'test-device',
  sealPublic: recipient.sealPublic,
  sealPrivate: recipient.sealPrivate,
  generation: 1,
  giver: giver.signPublic,
  lastSeq: 8
}
const header: LetterHeader = {
  v: 1,
  id: 'test-letter',
  kind: 'manifest',
  to: me.envId,
  toKey: me.sealPublic,
  generation: me.generation,
  from: me.giver,
  seq: 9,
  issuedAt: 1000,
  leaseUntil: 2000,
  grants: [
    { service: 'test-static', account: 'test-account', kind: 'static' },
    { service: 'test-access', account: 'test-account', kind: 'access', owner: 'test-owner' }
  ]
}
const secret = 'fake secret'
const staticAccount = { ...header.grants[0], secret }
const accessAccount = { ...header.grants[1] }
const body: LetterBody = {
  kind: header.kind,
  seq: header.seq,
  accounts: [accessAccount, staticAccount],
  extra: { nested: { z: '雪', a: [true, null] } }
}

function signLetter(unsigned: Omit<Letter, 'signature'>, signPrivate = giver.signPrivate): Letter {
  return {
    ...unsigned,
    signature: signBytes(signPrivate, Buffer.from(canonicalJson(unsigned)))
  }
}

function expectRefusal(letter: Letter, reason: OpenRefusal, identity = me): void {
  expect(openLetter(letter, identity)).toEqual({ ok: false, reason })
}

describe('device letters', () => {
  const letter = sealLetter(header, body, giver.signPrivate)

  it('opens a matching letter even when accounts and grants use different orders', () => {
    const wire = JSON.stringify(letter)
    expect(wire).not.toContain(secret)
    expect(openLetter(JSON.parse(wire), me)).toEqual({ ok: true, header, body })
  })

  it('checks both the claimed giver and their signature before the box uses a header', () => {
    expect(letterSignedBy(letter, giver.signPublic)).toBe(true)
    expect(letterSignedBy(letter, other.signPublic)).toBe(false)
    expect(letterSignedBy(sealLetter(header, body, other.signPrivate), giver.signPublic)).toBe(
      false
    )
    const wrongFrom = sealLetter({ ...header, from: other.signPublic }, body, giver.signPrivate)
    expect(letterSignedBy(wrongFrom, giver.signPublic)).toBe(false)
  })

  it('checks address, generation and pinned giver in that order before the signature', () => {
    const badSignature = { ...letter, signature: 'invalid' }
    expectRefusal(badSignature, 'wrong-addressee', {
      ...me,
      envId: 'other-device',
      generation: 2,
      giver: other.signPublic
    })
    expectRefusal(badSignature, 'wrong-addressee', { ...me, sealPublic: other.sealPublic })
    expectRefusal(badSignature, 'wrong-generation', {
      ...me,
      generation: 2,
      giver: other.signPublic
    })
    expectRefusal(badSignature, 'wrong-giver', { ...me, giver: other.signPublic })
    expectRefusal(badSignature, 'bad-signature', { ...me, lastSeq: header.seq })
  })

  it('rejects a sequence lower than or equal to the last one', () => {
    expectRefusal(letter, 'stale-seq', { ...me, lastSeq: header.seq + 1 })
    expectRefusal(letter, 'stale-seq', { ...me, lastSeq: header.seq })
  })

  it('rejects changes to the header or ciphertext before trying to open the box', () => {
    const changedLease = { ...letter, header: { ...header, leaseUntil: null } }
    const changedGrants = { ...letter, header: { ...header, grants: [] } }
    const changed = Buffer.from(letter.sealed, 'base64url')
    changed[changed.length - 1] ^= 1
    const sealed = changed.toString('base64url')
    for (const tampered of [changedLease, changedGrants, { ...letter, sealed }]) {
      expectRefusal(tampered, 'bad-signature')
      expect(letterSignedBy(tampered, giver.signPublic)).toBe(false)
    }
    const resigned = signLetter({ header, ephemeral: letter.ephemeral, sealed })
    expectRefusal(resigned, 'unreadable')
  })

  it('binds the encrypted body to the header even if the giver signs it again', () => {
    const changedHeader = { ...header, leaseUntil: null }
    const { ephemeral, sealed } = letter
    expectRefusal(signLetter({ header: changedHeader, ephemeral, sealed }), 'unreadable')
    expectRefusal(letter, 'unreadable', { ...me, sealPrivate: other.sealPrivate })
  })

  it.each<[string, Partial<LetterBody>]>([
    ['extra account', { accounts: [...body.accounts, { ...staticAccount, account: 'extra' }] }],
    ['missing account', { accounts: [staticAccount] }],
    ['duplicate account', { accounts: [staticAccount, staticAccount] }],
    ['wrong owner', { accounts: [{ ...accessAccount, owner: 'other-owner' }, staticAccount] }],
    ['static account with no secret', { accounts: [accessAccount, header.grants[0]] }],
    [
      'static account with an empty secret',
      { accounts: [accessAccount, { ...staticAccount, secret: '' }] }
    ],
    ['access account with a secret', { accounts: [{ ...accessAccount, secret }, staticAccount] }],
    [
      'access account with an empty secret',
      { accounts: [{ ...accessAccount, secret: '' }, staticAccount] }
    ],
    ['wrong kind', { kind: 'activate' }],
    ['wrong sequence', { seq: header.seq + 1 }]
  ])('refuses a validly signed body with %s', (_label, change) => {
    const signed = sealLetter(header, { ...body, ...change }, giver.signPrivate)
    expect(letterSignedBy(signed, giver.signPublic)).toBe(true)
    expectRefusal(signed, 'disagrees')
  })

  it('rejects duplicate grants even when the body lists exactly those grants', () => {
    const repeatedHeader = { ...header, grants: [header.grants[0], header.grants[0]] }
    const repeatedBody = { ...body, accounts: [staticAccount, staticAccount] }
    expectRefusal(sealLetter(repeatedHeader, repeatedBody, giver.signPrivate), 'disagrees')
  })

  it('measures UTF-8 bytes of the JSON and defines the 256 KiB limit', () => {
    const signed = sealLetter({ ...header, id: '雪' }, body, giver.signPrivate)
    const json = JSON.stringify(signed)
    expect(LETTER_CAP).toBe(262144)
    expect(letterSize(signed)).toBe(Buffer.from(json).length)
    expect(letterSize(signed)).toBeGreaterThan(json.length)
  })
})

describe('malformed device letters', () => {
  const letter = sealLetter(header, body, giver.signPrivate)

  it('refuses malformed outer values and fields without throwing', () => {
    const invalid = [
      null,
      undefined,
      [],
      { ...letter, header: null },
      { ...letter, ephemeral: [] },
      { ...letter, sealed: 1 },
      { ...letter, signature: undefined },
      { ...letter, extra: true },
      {
        ...letter,
        get header() {
          throw new Error(secret)
        }
      }
    ]
    for (const bad of invalid) {
      expectRefusal(bad as Letter, 'malformed')
      expect(letterSignedBy(bad as Letter, giver.signPublic)).toBe(false)
    }
  })

  it.each([
    ['v', 2],
    ['id', null],
    ['kind', 'other'],
    ['to', 0],
    ['toKey', {}],
    ['generation', 1.5],
    ['from', false],
    ['seq', Number.MAX_SAFE_INTEGER + 1],
    ['issuedAt', Infinity],
    ['leaseUntil', 'soon'],
    ['grants', {}],
    ['grants', new Array(1)],
    ['grants', [{ ...header.grants[0], owner: null }]],
    ['grants', [{ ...header.grants[0], account: 1 }]],
    ['grants', [{ ...header.grants[0], service: {} }]],
    ['grants', [{ ...header.grants[0], kind: 'other' }]],
    ['grants', [{ ...header.grants[0], secret }]]
  ])('refuses malformed header field %s ahead of address and signature checks', (key, value) => {
    const bad = { ...letter, header: { ...header, to: 'other-device', [key]: value } }
    expectRefusal(bad, 'malformed')
    expect(letterSignedBy(bad, giver.signPublic)).toBe(false)
  })

  it.each([
    ['kind', 'other'],
    ['seq', 'nine'],
    ['accounts', null],
    ['accounts', [{ ...staticAccount, secret: 1 }]],
    ['extra', []],
    ['other', true]
  ])('refuses a malformed decrypted body field %s', (key, value) => {
    const signed = sealLetter(header, { ...body, [key]: value }, giver.signPrivate)
    expectRefusal(signed, 'malformed')
  })

  it('refuses a correctly signed box whose plaintext is invalid JSON', () => {
    const box = sealTo(header.toKey, Buffer.from('{'), Buffer.from(canonicalJson(header)))
    expectRefusal(signLetter({ header, ...box }), 'malformed')
  })

  it('does not echo a secret when a caller tries to put it in a grant', () => {
    const bad = { ...header, grants: [staticAccount] }
    expect(() => sealLetter(bad, body, giver.signPrivate)).toThrow(/^Could not seal letter$/)
  })
})
