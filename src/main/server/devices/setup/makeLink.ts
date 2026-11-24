import { randomBytes } from 'node:crypto'
import type { DeviceIdentity, DevicesPush, SetupClaimRecord, SetupItems, SetupLinkRow } from '@shared/contract-devices'
import { deriveLinkKeys, sealWithKey, verifyBytes } from '@shared/devices/keys'
import { bundleDigest, claimBytes, formatSetupLink, setupWords, SETUP_TTL_MS, type SetupBundle } from '@shared/devices/setupLink'
import type { GiverDevices } from '../giverDevices'

/**
 * The giver's half of the setup link (docs/agents/pc-setup.md "The setup
 * link"). Make link: a 32-byte secret, from it the bundle key and the link
 * verifier; the bundle (who gives, through which box, what, the seeds) sealed
 * with the bundle key; a setup pairing minted on the box; the secret kept in
 * this Mac's vault (`addon/~setup-<pairingId>`) until the link is used,
 * cancelled or ends, and nowhere else. The link is answered once, to the
 * window that asked.
 *
 * On `device-joined` with the pairing id: the claim from devices.setupProof is
 * checked with the verifier made from the secret (a claim for an identity the
 * box swapped in fails it), and the device's own signature; then the three
 * words and the Allow notice. Allow: devices.activate, the computer kept with
 * its activate letter (the box, the giver, and LifeOS's one-time codes when
 * the link gives LifeOS) and, once it acks that, its first manifest; the
 * computer added to the chosen Work workspaces; the secret deleted.
 *
 * Nothing here logs a link, a code, a secret or a LifeOS code.
 */

export const LINKS_SETTING = 'devices.setupLinks'
export const secretName = (pairingId: string): string => `~setup-${pairingId}`

interface LinkRecord extends SetupLinkRow {
  items: SetupItems
  workspaces: string[]
  origin: string
  bundleDigest: string
  claim?: SetupClaimRecord
  envId?: string
  /**
   * An Allow under way, written before its first await (F11): a second Allow is refused, Cancel waits for
   * it, and one a crash cut short is run again (`resume`). `enrollment` is LifeOS's, once minted.
   */
  attempt?: { at: number; enrollment?: string }
}

export interface LifeosGrant {
  enrollment: string
  owner: string
  codes: { desktop?: string; tempcode?: string }
}

export interface MakeLinkDeps {
  environmentId: string
  giverName: () => string
  identity: () => DeviceIdentity
  /** The box link this Mac gives through (its admin key, the giver's). */
  box: () => { envId: string; request<T>(method: string, params?: unknown): Promise<T> } | null
  /** This Mac's vault, a bare secret per link. */
  secrets: { read(name: string): string | null; write(name: string, raw: string): void; clear(name: string): void }
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  computers: Pick<GiverDevices, 'add' | 'activate' | 'list' | 'owe'> & { firstManifestAfterAck(envId: string): void }
  /** LifeOS's one-time codes for the computer, through this Mac's Work session; null while it holds none. */
  lifeos: (name: string) => Promise<LifeosGrant | null>
  /** The Work switch here, seeded to the computer. */
  workOn: () => boolean
  /** Adds a host to a Work workspace's `mayUseDesktop`, wherever the workspace lives. */
  addDesktop: (workspaceId: string, envId: string) => Promise<void>
  /** The giver's own windows. */
  push: (p: DevicesPush) => void
  now?: () => number
  log?: (line: string) => void
}

export interface MakeInput {
  name: string
  items: SetupItems
  workspaces: string[]
  seeds?: { appearance?: unknown; defaultModels?: unknown }
}

export class SetupLinks {
  /** The Allow running for each link, for Cancel to wait on. */
  private readonly allowing = new Map<string, Promise<{ ok: true; envId: string }>>()

