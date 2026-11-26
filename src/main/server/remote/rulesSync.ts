import type { HostFeature } from '@shared/capabilities'
import type { ServerPush, SettingsHome } from '@shared/contract'
import type { WorkspaceMeta } from '@shared/domain'
import { ThreadDefaultsSchema, type ThreadDefaults } from '@shared/defaults'
import { PlanSettingsSchema, type PlanSettings } from '@shared/plans'
import { headlessOf, settingsHomeOf, type HostBuild } from '@shared/projectLinks'
import { ReviewSettingsSchema, type ReviewSettings } from '@shared/review'
import { OrchestrationRulesSchema, type OrchestrationRules } from '@shared/rules'
import type { Peers } from './peers'

/**
 * Rules, thread defaults, global Plans and global Reviews live on the box
 * (`settingsHomeOf`). Rules and defaults also sync linked workspaces
 * (paired by `linkId`). Project Plans and Reviews ride projectSettingsSync.
 * This runs on the host holding the admin peer link (the Mac):
 *
 *  - follows: on link-up, on the home's `workspaces` push (the box re-sends
 *    it whenever a synced setting changes) and every 5 minutes, it reads the
 *    home's value of every scope and writes it here when it differs.
 *  - seeds once: a scope this host has never synced with the home takes THIS
 *    host's value onto the home first, but only where the home holds none of
 *    its own (the person edited the rules on the Mac before there was one
 *    copy). A home that has its own copy keeps it and this host follows, so
 *    a fresh PC's defaults never write over the box's (`seed`). The home owns
 *    it from then on.
 *  - routes writes (`forward`): a write for a shared scope goes to the
 *    home and its value is written back here. A home out of reach refuses
 *    with nothing written. A workspace with no copy on
 *    the home stays this host's own. A pull whose read started before a
 *    forward never writes its older answer over the forward's (`writes`).
 *  - exchanges catalogs: on every pull, with every linked host, this host's
 *    visible catalog for the peer's (`catalog.exchange`, peerCatalogs.ts).
 *    One copy of the rules is not enough on its own: each host runs only
 *    what its own CLIs serve (the box has no Muse Code rows), so a host
 *    spawns and lists another's approved models only once it knows them.
 *  - says where a scope lives (`homeFor`): the getter answers it. An older
 *    box keeps Plans and Reviews local until it advertises support.
 */

export const RULES_SYNC_PERIOD_MS = 5 * 60_000
export const RULES_SYNC_DEBOUNCE_MS = 500
export const PEER_KEY = 'rules-sync:peer:'
export const SEEDED_KEY = 'rules-sync:seeded:'

interface PeerRecord {
  platform: string | null
  /** headlessOf the peer's last hello; absent from a record older than the field */
  headless?: boolean | null
  workspaces: { id: string; linkId: string }[]
  features?: readonly string[]
}

type Link = NonNullable<ReturnType<Peers['get']>>

export interface RulesSyncDeps {
  environmentId: string
  platform: string
  /** This host runs headless (buildInfo.ts hostHeadless); absent, `platform` decides as for an older build. */
  headless?: boolean
  registry: {
    listWorkspaces(): WorkspaceMeta[]
    getOrchestrationRules(workspaceId: string | null): OrchestrationRules | null
    setOrchestrationRules(workspaceId: string | null, rules: OrchestrationRules | null): void
    getThreadDefaults(workspaceId: string | null): ThreadDefaults | null
    setThreadDefaults(workspaceId: string | null, defaults: ThreadDefaults | null): void
    getPlanSettings(projectId: string | null): PlanSettings | null
    setPlanSettings(projectId: string | null, settings: PlanSettings | null): void
    getReviewSettings(projectId: string | null): ReviewSettings | null
    setReviewSettings(projectId: string | null, settings: ReviewSettings | null): void
  }
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  peers: Pick<Peers, 'get' | 'all'>
  /** This host's visible catalog, and where the peers' land (peerCatalogs.ts). */
  catalog?: () => unknown
  peerCatalogs?: { set(environmentId: string, catalog: unknown): boolean }
  log?: (line: string) => void
}

/** One synced setting: its RPCs, the field it rides in and this host's store. */
interface Kind {
  get: 'rules.get' | 'defaults.get' | 'plans.get' | 'review.get'
  set: 'rules.set' | 'defaults.set' | 'plans.set' | 'review.set'
  field: 'rules' | 'defaults' | 'settings'
  /** Feature-gated kinds sync the global project scope alone. */
  feature?: HostFeature
  stored(answer: Record<string, unknown>): unknown
  parse(value: unknown): unknown
  read(workspaceId: string | null): unknown
  write(workspaceId: string | null, value: unknown): void
}

