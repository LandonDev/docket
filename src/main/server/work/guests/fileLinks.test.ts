import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket as WsSocket } from 'ws'
import { createCollaborationClient, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, fileDocName, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import { guestRefusal, type GuestLinkAct } from '@shared/contract-work-guests'
import { SHARE_REFUSALS } from '@shared/work/guestRoles'
import { FenceError } from '../../remote/fence'
import { othersOpen } from '../docs/target'
import type { Caller, WorkCtx } from '../modules'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { LIMITS } from '../service/routes/guests'
import { servicePaths } from '../service/config'
import { startWorkService, type RunningService } from '../service/serve'
import { TcsheetBackend } from '../sheets/host/backends'
import { guestLinkKind, guests, guestsTools } from '.'
import { fileSheetId, GuestRuntime } from './links'
import { ensureGuestTables, fileLinked, guestLinkedFile } from './store'

/*
 * A guest link to a TempCode document or sheet kept as a file (the Share sheet's own links): what may be shared and
 * the words for what may not, the guest and the owner live on one .tcdoc both ways, a .tcsheet's socket held to its
 * link, revoke and a changed role within seconds, an agent's own writes made suggestions while a link stands, and a
 * thread's request held for his press.
 */

const shared = vi.hoisted(() => ({ paths: new Set<string>() }))
vi.mock('../files/policy', async (real) => ({ ...(await real<typeof import('../files/policy')>()), sharedOf: (_ctx: unknown, source: { path?: string }) => !!source.path && shared.paths.has(source.path) }))

const LOCAL: Caller = { kind: 'local', caps: [] }
const PHONE: Caller = { kind: 'remote', caps: ['read', 'operate', 'approve'] }
const open: { dirs: string[]; services: RunningService[]; clients: CollaborationClient[]; convex: FakeConvex[]; sockets: WsSocket[] } = { dirs: [], services: [], clients: [], convex: [], sockets: [] }

beforeEach(() => {
  LIMITS.requests.clear()
  LIMITS.failures.clear()
  shared.paths.clear()
  vi.stubEnv('TEMP_CODE_WORK_PUBLIC_ORIGIN', 'https://proof.example')
})
afterEach(async () => {
  vi.unstubAllEnvs()
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

async function rig() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'share-')))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  const keys = await generateCollabKeys('k')
  const signer: CollabSigner = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  const hosted = join(dir, 'hosted')
  mkdirSync(join(hosted, 'guest'), { recursive: true })
  writeFileSync(join(hosted, 'guest', 'index.html'), '<!doctype html><p>guest page</p>')
  const folder = join(dir, 'workspace')
  const outside = join(dir, 'elsewhere')
  for (const d of [join(dir, 'data'), folder, outside]) mkdirSync(d, { recursive: true })
  const service = await startWorkService(
    {
      port: 0,
      socketPath: servicePaths(join(dir, 'data')).socketPath,
      secret: 's'.repeat(43),
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
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, kind TEXT, sector TEXT)')
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Dummy job', ?, 'work', 'life')").run(folder)
  ensureGuestTables(db)
  const base = `http://127.0.0.1:${service.port}`
  const told: unknown[] = []
  const ctx = {
    db,
    host: 'env_box',
    dataDir: join(dir, 'data'),
    log: () => {},
    push: () => {},
    canvas: { get: () => null, paneOf: (s: string) => s },
    // As in the app: a remote key reaches the workspace's folder alone; the host's own callers and threads are not fenced here.
    reaches: (by: Caller, path: string) => by.kind !== 'remote' || path.startsWith(folder + '/'),
    service: { url: (route: string) => `${base}${route}`, token: async () => 'ok', internal: async () => ({}) },
    lifeos: { owner: () => ({ query: async () => null, mutation: async (name: string, args: unknown) => void told.push({ name, args }) }) }
  } as unknown as WorkCtx
  const rt = new GuestRuntime(ctx, () => ({ tokenSigner: () => signer, setLinks: (links) => service.setLinks(links), setProject: (id, project) => service.setProject(id, project) }))
  const doc = join(folder, 'Field trip plan.tcdoc')
  const sheet = join(folder, 'Field trip budget.tcsheet')
  TcsheetBackend.create(sheet, 'Field trip budget')
  // The document is made as his editor makes one: words typed in its room, which the service writes to the file.
  const own = (await signer.sign({ doc: fileDocName(doc), file: { path: doc }, role: 'edit', principal: 'owner' }, 300)).token
  const maker = createCollaborationClient({ documentName: fileDocName(doc), token: own, url: `${base.replace('http', 'ws')}/w/doc/${encodeURIComponent(fileDocName(doc))}`, offline: false })
  await until('synced', () => maker.provider.isSynced)
  maker.document.getText('proof').insert(0, 'Plan: ')
  await until('the file is written', () => existsSync(doc), 8000)
  await maker.destroy()
  return { rt, ctx, db, service, signer, base, folder, outside, doc, sheet, told }
}
type Rig = Awaited<ReturnType<typeof rig>>

