import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, threeWords } from './keys'
import { DeviceIdentitySchema, SetupItemsSchema, type DeviceIdentity } from '../contract-devices'

/**
 * The setup link (docs/agents/pc-setup.md "The setup link"):
 * `<box origin>/setup#v1.<code>.<secret>`. The code is a box pairing code;
 * the secret (32 random bytes, base64url) never leaves the giver and the
 * computer being set up: the box sees the code, the link verifier's public
 * key and the sealed bundle only.
 *
 * Nothing here echoes its input: a refusal's words never hold the link, the
 * code or the secret, so they may reach a log or a screen.
 */

export const SETUP_PROTOCOL = 'tempcode-setup-v1'
/** How long a link lasts, and with it the pending key a claim mints. */
export const SETUP_TTL_MS = 15 * 60_000

export class SetupLinkError extends Error {
  constructor(
    readonly reason: 'bad-link' | 'not-https',
    message: string
  ) {
    super(message)
    this.name = 'SetupLinkError'
  }
}

const SECRET = /^[A-Za-z0-9_-]{43}$/
const CODE = /^[0-9A-Za-z]{5}-?[0-9A-Za-z]{5}$/

export function formatSetupLink(origin: string, code: string, secret: Buffer): string {
  return `${origin}/setup#v1.${code}.${secret.toString('base64url')}`
}

/**
 * The parts of a pasted link. `https://` only; `http://` only when
 * `allowHttp` (the harness marker on the computer being set up).
 */
export function parseSetupLink(text: string, opts: { allowHttp?: boolean } = {}): { origin: string; code: string; secret: Buffer } {
  let url: URL
  try {
    url = new URL(String(text).trim())
  } catch {
    throw new SetupLinkError('bad-link', 'This is not a setup link. Copy the whole link from your Mac.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && opts.allowHttp)) throw new SetupLinkError('not-https', 'A setup link must start with https://')
  const parts = url.hash.replace(/^#/, '').split('.')
  if (url.pathname.replace(/\/+$/, '') !== '/setup' || parts.length !== 3 || parts[0] !== 'v1' || !CODE.test(parts[1]) || !SECRET.test(parts[2])) {
    throw new SetupLinkError('bad-link', 'This is not a setup link. Copy the whole link from your Mac.')
  }
  const secret = Buffer.from(parts[2], 'base64url')
  if (secret.length !== 32) throw new SetupLinkError('bad-link', 'This is not a setup link. Copy the whole link from your Mac.')
  return { origin: url.origin, code: parts[1].toUpperCase(), secret }
}

/** What the link's bundle holds, sealed with the bundle key. No account and no LifeOS code. */
export const SetupBundleSchema = z.object({
  v: z.literal(1),
  giver: z.object({ identity: DeviceIdentitySchema, name: z.string().min(1).max(120), envId: z.string().min(1).max(64) }),
  box: z.object({ envId: z.string().min(1).max(64), origin: z.string().min(1).max(300) }),
  items: SetupItemsSchema,
  workspaces: z.array(z.string().max(120)).max(200),
  seeds: z.object({ appearance: z.unknown().optional(), defaultModels: z.unknown().optional(), work: z.boolean().optional() })
})
export type SetupBundle = z.infer<typeof SetupBundleSchema>

/** sha256 hex of the sealed bundle as the box holds it. */
export const bundleDigest = (sealed: string): string => createHash('sha256').update(sealed, 'utf8').digest('hex')

export interface ClaimFields {
  origin: string
  pairingId: string
  bundleDigest: string
  identity: DeviceIdentity
  envId: string
  challenge: string
}

/** What both proofs sign: the link verifier and the computer's device key. */
export const claimBytes = (c: ClaimFields): Buffer =>
  Buffer.from(
    canonicalJson({
      protocol: SETUP_PROTOCOL,
      origin: c.origin,
      pairingId: c.pairingId,
      bundleDigest: c.bundleDigest,
      identity: { signPublic: c.identity.signPublic, sealPublic: c.identity.sealPublic },
      envId: c.envId,
      challenge: c.challenge
    })
  )

/** The three words both screens show: from the computer's identity and the claim it signed. */
export function setupWords(c: ClaimFields): [string, string, string] {
  const digest = createHash('sha256').update(claimBytes(c)).digest('hex')
  return threeWords(canonicalJson({ identity: { signPublic: c.identity.signPublic, sealPublic: c.identity.sealPublic }, claim: digest }))
}

/** The HTTP bodies of /api/setup/* (remote/listener.ts). */
export const SetupCodeBodySchema = z.object({ code: z.string().min(1).max(40) })
export const SetupClaimBodySchema = z.object({
  code: z.string().min(1).max(40),
  origin: z.string().min(1).max(300),
  envId: z.string().min(1).max(64),
  identity: DeviceIdentitySchema,
  challenge: z.string().min(1).max(100),
  proof: z.object({ verifierSig: z.string().min(1).max(200), deviceSig: z.string().min(1).max(200) })
})
export type SetupClaimBody = z.infer<typeof SetupClaimBodySchema>

/** The claim's answer: the pending key (its only appearance), its id, the generation the box gives the computer. */
export interface SetupClaimAnswer {
  keyId: string
  key: string
  generation: number
  expiresAt: number
  /** The challenge of the claim on file: a recovery signs a fresh one, but the words come from this. */
  challenge?: string
}
