import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allows, LOCAL_PRINCIPAL, principalCaps, requiredCapability, type Principal } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { AddonInput, AddonRow } from '@shared/contract-addons'
import type { LifeosJwtAnswer, LifeosStatus } from '@shared/contract-work-lifeos'
import type { WorkspaceMeta } from '@shared/domain'
import { WORK_HOME } from '@shared/work'
import type { AddonStore } from '../../addonStore'
import type { AddonGrants } from '../../addons/addonGrants'
import { openDb, Store } from '../../db'
import type { StoreSync } from '../../remote/storeSync'
import type { SessionRegistry } from '../../sessions'
import type { storeRpc } from '../../storeRpc'
import { startWork, type Work } from '../ctx'
import { WORK_OWNER_NAME_SETTING } from '../preamble'
import { lifeosAddress, lifeosHostOf, lifeosSeamsFor, LIFEOS_MCP_URL, LIFEOS_URL } from './ctx'
import { memoryDeviceToken } from './deviceToken'
import { FakeLifeos } from './fakeLifeos'
import { lifeos } from './index'
import { botNameOf, KEYS_TABLE } from './keys'
import { Links, PENDING_TABLE } from './links'
import { LifeosUnavailable } from './session'
import { faultOf, redact } from './transport'

const URL = 'https://lifeos.test'
let dir: string
let db: ReturnType<typeof openDb>
let store: Store
let fake: FakeLifeos
let tokens: ReturnType<typeof memoryDeviceToken>
let work: Work
let rows: Map<string, AddonRow>
let marks: Map<string, 'lifeos' | null>
let grants: Map<string, Record<string, string>>
let homes: Map<string, string>
/** The registry's `workspaces` pushes a link sent. */
let sectorPushes: string[] = []
let catalog: ((kind: 'workspaces' | 'projects') => void)[]
/** everything that left the host: pushes, answers, log lines */
let wire: string[]
let nextId = 0

const readKey: Principal = { kind: 'remote', keyId: 'k', name: 'phone', audience: 'client', caps: ['read', 'operate'] } as Principal
const approveKey: Principal = { kind: 'remote', keyId: 'k2', name: 'phone', audience: 'client', caps: ['read', 'operate', 'approve'] } as Principal

function workspace(id: string, extra: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
  const w = { id, name: id, path: join(dir, id), git: false, createdAt: Date.now(), ...extra } as WorkspaceMeta
  store.insertWorkspace(w)
  return w
}

function boot(): Work {
  const registry = {
    get: () => null,
    listWorkspaces: () => store.listWorkspaces(),
    setWorkspaceSector: (id: string, sector: string | null) => {
      store.setWorkspaceSector(id, sector)
      sectorPushes.push(`${id}:${sector}`)
    },
    onCatalog: (fn: (kind: 'workspaces' | 'projects') => void) => {
      catalog.push(fn)
      return () => {}
    }
  } as unknown as SessionRegistry
  const addons = {
    get: (id: string) => rows.get(id) ?? null,
    byName: (scope: string | null, name: string) => [...rows.values()].find((r) => r.workspaceId === scope && r.name === name) ?? null,
    workMarks: (id: string) => (rows.has(id) ? { role: marks.get(id) ?? null, forWork: false } : null),
    setWorkMarks: (id: string, m: { role?: 'lifeos' | null }) => void marks.set(id, m.role ?? null),
    onChange: () => () => {}
  } as unknown as AddonStore
  const addonRpc = {
    async handle(req: { method: string; params: { addon?: AddonInput; id?: string } }) {
      if (req.method === 'addons.set') {
        const input = req.params.addon!
        const id = input.id ?? `ad_${String(++nextId).padStart(12, '0')}`
        const row = { ...input, id, enabled: input.enabled ?? true, description: input.description ?? '' } as AddonRow
        rows.set(id, row)
        // A rewrite by a build before Work resets the marks; this store keeps them, as the upsert does.
        return { addon: row }
      }
      if (req.method === 'addons.remove') return { removed: rows.delete(req.params.id!) }
      throw new Error(req.method)
    }
  } as unknown as ReturnType<typeof storeRpc>
  const addonGrants = { setFields: async (id: string, fields: Record<string, string>) => void grants.set(id, fields) } as unknown as AddonGrants
  const storeSync = { homeFor: (scope: string | null) => (scope && homes.has(scope) ? { name: homes.get(scope)!, online: true } : null) } as unknown as StoreSync
  lifeosSeamsFor.current = {
    transport: fake,
    tokens,
    hasGrant: (id) => !!grants.get(id)?.Authorization,
    address: { url: URL, mcpUrl: 'https://lifeos-mcp.test/mcp' },
    hostName: 'box',
    session: { pollMs: 10, retryMs: [20], liveGraceMs: 60 }
  }
  const w = startWork({ db, store, registry, environmentId: 'env_box', dataDir: dir, addons, addonRpc, addonGrants, storeSync, log: (line) => wire.push(line) }, [lifeos])
  lifeosSeamsFor.current = null
  w.pushes.onPush((p) => wire.push(JSON.stringify(p)))
  return w
}

