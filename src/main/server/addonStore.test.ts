import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { AddonStore, configureLifeosRow, LIFEOS_ROW_REFUSAL, specDigest } from './addonStore'
import type { AddonInput, AddonRow, AddonSpec, AddonTool } from '@shared/contract-addons'

const you = { kind: 'person' } as const
const thread = { kind: 'thread', sessionId: 's1', environmentId: 'env_box', title: 'Wire GitHub' } as const
const spec: AddonSpec = { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: ['GITHUB_TOKEN'], auth: 'fields' }
const input = (over: Partial<AddonInput> = {}): AddonInput => ({ name: 'github', workspaceId: null, spec, ...over })
const tool: AddonTool = { name: 'create_issue', exposed: 'github__create_issue', description: 'Create an issue', inputSchema: { type: 'object' } }

let db: DatabaseSync
let clock: number
let store: AddonStore
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  clock = 1_000
  store = new AddonStore(db, () => clock)
})
afterEach(() => db.close())

describe('AddonStore rows', () => {
  it('creates a row with a minted id, stamps and the writer, and reads it back', () => {
    const row = store.set(input({ description: 'GitHub issues' }), you)
    expect(row.id).toMatch(/^ad_[A-Za-z0-9_-]{12}$/)
    expect(row).toMatchObject({ name: 'github', workspaceId: null, description: 'GitHub issues', enabled: true, addedBy: you, writtenBy: you, createdAt: 1_000, updatedAt: 1_000 })
    expect(store.get(row.id)).toEqual(row)
    expect(store.byName(null, 'github')).toEqual(row)
    expect(store.list()).toEqual([row])
  })

  it('replaces by scope and name, keeping the id, the creator and the creation time', () => {
    const first = store.set(input(), you)
    clock = 2_000
    const next = store.set(input({ spec: { ...spec, args: ['-y', 'other'] }, enabled: false }), thread)
    expect(next).toMatchObject({ id: first.id, enabled: false, addedBy: you, writtenBy: thread, createdAt: 1_000, updatedAt: 2_000 })
    expect(store.list()).toHaveLength(1)
  })

  it('replaces by id, may move the scope, and creates under an id minted elsewhere', () => {
    const first = store.set(input(), you)
    expect(store.set(input({ id: first.id, workspaceId: 'ws1' }), you).workspaceId).toBe('ws1')
    expect(store.byName(null, 'github')).toBeNull()
    expect(store.set(input({ id: 'ad_fromthemac1', name: 'linear' }), you).id).toBe('ad_fromthemac1')
  })

  it('refuses a name another row holds in that scope, and an unsafe spec', () => {
    const first = store.set(input(), you)
    store.set(input({ name: 'other' }), you)
    expect(() => store.set(input({ id: first.id, name: 'other' }), you)).toThrow('refused: an add-on named other already exists there')
    expect(() => store.set(input({ spec: { ...spec, args: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'] } }), you)).toThrow(/^refused: args\[0\] looks like a secret/)
    expect(() => store.set(input({ name: 'Bad' }), you)).toThrow()
  })

  it('keeps one row per scope and name, a workspace row beside a global one', () => {
    const global = store.set(input(), you)
    const ws = store.set(input({ workspaceId: 'ws1' }), you)
    expect(ws.id).not.toBe(global.id)
    expect(store.visible('ws1').map((r) => r.id)).toEqual([ws.id])
    expect(store.visible('ws2').map((r) => r.id)).toEqual([global.id])
  })

  it('the sync puts a row as it stands; a local row of that name under another id gives way', () => {
    const mine = store.set(input(), you)
    const home: AddonRow = { ...mine, id: 'ad_home00000001', writtenBy: thread, createdAt: 5, updatedAt: 6 }
    expect(store.put(home)).toBe(true)
    expect(store.list()).toEqual([home])
    expect(store.put(home)).toBe(false)
    // The same row with its keys in another order (as the wire may carry it) changes nothing.
    const reordered = Object.fromEntries(Object.entries({ ...home, spec: Object.fromEntries(Object.entries(home.spec).reverse()) }).reverse()) as AddonRow
    expect(store.put(reordered)).toBe(false)
  })

  it('removes a row, and drops a deleted workspace\'s rows', () => {
    const a = store.set(input(), you)
    store.set(input({ workspaceId: 'ws1' }), you)
    store.set(input({ workspaceId: 'ws1', name: 'linear' }), you)
    expect(store.dropWorkspace('ws1')).toBe(2)
    expect(store.list().map((r) => r.id)).toEqual([a.id])
    expect(store.remove(a.id)).toBe(true)
    expect(store.remove(a.id)).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('tells its listeners each change', () => {
    let changes = 0
    const off = store.onChange(() => changes++)
    const row = store.set(input(), you)
    store.put({ ...row, description: 'x' })
    store.put({ ...row, description: 'x' })
    store.remove(row.id)
    off()
    store.set(input(), you)
    expect(changes).toBe(3)
  })
})

describe('AddonStore tools and status (this host only)', () => {
  it('keeps the tools listed under the current spec; a changed spec voids them', () => {
    const row = store.set(input(), you)
    expect(store.tools(row.id)).toBeNull()
    store.setTools(row.id, [tool], 1_500)
    expect(store.tools(row.id)).toEqual({ tools: [tool], fetchedAt: 1_500 })
    // A write that keeps the spec keeps the cache.
    store.set(input({ description: 'still github' }), you)
    expect(store.tools(row.id)?.tools).toEqual([tool])
    store.set(input({ spec: { ...spec, args: ['-y', 'other'] } }), you)
    expect(store.tools(row.id)).toBeNull()
    expect(specDigest(spec)).toBe(specDigest({ ...spec }))
  })

  it('a put with another spec voids the cache too, and removal clears tools and status', () => {
    const row = store.set(input(), you)
    store.setTools(row.id, [tool])
    store.put({ ...row, spec: { ...spec, command: 'bunx' } })
    expect(store.tools(row.id)).toBeNull()
    store.setTools(row.id, [tool])
    store.setStatus(row.id, { state: 'ready', tools: 1, at: 1 })
    store.remove(row.id)
    expect(store.status()).toEqual({})
    expect(db.prepare('SELECT COUNT(*) AS n FROM addon_tool_cache').get()).toEqual({ n: 0 })
  })

  it('holds status in memory and tells its listeners only of a real change', () => {
    let seen = 0
    store.onStatus(() => seen++)
    store.setStatus('ad_x', { state: 'starting', tools: 0, at: 1 })
    store.setStatus('ad_x', { state: 'starting', tools: 0, at: 1 })
    store.setStatus('ad_x', { state: 'needs-grant', tools: 0, detail: 'GITHUB_TOKEN', at: 2 })
    expect(store.status()).toEqual({ ad_x: { state: 'needs-grant', tools: 0, detail: 'GITHUB_TOKEN', at: 2 } })
    store.setStatus('ad_x', null)
    store.setStatus('ad_x', null)
    expect(seen).toBe(3)
    expect(new AddonStore(db).status()).toEqual({})
  })
})

describe("AddonStore: Work's marks", () => {
  it('start unset, are set one at a time, and say when the add-on does not exist', () => {
    const row = store.set(input(), you)
    expect(store.workMarks(row.id)).toEqual({ role: null, forWork: false })
    expect(store.setWorkMarks(row.id, { forWork: true })).toBe(true)
    expect(store.setWorkMarks(row.id, { role: 'lifeos' })).toBe(true)
    expect(store.workMarks(row.id)).toEqual({ role: 'lifeos', forWork: true })
    expect(store.setWorkMarks(row.id, { role: null })).toBe(true)
    expect(store.workMarks(row.id)).toEqual({ role: null, forWork: true })
    expect(store.workMarks('ad_missing')).toBeNull()
    expect(store.setWorkMarks('ad_missing', { forWork: true })).toBe(false)
  })

  it("survive every write of the row: a person's edit, a replace by name and the sync's put", () => {
    const row = store.set(input(), you)
    store.setWorkMarks(row.id, { role: 'lifeos', forWork: true })
    clock = 2_000
    store.set(input({ id: row.id, description: 'edited', enabled: false }), thread)
    expect(store.workMarks(row.id)).toEqual({ role: 'lifeos', forWork: true })
    expect(store.put({ ...store.get(row.id)!, description: 'from the home', updatedAt: 3_000 })).toBe(true)
    expect(store.workMarks(row.id)).toEqual({ role: 'lifeos', forWork: true })
    expect(store.get(row.id)).toMatchObject({ description: 'from the home', updatedAt: 3_000 })
    // a row that is not LifeOS's keeps its mark across a change of its spec too
    const other = store.set(input({ name: 'slack' }), you)
    store.setWorkMarks(other.id, { forWork: true })
    store.set(input({ name: 'slack', spec: { ...spec, args: ['-y', 'other'] } }), you)
    expect(store.workMarks(other.id)).toEqual({ role: null, forWork: true })
  })

  describe("the app's own LifeOS row keeps LifeOS's address, whoever writes", () => {
    const lifeosSpec: AddonSpec = { transport: 'http', url: 'https://lifeos-mcp.example/mcp', headers: ['Authorization'], auth: 'fields' }
    const elsewhere: AddonSpec = { transport: 'http', url: 'https://attacker.example/mcp', headers: ['Authorization'], auth: 'fields' }
    const isLifeos = (s: AddonSpec): boolean => s.transport === 'http' && s.url === lifeosSpec.url
    afterEach(() => configureLifeosRow(null))

    it("refuses a person's edit and a thread's approved add that would point it at another server, and leaves the row whole", () => {
      configureLifeosRow(isLifeos)
      const row = store.set(input({ name: 'lifeos', spec: lifeosSpec }), you)
      store.setWorkMarks(row.id, { role: 'lifeos' })
      // by id (the settings page) and by scope and name (addon_add)
      expect(() => store.set(input({ id: row.id, name: 'lifeos', spec: elsewhere }), you)).toThrow(LIFEOS_ROW_REFUSAL)
      expect(() => store.set(input({ name: 'lifeos', spec: elsewhere }), thread)).toThrow(LIFEOS_ROW_REFUSAL)
      // and at this machine, where an agent's own server could be listening
      expect(() => store.set(input({ name: 'lifeos', spec: { ...lifeosSpec, url: 'http://127.0.0.1:9/mcp' } }), you)).toThrow(LIFEOS_ROW_REFUSAL)
      expect(store.get(row.id)).toEqual(row)
      expect(store.workMarks(row.id)?.role).toBe('lifeos')
    })

    it('takes a write that keeps the spec, and one that is still LifeOS', () => {
      configureLifeosRow(isLifeos)
      const row = store.set(input({ name: 'lifeos', spec: lifeosSpec }), you)
      store.setWorkMarks(row.id, { role: 'lifeos' })
      expect(store.set(input({ id: row.id, name: 'lifeos', spec: lifeosSpec, description: 'held to purdue' }), you).description).toBe('held to purdue')
      expect(store.set(input({ id: row.id, name: 'lifeos', spec: { ...lifeosSpec, platforms: ['linux'] } }), you).spec.platforms).toEqual(['linux'])
    })

    it('with no rule set (Work did not come up), refuses every change of its spec', () => {
      const row = store.set(input({ name: 'lifeos', spec: lifeosSpec }), you)
      store.setWorkMarks(row.id, { role: 'lifeos' })
      expect(() => store.set(input({ id: row.id, name: 'lifeos', spec: { ...lifeosSpec, platforms: ['linux'] } }), you)).toThrow(LIFEOS_ROW_REFUSAL)
    })

    it("takes the home's row from the sync as it stands, and drops the mark of one the home pointed elsewhere: nothing trusts it then", () => {
      configureLifeosRow(isLifeos)
      const row = store.set(input({ name: 'lifeos', spec: lifeosSpec }), you)
      store.setWorkMarks(row.id, { role: 'lifeos', forWork: true })
      expect(store.put({ ...row, spec: elsewhere, updatedAt: 9_000 })).toBe(true)
      expect(store.get(row.id)?.spec).toEqual(elsewhere)
      expect(store.workMarks(row.id)).toEqual({ role: null, forWork: true })
    })

    it('leaves every other row free to change', () => {
      configureLifeosRow(isLifeos)
      const row = store.set(input(), you)
      expect(store.set(input({ id: row.id, spec: elsewhere }), you).spec).toEqual(elsewhere)
    })
  })

  describe("a tool's hints", () => {
    const tools: AddonTool[] = [
      { name: 'search', exposed: 'github__search', description: 'Search', inputSchema: {}, readOnly: true },
      { name: 'post', exposed: 'github__post', description: 'Post', inputSchema: {} }
    ]
    it('are kept beside the tool cache, by tool name, and are no part of the tools a client lists', () => {
      const row = store.set(input(), you)
      store.setTools(row.id, tools, 5, { search: { readOnly: true, title: 'Search issues' }, post: { readOnly: true, openWorld: true, destructive: false, idempotent: false } })
      expect(store.toolHints(row.id)).toEqual({ search: { readOnly: true, title: 'Search issues' }, post: { readOnly: true, openWorld: true, destructive: false, idempotent: false } })
      expect(store.tools(row.id)?.tools).toEqual(tools)
    })
    it('are none for a list kept without them, and void once the spec changes', () => {
      const row = store.set(input(), you)
      store.setTools(row.id, tools)
      expect(store.toolHints(row.id)).toEqual({})
      store.setTools(row.id, tools, 5, { search: { readOnly: true } })
      store.set(input({ id: row.id, spec: { ...spec, args: ['-y', 'other'] } }), you)
      expect(store.toolHints(row.id)).toEqual({})
    })
    it('are added to a database made before them', () => {
      const old = new DatabaseSync(':memory:')
      old.exec(`CREATE TABLE addon_tool_cache (addon_id TEXT PRIMARY KEY, spec_digest TEXT NOT NULL, tools TEXT NOT NULL, fetched_at INTEGER NOT NULL)`)
      const s = new AddonStore(old)
      const row = s.set(input(), you)
      s.setTools(row.id, tools, 5, { search: { readOnly: true } })
      expect(s.toolHints(row.id)).toEqual({ search: { readOnly: true } })
    })
  })

  it('are not part of the row a client lists or the sync carries, and a change of one tells the listeners once', () => {
    const row = store.set(input(), you)
    let changes = 0
    store.onChange(() => changes++)
    store.setWorkMarks(row.id, { forWork: true })
    store.setWorkMarks(row.id, { forWork: true })
    expect(changes).toBe(1)
    expect(store.get(row.id)).toEqual(row)
    expect(Object.keys(store.list()[0])).not.toContain('role')
    expect(Object.keys(store.list()[0])).not.toContain('forWork')
  })

  it('go with the add-on when it is removed', () => {
    const row = store.set(input(), you)
    store.setWorkMarks(row.id, { role: 'lifeos' })
    store.remove(row.id)
    expect(store.workMarks(row.id)).toBeNull()
    const again = store.set(input(), you)
    expect(store.workMarks(again.id)).toEqual({ role: null, forWork: false })
  })
})

describe('AddonStore: a row it cannot read', () => {
  it("of the same scope and name gives way to a write, as it did when the write replaced on the unique index", () => {
    db.prepare(`INSERT INTO addons (id, name, workspace_id, description, spec, enabled, added_by, written_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'ad_broken', 'github', null, '', '{not json', 1, '{"kind":"person"}', '{"kind":"person"}', 1, 1
    )
    expect(store.list()).toEqual([])
    const home: AddonRow = { id: 'ad_fromhome00', name: 'github', workspaceId: null, description: '', spec, enabled: true, addedBy: you, writtenBy: you, createdAt: 5, updatedAt: 5 }
    expect(store.put(home)).toBe(true)
    expect(store.list().map((r) => r.id)).toEqual(['ad_fromhome00'])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM addons`).get()).toEqual({ n: 1 })
  })
})
