import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DeviceAck, DeviceBinding, DeviceIdentity, DevicesPush, GiverRecord } from '@shared/contract-devices'
import { LETTER_CAP, letterSignedBy, letterSize, type Grant, type Letter, type LetterHeader } from '@shared/devices/envelope'
import { canonicalJson, verifyBytes } from '@shared/devices/keys'
import type { Capability } from '@shared/capabilities'
import { ackBytes, DEVICE_CAPS, type DeviceBindings } from './binding'

/**
 * The box's mailbox for given computers (docs/agents/pc-setup.md "The box's
 * mailbox"). The giver posts sealed letters (`devices.post`, give); the box
 * checks the giver's signature before it reads the header for anything,
 * then that the header names a bound computer at its key and generation
 * with a seq above the newest on file, and that the letter is under
 * LETTER_CAP. The newest letter supersedes every older one in the queue
 * (`device_mail`) and is kept apart in `device_state`, which no sweep
 * touches. The addressee's proved socket hears `device-mail` and pulls
 * `devices.mail`; its signed ack lands on the binding and the giver's
 * sockets hear `device-acked`.
 *
 * The box filters what the account sync hands a given computer by the
 * newest verified header (`admittedFor`): an active binding's live manifest
 * admits its grants; a stopped, removing or retired binding, one with no
 * manifest, or one whose lease ran out, admits nothing.
 */

export interface MailboxDeps {
  bindings: DeviceBindings
  /** The giver on file (devices/giver.ts). */
  giver: () => GiverRecord | null
  auth: {
    getKey(id: string): { id: string; caps: Capability[]; revokedAt: number | null } | null
    setCaps(id: string, caps: Capability[]): unknown
  }
  /** A push to the env's proved sockets. */
  toComputer: (envId: string, push: DevicesPush) => void
  /** A push to the giver's sockets. */
  toGiver: (push: DevicesPush) => void
  /** An env id another host holds now (setupPairings' `taken`), asked again at activation: a claim is checked only when it is made (F27). */
  taken?: (envId: string) => boolean
  now?: () => number
  log?: (line: string) => void
}

interface StateRow {
  env_id: string
  seq: number
  kind: string
  header: string
  letter: string
  at: number
}

/** sha256 hex of canonicalJson(header): the digest an ack names. */
export const headerDigest = (header: LetterHeader): string => createHash('sha256').update(canonicalJson(header)).digest('hex')

