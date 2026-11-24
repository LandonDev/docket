import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Principal } from '@shared/capabilities'
import type { DevicesPush, SetupClaimRecord } from '@shared/contract-devices'
import { bundleDigest, claimBytes, SETUP_TTL_MS, type SetupClaimAnswer, type SetupClaimBody } from '@shared/devices/setupLink'
import { verifyBytes } from '@shared/devices/keys'
import { crockfordId, formatPairingCode, normalizePairingCode, type RemoteAuth } from '../remote/auth'
import type { DeviceBindings } from './binding'

/**
 * The box's half of the setup link (docs/agents/pc-setup.md "The setup link").
 *
 * - The giver mints a pairing with `setup` (remote.pairings.create, give):
 *   the link verifier's public key and the bundle sealed with the bundle key.
 *   Its caps are the pending set and it lasts 15 minutes. The legacy
 *   `/api/pair` exchanges refuse it (auth.ts `exchange`).
 * - `/api/setup/peek` answers the sealed bundle, `/api/setup/challenge` one
 *   challenge per code. Every setup request is limited by address (a code it
 *   does not know, a proof that fails) and by code (every ask counts), with
 *   auth.ts's failure limiter.
 * - `/api/setup/claim` checks the verifier's signature BEFORE it claims: a
 *   caller with the code alone cannot make it. Then the device's own
 *   signature, then one transaction: the conditional update that claims the
 *   code, the pending key's row, the claim and a `pending` binding. The
 *   giver's sockets hear `device-joined` with the pairing id.
 * - A lost reply: the same device, same identity and challenge, claims again
 *   and gets the same key id under a new secret (the box never keeps a token
 *   it could hand out twice; the old one stops working). Only before Allow,
 *   while the link is open and within the challenge's five minutes of the
 *   claim: a replay after Allow never re-keys the computer.
 * - Cancel (remote.pairings.revoke) ends the link, and before Allow its
 *   pending key and claim; so does the link's end (the sweep, and every
 *   setup request), unless devices.activate made the key a device key.
 */

const CHALLENGE_MS = 5 * 60_000
/** Live challenges kept per code: each ask gets its own, so a caller with the code alone cannot replace the PC's (F27). */
const CHALLENGES_PER_CODE = 16
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export class SetupError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

interface SetupRow {
  id: string
  name: string
  created_at: number
  expires_at: number
  consumed_at: number | null
  consumed_by: string | null
  setup: string
  claim: string | null
}

interface SetupFields {
  verifier: string
  bundle: string
  name: string
}

type StoredClaim = SetupClaimRecord & { prior: string | null }

export interface SetupPairingsDeps {
  auth: Pick<RemoteAuth, 'prepareBearer' | 'insertPrepared' | 'rekey' | 'revokeKey' | 'getKey' | 'retryAfter' | 'recordFailure'>
  bindings: Pick<DeviceBindings, 'get' | 'byKey' | 'nextGeneration' | 'bindPending' | 'dropPending'>
  toGiver: (push: DevicesPush) => void
  /** An env id that is another host's (the box's own, one it saved, one registered under a key that is no device's): no claim binds it. */
  taken?: (envId: string) => boolean
  /** End a removal that waits on a receipt (Farewell.finish): a new identity claiming that env id means Start fresh retired the old one. */
  finishRemoval?: (envId: string) => void
  now?: () => number
  log?: (line: string) => void
}

