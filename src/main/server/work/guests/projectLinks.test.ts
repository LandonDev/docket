import { request } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCollaborationClient, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import { WebSocket } from 'ws'
import { guestRefusal, type GuestSource } from '@shared/contract-work-guests'
import { GUEST_PROJECTION_KEYS, guestProjectionOf, projectionItems } from '@shared/work/guestProjection'
import type { WorkCtx } from '../modules'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { LIMITS } from '../service/routes/guests'
import { servicePaths } from '../service/config'
import { startWorkService, type RunningService } from '../service/serve'
import type { ServiceProject } from '../service/wire'
import { guestLinkKind, guestsTools } from '.'
import { ActNotSent } from '../outbox/kinds'
import { GuestRuntime } from './links'
import { ensureGuestTables } from './store'

/*
 * A project's guest link end to end in process (docs/agents/work-guests.md
 * "A project's link"): main's runtime on a LifeOS that stands in (its live
 * `projects:guestView`, its `shared` marks) and the real Work service. What
 * is proven is the boundary: the guest gets the projection and the
 * documents and sheets it lists, read only, and nothing else of the project.
 */

const SECRET = 's'.repeat(43)
const PROJECT = 'kproj1'
const DESC = 'kdesc'
const RUN = 'kdocrun'
const LATE = 'kdoclate'
const OUTSIDE = 'kdocout'
const SHEET = 'ksheet1'
const open: { dirs: string[]; services: RunningService[]; clients: CollaborationClient[]; convex: FakeConvex[]; sockets: WebSocket[] } = { dirs: [], services: [], clients: [], convex: [], sockets: [] }

