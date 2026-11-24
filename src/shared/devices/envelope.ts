import { canonicalJson, openSealed, sealTo, signBytes, verifyBytes } from './keys'

export type LetterKind = 'activate' | 'manifest' | 'stop' | 'remove'

export interface Grant {
  service: string
  account: string
  kind: 'static' | 'access'
  owner?: string
}

export interface LetterHeader {
  v: 1
  id: string
  kind: LetterKind
  to: string
  toKey: string
  generation: number
  from: string
  seq: number
  issuedAt: number
  leaseUntil: number | null
  grants: Grant[]
}

export interface LetterAccount {
  service: string
  account: string
  kind: 'static' | 'access'
  owner?: string
  secret?: string
}

export interface LetterBody {
  kind: LetterKind
  seq: number
  accounts: LetterAccount[]
  extra?: Record<string, unknown>
}

export interface Letter {
  header: LetterHeader
  ephemeral: string
  sealed: string
  signature: string
}

export type OpenRefusal =
  | 'malformed'
  | 'wrong-addressee'
  | 'wrong-generation'
  | 'wrong-giver'
  | 'stale-seq'
  | 'bad-signature'
  | 'unreadable'
  | 'disagrees'

export const LETTER_CAP = 256 * 1024

const GRANT_FIELDS = ['service', 'account', 'kind', 'owner']
const ACCOUNT_FIELDS = [...GRANT_FIELDS, 'secret']
const HEADER_FIELDS = [
  'v',
  'id',
  'kind',
  'to',
  'toKey',
  'generation',
  'from',
  'seq',
  'issuedAt',
  'leaseUntil',
  'grants'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string' || !fields.includes(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && 'value' in descriptor
  })
}

function isArrayOf<T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  if (Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (!descriptor?.enumerable || !('value' in descriptor) || !isItem(descriptor.value))
      return false
  }
  return true
}

function isKind(value: unknown): value is LetterKind {
  return value === 'activate' || value === 'manifest' || value === 'stop' || value === 'remove'
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function hasGrantFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.service === 'string' &&
    typeof value.account === 'string' &&
    (value.kind === 'static' || value.kind === 'access') &&
    isOptionalString(value.owner)
  )
}

function isGrant(value: unknown): value is Grant {
  return isRecord(value) && hasOnlyFields(value, GRANT_FIELDS) && hasGrantFields(value)
}

function isAccount(value: unknown): value is LetterAccount {
  return (
    isRecord(value) &&
    hasOnlyFields(value, ACCOUNT_FIELDS) &&
    hasGrantFields(value) &&
    isOptionalString(value.secret)
  )
}

function isHeader(value: unknown): value is LetterHeader {
  return (
    isRecord(value) &&
    hasOnlyFields(value, HEADER_FIELDS) &&
    value.v === 1 &&
    typeof value.id === 'string' &&
    isKind(value.kind) &&
    typeof value.to === 'string' &&
    typeof value.toKey === 'string' &&
    isCounter(value.generation) &&
    typeof value.from === 'string' &&
    isCounter(value.seq) &&
    isTime(value.issuedAt) &&
    (value.leaseUntil === null || isTime(value.leaseUntil)) &&
    isArrayOf(value.grants, isGrant)
  )
}

function isLetter(value: unknown): value is Letter {
  return (
    isRecord(value) &&
    hasOnlyFields(value, ['header', 'ephemeral', 'sealed', 'signature']) &&
    isHeader(value.header) &&
    typeof value.ephemeral === 'string' &&
    typeof value.sealed === 'string' &&
    typeof value.signature === 'string'
  )
}

function isBody(value: unknown): value is LetterBody {
  return (
    isRecord(value) &&
    hasOnlyFields(value, ['kind', 'seq', 'accounts', 'extra']) &&
    isKind(value.kind) &&
    isCounter(value.seq) &&
    isArrayOf(value.accounts, isAccount) &&
    (value.extra === undefined || isRecord(value.extra))
  )
}

function signedBytes({ header, ephemeral, sealed }: Omit<Letter, 'signature'>): Buffer {
  return Buffer.from(canonicalJson({ header, ephemeral, sealed }))
}

export function sealLetter(
  header: LetterHeader,
  body: LetterBody,
  giverSignPrivate: string
): Letter {
  try {
    if (!isHeader(header)) throw new Error('Invalid letter header')
    const box = sealTo(
      header.toKey,
      Buffer.from(canonicalJson(body)),
      Buffer.from(canonicalJson(header))
    )
    const letter = { header, ...box }
    return { ...letter, signature: signBytes(giverSignPrivate, signedBytes(letter)) }
  } catch {
    throw new Error('Could not seal letter')
  }
}

function signatureMatches(letter: Letter, giverSignPublic: string): boolean {
  return (
    letter.header.from === giverSignPublic &&
    verifyBytes(giverSignPublic, signedBytes(letter), letter.signature)
  )
}

export function letterSignedBy(letter: Letter, giverSignPublic: string): boolean {
  try {
    return isLetter(letter) && signatureMatches(letter, giverSignPublic)
  } catch {
    return false
  }
}

function grantIdentity({ service, account, kind, owner }: Grant): string {
  return JSON.stringify([service, account, kind, owner])
}

function agreesWithHeader(header: LetterHeader, body: LetterBody): boolean {
  if (body.kind !== header.kind || body.seq !== header.seq) return false
  if (body.accounts.length !== header.grants.length) return false
  const remaining = new Set(header.grants.map(grantIdentity))
  if (remaining.size !== header.grants.length) return false
  for (const account of body.accounts) {
    if (!remaining.delete(grantIdentity(account))) return false
    if (account.kind === 'static' ? !account.secret : account.secret !== undefined) return false
  }
  return true
}

export function openLetter(
  letter: Letter,
  me: {
    envId: string
    sealPublic: string
    sealPrivate: string
    generation: number
    giver: string
    lastSeq: number
  }
): { ok: true; header: LetterHeader; body: LetterBody } | { ok: false; reason: OpenRefusal } {
  try {
    if (!isLetter(letter)) return { ok: false, reason: 'malformed' }
    const { header } = letter
    if (header.to !== me.envId || header.toKey !== me.sealPublic) {
      return { ok: false, reason: 'wrong-addressee' }
    }
    if (header.generation !== me.generation) return { ok: false, reason: 'wrong-generation' }
    if (header.from !== me.giver) return { ok: false, reason: 'wrong-giver' }
    if (!signatureMatches(letter, me.giver)) return { ok: false, reason: 'bad-signature' }
    if (header.seq <= me.lastSeq) return { ok: false, reason: 'stale-seq' }

    const plain = openSealed(
      me.sealPrivate,
      me.sealPublic,
      letter,
      Buffer.from(canonicalJson(header))
    )
    if (plain === null) return { ok: false, reason: 'unreadable' }
    const body: unknown = JSON.parse(plain.toString('utf8'))
    if (!isBody(body)) return { ok: false, reason: 'malformed' }
    if (!agreesWithHeader(header, body)) return { ok: false, reason: 'disagrees' }
    return { ok: true, header, body }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

export function letterSize(letter: Letter): number {
  try {
    return Buffer.byteLength(JSON.stringify(letter))
  } catch {
    throw new Error('Could not measure letter')
  }
}
