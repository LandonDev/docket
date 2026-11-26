import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from '../db'
import { SessionRegistry } from '../sessions'
import { PeerCatalogs } from '../peerCatalogs'
import { HOST_FEATURES } from '@shared/capabilities'
import { DEFAULT_PLAN_SETTINGS } from '@shared/plans'
import { DEFAULT_REVIEW_SETTINGS } from '@shared/review'
import { DEFAULT_RULES, type OrchestrationRules } from '@shared/rules'
import { RulesSync, SEEDED_KEY, refusal } from './rulesSync'

// Two real registries: the Mac (this host, the follower) and the box (the
// settings home), joined by a fake peer link that answers the box's RPCs the
// way server/index.ts does.

const MAC = 'env_mac'
const BOX = 'env_box'
const WS_LINK = 'wl_temp'

const MUSE_CATALOG = {
  muse: {
    id: 'muse',
    label: 'Muse Code',
    models: [{ id: 'muse-wonder-full-1.0', label: 'Muse Wonder Full 1.0', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    defaultModel: 'muse-wonder-full-1.0'
  }
}
const BOX_CATALOG = { muse: { id: 'muse', label: 'Muse Code', models: [], defaultModel: 'muse-spark-1.3' } }

interface World {
  dbs: ReturnType<typeof openDb>[]
  mac: SessionRegistry
  macStore: Store
  box: SessionRegistry
  link: {
    id: string
    env: { id: string; name: string }
    connected: boolean
    build: { platform: string; headless?: boolean } | null
    features: readonly string[] | null
    calls: string[]
    /** Methods the box answers as an older build would: unknown. */
    unknown: Set<string>
    /** The next request of this method reads now and answers after the wait. */
    hold: { method: string; wait: Promise<void> } | null
    /** What the Mac sent with catalog.exchange. */
    sentCatalog: unknown
    request: <T>(method: string, params?: unknown) => Promise<T>
  }
  peerCatalogs: PeerCatalogs
  logs: string[]
  sync: RulesSync
}

function host(id: string, path: string, linked: boolean): { db: ReturnType<typeof openDb>; store: Store; registry: SessionRegistry } {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.insertWorkspace({ id: `w-${id}`, name: 'temp-code', path, git: true, createdAt: 1 })
  if (linked) store.setWorkspaceLink(`w-${id}`, WS_LINK)
  return { db, store, registry: new SessionRegistry(store) }
}

/** `me`, `platform`, `headless`: the follower's own id and hello (a Mac by default). */
function world(opts: { macLinked?: boolean; me?: string; platform?: string; headless?: boolean } = {}): World {
  const me = opts.me ?? MAC
  const mac = host(me, '/Users/me/IdeaProjects/temp-code', opts.macLinked !== false)
  const box = host(BOX, '/srv/agents/work/temp-code', true)
  const b = box.registry
  const link: World['link'] = {
    id: BOX,
    env: { id: BOX, name: 'box' },
    connected: true,
    build: { platform: 'linux', headless: true },
    features: [...HOST_FEATURES],
    calls: [],
    unknown: new Set(),
    hold: null,
    sentCatalog: null,
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (!link.connected) throw new Error('box is not connected')
      link.calls.push(method)
      if (link.unknown.has(method)) throw new Error(`unknown method ${method}`)
      const result = answer(method, (params ?? {}) as Record<string, any>)
      if (link.hold?.method === method) {
        const { wait } = link.hold
        link.hold = null
        await wait
      }
      return result as T
    }
  }

  function answer(method: string, p: Record<string, any>): unknown {
    switch (method) {
      case 'workspace.list':
        return b.listWorkspaces()
      case 'catalog.exchange':
        link.sentCatalog = p.catalog
        return { catalog: BOX_CATALOG }
      case 'rules.get': {
        const scoped = b.getOrchestrationRules(p.workspaceId)
        return { rules: scoped ?? b.getOrchestrationRules(null) ?? DEFAULT_RULES, overridden: scoped !== null }
      }
      case 'rules.set':
        return b.setOrchestrationRules(p.workspaceId, p.rules)
      case 'defaults.get': {
        const scoped = b.getThreadDefaults(p.workspaceId)
        return { defaults: scoped, overridden: scoped !== null }
      }
      case 'defaults.set':
        return b.setThreadDefaults(p.workspaceId, p.defaults)
      case 'plans.get': {
        expect(p).toEqual({ projectId: null })
        const settings = b.getPlanSettings(null)
        return { settings: settings ?? DEFAULT_PLAN_SETTINGS, overridden: settings !== null }
      }
      case 'plans.set':
        expect(p).toEqual({ projectId: null, settings: p.settings })
        return b.setPlanSettings(null, p.settings)
      case 'review.get':
        expect(p).toEqual({ projectId: null })
        return { override: null, global: b.getReviewSettings(null), ...b.effectiveReview(null) }
      case 'review.set':
        expect(p).toEqual({ projectId: null, settings: p.settings })
        return b.setReviewSettings(null, p.settings)
    }
    throw new Error(`unexpected ${method}`)
  }
  const peers = { get: (id: string) => (id === BOX ? link : undefined), all: () => [link] }
  const peerCatalogs = new PeerCatalogs(mac.store)
  const logs: string[] = []
  const sync = new RulesSync({
    environmentId: me,
    platform: opts.platform ?? 'darwin',
    headless: opts.headless,
    registry: mac.registry,
    store: mac.store,
    peers: peers as never,
    catalog: () => MUSE_CATALOG,
    peerCatalogs,
    log: (line) => logs.push(line)
  })
  return { dbs: [mac.db, box.db], mac: mac.registry, macStore: mac.store, box: b, link, peerCatalogs, logs, sync }
}

const withModel = (rules: OrchestrationRules, key: string, policy: OrchestrationRules['models'][string]): OrchestrationRules => ({
  ...rules,
  models: { ...rules.models, [key]: policy }
})

let w: World
beforeEach(() => {
  w = world()
})
afterEach(() => {
  w.sync.close()
  for (const db of w.dbs) db.close()
})

describe('one copy on the box', () => {
  it('seeds each shared scope from the Mac once, then follows the box', async () => {
    const mine = withModel(DEFAULT_RULES, 'muse:muse-spark-1.3', { approved: false })
    w.mac.setOrchestrationRules(null, mine)
    await w.sync.syncWith(BOX)
    expect(w.box.getOrchestrationRules(null)).toEqual(mine)
    expect(JSON.parse(w.macStore.getSetting(`${SEEDED_KEY}${BOX}`)!)).toEqual(['plans.get', 'review.get', 'global', WS_LINK])
    // From then on the box's edit wins.
    const theirs = withModel(mine, 'muse:muse-spark-1.3', { approved: true })
    w.box.setOrchestrationRules(null, theirs)
    await w.sync.syncWith(BOX)
    expect(w.mac.getOrchestrationRules(null)).toEqual(theirs)
  })

  it('a rule for a model only the Mac runs is stored on the box and read back here', async () => {
    await w.sync.syncWith(BOX)
    const next = withModel(DEFAULT_RULES, 'muse:muse-wonder-full-1.0', { approved: true, minReasoning: 'low', maxReasoning: 'xhigh' })
    expect(await w.sync.forward('rules.set', null, next)).toBe(true)
    // The box keeps a policy for a model its own catalog has no row for.
    expect(w.box.getOrchestrationRules(null)?.models['muse:muse-wonder-full-1.0']).toEqual({ approved: true, minReasoning: 'low', maxReasoning: 'xhigh' })
    expect(w.mac.getOrchestrationRules(null)).toEqual(w.box.getOrchestrationRules(null))
  })

  it('a workspace override is kept under each host its own workspace id, met by the link id', async () => {
    await w.sync.syncWith(BOX)
    const override = withModel(DEFAULT_RULES, 'codex:gpt-6-astra', { approved: false })
    expect(await w.sync.forward('rules.set', `w-${MAC}`, override)).toBe(true)
    expect(w.box.getOrchestrationRules(`w-${BOX}`)).toEqual(override)
    expect(w.mac.getOrchestrationRules(`w-${MAC}`)).toEqual(override)
    expect(w.box.getOrchestrationRules(`w-${MAC}`)).toBeNull()
  })

  it('a pull read before a forward never writes its older answer over it', async () => {
    const r1 = withModel(DEFAULT_RULES, 'codex:gpt-6-astra', { approved: true })
    w.mac.setOrchestrationRules(null, r1)
    await w.sync.syncWith(BOX)
    let release!: () => void
    w.link.hold = { method: 'rules.get', wait: new Promise<void>((r) => (release = r)) }
    const pull = w.sync.syncWith(BOX)
    // Let the pull reach its rules.get, which reads r1 and waits.
    for (let i = 0; i < 20 && w.link.hold; i++) await new Promise((r) => setTimeout(r, 0))
    expect(w.link.hold).toBeNull()
    const r2 = withModel(r1, 'codex:gpt-6-astra', { approved: false })
    await w.sync.forward('rules.set', null, r2)
    expect(w.mac.getOrchestrationRules(null)).toEqual(r2)
    release()
    await pull
    expect(w.mac.getOrchestrationRules(null)).toEqual(r2)
    expect(w.box.getOrchestrationRules(null)).toEqual(r2)
  })

  it('a write while the box is out of reach is refused and nothing changes here', async () => {
    const r1 = withModel(DEFAULT_RULES, 'codex:gpt-6-astra', { approved: true })
    w.mac.setOrchestrationRules(null, r1)
    await w.sync.syncWith(BOX)
    w.link.connected = false
    await expect(w.sync.forward('rules.set', null, withModel(r1, 'codex:gpt-6-astra', { approved: false }))).rejects.toThrow(refusal('box'))
    await expect(w.sync.forward('defaults.set', null, { provider: 'codex', model: '', reasoning: 'high', permission: 'auto' })).rejects.toThrow(refusal('box'))
    expect(w.mac.getOrchestrationRules(null)).toEqual(r1)
    expect(w.mac.getThreadDefaults(null)).toBeNull()
  })

  it('says where each scope lives: the box while it answers, offline when not, nothing for a workspace of its own', async () => {
    expect(w.sync.homeFor(null)).toBeNull()
    await w.sync.syncWith(BOX)
    expect(w.sync.homeFor(null)).toEqual({ name: 'box', online: true })
    expect(w.sync.homeFor(`w-${MAC}`)).toEqual({ name: 'box', online: true })
    w.link.connected = false
    expect(w.sync.homeFor(null)).toEqual({ name: 'box', online: false })
    w.sync.close()
    w.dbs.forEach((db) => db.close())
    w = world({ macLinked: false })
    await w.sync.syncWith(BOX)
    expect(w.sync.homeFor(null)).toEqual({ name: 'box', online: true })
    expect(w.sync.homeFor(`w-${MAC}`)).toBeNull()
  })
})

const plans = { ...DEFAULT_PLAN_SETTINGS, autoImplement: false }
const review = { ...DEFAULT_REVIEW_SETTINGS, beforeMerge: true }

describe.each([
  {
    kind: 'plans',
    get: 'plans.get',
    set: 'plans.set',
    mine: plans,
    theirs: { ...plans, archiveAfterStart: false },
    read: (r: SessionRegistry) => r.getPlanSettings(null),
    clear: (r: SessionRegistry) => r.setPlanSettings(null, null),
    saveMine: (r: SessionRegistry) => r.setPlanSettings(null, plans),
    saveTheirs: (r: SessionRegistry) => r.setPlanSettings(null, { ...plans, archiveAfterStart: false }),
  },
  {
    kind: 'review',
    get: 'review.get',
    set: 'review.set',
    mine: review,
    theirs: { ...review, maxMinutes: 24 },
    read: (r: SessionRegistry) => r.getReviewSettings(null),
    clear: (r: SessionRegistry) => r.setReviewSettings(null, null),
    saveMine: (r: SessionRegistry) => r.setReviewSettings(null, review),
    saveTheirs: (r: SessionRegistry) => r.setReviewSettings(null, { ...review, maxMinutes: 24 }),
  }
] as const)('global $kind', ({ kind, get, set, mine, theirs, read, clear, saveMine, saveTheirs }) => {
  it("takes the box's set on first sync and follows a later edit and clear", async () => {
    saveMine(w.mac)
    saveTheirs(w.box)
    await w.sync.syncWith(BOX)
    expect(read(w.mac)).toEqual(theirs)
    expect(w.link.calls).not.toContain(set)

    saveMine(w.box)
    await w.sync.syncWith(BOX)
    expect(read(w.mac)).toEqual(mine)
    clear(w.box)
    await w.sync.syncWith(BOX)
    expect(read(w.mac)).toBeNull()
  })

  it('seeds an empty box once, even if rules and defaults synced before the upgrade', async () => {
    w.macStore.setSetting(`${SEEDED_KEY}${BOX}`, JSON.stringify(['global', WS_LINK]))
    saveMine(w.mac)
    await w.sync.syncWith(BOX)
    expect(read(w.box)).toEqual(mine)
    expect(w.link.calls.filter((method) => method === set)).toHaveLength(1)
    clear(w.box)
    await w.sync.syncWith(BOX)
    expect(read(w.mac)).toBeNull()
    expect(w.link.calls.filter((method) => method === set)).toHaveLength(1)
  })

  it('pushes a global change on the same catalog channel as rules and defaults', () => {
    const changes: string[] = []
    const off = w.box.onCatalog((change) => changes.push(change))
    saveMine(w.box)
    saveMine(w.box)
    clear(w.box)
    off()
    expect(changes).toEqual(['workspaces', 'workspaces'])
  })

  it('forwards a write and a clear to the box, and keeps projects out of RulesSync', async () => {
    await w.sync.syncWith(BOX)
    expect(await w.sync.forward(set, 'project', mine)).toBe(false)
    expect(w.sync.homeFor('project', get)).toBeNull()
    expect(await w.sync.forward(set, null, mine)).toBe(true)
    expect(read(w.box)).toEqual(mine)
    expect(read(w.mac)).toEqual(mine)
    expect(await w.sync.forward(set, null, null)).toBe(true)
    expect(read(w.box)).toBeNull()
    expect(read(w.mac)).toBeNull()
  })

  it('names the box and refuses an offline write without changing the local set', async () => {
    expect(w.sync.homeFor(null, get)).toBeNull()
    saveMine(w.box)
    await w.sync.syncWith(BOX)
    expect(w.sync.homeFor(null, get)).toEqual({ name: 'box', online: true })
    w.link.connected = false
    w.link.features = null // The new link has not heard a hello since this host restarted.
    expect(w.sync.homeFor(null, get)).toEqual({ name: 'box', online: false })
    await expect(w.sync.forward(set, null, theirs)).rejects.toThrow(refusal('box', set))
    expect(read(w.mac)).toEqual(mine)
  })

  it('drops an older pull that answers after a forwarded write', async () => {
    saveMine(w.box)
    await w.sync.syncWith(BOX)
    let release!: () => void
    w.link.hold = { method: get, wait: new Promise<void>((r) => (release = r)) }
    const pull = w.sync.syncWith(BOX)
    for (let i = 0; i < 20 && w.link.hold; i++) await new Promise((r) => setTimeout(r, 0))
    expect(w.link.hold).toBeNull()
    await w.sync.forward(set, null, theirs)
    expect(read(w.mac)).toEqual(theirs)
    release()
    await pull
    expect(read(w.mac)).toEqual(theirs)
    expect(read(w.box)).toEqual(theirs)
  })

  it('keeps the local set on an older box, then seeds once its new hello names the feature', async () => {
    w.link.features = HOST_FEATURES.filter((feature) => feature !== `rulesSync.${kind}`)
    saveMine(w.mac)
    await w.sync.syncWith(BOX)
    expect(w.link.calls).not.toContain(get)
    expect(w.sync.homeFor(null, get)).toBeNull()
    w.link.connected = false
    expect(await w.sync.forward(set, null, theirs)).toBe(false)
    saveTheirs(w.mac)
    expect(read(w.mac)).toEqual(theirs)
    expect(read(w.box)).toBeNull()

    w.link.connected = true
    w.link.features = [...HOST_FEATURES]
    await w.sync.syncWith(BOX)
    expect(read(w.box)).toEqual(theirs)
    expect(w.sync.homeFor(null, get)).toEqual({ name: 'box', online: true })
  })

  it.each([get, set])('keeps its own copy if the box refuses %s despite the hello', async (method) => {
    const other = get === 'plans.get' ? 'review.get' : 'plans.get'
    saveMine(w.mac)
    w.link.unknown.add(method)
    await w.sync.syncWith(BOX)
    expect(w.sync.homeFor(null, get)).toBeNull()
    expect(w.sync.homeFor(null, other)).toEqual({ name: 'box', online: true })
    expect(await w.sync.forward(set, null, theirs)).toBe(false)
    expect(read(w.mac)).toEqual(mine)
    expect(read(w.box)).toBeNull()
    w.link.connected = false
    w.link.features = null
    expect(w.sync.homeFor(null, get)).toBeNull()
  })

  it('falls back to a local write if the first forward finds an unsupported setter', async () => {
    await w.sync.syncWith(BOX)
    w.link.unknown.add(set)
    expect(await w.sync.forward(set, null, mine)).toBe(false)
    expect(w.sync.homeFor(null, get)).toBeNull()
    expect(read(w.box)).toBeNull()
  })
})

describe('a PC beside the box', () => {
  const PC = 'env_a_pc' // sorts before env_box
  const pc = (): World => {
    w.sync.close()
    w.dbs.forEach((db) => db.close())
    return world({ me: PC, platform: 'win32', headless: false })
  }

  it('is never the home, though its id sorts first', async () => {
    w = pc()
    await w.sync.syncWith(BOX)
    expect(w.sync.homeOf()).toBe(BOX)
    expect(w.sync.homeFor(null)).toEqual({ name: 'box', online: true })
  })

  it('a fresh PC never writes its defaults over the box’s global rules and defaults; it follows them', async () => {
    w = pc()
    const boxRules = withModel(DEFAULT_RULES, 'codex:gpt-6-astra', { approved: false })
    const boxDefaults = { provider: 'codex', model: '', reasoning: 'high', permission: 'auto' } as const
    w.box.setOrchestrationRules(null, boxRules)
    w.box.setThreadDefaults(null, boxDefaults)
    w.box.setOrchestrationRules(`w-${BOX}`, boxRules)
    // The PC's own global defaults, made before it ever linked: the box's copy still wins.
    w.mac.setThreadDefaults(null, { provider: 'claude', model: '', reasoning: 'low', permission: 'auto' })
    await w.sync.syncWith(BOX)
    expect(w.link.calls).not.toContain('rules.set')
    expect(w.link.calls).not.toContain('defaults.set')
    expect(w.box.getOrchestrationRules(null)).toEqual(boxRules)
    expect(w.box.getThreadDefaults(null)).toEqual(boxDefaults)
    expect(w.mac.getOrchestrationRules(null)).toEqual(boxRules)
    expect(w.mac.getThreadDefaults(null)).toEqual(boxDefaults)
    expect(w.mac.getOrchestrationRules(`w-${PC}`)).toEqual(boxRules)
  })

  it('a box with no copy of its own takes the PC’s; a PC with none sends nothing', async () => {
    w = pc()
    const mine = withModel(DEFAULT_RULES, 'codex:gpt-6-astra', { approved: true })
    w.mac.setOrchestrationRules(null, mine)
    await w.sync.syncWith(BOX)
    expect(w.box.getOrchestrationRules(null)).toEqual(mine)
    expect(w.link.calls.filter((c) => c === 'defaults.set')).toHaveLength(0)
    expect(w.box.getThreadDefaults(null)).toBeNull()
  })
})

describe('the catalogs', () => {
  it('each pull sends this host its catalog and keeps the box its own', async () => {
    await w.sync.syncWith(BOX)
    expect(w.link.sentCatalog).toEqual(MUSE_CATALOG)
    expect(w.peerCatalogs.get(BOX)?.muse?.models).toEqual([])
  })

  it('a box that predates the exchange still syncs the rules, and says so once', async () => {
    w.link.unknown.add('catalog.exchange')
    const mine = withModel(DEFAULT_RULES, 'muse:muse-spark-1.3', { approved: false })
    w.mac.setOrchestrationRules(null, mine)
    await w.sync.syncWith(BOX)
    await w.sync.syncWith(BOX)
    expect(w.box.getOrchestrationRules(null)).toEqual(mine)
    expect(w.peerCatalogs.get(BOX)).toBeNull()
    expect(w.logs.filter((l) => l.includes('no catalog exchange'))).toHaveLength(1)
  })
})
