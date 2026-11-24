import { randomBytes } from 'node:crypto'
import type { ServiceId } from 'aliax-core'
import type { StoredProfile } from 'aliax-core/vault'
import { hasRefresh } from 'aliax-core/sync'
import { LEASE_MS, type DeviceIdentity } from '@shared/contract-devices'
import { sealLetter, type Grant, type Letter, type LetterAccount, type LetterHeader, type LetterKind } from '@shared/devices/envelope'
import type { DeviceKeys } from '@shared/devices/keys'

/**
 * The giver's side of given computers (docs/agents/pc-setup.md): which
 * computers it set up, and the letters that tell each what it may hold.
 *
 * A manifest is the whole truth for a computer: every account the giver can
 * give, by service, canonical id and kind. A static grant (a Claude one-year
 * token, Muse's login, a Meta key) rides the sealed body; Codex, owned by
 * the box, rides as an admission alone and its access copy comes from the
 * box. A grant this Mac refreshes itself is not given (no computer could
 * reach it to refresh), nor is Cursor, nor an add-on grant. Ticking "His
 * accounts" means all of them, later ones too, so a manifest goes on every
 * vault write or delete, an owner or home change, the box link coming up,
 * once a day while online, and on Retry. `seq` rises on every letter.
 */

export const COMPUTERS_SETTING = 'devices.computers'
const GIVEN_SERVICES: readonly ServiceId[] = ['claude-code', 'codex', 'meta', 'muse-code']
/** Services whose every profile is a static grant, whatever the row says (aliax-core treats them so). */
const ALWAYS_STATIC: ReadonlySet<ServiceId> = new Set(['meta', 'muse-code'])
export const RESIGN_MS = 24 * 3_600_000

export interface GivenComputer {
  envId: string
  name: string
  identity: DeviceIdentity
  generation: number
  /** The last letter's seq; the next is one more. */
  seq: number
  state: 'active' | 'stopped' | 'removing'
  /** What the setup link gave: accounts at all. */
  accounts: boolean
  removalId?: string
  /** LifeOS enrollments the setup made for it, revoked by Remove (setup/lifeosEnroll.ts). */
  enrollments?: string[]
  lastPostAt?: number
  lastError?: string | null
}

export interface ManifestSource {
  profiles: (service: ServiceId) => StoredProfile[]
  readSecret: (service: ServiceId, name: string) => string | null
}

/** What the manifest gives, and what it cannot (a grant this Mac refreshes itself). */
export function grantsFor(source: ManifestSource, boxEnvId: string): { accounts: LetterAccount[]; meta: Record<string, unknown>; withheld: { service: string; account: string }[] } {
  const accounts: LetterAccount[] = []
  const meta: Record<string, unknown> = {}
  const withheld: { service: string; account: string }[] = []
  for (const service of GIVEN_SERVICES) {
    for (const p of source.profiles(service)) {
      const isStatic = !!p.static || ALWAYS_STATIC.has(service)
      if (isStatic) {
        let secret: string | null = null
        try {
          secret = source.readSecret(service, p.name)
        } catch {
          secret = null
        }
        // A blob with a refresh token is never given, whatever its row says.
        if (!secret || hasRefresh(service, secret)) {
          withheld.push({ service, account: p.accountId })
          continue
        }
        accounts.push({ service, account: p.accountId, kind: 'static', secret })
      } else if (p.owner === boxEnvId) {
        accounts.push({ service, account: p.accountId, kind: 'access', owner: boxEnvId })
      } else {
        withheld.push({ service, account: p.accountId })
        continue
      }
      meta[`${service}:${p.accountId}`] = { name: p.name, email: p.email, nickname: p.nickname, color: p.color, createdAt: p.createdAt }
    }
  }
  return { accounts, meta, withheld }
}

const grantOf = (a: LetterAccount): Grant => ({ service: a.service, account: a.account, kind: a.kind, ...(a.owner ? { owner: a.owner } : {}) })

export interface LetterInput {
  computer: GivenComputer
  giver: DeviceKeys
  kind: LetterKind
  seq: number
  now: number
  accounts?: LetterAccount[]
  extra?: Record<string, unknown>
}

export function letterFor(input: LetterInput): Letter {
  const accounts = input.accounts ?? []
  const header: LetterHeader = {
    v: 1,
    id: randomBytes(12).toString('base64url'),
    kind: input.kind,
    to: input.computer.envId,
    toKey: input.computer.identity.sealPublic,
    generation: input.computer.generation,
    from: input.giver.signPublic,
    seq: input.seq,
    issuedAt: input.now,
    leaseUntil: input.kind === 'manifest' ? input.now + LEASE_MS : null,
    grants: accounts.map(grantOf)
  }
  return sealLetter(header, { kind: input.kind, seq: input.seq, accounts, ...(input.extra ? { extra: input.extra } : {}) }, input.giver.signPrivate)
}

export interface GiverDevicesDeps {
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  keys: () => DeviceKeys
  source: ManifestSource
  /** The box this Mac gives through, or null while it has none. */
  box: () => { envId: string; request<T>(method: string, params?: unknown): Promise<T> } | null
  now?: () => number
  log?: (line: string) => void
  /** A computer's list changed (a post, a state): the Computers group redraws. */
  changed?: () => void
}

