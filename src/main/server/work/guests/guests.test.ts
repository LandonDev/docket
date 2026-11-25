import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket as WsSocket } from 'ws'
import { createCollaborationClient, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import { GUEST_KEEP_MS, guestRefusal, type LifeosGuestSource } from '@shared/contract-work-guests'
import type { Caller, WorkCtx } from '../modules'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { PUBLIC_ROUTES } from '../service/routes'
import { BUDGET, CLOSE_FULL, CLOSE_TOO_MUCH, waitOf } from '../service/routes/budget'
import { addsContent, callerKey, cutDue, DOC_BYTES, guestThreads, LIMITS, plainBody, Window } from '../service/routes/guests'
import { servicePaths } from '../service/config'
import { startWorkService, type RunningService } from '../service/serve'
import { workClock } from '../clock'
import { guestLinkKind, guestsTools } from '.'
import { ActNotSent } from '../outbox/kinds'
import { GuestRuntime, guestOriginSetting, originOf } from './links'
import { ensureGuestTables, GuestStore, hashSecret } from './store'

/*
 * Guest links end to end in process: main's runtime (rows, tokens it signs,
 * the list it sends) and the real Work service (routes, Hocuspocus, the sheet
 * route) against a fake LifeOS. Every refusal the plan names is tried here.
 */

const SECRET = 's'.repeat(43)
const LOCAL: Caller = { kind: 'local', caps: [] }
const DOC = 'kdoc1'
const OTHER = 'kdoc2'
const open: { dirs: string[]; services: RunningService[]; clients: CollaborationClient[]; convex: FakeConvex[] } = { dirs: [], services: [], clients: [], convex: [] }

const BUDGET_AS_SHIPPED = { ...BUDGET }
beforeEach(() => {
  LIMITS.requests.clear()
  LIMITS.failures.clear()
  LIMITS.comments.clear()
  DOC_BYTES.clear()
  Object.assign(BUDGET, BUDGET_AS_SHIPPED)
})
afterEach(async () => {
  await Promise.all(open.clients.splice(0).map((c) => c.destroy()))
  await Promise.all(open.services.splice(0).map((s) => s.stop().catch(() => {})))
  await Promise.all(open.convex.splice(0).map((c) => c.close()))
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const until = async (what: string, ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Rig {
  rt: GuestRuntime
  service: RunningService
  convex: FakeConvex
  db: DatabaseSync
  signer: CollabSigner
  shared: { id: string; shared: boolean }[]
  logs: string[]
  base: string
  ctx: WorkCtx
  /** every list main sent the service */
  sent: Parameters<RunningService['setLinks']>[0][]
}

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'm31-'))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  for (const id of [DOC, OTHER]) convex.docs.set(id, { _id: id, sector: 'life', seq: 0, title: id, shared: false, markdown: '', plain: '' })
  const keys = await generateCollabKeys('k')
  const signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  const hosted = join(dir, 'hosted')
  mkdirSync(join(hosted, 'guest'), { recursive: true })
  writeFileSync(join(hosted, 'guest', 'index.html'), '<!doctype html><p>guest page</p>')
  mkdirSync(join(dir, 'data'), { recursive: true })
  const logs: string[] = []
  const service = await startWorkService(
    {
      port: 0,
      socketPath: servicePaths(join(dir, 'data')).socketPath,
      secret: SECRET,
      dataDir: join(dir, 'data', 'work-service'),
      hostedDir: hosted,
      host: 'env_box',
      lifeos: { here: true, url: convex.url },
      trusted: [{ by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }],
      links: []
    },
    { jwt: async () => 'owner-jwt', log: (l) => logs.push(l) }
  )
  open.services.push(service)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('work.ownerName', 'Landon Hale')
  ensureGuestTables(db)
  const shared: Rig['shared'] = []
  const base = `http://127.0.0.1:${service.port}`
  const ctx = {
    db,
    host: 'env_box',
    log: (l: string) => logs.push(l),
    push: () => {},
    service: {
      url: (route: string) => `${base}${route}`,
      token: async () => 'ok',
      internal: async (route: string) => (route === '/internal/guests/seen' ? { seen: {} } : {})
    },
    lifeos: {
      owner: () => ({
        query: async (_fn: string, args: { id: string }) => convex.docs.get(args.id) ?? (args.id === 'sheet1' ? { sector: 'life', title: 'Budget' } : null),
        mutation: async (fn: string, args: { id: string; shared: boolean }) => void (fn.endsWith(':setShared') && shared.push({ id: args.id, shared: args.shared }))
      })
    }
  } as unknown as WorkCtx
  const sent: Rig['sent'] = []
  const r: Rig = { rt: null as never, service, convex, db, signer, shared, logs, base, ctx, sent }
  r.rt = new GuestRuntime(ctx, () => ({ tokenSigner: () => r.signer, setLinks: (links) => (sent.push(links), r.service.setLinks(links)), setProject: (id, project) => r.service.setProject(id, project) }))
  return r
}

/** A second service on the first one's port, as a restart leaves it: `settled` false is main itself restarted (it has named no link yet). */
async function restarted(r: Rig, settled: boolean, links: Parameters<RunningService['setLinks']>[0] = []): Promise<RunningService> {
  const port = r.service.port
  const dir = mkdtempSync(join(tmpdir(), 'm31-again-'))
  open.dirs.push(dir)
  const hosted = join(dir, 'hosted')
  mkdirSync(join(hosted, 'guest'), { recursive: true })
  writeFileSync(join(hosted, 'guest', 'index.html'), '<!doctype html><p>guest page</p>')
  mkdirSync(join(dir, 'data'), { recursive: true })
  await r.service.stop()
  const keys = await generateCollabKeys('k2')
  r.signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  const service = await startWorkService(
    {
      port,
      socketPath: servicePaths(join(dir, 'data')).socketPath,
      secret: SECRET,
      dataDir: join(dir, 'data', 'work-service'),
      hostedDir: hosted,
      host: 'env_box',
      lifeos: { here: true, url: r.convex.url },
      trusted: [{ by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }],
      links,
      linksSettled: settled
    },
    { jwt: async () => 'owner-jwt', log: (l) => r.logs.push(l) }
  )
  open.services.push(service)
  r.service = service
  return service
}

const doc = (id = DOC): LifeosGuestSource => ({ at: 'lifeos', table: 'docs', id })
const inDays = (d: number) => Date.now() + d * 24 * 60 * 60_000

async function make(r: Rig, role: 'view' | 'comment' | 'edit', source = doc()) {
  const made = await r.rt.create({ source, title: 'Run of show', name: 'Dana Lee', role, expiresAt: inDays(30), bySession: null })
  const u = new URL(made.url)
  return { id: made.link.id, secret: u.hash.replace('#k=', ''), url: made.url }
}

const post = (r: Rig, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${r.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

async function opened(r: Rig, id: string, secret: string, headers: Record<string, string> = {}) {
  const res = await post(r, `/g/${id}/open`, { secret }, headers)
  return { status: res.status, body: (await res.json()) as Record<string, string> }
}

function guestSocket(r: Rig, id: string, name: string, token: string) {
  const closes: string[] = []
  const client = createCollaborationClient({ documentName: name, token, url: `ws://127.0.0.1:${r.service.port}/g/ws/${id}`, offline: false, onClose: (why) => closes.push(why) })
  open.clients.push(client)
  return { client, closes }
}
function ownerSocket(r: Rig, name: string, token: string) {
  const client = createCollaborationClient({ documentName: name, token, url: `ws://127.0.0.1:${r.service.port}/w/doc/${name}`, offline: false })
  open.clients.push(client)
  return client
}
const synced = (c: CollaborationClient) => c.provider.isSynced && !c.provider.hasUnsyncedChanges
const ownerToken = async (r: Rig, name = DOC) => (await r.signer.sign({ doc: name, role: 'edit', principal: 'owner' }, 300)).token

describe('the guest origin', () => {
  const OLD = 'tempcode.test'
  const SHARE = 'share.test'
  /** One request to the service as a hostname's rule in the tunnel hands it over: the path, with that `Host`. */
  const on = (r: Rig, host: string, method: string, path: string, body?: unknown): Promise<{ status: number; location: string | null; text: string }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = httpRequest({ host: '127.0.0.1', port: r.service.port, path, method, headers: { Host: host, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null, text: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject)
      req.end(payload)
    })
  const socketOn = (r: Rig, host: string, path: string): Promise<number> =>
    new Promise((res) => {
      const ws = new WsSocket(`ws://127.0.0.1:${r.service.port}${path}`, { headers: { Host: host } })
      ws.on('open', () => (ws.terminate(), res(101)))
      ws.on('unexpected-response', (_q, got) => res(got.statusCode ?? 0))
      ws.on('error', () => {})
    })
  const flipped = (r: Rig) => r.service.setOrigins({ allowed: [`https://${OLD}`, `https://${SHARE}`], guest: `https://${SHARE}`, loopback: true })

  it('while guest pages share the host, every route answers on it as before', async () => {
    const r = await rig()
    const g = await make(r, 'edit')
    expect((await on(r, OLD, 'GET', `/g/${g.id}`)).status).toBe(200)
    expect((await on(r, OLD, 'POST', `/g/${g.id}/open`, { secret: g.secret })).status).toBe(200)
    expect((await on(r, OLD, 'GET', '/w/open')).status).toBe(200)
    expect(await socketOn(r, OLD, `/g/ws/${g.id}`)).toBe(101)
  })

  it('once they have their own, a page asked for on another host is sent on to the same path there (308), and nothing else of a guest answers on the old one', async () => {
    const r = await rig()
    const g = await make(r, 'edit')
    flipped(r)
    // An address already handed out: the browser follows, and carries its fragment (the secret) with it.
    expect(await on(r, OLD, 'GET', `/g/${g.id}`)).toMatchObject({ status: 308, location: `https://${SHARE}/g/${g.id}` })
    expect(await on(r, OLD, 'GET', '/w/open')).toMatchObject({ status: 308, location: `https://${SHARE}/w/open` })
    expect((await on(r, OLD, 'POST', `/g/${g.id}/open`, { secret: g.secret })).status).toBe(404)
    expect((await on(r, OLD, 'GET', `/g/${g.id}/threads`)).status).toBe(404)
    expect((await on(r, OLD, 'POST', `/g/${g.id}/comment`, { quote: 'x', text: 'y' })).status).toBe(404)
    expect(await socketOn(r, OLD, `/g/ws/${g.id}`)).toBe(404)
    // On the guest origin everything answers; the same id and secret open it.
    expect((await on(r, SHARE, 'GET', `/g/${g.id}`)).status).toBe(200)
    expect((await on(r, SHARE, 'POST', `/g/${g.id}/open`, { secret: g.secret })).status).toBe(200)
    expect((await on(r, SHARE, 'GET', '/w/open')).status).toBe(200)
    expect(await socketOn(r, SHARE, `/g/ws/${g.id}`)).toBe(101)
    // What is not a guest's stays where it was: the hosted files, health, and his own page's renewals.
    expect((await on(r, OLD, 'GET', '/w/healthz')).status).toBe(200)
    expect((await on(r, OLD, 'POST', '/w/open/renew', { renew: 'x'.repeat(43) })).status).toBe(403)
    // Nothing else of the host is served on the guest origin: its closed route list answers 404.
    for (const path of ['/', '/ui', '/ws', '/api/x', '/pair']) expect((await on(r, SHARE, 'GET', path)).status, path).toBe(404)
  })

  it('takes a name only once it answers as this very service, keeps it, and a link made after carries it', async () => {
    const r = await rig()
    const before = await make(r, 'view')
    // The host's own origin, whatever this run's is.
    const own = new URL(before.url).origin
    expect(own).not.toContain('share.')
    let mark: string | null = r.service.mark
    const asked: string[] = []
    const refreshed: number[] = []
    const fetchFn = (async (url: string) => (asked.push(url), url.startsWith('https://share.landonhale.com/') ? new Response(r.service.mark) : url.startsWith('https://other.example/') ? new Response('f'.repeat(32)) : Promise.reject(new Error('no such host')))) as unknown as typeof fetch
    const rt = new GuestRuntime(r.ctx, () => ({ tokenSigner: () => r.signer, setLinks: (links) => r.service.setLinks(links), setProject: (id, project) => r.service.setProject(id, project), mark: () => mark, refreshOrigins: () => void refreshed.push(1) }), fetchFn)
    // Another machine's service, a name that reaches nothing, and what is no origin at all: none is taken.
    await expect(rt.setOrigin('https://other.example')).rejects.toThrow("https://other.example does not reach this computer's Work service. Nothing changed.")
    await expect(rt.setOrigin('https://nowhere.example')).rejects.toThrow('does not reach')
    for (const bad of ['http://share.landonhale.com', 'https://share.landonhale.com/g', 'share.landonhale.com', 'https://user@share.landonhale.com', 'javascript:alert(1)'])
      await expect(rt.setOrigin(bad), bad).rejects.toThrow('An origin is https:// and a name')
    mark = null
    await expect(rt.setOrigin('https://share.landonhale.com')).rejects.toThrow('The Work service is not running')
    expect(guestOriginSetting(r.db)).toBeNull()
    expect(refreshed).toHaveLength(0)
    mark = r.service.mark
    expect(await rt.setOrigin('https://share.landonhale.com/')).toEqual({ origin: 'https://share.landonhale.com' })
    expect(asked.at(-1)).toBe('https://share.landonhale.com/w/healthz')
    expect(guestOriginSetting(r.db)).toBe('https://share.landonhale.com')
    expect(refreshed).toHaveLength(1)
    const after = await rt.create({ source: doc(OTHER), title: 'Run of show', name: 'Sam', role: 'view', expiresAt: inDays(7), bySession: null })
    expect(after.url.startsWith('https://share.landonhale.com/g/')).toBe(true)
    expect((await rt.rekey(before.id))!.startsWith('https://share.landonhale.com/g/')).toBe(true)
    // Put back: new links carry the host's own origin again.
    expect(await rt.setOrigin(null)).toEqual({ origin: null })
    expect(guestOriginSetting(r.db)).toBeNull()
    expect(refreshed).toHaveLength(2)
    expect(new URL((await rt.rekey(before.id))!).origin).toBe(own)
  })

  it('an origin is https and a name with nothing after it; a loopback http one only on an isolated instance', () => {
    expect(originOf('https://share.landonhale.com')).toBe('https://share.landonhale.com')
    expect(originOf(' https://Share.LandonHale.com/ ')).toBe('https://share.landonhale.com')
    expect(originOf('https://share.landonhale.com:8443')).toBe('https://share.landonhale.com:8443')
    expect(originOf('http://127.0.0.1:7001', { TEMP_CODE_USER_DATA: '/tmp/x' })).toBe('http://127.0.0.1:7001')
    expect(originOf('http://127.0.0.1:7001', { TEMP_CODE_USER_DATA: '/srv/agents/temp-code-data' })).toBeNull()
    for (const bad of ['', 'share', 'ftp://share.landonhale.com', 'https://share.landonhale.com/x', 'https://share.landonhale.com?x=1', 'https://share.landonhale.com#k']) expect(originOf(bad), bad).toBeNull()
  })

  it('a thread sets no origin: only the owner does', async () => {
    const { guests } = await import('.')
    const r = await rig()
    await expect(guests.handle!({ method: 'work.guests.setOrigin', params: { origin: 'https://share.landonhale.com' } } as never, r.ctx, { kind: 'model', caps: [], sessionId: 't1' } as never)).rejects.toThrow('Only the owner')
    const { GUESTS_CAPS } = await import('@shared/contract-work-guests')
    expect(GUESTS_CAPS['work.guests.setOrigin']).toBe('admin')
  })
})

describe("a link's budget", () => {
  /** A raw socket on a link's address: what it was closed with, or the status its upgrade was refused with. */
  const raw = (r: Rig, id: string) => {
    const ws = new WsSocket(`ws://127.0.0.1:${r.service.port}/g/ws/${id}`)
    const ended = new Promise<{ code: number; reason: string } | { status: number }>((res) => {
      ws.on('close', (code, reason) => res({ code, reason: reason.toString() }))
      ws.on('unexpected-response', (_q, got) => res({ status: got.statusCode ?? 0 }))
      ws.on('error', () => {})
    })
    return { ws, ended, opened: new Promise<boolean>((res) => (ws.on('open', () => res(true)), ws.on('unexpected-response', () => res(false)))) }
  }

  it('ships as 4 MiB at once, a megabyte back a minute, 8 sockets a link and 32 MiB a document', () => {
    expect(BUDGET_AS_SHIPPED).toEqual({ bytes: 4 * 1024 * 1024, bytesPerMinute: 1024 * 1024, sockets: 8, docBytes: 32 * 1024 * 1024 })
  })

  it('a link that sends more than its budget is closed with the seconds to wait, opens no new socket until then, and another link is untouched', async () => {
    BUDGET.bytes = 2000
    BUDGET.bytesPerMinute = 60_000
    const r = await rig()
    const a = await make(r, 'edit')
    const b = await make(r, 'edit', doc(OTHER))
    const flood = raw(r, a.id)
    expect(await flood.opened).toBe(true)
    // Three frames of 900 bytes: the third is past 2,000, is not passed on, and the socket is told how long to wait.
    for (let i = 0; i < 3; i++) flood.ws.send(new Uint8Array(900))
    const closed = (await flood.ended) as { code: number; reason: string }
    expect(closed.code).toBe(CLOSE_TOO_MUCH)
    // 700 bytes short at 1,000 bytes a second: under a second, said as one.
    expect(waitOf(closed.reason)).toBe(1)
    // Until then the link opens nothing: a page's tries cost one refused upgrade each.
    expect(await raw(r, a.id).ended).toEqual({ status: 429 })
    // The other link's guest is in as ever.
    const other = raw(r, b.id)
    expect(await other.opened).toBe(true)
    other.ws.terminate()
    await sleep(1100)
    const back = raw(r, a.id)
    expect(await back.opened).toBe(true)
    back.ws.terminate()
  })

  it('a link holds eight sockets at a time; the ninth is refused until one leaves', async () => {
    BUDGET.sockets = 3
    const r = await rig()
    const a = await make(r, 'view')
    const held = [raw(r, a.id), raw(r, a.id), raw(r, a.id)]
    for (const h of held) expect(await h.opened).toBe(true)
    expect(await raw(r, a.id).ended).toEqual({ status: 429 })
    held[0]!.ws.terminate()
    await until('the service counts it gone', () => true, 10)
    await sleep(100)
    const next = raw(r, a.id)
    expect(await next.opened).toBe(true)
    for (const h of [...held, next]) h.ws.terminate()
  })

  it('a guest adds nothing to a document as large as a guest may make it; reading it and the owner writing it go on', async () => {
    const r = await rig()
    const g = await make(r, 'edit')
    const first = await opened(r, g.id, g.secret)
    const owner = ownerSocket(r, DOC, await ownerToken(r))
    const guest = guestSocket(r, g.id, DOC, first.body.token!)
    await until('both in', () => synced(owner) && synced(guest.client))
    owner.document.getText('probe').insert(0, 'x'.repeat(5000))
    await until('the guest reads it', () => guest.client.document.getText('probe').length === 5000)
    // From here the document is past what a guest may grow it to.
    BUDGET.docBytes = 1000
    await sleep(50)
    const closes: number[] = []
    guest.client.provider.on('close', ({ event }: { event: { code: number } }) => closes.push(event.code))
    guest.client.document.getText('probe').insert(0, 'one more word')
    await until('the guest is told the document is full', () => closes.includes(CLOSE_FULL), 12_000)
    owner.document.getText('probe').insert(0, 'his own words ')
    await until('the owner still writes', () => synced(owner))
    expect(owner.document.getText('probe').toString()).not.toContain('one more word')
  }, 20_000)

  it('tells a frame that adds to the document from one that only asks or says who is here', () => {
    const frame = (...after: number[]) => new Uint8Array([4, 107, 100, 111, 99, ...after])
    expect(addsContent(frame(0, 2, 5, 1, 2, 3, 4, 5))).toBe(true)
    expect(addsContent(frame(0, 1, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9))).toBe(true)
    // A sync answer with nothing in it, a first ask, presence, a token.
    expect(addsContent(frame(0, 1, 2, 0, 0))).toBe(false)
    expect(addsContent(frame(0, 0, 1, 0))).toBe(false)
    expect(addsContent(frame(1, 3, 1, 2, 3))).toBe(false)
    expect(addsContent(frame(2, 0, 1, 65))).toBe(false)
    expect(addsContent(new Uint8Array([200]))).toBe(false)
  })
})

describe('a start is not an end', () => {
  it('after main restarts, a live link answers "starting" (503) on every route until main names its links, then opens; nothing is counted against the caller', async () => {
    const r = await rig()
    const g = await make(r, 'edit')
    expect((await opened(r, g.id, g.secret)).status).toBe(200)
    // Main and its service start again: new keys, and a service that has heard of no link.
    const before = r.signer
    await restarted(r, false)
    const rt2 = new GuestRuntime(r.ctx, () => ({ tokenSigner: () => r.signer, setLinks: (links) => r.service.setLinks(links), setProject: (id, project) => r.service.setProject(id, project) }))
    expect(r.signer).not.toBe(before)
    for (let i = 0; i < 12; i++) {
      const got = await opened(r, g.id, g.secret)
      expect(got.status).toBe(503)
      expect(got.body).toEqual({ error: 'starting' })
    }
    // Twelve tries, none a wrong secret: the caller is not shut out for them.
    expect(LIMITS.failures.over('127.0.0.1')).toBe(false)
    expect((await post(r, `/g/${g.id}/item`, { secret: g.secret, table: 'docs', id: DOC })).status).toBe(503)
    expect((await fetch(`${r.base}/g/${g.id}/threads`, { headers: { Authorization: 'Bearer x' } })).status).toBe(503)
    expect((await post(r, '/w/open/redeem', { ticket: 'x'.repeat(43) })).status).toBe(503)
    expect((await post(r, '/w/open/renew', { renew: 'x'.repeat(43) })).status).toBe(503)
    const ws = new WsSocket(`ws://127.0.0.1:${r.service.port}/g/ws/${g.id}`)
    expect(await new Promise((res) => (ws.on('open', () => res(101)), ws.on('unexpected-response', (_q, got) => res(got.statusCode)), ws.on('error', () => {})))).toBe(503)
    // The page itself is served all along: it is the same for any id.
    expect((await fetch(`${r.base}/g/${g.id}`)).status).toBe(200)
    // Main's first pass: the link is sent from this host's own record of what LifeOS was told, with LifeOS not asked first.
    const asked = r.shared.length
    await rt2.sync()
    expect(r.shared.length).toBe(asked)
    const again = await opened(r, g.id, g.secret)
    expect(again.status).toBe(200)
    expect(again.body.token).not.toBe('')
    // And LifeOS is still told once more after the start, as every row is.
    await rt2.settle()
    expect(r.shared.slice(asked)).toEqual([{ id: DOC, shared: true }])
  })

  it('once main has named its links, one that is not among them is gone at once (403), and a wrong secret is counted', async () => {
    const r = await rig()
    const live = await make(r, 'view')
    const ended = await make(r, 'view', doc(OTHER))
    await r.rt.revoke(ended.id)
    await restarted(r, false)
    const rt2 = new GuestRuntime(r.ctx, () => ({ tokenSigner: () => r.signer, setLinks: (links) => r.service.setLinks(links), setProject: (id, project) => r.service.setProject(id, project) }))
    expect((await opened(r, ended.id, ended.secret)).status).toBe(503)
    await rt2.sync()
    expect((await opened(r, ended.id, ended.secret)).status).toBe(403)
    expect((await opened(r, 'neverMade', 'x'.repeat(43))).status).toBe(403)
    expect((await opened(r, live.id, 'wrong'.repeat(8))).status).toBe(403)
    expect((await opened(r, live.id, live.secret)).status).toBe(200)
  })

  it("a service that restarts alone is handed main's last list: no wait, and the page's secret opens it again", async () => {
    const r = await rig()
    const g = await make(r, 'edit')
    const list = [...(r.sent.at(-1) ?? [])]
    await restarted(r, true, list)
    expect((await opened(r, g.id, g.secret)).status).toBe(200)
  })

  it('main sends no list before it can sign a token: a list with nothing in it would read as every link gone', async () => {
    const r = await rig()
    await make(r, 'edit')
    const lists = r.sent.length
    const rt2 = new GuestRuntime(r.ctx, () => ({ tokenSigner: () => null, setLinks: (links) => void r.sent.push(links), setProject: () => {} }))
    await rt2.tick()
    expect(r.sent.length).toBe(lists)
  })
})

describe('the rows', () => {
  it('keep the secret as its hash only; a link ended or revoked stays listed a week', () => {
    const db = new DatabaseSync(':memory:')
    ensureGuestTables(db)
    const store = new GuestStore(db)
    const now = Date.now()
    const { link, secret } = store.create({ name: 'Dana', source: doc(), title: 'T', role: 'view', expiresAt: now + 60 * 60_000 * 2, bySession: null }, now)
    expect(secret.length).toBeGreaterThanOrEqual(43)
    expect(JSON.stringify(db.prepare('SELECT * FROM work_guest_links').all())).not.toContain(secret)
    expect(link.secretHash).toBe(hashSecret(secret))
    expect(store.live(now).map((l) => l.id)).toEqual([link.id])
    expect(store.revoke(link.id, now + 1)).toBe(true)
    expect(store.revoke(link.id, now + 2)).toBe(false)
    expect(store.live(now + 3)).toEqual([])
    expect(store.listed(now + 3).map((l) => l.id)).toEqual([link.id])
    expect(store.listed(now + GUEST_KEEP_MS + 10)).toEqual([])
  })
  it('refuse a comment link on a sheet, and ends outside an hour to a year', () => {
    const now = Date.now()
    expect(guestRefusal({ source: { at: 'lifeos', table: 'sheets', id: 's' }, role: 'comment', expiresAt: inDays(3) })).toMatch(/view or edit/)
    expect(guestRefusal({ source: doc(), role: 'view', expiresAt: now + 60_000 })).toMatch(/an hour/)
    expect(guestRefusal({ source: doc(), role: 'view', expiresAt: inDays(400) })).toMatch(/a year/)
    expect(guestRefusal({ source: doc(), role: 'edit', expiresAt: inDays(30) })).toBeNull()
  })
})

describe('a guest link', () => {
  it('opens with its secret only: no token, a wrong or another link\'s secret all get one answer that says nothing', async () => {
    const r = await rig()
    const a = await make(r, 'edit')
    const b = await make(r, 'view', doc(OTHER))
    expect(r.shared).toEqual([
      { id: DOC, shared: true },
      { id: OTHER, shared: true }
    ])
    const page = await fetch(`${r.base}/g/${a.id}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    // The page is the same for any id: it does not say whether a link exists.
    expect(await (await fetch(`${r.base}/g/nosuchlink`)).text()).toBe(await page.text())
    for (const [id, secret] of [
      [a.id, ''],
      [a.id, 'x'.repeat(43)],
      [a.id, b.secret],
      ['nosuchlink', a.secret]
    ]) {
      const got = await opened(r, id!, secret!)
      expect(got.status).toBe(403)
      expect(got.body).toEqual({ error: 'gone' })
    }
    const ok = await opened(r, a.id, a.secret)
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ kind: 'doc', role: 'edit', name: 'Dana Lee', title: 'Run of show', owner: 'Landon Hale', doc: DOC, me: `guest:${a.id}` })
    // The token carries the link and no file path.
    const claims = JSON.parse(Buffer.from(ok.body.token!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>
    expect(claims).toMatchObject({ doc: DOC, role: 'edit', principal: `guest:${a.id}`, link: a.id })
    expect(claims.file).toBeUndefined()
  })

  it('refuses past ten failed secrets from one CF-Connecting-IP, even the right one, and only from there', async () => {
    const r = await rig()
    const a = await make(r, 'view')
    for (let i = 0; i < 10; i++) expect((await opened(r, a.id, 'wrong', { 'CF-Connecting-IP': '203.0.113.9' })).status).toBe(403)
    expect((await opened(r, a.id, a.secret, { 'CF-Connecting-IP': '203.0.113.9' })).status).toBe(429)
    expect((await opened(r, a.id, a.secret, { 'CF-Connecting-IP': '198.51.100.4' })).status).toBe(200)
  })

  it('an expired link opens nothing', async () => {
    const r = await rig()
    const a = await make(r, 'view')
    r.db.prepare('UPDATE work_guest_links SET expires_at = ?').run(Date.now() - 1)
    await r.rt.tick()
    expect((await opened(r, a.id, a.secret)).status).toBe(403)
    expect(r.shared.at(-1)).toEqual({ id: DOC, shared: false })
  })

  it('edits live with the owner; revoked, its socket closes within a second and it opens nothing again', async () => {
    const r = await rig()
    const a = await make(r, 'edit')
    const { body } = await opened(r, a.id, a.secret)
    const guest = guestSocket(r, a.id, DOC, body.token!)
    const owner = ownerSocket(r, DOC, await ownerToken(r))
    await until('both synced', () => synced(guest.client) && synced(owner))
    guest.client.document.getText('probe').insert(0, '[guest]')
    await until('the owner sees it', () => owner.document.getText('probe').toString() === '[guest]')
    const at = Date.now()
    await r.rt.revoke(a.id)
    await until('the guest is closed', () => guest.closes.length > 0, 1000)
    expect(Date.now() - at).toBeLessThan(1000)
    expect((await opened(r, a.id, a.secret)).status).toBe(403)
    expect(r.shared.at(-1)).toEqual({ id: DOC, shared: false })
  })

  it("a view link's writes are dropped, and it may not comment", async () => {
    const r = await rig()
    const a = await make(r, 'view')
    const { body } = await opened(r, a.id, a.secret)
    const guest = guestSocket(r, a.id, DOC, body.token!)
    const owner = ownerSocket(r, DOC, await ownerToken(r))
    await until('both synced', () => guest.client.provider.isSynced && synced(owner))
    guest.client.document.getText('probe').insert(0, '[view]')
    await sleep(400)
    expect(owner.document.getText('probe').toString()).toBe('')
    const res = await post(r, `/g/${a.id}/comment`, { quote: 'x', text: 'hi' }, { Authorization: `Bearer ${body.token}` })
    expect(res.status).toBe(403)
  })

  it('a comment link comments (the service writes the mark, the words plain) and edits nothing', async () => {
    const r = await rig()
    await r.service.collab.writeMarkdown(DOC, 'owner', 'Check-in opens at the north doors')
    const a = await make(r, 'comment')
    const { body } = await opened(r, a.id, a.secret)
    const guest = guestSocket(r, a.id, DOC, body.token!)
    const owner = ownerSocket(r, DOC, await ownerToken(r))
    await until('both synced', () => guest.client.provider.isSynced && synced(owner))
    guest.client.document.getText('probe').insert(0, '[comment]')
    await sleep(400)
    expect(owner.document.getText('probe').toString()).toBe('')
    const auth = { Authorization: `Bearer ${body.token}` }
    const made = await post(r, `/g/${a.id}/comment`, { quote: 'north doors', text: 'See [this](javascript:alert(1)) <img src=x onerror=alert(1)>' }, auth)
    expect(made.status).toBe(200)
    const t = r.convex.threads.at(-1)!
    expect(t).toMatchObject({ docId: DOC, quote: 'north doors', author: `guest:${a.id}` })
    // Plain words only: one text run, no link and no mark, whatever was typed.
    expect(JSON.parse(t.body)).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'See [this](javascript:alert(1)) <img src=x onerror=alert(1)>', styles: {} }] }])
    expect(r.logs.join('\n')).not.toMatch(/could not be marked/)
    const reply = await post(r, `/g/${a.id}/comment`, { threadId: t.threadId, text: 'And a reply' }, auth)
    expect(reply.status).toBe(200)
    expect((await post(r, `/g/${a.id}/comment`, { threadId: 'th-elsewhere', text: 'x' }, auth)).status).toBe(404)
    const listed = (await (await fetch(`${r.base}/g/${a.id}/threads`, { headers: auth })).json()) as { rows: { comments: { authorMemberId: string }[] }[]; names: Record<string, string> }
    expect(listed.rows).toHaveLength(1)
    expect(listed.names[`guest:${a.id}`]).toBe('You')
    expect(listed.rows[0]!.comments.map((c) => c.authorMemberId)).toEqual([`guest:${a.id}`, `guest:${a.id}`])
    expect(plainBody('a\nb')).toBe(JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: 'a', styles: {} }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b', styles: {} }] }]))
  })

  it("reaches its own item and nothing else: another link's endpoints, another document, the owner's routes", async () => {
    const r = await rig()
    const a = await make(r, 'edit')
    const b = await make(r, 'edit', doc(OTHER))
    const { body } = await opened(r, a.id, a.secret)
    const auth = { Authorization: `Bearer ${body.token}` }
    // B's endpoints with A's token.
    expect((await fetch(`${r.base}/g/${b.id}/threads`, { headers: auth })).status).toBe(403)
    expect((await post(r, `/g/${b.id}/comment`, { quote: 'x', text: 'x' }, auth)).status).toBe(403)
    // A's token on B's socket: the socket is bound to B's document, the token names A's.
    const wrong = guestSocket(r, b.id, OTHER, body.token!)
    await sleep(500)
    expect(wrong.client.provider.isSynced).toBe(false)
    // A's token on the owner's socket of another document.
    const other = createCollaborationClient({ documentName: OTHER, token: body.token!, url: `ws://127.0.0.1:${r.service.port}/w/doc/${OTHER}`, offline: false })
    open.clients.push(other)
    await sleep(500)
    expect(other.provider.isSynced).toBe(false)
    // Every other route: nothing answers a guest's token with data. Internal routes are not on this port at all.
    for (const path of ['/internal/doc/read', '/internal/guests/seen', '/w/hosted/../internal/doc/read', '/w/full/x', '/w/office', '/f/x/form', '/w/open/renew', '/w/open/redeem']) {
      const res = await fetch(`${r.base}${path}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ docId: OTHER, ticket: body.token, renew: body.token }) })
      expect(res.status, path).toBeGreaterThanOrEqual(400)
    }
    expect(PUBLIC_ROUTES.map((x) => x.match.source).some((s) => s.includes('internal'))).toBe(false)
    // An action of a well-formed id with no link answers as a dead one.
    expect((await fetch(`${r.base}/g/zzz/threads`, { headers: auth })).status).toBe(403)
  })

  it('a page of another origin cannot post to the routes', async () => {
    const r = await rig()
    const a = await make(r, 'view')
    expect((await post(r, `/g/${a.id}/open`, { secret: a.secret }, { Origin: 'https://evil.example' })).status).toBe(403)
  })
})

describe('after the review', () => {
  it('a revoke during a tick that is still signing is not undone by the tick', async () => {
    const r = await rig()
    const a = await make(r, 'edit')
    const sent: string[][] = []
    let release!: () => void
    const slow = new Promise<void>((res) => (release = res))
    // A signer that holds the next re-sign until released: the tick's sync sits in it while the owner revokes.
    const signer = { sign: async (c: never, s: number) => (await slow, r.signer.sign(c, s)) }
    const rt = new GuestRuntime((r.rt as unknown as { ctx: WorkCtx }).ctx, () => ({ tokenSigner: () => signer as never, setProject: (id, project) => r.service.setProject(id, project), setLinks: (l) => (sent.push(l.map((x) => x.linkId)), r.service.setLinks(l)) }))
    const tick = rt.tick()
    await sleep(20)
    const revoked = rt.revoke(a.id)
    release()
    await Promise.all([tick, revoked])
    expect(sent.at(-1)).not.toContain(a.id)
    expect((await opened(r, a.id, a.secret)).status).toBe(403)
  })

  it('a link that cannot be signed is left out of what the service is told, never left as it was', async () => {
    const r = await rig()
    const a = await make(r, 'view')
    const sent: string[][] = []
    const broken = { sign: async () => Promise.reject(new Error('no key')) }
    const rt = new GuestRuntime((r.rt as unknown as { ctx: WorkCtx }).ctx, () => ({ tokenSigner: () => broken as never, setProject: (id, project) => r.service.setProject(id, project), setLinks: (l) => (sent.push(l.map((x) => x.linkId)), r.service.setLinks(l)) }))
    await rt.sync()
    expect(sent).toEqual([[]])
    expect((await opened(r, a.id, a.secret)).status).toBe(403)
  })

  it('a new address opens and the one before does not; an ended link takes none', async () => {
    const r = await rig()
    const a = await make(r, 'view')
    const url = (await r.rt.rekey(a.id))!
    const secret = new URL(url).hash.slice(3)
    expect(secret).not.toBe(a.secret)
    expect((await opened(r, a.id, a.secret)).status).toBe(403)
    expect((await opened(r, a.id, secret)).status).toBe(200)
    await r.rt.revoke(a.id)
    expect(await r.rt.rekey(a.id)).toBeNull()
  })

  it("is not made when LifeOS does not mark its item shared: the held act fails as not sent, and nothing was ever live", async () => {
    const r = await rig()
    const ctx = (r.rt as unknown as { ctx: WorkCtx }).ctx
    const sent: string[][] = []
    const down = { ...ctx, lifeos: { owner: () => ({ ...ctx.lifeos.owner(), mutation: async () => Promise.reject(new Error('LifeOS is down')) }) } } as unknown as WorkCtx
    const rt = new GuestRuntime(down, () => ({ tokenSigner: () => r.signer, setProject: (id, project) => r.service.setProject(id, project), setLinks: (l) => (sent.push(l.map((x) => x.linkId)), r.service.setLinks(l)) }))
    const asked = { ...down, item: { sessionId: null }, threads: { resume: async () => {} } }
    const made = guestLinkKind.execute({ source: doc(), title: 'Run of show', name: 'Dana Lee', role: 'edit', expiresAt: inDays(7) }, asked as never)
    await expect(made).rejects.toBeInstanceOf(ActNotSent)
    await expect(rt.create({ source: doc(), title: 'Run of show', name: 'Dana Lee', role: 'edit', expiresAt: inDays(7), bySession: null })).rejects.toThrow('LifeOS did not mark Run of show as shared, so no guest link was made.')
    expect(rt.store.live()).toEqual([])
    expect(await rt.list()).toEqual([])
    expect(sent.flat()).toEqual([])
  })

  it('after a restart, a link whose item this host marked is served at once from its own record; one with no record waits for LifeOS', async () => {
    const r = await rig()
    const a = await make(r, 'view')
    const b = await make(r, 'view', doc(OTHER))
    // As if the mark of the second had never been recorded here (a database from before marks were kept).
    r.db.prepare('DELETE FROM work_guest_marks WHERE key = ?').run(`docs:${OTHER}`)
    const ctx = (r.rt as unknown as { ctx: WorkCtx }).ctx
    let up = false
    const flaky = { ...ctx, lifeos: { owner: () => ({ ...ctx.lifeos.owner(), mutation: async (fn: string, args: never) => (up ? ctx.lifeos.owner().mutation(fn, args) : Promise.reject(new Error('LifeOS is down'))) }) } } as unknown as WorkCtx
    const sent: string[][] = []
    const rt = new GuestRuntime(flaky, () => ({ tokenSigner: () => r.signer, setProject: (id, project) => r.service.setProject(id, project), setLinks: (l) => (sent.push(l.map((x) => x.linkId)), r.service.setLinks(l)) }))
    await rt.tick()
    // LifeOS is down: the link it was told of before the restart stays open; the other is not sent on a guess.
    expect(sent.at(-1)).toEqual([a.id])
    expect((await opened(r, a.id, a.secret)).status).toBe(200)
    expect((await opened(r, b.id, b.secret)).status).toBe(403)
    up = true
    const told = r.shared.length
    await rt.tick()
    expect(sent.at(-1)).toEqual([a.id, b.id])
    expect((await opened(r, b.id, b.secret)).status).toBe(200)
    // Both were told to LifeOS again once it answered: every row once after a start.
    expect(r.shared.slice(told).map((x) => x.id).sort()).toEqual([DOC, OTHER].sort())
  })

  it('the thread that asked is told the link, never its address', async () => {
    const r = await rig()
    const told: string[] = []
    const clock = workClock('America/New_York')
    clock.set('lifeos', 'America/Chicago')
    const ctx = { ...(r.rt as unknown as { ctx: WorkCtx }).ctx, clock, item: { sessionId: 't1' }, threads: { resume: async (_s: string, notice: string) => void told.push(notice) } }
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 17, 5, 30))
    const got = await guestLinkKind.execute({ source: doc(), title: 'Run of show', name: 'Dana Lee', role: 'view', expiresAt: inDays(7) }, ctx as never).finally(() => now.mockRestore())
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('until Mon, Nov 23.')
    expect(told[0]).not.toMatch(/#k=|https?:\/\//)
    expect(told[0]).toContain((got.ref as { linkId: string }).linkId)
  })

  it('the limits hold a bounded map, and an IPv6 caller is counted by its /64', () => {
    const w = new Window(2, 60_000, 100)
    for (let i = 0; i < 1000; i++) w.take(`198.51.100.${i}`)
    expect(w.size).toBeLessThanOrEqual(100)
    expect(callerKey('2001:db8:1:2:aaaa::1')).toBe(callerKey('2001:0db8:0001:0002:ffff:1:2:3'))
    expect(callerKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
    expect(callerKey('2001:db8:1:3::1')).not.toBe(callerKey('2001:db8:1:2::1'))
    expect(callerKey('203.0.113.9')).toBe('203.0.113.9')
    expect(callerKey('::ffff:203.0.113.9')).toBe('203.0.113.9')
  })

  it('a guest sees other guests as "A guest", and a version is cut at most every five minutes per link', () => {
    const rows = [{ thread: { _id: 't', resolved: false, at: 1, editedAt: 1 }, comments: [{ _id: 'c1', author: 'guest:other', body: '[]', at: 1, editedAt: 1 }, { _id: 'c2', author: 'guest:me', body: '[]', at: 2, editedAt: 2 }] }]
    const got = guestThreads(rows, 'guest:me', 'Landon Hale')
    const other = got.rows[0]!.comments[0]!.authorMemberId
    expect(got.names[other]).toBe('A guest')
    expect(other).not.toContain('other')
    expect(got.names['guest:me']).toBe('You')
    const now = Date.now()
    expect(cutDue('d|l', now)).toBe(true)
    expect(cutDue('d|l', now + 60_000)).toBe(false)
    expect(cutDue('d|l', now + 6 * 60_000)).toBe(true)
  })
})

describe('found by the projects reviews', () => {
  const sheetHello = (r: Rig, path: string, token: string) => {
    const ws = new WsSocket(`${r.base.replace('http', 'ws')}${path}`)
    const messages: { t: string }[] = []
    ws.on('message', (d) => messages.push(JSON.parse(String(d)) as { t: string }))
    ws.on('error', () => {})
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token })))
    return { messages, closed: new Promise<number>((res) => ws.on('close', (code) => res(code))) }
  }

  it("a sheet's socket ends when its token runs out", async () => {
    const r = await rig()
    r.convex.sheets.set('ksheet1', { title: 'Budget', sector: 'life', ops: [] })
    const s = sheetHello(r, '/w/sheet/ksheet1', (await r.signer.sign({ sheet: 'ksheet1', role: 'edit', principal: 'owner' }, 1)).token)
    await until('the workbook arrives', () => s.messages.some((m) => m.t === 'state'))
    const at = Date.now()
    expect(await s.closed).toBe(4401)
    expect(Date.now() - at).toBeLessThan(2500)
  })

  it("a new address ends the document link's tokens already handed out: its socket closes at once and the old token opens nothing", async () => {
    const r = await rig()
    const a = await make(r, 'edit')
    const old = (await opened(r, a.id, a.secret)).body.token!
    const guest = guestSocket(r, a.id, DOC, old)
    await until('synced', () => synced(guest.client))
    const at = Date.now()
    const url = (await r.rt.rekey(a.id))!
    await until('the old socket is closed', () => guest.closes.length > 0, 2500)
    // The rekey waits for the next second's edge so new tokens are signed after it.
    expect(Date.now() - at).toBeLessThan(2500)
    expect((await fetch(`${r.base}/g/${a.id}/threads`, { headers: { Authorization: `Bearer ${old}` } })).status).toBe(403)
    const again = guestSocket(r, a.id, DOC, old)
    await sleep(500)
    expect(again.client.provider.isSynced).toBe(false)
    // The new address opens, and its token syncs.
    const fresh = await opened(r, a.id, new URL(url).hash.slice(3))
    expect(fresh.status).toBe(200)
    expect(fresh.body.token).not.toBe(old)
    const now = guestSocket(r, a.id, DOC, fresh.body.token!)
    await until('the new token syncs', () => synced(now.client))
  })

  it("a document guest's caret carries the link's name, whatever the page claims", async () => {
    const r = await rig()
    const a = await make(r, 'edit')
    const guest = guestSocket(r, a.id, DOC, (await opened(r, a.id, a.secret)).body.token!)
    const owner = ownerSocket(r, DOC, await ownerToken(r))
    await until('both synced', () => synced(guest.client) && synced(owner))
    const theirs = guest.client.provider.awareness!
    theirs.setLocalState({ member: { id: 'owner' }, user: { id: 'owner', name: 'Landon Hale', color: '#000000', hue: 2, avatarUrl: 'https://evil.example/me.png' } })
    const seen = () => owner.provider.awareness!.getStates().get(theirs.clientID) as { member?: { id: string }; user?: { id: string; name: string; avatarUrl: unknown } } | undefined
    await until('the owner sees the guest', () => seen()?.user !== undefined)
    expect(seen()!.user).toMatchObject({ id: `guest:${a.id}`, name: 'Dana Lee', avatarUrl: null })
    expect(seen()!.member).toEqual({ id: `guest:${a.id}` })
  })

  it("a new address ends a sheet link's open socket within a second", async () => {
    const r = await rig()
    r.convex.sheets.set('sheet1', { title: 'Budget', sector: 'life', ops: [] })
    const a = await make(r, 'view', { at: 'lifeos', table: 'sheets', id: 'sheet1' })
    const old = (await opened(r, a.id, a.secret)).body.token!
    const s = sheetHello(r, `/g/ws/${a.id}`, old)
    await until('the workbook arrives', () => s.messages.some((m) => m.t === 'state'))
    await r.rt.rekey(a.id)
    const at = Date.now()
    expect(await s.closed).toBe(4403)
    expect(Date.now() - at).toBeLessThan(1500)
    // The old token at a fresh socket is shut at its hello.
    expect(await sheetHello(r, `/g/ws/${a.id}`, old).closed).toBe(4403)
  })
})

describe('a sheet link', () => {
  it('names its sheet in the token, with the link; the socket goes to that sheet whatever the client asks', async () => {
    const r = await rig()
    const s = await make(r, 'view', { at: 'lifeos', table: 'sheets', id: 'sheet1' })
    const { body } = await opened(r, s.id, s.secret)
    expect(body).toMatchObject({ kind: 'sheet', role: 'view' })
    const claims = JSON.parse(Buffer.from(body.token!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>
    expect(claims).toMatchObject({ sheet: 'sheet1', link: s.id, principal: `guest:${s.id}` })
    expect(r.shared[0]).toEqual({ id: 'sheet1', shared: true })
  })
})

describe('an agent asking', () => {
  it('holds share.guestLink with exactly the link; his press makes it and tells the thread; its way back is Revoke link', async () => {
    const r = await rig()
    const held: unknown[] = []
    const tool = guestsTools.find((t) => t.name === 'guest_link')!
    const ctx = {
      ...(r.rt as unknown as { ctx: WorkCtx }).ctx,
      sessionId: 'thread1',
      clock: workClock('America/Chicago'),
      scope: { sector: 'life' },
      held: { create: (a: unknown) => (held.push(a), { state: 'held', ref: { at: 'host', id: 'h1' } }) }
    }
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 17, 5, 30))
    const out = await tool.run(tool.input.parse({ docId: DOC, name: 'Dana Lee', role: 'edit', days: 7 }), ctx as never).finally(() => now.mockRestore())
    expect(out.isError).toBeFalsy()
    expect(out.content[0]).toMatchObject({ text: expect.stringContaining('ends Mon, Nov 23') })
    expect(held).toEqual([{ kind: 'share.guestLink', sessionId: 'thread1', payload: expect.objectContaining({ source: doc(), name: 'Dana Lee', role: 'edit' }) }])
    // Another sector's document is not this thread's to share.
    r.convex.docs.get(OTHER)!.sector = 'cosmic'
    expect((await tool.run(tool.input.parse({ docId: OTHER, name: 'X' }), ctx as never)).isError).toBe(true)
    expect(guestLinkKind.words((held[0] as { payload: never }).payload)).toEqual({ summary: 'Make a guest link for Dana Lee: kdoc1', verb: 'Create link' })
    expect(guestLinkKind.wayBack!({ summary: '', ref: { linkId: 'L1' } })).toEqual({ pillar: 'guests', verb: 'guest_link_revoke', args: { linkId: 'L1' }, label: 'Revoke link' })
  })
})

describe("the owner's hosted editor", () => {
  it('a ticket opens once, then renews by the key the service made; a used or wrong ticket opens nothing', async () => {
    const r = await rig()
    const { url } = await r.rt.ticket(doc(), 'Run of show', LOCAL)
    const ticket = new URL(url).hash.replace('#t=', '')
    expect((await fetch(`${r.base}/w/open`)).status).toBe(200)
    const first = await post(r, '/w/open/redeem', { ticket })
    expect(first.status).toBe(200)
    const got = (await first.json()) as { doc: string; me: string; renew: string; token: string }
    expect(got).toMatchObject({ doc: DOC, me: 'owner' })
    expect((await post(r, '/w/open/redeem', { ticket })).status).toBe(403)
    expect((await post(r, '/w/open/redeem', { ticket: 'x'.repeat(43) })).status).toBe(403)
    const renewed = await post(r, '/w/open/renew', { renew: got.renew })
    expect(renewed.status).toBe(200)
    expect((await post(r, '/w/open/renew', { renew: 'nope' })).status).toBe(403)
    // A ticket main made before this service started may have been used by the one before: it opens nothing.
    const old = 'o'.repeat(43)
    r.service.setLinks([{ linkId: 'open.old', item: { doc: DOC }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null, pass: { ticketHash: hashSecret(old), ticketUntil: Date.now() + 60_000, issuedAt: 0, title: 'x', token: got.token, tokenExp: Date.now() + 60_000 } } as never])
    expect((await post(r, '/w/open/redeem', { ticket: old })).status).toBe(403)
    // A pass is no guest link: its token is the owner's, and /g/ knows nothing of it.
    expect((await post(r, '/g/open.x/open', { secret: ticket })).status).toBe(404)
  })
})