beforeEach(() => {
  LIMITS.requests.clear()
  LIMITS.failures.clear()
  LIMITS.comments.clear()
})
afterEach(async () => {
  for (const ws of open.sockets.splice(0)) ws.terminate()
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
const inDays = (d: number) => Date.now() + d * 24 * 60 * 60_000

/** LifeOS's answer to `projects:guestView`, with the things the cut must never pass on planted in it. */
const view = (docs: string[] = [RUN], sheets: string[] = [SHEET]) => ({
  project: { id: PROJECT, name: 'Spring LAN', status: 'active', description: 'Two days in the Union ballroom.', docId: DESC, sector: 'purdue', linearProjectId: 'LIN-1' },
  counts: { todo: 1, doing: 1, waiting: 0, done: 0 },
  tasks: [
    { id: 'ktask1', key: 'PUR-1', parentId: null, rank: 'a', title: 'Book the ballroom', status: 'doing', priority: 'high', dueAt: 1, notes: 'Ask Dana.', waitingOn: 'Marcus Reed', rawMessageId: 'kraw1', mailThreadId: 'kmail1' },
    { id: 'ktask2', key: 'PUR-2', parentId: 'ktask1', rank: 'b', title: 'Network for 64 seats', status: 'todo', priority: null, dueAt: null, notes: '' }
  ],
  truncated: false,
  docs: docs.map((id) => ({ id, title: `Doc ${id}`, sector: 'purdue' })),
  sheets: sheets.map((id) => ({ id, title: 'Budget' })),
  comments: [{ body: 'A comment only he reads' }],
  changes: [{ line: 'A history line' }]
})

interface Rig {
  rt: GuestRuntime
  ctx: WorkCtx
  service: RunningService
  convex: FakeConvex
  db: DatabaseSync
  signer: CollabSigner
  /** every `shared` LifeOS was told, in order */
  shared: { key: string; shared: boolean }[]
  /** every projection the service was sent, in order (null: taken away) */
  sent: { linkId: string; project: ServiceProject | null }[]
  /** LifeOS's live answer changes: every watcher hears it */
  setView(next: unknown): void
  /** how many live reads of the project LifeOS holds */
  watchers(): number
  socketPath: string
  base: string
  /** LifeOS as the rig plays it: refusing every mark, out of reach, or without the project any more */
  lifeos: { fail: boolean; up: boolean; deleted: boolean }
}

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'p7-'))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  for (const id of [DESC, RUN, LATE, OUTSIDE]) convex.docs.set(id, { _id: id, sector: 'purdue', seq: 0, title: id, shared: false, markdown: '', plain: '' })
  convex.sheets.set(SHEET, { title: 'Budget', sector: 'purdue', ops: [] })
  const keys = await generateCollabKeys('k')
  const signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  const hosted = join(dir, 'hosted')
  mkdirSync(join(hosted, 'guest'), { recursive: true })
  writeFileSync(join(hosted, 'guest', 'index.html'), '<!doctype html><p>guest page</p>')
  mkdirSync(join(dir, 'data'), { recursive: true })
  const socketPath = servicePaths(join(dir, 'data')).socketPath
  const service = await startWorkService(
    {
      port: 0,
      socketPath,
      secret: SECRET,
      dataDir: join(dir, 'data', 'work-service'),
      hostedDir: hosted,
      host: 'env_box',
      lifeos: { here: true, url: convex.url },
      trusted: [{ by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }],
      links: []
    },
    { jwt: async () => 'owner-jwt', log: () => {} }
  )
  open.services.push(service)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('work.ownerName', 'Landon Hale')
  ensureGuestTables(db)
  const shared: Rig['shared'] = []
  const sent: Rig['sent'] = []
  const lifeos = { fail: false, up: true, deleted: false }
  let projectShared = false
  let current: unknown = view()
  const watchers = new Set<(v: unknown) => void>()
  // As LifeOS: nothing is answered for a project that is not shared.
  const answer = (): unknown => (projectShared ? current : null)
  const base = `http://127.0.0.1:${service.port}`
  const ctx = {
    db,
    host: 'env_box',
    log: () => {},
    push: () => {},
    service: { url: (route: string) => `${base}${route}`, token: async () => 'ok', internal: async () => ({ seen: {} }) },
    lifeos: {
      connected: () => lifeos.up,
      owner: () => ({
        query: async (fn: string, args: { id: string }) => {
          if (fn === 'projects:get') return args.id === PROJECT && !lifeos.deleted ? { project: { sector: 'purdue', name: 'Spring LAN' } } : null
          return convex.docs.get(args.id) ?? null
        },
        mutation: async (fn: string, args: { id: string; shared: boolean }) => {
          if (!fn.endsWith(':setShared')) return null
          if (lifeos.fail) throw new Error('LifeOS is down')
          const table = fn.split(':')[0]!
          if (table === 'projects' && lifeos.deleted) throw new Error('no such project')
          shared.push({ key: `${table}:${args.id}`, shared: args.shared })
          // The row the Work service's write guard reads.
          if (table === 'docs' && convex.docs.has(args.id)) convex.docs.get(args.id)!.shared = args.shared
          if (table === 'projects') {
            projectShared = args.shared
            // As LifeOS does: a project's description is marked with the project, both ways, with no word to the caller.
            convex.docs.get(DESC)!.shared = args.shared
            for (const w of [...watchers]) w(answer())
          }
          return null
        }
      }),
      subscribe: (_fn: string, _args: unknown, on: (v: unknown) => void) => {
        watchers.add(on)
        queueMicrotask(() => watchers.has(on) && on(answer()))
        return () => void watchers.delete(on)
      }
    }
  } as unknown as WorkCtx
  const rt = new GuestRuntime(ctx, () => ({
    tokenSigner: () => signer,
    setLinks: (links) => service.setLinks(links),
    setProject: (linkId, project) => (sent.push({ linkId, project }), service.setProject(linkId, project))
  }))
  return {
    rt,
    ctx,
    service,
    convex,
    db,
    signer,
    shared,
    sent,
    setView: (next) => {
      current = next
      for (const w of [...watchers]) w(answer())
    },
    watchers: () => watchers.size,
    socketPath,
    base,
    lifeos
  }
}

const project: GuestSource = { at: 'lifeos', table: 'projects', id: PROJECT }
const docSource = (id: string): GuestSource => ({ at: 'lifeos', table: 'docs', id })

