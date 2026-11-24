import { createHash } from 'node:crypto'
import { accounts as coreAccounts, vault, type ServiceId } from 'aliax-core'
import { ownsProfile } from 'aliax-core/sync'
import { ADDON_SERVICE } from '@shared/addonGrant'
import { PROVIDER_OF, SERVICE_OF, type AccountProvider, type AccountsSnapshot } from '@shared/accounts'
import { FAREWELL_CLOSE, farewellPayload, peerProofPayload, type DeviceAck } from '@shared/contract-devices'
import type { ServerPush } from '@shared/contract'
import { openLetter, type Grant, type Letter, type LetterAccount, type LetterHeader } from '@shared/devices/envelope'
import { canonicalJson, signBytes } from '@shared/devices/keys'
import type { DeviceIdentities } from './identity'
import { givenHost } from './hostRules'

/**
 * A given computer's half of the mailbox (docs/agents/pc-setup.md "A given
 * computer"): a PC or a second Mac set up from the giver. It listens on
 * nothing; it dials the box, proves its device key in peer.register, reads
 * its newest letter (`devices.mail`) on every link up and every
 * `device-mail` push, and applies it.
 *
 * - **The pins.** Setup (M4) calls `pinGiver`: the giver's signing key, the
 *   box, the generation and the box's bearer key go into this host's vault as
 *   the bare secret `addon/~device-pins`, never a settings row; the saved box
 *   environment's key is taken out of its row and read back from the pins
 *   (remote/environments.ts `sealedEnvironmentKeys`). What changes with each
 *   letter (seq, lease, the given rows) is the settings row `devices.given`;
 *   a letter is opened against the pins alone.
 * - **Apply**, under one lock, as one recoverable operation:
 *   1. a deny marker (`devices.deny.<service>:<account>`) for each given row
 *      the letter drops (a stop or remove drops all);
 *   2. the vault reconciled: each dropped row by the drop sequence (refuse
 *      new turns on it, end the harness handles on it, delete it, clear the
 *      gateway's credential cache, delete its tagged files), each static
 *      grant saved with its profile, each access grant's profile added with
 *      the box as owner and no secret (the next pull brings it, admitted by
 *      the manifest); then the snapshot rebuilt (`refreshNow`);
 *   3. commit: seq, lease, rows, grants;
 *   4. the signed `devices.ack` (holds = the given rows, own = every other row).
 *   A crash before 3 leaves seq where it was, so the same letter, which the
 *   box hands out again, re-runs the apply; a crash after 3 leaves the ack
 *   owed, sent at the next link up. Deny-marked rows still in the vault at
 *   start are dropped then. Every step checks the pins still name the
 *   generation the letter was opened under.
 * - **Admission.** AccountSync's `admitted` is the committed grants, less any
 *   deny-marked one and any that matches a row this computer refreshes
 *   itself; so a late pull answer, rotation or askOwner never lands a
 *   dropped grant, nor one of the computer's own sign-ins.
 * - **Own rows**, there before setup, are listed in the ack's `own` and never
 *   touched; a grant matching one is not applied. **Given rows** are never
 *   pushed, handed off, made live or deleted by hand (AccountSync
 *   `givenRow`).
 * - **The lease.** Past `leaseUntil` the given rows are held out of routing
 *   (AccountsService `held`) and the Accounts page says one line
 *   (AccountsSnapshot.given); a newer manifest lifts it.
 * - **Remove** (a `remove` letter, or the box's farewell close and then its
 *   letter from /api/farewell): journaled in `devices.wipe`; every given row
 *   and tagged file goes, TempCode's LifeOS token, the folders setup added
 *   and LifeOS's reader; the signed receipt goes to /api/farewell, retried
 *   until the box records it; then the box environment, the pins and the
 *   identity. Start fresh on a locked vault ends the same way, with no receipt.
 */

export const GIVEN_SETTING = 'devices.given'
export const DENY_PREFIX = 'devices.deny.'
export const WIPE_SETTING = 'devices.wipe'
export const PINS_NAME = '~device-pins'
/** What a given computer may hold, and the services whose every row is listed as its own when not given. */
const ROW_SERVICES: readonly ServiceId[] = ['claude-code', 'codex', 'cursor', 'meta', 'muse-code']
const GIVEN_SERVICES: ReadonlySet<string> = new Set(['claude-code', 'codex', 'meta', 'muse-code'])
export const RECEIPT_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000]
const WIPE_RETRY_MS = 60_000
const ACK_CAP = 500
const TIMER_MAX = 2 ** 31 - 1

export interface Pins {
  v: 1
  giver: { signPublic: string; name: string; envId: string }
  box: { envId: string; origin: string }
  generation: number
  boxKey: string
  at: number
}

export interface GivenRow {
  service: ServiceId
  account: string
  name: string
  kind: 'static' | 'access'
}

export interface GivenState {
  giver: { name: string; envId: string }
  box: { envId: string; origin: string }
  generation: number
  lastSeq: number
  leaseUntil: number | null
  /** When the giver signed the newest letter applied (its issuedAt): "not in touch since". */
  since: number
  rows: GivenRow[]
  grants: Grant[]
  /** The applied letter whose ack the box has not taken yet. */
  unacked?: { letterId: string; seq: number; digest: string }
  removalId?: string
}

