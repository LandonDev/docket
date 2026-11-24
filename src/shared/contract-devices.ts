import { z } from 'zod'
import type { MethodCapability } from './capabilities'

// Computers set up from the giver (docs/agents/pc-setup.md): the giver's
// claim on the box, and later the mailbox of letters to given computers.

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

/** A computer's device identity: Ed25519 to sign, X25519 to be sealed to (src/shared/devices/keys.ts), base64url raw keys. */
export const DeviceIdentitySchema = z.object({ signPublic: z.string().min(1).max(64), sealPublic: z.string().min(1).max(64) })
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>

/** What a setup link gives (the setup dialog's rows; the link to the box is always given). */
export const SetupItemsSchema = z.object({ accounts: z.boolean(), lifeos: z.boolean(), reader: z.boolean(), folders: z.boolean() })
export type SetupItems = z.infer<typeof SetupItemsSchema>

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

/** The computer's steps, in order (devices/setup/useLink.ts). */
export const SETUP_STEPS = ['link', 'allow', 'accounts', 'lifeos', 'work', 'folders'] as const
export type SetupStepName = SetupStep
export type SetupStepState = SetupStepRow['state']

/** Written once into the window's storage on the computer (lib/appearance.ts, lib/models.ts). */
export interface SetupSeeds {
  appearance?: { code?: 'dark' | 'light' | 'system'; work?: 'dark' | 'light' | 'system' }
  defaultModels?: Record<string, string>
  work?: boolean
}

export const DevicesRequestSchemas = [
  /** → { giver }: the Mac's first link after the upgrade (remote; admin, a key made before the upgrade). */
  request('devices.claimGiver', z.object({ identity: DeviceIdentitySchema, name: z.string().min(1).max(120), proof: z.string().max(200).optional() })),
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
  /**
   * → { ticket, expiresIn }: a ticket minted on a given computer's proved socket (its main process's
   * link), so the socket its window opens with it starts proved; a bearer alone never mints one.
   */
  z.object({ id: z.string(), method: z.literal('devices.ticket'), params: z.object({}).optional() }),
  /** → { ok }: the calling computer's signed ack of a letter it applied. */
  request('devices.ack', z.object({ ack: DeviceAckSchema })),
  /** → { bindings }: every computer the box binds, for the giver's Computers list (give; admin reads too). */
  z.object({ id: z.string(), method: z.literal('devices.list'), params: z.object({}).optional() }),
  /**
   * → { removalId }: Remove (give): the box persists the removal, puts the key in farewell (its sockets,
   * lanes and tickets closed with FAREWELL_CLOSE, queued calls cancelled), and retires the binding
   * everywhere; the key is revoked on the computer's receipt at /api/farewell, or after 30 days.
   */
  request('devices.remove', z.object({ envId: z.string().min(1).max(64) })),
  /** → { claim: SetupClaimRecord | null }: what the computer that used a setup link signed (give), for the giver to check against its own verifier. */
  request('devices.setupProof', z.object({ pairingId: z.string().min(1).max(64) })),
  // The giver's own window (local): its Computers group in Settings → Hosts.
  /** → { computers: ComputerRow[], giver: GiverRecord | null }: what each computer holds and when it last synced. */
  z.object({ id: z.string(), method: z.literal('devices.computers'), params: z.object({}).optional() }),
  /** → { ok }: Stop, Start again, Remove, Retry on one computer's row. */
  request('devices.computer', z.object({ envId: z.string().min(1).max(64), action: z.enum(['stop', 'start', 'remove', 'retry']) })),
  // The setup link (docs/agents/pc-setup.md "The setup link"), the giver's window (local).
  /** → { link, expiresAt, pairingId }: a link for one computer; the link is answered once and kept nowhere but the vault's secret. */
  request(
    'devices.setup.make',
    z.object({
      name: z.string().trim().min(1).max(80),
      items: SetupItemsSchema,
      workspaces: z.array(z.string().min(1).max(120)).max(200),
      /** The window's appearance and default models, written once into the new computer's window. */
      seeds: z.object({ appearance: z.unknown().optional(), defaultModels: z.unknown().optional() }).optional()
    })
  ),
  /** → { ok }: Cancel: the pairing, its pending key and any claim end on the box; the secret goes. */
  request('devices.setup.cancel', z.object({ pairingId: z.string().min(1).max(64) })),
  /** → { ok, envId }: Allow on the notice: activate, the first letters, the workspaces. */
  request('devices.setup.allow', z.object({ pairingId: z.string().min(1).max(64) })),
  /** → { ok }: Remove on the notice before Allow: the same as Cancel. */
  request('devices.setup.deny', z.object({ pairingId: z.string().min(1).max(64) })),
  /** → { links: SetupLinkRow[] }: this Mac's open links, so a reloaded window shows the notice again. */
  z.object({ id: z.string(), method: z.literal('devices.setup.links'), params: z.object({}).optional() }),
  // The computer being set up (local).
  /** → SetupPeek: what a pasted link gives and from whom; nothing moves. */
  request('devices.setup.peek', z.object({ link: z.string().min(1).max(600) })),
  /** → { ok }: Set up this PC; the steps report as `device-setup` pushes. */
  request('devices.setup.start', z.object({ link: z.string().min(1).max(600) })),
  /** → SetupState | null: the steps, the words, the seeds. */
  z.object({ id: z.string(), method: z.literal('devices.setup.state'), params: z.object({}).optional() }),
  /** → { ok }: run a failed step again. */
  request('devices.setup.retry', z.object({ step: z.enum(['link', 'allow', 'accounts', 'lifeos', 'work', 'folders']) })),
  /** → { added }: the folders his pick named, into Files. */
  request('devices.setup.folders', z.object({ paths: z.array(z.string().min(1).max(1000)).min(1).max(50) })),
  /**
   * A proof's seam (isolated instances with TEMP_CODE_E2E_DEVICES=1 only; scripts/e2e-given-computer.ts),
   * until the setup link (M4) does the same: `identity` this host's env id and public identity; on the giver
   * `give` (bind and activate a computer, then its first manifest) and `post` (a letter again); on a given
   * computer `pin` (pinGiver and the sealed box environment), `apply` (a letter fed in) and `state`.
   */
  request('devices.proof', z.object({ op: z.enum(['identity', 'give', 'post', 'pin', 'apply', 'state']), args: z.record(z.string(), z.unknown()).optional() }))
] as const

