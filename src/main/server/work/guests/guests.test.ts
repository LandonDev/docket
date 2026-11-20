import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCollaborationClient, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import { GUEST_KEEP_MS, guestRefusal, type GuestSource } from '@shared/contract-work-guests'
import type { WorkCtx } from '../modules'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { PUBLIC_ROUTES } from '../service/routes'
import { callerKey, cutDue, guestThreads, LIMITS, plainBody, Window } from '../service/routes/guests'
import { servicePaths } from '../service/config'
import { startWorkService, type RunningService } from '../service/serve'
import { guestLinkKind, guestsTools } from '.'
import { ActNotSent } from '../outbox/kinds'
import { GuestRuntime } from './links'
import { ensureGuestTables, GuestStore, hashSecret } from './store'

/*
 * Guest links end to end in process: main's runtime (rows, tokens it signs,
 * the list it sends) and the real Work service (routes, Hocuspocus, the sheet
 * route) against a fake LifeOS. Every refusal the plan names is tried here.
 */

const SECRET = 's'.repeat(43)
const DOC = 'kdoc1'
const OTHER = 'kdoc2'
const open: { dirs: string[]; services: RunningService[]; clients: CollaborationClient[]; convex: FakeConvex[] } = { dirs: [], services: [], clients: [], convex: [] }

beforeEach(() => {
  LIMITS.requests.clear()
  LIMITS.failures.clear()
  LIMITS.comments.clear()
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
  const rt = new GuestRuntime(ctx, () => ({ tokenSigner: () => signer, setLinks: (links) => service.setLinks(links), setProject: (id, project) => service.setProject(id, project) }))
  return { rt, service, convex, db, signer, shared, logs, base }
}

const doc = (id = DOC): GuestSource => ({ at: 'lifeos', table: 'docs', id })
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

  it('after a restart, a live link reaches the service only once LifeOS takes its item\'s shared again', async () => {
    const r = await rig()
    const a = await make(r, 'view')
    const ctx = (r.rt as unknown as { ctx: WorkCtx }).ctx
    let up = false
    const flaky = { ...ctx, lifeos: { owner: () => ({ ...ctx.lifeos.owner(), mutation: async (fn: string, args: never) => (up ? ctx.lifeos.owner().mutation(fn, args) : Promise.reject(new Error('LifeOS is down'))) }) } } as unknown as WorkCtx
    const sent: string[][] = []
    const rt = new GuestRuntime(flaky, () => ({ tokenSigner: () => r.signer, setProject: (id, project) => r.service.setProject(id, project), setLinks: (l) => (sent.push(l.map((x) => x.linkId)), r.service.setLinks(l)) }))
    await rt.tick()
    expect(sent.at(-1)).toEqual([])
    expect((await opened(r, a.id, a.secret)).status).toBe(403)
    up = true
    await rt.tick()
    expect(sent.at(-1)).toEqual([a.id])
    expect((await opened(r, a.id, a.secret)).status).toBe(200)
  })

  it('the thread that asked is told the link, never its address', async () => {
    const r = await rig()
    const told: string[] = []
    const ctx = { ...(r.rt as unknown as { ctx: WorkCtx }).ctx, item: { sessionId: 't1' }, threads: { resume: async (_s: string, notice: string) => void told.push(notice) } }
    const got = await guestLinkKind.execute({ source: doc(), title: 'Run of show', name: 'Dana Lee', role: 'view', expiresAt: inDays(7) }, ctx as never)
    expect(told).toHaveLength(1)
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
      scope: { sector: 'life' },
      held: { create: (a: unknown) => (held.push(a), { state: 'held', ref: { at: 'host', id: 'h1' } }) }
    }
    const out = await tool.run(tool.input.parse({ docId: DOC, name: 'Dana Lee', role: 'edit', days: 7 }), ctx as never)
    expect(out.isError).toBeFalsy()
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
    const { url } = await r.rt.ticket(doc(), 'Run of show')
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