const file = (path: string, host = 'env_box') => ({ at: 'file' as const, host, path })
const days = (n: number): number => Date.now() + n * 24 * 60 * 60_000
const secretOf = (url: string): string => new URL(url).hash.replace('#k=', '')
const openLink = async (r: Rig, id: string, secret: string) => {
  const res = await fetch(`${r.base}/g/${id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }) })
  return { status: res.status, body: (await res.json()) as { kind?: string; role?: string; doc?: string; token?: string; comments?: boolean; name?: string } }
}
const client = (url: string, documentName: string, token: string): CollaborationClient => {
  const c = createCollaborationClient({ documentName, token, url, offline: false })
  open.clients.push(c)
  return c
}

describe('what a file link can be for', () => {
  it('takes a .tcdoc or a .tcsheet of his own on this host, and says in one line why not for anything else', async () => {
    const r = await rig()
    const make = (source: ReturnType<typeof file>, by: Caller = LOCAL, role: 'view' | 'comment' | 'edit' = 'edit') => r.rt.create({ source, title: 'T', name: 'Dana', role, expiresAt: days(30), bySession: null, by })
    await expect(make(file(join(r.folder, 'Letter.docx')))).rejects.toThrow(SHARE_REFUSALS.other)
    // A file another host has is that host's to share, as a LifeOS row another host serves.
    await expect(make(file(join(r.folder, 'Mac only.tcdoc'), 'env_mac'))).rejects.toThrow('served elsewhere: env_mac')
    await expect(make(file(join(r.folder, 'Gone.tcdoc')))).rejects.toThrow(SHARE_REFUSALS.gone)
    shared.paths.add(r.doc)
    await expect(make(file(r.doc))).rejects.toThrow(SHARE_REFUSALS.shared)
    shared.paths.clear()
    // A remote key reaches the workspace's folder alone.
    writeFileSync(join(r.outside, 'Private.tcdoc'), '')
    await expect(make(file(join(r.outside, 'Private.tcdoc')), PHONE)).rejects.toBeInstanceOf(FenceError)
    // A .tcdoc keeps its comments on this computer: its link views or edits.
    await expect(make(file(r.doc), LOCAL, 'comment')).rejects.toThrow('A link to this document can view or edit.')
    expect(guestRefusal({ source: file(r.sheet), role: 'comment', expiresAt: days(1) })).toBe('A sheet link can view or edit.')
    // A host whose pages no guest can reach (a Mac, an isolated instance) says so.
    vi.stubEnv('TEMP_CODE_WORK_PUBLIC_ORIGIN', '')
    vi.stubEnv('TEMP_CODE_USER_DATA', join(r.folder, 'instance'))
    await expect(make(file(r.doc))).rejects.toThrow(SHARE_REFUSALS.noPage)
    expect(r.db.prepare('SELECT count(*) AS n FROM work_guest_links').get()).toEqual({ n: 0 })
  })

  it('marks no LifeOS row: the live link itself makes the file read as shared, so an agent only suggests on it', async () => {
    const r = await rig()
    const made = await r.rt.create({ source: file(r.doc), title: 'Field trip plan', name: 'Dana', role: 'edit', expiresAt: days(30), bySession: null, by: LOCAL })
    expect(made.link.source).toMatchObject({ at: 'file', table: 'docs', path: r.doc })
    expect(r.told).toEqual([])
    expect(fileLinked(r.db, r.doc)).toBe(true)
    expect(guestLinkedFile(r.db, file(r.sheet))).toBe(false)
    const target = { at: 'file' as const, doc: fileDocName(r.doc), path: r.doc, source: file(r.doc) }
    expect(othersOpen(r.ctx, target, null)).toBe(true)
    await r.rt.revoke(made.link.id)
    expect(othersOpen(r.ctx, target, null)).toBe(false)
    // One item's list, as the Share sheet asks for it.
    expect((await r.rt.list(r.rt.resolve(file(r.doc), LOCAL))).map((l) => l.id)).toEqual([made.link.id])
  })
})

describe('a file link that no longer fits', () => {
  it('ends for good when its file goes, and a file put in its place later is not shown under it', async () => {
    const r = await rig()
    const made = await r.rt.create({ source: file(r.sheet), title: 'Field trip budget', name: 'Sam', role: 'view', expiresAt: days(7), bySession: null, by: LOCAL })
    rmSync(r.sheet)
    await r.rt.tick()
    expect(r.rt.store.get(made.link.id)?.revokedAt).not.toBeNull()
    TcsheetBackend.create(r.sheet, 'Something else')
    await r.rt.tick()
    expect((await openLink(r, made.link.id, secretOf(made.url))).status).toBe(403)
  })

  it('a document Save As keeps linked to another file can be viewed by a guest, never edited', async () => {
    const r = await rig()
    r.db.exec('CREATE TABLE work_files_links (doc TEXT, target TEXT)')
    r.db.prepare('INSERT INTO work_files_links VALUES (?, ?)').run(r.doc, '/elsewhere/Plan.docx')
    const make = (role: 'view' | 'edit') => r.rt.create({ source: file(r.doc), title: 'Plan', name: 'Dana', role, expiresAt: days(7), bySession: null, by: LOCAL })
    await expect(make('edit')).rejects.toThrow(SHARE_REFUSALS.linkedOut)
    const viewer = await make('view')
    await expect(r.rt.setRole(viewer.link.id, 'edit')).rejects.toThrow(SHARE_REFUSALS.linkedOut)
  })
})

describe('a guest on a .tcdoc', () => {
  it('edits live with the owner both ways on one document; revoke ends the guest within a second', async () => {
    const r = await rig()
    const made = await r.rt.create({ source: file(r.doc), title: 'Field trip plan', name: 'Dana', role: 'edit', expiresAt: days(30), bySession: null, by: LOCAL })
    const opened = await openLink(r, made.link.id, secretOf(made.url))
    expect(opened.status).toBe(200)
    expect(opened.body).toMatchObject({ kind: 'doc', role: 'edit', doc: fileDocName(r.doc), comments: false, name: 'Dana' })
    const ws = r.base.replace('http', 'ws')
    const guest = client(`${ws}/g/ws/${made.link.id}`, opened.body.doc!, opened.body.token!)
    // His desktop editor's own token for the file, as the docs pillar signs it.
    const own = (await r.signer.sign({ doc: fileDocName(r.doc), file: { path: r.doc }, role: 'edit', principal: 'owner' }, 300)).token
    const owner = client(`${ws}/w/doc/${encodeURIComponent(fileDocName(r.doc))}`, fileDocName(r.doc), own)
    await until('both synced', () => guest.provider.isSynced && owner.provider.isSynced)
    guest.document.getText('proof').insert(0, 'Bus at 7:30. ')
    await until('the owner sees the guest', () => owner.document.getText('proof').toString().includes('Bus at 7:30.'))
    owner.document.getText('proof').insert(owner.document.getText('proof').length, 'Lunch at noon.')
    await until('the guest sees the owner', () => guest.document.getText('proof').toString().includes('Lunch at noon.'))
    // Both at once: nothing is lost.
    guest.document.getText('proof').insert(0, 'G')
    owner.document.getText('proof').insert(0, 'O')
    await until('both letters on both sides', () => ['G', 'O'].every((c) => guest.document.getText('proof').toString().includes(c) && owner.document.getText('proof').toString().includes(c)))
    expect(guest.document.getText('proof').toString()).toBe(owner.document.getText('proof').toString())
    const at = Date.now()
    await r.rt.revoke(made.link.id)
    await until('the guest is shut out', () => !guest.provider.isSynced, 2000)
    expect(Date.now() - at).toBeLessThan(1500)
    expect((await openLink(r, made.link.id, secretOf(made.url))).status).toBe(403)
    // His own editor is untouched.
    expect(owner.provider.isSynced).toBe(true)
  })

  it('a changed role takes effect at once: the open socket closes, and the page opens again as a reader', async () => {
    const r = await rig()
    const made = await r.rt.create({ source: file(r.doc), title: 'Field trip plan', name: 'Dana', role: 'edit', expiresAt: days(30), bySession: null, by: LOCAL })
    const first = await openLink(r, made.link.id, secretOf(made.url))
    const ws = r.base.replace('http', 'ws')
    const guest = client(`${ws}/g/ws/${made.link.id}`, first.body.doc!, first.body.token!)
    await until('synced', () => guest.provider.isSynced)
    expect(await r.rt.setRole(made.link.id, 'view')).toBe(true)
    await until('the socket on the old role closes', () => !guest.provider.isSynced, 3000)
    const again = await openLink(r, made.link.id, secretOf(made.url))
    expect(again.body.role).toBe('view')
    // The address stayed; a reader's writes go nowhere.
    const reader = client(`${ws}/g/ws/${made.link.id}`, again.body.doc!, again.body.token!)
    const own = (await r.signer.sign({ doc: fileDocName(r.doc), file: { path: r.doc }, role: 'edit', principal: 'owner' }, 300)).token
    const owner = client(`${ws}/w/doc/${encodeURIComponent(fileDocName(r.doc))}`, fileDocName(r.doc), own)
    await until('both synced', () => reader.provider.isSynced && owner.provider.isSynced)
    reader.document.getText('proof').insert(0, 'not taken')
    owner.document.getText('proof').insert(0, 'his words')
    await until('the reader sees his words', () => reader.document.getText('proof').toString().includes('his words'))
    await new Promise((res) => setTimeout(res, 300))
    expect(owner.document.getText('proof').toString()).not.toContain('not taken')
    await expect(r.rt.setRole(made.link.id, 'comment')).rejects.toThrow('A link to this document can view or edit.')
  })
})

describe('a guest on a .tcsheet', () => {
  it('opens the file on its link’s socket alone, and the socket closes within a second of a revoke', async () => {
    const r = await rig()
    const made = await r.rt.create({ source: file(r.sheet), title: 'Field trip budget', name: 'Sam', role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
    const opened = await openLink(r, made.link.id, secretOf(made.url))
    expect(opened.body).toMatchObject({ kind: 'sheet', role: 'edit' })
    const hello = (path: string, token: string) => {
      const ws = new WsSocket(`${r.base.replace('http', 'ws')}${path}`)
      open.sockets.push(ws)
      const messages: { t: string; rev?: number }[] = []
      ws.on('message', (d) => messages.push(JSON.parse(String(d)) as { t: string }))
      ws.on('error', () => {})
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token })))
      return { ws, messages, closed: new Promise<number>((res) => ws.on('close', (code) => res(code))) }
    }
    const mine = hello(`/g/ws/${made.link.id}`, opened.body.token!)
    await until('the workbook arrives', () => mine.messages.some((m) => m.t === 'state'))
    mine.ws.send(JSON.stringify({ t: 'ops', id: 1, baseRev: mine.messages.find((m) => m.t === 'state')!.rev, mutations: [{ id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: { 1: { 1: { v: 42 } } } } }] }))
    await until('acknowledged', () => mine.messages.some((m) => m.t === 'ack' || m.t === 'refused'))
    expect(mine.messages.some((m) => m.t === 'ack')).toBe(true)
    // Another link's token, and his own token with no pass, open nothing of the file.
    const other = hello(`/w/sheet/${fileSheetId(r.sheet)}`, (await r.signer.sign({ sheet: fileSheetId(r.sheet), role: 'edit', principal: 'guest:L9', link: 'L9' }, 60)).token)
    expect(await other.closed).toBe(4403)
    const owner = hello(`/w/sheet/${fileSheetId(r.sheet)}`, (await r.signer.sign({ sheet: fileSheetId(r.sheet), role: 'edit', principal: 'owner' }, 60)).token)
    expect(await owner.closed).toBe(4403)
    const at = Date.now()
    await r.rt.revoke(made.link.id)
    expect(await mine.closed).toBe(4403)
    expect(Date.now() - at).toBeLessThan(2500)
  })
})

describe('a thread asking to share a file', () => {
  it('holds share.guestLink for his press, with no grant; a file outside its reach is refused', async () => {
    const r = await rig()
    const held: unknown[] = []
    const tool = guestsTools.find((t) => t.name === 'guest_link')!
    const ctx = { ...r.ctx, sessionId: 'thread1', scope: { sector: 'life', workspaceId: 'w1' }, held: { create: (a: unknown) => (held.push(a), { state: 'held', ref: { at: 'host', id: 'h1' } }) } }
    const out = await tool.run(tool.input.parse({ path: r.doc, name: 'Dana', role: 'edit', days: 7 }), ctx as never)
    expect(out.isError).toBeFalsy()
    expect(held).toEqual([{ kind: 'share.guestLink', sessionId: 'thread1', payload: expect.objectContaining({ source: file(r.doc), fileId: expect.any(String), title: 'Field trip plan', role: 'edit' }) }])
    // Nothing is made until his press.
    expect(r.db.prepare('SELECT count(*) AS n FROM work_guest_links').get()).toEqual({ n: 0 })
    // A file of this host outside the thread's own workspace is not its to share, though nothing else fences a thread.
    writeFileSync(join(r.outside, 'Private.tcdoc'), '')
    const far = await tool.run(tool.input.parse({ path: join(r.outside, 'Private.tcdoc'), name: 'X' }), ctx as never)
    expect(far.isError).toBe(true)
    expect(far.content[0]).toMatchObject({ text: 'That file is not in this workspace.' })
    expect(held).toHaveLength(1)
    // His press makes the link only for the file the thread named: another file at that name since is refused.
    const p = (held[0] as { payload: GuestLinkAct }).payload
    await expect(r.rt.create({ ...p, fileId: 'f'.repeat(40), bySession: 'thread1' })).rejects.toThrow(SHARE_REFUSALS.moved)
    const made = await r.rt.create({ ...p, bySession: 'thread1' })
    expect(made.link.source).toMatchObject({ at: 'file', path: r.doc })
    // A thread's own call to make, widen or revoke is refused: only the owner's screens do.
    for (const method of ['work.guests.create', 'work.guests.setRole', 'work.guests.revoke'])
      await expect(guests.handle!({ method, params: {} } as never, r.ctx, { kind: 'model', caps: [], sessionId: 'thread1' } as never)).rejects.toThrow('Only the owner')
    expect(guestLinkKind.words((held[0] as { payload: never }).payload).summary).toBe('Make a guest link for Dana: Field trip plan')
  })
})