/** A shared scope: the global set, or a workspace both hosts hold. */
export interface Scope {
  key: string
  local: string | null
  peer: string | null
}

export class RulesSync {
  private readonly kinds: Kind[]
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private period: NodeJS.Timeout | null = null
  private closed = false
  /** A pull started before a write to its scope never replaces that write. */
  private readonly writes = new Map<string, number>()
  private readonly unexchanged = new Set<string>()
  /** A fresh hello can restore a feature a previous socket refused. */
  private readonly unsupported = new WeakMap<readonly string[], Set<string>>()

  constructor(private readonly deps: RulesSyncDeps) {
    const r = deps.registry
    this.kinds = [
      {
        get: 'rules.get',
        set: 'rules.set',
        field: 'rules',
        stored: (v) => v.overridden ? v.rules : null,
        parse: (v) => OrchestrationRulesSchema.nullable().parse(v),
        read: (ws) => r.getOrchestrationRules(ws),
        write: (ws, v) => r.setOrchestrationRules(ws, v as OrchestrationRules | null)
      },
      {
        get: 'defaults.get',
        set: 'defaults.set',
        field: 'defaults',
        stored: (v) => v.overridden ? v.defaults : null,
        parse: (v) => ThreadDefaultsSchema.nullable().parse(v),
        read: (ws) => r.getThreadDefaults(ws),
        write: (ws, v) => r.setThreadDefaults(ws, v as ThreadDefaults | null)
      },
      {
        get: 'plans.get',
        set: 'plans.set',
        field: 'settings',
        feature: 'rulesSync.plans',
        stored: (v) => v.overridden ? v.settings : null,
        parse: (v) => PlanSettingsSchema.nullable().parse(v),
        read: () => r.getPlanSettings(null),
        write: (_, v) => r.setPlanSettings(null, v as PlanSettings | null)
      },
      {
        get: 'review.get',
        set: 'review.set',
        field: 'settings',
        feature: 'rulesSync.review',
        stored: (v) => v.global,
        parse: (v) => ReviewSettingsSchema.nullable().parse(v),
        read: () => r.getReviewSettings(null),
        write: (_, v) => r.setReviewSettings(null, v as ReviewSettings | null)
      }
    ]
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[rules-sync] ${l}`)))(line)
  }

  start(): void {
    if (this.period || this.closed) return
    this.period = setInterval(() => {
      for (const link of this.deps.peers.all()) this.schedule(link.id)
    }, RULES_SYNC_PERIOD_MS)
    this.period.unref?.()
  }

  close(): void {
    this.closed = true
    if (this.period) clearInterval(this.period)
    this.period = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  linkUp(id: string): void {
    this.schedule(id)
  }

  /** The peer's `workspaces` push: follow it. Never consumes the push. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push === 'workspaces') this.schedule(from)
    return false
  }

  /** This host's catalog moved (a probe landed): every linked host hears it. */
  catalogChanged(): void {
    for (const link of this.deps.peers.all()) this.schedule(link.id)
  }

  schedule(id: string): void {
    if (this.closed) return
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.syncWith(id)
    }, RULES_SYNC_DEBOUNCE_MS)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  syncWith(id: string): Promise<void> {
    const live = this.running.get(id)
    if (live) {
      this.again.add(id)
      return live
    }
    const run = (async () => {
      try {
        do {
          this.again.delete(id)
          await this.pull(id)
        } while (this.again.has(id) && !this.closed)
      } catch (err) {
        this.log(`${this.deps.peers.get(id)?.env.name ?? id}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        this.running.delete(id)
      }
    })()
    this.running.set(id, run)
    return run
  }

  private async pull(id: string): Promise<void> {
    const link = this.deps.peers.get(id)
    if (!link?.connected) return
    this.remember(link, await link.request<WorkspaceMeta[]>('workspace.list'))
    await this.exchangeCatalogs(link)
    if (this.homeOf() !== id) return
    const seededScopes = new Set(this.seeded(id))
    for (const scope of this.sharedScopes(id)) {
      const seeded = seededScopes.has(scope.key)
      let completed = true
      for (const kind of this.kinds) {
        if (kind.feature) {
          if (scope.local === null && this.supports(link, kind)) await this.syncGlobal(link, kind, scope)
        } else if (seeded) {
          await this.follow(link, kind, scope)
        } else if (!(await this.seed(link, kind, scope))) {
          completed = false
        }
      }
      if (!seeded && completed) this.markSeeded(link, scope.key)
    }
  }

  private async syncGlobal(link: Link, kind: Kind, scope: Scope): Promise<void> {
    const key = kind.get
    try {
      if (this.seeded(link.id).includes(key)) await this.follow(link, kind, scope)
      else if (await this.seed(link, kind, scope)) this.markSeeded(link, key)
    } catch (err) {
      if (!this.markUnsupported(link, kind, err)) throw err
    }
  }

  private params(kind: Kind, scope: Scope): Record<string, string | null> {
    return kind.feature ? { projectId: null } : { workspaceId: scope.peer }
  }

  private writeKey(kind: Kind, scope: Scope): string {
    return `${kind.get}:${scope.local ?? ''}`
  }

  /** A scope's first sync: the box's set wins. An empty box takes this host's set once. */
  private async seed(link: Link, kind: Kind, scope: Scope): Promise<boolean> {
    const key = this.writeKey(kind, scope)
    const before = this.writes.get(key)
    const res = await link.request<Record<string, unknown>>(kind.get, this.params(kind, scope))
    if (this.writes.get(key) !== before) return false
    const theirs = kind.parse(kind.stored(res))
    if (theirs !== null) this.apply(link, kind, scope, theirs)
    else {
      const mine = kind.read(scope.local)
      if (mine !== null) await link.request(kind.set, { ...this.params(kind, scope), [kind.field]: mine })
    }
    return true
  }

  /** A pull that read before a forward never replaces its answer. */
  private async follow(link: Link, kind: Kind, scope: Scope): Promise<void> {
    const key = this.writeKey(kind, scope)
    const before = this.writes.get(key)
    const res = await link.request<Record<string, unknown>>(kind.get, this.params(kind, scope))
    if (this.writes.get(key) !== before) return
    this.apply(link, kind, scope, kind.parse(kind.stored(res)))
  }

  private apply(link: Link, kind: Kind, scope: Scope, theirs: unknown): void {
    if (JSON.stringify(theirs) === JSON.stringify(kind.read(scope.local))) return
    kind.write(scope.local, theirs)
    this.log(`${link.env.name}: followed ${kind.get} for ${scope.key}`)
  }

  /** This host's catalog for the peer's; a peer that predates the exchange keeps none. */
  private async exchangeCatalogs(link: Link): Promise<void> {
    const { catalog, peerCatalogs } = this.deps
    if (!catalog || !peerCatalogs) return
    try {
      const res = await link.request<{ catalog: unknown }>('catalog.exchange', { from: this.deps.environmentId, catalog: catalog() })
      if (peerCatalogs.set(link.id, res.catalog)) this.log(`${link.env.name}: its catalog changed`)
    } catch (err) {
      // Said once per host and boot: an older build answers every pull the same.
      if (this.unexchanged.has(link.id)) return
      this.unexchanged.add(link.id)
      this.log(`${link.env.name}: no catalog exchange (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  // ── the home ────────────────────────────────────────────────────────

  private record(id: string): PeerRecord | null {
    const raw = this.deps.store.getSetting(`${PEER_KEY}${id}`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as PeerRecord
    } catch {
      return null
    }
  }

  private seeded(id: string): string[] {
    try {
      return JSON.parse(this.deps.store.getSetting(`${SEEDED_KEY}${id}`) ?? '[]') as string[]
    } catch {
      return []
    }
  }

  private markSeeded(link: Link, key: string): void {
    const seeded = this.seeded(link.id)
    if (seeded.includes(key)) return
    this.deps.store.setSetting(`${SEEDED_KEY}${link.id}`, JSON.stringify([...seeded, key]))
    this.log(`${link.env.name}: seeded ${key}`)
  }

  private featuresOf(link: Link): readonly string[] {
    const features = link.features ?? this.record(link.id)?.features ?? []
    const refused = this.unsupported.get(features)
    return refused ? features.filter((feature) => !refused.has(feature)) : features
  }

  private supports(link: Link, kind: Kind): boolean {
    return !kind.feature || this.featuresOf(link).includes(kind.feature)
  }

  /** Only a missing RPC is a version fallback. Other errors still reach the caller. */
  private markUnsupported(link: Link, kind: Kind, err: unknown): boolean {
    const { feature } = kind
    const hello = link.features
    if (!feature || !hello || !(err instanceof Error) || !/^(?:refused:\s*)?(?:unknown|unsupported) (?:method|kind)\b/i.test(err.message)) return false
    const refused = this.unsupported.get(hello) ?? new Set<string>()
    refused.add(feature)
    this.unsupported.set(hello, refused)
    const record = this.record(link.id)
    if (record) this.saveRecord(link.id, { ...record, features: this.featuresOf(link) })
    this.log(`${link.env.name}: no ${feature} (${err.message})`)
    return true
  }

  private remember(link: Link, workspaces: WorkspaceMeta[]): void {
    const build = link.build
    const previous = this.record(link.id)
    this.saveRecord(link.id, {
      platform: build?.platform ?? previous?.platform ?? null,
      headless: headlessOf(build) ?? previous?.headless ?? null,
      workspaces: workspaces.filter((w) => w.linkId).map((w) => ({ id: w.id, linkId: w.linkId! })),
      features: this.featuresOf(link)
    })
  }

  private saveRecord(id: string, record: PeerRecord): void {
    const raw = JSON.stringify(record)
    if (raw !== this.deps.store.getSetting(`${PEER_KEY}${id}`)) this.deps.store.setSetting(`${PEER_KEY}${id}`, raw)
  }

  /** The settings home among this host and every peer it has synced with once. */
  homeOf(): string {
    const copies = [{ environmentId: this.deps.environmentId }]
    for (const link of this.deps.peers.all()) if (this.record(link.id)) copies.push({ environmentId: link.id })
    return settingsHomeOf(copies, this.buildOf) ?? this.deps.environmentId
  }

  /** A host's hello build: this host's own, a peer's live one, else what its last pull recorded. */
  private buildOf = (id: string): HostBuild | null => {
    if (id === this.deps.environmentId) return { platform: this.deps.platform, headless: this.deps.headless }
    return this.deps.peers.get(id)?.build ?? this.record(id)
  }

  /** The global scope and every local workspace whose link the peer holds too (storeSync.ts reads the same). */
  sharedScopes(id: string): Scope[] {
    const theirs = new Map((this.record(id)?.workspaces ?? []).map((w) => [w.linkId, w.id]))
    const out: Scope[] = [{ key: 'global', local: null, peer: null }]
    for (const ws of this.deps.registry.listWorkspaces()) {
      const peer = ws.linkId ? theirs.get(ws.linkId) : undefined
      if (peer) out.push({ key: ws.linkId!, local: ws.id, peer })
    }
    return out
  }

  /**
   * A settings write: `true` when it went to the home and the
   * home's value now stands here too, `false` when the caller writes it here
   * as before. Throws the refusal when the home is offline.
   */
  async forward(method: Kind['set'], workspaceId: string | null, value: unknown): Promise<boolean> {
    const kind = this.kinds.find((k) => k.set === method)!
    if (kind.feature && workspaceId !== null) return false
    const home = this.homeOf()
    if (home === this.deps.environmentId) return false
    const link = this.deps.peers.get(home)
    if (!link) return false
    const scope = this.sharedScopes(home).find((s) => s.local === workspaceId)
    if (!scope || !this.supports(link, kind)) return false
    if (!link.connected) throw new Error(refusal(link.env.name, method))
    const key = this.writeKey(kind, scope)
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1)
    try {
      await link.request(method, { ...this.params(kind, scope), [kind.field]: value })
    } catch (err) {
      if (!link.connected) throw new Error(refusal(link.env.name, method))
      if (this.markUnsupported(link, kind, err)) return false
      throw err
    }
    // A pull may have made its read while the write was on the wire.
    const written = (this.writes.get(key) ?? 0) + 1
    this.writes.set(key, written)
    if (kind.feature) this.markSeeded(link, kind.get)
    try {
      await this.follow(link, kind, scope)
    } catch (err) {
      // The home has it; the next pull brings it here.
      if (written === this.writes.get(key)) kind.write(workspaceId, kind.parse(value))
      this.markUnsupported(link, kind, err)
      this.log(`${link.env.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return true
  }

  /** Where a scope's one copy lives when another host holds it: that host's
   *  name and whether it answers now. Null when this host's copy is the one. */
  homeFor(workspaceId: string | null, method: Kind['get'] = 'rules.get'): SettingsHome | null {
    const kind = this.kinds.find((k) => k.get === method)!
    if (kind.feature && workspaceId !== null) return null
    const home = this.homeOf()
    if (home === this.deps.environmentId) return null
    const link = this.deps.peers.get(home)
    if (!link || !this.supports(link, kind)) return null
    if (workspaceId !== null && !this.sharedScopes(home).some((s) => s.local === workspaceId)) return null
    return { name: link.env.name, online: link.connected }
  }
}

export const refusal = (host: string, method?: Kind['set']): string => {
  const settings = method === 'plans.set' ? 'plan settings' : method === 'review.set' ? 'review settings' : 'orchestration rules and thread defaults'
  return `refused: ${settings} live on ${host}; it is offline`
}