interface Wipe {
  removalId: string
  at: number
  step: 'drop' | 'receipt' | 'forget'
  /** The drop step's parts already done; one that fails is run again before the receipt is signed (F16). */
  done?: string[]
}

export interface SecretStore {
  read(): string | null
  write(raw: string): void
  clear(): void
}

export const vaultPinsStore: SecretStore = {
  read: () => vault.readSecret(ADDON_SERVICE, PINS_NAME),
  write: (raw) => vault.saveSecret(ADDON_SERVICE, PINS_NAME, raw, 'sync'),
  clear: () => vault.deleteProfile(ADDON_SERVICE, PINS_NAME)
}

export function memoryPinsStore(): SecretStore {
  let held: string | null = null
  return { read: () => held, write: (raw) => void (held = raw), clear: () => void (held = null) }
}

type Request = <T>(method: string, params?: unknown) => Promise<T>

export interface GivenDeps {
  environmentId: string
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void; settingsWithPrefix(prefix: string): Iterable<[string, string]> }
  identity: Pick<DeviceIdentities, 'keys' | 'retire'>
  pins?: SecretStore
  /** The connected link to the box, or null. */
  link: (envId: string) => Request | null
  /** Rebuild the accounts snapshot and hand it to the gateway (AccountSync's refreshNow). */
  refreshNow: () => Promise<void> | void
  /** The snapshot's one line or a held row changed: rebuild soon. */
  changed?: () => void
  /** Pull from the box now: a new access grant's copy arrives (AccountSync.syncWith). */
  pull?: (boxEnvId: string) => Promise<void> | void
  /** End the harness handles on an account (SessionRegistry.rebootOnAccount). */
  endHandles?: (provider: AccountProvider, name: string) => void | Promise<void>
  /** The gateway's credential cache for a service (GatewayHost.credentialsChanged). */
  clearGatewayCache?: (service: ServiceId) => void
  /** Delete the generation-tagged files of one given account, or of all with null (museConfigDirs.ts removeGivenMuseDirs). */
  dropFiles?: (service: ServiceId, name: string | null) => void
  /** Remove: TempCode's own LifeOS sign-in, when setup made it (devices/setup/gave.ts clearGivenWork). */
  clearLifeosToken?: () => Promise<unknown> | void
  /** Remove's first step: setup's steps stop and the running ones finish (SetupThisPc.halt). */
  haltSetup?: () => Promise<void> | void
  /** Remove's and Start fresh's last: setup's progress and record go (SetupThisPc.forget). */
  forgetSetup?: () => void
  /** Remove: the folders setup added, from setup's ledger (M6). */
  removeSetupFolders?: () => Promise<void> | void
  /** Remove: LifeOS's Outlook and Teams reader off (`read: false` in %APPDATA%\lifeos\purdue.json, M5). */
  lifeosReaderOff?: () => Promise<void> | void
  /** Remove's last step: the saved box environment goes (removeEnvironment, then the links refresh). */
  removeEnvironment?: (envId: string) => void
  /** Take a saved row's plain key out of settings (remote/environments.ts sealEnvironmentKey). */
  sealEnvironmentKey?: (envId: string) => void
  /** A letter applied (setup's steps, devices/setup/useLink.ts): its kind and the extra it carried. */
  onApplied?: (kind: 'activate' | 'manifest', extra: Record<string, unknown> | undefined) => void
  fetch?: typeof fetch
  now?: () => number
  log?: (line: string) => void
  /** Test seams: the receipt's backoff, and a fault after an apply step. */
  sleep?: (ms: number) => Promise<void>
  crashAfter?: (step: 'deny' | 'reconcile' | 'commit') => void
}

/** The letter's generation is no longer this computer's (a new setup, Remove, Start fresh): the apply stops. */
class Superseded extends Error {}

const rowKey = (r: { service: string; account: string }): string => `${r.service}:${r.account}`
const sameGrant = (a: { service: string; account: string }, b: { service: string; account: string }): boolean => a.service === b.service && a.account === b.account

export class GivenComputer {
  private chain: Promise<unknown> = Promise.resolve()
  /** Given rows being dropped: out of routing until the snapshot no longer has them. */
  private readonly dropping = new Set<string>()
  private leaseTimer: NodeJS.Timeout | null = null
  private wiping: Promise<void> | null = null
  private farewellRetry: NodeJS.Timeout | null = null
  private farewelling = false
  private closed = false

  constructor(private readonly deps: GivenDeps) {}