export class GiverDevices {
  private chain: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private daily: NodeJS.Timeout | null = null

  constructor(private readonly deps: GiverDevicesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[devices] ${l}`)))(line)
  }

  list(): GivenComputer[] {
    try {
      const raw = this.deps.store.getSetting(COMPUTERS_SETTING)
      return raw ? (JSON.parse(raw) as GivenComputer[]) : []
    } catch {
      return []
    }
  }

  private save(list: GivenComputer[]): void {
    this.deps.store.setSetting(COMPUTERS_SETTING, list.length ? JSON.stringify(list) : null)
    this.deps.changed?.()
  }

  private update(envId: string, patch: Partial<GivenComputer>): GivenComputer | null {
    const list = this.list()
    const i = list.findIndex((c) => c.envId === envId)
    if (i < 0) return null
    list[i] = { ...list[i], ...patch }
    this.save(list)
    return list[i]
  }

  /** A computer the giver just allowed (setup's Allow): kept, then its activate letter and first manifest go. */
  add(computer: Omit<GivenComputer, 'seq' | 'state'>): GivenComputer {
    const list = this.list().filter((c) => c.envId !== computer.envId)
    const row: GivenComputer = { ...computer, seq: 0, state: 'active' }
    this.save([...list, row])
    return row
  }

  /** One letter to one computer, in order with every other: the seq is taken and saved before the post. */
  private send(envId: string, kind: LetterKind, build: (c: GivenComputer) => Pick<LetterInput, 'accounts' | 'extra'>): Promise<boolean> {
    const run = this.chain.then(async () => {
      const c = this.list().find((x) => x.envId === envId)
      const box = this.deps.box()
      if (!c || !box) return false
      const seq = c.seq + 1
      const letter = letterFor({ computer: c, giver: this.deps.keys(), kind, seq, now: this.now(), ...build(c) })
      this.update(envId, { seq })
      try {
        await box.request('devices.post', { letter })
        this.update(envId, { lastPostAt: this.now(), lastError: null })
        return true
      } catch (err) {
        this.update(envId, { lastError: (err as Error).message })
        this.log(`${c.name}: ${kind} ${seq} not posted (${(err as Error).message})`)
        return false
      }
    })
    this.chain = run.catch(() => {})
    return run
  }

  activate(envId: string, extra: Record<string, unknown>): Promise<boolean> {
    return this.send(envId, 'activate', () => ({ extra }))
  }

  /** The whole truth for one computer now: what it may hold, or nothing while stopped or without accounts. */
  manifest(envId: string): Promise<boolean> {
    const c = this.list().find((x) => x.envId === envId)
    if (!c || c.state === 'removing') return Promise.resolve(false)
    if (c.state === 'stopped') return Promise.resolve(false)
    const box = this.deps.box()
    if (!box) return Promise.resolve(false)
    return this.send(envId, 'manifest', (cur) => {
      if (!cur.accounts) return { accounts: [], extra: { meta: {} } }
      const g = grantsFor(this.deps.source, box.envId)
      return { accounts: g.accounts, extra: { meta: g.meta } }
    })
  }

  /** Every active computer, soon: the vault changed, an owner or home moved, the box link came up. */
  manifestAllSoon(delayMs = 2_000): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.manifestAll()
    }, delayMs)
    this.timer.unref?.()
  }

  async manifestAll(): Promise<void> {
    for (const c of this.list()) if (c.state === 'active') await this.manifest(c.envId)
  }

  /** The daily re-sign, so a computer's lease never runs out while this Mac is online. */
  startDaily(): void {
    if (this.daily) return
    this.daily = setInterval(() => void this.manifestAll(), RESIGN_MS)
    this.daily.unref?.()
  }

  stopDaily(): void {
    if (this.daily) clearInterval(this.daily)
    if (this.timer) clearTimeout(this.timer)
    this.daily = this.timer = null
  }

  /** Stop: the accounts come off at its next contact; the link stays. Start again sends a fresh manifest. */
  async stop(envId: string): Promise<boolean> {
    if (!this.update(envId, { state: 'stopped' })) return false
    return this.send(envId, 'stop', () => ({}))
  }

  async start(envId: string): Promise<boolean> {
    if (!this.update(envId, { state: 'active' })) return false
    return this.manifest(envId)
  }

  /**
   * Remove: the box puts the key in farewell and retires the binding; the
   * `remove` letter tells the computer to wipe what the link gave and sign
   * its receipt. `revokeLifeos` ends the LifeOS sessions the setup made.
   */
  async remove(envId: string, revokeLifeos?: (enrollment: string) => Promise<void>): Promise<string | null> {
    const c = this.list().find((x) => x.envId === envId)
    const box = this.deps.box()
    if (!c || !box) return null
    const { removalId } = await box.request<{ removalId: string }>('devices.remove', { envId })
    this.update(envId, { state: 'removing', removalId })
    await this.send(envId, 'remove', () => ({ extra: { removalId } }))
    for (const e of c.enrollments ?? []) await revokeLifeos?.(e).catch((err) => this.log(`${c.name}: LifeOS enrollment not revoked (${(err as Error).message})`))
    return removalId
  }

  /** The box retired it (its receipt, or 30 days): it leaves the list. */
  forget(envId: string): void {
    this.save(this.list().filter((c) => c.envId !== envId))
  }
}