/** What the computer that used a setup link signed, as the box stored it (devices/setupPairings.ts). */
export interface SetupClaimRecord {
  pairingId: string
  name: string
  envId: string
  keyId: string
  identity: DeviceIdentity
  origin: string
  bundleDigest: string
  challenge: string
  proof: { verifierSig: string; deviceSig: string }
  generation: number
  at: number
}

/** One of the giver's links: open, its claim waiting for Allow, refused, allowed or ended. */
export interface SetupLinkRow {
  pairingId: string
  name: string
  expiresAt: number
  state: 'open' | 'asking' | 'refused' | 'allowed' | 'ended'
  words?: string[]
  reason?: string
}

/** What a pasted link gives, from whom, through which box. */
export interface SetupPeek {
  origin: string
  giver: string
  items: SetupItems
  expiresAt: number
}

export type SetupStep = 'link' | 'allow' | 'accounts' | 'lifeos' | 'work' | 'folders'
export interface SetupStepRow {
  step: SetupStep
  state: 'waiting' | 'working' | 'done' | 'failed'
  reason?: string
}
/** The computer's setup as its window draws it: only the steps the link gives (LifeOS's install on Windows alone). */
export interface SetupState {
  origin: string
  giver: string
  /** The three words, once the claim is made; the giver's notice shows the same. */
  words: string[] | null
  steps: SetupStepRow[]
  /** Written once into this window's storage. */
  seeds: { appearance?: unknown; defaultModels?: unknown } | null
  done: boolean
}

/** One row of the giver's Computers group: its own record merged with the box's binding and the newest ack. */
export interface ComputerRow {
  envId: string
  name: string
  state: 'active' | 'stopped' | 'removing' | 'retired'
  /** The given accounts it said it holds in its newest ack, by service and account id. */
  holds: { service: string; account: string }[]
  /** When its newest ack was made, or null before the first. */
  syncedAt: number | null
  /** Its lease ran out and its given accounts are paused there. */
  paused: boolean
  /** A removal waits for the computer to be in touch. */
  waitingForContact: boolean
  lastError: string | null
}

/** The box's row in the Computers group: what it holds and when this Mac last synced with it; no Stop or Remove. */
export interface BoxComputerRow {
  envId: string
  name: string
  holds: { service: string; account: string }[]
  syncedAt: number | null
}

/** `devices.computers`' answer. */
export interface ComputersAnswer {
  computers: ComputerRow[]
  giver: GiverRecord | null
  box?: BoxComputerRow | null
}

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
  'devices.ticket': 'admin',
  'devices.list': 'admin',
  'devices.remove': 'give',
  'devices.setupProof': 'give',
  'devices.computers': 'local',
  'devices.computer': 'local',
  'devices.setup.make': 'local',
  'devices.setup.cancel': 'local',
  'devices.setup.allow': 'local',
  'devices.setup.deny': 'local',
  'devices.setup.links': 'local',
  'devices.setup.peek': 'local',
  'devices.setup.start': 'local',
  'devices.setup.state': 'local',
  'devices.setup.retry': 'local',
  'devices.setup.folders': 'local',
  'devices.proof': 'local'
} as const satisfies Record<string, MethodCapability>

/** Pushes: a letter waiting (to the addressee's socket) and a computer's news (to the giver's). */
export type DevicesPush =
  | { push: 'device-mail'; seq: number }
  | { push: 'device-acked' | 'device-gone'; envId: string }
  /** A computer bound, or (with `pairingId`) a setup link's claim made: the giver fetches devices.setupProof. */
  | { push: 'device-joined'; envId: string; pairingId?: string }
  /** The giver's window (local): a checked claim waits for Allow. */
  | { push: 'device-allow'; pairingId: string; name: string; words: string[] }
  /** The giver's window (local): a link's state changed (refused, allowed, ended). */
  | { push: 'device-link'; link: SetupLinkRow }
  /** The window of the computer being set up (local): one step's state. */
  | { push: 'device-setup'; step: SetupStep; state: SetupStepRow['state']; reason?: string; words?: string[] }

/**
 * A device key's proof in peer.register (`proof`, contract-macbridge.ts; devices/given.ts makes it,
 * the box checks it): Ed25519 by the computer's device key over canonicalJson(peerProofPayload) of the
 * nonce its socket got from devices.challenge, its own env id (`from`) and its box key's id.
 */
export const peerProofPayload = (p: { nonce: string; from: string; keyId: string }): { nonce: string; from: string; keyId: string } => ({ nonce: p.nonce, from: p.from, keyId: p.keyId })

/** The signed receipt a removed computer posts to /api/farewell: Ed25519 by its device key over canonicalJson(farewellPayload). */
export const farewellPayload = (p: { removalId: string; envId: string }): { removalId: string; envId: string } => ({ removalId: p.removalId, envId: p.envId })
export type FarewellRequest = { op: 'mail' } | { op: 'receipt'; removalId: string; signature: string }