  constructor(private readonly deps: MakeLinkDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[devices] ${l}`)))(line)
  }

  private records(): LinkRecord[] {
    try {
      const raw = this.deps.store.getSetting(LINKS_SETTING)
      return raw ? (JSON.parse(raw) as LinkRecord[]) : []
    } catch {
      return []
    }
  }

  private save(list: LinkRecord[]): void {
    // Rows over a day past their end go.
    const keep = list.filter((r) => r.expiresAt > this.now() - 86_400_000 || r.state === 'asking')
    this.deps.store.setSetting(LINKS_SETTING, keep.length ? JSON.stringify(keep) : null)
  }

  private record(pairingId: string): LinkRecord | null {
    return this.records().find((r) => r.pairingId === pairingId) ?? null
  }

  private update(pairingId: string, patch: Partial<LinkRecord>): LinkRecord | null {
    const list = this.records()
    const i = list.findIndex((r) => r.pairingId === pairingId)
    if (i < 0) return null
    list[i] = { ...list[i], ...patch }
    this.save(list)
    return list[i]
  }

  private dropSecret(pairingId: string): void {
    try {
      this.deps.secrets.clear(secretName(pairingId))
    } catch {
      // a locked vault: the sweep tries again
    }
  }

  private rowOf(r: LinkRecord): SetupLinkRow {
    return { pairingId: r.pairingId, name: r.name, expiresAt: r.expiresAt, state: r.state, ...(r.words ? { words: r.words } : {}), ...(r.reason ? { reason: r.reason } : {}) }
  }

  private tell(r: LinkRecord | null): void {
    if (r) this.deps.push({ push: 'device-link', link: this.rowOf(r) })
  }

  /** The open links and those waiting for Allow, for a window that opens late. */
  links(): SetupLinkRow[] {
    this.sweep()
    void this.rediscover()
    return this.records().filter((r) => r.state === 'open' || r.state === 'asking').map((r) => this.rowOf(r))
  }

  /** Make link. The answer is the link's only appearance. */
  async make(input: MakeInput): Promise<{ link: string; expiresAt: number; pairingId: string }> {
    const box = this.deps.box()
    if (!box) throw new Error('This Mac is not linked to the box')
    const name = input.name.trim()
    const { origin } = await box.request<{ origin: string }>('remote.status', {})
    const secret = randomBytes(32)
    const { bundleKey, verifier } = deriveLinkKeys(secret)
    const bundle: SetupBundle = {
      v: 1,
      giver: { identity: this.deps.identity(), name: this.deps.giverName(), envId: this.deps.environmentId },
      box: { envId: box.envId, origin },
      items: input.items,
      workspaces: input.items.folders ? input.workspaces : [],
      seeds: { ...(input.seeds ?? {}), work: this.deps.workOn() }
    }
    const sealed = sealWithKey(bundleKey, Buffer.from(JSON.stringify(bundle)))
    const made = await box.request<{ pairing: { id: string; expiresAt: number }; code: string }>('remote.pairings.create', {
      name,
      audience: 'client',
      caps: ['pending'],
      setup: { verifier: verifier.public, bundle: sealed, name }
    })
    const pairingId = made.pairing.id
    try {
      this.deps.secrets.write(secretName(pairingId), secret.toString('base64url'))
    } catch (err) {
      await box.request('remote.pairings.revoke', { id: pairingId }).catch(() => {})
      throw new Error(`The vault did not take the link's secret (${(err as Error).message})`)
    }
    const expiresAt = made.pairing.expiresAt || this.now() + SETUP_TTL_MS
    this.save([...this.records(), { pairingId, name, expiresAt, state: 'open', items: input.items, workspaces: bundle.workspaces, origin, bundleDigest: bundleDigest(sealed) }])
    this.log(`setup link ${pairingId} made for ${name}`)
    return { link: formatSetupLink(origin, made.code, secret), expiresAt, pairingId }
  }

  /**
   * Cancel (and Remove on the notice): the box ends the pairing, its pending key and claim; the secret goes.
   * An Allow under way finishes first: once it has, the computer is joined and only Remove ends it (F11).
   */
  async cancel(pairingId: string): Promise<{ ok: boolean }> {
    await this.allowing.get(pairingId)?.catch(() => {})
    const r = this.record(pairingId)
    if (!r || r.state === 'allowed' || r.attempt) return { ok: false }
    const box = this.deps.box()
    if (box) await box.request('remote.pairings.revoke', { id: pairingId })
    else if (r.state === 'open' || r.state === 'asking') throw new Error('This Mac is not linked to the box; the link ends on its own at its time')
    this.dropSecret(pairingId)
    if (r.state === 'open' || r.state === 'asking') this.tell(this.update(pairingId, { state: 'ended', words: undefined }))
    return { ok: true }
  }

  /** The verifier this Mac made for a link, from its secret; null once the secret is gone. */
  private verifierOf(pairingId: string): string | null {
    let raw: string | null = null
    try {
      raw = this.deps.secrets.read(secretName(pairingId))
    } catch {
      raw = null
    }
    if (!raw) return null
    try {
      return deriveLinkKeys(Buffer.from(raw, 'base64url')).verifier.public
    } catch {
      return null
    }
  }

  /** `device-joined` with a pairing id: check the claim, then raise the Allow notice. */
  async onJoined(pairingId: string): Promise<void> {
    const r = this.record(pairingId)
    if (!r || r.state !== 'open') return
    const box = this.deps.box()
    if (!box) return
    const { claim } = await box.request<{ claim: SetupClaimRecord | null }>('devices.setupProof', { pairingId })
    const refusal = claim ? this.refusal(r, claim) : 'The box sent no claim'
    if (refusal || !claim) {
      this.log(`setup link ${pairingId}: claim refused (${refusal})`)
      await box.request('remote.pairings.revoke', { id: pairingId }).catch(() => {})
      this.dropSecret(pairingId)
      this.tell(this.update(pairingId, { state: 'refused', reason: 'The computer that used this link could not prove it holds it. Make a new link.' }))
      return
    }
    const words = setupWords(claim)
    this.update(pairingId, { state: 'asking', words, claim, envId: claim.envId })
    this.deps.push({ push: 'device-allow', pairingId, name: r.name, words })
  }

  /** Why a claim is not the one this link's holder made, or null. */
  private refusal(r: LinkRecord, claim: SetupClaimRecord): string | null {
    const verifier = this.verifierOf(r.pairingId)
    if (!verifier) return 'the link was cancelled or ended'
    if (claim.pairingId !== r.pairingId || claim.origin !== r.origin || claim.bundleDigest !== r.bundleDigest) return 'the claim names another link'
    const bytes = claimBytes(claim)
    if (!verifyBytes(verifier, bytes, claim.proof.verifierSig)) return 'the link verifier did not sign this claim'
    if (!verifyBytes(claim.identity.signPublic, bytes, claim.proof.deviceSig)) return 'the computer did not sign its claim'
    return null
  }

  /** Allow: the computer joins. The attempt is on file before the first await, so a second Allow finds it (F11). */
  allow(pairingId: string): Promise<{ ok: true; envId: string }> {
    const r = this.record(pairingId)
    if (!r?.claim || r.state !== 'asking' || r.attempt || this.allowing.has(pairingId)) return Promise.reject(new Error('Nothing waits for Allow on this link'))
    const box = this.deps.box()
    if (!box) return Promise.reject(new Error('This Mac is not linked to the box'))
    if (!this.verifierOf(pairingId) || this.refusal(r, r.claim)) return Promise.reject(new Error('This link was cancelled or ended'))
    const attempt = { at: this.now() }
    this.update(pairingId, { attempt })
    return this.run({ ...r, attempt })
  }

  /** An Allow a crash cut short, run again at the box link's next up: it finishes, or ends and owes what it minted. */
  async resume(): Promise<void> {
    await this.rediscover()
    for (const r of this.records()) {
      if (r.state !== 'asking' || !r.attempt || this.allowing.has(r.pairingId)) continue
      this.log(`setup link ${r.pairingId}: an Allow was cut short; run again`)
      await this.run(r).catch((err) => this.log(`setup link ${r.pairingId}: Allow not finished (${(err as Error).message})`))
    }
  }

  private run(r: LinkRecord): Promise<{ ok: true; envId: string }> {
    const run = this.finishAllow(r).finally(() => this.allowing.delete(r.pairingId))
    this.allowing.set(r.pairingId, run)
    return run
  }

  private async finishAllow(r: LinkRecord): Promise<{ ok: true; envId: string }> {
    const pairingId = r.pairingId
    const box = this.deps.box()
    if (!box) throw new Error('This Mac is not linked to the box')
    const c = r.claim!
    // A try a crash cut short after the computer was kept: its activate letter is on file (and posted again by catchUp).
    const kept = this.deps.computers.list().some((x) => x.envId === c.envId && x.generation === c.generation)
    // An enrollment minted by a try that never handed on its codes is owed a revoke: the codes are gone with it.
    const minted = r.attempt?.enrollment
    if (minted && !this.deps.computers.list().some((x) => x.envId === c.envId && x.enrollments?.includes(minted))) {
      this.deps.computers.owe([minted], r.name)
      this.update(pairingId, { attempt: { at: r.attempt!.at } })
    }
    try {
      await box.request('devices.activate', { envId: c.envId, keyId: c.keyId, identity: c.identity, generation: c.generation, name: r.name })
    } catch (err) {
      // Not joined: the link waits for Allow again, or reads as ended past its time.
      const ended = r.expiresAt <= this.now()
      this.tell(this.update(pairingId, { attempt: undefined, ...(ended ? { state: 'ended' as const, words: undefined } : {}) }))
      if (ended) this.dropSecret(pairingId)
      throw err
    }
    if (!kept) await this.keep(r, box.envId)
    for (const w of r.workspaces) {
      await this.deps.addDesktop(w, c.envId).catch((err) => this.log(`setup link ${pairingId}: workspace ${w} not given the computer (${(err as Error).message})`))
    }
    this.dropSecret(pairingId)
    this.tell(this.update(pairingId, { state: 'allowed', words: undefined, attempt: undefined }))
    this.log(`setup link ${pairingId}: ${r.name} allowed as ${c.envId}`)
    return { ok: true, envId: c.envId }
  }

  /** The computer kept with its activate letter: LifeOS's codes minted, their enrollment on file before the row. */
  private async keep(r: LinkRecord, boxEnvId: string): Promise<void> {
    const pairingId = r.pairingId
    const c = r.claim!
    let lifeos: LifeosGrant | null = null
    // Null: this Mac's Work holds no LifeOS session. A throw: LifeOS was asked and did not prepare the sign-in.
    let lifeosFailed = false
    if (r.items.lifeos) {
      try {
        lifeos = await this.deps.lifeos(r.name)
        if (lifeos) this.update(pairingId, { attempt: { at: r.attempt!.at, enrollment: lifeos.enrollment } })
      } catch (err) {
        lifeosFailed = true
        this.log(`setup link ${pairingId}: LifeOS sign-in not prepared (${(err as Error).message})`)
      }
    }
    this.deps.computers.add({ envId: c.envId, name: r.name, identity: c.identity, generation: c.generation, accounts: r.items.accounts, ...(lifeos ? { enrollments: [lifeos.enrollment] } : {}) })
    this.deps.computers.firstManifestAfterAck(c.envId)
    const extra: Record<string, unknown> = {
      box: { envId: boxEnvId, origin: r.origin },
      giver: { envId: this.deps.environmentId, name: this.deps.giverName() },
      ...(r.items.lifeos ? { lifeos: lifeos ? { owner: lifeos.owner, codes: lifeos.codes, reader: r.items.reader } : { missing: lifeosFailed ? 'failed' : 'not-signed-in' } } : {})
    }
    await this.deps.computers.activate(c.envId, extra)
  }

  /**
   * The box pushes a claim once (`device-joined`): an open link asks the box whether it was claimed, at the
   * box link's next up, on a window's read and each minute, so a push lost on a dropped link is found (F21).
   */
  async rediscover(): Promise<void> {
    const box = this.deps.box()
    if (!box) return
    for (const r of this.records()) {
      if (r.state !== 'open' || r.expiresAt <= this.now()) continue
      const { claim } = await box.request<{ claim: SetupClaimRecord | null }>('devices.setupProof', { pairingId: r.pairingId }).catch(() => ({ claim: null }))
      if (claim) await this.onJoined(r.pairingId).catch((err) => this.log(`setup link ${r.pairingId}: claim not checked (${(err as Error).message})`))
    }
  }

  /** Links past their end lose their secret and read as ended; called on each ask and on a timer. */
  sweep(): void {
    const now = this.now()
    for (const r of this.records()) {
      // An Allow under way, or one cut short, is `resume`'s to settle.
      if ((r.state === 'open' || r.state === 'asking') && r.expiresAt <= now && !r.attempt) {
        this.dropSecret(r.pairingId)
        this.tell(this.update(r.pairingId, { state: 'ended', words: undefined }))
      }
    }
  }
}