const req = (method: string, params?: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
async function call<T>(method: string, params?: unknown, principal: Principal = LOCAL_PRINCIPAL): Promise<T> {
  const answer = await work.handle(req(method, params), principal)
  if (!answer.handled) throw new Error(`${method} not handled`)
  wire.push(JSON.stringify(answer.result))
  return answer.result as T
}
const until = async (test: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
const status = (): Promise<LifeosStatus> => call<LifeosStatus>('work.lifeos.status')
const signedIn = async (): Promise<void> => {
  tokens.write({ v: 1, token: fake.device(), url: URL, at: 1 })
  work.settings.set({ enabled: true })
  await until(() => work.ctx.lifeos.connected())
}
/** No device token, sector key, poll secret or JWT in anything the host sent or logged. */
function assertNoSecret(except: string[] = []): void {
  const secrets = [...fake.sessions.keys(), ...fake.bots.map((b) => b.token), ...fake.jwts.map((j) => j.jwt).filter((j) => !except.includes(j))]
  const all = wire.join('\n')
  for (const s of secrets) expect(all.includes(s), `a secret reached the wire: ${s.slice(0, 6)}…`).toBe(false)
  expect(all).not.toMatch(/lop_[A-Za-z0-9_-]{8,}/)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-work-lifeos-'))
  db = openDb(join(dir, 'test.db'))
  store = new Store(db)
  fake = new FakeLifeos()
  tokens = memoryDeviceToken()
  rows = new Map()
  marks = new Map()
  grants = new Map()
  homes = new Map()
  catalog = []
  wire = []
  work = boot()
})
afterEach(() => {
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('with Work off', () => {
  it('nothing reaches LifeOS and every member answers off', async () => {
    tokens.write({ v: 1, token: fake.device(), url: URL, at: 1 })
    expect(work.ctx.lifeos.connected()).toBe(false)
    await expect(work.ctx.lifeos.jwt('purdue')).rejects.toMatchObject({ state: 'off' })
    await expect(work.ctx.lifeos.owner().query('auth:caller')).rejects.toBeInstanceOf(LifeosUnavailable)
    await expect(work.ctx.links.forThread('s')).rejects.toMatchObject({ state: 'off' })
    expect(fake.calls).toEqual([])
    expect(db.prepare(`SELECT count(*) AS n FROM ${KEYS_TABLE}`).get()).toEqual({ n: 0 })
  })
})

describe('signing in', () => {
  it('signed out: a typed state, a JWT answer that says so, and a chip create still admitted', async () => {
    work.settings.set({ enabled: true })
    expect((await status()).lifeos).toEqual({ state: 'signed-out' })
    expect(await call<LifeosJwtAnswer>('work.lifeos.jwt', { sector: 'purdue' })).toEqual({ ok: false, state: 'signed-out' })
    await expect(work.ctx.links.completeFor('s', 'sent')).rejects.toMatchObject({ state: 'signed-out' })
    expect(() => work.admitSession({ provider: 'claude', about: { kind: 'task', label: 'T', ref: { at: 'lifeos', table: 'tasks', id: 'task1' } } } as never, { kind: 'local', caps: [] })).not.toThrow()
  })

  it('setToken keeps a token only if LifeOS takes it, then connects as the owner', async () => {
    work.settings.set({ enabled: true })
    await expect(call('work.lifeos.setToken', { token: 'lo_not-a-real-token-here' })).rejects.toThrow('LifeOS refused that token')
    expect(tokens.current()).toBeNull()
    const token = fake.device()
    const answer = await call<LifeosStatus>('work.lifeos.setToken', { token })
    expect(answer.lifeos).toMatchObject({ state: 'connected', ownerId: 'landon' })
    expect(tokens.current()).toMatchObject({ token, url: URL })
    assertNoSecret()
  })

  it("pairs: the code to an admin only, the host polls and keeps the token, the poll secret never leaves", async () => {
    work.settings.set({ enabled: true })
    const started = await call<{ code: string }>('work.lifeos.pairStart', { name: 'TempCode box' })
    expect(started.code).toBe('ABCD-EFGH')
    expect((await call<LifeosStatus>('work.lifeos.status', {}, LOCAL_PRINCIPAL)).lifeos).toMatchObject({ state: 'pairing', code: 'ABCD-EFGH' })
    expect((await call<LifeosStatus>('work.lifeos.status', {}, readKey)).lifeos).not.toHaveProperty('code')
    await new Promise((r) => setTimeout(r, 40))
    expect(work.ctx.lifeos.connected()).toBe(false)
    fake.approvePairing()
    await until(() => work.ctx.lifeos.connected())
    expect(tokens.current()?.token).toMatch(/^lo_/)
    const pushes = wire.filter((l) => l.includes('"push":"work.lifeos"'))
    expect(pushes.length).toBeGreaterThan(0)
    expect(pushes.some((p) => p.includes('ABCD-EFGH'))).toBe(false)
    assertNoSecret()
  })

  it('a token another LifeOS address issued is never sent to this one', async () => {
    tokens.write({ v: 1, token: fake.device(), url: 'https://elsewhere.test', at: 1 })
    work.settings.set({ enabled: true })
    expect((await status()).lifeos).toEqual({ state: 'signed-out' })
    expect(fake.calls).toEqual([])
  })

  it('signs out: the session is revoked in LifeOS and the token leaves the vault', async () => {
    await signedIn()
    const token = tokens.current()!.token
    expect((await call<LifeosStatus>('work.lifeos.signOut')).lifeos).toEqual({ state: 'signed-out' })
    expect(fake.sessions.get(token)?.revoked).toBe(true)
    expect(tokens.current()).toBeNull()
  })

  it('a revoked token reads as refused', async () => {
    const token = fake.device()
    fake.sessions.get(token)!.revoked = true
    tokens.write({ v: 1, token, url: URL, at: 1 })
    work.settings.set({ enabled: true })
    await until(() => work.ctx.lifeos.connected() === false && (work.ctx as unknown as object) !== null)
    await new Promise((r) => setTimeout(r, 20))
    expect((await status()).lifeos).toMatchObject({ state: 'refused' })
  })

  it("learns the owner's name for the preamble from his default mail identity", async () => {
    await signedIn()
    await until(() => store.getSetting(WORK_OWNER_NAME_SETTING) === 'Landon Hale')
  })

  it('turning Work off closes the connection and answers off again', async () => {
    await signedIn()
    work.settings.set({ enabled: false })
    expect(work.ctx.lifeos.connected()).toBe(false)
    expect(fake.open_()).toBe(0)
    // The frame refuses a pillar's methods while Work is off; the session itself reads off.
    await expect(status()).rejects.toThrow('Work is off on this host')
    expect((await import('./ctx')).lifeosHostOf(work.ctx)!.status(true).lifeos).toEqual({ state: 'off' })
  })
})

describe('unreachable', () => {
  it('every member answers a typed unreachable, a chip create is admitted, and the host connects once LifeOS answers', async () => {
    fake.reachable = false
    tokens.write({ v: 1, token: fake.device(), url: URL, at: 1 })
    work.settings.set({ enabled: true })
    await until(() => work.ctx.lifeos.connected() === false && fake.calls.length > 0)
    await until(() => (work.ctx as unknown as { lifeos: { connected(): boolean } }).lifeos.connected() === false && JSON.stringify(wire).includes('unreachable'))
    expect((await status()).lifeos).toMatchObject({ state: 'unreachable' })
    expect(await call<LifeosJwtAnswer>('work.lifeos.jwt', {})).toEqual({ ok: false, state: 'unreachable' })
    await expect(work.ctx.links.forThread('s')).rejects.toMatchObject({ state: 'unreachable' })
    await expect(work.ctx.lifeos.owner().query('sectors:list')).rejects.toMatchObject({ state: 'unreachable' })
    expect(() => work.admitSession({ provider: 'claude', about: { kind: 'task', label: 'T', ref: { at: 'lifeos', table: 'tasks', id: 'task1' } } } as never, { kind: 'local', caps: [] })).not.toThrow()
    // A link asked for now waits, and is made once LifeOS is back.
    await work.ctx.links.link({ kind: 'task', label: 'Book the room', ref: { at: 'lifeos', table: 'tasks', id: 'task1' } }, 'thread1', 'Book the room')
    expect(db.prepare(`SELECT count(*) AS n FROM ${PENDING_TABLE}`).get()).toEqual({ n: 1 })
    fake.reachable = true
    await until(() => work.ctx.lifeos.connected())
    await until(() => fake.links.length === 1)
    expect(fake.links[0]).toMatchObject({ entity: { table: 'tasks', id: 'task1' }, host: 'env_box', threadId: 'thread1' })
    expect(db.prepare(`SELECT count(*) AS n FROM ${PENDING_TABLE}`).get()).toEqual({ n: 0 })
  })

  it('a socket that drops while connected reads as unreachable after the grace, and connected when it is back', async () => {
    await signedIn()
    fake.reachable = false
    await until(() => !work.ctx.lifeos.connected())
    expect((await status()).lifeos.state).toBe('unreachable')
    fake.reachable = true
    await until(() => work.ctx.lifeos.connected())
  })
})

describe('the JWT for a screen', () => {
  it('needs approve, answers one narrowed to the sector, and keeps it until it nears its end', async () => {
    await signedIn()
    // The socket's gate (remote/handlers.ts) refuses a key without approve before Work hears the call.
    expect(requiredCapability({ method: 'work.lifeos.jwt' as never })).toBe('approve')
    expect(allows(principalCaps(readKey), requiredCapability({ method: 'work.lifeos.jwt' as never }) as never)).toBe(false)
    expect(allows(principalCaps(approveKey), 'approve')).toBe(true)
    expect(requiredCapability({ method: 'work.lifeos.status' as never })).toBe('read')
    expect(requiredCapability({ method: 'work.lifeos.setToken' as never })).toBe('local')
    const before = fake.jwts.length
    const a = await call<LifeosJwtAnswer>('work.lifeos.jwt', { sector: 'purdue' }, approveKey)
    const b = await call<LifeosJwtAnswer>('work.lifeos.jwt', { sector: 'purdue' }, approveKey)
    expect(a.ok && b.ok && a.jwt === b.jwt).toBe(true)
    // A screen opens its own Convex client on the address the JWT is good for.
    expect(a.ok && a.url).toBe(URL)
    expect(fake.jwts.length).toBe(before + 1)
    expect(fake.jwts.at(-1)?.sectors).toEqual(['purdue'])
    expect(await work.ctx.lifeos.jwt()).not.toBe(a.ok ? a.jwt : '')
  })

  it('with no sector answers a JWT of the whole device session, asked of LifeOS with no sectors named (Today reads every job through it)', async () => {
    await signedIn()
    const whole = await call<LifeosJwtAnswer>('work.lifeos.jwt', {}, approveKey)
    expect(whole.ok).toBe(true)
    // LifeOS narrows a JWT only to sectors named in the trade (auth:token): none named, it carries the session's own, which is every sector unless the session was made narrower.
    expect(fake.jwts.find((j) => whole.ok && j.jwt === whole.jwt)).toEqual({ jwt: whole.ok ? whole.jwt : '' })
    const narrow = await call<LifeosJwtAnswer>('work.lifeos.jwt', { sector: 'ref' }, approveKey)
    expect(narrow.ok && whole.ok && narrow.jwt !== whole.jwt).toBe(true)
  })
})

describe('sector keys', () => {
  it('a linked workspace and the Work Chats each get a draft-only key held to their sectors, kept only as the LifeOS row\'s grant', async () => {
    const ws = workspace('ws_purdue', { kind: 'work', sector: 'purdue' })
    await signedIn()
    await until(() => fake.liveBots().length === 2)
    await until(() => !!work && rows.size === 2 && grants.size === 2)
    const purdue = fake.liveBots().find((b) => b.sectors.length === 1)!
    const chats = fake.liveBots().find((b) => b.sectors.length > 1)!
    expect(purdue).toMatchObject({ sectors: ['purdue'], client: 'tempcode', draftOnly: true })
    expect(chats.sectors).toEqual(['cosmic', 'hypixel', 'purdue', 'ref', 'unify', 'life'])
    const purdueRow = [...rows.values()].find((r) => r.workspaceId === ws.id)!
    const chatsRow = [...rows.values()].find((r) => r.workspaceId === WORK_HOME)!
    expect(purdueRow).toMatchObject({ name: 'lifeos', spec: { transport: 'http', url: 'https://lifeos-mcp.test/mcp', headers: ['Authorization'], auth: 'fields' } })
    expect(marks.get(purdueRow.id)).toBe('lifeos')
    expect(marks.get(chatsRow.id)).toBe('lifeos')
    expect(grants.get(purdueRow.id)).toEqual({ Authorization: `Bearer ${purdue.token}` })
    expect(grants.get(chatsRow.id)).toEqual({ Authorization: `Bearer ${chats.token}` })
    // Not in the row, not in the key table, not on the wire.
    expect(JSON.stringify([...rows.values()])).not.toContain(purdue.token)
    expect(JSON.stringify(db.prepare(`SELECT * FROM ${KEYS_TABLE}`).all())).not.toContain(purdue.token)
    const keys = (await status()).keys
    expect(keys.map((k) => [k.workspaceId, k.state]).sort()).toEqual([[WORK_HOME, 'ready'], [ws.id, 'ready']].sort())
    assertNoSecret()
  })

  it('a second pass mints nothing; a lost role mark is put back', async () => {
    workspace('ws_purdue', { kind: 'work', sector: 'purdue' })
    await signedIn()
    await until(() => grants.size === 2)
    const minted = fake.bots.length
    const id = [...rows.values()].find((r) => r.workspaceId === 'ws_purdue')!.id
    marks.set(id, null)
    await work.ctx.lifeos.connected() && (await (await import('./ctx')).lifeosHostOf(work.ctx)!.reconcile())
    expect(fake.bots.length).toBe(minted)
    expect(marks.get(id)).toBe('lifeos')
  })

  it('linking a code workspace mints its key; a new sector retires the old key; unlinking retires it and removes the row', async () => {
    const ws = workspace('ws_code')
    await signedIn()
    await until(() => grants.size === 1)
    sectorPushes = []
    await call('work.lifeos.link', { workspaceId: ws.id, sector: 'cosmic' })
    expect(store.listWorkspaces().find((w) => w.id === ws.id)?.sector).toBe('cosmic')
    // The sector reaches every client through the registry's workspaces push.
    expect(sectorPushes).toEqual([`${ws.id}:cosmic`])
    const first = fake.liveBots().find((b) => b.sectors.join() === 'cosmic')!
    expect(first).toBeTruthy()
    await call('work.lifeos.link', { workspaceId: ws.id, sector: 'hypixel' })
    expect(first.revokedAt).toBeDefined()
    const second = fake.liveBots().find((b) => b.sectors.join() === 'hypixel')!
    const row = [...rows.values()].find((r) => r.workspaceId === ws.id)!
    expect(grants.get(row.id)).toEqual({ Authorization: `Bearer ${second.token}` })
    await call('work.lifeos.link', { workspaceId: ws.id, sector: null })
    expect(second.revokedAt).toBeDefined()
    expect([...rows.values()].some((r) => r.workspaceId === ws.id)).toBe(false)
    await expect(call('work.lifeos.link', { workspaceId: ws.id, sector: 'nope' })).rejects.toThrow('LifeOS has no sector nope')
  })

  it("a Work workspace's sector is not relinked, a person's own lifeos row is never written over, and a workspace homed on another host is left to it", async () => {
    workspace('ws_work', { kind: 'work', sector: 'purdue' })
    workspace('ws_mine', { sector: 'ref' })
    workspace('ws_shared', { sector: 'unify' })
    homes.set('ws_shared', 'box')
    rows.set('ad_mine0000000', { id: 'ad_mine0000000', name: 'lifeos', workspaceId: 'ws_mine', spec: { transport: 'http', url: 'https://x.test/mcp', headers: [], auth: 'none' } } as unknown as AddonRow)
    await signedIn()
    await until(() => grants.size === 2)
    await expect(call('work.lifeos.link', { workspaceId: 'ws_work', sector: 'life' })).rejects.toThrow("a Work workspace's sector is set when it is made")
    const keys = (await status()).keys
    expect(keys.find((k) => k.workspaceId === 'ws_mine')).toMatchObject({ state: 'failed', error: expect.stringContaining('already in this workspace') })
    expect(keys.find((k) => k.workspaceId === 'ws_shared')).toMatchObject({ state: 'elsewhere' })
    expect(rows.get('ad_mine0000000')?.spec).toMatchObject({ url: 'https://x.test/mcp' })
    expect(fake.liveBots().some((b) => b.sectors.join() === 'ref' || b.sectors.join() === 'unify')).toBe(false)
  })

  it('a bot name LifeOS takes: at most 40 characters, one per host and scope', () => {
    const a = botNameOf('env_box', 'box', 'ws_1', 'A very long workspace name that goes on and on')
    const b = botNameOf('env_mac', 'box', 'ws_1', 'A very long workspace name that goes on and on')
    expect(a.length).toBeLessThanOrEqual(40)
    expect(a).not.toBe(b)
    expect(botNameOf('env_box', 'box', WORK_HOME, 'Work Chats')).toMatch(/^TempCode box: Work Chats [0-9a-f]{6}$/)
  })
})

describe('thread links', () => {
  it('a task chip links the thread; forThread reads it back; completeFor completes the task with the reason and the thread', async () => {
    await signedIn()
    await work.ctx.links.link({ kind: 'task', label: 'Book the room', ref: { at: 'lifeos', table: 'tasks', id: 'task1' } }, 'thread1', 'Booking')
    const links = await work.ctx.links.forThread('thread1')
    expect(links).toEqual([expect.objectContaining({ sector: 'purdue', entity: { table: 'tasks', id: 'task1' }, host: 'env_box', threadId: 'thread1', title: 'Booking', state: 'open' })])
    await work.ctx.links.completeFor('thread1', 'Booked room 204')
    expect(fake.tasks.get('task1')?.done).toEqual({ reason: 'Booked room 204', threadLink: { host: 'env_box', threadId: 'thread1', title: 'Booking' } })
    expect((await work.ctx.links.forThread('thread1'))[0]?.state).toBe('done')
  })

  it('a selection or a file chip links nothing; a deleted thread drops its queued link', async () => {
    await signedIn()
    await work.ctx.links.link({ kind: 'selection', label: 'Para', ref: { at: 'thread' }, quote: 'x' } as never, 'thread1', 'T')
    expect(fake.links).toEqual([])
    db.prepare(`INSERT INTO ${PENDING_TABLE} (session_id, entity_table, entity_id, title, at) VALUES ('gone', 'tasks', 'task1', 'T', 1)`).run()
    lifeos.sessionsRemoved!(['gone'], work.ctx)
    expect(db.prepare(`SELECT count(*) AS n FROM ${PENDING_TABLE}`).get()).toEqual({ n: 0 })
  })

  it("a link LifeOS cannot take now for any reason but its own refusal waits, and lands once it can", async () => {
    await signedIn()
    fake.missing.add('workLinks:link')
    await work.ctx.links.link({ kind: 'task', label: 'T', ref: { at: 'lifeos', table: 'tasks', id: 'task1' } }, 'thread1', 'T')
    expect(db.prepare(`SELECT count(*) AS n FROM ${PENDING_TABLE}`).get()).toEqual({ n: 1 })
    fake.missing.clear()
    await lifeosHostOf(work.ctx)!.links.flush()
    expect(fake.links).toHaveLength(1)
  })

  it("LifeOS's own refusal of a link is final, and nothing is queued", async () => {
    await signedIn()
    await expect(work.ctx.links.link({ kind: 'task', label: 'T', ref: { at: 'lifeos', table: 'nope' as never, id: 'x' } }, 'thread1', 'T')).resolves.toBeUndefined()
    expect(db.prepare(`SELECT count(*) AS n FROM ${PENDING_TABLE}`).get()).toEqual({ n: 0 })
  })

  it('a Work thread never completes a linked task of another sector', async () => {
    const owner = new FakeLifeos()
    const token = owner.device()
    const conn = owner.connect(async () => (await owner.open<{ jwt: string }>('auth:token', { token })).jwt, () => {})
    owner.tasks.set('task2', { sector: 'cosmic' })
    const links = new Links({ db, host: 'env_box', owner: () => conn, sectorOf: () => 'purdue', log: () => {} })
    await links.link({ kind: 'task', label: 'A', ref: { at: 'lifeos', table: 'tasks', id: 'task1' } }, 't', 'A')
    await links.link({ kind: 'task', label: 'B', ref: { at: 'lifeos', table: 'tasks', id: 'task2' } }, 't', 'B')
    await links.completeFor('t', 'done', conn)
    expect(owner.tasks.get('task1')?.done).toBeTruthy()
    expect(owner.tasks.get('task2')?.done).toBeUndefined()
  })
})

describe('after the review', () => {
  it("a sign-in whose identity lapsed in the Convex client reconnects on its own", async () => {
    await signedIn()
    fake.authLost?.()
    await until(() => work.ctx.lifeos.connected())
    expect(fake.open_()).toBe(1)
  })

  it("a failed JWT trade for one screen answers unreachable and leaves the owner's connection up", async () => {
    await signedIn()
    fake.openDown = true
    expect(await call<LifeosJwtAnswer>('work.lifeos.jwt', { sector: 'cosmic' })).toEqual({ ok: false, state: 'unreachable' })
    expect(work.ctx.lifeos.connected()).toBe(true)
    expect(fake.open_()).toBe(1)
  })

  it('a sign-out while setToken waits on LifeOS wins: the token is not kept', async () => {
    work.settings.set({ enabled: true })
    fake.delayMs = 40
    const setting = call('work.lifeos.setToken', { token: fake.device() })
    await call('work.lifeos.signOut')
    await expect(setting).rejects.toThrow('overtaken')
    expect(tokens.current()).toBeNull()
    expect((await status()).lifeos).toEqual({ state: 'signed-out' })
  })

  it('Work switched off while setToken waits: nothing is kept and nothing connects', async () => {
    work.settings.set({ enabled: true })
    fake.delayMs = 40
    const setting = call('work.lifeos.setToken', { token: fake.device() })
    await new Promise((r) => setTimeout(r, 5))
    work.settings.set({ enabled: false })
    await expect(setting).rejects.toBeTruthy()
    expect(tokens.current()).toBeNull()
    expect(fake.open_()).toBe(0)
  })

  it('a new token ends the session it replaces, and pairing waits for a sign-out', async () => {
    await signedIn()
    const old = tokens.current()!.token
    await expect(call('work.lifeos.pairStart', {})).rejects.toThrow('sign out before pairing again')
    await call('work.lifeos.setToken', { token: fake.device() })
    expect(fake.sessions.get(old)?.revoked).toBe(true)
  })

  it('a LifeOS row pointed at another address loses its key: revoked, and minted again into a sound row', async () => {
    workspace('ws_purdue', { kind: 'work', sector: 'purdue' })
    await signedIn()
    await until(() => grants.size === 2)
    const row = [...rows.values()].find((r) => r.workspaceId === 'ws_purdue')!
    const first = fake.liveBots().find((b) => b.sectors.join() === 'purdue')!
    rows.set(row.id, { ...row, spec: { ...row.spec, url: 'https://evil.test/mcp' } as AddonRow['spec'] })
    await lifeosHostOf(work.ctx)!.reconcile()
    expect(first.revokedAt).toBeDefined()
    expect(rows.get(row.id)?.spec).toMatchObject({ url: 'https://lifeos-mcp.test/mcp' })
    const second = fake.liveBots().find((b) => b.sectors.join() === 'purdue')!
    expect(grants.get(row.id)).toEqual({ Authorization: `Bearer ${second.token}` })
  })

  it("a key minted here before its workspace's add-ons moved to another host is revoked and forgotten; the row is left to that host", async () => {
    workspace('ws_code', { sector: 'cosmic' })
    await signedIn()
    await until(() => grants.size === 2)
    const mine = fake.liveBots().find((b) => b.sectors.join() === 'cosmic')!
    const row = [...rows.values()].find((r) => r.workspaceId === 'ws_code')!
    homes.set('ws_code', 'box')
    await lifeosHostOf(work.ctx)!.reconcile()
    expect(mine.revokedAt).toBeDefined()
    expect(rows.has(row.id)).toBe(true)
    expect((await status()).keys.find((k) => k.workspaceId === 'ws_code')?.state).toBe('elsewhere')
    expect(db.prepare(`SELECT count(*) AS n FROM ${KEYS_TABLE} WHERE scope = 'ws_code'`).get()).toEqual({ n: 0 })
    await expect(call('work.lifeos.link', { workspaceId: 'ws_code', sector: 'life' })).rejects.toThrow('live on box; link it there')
  })

  it('a key LifeOS made whose answer was lost is retired at once, or later from the kept intent when that retire fails too', async () => {
    const ws = workspace('ws_code')
    await signedIn()
    await until(() => grants.size === 1)
    fake.loseMintAnswer = true
    await call('work.lifeos.link', { workspaceId: ws.id, sector: 'ref' })
    expect(fake.liveBots().filter((b) => b.sectors.join() === 'ref')).toHaveLength(0)
    // Now the retire cannot run either: the key stays live, and its name stays on file.
    fake.missing.add('bots:revoke')
    await lifeosHostOf(work.ctx)!.reconcile()
    expect(fake.liveBots().filter((b) => b.sectors.join() === 'ref')).toHaveLength(1)
    expect(db.prepare(`SELECT count(*) AS n FROM ${KEYS_TABLE} WHERE scope = ?`).get(ws.id)).toEqual({ n: 1 })
    fake.loseMintAnswer = false
    fake.missing.clear()
    await call('work.lifeos.link', { workspaceId: ws.id, sector: null })
    expect(fake.liveBots().some((b) => b.sectors.join() === 'ref')).toBe(false)
    expect(db.prepare(`SELECT count(*) AS n FROM ${KEYS_TABLE} WHERE scope = ?`).get(ws.id)).toEqual({ n: 0 })
  })
})

describe('subscribe', () => {
  it('runs as the owner while connected and comes back after a reconnect', async () => {
    const seen: unknown[] = []
    work.settings.set({ enabled: true })
    const off = work.ctx.lifeos.subscribe<{ key: string }[]>('sectors:list', {}, (v) => seen.push(v.length))
    tokens.write({ v: 1, token: fake.device(), url: URL, at: 1 })
    await call('work.lifeos.setToken', { token: tokens.current()!.token })
    await until(() => seen.length === 1)
    await call('work.lifeos.signOut')
    await call('work.lifeos.setToken', { token: fake.device() })
    await until(() => seen.length === 2)
    off()
  })
})

describe('the pieces', () => {
  it('redacts every LifeOS secret shape from a line', () => {
    expect(redact('token lo_abcdefghijklmnop key lob_ABCDEFGHIJKLMNOP poll lop_0123456789ab jwt eyJabcdefghij.klmnopqrstu.vwxyz012345')).toBe('token [secret] key [secret] poll [secret] jwt [jwt]')
  })
  it('tells a refusal from an unreachable LifeOS', () => {
    expect(faultOf(Object.assign(new Error('x'), { data: { code: 'invalid-token' } }))).toBe('refused')
    expect(faultOf(new TypeError('fetch failed'))).toBe('unreachable')
    expect(faultOf(Object.assign(new Error('x'), { data: { code: 'invalid-sectors' } }))).toBe('error')
    expect(faultOf(new Error('Could not find public function'))).toBe('error')
  })
  it('points at the real LifeOS unless an isolated instance names another', () => {
    expect(lifeosAddress({ TEMP_CODE_LIFEOS_URL: 'https://x.test' })).toEqual({ url: LIFEOS_URL, mcpUrl: LIFEOS_MCP_URL })
    expect(lifeosAddress({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_LIFEOS_URL: 'https://x.test', TEMP_CODE_LIFEOS_MCP_URL: 'https://m.test/mcp' })).toEqual({ url: 'https://x.test', mcpUrl: 'https://m.test/mcp' })
  })
})
