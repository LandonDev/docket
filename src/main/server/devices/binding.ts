import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Capability, Principal } from '@shared/capabilities'
import type { BindingState, DeviceAck, DeviceBinding, DeviceIdentity } from '@shared/contract-devices'
import { canonicalJson, verifyBytes } from '@shared/devices/keys'

/**
 * The box's durable binding of each given computer (docs/agents/pc-setup.md
 * "The box's mailbox"): `{env id, box key id, device identity, generation}`,
 * one row per env id in `device_bindings`, never deleted.
 *
 * - Every socket of a device key proves itself before it does anything:
 *   `devices.challenge` hands it a nonce bound to that connection, and its
 *   `peer.register` carries an Ed25519 signature by the binding's sign key
 *   over canonicalJson({nonce, from, keyId}). Until then the socket is
 *   refused every other method (`socketRefusal`).
 * - A registration claiming a bound env id from any other key is refused,
 *   as is a device key claiming another env id than its own.
 * - A retired env id is never admitted again. `liveBinding` is true only for
 *   an active or stopped binding; `mayRoute` (a host with no binding, or a
 *   live one) is the check every route makes: Work's `mayUseDesktop` and
 *   `ownerDesktops`, Files reach, and the bridge's calls (PeerCalls).
 */

export const DEVICE_CAPS: readonly Capability[] = ['approve', 'device', 'operate', 'read']
/** What an unproved device socket may call. */
export const BEFORE_PROOF: ReadonlySet<string> = new Set(['devices.challenge', 'peer.register'])

interface BindingRow {
  env_id: string
  key_id: string
  sign_public: string
  seal_public: string
  generation: number
  name: string
  state: BindingState
  created_at: number
  seq: number | null
  kind: string | null
  ack: string | null
  last_seen_at: number | null
  removal_id: string | null
  retired_at: number | null
}

const parseAck = (raw: string | null): DeviceAck | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as DeviceAck
  } catch {
    return null
  }
}

const bindingOf = (r: BindingRow): DeviceBinding => ({
  envId: r.env_id,
  keyId: r.key_id,
  identity: { signPublic: r.sign_public, sealPublic: r.seal_public },
  generation: r.generation,
  name: r.name,
  state: r.state,
  createdAt: r.created_at,
  seq: r.seq,
  kind: r.kind,
  ack: parseAck(r.ack),
  lastSeenAt: r.last_seen_at,
  removalId: r.removal_id,
  retiredAt: r.retired_at
})

/** The bytes a device key signs to prove a socket. */
export const proofBytes = (nonce: string, from: string, keyId: string): Buffer => Buffer.from(canonicalJson({ nonce, from, keyId }))

type RemotePrincipal = Principal & { kind: 'remote' }
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }

interface ProvedSocket {
  envId: string
  keyId: string
}

export interface BindingDeps {
  now?: () => number
  log?: (line: string) => void
  /** Whether a key is in farewell (devices/farewell.ts): its sockets are refused everything. */
  inFarewell?: (keyId: string) => boolean
}

