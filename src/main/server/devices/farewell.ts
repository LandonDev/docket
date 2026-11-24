import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { FAREWELL_TTL_MS, type DevicesPush } from '@shared/contract-devices'
import type { Principal } from '@shared/capabilities'
import { canonicalJson, verifyBytes } from '@shared/devices/keys'
import { RemoteAuthError } from '../remote/auth'
import type { DeviceBindings } from './binding'
import type { DeviceMailbox } from './mailbox'

/**
 * Remove on the box (docs/agents/pc-setup.md "The box's mailbox").
 * `devices.remove` (give) persists a removal (`device_removals`, which
 * outlives the mail), takes the binding off every route (state `removing`),
 * and puts the computer's key in farewell: its sockets, relayed lanes and
 * their subscriptions close with FAREWELL_CLOSE (not 4001, so it retries),
 * its tickets go and the calls queued on it fail. From then the key reaches
 * only `POST /api/farewell`: `{op: 'mail'}` answers its remove letter, and
 * `{op: 'receipt', removalId, signature}` (its device key over
 * canonicalJson({removalId, envId})) records the receipt, revokes the key
 * and retires the binding for good. A key with no receipt is revoked
 * FAREWELL_TTL_MS after the removal (`sweep`).
 */

export interface FarewellDeps {
  bindings: DeviceBindings
  mailbox: Pick<DeviceMailbox, 'mail'>
  auth: {
    /** Drop its tickets and close its sockets with FAREWELL_CLOSE (RemoteAuth.farewell). */
    farewell(keyId: string): void
    revokeKey(keyId: string): boolean
  }
  /** Fail the calls queued on the key's registrations (PeerCalls.dropKey). */
  dropCalls?: (keyId: string) => void
  toGiver: (push: DevicesPush) => void
  /** The binding retired: the env id leaves every workspace's reach here for good (WorkSettingsStore.dropHost). */
  onRetired?: (envId: string) => void
  now?: () => number
  log?: (line: string) => void
}

interface RemovalRow {
  removal_id: string
  env_id: string
  key_id: string
  at: number
  receipt_at: number | null
  revoked_at: number | null
}

export const FarewellBodySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('mail') }),
  z.object({ op: z.literal('receipt'), removalId: z.string().min(1).max(64), signature: z.string().min(1).max(200) })
])

/** What a computer signs to say it wiped what it was given. */
export const receiptBytes = (removalId: string, envId: string): Buffer => Buffer.from(canonicalJson({ removalId, envId }))

