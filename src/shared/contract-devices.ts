import { z } from 'zod'
import type { MethodCapability } from './capabilities'

// Computers set up from the giver (docs/agents/pc-setup.md): the giver's
// claim on the box, and later the mailbox of letters to given computers.

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

/** A computer's device identity: Ed25519 to sign, X25519 to be sealed to (src/shared/devices/keys.ts), base64url raw keys. */
export const DeviceIdentitySchema = z.object({ signPublic: z.string().min(1).max(64), sealPublic: z.string().min(1).max(64) })
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>

export interface GiverRecord {
  keyId: string
  identity: DeviceIdentity
  /** The giver's name as it said it ("Landon's MacBook"). */
  name: string
  at: number
}

/** A letter as it crosses the wire (shared/devices/envelope.ts `Letter`); openLetter validates it whole, so this only bounds it. */
export const LetterWireSchema = z.object({
  header: z.record(z.string(), z.unknown()),
  ephemeral: z.string().max(200),
  sealed: z.string().max(400_000),
  signature: z.string().max(200)
})

/** A given computer's signed word that it applied a letter (devices/given.ts): what it holds now, by service and account id only. */
export const DeviceAckSchema = z.object({
  envId: z.string().min(1).max(64),
  letterId: z.string().min(1).max(64),
  seq: z.number().int().nonnegative(),
  /** sha256 hex of canonicalJson(header) of the letter applied. */
  digest: z.string().min(1).max(128),
  /** The given accounts it holds after the apply. */
  holds: z.array(z.object({ service: z.string().max(32), account: z.string().max(200) })).max(500),
  /** Its own sign-ins, made there before setup: listed, never touched. */
  own: z.array(z.object({ service: z.string().max(32), account: z.string().max(200) })).max(500),
  /** Set while its lease has run out and its given accounts are paused. */
  paused: z.boolean().optional(),
  at: z.number().int(),
  /** Ed25519 by the computer's device key over canonicalJson of every field above. */
  signature: z.string().min(1).max(200)
})
export type DeviceAck = z.infer<typeof DeviceAckSchema>

/** One given computer as the box keeps it (devices/mailbox.ts). */
export type BindingState = 'pending' | 'active' | 'stopped' | 'removing' | 'retired'
export interface DeviceBinding {
  envId: string
  keyId: string
  identity: DeviceIdentity
  generation: number
  name: string
  state: BindingState
  createdAt: number
  /** The newest verified letter's header seq and kind. */
  seq: number | null
  kind: string | null
  /** The newest ack, verified against the binding's key. */
  ack: DeviceAck | null
  lastSeenAt: number | null
  removalId: string | null
  retiredAt: number | null
}

export const DevicesRequestSchemas = [
  /** → { giver }: the Mac's first link after the upgrade (remote; admin, a key made before the upgrade). */
  request('devices.claimGiver', z.object({ identity: DeviceIdentitySchema, name: z.string().min(1).max(120) })),
  /** → { giver | null, upgradeAt | null }: who the giver is, for /ui and the Computers list. */
  z.object({ id: z.string(), method: z.literal('devices.giver'), params: z.object({}).optional() }),
  /** → { giver | null }: the box's own say, tc-local only (keyId null clears it). */
  request('devices.setGiver', z.object({ keyId: z.string().nullable(), name: z.string().min(1).max(120).optional() })),
  /** → { nonce }: a device key's socket asks once, then proves it in peer.register's `proof` (devices/binding.ts). */
  z.object({ id: z.string(), method: z.literal('devices.challenge'), params: z.object({}).optional() }),
  /**
   * → { binding }: the giver binds a computer (give): the pending key becomes its device key, at this
   * generation; a retired env id, or one bound under another identity, is refused.
   */
  request(
    'devices.activate',
    z.object({ envId: z.string().min(1).max(64), keyId: z.string().min(1).max(64), identity: DeviceIdentitySchema, generation: z.number().int().positive(), name: z.string().min(1).max(120) })
  ),
  /** → { ok, superseded }: a letter for one computer (give); the box checks the giver's signature before it reads the header. */
  request('devices.post', z.object({ letter: LetterWireSchema })),
  /** → { letter | null, removal | null }: the newest letter for the calling computer (its proved socket only). */
  z.object({ id: z.string(), method: z.literal('devices.mail'), params: z.object({}).optional() }),
  /** → { ok }: the calling computer's signed ack of a letter it applied. */
  request('devices.ack', z.object({ ack: DeviceAckSchema })),
  /** → { bindings }: every computer the box binds, for the giver's Computers list (give; admin reads too). */
  z.object({ id: z.string(), method: z.literal('devices.list'), params: z.object({}).optional() }),
  /**
   * → { removalId }: Remove (give): the box persists the removal, puts the key in farewell (its sockets,
   * lanes and tickets closed with FAREWELL_CLOSE, queued calls cancelled), and retires the binding
   * everywhere; the key is revoked on the computer's receipt at /api/farewell, or after 30 days.
   */
  request('devices.remove', z.object({ envId: z.string().min(1).max(64) }))
] as const

/** The close code a key in farewell gets: not 4001, so the computer retries, and from then reaches only /api/farewell. */
export const FAREWELL_CLOSE = 4010
/** A key in farewell with no receipt is revoked after this long. */
export const FAREWELL_TTL_MS = 30 * 86_400_000
/** A manifest's lease; the giver re-signs one a day while online. */
export const LEASE_MS = 30 * 86_400_000

export const DEVICES_CAPS = {
  'devices.claimGiver': 'admin',
  'devices.giver': 'admin',
  'devices.setGiver': 'local',
  'devices.challenge': 'admin',
  'devices.activate': 'give',
  'devices.post': 'give',
  'devices.mail': 'admin',
  'devices.ack': 'admin',
  'devices.list': 'admin',
  'devices.remove': 'give'
} as const satisfies Record<string, MethodCapability>

/** Pushes: a letter waiting (to the addressee's socket) and a computer's news (to the giver's). */
export type DevicesPush = { push: 'device-mail'; seq: number } | { push: 'device-joined' | 'device-acked' | 'device-gone'; envId: string }