export class SetupPairings {
  /** pairing id → challenge → its end. */
  private readonly challenges = new Map<string, Map<string, number>>()
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: SetupPairingsDeps
  ) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(`[devices] ${line}`))
  }

  /** remote.pairings.create with `setup` (give): caps forced to the pending set, 15 minutes. */
  create(input: SetupFields & { createdBy: string }): { pairing: { id: string; name: string; expiresAt: number }; code: string } {
    const code = crockfordId()
    const id = crockfordId()
    const now = this.now()
    const setup: SetupFields = { verifier: input.verifier, bundle: input.bundle, name: input.name.trim() }
    this.db
      .prepare(`INSERT INTO remote_pairings (id, code_hash, name, audience, caps, created_at, expires_at, setup) VALUES (?, ?, ?, 'client', 'pending,read', ?, ?, ?)`)
      .run(id, sha256(code), setup.name, now, now + SETUP_TTL_MS, JSON.stringify(setup))
    this.log(`setup link ${id} (${setup.name}) made by key ${input.createdBy}`)
    return { pairing: { id, name: setup.name, expiresAt: now + SETUP_TTL_MS }, code: formatPairingCode(code) }
  }

  private byId(id: string): SetupRow | null {
    return (this.db.prepare(`SELECT * FROM remote_pairings WHERE id = ? AND setup IS NOT NULL`).get(id) as SetupRow | undefined) ?? null
  }

  /**
   * The row a code names, limited by address for a code it does not know and by code for every ask.
   * Challenges count in a bucket of their own, so asking for them never spends the claim's (F27).
   */
  private lookup(code: string, ip: string, bucket = 'setup'): SetupRow {
    this.limit(ip)
    const row = this.db.prepare(`SELECT * FROM remote_pairings WHERE code_hash = ? AND setup IS NOT NULL`).get(sha256(normalizePairingCode(code))) as SetupRow | undefined
    if (!row) {
      this.deps.auth.recordFailure(ip)
      throw new SetupError(404, 'no such setup link')
    }
    this.limit(`${bucket}:${row.id}`)
    this.deps.auth.recordFailure(`${bucket}:${row.id}`)
    return row
  }

  private limit(who: string): void {
    const wait = this.deps.auth.retryAfter(who)
    if (wait > 0) throw new SetupError(429, 'too many tries; wait and try again', { retryAfter: wait })
  }

  /** A used or ended link's refusal: when it was used, or that it ended. */
  private refuseClosed(row: SetupRow): void {
    if (row.consumed_at !== null) throw new SetupError(410, 'this setup link was used', { used: row.consumed_at })
    if (row.expires_at <= this.now()) throw new SetupError(410, 'this setup link has ended', { ended: row.expires_at })
  }

  /**
   * POST /api/setup/peek: the sealed bundle, without using the link. A claim that may still be recovered
   * answers too, so the PC that made it and lost its reply resumes it from the same link (F21).
   */
  peek(body: { code: string }, ip: string): { bundle: string; expiresAt: number; pairingId: string; claimedBy?: string; used?: number } {
    this.expire()
    const row = this.lookup(body.code, ip)
    const recoverable = this.recoverable(row)
    if (!recoverable) this.refuseClosed(row)
    const bundle = { bundle: (JSON.parse(row.setup) as SetupFields).bundle, expiresAt: row.expires_at, pairingId: row.id }
    // The claimer's public key, so another computer says "used" and the claimer alone goes on.
    return recoverable ? { ...bundle, claimedBy: (JSON.parse(row.claim!) as StoredClaim).identity.signPublic, used: row.consumed_at! } : bundle
  }

  /**
   * POST /api/setup/challenge: a challenge of its own for each ask; the oldest goes past CHALLENGES_PER_CODE.
   * A claimed link still answers while its claim may be recovered, for the recovery's fresh signature (F18).
   */
  challenge(body: { code: string }, ip: string): { challenge: string } {
    this.expire()
    const row = this.lookup(body.code, ip, 'setup-challenge')
    if (!this.recoverable(row)) this.refuseClosed(row)
    const challenge = randomBytes(32).toString('base64url')
    const live = this.challenges.get(row.id) ?? new Map<string, number>()
    live.set(challenge, Math.min(this.now() + CHALLENGE_MS, row.expires_at))
    for (const old of live.keys()) if (live.size > CHALLENGES_PER_CODE) live.delete(old)
    this.challenges.set(row.id, live)
    return { challenge }
  }

  /** POST /api/setup/claim. The verifier's signature is checked before anything is claimed. */
  async claim(body: SetupClaimBody, ip: string): Promise<SetupClaimAnswer> {
    this.expire()
    const row = this.lookup(body.code, ip)
    const setup = JSON.parse(row.setup) as SetupFields
    const fields = { origin: body.origin, pairingId: row.id, bundleDigest: bundleDigest(setup.bundle), identity: body.identity, envId: body.envId, challenge: body.challenge }
    const bytes = claimBytes(fields)
    if (!verifyBytes(setup.verifier, bytes, body.proof.verifierSig)) {
      this.deps.auth.recordFailure(ip)
      throw new SetupError(403, 'the proof does not verify')
    }
    if (!verifyBytes(body.identity.signPublic, bytes, body.proof.deviceSig)) {
      this.deps.auth.recordFailure(ip)
      throw new SetupError(403, 'the device signature does not verify')
    }
    if (row.claim) return this.again(row, body)
    this.refuseClosed(row)
    if (this.deps.taken?.(body.envId)) throw new SetupError(409, "this computer's id is another host's; it cannot be set up under it")
    const issued = this.challenges.get(row.id)?.get(body.challenge)
    if (!issued || issued <= this.now()) throw new SetupError(403, 'ask for a challenge first')
    const leaving = this.deps.bindings.get(body.envId)
    if (leaving?.state === 'removing' && leaving.identity.signPublic !== body.identity.signPublic && leaving.identity.sealPublic !== body.identity.sealPublic) this.deps.finishRemoval?.(body.envId)
    const generation = this.deps.bindings.nextGeneration(body.envId)
    const prepared = await this.deps.auth.prepareBearer()
    const now = this.now()
    const record: StoredClaim = { pairingId: row.id, name: setup.name, envId: body.envId, keyId: prepared.id, identity: body.identity, origin: body.origin, bundleDigest: fields.bundleDigest, challenge: body.challenge, proof: body.proof, generation, at: now, prior: null }
    this.db.exec('BEGIN')
    try {
      const claimed = this.db
        .prepare(`UPDATE remote_pairings SET consumed_at = ?, consumed_by = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND setup IS NOT NULL`)
        .run(now, prepared.id, row.id, now).changes === 1
      if (!claimed) throw new SetupError(410, 'this setup link was used or has ended')
      this.deps.auth.insertPrepared(prepared, { name: setup.name, caps: ['pending'], createdBy: `pairing:${row.id}` })
      const bound = this.deps.bindings.bindPending({ envId: body.envId, keyId: prepared.id, identity: body.identity, generation, name: setup.name })
      if (!bound.ok) throw new SetupError(409, bound.error)
      record.prior = bound.prior
      this.db.prepare(`UPDATE remote_pairings SET claim = ? WHERE id = ?`).run(JSON.stringify(record), row.id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.challenges.delete(row.id)
    this.log(`setup link ${row.id} claimed by ${body.envId}: pending key ${prepared.id}, generation ${generation}`)
    this.deps.toGiver({ push: 'device-joined', envId: body.envId, pairingId: row.id })
    return { keyId: prepared.id, key: prepared.token, generation, expiresAt: row.expires_at, challenge: body.challenge }
  }

  /** A claim that waits for Allow, on an open link, made under five minutes ago: a lost reply may still be recovered. */
  private recoverable(row: SetupRow): boolean {
    if (!row.claim || row.expires_at <= this.now()) return false
    const claim = JSON.parse(row.claim) as StoredClaim
    const binding = this.deps.bindings.get(claim.envId)
    return binding?.state === 'pending' && binding.keyId === claim.keyId && this.now() - claim.at <= CHALLENGE_MS
  }

  /**
   * The same device after a lost reply: the same identity and env id, signing a fresh challenge asked after
   * the claim, get the same key id under a new secret. The claim's own signatures replayed get nothing (F18).
   */
  private async again(row: SetupRow, body: SetupClaimBody): Promise<SetupClaimAnswer> {
    const claim = JSON.parse(row.claim!) as StoredClaim
    const same = claim.envId === body.envId && claim.identity.signPublic === body.identity.signPublic && claim.identity.sealPublic === body.identity.sealPublic
    if (!same) throw new SetupError(410, 'this setup link was used', { used: row.consumed_at })
    const live = this.challenges.get(row.id)
    const fresh = body.challenge !== claim.challenge && (live?.get(body.challenge) ?? 0) > this.now()
    if (!fresh) throw new SetupError(410, 'this setup link was used', { used: row.consumed_at })
    live!.delete(body.challenge)
    // Only while the claim waits for Allow, its link is open and the reply could still be on its way: a body
    // copied off the wire and replayed after Allow, or later, never re-keys the computer.
    const binding = this.deps.bindings.get(claim.envId)
    if (!binding || binding.keyId !== claim.keyId || binding.state !== 'pending') throw new SetupError(410, 'this setup link was used', { used: row.consumed_at })
    if (row.expires_at <= this.now() || this.now() - claim.at > CHALLENGE_MS) throw new SetupError(410, 'this setup link was used', { used: row.consumed_at })
    const prepared = await this.deps.auth.prepareBearer()
    // Allow may have landed while the hash was made: check again at the point of the rekey (F18).
    const now = this.deps.bindings.get(claim.envId)
    if (now?.state !== 'pending' || now.keyId !== claim.keyId || row.expires_at <= this.now()) throw new SetupError(410, 'this setup link was used', { used: row.consumed_at })
    if (!this.deps.auth.rekey(claim.keyId, prepared)) throw new SetupError(410, 'this setup link has ended')
    this.log(`setup link ${row.id}: ${claim.envId} claimed again after a lost reply; key ${claim.keyId} has a new secret`)
    return { keyId: claim.keyId, key: `tc_${claim.keyId}.${prepared.token.slice(prepared.token.indexOf('.') + 1)}`, generation: claim.generation, expiresAt: row.expires_at, challenge: claim.challenge }
  }

  /** POST /api/setup/status (the pending key's bearer): whether the giver allowed it yet. */
  status(principal: Principal & { kind: 'remote' }): { state: 'pending' | 'active' } {
    this.expire()
    const binding = this.deps.bindings.byKey(principal.keyId)
    if (!binding || (binding.state !== 'pending' && binding.state !== 'active')) throw new SetupError(410, 'this setup link has ended')
    return { state: binding.state }
  }

  /** devices.setupProof (give): the claim as stored, for the giver to check against the verifier it made. */
  proof(pairingId: string): { claim: SetupClaimRecord | null } {
    const row = this.byId(pairingId)
    if (!row?.claim) return { claim: null }
    const { prior: _prior, ...claim } = JSON.parse(row.claim) as StoredClaim
    return { claim }
  }

  /**
   * Before Allow, the pending key, the binding (the retired row it replaced comes back) and, on Cancel,
   * the link's life end in one commit: a crash leaves all of them or none (F27).
   */
  private endClaim(row: SetupRow, endLink = false): void {
    const claim = row.claim ? (JSON.parse(row.claim) as StoredClaim) : null
    const binding = claim ? this.deps.bindings.get(claim.envId) : null
    const pending = claim && binding?.state === 'pending' && binding.keyId === claim.keyId ? claim : null
    if (!pending && !endLink) return
    this.db.exec('BEGIN')
    try {
      if (pending) {
        this.deps.bindings.dropPending(pending.envId, pending.keyId, pending.prior)
        this.deps.auth.revokeKey(pending.keyId)
      }
      if (endLink) this.db.prepare(`UPDATE remote_pairings SET expires_at = ? WHERE id = ? AND expires_at > ?`).run(this.now(), row.id, this.now())
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    if (pending) this.log(`setup link ${row.id}: ${pending.envId} was not allowed; its pending key ${pending.keyId} ended`)
  }

  /** remote.pairings.revoke: null for a pairing that is not a setup link's; else the link ends, with its pending key and claim. */
  revoke(id: string): boolean | null {
    const row = this.byId(id)
    if (!row) return null
    this.endClaim(row, true)
    this.challenges.delete(id)
    this.log(`setup link ${id} cancelled`)
    return true
  }

  /** Links past their end: a claim never allowed ends with its pending key. */
  expire(): void {
    const now = this.now()
    const rows = this.db.prepare(`SELECT * FROM remote_pairings WHERE setup IS NOT NULL AND claim IS NOT NULL AND expires_at <= ?`).all(now) as unknown as SetupRow[]
    for (const row of rows) this.endClaim(row)
    for (const [id, live] of this.challenges) {
      for (const [c, end] of live) if (end <= now) live.delete(c)
      if (!live.size) this.challenges.delete(id)
    }
  }
}