export class Farewell {
  /** Keys in farewell: a removal with no revoke yet. Loaded once, kept in step. */
  private readonly keys = new Set<string>()
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: FarewellDeps
  ) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(`[devices] ${line}`))
    for (const r of db.prepare(`SELECT key_id FROM device_removals WHERE revoked_at IS NULL`).all() as unknown as { key_id: string }[]) this.keys.add(r.key_id)
    this.repair()
  }

  /** One commit for the writes of a step, so a crash leaves all of them or none (F19). */
  private tx(work: () => void): void {
    this.db.exec('BEGIN')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * At boot, before any request: a removal an older build left half done is finished. A removal with
   * no revoke whose binding was not yet marked is marked `removing` under that removal; one marked
   * revoked whose key or binding is still live is ended again (F19).
   */
  private repair(): void {
    for (const row of this.db.prepare(`SELECT * FROM device_removals`).all() as unknown as RemovalRow[]) {
      const binding = this.deps.bindings.get(row.env_id)
      if (!binding || binding.keyId !== row.key_id) continue
      if (row.revoked_at === null) {
        if (binding.state === 'active' || binding.state === 'stopped') {
          this.deps.bindings.markRemoving(row.env_id, row.removal_id)
          this.log(`${row.env_id}: removal ${row.removal_id} was not marked on the binding; marked now`)
        }
      } else if (binding.state === 'removing' && binding.removalId === row.removal_id) {
        this.log(`${row.env_id}: removal ${row.removal_id} was revoked but not retired; ended now`)
        this.end(row)
      }
    }
  }

  inFarewell(keyId: string): boolean {
    return this.keys.has(keyId)
  }

  private removal(id: string): RemovalRow | null {
    return (this.db.prepare(`SELECT * FROM device_removals WHERE removal_id = ?`).get(id) as RemovalRow | undefined) ?? null
  }

  /** devices.remove (give). A second ask for a computer already leaving answers its removal again. */
  remove(envId: string): { removalId: string } {
    const binding = this.deps.bindings.get(envId)
    if (!binding || binding.state === 'retired') throw new Error(`refused: ${envId} is not bound here`)
    if (binding.state === 'removing' && binding.removalId) return { removalId: binding.removalId }
    const removalId = randomBytes(16).toString('base64url')
    this.tx(() => {
      this.db.prepare(`INSERT INTO device_removals (removal_id, env_id, key_id, at) VALUES (?, ?, ?, ?)`).run(removalId, envId, binding.keyId, this.now())
      this.deps.bindings.markRemoving(envId, removalId)
    })
    this.keys.add(binding.keyId)
    this.deps.auth.farewell(binding.keyId)
    this.deps.dropCalls?.(binding.keyId)
    this.log(`${envId} (${binding.name}): removal ${removalId}, key ${binding.keyId} in farewell`)
    return { removalId }
  }

  /** `POST /api/farewell` from a key in farewell. */
  handle(principal: Principal & { kind: 'remote' }, body: unknown): unknown {
    if (!this.keys.has(principal.keyId)) throw new RemoteAuthError(403, 'this key is not in farewell')
    const binding = this.deps.bindings.byKey(principal.keyId)
    if (!binding || binding.state !== 'removing' || !binding.removalId) throw new RemoteAuthError(404, 'no removal for this key')
    const ask = FarewellBodySchema.parse(body)
    if (ask.op === 'mail') return this.deps.mailbox.mail(binding.envId)
    const row = this.removal(ask.removalId)
    if (!row || row.key_id !== principal.keyId || row.env_id !== binding.envId || row.removal_id !== binding.removalId) throw new RemoteAuthError(404, 'no such removal for this key')
    if (!verifyBytes(binding.identity.signPublic, receiptBytes(row.removal_id, row.env_id), ask.signature)) throw new RemoteAuthError(403, 'the receipt is not signed by this computer')
    this.db.prepare(`UPDATE device_removals SET receipt_at = ? WHERE removal_id = ?`).run(this.now(), row.removal_id)
    this.log(`${row.env_id}: receipt for removal ${row.removal_id}`)
    this.end(row)
    return { ok: true }
  }

  /** The key revoked and the binding retired: the end of a removal, by receipt or by the sweep. */
  private end(row: RemovalRow): void {
    // The revoke mark, the key and the binding in one commit; the binding retires only under this removal.
    this.tx(() => {
      this.db.prepare(`UPDATE device_removals SET revoked_at = ? WHERE removal_id = ?`).run(this.now(), row.removal_id)
      this.deps.auth.revokeKey(row.key_id)
      this.deps.bindings.retire(row.env_id, row.removal_id)
      this.db.prepare(`DELETE FROM device_mail WHERE env_id = ?`).run(row.env_id)
    })
    this.keys.delete(row.key_id)
    this.deps.onRetired?.(row.env_id)
    this.deps.toGiver({ push: 'device-gone', envId: row.env_id })
  }

  /**
   * The same install set up again while its removal waits for a receipt that cannot come (Start fresh
   * retired the identity that would sign it): the removal ends now, as the sweep would end it.
   */
  finish(envId: string): boolean {
    const binding = this.deps.bindings.get(envId)
    if (binding?.state !== 'removing' || !binding.removalId) return false
    const row = this.removal(binding.removalId)
    if (!row || row.revoked_at !== null) return false
    this.log(`${envId}: set up again under a new identity; removal ${row.removal_id} ends with no receipt`)
    this.end(row)
    return true
  }

  /** Revoke every farewell key FAREWELL_TTL_MS past its removal with no receipt. */
  sweep(): number {
    const cutoff = this.now() - FAREWELL_TTL_MS
    const rows = this.db.prepare(`SELECT * FROM device_removals WHERE revoked_at IS NULL AND at <= ?`).all(cutoff) as unknown as RemovalRow[]
    for (const row of rows) {
      this.log(`${row.env_id}: no receipt for removal ${row.removal_id} in 30 days; key ${row.key_id} revoked`)
      this.end(row)
    }
    return rows.length
  }
}