export class DeviceBindings {
  /** connection → the nonce it was handed, until its peer.register spends it. */
  private readonly nonces = new Map<number, { nonce: string; keyId: string }>()
  private readonly proved = new Map<number, ProvedSocket>()
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: BindingDeps = {}
  ) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(`[devices] ${line}`))
  }

  private row(envId: string): BindingRow | null {
    return (this.db.prepare(`SELECT * FROM device_bindings WHERE env_id = ?`).get(envId) as BindingRow | undefined) ?? null
  }

  get(envId: string): DeviceBinding | null {
    const r = this.row(envId)
    return r ? bindingOf(r) : null
  }

  byKey(keyId: string): DeviceBinding | null {
    const r = this.db.prepare(`SELECT * FROM device_bindings WHERE key_id = ? ORDER BY created_at DESC LIMIT 1`).get(keyId) as BindingRow | undefined
    return r ? bindingOf(r) : null
  }

  list(): DeviceBinding[] {
    return (this.db.prepare(`SELECT * FROM device_bindings ORDER BY created_at`).all() as unknown as BindingRow[]).map(bindingOf)
  }

  /** True only for an active or stopped binding. */
  live(envId: string): boolean {
    const state = this.row(envId)?.state
    return state === 'active' || state === 'stopped'
  }

  /** Whether a route may reach a host: one that is no given computer, or one whose binding is live. */
  mayRoute(envId: string): boolean {
    const state = this.row(envId)?.state
    return state === undefined || state === 'pending' || this.live(envId)
  }

  /**
   * The one way a retired env id comes back (the same install set up again
   * after Remove): a new identity, sign and seal keys both, at a higher
   * generation. Nothing carries over on an env-id match alone.
   */
  private static readmits(prior: BindingRow, p: { identity: DeviceIdentity; generation: number }): boolean {
    return prior.state === 'retired' && prior.sign_public !== p.identity.signPublic && prior.seal_public !== p.identity.sealPublic && p.generation > prior.generation
  }

  /** The generation a claim for this env id gets: one past a retired binding's, else 1. */
  nextGeneration(envId: string): number {
    const prior = this.row(envId)
    return prior?.state === 'retired' ? prior.generation + 1 : 1
  }

  /**
   * Bind a computer (devices.activate's rules; mailbox.ts sets the key's caps).
   * A retired env id is re-admitted only under a new identity at a higher
   * generation; an env id already bound answers ok only to the same key,
   * identity and generation (a pending one, a setup link's claim, becomes
   * active); a key binds one computer.
   */
  bind(params: { envId: string; keyId: string; identity: DeviceIdentity; generation: number; name: string }): Result<{ binding: DeviceBinding }> {
    const prior = this.row(params.envId)
    if (prior?.state === 'retired' && !DeviceBindings.readmits(prior, params)) return { ok: false, error: `${params.envId} was removed and is admitted again only under a new identity at a higher generation` }
    if (prior && prior.state !== 'retired') {
      const same = prior.key_id === params.keyId && prior.sign_public === params.identity.signPublic && prior.seal_public === params.identity.sealPublic && prior.generation === params.generation
      if (!same) return { ok: false, error: `${params.envId} is bound under another key, identity or generation` }
      if (prior.state === 'pending') {
        this.db.prepare(`UPDATE device_bindings SET state = 'active', name = ? WHERE env_id = ? AND state = 'pending'`).run(params.name, params.envId)
        this.log(`${params.envId} (${params.name}) allowed, key ${params.keyId}, generation ${params.generation}`)
      }
      return { ok: true, binding: this.get(params.envId)! }
    }
    const other = this.byKey(params.keyId)
    if (other && other.envId !== params.envId) return { ok: false, error: `key ${params.keyId} already binds ${other.envId}` }
    this.write(params, 'active')
    this.log(`${params.envId} (${params.name}) bound to key ${params.keyId}, generation ${params.generation}`)
    return { ok: true, binding: this.get(params.envId)! }
  }

  /** A fresh row, or a retired one replaced whole: its queue and newest letter go with it (the caller's transaction). */
  private write(params: { envId: string; keyId: string; identity: DeviceIdentity; generation: number; name: string }, state: 'active' | 'pending'): void {
    this.db.prepare(`DELETE FROM device_bindings WHERE env_id = ? AND state = 'retired'`).run(params.envId)
    this.db.prepare(`DELETE FROM device_mail WHERE env_id = ?`).run(params.envId)
    this.db.prepare(`DELETE FROM device_state WHERE env_id = ?`).run(params.envId)
    this.db
      .prepare(`INSERT INTO device_bindings (env_id, key_id, sign_public, seal_public, generation, name, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(params.envId, params.keyId, params.identity.signPublic, params.identity.sealPublic, params.generation, params.name, state, this.now())
  }

  /**
   * A setup link's claim (devices/setupPairings.ts, inside its transaction):
   * a `pending` row, which routes nowhere and takes no letter until Allow.
   * Answers the row it replaced (a retired one), for Cancel to put back.
   */
  bindPending(params: { envId: string; keyId: string; identity: DeviceIdentity; generation: number; name: string }): Result<{ prior: string | null }> {
    const prior = this.row(params.envId)
    if (prior && !DeviceBindings.readmits(prior, params)) {
      return { ok: false, error: prior.state === 'retired' ? 'this computer was removed; it comes back only under a new identity' : 'this computer is set up already; Remove it on the giver first' }
    }
    if (this.byKey(params.keyId)) return { ok: false, error: `key ${params.keyId} already binds a computer` }
    this.write(params, 'pending')
    return { ok: true, prior: prior ? JSON.stringify(prior) : null }
  }

  /** Cancel, or a link ended before Allow: the pending row goes, and the retired one it replaced comes back. */
  dropPending(envId: string, keyId: string, prior: string | null): boolean {
    const gone = this.db.prepare(`DELETE FROM device_bindings WHERE env_id = ? AND key_id = ? AND state = 'pending'`).run(envId, keyId).changes === 1
    if (gone && prior) {
      const r = JSON.parse(prior) as BindingRow
      this.db
        .prepare(`INSERT INTO device_bindings (env_id, key_id, sign_public, seal_public, generation, name, state, created_at, seq, kind, ack, last_seen_at, removal_id, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.env_id, r.key_id, r.sign_public, r.seal_public, r.generation, r.name, r.state, r.created_at, r.seq, r.kind, r.ack, r.last_seen_at, r.removal_id, r.retired_at)
    }
    return gone
  }

  /** The newest verified letter's seq and kind; a stop makes it stopped, a manifest after a stop active again. */
  noteLetter(envId: string, seq: number, kind: string): void {
    const state = this.row(envId)?.state
    const next = kind === 'stop' && state === 'active' ? 'stopped' : kind === 'manifest' && state === 'stopped' ? 'active' : state
    this.db.prepare(`UPDATE device_bindings SET seq = ?, kind = ?, state = ? WHERE env_id = ?`).run(seq, kind, next ?? 'active', envId)
  }

  noteAck(envId: string, ack: DeviceAck): void {
    this.db.prepare(`UPDATE device_bindings SET ack = ?, last_seen_at = ? WHERE env_id = ?`).run(JSON.stringify(ack), this.now(), envId)
  }

  /** Remove's first step: the binding is no longer live, every route drops it. */
  markRemoving(envId: string, removalId: string): void {
    this.db.prepare(`UPDATE device_bindings SET state = 'removing', removal_id = ? WHERE env_id = ?`).run(removalId, envId)
  }

  /** For good: the env id is never admitted again. With a removal id, only the binding that removal marked retires. */
  retire(envId: string, removalId?: string): void {
    if (removalId) this.db.prepare(`UPDATE device_bindings SET state = 'retired', retired_at = ? WHERE env_id = ? AND state = 'removing' AND removal_id = ?`).run(this.now(), envId, removalId)
    else this.db.prepare(`UPDATE device_bindings SET state = 'retired', retired_at = ? WHERE env_id = ? AND state != 'retired'`).run(this.now(), envId)
    for (const [connection, p] of this.proved) if (p.envId === envId) this.proved.delete(connection)
    this.log(`${envId} retired`)
  }

  // ── sockets ─────────────────────────────────────────────────────────

  /** devices.challenge: a fresh nonce for this connection; a second ask replaces the first. */
  challenge(connection: number, principal: Principal): { nonce: string } {
    if (principal.kind !== 'remote' || !principal.caps.includes('device')) throw new Error('forbidden: devices.challenge is a given computer\'s')
    const nonce = randomBytes(32).toString('base64url')
    this.nonces.set(connection, { nonce, keyId: principal.keyId })
    return { nonce }
  }

  /**
   * peer.register's rules for a remote socket; null when it may register. A
   * device key must prove itself (and is then proved for this connection);
   * any key claiming a bound env id that is not its own is refused.
   */
  registerRefusal(connection: number, principal: RemotePrincipal, params: { from: string; proof?: string }): string | null {
    const claimed = this.row(params.from)
    if (!principal.caps.includes('device')) {
      // A pending claim is a setup link's, not yet allowed: it never shuts a host out of its own id.
      return claimed && claimed.state !== 'pending' ? `forbidden: ${params.from} is a given computer's; another key may not register as it` : null
    }
    const issued = this.nonces.get(connection)
    this.nonces.delete(connection)
    const binding = this.byKey(principal.keyId)
    if (!binding) return 'forbidden: this key binds no computer'
    if (claimed && claimed.key_id !== principal.keyId) return `forbidden: ${params.from} is bound to another key`
    if (binding.envId !== params.from) return `forbidden: this key binds ${binding.envId}, not ${params.from}`
    if (binding.state !== 'active' && binding.state !== 'stopped') return `forbidden: ${params.from} is ${binding.state}`
    if (!issued || issued.keyId !== principal.keyId) return 'forbidden: ask devices.challenge on this socket first'
    if (!params.proof || !verifyBytes(binding.identity.signPublic, proofBytes(issued.nonce, params.from, principal.keyId), params.proof)) return 'forbidden: the proof does not verify'
    this.proved.set(connection, { envId: binding.envId, keyId: principal.keyId })
    return null
  }

  /**
   * A socket opened with a ticket a proved socket of the same key minted (devices.ticket): it starts
   * proved for that env id, while the binding is still that key's and live. A bearer alone mints no such ticket.
   */
  adoptProof(connection: number, principal: RemotePrincipal): boolean {
    const envId = principal.provedEnv
    if (!envId || !principal.caps.includes('device')) return false
    const binding = this.byKey(principal.keyId)
    if (!binding || binding.envId !== envId || (binding.state !== 'active' && binding.state !== 'stopped')) return false
    this.proved.set(connection, { envId, keyId: principal.keyId })
    return true
  }

  /** The env id a device socket proved, or null. */
  provedEnv(connection: number): string | null {
    return this.proved.get(connection)?.envId ?? null
  }

  /** The host a call speaks for: a device socket's proved env id, never one it names; any other caller's own word. Null for an unproved device socket. */
  speakerFor(connection: number, principal: Principal, named: string): string | null {
    return principal.kind === 'remote' && principal.caps.includes('device') ? this.provedEnv(connection) : named
  }

  /** The proved connections of an env id. */
  connectionsOf(envId: string): number[] {
    return [...this.proved.entries()].filter(([, p]) => p.envId === envId).map(([c]) => c)
  }

  /**
   * The gate ahead of every request on a remote socket: a key in farewell is
   * refused everything here; a device key's socket that has not proved is
   * refused all but devices.challenge and peer.register.
   */
  socketRefusal(principal: Principal, connection: number, method: string): string | null {
    if (principal.kind !== 'remote') return null
    if (this.deps.inFarewell?.(principal.keyId)) return 'forbidden: farewell: this key reaches only /api/farewell'
    if (!principal.caps.includes('device') || BEFORE_PROOF.has(method)) return null
    return this.proved.has(connection) ? null : `forbidden: ${method} needs this socket's proof (devices.challenge, then peer.register)`
  }

  dropConnection(connection: number): void {
    this.nonces.delete(connection)
    this.proved.delete(connection)
  }
}

/**
 * The box's one bindings, for a route that cannot take it as a dependency.
 * Unset (a given computer, the Mac, a test): no host is bound here.
 */
export const deviceBindingsHook: { current: DeviceBindings | null } = { current: null }

/** True only for an env id whose binding here is active or stopped. */
export function liveBinding(envId: string): boolean {
  return deviceBindingsHook.current?.live(envId) ?? false
}

/** Whether a route may reach a host: no given computer, or a live one. */
export function mayRoute(envId: string): boolean {
  return deviceBindingsHook.current?.mayRoute(envId) ?? true
}

/** canonicalJson of an ack without its signature: what the device key signed. */
export const ackBytes = (ack: DeviceAck): Buffer => {
  const { signature: _signature, ...rest } = ack
  return Buffer.from(canonicalJson(rest))
}
