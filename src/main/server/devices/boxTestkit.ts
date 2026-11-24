import type { DevicesPush } from '@shared/contract-devices'
import { sealLetter, type Grant, type Letter, type LetterHeader, type LetterKind } from '@shared/devices/envelope'
import { canonicalJson, generateDeviceKeys, signBytes, type DeviceKeys } from '@shared/devices/keys'
import { openDb } from '../db'
import { RemoteAuth } from '../remote/auth'
import { ackBytes, DeviceBindings, proofBytes } from './binding'
import { Farewell } from './farewell'
import { Givers } from './giver'
import { DeviceMailbox, headerDigest } from './mailbox'

/**
 * A box for the devices tests (mailbox, binding, farewell): an in-memory
 * database, real RemoteAuth, a giver on file, and every push recorded.
 * Keys and secrets are fakes made here.
 */
export async function makeBox(start = 1_700_000_000_000) {
  const clock = { now: start }
  const now = (): number => clock.now
  const db = openDb(':memory:')
  const auth = new RemoteAuth(db, { now })
  const settings = new Map<string, string>()
  const givers = new Givers({ getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) }, auth, now, () => {})
  const giverKeys = generateDeviceKeys()
  const giverKey = (await auth.createKey({ name: 'Mac', audience: 'client', caps: ['admin'], createdBy: 'test' })).key
  givers.set(giverKey.id, { signPublic: giverKeys.signPublic, sealPublic: giverKeys.sealPublic }, 'Mac')
  const toComputer: { envId: string; push: DevicesPush }[] = []
  const toGiver: DevicesPush[] = []
  const farewells: string[] = []
  const dropped: string[] = []
  auth.onFarewell((keyId) => farewells.push(keyId))
  const bindings = new DeviceBindings(db, { now, log: () => {}, inFarewell: (k) => auth.inFarewell(k) })
  const mailbox = new DeviceMailbox(db, { bindings, giver: () => givers.giver(), auth, toComputer: (envId, push) => toComputer.push({ envId, push }), toGiver: (p) => toGiver.push(p), now, log: () => {} })
  const farewell = new Farewell(db, { bindings, mailbox, auth, dropCalls: (k) => dropped.push(k), toGiver: (p) => toGiver.push(p), now, log: () => {} })
  auth.setFarewellCheck((k) => farewell.inFarewell(k))

  /** A pending computer's key and identity, activated as `envId` at `generation`. */
  const computer = async (envId = 'env_pc', generation = 1) => {
    const keys = generateDeviceKeys()
    const made = await auth.createKey({ name: envId, audience: 'client', caps: ['read'], createdBy: giverKey.id })
    const activated = mailbox.activate({ envId, keyId: made.key.id, identity: { signPublic: keys.signPublic, sealPublic: keys.sealPublic }, generation, name: envId })
    return { envId, keys, keyId: made.key.id, token: made.token, generation, binding: activated.binding }
  }
  type Computer = Awaited<ReturnType<typeof computer>>

  /** A letter from the giver; `over` bends the header, `signer` signs it in the giver's place. */
  const letter = (to: Computer, seq: number, kind: LetterKind = 'manifest', opts: { grants?: Grant[]; over?: Partial<LetterHeader>; signer?: DeviceKeys; secret?: string } = {}): Letter => {
    const grants = opts.grants ?? (kind === 'manifest' ? [{ service: 'codex', account: 'acct-1', kind: 'access' as const, owner: 'env_box' }] : [])
    const header: LetterHeader = {
      v: 1,
      id: `letter-${seq}`,
      kind,
      to: to.envId,
      toKey: to.keys.sealPublic,
      generation: to.generation,
      from: (opts.signer ?? giverKeys).signPublic,
      seq,
      issuedAt: clock.now,
      leaseUntil: kind === 'manifest' ? clock.now + 30 * 86_400_000 : null,
      grants,
      ...opts.over
    }
    const accounts = grants.map((g) => (g.kind === 'static' ? { ...g, secret: opts.secret ?? 'fake secret' } : { ...g }))
    return sealLetter(header, { kind, seq, accounts }, (opts.signer ?? giverKeys).signPrivate)
  }

  /** The computer proves `connection` the way its peer link does. */
  const prove = (c: Computer, connection: number): string | null => {
    const principal = { kind: 'remote' as const, keyId: c.keyId, name: c.envId, audience: 'client' as const, caps: auth.getKey(c.keyId)!.caps }
    const { nonce } = bindings.challenge(connection, principal)
    return bindings.registerRefusal(connection, principal, { from: c.envId, proof: signBytes(c.keys.signPrivate, proofBytes(nonce, c.envId, c.keyId)) })
  }

  /** A signed ack of letter `seq` (the newest on file unless `header` names another). */
  const ack = (c: Computer, header: LetterHeader, signer: DeviceKeys = c.keys) => {
    const unsigned = { envId: c.envId, letterId: header.id, seq: header.seq, digest: headerDigest(header), holds: [], own: [], at: clock.now }
    return { ...unsigned, signature: signBytes(signer.signPrivate, ackBytes({ ...unsigned, signature: '' })) }
  }

  const receipt = (c: Computer, removalId: string, signer: DeviceKeys = c.keys): string => signBytes(signer.signPrivate, Buffer.from(canonicalJson({ removalId, envId: c.envId })))

  const principalOf = (c: Computer) => ({ kind: 'remote' as const, keyId: c.keyId, name: c.envId, audience: 'client' as const, caps: auth.getKey(c.keyId)!.caps })

  return { db, auth, givers, giverKey, giverKeys, bindings, mailbox, farewell, clock, toComputer, toGiver, farewells, dropped, computer, letter, prove, ack, receipt, principalOf }
}