async function make(r: Rig, source: GuestSource = project, role: 'view' | 'edit' = 'view') {
  const made = await r.rt.create({ source, title: 'Spring LAN', name: 'Dana Lee', role, expiresAt: inDays(30), bySession: null })
  return { id: made.link.id, secret: new URL(made.url).hash.replace('#k=', '') }
}
const post = (r: Rig, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${r.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const opened = async (r: Rig, id: string, secret: string) => {
  const res = await post(r, `/g/${id}/open`, { secret })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const itemOf = async (r: Rig, id: string, secret: string, table: string, item: string) => {
  const res = await post(r, `/g/${id}/item`, { secret, table, id: item })
  return { status: res.status, body: (await res.json()) as Record<string, string> }
}
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>
function socket(r: Rig, path: string, name: string, token: string) {
  const closes: string[] = []
  const client = createCollaborationClient({ documentName: name, token, url: `ws://127.0.0.1:${r.service.port}${path}`, offline: false, onClose: (why) => closes.push(why) })
  open.clients.push(client)
  return { client, closes }
}
const synced = (c: CollaborationClient) => c.provider.isSynced && !c.provider.hasUnsyncedChanges
const last = (r: Rig, key: string) => r.shared.filter((s) => s.key === key).at(-1)?.shared

/** A raw socket's fate: the HTTP status that refused it, or the close code once it was open. */
function raw(r: Rig, path: string): { ws: WebSocket; refused: Promise<number>; closed: Promise<number>; messages: Record<string, unknown>[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${r.service.port}${path}`)
  open.sockets.push(ws)
  const messages: Record<string, unknown>[] = []
  ws.on('message', (d) => messages.push(JSON.parse(String(d)) as Record<string, unknown>))
  ws.on('error', () => {})
  return {
    ws,
    messages,
    refused: new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))),
    closed: new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  }
}

function internal(socketPath: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

describe('the cut', () => {
  it('holds no key outside the allowed list, whatever LifeOS answers', () => {
    const p = guestProjectionOf(view())!
    expect(Object.keys(p).sort()).toEqual([...GUEST_PROJECTION_KEYS.top].sort())
    expect(Object.keys(p.project).sort()).toEqual([...GUEST_PROJECTION_KEYS.project].sort())
    expect(Object.keys(p.counts).sort()).toEqual([...GUEST_PROJECTION_KEYS.counts].sort())
    for (const task of p.tasks) expect(Object.keys(task).sort()).toEqual([...GUEST_PROJECTION_KEYS.task].sort())
    for (const item of [...p.docs, ...p.sheets]) expect(Object.keys(item).sort()).toEqual([...GUEST_PROJECTION_KEYS.item].sort())
    const words = JSON.stringify(p)
    for (const never of ['Marcus Reed', 'kraw1', 'kmail1', 'A comment only he reads', 'A history line', 'LIN-1', 'purdue']) expect(words).not.toContain(never)
    expect(projectionItems(p)).toEqual([`docs:${DESC}`, `docs:${RUN}`, `sheets:${SHEET}`])
  })

  it('reads an answer that is no projection as nothing, and drops a row with no id or a state it does not know', () => {
    expect(guestProjectionOf(null)).toBeNull()
    expect(guestProjectionOf({ project: { id: PROJECT, status: 'secret' } })).toBeNull()
    const p = guestProjectionOf({ ...view(), tasks: [{ id: 'k1', status: 'dropped', title: 'x' }, { title: 'no id', status: 'todo' }], docs: [{ id: '../etc', title: 'x' }] })!
    expect(p.tasks).toEqual([])
    expect(p.docs).toEqual([])
  })

  it('a project link can only view', () => {
    expect(guestRefusal({ source: project, role: 'edit', expiresAt: inDays(3) })).toBe('A project link can view.')
    expect(guestRefusal({ source: project, role: 'comment', expiresAt: inDays(3) })).toBe('A project link can view.')
    expect(guestRefusal({ source: project, role: 'view', expiresAt: inDays(3) })).toBeNull()
  })
})

describe("a project's link", () => {
  it('marks the project and everything it shows before the service hears of it, and opens to the projection alone', async () => {
    const r = await rig()
    const a = await make(r)
    // The project first (LifeOS answers nothing of a project it does not read as shared), then each document and sheet.
    expect(r.shared[0]).toEqual({ key: `projects:${PROJECT}`, shared: true })
    expect(r.shared.map((s) => s.key).sort()).toEqual([`docs:${DESC}`, `docs:${RUN}`, `projects:${PROJECT}`, `sheets:${SHEET}`].sort())
    expect(r.shared.every((s) => s.shared)).toBe(true)
    // The service was never sent an item LifeOS had not yet marked.
    expect(r.sent.at(-1)!.project!.projection.docs.map((d) => d.id)).toEqual([RUN])
    const got = await opened(r, a.id, a.secret)
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ kind: 'project', role: 'view', name: 'Dana Lee', title: 'Spring LAN', owner: 'Landon Hale', me: `guest:${a.id}` })
    expect(got.body.token).toBeUndefined()
    const words = JSON.stringify(got.body)
    // A comment and a history line are never sent; nor whom a task waits on, nor where it came from.
    for (const never of ['A comment only he reads', 'A history line', 'Marcus Reed', 'kraw1', 'kmail1']) expect(words).not.toContain(never)
    expect((got.body.projection as { tasks: unknown[] }).tasks).toHaveLength(2)
    // A wrong secret, and no secret, get the one answer every unknown link gets.
    expect(await opened(r, a.id, 'x'.repeat(43))).toEqual({ status: 403, body: { error: 'gone' } })
    expect(await opened(r, a.id, '')).toEqual({ status: 403, body: { error: 'gone' } })
  })

  it("hands a listed document as its text and a listed sheet a view token bound to the link and the sheet, and answers anything else as gone", async () => {
    const r = await rig()
    await r.service.collab.writeMarkdown(RUN, 'owner', '# Saturday\n\nCheck-in opens at the north doors.')
    const a = await make(r)
    for (const id of [RUN, DESC]) {
      const got = await itemOf(r, a.id, a.secret, 'docs', id)
      expect(got.status).toBe(200)
      expect(got.body).toMatchObject({ kind: 'doc', role: 'view', me: `guest:${a.id}`, doc: id })
      // No token: a project's document has no socket to open.
      expect(got.body.token).toBeUndefined()
    }
    expect((await itemOf(r, a.id, a.secret, 'docs', RUN)).body.markdown).toContain('north doors')
    // Main signs nothing for a document of a project's link.
    expect(Object.keys(r.sent.at(-1)!.project!.tokens)).toEqual([`sheets:${SHEET}`])
    const sheet = await itemOf(r, a.id, a.secret, 'sheets', SHEET)
    expect(sheet.status).toBe(200)
    expect(sheet.body).toMatchObject({ kind: 'sheet', role: 'view', me: `guest:${a.id}`, sheet: SHEET })
    expect(claimsOf(sheet.body.token!)).toMatchObject({ sheet: SHEET, role: 'view', link: a.id, principal: `guest:${a.id}` })
    // A document of the same owner that is not the project's, an id that is none, a table that is none, a wrong secret.
    for (const [table, id, secret] of [['docs', OUTSIDE, a.secret], ['docs', 'nosuchdoc', a.secret], ['sheets', RUN, a.secret], ['projects', PROJECT, a.secret], ['tasks', 'ktask1', a.secret], ['docs', RUN, 'x'.repeat(43)]] as const) {
      expect(await itemOf(r, a.id, secret, table, id)).toEqual({ status: 403, body: { error: 'gone' } })
    }
    // A document's own link has no items.
    const d = await make(r, docSource(OUTSIDE), 'edit')
    expect((await itemOf(r, d.id, d.secret, 'docs', OUTSIDE)).status).toBe(403)
  })

  it("shows a document as it stands now: no words he deleted, no mark of his comments, and no socket of the document on any route", async () => {
    const r = await rig()
    await r.service.collab.writeMarkdown(RUN, 'owner', 'The venue fee is 4,000 dollars, which we cannot pay.\n\nCheck-in opens at the north doors.')
    const a = await make(r)
    // He comments on some words and cuts a sentence: both stay in the live room's state, and neither is the guest's to see.
    expect(await r.service.collab.markThread(RUN, 'owner', 'north doors', 'kthreadsecret')).toBe(true)
    await r.service.collab.writeMarkdown(RUN, 'owner', 'Check-in opens at the north doors.')
    const got = await itemOf(r, a.id, a.secret, 'docs', RUN)
    expect(got.body.markdown).toContain('Check-in opens at the north doors.')
    const words = JSON.stringify(got.body)
    for (const never of ['4,000', 'cannot pay', 'kthreadsecret']) expect(words).not.toContain(never)
    // No socket for a document of a project's link: not the link's bare one, not one named for the document, not a task's.
    expect(await raw(r, `/g/ws/${a.id}`).refused).toBe(404)
    expect(await raw(r, `/g/ws/${a.id}/docs/${RUN}`).refused).toBe(404)
    expect(await raw(r, `/g/ws/${a.id}/tasks/ktask1`).refused).toBe(404)
    // The sheet's token is the one token the link has: it opens no document's room, and no comment route.
    const { token } = (await itemOf(r, a.id, a.secret, 'sheets', SHEET)).body
    for (const name of [RUN, OUTSIDE]) {
      const stray = socket(r, `/w/doc/${name}`, name, token!)
      await new Promise((res) => setTimeout(res, 300))
      expect(synced(stray.client)).toBe(false)
    }
    const auth = { Authorization: `Bearer ${token}` }
    expect((await fetch(`${r.base}/g/${a.id}/threads`, { headers: auth })).status).toBe(403)
    expect((await post(r, `/g/${a.id}/comment`, { quote: 'north', text: 'hello' }, auth)).status).toBe(403)
    expect(r.convex.threads).toEqual([])
  })

  it('a listed sheet opens on its socket, a view link writes nothing there, and a sheet outside the project is refused', async () => {
    const r = await rig()
    const a = await make(r)
    const { token } = (await itemOf(r, a.id, a.secret, 'sheets', SHEET)).body
    const s = raw(r, `/g/ws/${a.id}/sheets/${SHEET}`)
    await new Promise((res) => s.ws.on('open', res))
    s.ws.send(JSON.stringify({ t: 'hello', token }))
    await until('the workbook arrives', () => s.messages.some((m) => m.t === 'state'))
    s.ws.send(JSON.stringify({ t: 'ops', id: 1, baseRev: 0, mutations: [{ id: 'sheet.mutation.set-range-values', params: { unitId: SHEET, subUnitId: 'sheet1', cellValue: { 0: { 0: { v: 1 } } } } }] }))
    await until('the op is refused', () => s.messages.some((m) => m.t === 'refused'))
    expect(r.convex.sheets.get(SHEET)!.ops).toEqual([])
    expect(await raw(r, `/g/ws/${a.id}/sheets/ksheetother`).refused).toBe(404)
    // The sheet leaves the project: its socket closes within the second.
    const before = Date.now()
    r.setView(view([RUN], []))
    expect(await s.closed).toBe(4403)
    expect(Date.now() - before).toBeLessThan(1500)
  })

  it('a document that leaves the project is handed no more, and only then loses its mark', async () => {
    const r = await rig()
    const a = await make(r)
    expect((await itemOf(r, a.id, a.secret, 'docs', RUN)).status).toBe(200)
    const sentBefore = r.sent.length
    r.setView(view([], [SHEET]))
    await until('the mark comes off', () => last(r, `docs:${RUN}`) === false)
    // The service heard first: the projection without the document was sent before LifeOS was told.
    expect(r.sent[sentBefore]!.project!.projection.docs).toEqual([])
    expect((await itemOf(r, a.id, a.secret, 'docs', RUN)).status).toBe(403)
    // The rest of the project still stands.
    expect((await opened(r, a.id, a.secret)).status).toBe(200)
    expect(last(r, `docs:${DESC}`)).toBe(true)
  })

  it('never unmarks a document the service still shows: a read that changed while the list was being signed waits for the next pass', async () => {
    const r = await rig()
    const a = await make(r)
    // The runtime as it stands when a newer read landed after the service was sent the older one.
    const rt = r.rt as unknown as { watched: Map<string, { projection: unknown }>; reconcile(): Promise<{ told: number }> }
    rt.watched.get(PROJECT)!.projection = guestProjectionOf(view([], [SHEET]))
    const before = r.shared.length
    await rt.reconcile()
    // The service still lists the run of show, so its mark stays.
    expect(r.shared.slice(before)).toEqual([])
    expect((await itemOf(r, a.id, a.secret, 'docs', RUN)).status).toBe(200)
    // The next pass tells the service, then LifeOS.
    await r.rt.tick()
    expect((await itemOf(r, a.id, a.secret, 'docs', RUN)).status).toBe(403)
    expect(last(r, `docs:${RUN}`)).toBe(false)
  })

  it('a document that joins is marked shared before the guest is shown it', async () => {
    const r = await rig()
    const a = await make(r)
    r.lifeos.fail = true
    r.setView(view([RUN, LATE]))
    await new Promise((res) => setTimeout(res, 100))
    // LifeOS did not take the mark: the guest is not shown the document, and cannot open it.
    expect(((await opened(r, a.id, a.secret)).body.projection as { docs: { id: string }[] }).docs.map((d) => d.id)).toEqual([RUN])
    expect((await itemOf(r, a.id, a.secret, 'docs', LATE)).status).toBe(403)
    r.lifeos.fail = false
    await r.rt.tick()
    expect(last(r, `docs:${LATE}`)).toBe(true)
    expect(((await opened(r, a.id, a.secret)).body.projection as { docs: { id: string }[] }).docs.map((d) => d.id)).toEqual([RUN, LATE])
    expect((await itemOf(r, a.id, a.secret, 'docs', LATE)).status).toBe(200)
  })

  /** A guest's sheet socket, said hello on. */
  async function sheetSocket(r: Rig, linkId: string, token: string) {
    const s = raw(r, `/g/ws/${linkId}/sheets/${SHEET}`)
    await new Promise((res) => s.ws.on('open', res))
    s.ws.send(JSON.stringify({ t: 'hello', token }))
    return s
  }

  it('revoked, it closes its sheet within a second, opens nothing, and unmarks all it showed; a document with a link of its own stays shared', async () => {
    const r = await rig()
    const a = await make(r)
    const own = await make(r, docSource(RUN), 'edit')
    const s = await sheetSocket(r, a.id, (await itemOf(r, a.id, a.secret, 'sheets', SHEET)).body.token!)
    await until('the workbook arrives', () => s.messages.some((m) => m.t === 'state'))
    const before = Date.now()
    await r.rt.revoke(a.id)
    expect(await s.closed).toBe(4403)
    expect(Date.now() - before).toBeLessThan(1500)
    expect((await opened(r, a.id, a.secret)).status).toBe(403)
    expect((await itemOf(r, a.id, a.secret, 'docs', RUN)).status).toBe(403)
    expect(await raw(r, `/g/ws/${a.id}/sheets/${SHEET}`).refused).toBe(404)
    expect(r.sent.at(-1)).toEqual({ linkId: a.id, project: null })
    expect(last(r, `projects:${PROJECT}`)).toBe(false)
    expect(last(r, `docs:${DESC}`)).toBe(false)
    expect(last(r, `sheets:${SHEET}`)).toBe(false)
    // The run of show has a guest link of its own: it stays shared, and that link still opens.
    expect(last(r, `docs:${RUN}`)).toBe(true)
    expect((await opened(r, own.id, own.secret)).status).toBe(200)
    expect(r.watchers()).toBe(0)
  })

  it('a revoke reaches the service at once, ahead of a pass that waits on LifeOS', async () => {
    const r = await rig()
    const a = await make(r)
    // LifeOS takes its time over a mark: a pass sits in it.
    let release!: () => void
    const slow = new Promise<void>((res) => (release = res))
    const owner = r.ctx.lifeos.owner()
    const ctx = r.ctx as unknown as { lifeos: { owner(): unknown } }
    ctx.lifeos.owner = () => ({ ...owner, mutation: async (fn: string, args: never) => (await slow, owner.mutation(fn, args)) })
    r.setView(view([RUN, LATE]))
    await new Promise((res) => setTimeout(res, 50))
    const revoked = r.rt.revoke(a.id)
    await until('the service knows', () => r.sent.at(-1)?.project === null, 1000)
    expect((await opened(r, a.id, a.secret)).status).toBe(403)
    release()
    await revoked
  })

  it("its description keeps its mark when the description has a guest link of its own and the project's link is revoked", async () => {
    const r = await rig()
    const a = await make(r)
    const own = await make(r, docSource(DESC), 'edit')
    await r.rt.revoke(a.id)
    // LifeOS cleared the description's mark with the project's; main tells it again, since a live link still shows it.
    expect(r.convex.docs.get(DESC)!.shared).toBe(true)
    expect(last(r, `docs:${DESC}`)).toBe(true)
    expect((await opened(r, own.id, own.secret)).status).toBe(200)
    // And an agent's write there still waits as a suggestion.
    const held = await internal(r.socketPath, '/internal/doc/write', { docId: DESC, markdown: 'An agent wrote this.', because: 'own', botId: 'key1', fence: { sectors: 'all' } })
    expect(held).toMatchObject({ status: 200, body: { mode: 'branch' } })
  })

  it("takes only its own link's token on a sheet's socket", async () => {
    const r = await rig()
    const a = await make(r)
    const b = await make(r)
    const tokenB = (await itemOf(r, b.id, b.secret, 'sheets', SHEET)).body.token!
    // Link B's token on link A's address: refused, though both links list the sheet.
    const crossed = await sheetSocket(r, a.id, tokenB)
    expect(await crossed.closed).toBe(4403)
    const straight = await sheetSocket(r, b.id, tokenB)
    await until('the workbook arrives', () => straight.messages.some((m) => m.t === 'state'))
  })

  it('shows nothing while LifeOS has been out of reach a minute, and shows the project again when it answers', async () => {
    const r = await rig()
    const a = await make(r)
    const s = await sheetSocket(r, a.id, (await itemOf(r, a.id, a.secret, 'sheets', SHEET)).body.token!)
    await until('the workbook arrives', () => s.messages.some((m) => m.t === 'state'))
    r.lifeos.up = false
    await r.rt.tick()
    // Out of reach, but not yet for a minute: the last read stands.
    expect((await opened(r, a.id, a.secret)).status).toBe(200)
    ;(r.rt as unknown as { lifeosDownSince: number }).lifeosDownSince = Date.now() - 61_000
    await r.rt.tick()
    // The read may be old now: the page is told to try again, a listed document is not handed, the sheet's socket closes. No mark comes off.
    expect((await opened(r, a.id, a.secret)).status).toBe(503)
    expect((await itemOf(r, a.id, a.secret, 'docs', RUN)).status).toBe(403)
    expect(await s.closed).toBe(4403)
    expect(r.shared.every((x) => x.shared)).toBe(true)
    r.lifeos.up = true
    await r.rt.tick()
    expect((await opened(r, a.id, a.secret)).status).toBe(200)
  })

  it('ends when LifeOS no longer has the project: the link is not listed as live and not tried again', async () => {
    const r = await rig()
    const a = await make(r)
    r.lifeos.deleted = true
    r.setView(null)
    await new Promise((res) => setTimeout(res, 50))
    await r.rt.tick()
    await r.rt.tick()
    expect(r.rt.store.live()).toEqual([])
    expect(r.rt.store.get(a.id)!.revokedAt).not.toBeNull()
    expect((await opened(r, a.id, a.secret)).status).toBe(403)
  })

  it('ended, it is gone at the next pass and its marks come off', async () => {
    const r = await rig()
    const a = await make(r)
    const s = await sheetSocket(r, a.id, (await itemOf(r, a.id, a.secret, 'sheets', SHEET)).body.token!)
    await until('the workbook arrives', () => s.messages.some((m) => m.t === 'state'))
    r.db.prepare('UPDATE work_guest_links SET expires_at = ? WHERE id = ?').run(Date.now() - 1, a.id)
    const before = Date.now()
    await r.rt.tick()
    expect(await s.closed).toBe(4403)
    expect(Date.now() - before).toBeLessThan(1500)
    expect((await opened(r, a.id, a.secret)).status).toBe(403)
    for (const key of [`projects:${PROJECT}`, `docs:${DESC}`, `docs:${RUN}`, `sheets:${SHEET}`]) expect(last(r, key)).toBe(false)
  })

  it('after a restart, what an ended link showed is still unmarked: the marks are kept with the rows', async () => {
    const r = await rig()
    const a = await make(r)
    r.db.prepare('UPDATE work_guest_links SET expires_at = ? WHERE id = ?').run(Date.now() - 1, a.id)
    // A new runtime on the same database: it has read nothing of the project.
    const told: Rig['shared'] = []
    const fresh = { ...r.ctx, lifeos: { ...r.ctx.lifeos, owner: () => ({ ...r.ctx.lifeos.owner(), mutation: async (fn: string, args: { id: string; shared: boolean }) => void told.push({ key: `${fn.split(':')[0]}:${args.id}`, shared: args.shared }) }) } } as unknown as WorkCtx
    const rt = new GuestRuntime(fresh, () => ({ tokenSigner: () => r.signer, setLinks: () => {}, setProject: () => {} }))
    await rt.tick()
    expect(told.sort((x, y) => x.key.localeCompare(y.key))).toEqual([`docs:${DESC}`, `docs:${RUN}`, `projects:${PROJECT}`, `sheets:${SHEET}`].sort().map((key) => ({ key, shared: false })))
    expect(rt.store.marks()).toEqual([])
  })

  it('is not made when LifeOS does not mark the project', async () => {
    const r = await rig()
    r.lifeos.fail = true
    await expect(make(r)).rejects.toBeInstanceOf(ActNotSent)
    expect(r.rt.store.live()).toEqual([])
    expect(r.sent).toEqual([])
    expect(r.watchers()).toBe(0)
  })

  it("an agent's write to a document of a shared project waits as a suggestion, where a private document takes it", async () => {
    const r = await rig()
    const fence = { sectors: 'all' }
    const direct = await internal(r.socketPath, '/internal/doc/write', { docId: OUTSIDE, markdown: 'A private note.', because: 'own', botId: 'key1', fence })
    expect(direct).toMatchObject({ status: 200, body: { mode: 'direct' } })
    await make(r)
    // The project's link marked the document where the Work service's write guard reads it.
    expect(r.convex.docs.get(RUN)!.shared).toBe(true)
    expect(r.convex.docs.get(DESC)!.shared).toBe(true)
    for (const docId of [RUN, DESC]) {
      const held = await internal(r.socketPath, '/internal/doc/write', { docId, markdown: 'What the guest would read.', because: 'asked', botId: 'key1', fence })
      expect(held).toMatchObject({ status: 200, body: { mode: 'branch' } })
    }
    // And a bot's comment there is refused, as on any shared document.
    expect((await internal(r.socketPath, '/internal/doc/comment', { docId: RUN, anchorText: 'x', body: 'y', botId: 'key1', fence })).status).toBe(403)
  })

  it('has no hosted-editor ticket: that opens a document or a sheet', async () => {
    const r = await rig()
    await expect(r.rt.ticket(project, 'Spring LAN')).rejects.toThrow('The hosted editor opens a document or a sheet.')
  })
})

describe('an agent asking for a project', () => {
  it('holds share.guestLink for the project, view only, inside its sector; his press makes the link', async () => {
    const r = await rig()
    const held: { payload: { source: GuestSource; role: string; title: string } }[] = []
    const tool = guestsTools.find((t) => t.name === 'guest_link')!
    const ctx = { ...r.ctx, sessionId: 'thread1', scope: { sector: 'purdue' }, held: { create: (a: never) => (held.push(a), { state: 'held', ref: { at: 'host', id: 'h1' } }) } }
    const out = await tool.run(tool.input.parse({ projectId: PROJECT, name: 'Dana Lee', days: 7 }), ctx as never)
    expect(out.isError).toBeFalsy()
    expect(held).toEqual([{ kind: 'share.guestLink', sessionId: 'thread1', payload: expect.objectContaining({ source: project, name: 'Dana Lee', role: 'view', title: 'Spring LAN' }) }])
    expect(guestLinkKind.words(held[0]!.payload as never)).toEqual({ summary: 'Make a guest link for Dana Lee: Spring LAN', verb: 'Create link' })
    // More than view, two things at once, another sector's project and one LifeOS does not have are all refused, and hold nothing.
    for (const args of [{ projectId: PROJECT, name: 'X', role: 'edit' }, { projectId: PROJECT, docId: RUN, name: 'X' }, { projectId: 'knone', name: 'X' }, { name: 'X' }]) expect((await tool.run(tool.input.parse(args), ctx as never)).isError).toBe(true)
    expect((await tool.run(tool.input.parse({ projectId: PROJECT, name: 'X' }), { ...ctx, scope: { sector: 'cosmic' } } as never)).isError).toBe(true)
    expect(held).toHaveLength(1)
    // His press: the link is made, with no thread told an address.
    const made = await guestLinkKind.execute(held[0]!.payload as never, { ...r.ctx, item: { sessionId: null }, threads: { resume: async () => {} } } as never)
    const linkId = (made.ref as { linkId: string }).linkId
    expect(r.rt.store.get(linkId)).toMatchObject({ source: project, role: 'view', name: 'Dana Lee' })
  })
})