  private get pinsStore(): SecretStore {
    return this.deps.pins ?? vaultPinsStore
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[given] ${l}`)))(line)
  }

  // ── what is on file ────────────────────────────────────────────────────

  pins(): Pins | null {
    let raw: string | null
    try {
      raw = this.pinsStore.read()
    } catch {
      return null
    }
    if (!raw) return null
    try {
      const p = JSON.parse(raw) as Pins
      return p?.v === 1 && typeof p.giver?.signPublic === 'string' && typeof p.box?.envId === 'string' && typeof p.boxKey === 'string' && Number.isSafeInteger(p.generation) ? p : null
    } catch {
      return null
    }
  }

  state(): GivenState | null {
    const raw = this.deps.store.getSetting(GIVEN_SETTING)
    if (!raw) return null
    try {
      const s = JSON.parse(raw) as GivenState
      return s && Array.isArray(s.rows) && Array.isArray(s.grants) && typeof s.lastSeq === 'number' ? s : null
    } catch {
      return null
    }
  }

  private saveState(s: GivenState | null): void {
    this.deps.store.setSetting(GIVEN_SETTING, s ? JSON.stringify(s) : null)
  }

  /** The pins and the state, when they agree on the generation; null on a computer nobody gave anything. */
  private current(): { pins: Pins; state: GivenState } | null {
    const pins = this.pins()
    const state = this.state()
    return pins && state && state.generation === pins.generation && state.box.envId === pins.box.envId ? { pins, state } : null
  }

  /** Whether this computer was set up from a giver (hostRules.givenHost). */
  isGiven(): boolean {
    return this.pins() !== null
  }

  isBox(envId: string): boolean {
    return this.pins()?.box.envId === envId
  }

  /** The box's bearer key, for the saved environment's sealed row. */
  boxKeyFor(envId: string): string | null {
    const p = this.pins()
    return p && p.box.envId === envId ? p.boxKey : null
  }

  private denied(r: { service: string; account: string }): boolean {
    return this.deps.store.getSetting(`${DENY_PREFIX}${rowKey(r)}`) !== null
  }

  private deny(r: { service: string; account: string }, seq: number): void {
    this.deps.store.setSetting(`${DENY_PREFIX}${rowKey(r)}`, JSON.stringify({ seq, at: this.now() }))
  }

  private undeny(r: { service: string; account: string }): void {
    if (this.denied(r)) this.deps.store.setSetting(`${DENY_PREFIX}${rowKey(r)}`, null)
  }

  private denyMarkers(): string[] {
    return [...this.deps.store.settingsWithPrefix(DENY_PREFIX)].map(([k]) => k)
  }

  /** A row the giver gave (by its vault name): never pushed, handed off, made live or deleted here. */
  isGivenRow(service: ServiceId, name: string): boolean {
    return this.state()?.rows.some((r) => r.service === service && r.name === name && !takenOver(r)) ?? false
  }

  /** A vault row this computer refreshes itself, of this account: its own sign-in, a given row it took over included (F15). */
  private ownRefreshing(g: { service: string; account: string }): boolean {
    return safeProfiles(g.service as ServiceId).some((p) => p.accountId === g.account && ownedHere(p))
  }

  /**
   * What AccountSync may land here (devices/admission.ts `admitted`): the
   * committed grants, less a deny-marked one and one that matches a row this
   * computer refreshes itself. Undefined on a computer nobody gave anything;
   * empty while the pins and the state disagree (nothing lands then).
   */
  admitted(): readonly Grant[] | undefined {
    if (!this.pins()) return undefined
    const cur = this.current()
    // Past the lease nothing lands: a late pull answer or rotation is refused like any other (F13).
    if (!cur || this.paused()) return []
    return cur.state.grants.filter((g) => !this.denied(g) && !this.ownRefreshing(g))
  }

  /** Past the lease: the given rows are paused. */
  paused(): boolean {
    const s = this.state()
    return !!s && s.rows.length > 0 && s.leaseUntil !== null && this.now() > s.leaseUntil
  }

  /** The given rows routing skips now (AccountsService `held`): all while paused, and any being dropped. */
  held(provider: AccountProvider): string[] {
    const service = SERVICE_OF[provider]
    const s = this.state()
    const out = new Set<string>()
    if (s && this.paused()) for (const r of s.rows) if (r.service === service) out.add(r.name)
    for (const key of this.dropping) {
      const [svc, name] = splitOnce(key)
      if (svc === service) out.add(name)
    }
    return [...out]
  }

  /** The Accounts page's one line (AccountsSnapshot.given). */
  snapshotLine(): AccountsSnapshot['given'] {
    const s = this.state()
    if (!s || !this.pins()) return undefined
    return { paused: this.paused(), giver: s.giver.name, since: s.since }
  }

  /** Muse's tagged dirs (museConfigDirs.ts givenTag): a given account's generation. */
  givenTag(account: string): string | null {
    const s = this.state()
    return s?.rows.some((r) => r.service === 'muse-code' && r.name === account) ? `g${s.generation}` : null
  }

  /** Every vault row that is not given: this computer's own sign-ins. */
  own(rows: readonly GivenRow[] = this.state()?.rows ?? []): { service: string; account: string }[] {
    const out: { service: string; account: string }[] = []
    for (const service of ROW_SERVICES) {
      for (const p of safeProfiles(service)) if (!rows.some((r) => r.service === service && r.name === p.name)) out.push({ service, account: p.accountId })
    }
    return out
  }

  // ── setup ──────────────────────────────────────────────────────────────

  /**
   * Setup's activation (M4): pin the giver and the box, sealed in the vault,
   * and start the state at seq 0. A pin of another generation or giver first
   * drops every row the old one gave: nothing carries over. The box's saved
   * environment, when already saved, loses its plain key.
   */
  async pinGiver(input: { giver: { signPublic: string; name: string; envId: string }; box: { envId: string; origin: string }; boxKey: string; generation: number }): Promise<void> {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('a generation is a positive integer')
    if (!input.boxKey || !input.giver.signPublic || !input.box.envId) throw new Error('the pins are incomplete')
    await this.locked(async () => {
      const old = this.pins()
      if (old && (old.generation !== input.generation || old.giver.signPublic !== input.giver.signPublic || old.box.envId !== input.box.envId)) {
        await this.dropAll(this.state()?.lastSeq ?? 0)
        for (const key of this.denyMarkers()) this.deps.store.setSetting(key, null)
      }
      const pins: Pins = { v: 1, giver: { ...input.giver }, box: { ...input.box }, generation: input.generation, boxKey: input.boxKey, at: this.now() }
      this.pinsStore.write(JSON.stringify(pins))
      const prior = this.state()
      const keep = prior && prior.generation === input.generation && prior.box.envId === input.box.envId
      this.saveState(
        keep
          ? { ...prior, giver: { name: input.giver.name, envId: input.giver.envId }, box: { ...input.box } }
          : { giver: { name: input.giver.name, envId: input.giver.envId }, box: { ...input.box }, generation: input.generation, lastSeq: 0, leaseUntil: null, since: this.now(), rows: [], grants: [] }
      )
      this.deps.sealEnvironmentKey?.(input.box.envId)
      givenHost.current = () => this.isGiven()
      this.log(`pinned ${input.giver.name} through ${input.box.envId}, generation ${input.generation}`)
    })
    this.deps.changed?.()
  }

  /**
   * A setup link that ended before Allow (cancelled, or its 15 minutes
   * passed): the pins go, and the state if no letter was ever applied. The
   * identity stays; nothing was given under it.
   */
  async abandon(): Promise<void> {
    await this.locked(async () => {
      const s = this.state()
      if (s && (s.lastSeq > 0 || s.rows.length > 0)) return
      try {
        this.pinsStore.clear()
      } catch {
        // a locked vault holds them still; a new pin replaces them
      }
      this.saveState(null)
    })
    this.deps.changed?.()
  }

  /** Boot: the host rule, an unfinished wipe resumed, deny-marked rows still in the vault dropped, the lease armed. */
  start(): void {
    givenHost.current = () => this.isGiven()
    const wipe = this.wipeJournal()
    if (wipe) {
      void this.wipe(wipe.removalId)
      return
    }
    void this.locked(async () => {
      const s = this.state()
      if (!s) return
      const stale = s.rows.filter((r) => this.denied(r))
      for (const r of stale) await this.dropRow(r)
      if (stale.length) {
        this.saveState({ ...s, rows: s.rows.filter((r) => !this.denied(r)), grants: s.grants.filter((g) => !this.denied(g)) })
        await this.deps.refreshNow()
        this.log(`${stale.length} given account${stale.length === 1 ? '' : 's'} dropped at start (a drop left unfinished)`)
      }
    }).catch((err) => this.log(`start: ${(err as Error).message}`))
    this.armLease()
  }

  // ── the link ───────────────────────────────────────────────────────────

  /** peer.register's `proof` on the box's link (MacBridge `proof`): the signature over the challenge's nonce; null on any other link. */
  async proofFor(envId: string, request: Request): Promise<string | null> {
    const pins = this.pins()
    if (!pins || pins.box.envId !== envId) return null
    const keyId = /^tc_([A-Za-z0-9_-]+)\./.exec(pins.boxKey)?.[1]
    if (!keyId) return null
    const { nonce } = await request<{ nonce: string }>('devices.challenge', {})
    if (typeof nonce !== 'string' || !nonce) throw new Error('the box sent no challenge')
    const payload = canonicalJson(peerProofPayload({ nonce, from: this.deps.environmentId, keyId }))
    return signBytes(this.deps.identity.keys().signPrivate, Buffer.from(payload))
  }

  /**
   * The window's ticket for the box: minted on this process's proved link (`devices.ticket`), so the
   * window's socket starts proved; the box refuses a device key's socket that never proved. Null for
   * any other environment.
   */
  windowTicket(envId: string): Promise<{ ticket: string; expiresIn: number }> | null {
    if (!this.isBox(envId)) return null
    const request = this.deps.link(envId)
    if (!request) return Promise.reject(new Error(`unavailable: the link to the box is not up yet`))
    return request<{ ticket: string; expiresIn: number }>('devices.ticket', {})
  }

  /** The box's link is up and registered: an owed ack goes, then the newest letter is read. */
  async linkUp(envId: string): Promise<void> {
    if (!this.isBox(envId)) return
    await this.sendAck().catch((err) => this.log(`ack not sent (${(err as Error).message})`))
    await this.readMail(envId)
  }

  /** A `device-mail` push from the box: read the letter now. True when the push was this module's. */
  onPeerPush(envId: string, push: ServerPush | { push: string }): boolean {
    if (push.push !== 'device-mail') return false
    if (this.isBox(envId)) void this.readMail(envId)
    return true
  }

  /** The box closed the link: its farewell code means this computer was removed. */
  onClose(envId: string, code: number): void {
    if (code !== FAREWELL_CLOSE || !this.isBox(envId)) return
    this.log('the box closed the link for farewell; reading the removal')
    void this.farewellMail()
  }

  async readMail(envId: string): Promise<void> {
    const request = this.deps.link(envId)
    if (!request) return
    try {
      const { letter } = await request<{ letter: Letter | null; removal?: { removalId: string } | null }>('devices.mail', {})
      if (letter) await this.apply(letter)
    } catch (err) {
      this.log(`mail not read (${(err as Error).message})`)
    }
  }

  // ── apply ──────────────────────────────────────────────────────────────

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => {})
    return run
  }

  /** Open and apply one letter under the lock; answers whether it was applied. A refusal is logged by seq and reason alone. */
  apply(letter: Letter): Promise<boolean> {
    return this.locked(() => this.applyLocked(letter))
  }

  private async applyLocked(letter: Letter): Promise<boolean> {
    const cur = this.current()
    const seq = typeof letter?.header?.seq === 'number' ? letter.header.seq : -1
    if (!cur) {
      this.log(`letter ${seq}: dropped (no giver pinned)`)
      return false
    }
    const keys = this.deps.identity.keys()
    const opened = openLetter(letter, {
      envId: this.deps.environmentId,
      sealPublic: keys.sealPublic,
      sealPrivate: keys.sealPrivate,
      generation: cur.pins.generation,
      giver: cur.pins.giver.signPublic,
      lastSeq: cur.state.lastSeq
    })
    if (!opened.ok) {
      this.log(`letter ${seq}: dropped (${opened.reason})`)
      // The same letter again after a crash between commit and ack: the ack is still owed.
      if (opened.reason === 'stale-seq' && cur.state.unacked?.seq === seq) await this.sendAck().catch(() => {})
      return false
    }
    const { header, body } = opened
    const generation = cur.pins.generation
    const stillCurrent = (): void => {
      const now = this.current()
      if (!now || now.pins.generation !== generation || now.pins.giver.signPublic !== cur.pins.giver.signPublic) throw new Superseded('superseded')
    }
    try {
      if (header.kind === 'remove') {
        const removalId = typeof body.extra?.removalId === 'string' ? body.extra.removalId : null
        if (!removalId) {
          this.log(`letter ${seq}: dropped (a removal with no id)`)
          return false
        }
        // Journaled before the seq moves: a restart finds the wipe, never a removal it already read and forgot.
        if (this.wipeJournal()?.removalId !== removalId) this.journal({ removalId, at: this.now(), step: 'drop' })
        this.saveState({ ...cur.state, lastSeq: header.seq, removalId })
        void this.wipe(removalId)
        return true
      }
      if (header.kind === 'activate') {
        const box = body.extra?.box as { envId?: unknown } | undefined
        if (box?.envId !== cur.pins.box.envId) {
          this.log(`letter ${seq}: dropped (an activation through another box)`)
          return false
        }
        // LifeOS's codes are saved before the seq is: a crash between them reads the same letter again (F20).
        this.deps.onApplied?.('activate', body.extra)
        this.saveState({ ...cur.state, lastSeq: header.seq, since: header.issuedAt, unacked: ackRef(header) })
        await this.sendAck()
        return true
      }
      const meta = (body.extra?.meta ?? {}) as Record<string, { name?: unknown; email?: unknown; nickname?: unknown; color?: unknown; createdAt?: unknown }>
      // A stop, and a manifest, are the whole truth: what is not in them goes.
      const offered = header.kind === 'manifest' ? body.accounts.filter((a) => GIVEN_SERVICES.has(a.service)) : []
      const accepted = offered.filter((a) => !this.ownMatch(a, cur.state.rows))
      const dropped = cur.state.rows.filter((r) => !accepted.some((a) => sameGrant(a, r) && a.kind === r.kind))
      // Each row's name is fixed before the vault moves, and the state lists every row the apply may
      // write as given: a crash mid-write never leaves one that reads as this computer's own.
      const planned: GivenRow[] = []
      for (const a of accepted) {
        const was = cur.state.rows.find((r) => sameGrant(r, a))
        const wanted = meta[rowKey(a)]?.name
        const also = planned.filter((p) => p.service === a.service).map((p) => p.name)
        planned.push({ service: a.service as ServiceId, account: a.account, kind: a.kind, name: was?.name ?? freeName(a.service as ServiceId, typeof wanted === 'string' && wanted ? wanted : a.account, also) })
      }
      // 1. Deny markers, before anything else moves.
      for (const r of dropped) this.deny(r, header.seq)
      const journaled = [...cur.state.rows, ...planned.filter((p) => !cur.state.rows.some((r) => r.service === p.service && r.name === p.name))]
      this.saveState({ ...cur.state, rows: journaled })
      stillCurrent()
      this.deps.crashAfter?.('deny')
      // 2. The vault.
      for (const r of dropped) await this.dropRow(r)
      const rows: GivenRow[] = []
      for (const [i, a] of accepted.entries()) {
        stillCurrent()
        rows.push(this.saveRow(a, planned[i].name, meta[rowKey(a)], cur.pins.box.envId))
        this.undeny(a)
      }
      await this.deps.refreshNow()
      this.dropping.clear()
      stillCurrent()
      this.deps.crashAfter?.('reconcile')
      // 3. Commit.
      const grants = accepted.map(grantOf)
      this.saveState({ ...cur.state, lastSeq: header.seq, leaseUntil: header.leaseUntil, since: header.issuedAt, rows, grants, unacked: ackRef(header) })
      this.deps.crashAfter?.('commit')
      this.log(`letter ${seq}: ${header.kind} applied (${rows.length} held, ${dropped.length} dropped)`)
      this.armLease()
      this.deps.changed?.()
      if (header.kind === 'manifest') this.deps.onApplied?.('manifest', body.extra)
      // 4. The ack, then the copies the box owns.
      await this.sendAck().catch((err) => this.log(`ack not sent (${(err as Error).message}); sent at the next link up`))
      if (rows.some((r) => r.kind === 'access' && !cur.state.rows.some((o) => sameGrant(o, r) && o.kind === 'access'))) void this.deps.pull?.(cur.pins.box.envId)
      return true
    } catch (err) {
      if (err instanceof Superseded) {
        this.log(`letter ${seq}: stopped (this computer's setup changed)`)
        return false
      }
      throw err
    } finally {
      this.dropping.clear()
    }
  }

  /** A grant whose account is already one of this computer's own rows: never applied over it. */
  private ownMatch(a: { service: string; account: string }, rows: readonly GivenRow[]): boolean {
    return safeProfiles(a.service as ServiceId).some((p) => p.accountId === a.account && (!rows.some((r) => r.service === a.service && r.name === p.name) || ownedHere(p)))
  }

  /** Save one given row: a static grant's secret, or an access grant's profile with the box as owner and no secret. */
  private saveRow(a: LetterAccount, name: string, meta: { email?: unknown; nickname?: unknown; color?: unknown; createdAt?: unknown } | undefined, boxEnvId: string): GivenRow {
    const service = a.service as ServiceId
    const existing = safeProfiles(service).find((p) => p.name === name)
    const kind = a.kind
    vault.upsertProfile(service, {
      ...(existing ?? {}),
      name,
      accountId: a.account,
      ...(typeof meta?.email === 'string' ? { email: meta.email } : {}),
      ...(typeof meta?.nickname === 'string' ? { nickname: meta.nickname } : {}),
      ...(typeof meta?.color === 'string' ? { color: meta.color } : {}),
      createdAt: typeof meta?.createdAt === 'number' ? meta.createdAt : (existing?.createdAt ?? this.now()),
      ...(kind === 'static' ? { static: true, owner: undefined } : { static: undefined, owner: a.owner ?? boxEnvId }),
      syncedAt: this.now()
    })
    if (kind === 'static' && a.secret) vault.saveSecret(service, name, a.secret, 'sync')
    return { service, account: a.account, name, kind }
  }

  /** The drop sequence for one given row: refuse new turns, end its handles, delete it, clear the gateway's cache, delete its tagged files. */
  private async dropRow(r: GivenRow): Promise<void> {
    // A sign-in made here since landed on the row: it is this computer's own now, and stays (F15).
    if (takenOver(r)) {
      this.log(`${r.service} ${r.name}: signed in on this computer since it was given; kept as its own`)
      this.deps.dropFiles?.(r.service, r.name)
      return
    }
    const provider = PROVIDER_OF[r.service]
    this.dropping.add(`${r.service}:${r.name}`)
    this.deps.changed?.()
    if (provider) await this.deps.endHandles?.(provider, r.name)
    // By the recorded name alone: a repair that relabelled the row's account must not leave it behind as an own row.
    if (safeProfiles(r.service).some((p) => p.name === r.name)) {
      vault.deleteProfile(r.service, r.name)
      try {
        coreAccounts.clearUsageCache(r.service)
      } catch {
        // no usage cache yet
      }
    }
    this.deps.clearGatewayCache?.(r.service)
    this.deps.dropFiles?.(r.service, r.name)
  }

  /** Every given row goes, each with its deny marker, and every tagged file. */
  private async dropAll(seq: number): Promise<void> {
    const s = this.state()
    const rows = s?.rows ?? []
    for (const r of rows) this.deny(r, seq)
    for (const r of rows) await this.dropRow(r)
    for (const service of GIVEN_SERVICES) this.deps.dropFiles?.(service as ServiceId, null)
    if (s) this.saveState({ ...s, rows: [], grants: [] })
    await this.deps.refreshNow()
    this.dropping.clear()
  }

  /** The signed ack of the newest letter applied, when the box has not taken it yet. */
  async sendAck(): Promise<boolean> {
    const cur = this.current()
    const owed = cur?.state.unacked
    if (!cur || !owed) return false
    const request = this.deps.link(cur.pins.box.envId)
    if (!request) return false
    const fields: Omit<DeviceAck, 'signature'> = {
      envId: this.deps.environmentId,
      letterId: owed.letterId,
      seq: owed.seq,
      digest: owed.digest,
      holds: cur.state.rows.slice(0, ACK_CAP).map((r) => ({ service: r.service, account: r.account })),
      own: this.own(cur.state.rows).slice(0, ACK_CAP),
      ...(this.paused() ? { paused: true } : {}),
      at: this.now()
    }
    const ack: DeviceAck = { ...fields, signature: signBytes(this.deps.identity.keys().signPrivate, Buffer.from(canonicalJson(fields))) }
    await request('devices.ack', { ack })
    const after = this.state()
    if (after?.unacked?.seq === owed.seq) this.saveState({ ...after, unacked: undefined })
    return true
  }

  // ── the lease ──────────────────────────────────────────────────────────

  private armLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = null
    const until = this.state()?.leaseUntil
    if (until === null || until === undefined || this.closed) return
    const wait = until - this.now()
    if (wait < 0) return
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null
      // A lease past the longest timer wakes early: wait again for its real end (F13).
      if (!this.paused()) return this.armLease()
      this.log('the lease ran out; given accounts paused until the giver is in touch')
      this.deps.changed?.()
      void this.sendAck().catch(() => {})
    }, Math.min(wait + 1, TIMER_MAX))
    this.leaseTimer.unref?.()
  }

  // ── remove ─────────────────────────────────────────────────────────────

  private wipeJournal(): Wipe | null {
    const raw = this.deps.store.getSetting(WIPE_SETTING)
    if (!raw) return null
    try {
      const w = JSON.parse(raw) as Wipe
      return typeof w?.removalId === 'string' ? w : null
    } catch {
      return null
    }
  }

  private journal(w: Wipe | null): void {
    this.deps.store.setSetting(WIPE_SETTING, w ? JSON.stringify(w) : null)
  }

  /**
   * The box refused this computer's key at /api/ticket (403: in farewell; 401: ended). Remove may
   * have been pressed while this computer was away and no socket was open to close: ask the
   * farewell route, which answers "not in farewell" when there is nothing to do.
   */
  onRefused(envId: string): void {
    if (!this.isBox(envId) || !this.activated()) return
    void this.farewellMail()
  }

  /** A letter was applied under these pins: the setup passed Allow (a pending key's refusal means nothing). */
  private activated(): boolean {
    const s = this.current()?.state
    return !!s && (s.lastSeq > 0 || s.rows.length > 0)
  }

  /**
   * The removal through /api/farewell: its letter applied, or, while the box holds no letter, the
   * wipe started on the removal id it names. A key the box no longer takes (401) is a removal whose
   * receipt can no longer be recorded: the wipe runs all the same. "Not in farewell" (403, 404) ends
   * the ask; anything else is retried.
   */
  async farewellMail(): Promise<void> {
    const pins = this.pins()
    if (!pins || this.wipeJournal() || this.farewelling) return
    this.farewelling = true
    try {
      const res = await this.farewell(pins, { op: 'mail' })
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { letter?: Letter | null; removal?: { removalId?: unknown } | null } | null
        if (body?.letter && (await this.apply(body.letter))) return
        const removalId = body?.removal?.removalId
        if (typeof removalId === 'string' && removalId) return void this.startWipe(removalId)
      } else {
        await res.body?.cancel()
        if (res.status === 401 && this.activated()) {
          this.log('the box no longer takes this key; wiping what the setup gave')
          return void this.startWipe(this.state()?.removalId ?? 'ended')
        }
        if (res.status === 401 || res.status === 403 || res.status === 404) return
      }
    } catch (err) {
      this.log(`farewell mail not read (${(err as Error).message})`)
    } finally {
      this.farewelling = false
    }
    if (this.closed || this.farewellRetry) return
    this.farewellRetry = setTimeout(() => {
      this.farewellRetry = null
      void this.farewellMail()
    }, RECEIPT_BACKOFF_MS[1])
    this.farewellRetry.unref?.()
  }

  /** Journal a removal and run the wipe (a letter that never came, or a key the box ended). */
  private startWipe(removalId: string): void {
    if (this.wipeJournal()?.removalId !== removalId) this.journal({ removalId, at: this.now(), step: 'drop' })
    void this.wipe(removalId)
  }

  private farewell(pins: Pins, body: unknown): Promise<Response> {
    return (this.deps.fetch ?? fetch)(`${pins.box.origin.replace(/\/+$/, '')}/api/farewell`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pins.boxKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error'
    })
  }

  /** Remove: every step journaled, so a restart picks it up where it stopped. */
  wipe(removalId: string): Promise<void> {
    if (this.wiping) return this.wiping
    const run = this.locked(() => this.wipeLocked(removalId)).finally(() => {
      if (this.wiping === run) this.wiping = null
    })
    this.wiping = run
    return run
  }

  private async wipeLocked(removalId: string): Promise<void> {
    let w = this.wipeJournal()
    if (!w || w.removalId !== removalId) {
      w = { removalId, at: this.now(), step: 'drop' }
      this.journal(w)
    }
    if (w.step === 'drop') {
      this.log('removed: wiping what the setup gave')
      const parts: [string, () => unknown][] = [
        ['setup steps', () => this.deps.haltSetup?.()],
        ['accounts', () => this.dropAll(this.state()?.lastSeq ?? 0)],
        ['LifeOS token', () => this.deps.clearLifeosToken?.()],
        ['setup folders', () => this.deps.removeSetupFolders?.()],
        ["LifeOS's reader", () => this.deps.lifeosReaderOff?.()]
      ]
      // Each part journaled once it succeeds; a part that fails stops the wipe short of the receipt, and it runs again.
      for (const [what, fn] of parts) {
        if (w.done?.includes(what)) continue
        try {
          await fn()
        } catch (err) {
          this.log(`removed: ${what} not cleared (${(err as Error).message}); tried again before the receipt`)
          this.retryWipe(removalId)
          return
        }
        this.journal((w = { ...w, done: [...(w.done ?? []), what] }))
      }
      this.journal((w = { ...w, step: 'receipt' }))
    }
    if (w.step === 'receipt') {
      await this.postReceipt(removalId)
      this.journal((w = { ...w, step: 'forget' }))
    }
    this.forget()
    this.journal(null)
    this.log('removed: the box, the giver and this identity are forgotten')
  }

  private wipeRetry: ReturnType<typeof setTimeout> | null = null

  /** A wipe part that failed runs again in a minute, and at the next start. */
  private retryWipe(removalId: string): void {
    if (this.wipeRetry || this.closed) return
    this.wipeRetry = setTimeout(() => {
      this.wipeRetry = null
      void this.wipe(removalId)
    }, WIPE_RETRY_MS)
    this.wipeRetry.unref?.()
  }

  /** The signed receipt, posted until the box records it. A box that no longer takes the key (it ended it) counts as recorded. */
  private async postReceipt(removalId: string): Promise<void> {
    const pins = this.pins()
    if (!pins) return
    const signature = signBytes(this.deps.identity.keys().signPrivate, Buffer.from(canonicalJson(farewellPayload({ removalId, envId: this.deps.environmentId }))))
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()))
    for (let attempt = 0; !this.closed; attempt++) {
      try {
        const res = await this.farewell(pins, { op: 'receipt', removalId, signature })
        const body = (await res.json().catch(() => null)) as { ok?: boolean } | null
        if (res.ok && body?.ok !== false) return
        if (res.status === 401 || res.status === 403) {
          this.log(`removed: the box no longer takes this key (${res.status}); the receipt is moot`)
          return
        }
        this.log(`removed: the receipt was not recorded (HTTP ${res.status}); trying again`)
      } catch (err) {
        this.log(`removed: the receipt did not reach the box (${(err as Error).message}); trying again`)
      }
      await sleep(RECEIPT_BACKOFF_MS[Math.min(attempt, RECEIPT_BACKOFF_MS.length - 1)])
    }
  }

  /** The last of Remove and of Start fresh: the box environment, the pins, the identity, every marker. */
  private forget(): void {
    // After Start fresh the pins went with the old vault; the state still names the box.
    const boxEnvId = this.pins()?.box.envId ?? this.state()?.box.envId
    if (boxEnvId) {
      try {
        this.deps.removeEnvironment?.(boxEnvId)
      } catch (err) {
        this.log(`the box environment was not removed (${(err as Error).message})`)
      }
    }
    try {
      this.pinsStore.clear()
    } catch {
      // a vault set aside holds them no longer
    }
    try {
      this.deps.identity.retire()
    } catch {
      // the same
    }
    for (const key of this.denyMarkers()) this.deps.store.setSetting(key, null)
    this.saveState(null)
    try {
      this.deps.forgetSetup?.()
    } catch (err) {
      this.log(`setup's progress was not cleared (${(err as Error).message})`)
    }
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = null
    this.deps.changed?.()
  }

  /**
   * Start fresh on a locked vault (aliaxPages.ts vaultStartFreshHooks): the
   * pins, the box key and the identity went with the old vault, so this
   * computer is no longer given: the rows' state, markers and tagged files go
   * and the identity is retired. No receipt: no key is left to sign it with.
   */
  startFresh(): void {
    // Setup's progress goes with the pins whether or not anything was given yet (F23).
    try {
      this.deps.forgetSetup?.()
    } catch (err) {
      this.log(`setup's progress was not cleared (${(err as Error).message})`)
    }
    if (!this.state() && !this.wipeJournal()) return
    for (const service of GIVEN_SERVICES) this.deps.dropFiles?.(service as ServiceId, null)
    this.journal(null)
    this.forget()
    this.log('start fresh: this computer is no longer given')
  }

  close(): void {
    this.closed = true
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    if (this.farewellRetry) clearTimeout(this.farewellRetry)
    this.leaseTimer = this.farewellRetry = null
  }
}