export class DeviceMailbox {
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: MailboxDeps
  ) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(`[devices] ${line}`))
  }

  /** devices.activate (give): bind the computer and make its pending key a device key. */
  activate(params: { envId: string; keyId: string; identity: DeviceIdentity; generation: number; name: string }): { binding: DeviceBinding } {
    const key = this.deps.auth.getKey(params.keyId)
    if (!key || key.revokedAt !== null) throw new Error(`refused: unknown key ${params.keyId}`)
    if (this.deps.giver()?.keyId === params.keyId) throw new Error('refused: the giver\'s key is not a given computer\'s')
    if (key.caps.includes('admin') || key.caps.includes('give')) throw new Error(`refused: key ${params.keyId} is not a pending computer's key`)
    if (this.deps.bindings.get(params.envId)?.state === 'pending' && this.deps.taken?.(params.envId)) throw new Error(`refused: ${params.envId} is another host's now; it cannot be set up under it`)
    // The binding's state and the key's caps in one commit (F11).
    this.db.exec('BEGIN')
    try {
      const bound = this.deps.bindings.bind(params)
      if (!bound.ok) throw new Error(`refused: ${bound.error}`)
      this.deps.auth.setCaps(params.keyId, [...DEVICE_CAPS])
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.deps.toGiver({ push: 'device-joined', envId: params.envId })
    return { binding: this.deps.bindings.get(params.envId)! }
  }

  /** devices.post (give): one letter for one computer. Throws `refused: …` for every rule it breaks. */
  post(letter: Letter): { ok: true; superseded: number } {
    const giver = this.deps.giver()
    if (!giver?.identity.signPublic) throw new Error('refused: no giver on file')
    // The signature first: nothing in an unsigned header is read.
    if (!letterSignedBy(letter, giver.identity.signPublic)) throw new Error('refused: the giver did not sign this letter')
    const { header } = letter
    const binding = this.deps.bindings.get(header.to)
    if (!binding) throw new Error(`refused: ${header.to} is not bound here`)
    if (binding.state === 'retired' || binding.state === 'pending') throw new Error(`refused: ${header.to} is ${binding.state}`)
    if (binding.state === 'removing' && header.kind !== 'remove') throw new Error(`refused: ${header.to} is being removed; only its remove letter goes`)
    if (header.kind === 'remove' && binding.state !== 'removing') throw new Error('refused: a remove letter follows devices.remove')
    if (header.toKey !== binding.identity.sealPublic) throw new Error('refused: the letter is sealed to another key')
    if (header.generation !== binding.generation) throw new Error(`refused: generation ${header.generation} is not ${binding.generation}`)
    if (binding.seq !== null && header.seq <= binding.seq) throw new Error(`refused: seq ${header.seq} is not above ${binding.seq}`)
    if (letterSize(letter) > LETTER_CAP) throw new Error(`refused: the letter is over ${LETTER_CAP} bytes`)
    const at = this.now()
    const raw = JSON.stringify(letter)
    let superseded = 0
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`INSERT INTO device_mail (env_id, seq, kind, letter, at) VALUES (?, ?, ?, ?, ?)`).run(header.to, header.seq, header.kind, raw, at)
      superseded = Number(this.db.prepare(`DELETE FROM device_mail WHERE env_id = ? AND seq < ?`).run(header.to, header.seq).changes)
      this.db
        .prepare(`INSERT INTO device_state (env_id, seq, kind, header, letter, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(env_id) DO UPDATE SET seq = excluded.seq, kind = excluded.kind, header = excluded.header, letter = excluded.letter, at = excluded.at`)
        .run(header.to, header.seq, header.kind, JSON.stringify(header), raw, at)
      this.deps.bindings.noteLetter(header.to, header.seq, header.kind)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.log(`${header.to}: letter ${header.seq} (${header.kind}) on file${superseded ? `, ${superseded} older superseded` : ''}`)
    this.deps.toComputer(header.to, { push: 'device-mail', seq: header.seq })
    return { ok: true, superseded }
  }

  private stateRow(envId: string): StateRow | null {
    return (this.db.prepare(`SELECT * FROM device_state WHERE env_id = ?`).get(envId) as StateRow | undefined) ?? null
  }

  /** The newest verified letter for a computer, from device_state. */
  newest(envId: string): { seq: number; kind: string; header: LetterHeader; letter: Letter } | null {
    const r = this.stateRow(envId)
    if (!r) return null
    return { seq: r.seq, kind: r.kind, header: JSON.parse(r.header) as LetterHeader, letter: JSON.parse(r.letter) as Letter }
  }

  /** devices.mail (its proved socket; /api/farewell's op 'mail'): the newest letter, and while it is being removed, the removal. */
  mail(envId: string): { letter: Letter | null; removal: { removalId: string } | null } {
    const binding = this.deps.bindings.get(envId)
    if (!binding || binding.state === 'retired') throw new Error(`refused: ${envId} is not bound here`)
    const newest = this.newest(envId)
    if (binding.state === 'removing') {
      return { letter: newest?.kind === 'remove' ? newest.letter : null, removal: binding.removalId ? { removalId: binding.removalId } : null }
    }
    return { letter: newest?.letter ?? null, removal: null }
  }

  /** devices.ack (its proved socket): the computer's signed word on what it applied. */
  ack(envId: string, ack: DeviceAck): { ok: true } {
    const binding = this.deps.bindings.get(envId)
    if (!binding || (binding.state !== 'active' && binding.state !== 'stopped')) throw new Error(`refused: ${envId} is not live here`)
    if (ack.envId !== envId) throw new Error('refused: an ack names its own computer')
    if (!verifyBytes(binding.identity.signPublic, ackBytes(ack), ack.signature)) throw new Error('refused: the ack is not signed by this computer')
    if (binding.seq === null || ack.seq > binding.seq) throw new Error(`refused: no letter ${ack.seq} went to ${envId}`)
    const newest = this.newest(envId)
    if (newest && ack.seq === newest.seq && (ack.digest !== headerDigest(newest.header) || ack.letterId !== newest.header.id)) throw new Error('refused: the ack names another letter')
    this.deps.bindings.noteAck(envId, ack)
    // Delivered: the queue's copies go; device_state keeps the letter.
    this.db.prepare(`DELETE FROM device_mail WHERE env_id = ? AND seq <= ?`).run(envId, ack.seq)
    this.deps.toGiver({ push: 'device-acked', envId })
    return { ok: true }
  }

  list(): { bindings: DeviceBinding[] } {
    return { bindings: this.deps.bindings.list() }
  }

  /**
   * What the account sync may hand a computer (AccountSync `admittedFor`):
   * undefined for a host bound to nothing here; null when it may hold nothing;
   * else the grants of its newest verified manifest.
   */
  admittedFor(envId: string): readonly Grant[] | null | undefined {
    const binding = this.deps.bindings.get(envId)
    if (!binding) return undefined
    if (binding.state !== 'active') return null
    const newest = this.newest(envId)
    if (newest?.kind !== 'manifest') return null
    if (newest.header.leaseUntil !== null && newest.header.leaseUntil < this.now()) return null
    return newest.header.grants
  }

  /** The queue's delivered rows and every row of a retired computer go; device_state stays. */
  sweepQueue(): number {
    let n = 0
    for (const b of this.deps.bindings.list()) {
      if (b.state === 'retired') n += Number(this.db.prepare(`DELETE FROM device_mail WHERE env_id = ?`).run(b.envId).changes)
      else if (b.ack) n += Number(this.db.prepare(`DELETE FROM device_mail WHERE env_id = ? AND seq <= ?`).run(b.envId, b.ack.seq).changes)
    }
    return n
  }
}