const grantOf = (a: LetterAccount): Grant => ({ service: a.service, account: a.account, kind: a.kind, ...(a.owner ? { owner: a.owner } : {}) })

const ackRef = (header: LetterHeader): { letterId: string; seq: number; digest: string } => ({
  letterId: header.id,
  seq: header.seq,
  digest: createHash('sha256').update(canonicalJson(header)).digest('hex')
})

function safeProfiles(service: ServiceId): ReturnType<typeof vault.profiles> {
  try {
    return vault.profiles(service)
  } catch {
    return []
  }
}

/** The giver's name for the row, or one free of every row already here (an own row by that name stays its own). */
/** A name no row holds in any case: on Windows the vault's files are one file for names that differ only by case (F15). */
function freeName(service: ServiceId, wanted: string, also: readonly string[] = []): string {
  const taken = new Set([...safeProfiles(service).map((p) => p.name), ...also].map((n) => n.toLowerCase()))
  if (!taken.has(wanted.toLowerCase())) return wanted
  for (let i = 2; ; i++) if (!taken.has(`${wanted} (${i})`.toLowerCase())) return `${wanted} (${i})`
}

/**
 * A profile this computer refreshes itself. A given row is never one: a static grant is static and an
 * access copy is owned by the box. A local sign-in that matched the row's account turns it into one.
 */
const ownedHere = (p: { static?: boolean; owner?: string | null }): boolean => !p.static && ownsProfile(p as Parameters<typeof ownsProfile>[0])

/** A given row a local sign-in has since taken over (F15). */
function takenOver(r: GivenRow): boolean {
  const p = safeProfiles(r.service).find((x) => x.name === r.name)
  return !!p && ownedHere(p)
}

function splitOnce(key: string): [string, string] {
  const i = key.indexOf(':')
  return [key.slice(0, i), key.slice(i + 1)]
}

/**
 * Remove's two steps that belong to later parts of setup, filled by them: the folders setup added to
 * Files (its ledger, M6) and LifeOS's Outlook and Teams reader (`read: false` in its purdue.json, M5).
 * Unset, the step is skipped.
 */
export const givenSetupHooks: { removeSetupFolders?: () => Promise<void> | void; lifeosReaderOff?: () => Promise<void> | void } = {}

/** The running instance, for the vault's Start fresh hook (src/main/index.ts). */
export const givenComputerHooks: { current: GivenComputer | null } = { current: null }
