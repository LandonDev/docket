import { copyFileSync, existsSync, mkdirSync, readFileSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
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
import { readZip, writeZip } from '../sheets/patch/zip'
import { guestLinkKind, guests, guestsTools } from '.'
import { fileUid } from './fileIdent'
import { fileSheetId, GuestRuntime } from './links'
import { endGuestEditOn, ensureGuestTables, fileLinked, guestLinkedFile } from './store'

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

function internal(socketPath: string, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'s'.repeat(43)}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const answer = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { error?: string }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(answer.error ?? String(res.statusCode)))
        else resolve(answer)
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body ?? {}))
  })
}

/** The runtime the service's asks go to, set once the rig has made it. */
const asked: { rt: GuestRuntime | null } = { rt: null }

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
    // The service asks main about a file document's comments: the runtime answers, as the supervisor wires it.
    { jwt: async () => 'owner-jwt', log: (line) => void (process.env.SHARE_LOG && console.error(line)), guestAsk: (ask) => asked.rt!.answerAsk(ask) }
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
    // The service's own internal routes, over its socket, as `ctx.service.internal` reaches them.
    service: { url: (route: string) => `${base}${route}`, token: async () => 'ok', internal: (route: string, body: unknown) => internal(servicePaths(join(dir, 'data')).socketPath, route, body) },
    lifeos: { owner: () => ({ query: async () => null, mutation: async (name: string, args: unknown) => void told.push({ name, args }) }) }
  } as unknown as WorkCtx
  const rt = (asked.rt = new GuestRuntime(ctx, () => ({ tokenSigner: () => signer, setLinks: (links) => service.setLinks(links), setProject: (id, project) => service.setProject(id, project) })))
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

/** A `.tcdoc`'s bytes with its id entry taken out: the file as a copy made into a document of its own. */
function readWithout(path: string): Uint8Array {
  const z = readZip(new Uint8Array(readFileSync(path)))
  return writeZip(z, new Map(), new Set(['ident.json']), new Map())
}

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
    // A sheet keeps no comments: its link views or edits. A document takes all three, kept as a file too.
    expect(guestRefusal({ source: file(r.doc), role: 'comment', expiresAt: days(1) })).toBeNull()
    expect(guestRefusal({ source: file(r.sheet), role: 'comment', expiresAt: days(1) })).toBe('A sheet link can view or edit.')
    // A host whose pages no guest can reach (a Mac, an isolated instance) says so.
    vi.stubEnv('TEMP_CODE_WORK_PUBLIC_ORIGIN', '')
    vi.stubEnv('TEMP_CODE_USER_DATA', join(r.folder, 'instance'))
    await expect(make(file(r.doc))).rejects.toThrow(SHARE_REFUSALS.noPage)
    // A file others open is refused as one there too: it is shared where it lives, never by a guest link (decision 9).
    shared.paths.add(r.doc)
    await expect(make(file(r.doc))).rejects.toThrow(SHARE_REFUSALS.shared)
    shared.paths.clear()
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

describe('a file link is for one file, not for a path', () => {
  it('another file saved over the path opens for nobody from the first request, and the link ends at the next pass', async () => {
    const r = await rig()
    for (const [path, name] of [[r.doc, 'Dana'], [r.sheet, 'Sam']] as const) {
      const made = await r.rt.create({ source: file(path), title: 'T', name, role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
      expect(r.rt.store.get(made.link.id)?.fileUid).toBe(fileUid(path))
      expect((await openLink(r, made.link.id, secretOf(made.url))).status).toBe(200)
      // Another document of his, moved onto the name in one step: the path never stood empty, so no pass saw it go.
      const other = join(r.folder, path.endsWith('.tcdoc') ? 'Private notes.tcdoc' : 'Private budget.tcsheet')
      if (path.endsWith('.tcsheet')) TcsheetBackend.create(other, 'Private budget')
      else {
        copyFileSync(path, other)
        // A copy is the same document; one that is its own carries its own id.
        await internal(servicePaths(join(r.folder, '..', 'data')).socketPath, '/internal/guests/ident', { path: other })
        writeFileSync(other, readWithout(other))
        await internal(servicePaths(join(r.folder, '..', 'data')).socketPath, '/internal/guests/ident', { path: other })
      }
      expect(fileUid(other)).not.toBe(fileUid(path))
      renameSync(other, path)
      // The service has not been told anything new, and still opens nothing of it.
      expect((await openLink(r, made.link.id, secretOf(made.url))).status, path).toBe(403)
      const ws = new WsSocket(`${r.base.replace('http', 'ws')}/g/ws/${made.link.id}`)
      open.sockets.push(ws)
      expect(await new Promise((res) => (ws.on('open', () => res('open')), ws.on('unexpected-response', (_q, got) => res(got.statusCode)), ws.on('error', () => {}))), path).toBe(404)
      // And at main's next pass the link is over for good: he makes a new one for the new file.
      await r.rt.tick()
      expect(r.rt.store.get(made.link.id)?.revokedAt, path).not.toBeNull()
    }
  })

  it('a guest already in the document is let go within seconds of another file being saved over its path, before main hears of it', async () => {
    const r = await rig()
    const made = await r.rt.create({ source: file(r.doc), title: 'T', name: 'Dana', role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
    const opened = await openLink(r, made.link.id, secretOf(made.url))
    const guest = client(`${r.base.replace('http', 'ws')}/g/ws/${made.link.id}`, opened.body.doc!, opened.body.token!)
    await until('synced', () => guest.provider.isSynced)
    const other = join(r.folder, 'Private notes.tcdoc')
    copyFileSync(r.doc, other)
    writeFileSync(other, readWithout(other))
    await internal(servicePaths(join(r.folder, '..', 'data')).socketPath, '/internal/guests/ident', { path: other })
    renameSync(other, r.doc)
    const at = Date.now()
    await until('the guest is let go', () => !guest.provider.isSynced, 4000)
    expect(Date.now() - at).toBeLessThan(3500)
  })

  it("the app's own saves keep the file's id, so a guest's edits never end their own link", async () => {
    const r = await rig()
    const doc = await r.rt.create({ source: file(r.doc), title: 'Plan', name: 'Dana', role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
    const before = fileUid(r.doc)
    const opened = await openLink(r, doc.link.id, secretOf(doc.url))
    const guest = client(`${r.base.replace('http', 'ws')}/g/ws/${doc.link.id}`, opened.body.doc!, opened.body.token!)
    await until('synced', () => guest.provider.isSynced)
    guest.document.getText('proof').insert(0, 'Typed by the guest. ')
    await until('stored', () => guest.provider.isSynced && !guest.provider.hasUnsyncedChanges)
    await guest.destroy()
    // The store rewrote the file (a new inode); what names it is inside it.
    await until('the file is written again', () => fileUid(r.doc) === before && r.rt.store.get(doc.link.id)?.revokedAt === null, 8000)
    await r.rt.tick()
    expect(r.rt.store.get(doc.link.id)?.revokedAt).toBeNull()
    expect((await openLink(r, doc.link.id, secretOf(doc.url))).status).toBe(200)
    // A sheet: an op rewrites the whole file.
    const sheet = await r.rt.create({ source: file(r.sheet), title: 'Budget', name: 'Sam', role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
    const id = fileUid(r.sheet)
    await internal(servicePaths(join(r.folder, '..', 'data')).socketPath, '/internal/sheet/cells', { sheet: { tcsheet: r.sheet }, cells: [{ at: 'A1', v: 1 }], by: 'owner' })
    expect(fileUid(r.sheet)).toBe(id)
    await r.rt.tick()
    expect(r.rt.store.get(sheet.link.id)?.revokedAt).toBeNull()
  })

  it('a link made before files carried an id takes the id its file has now, once', async () => {
    const r = await rig()
    const made = await r.rt.create({ source: file(r.doc), title: 'Plan', name: 'Dana', role: 'view', expiresAt: days(7), bySession: null, by: LOCAL })
    r.db.prepare('UPDATE work_guest_links SET file_uid = NULL WHERE id = ?').run(made.link.id)
    await r.rt.tick()
    expect(r.rt.store.get(made.link.id)?.fileUid).toBe(fileUid(r.doc))
    expect((await openLink(r, made.link.id, secretOf(made.url))).status).toBe(200)
  })

  it('a path is taken as the file it reaches: no relative path, no home shorthand, and no name that links to a Word file', async () => {
    const r = await rig()
    const make = (path: string, by: Caller = LOCAL) => r.rt.create({ source: file(path), title: 'T', name: 'Dana', role: 'view', expiresAt: days(7), bySession: null, by })
    await expect(make('Field trip plan.tcdoc')).rejects.toThrow(SHARE_REFUSALS.gone)
    await expect(make('~/Field trip plan.tcdoc')).rejects.toThrow(SHARE_REFUSALS.gone)
    // A name that reads as a document of ours and links to a Word file: the service would open, and write, the Word file.
    writeFileSync(join(r.folder, 'Letter.docx'), 'word bytes')
    symlinkSync(join(r.folder, 'Letter.docx'), join(r.folder, 'Letter.tcdoc'))
    await expect(make(join(r.folder, 'Letter.tcdoc'))).rejects.toThrow(SHARE_REFUSALS.other)
    // A name in the workspace that links to a file outside it is fenced by the file, for a key that reaches the folder alone.
    writeFileSync(join(r.outside, 'Private.tcdoc'), '')
    symlinkSync(join(r.outside, 'Private.tcdoc'), join(r.folder, 'Alias.tcdoc'))
    shared.paths.add(join(r.outside, 'Private.tcdoc'))
    await expect(make(join(r.folder, 'Alias.tcdoc'), PHONE)).rejects.toThrow(SHARE_REFUSALS.shared)
    // Another host's id never reaches this disk: refused before the path is looked at.
    await expect(r.rt.create({ source: file('/does/not/matter.tcdoc', 'env_mac'), title: 'T', name: 'D', role: 'view', expiresAt: days(7), bySession: null, by: LOCAL })).rejects.toThrow('served elsewhere: env_mac')
    expect(r.db.prepare('SELECT count(*) AS n FROM work_guest_links').get()).toEqual({ n: 0 })
  })

  it('Save As that keeps a document linked first turns its edit links into view links, their sockets closed', async () => {
    const r = await rig()
    const made = await r.rt.create({ source: file(r.doc), title: 'Plan', name: 'Dana', role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
    const reader = await r.rt.create({ source: file(r.doc), title: 'Plan', name: 'Kim', role: 'view', expiresAt: days(7), bySession: null, by: LOCAL })
    const opened = await openLink(r, made.link.id, secretOf(made.url))
    const guest = client(`${r.base.replace('http', 'ws')}/g/ws/${made.link.id}`, opened.body.doc!, opened.body.token!)
    await until('synced', () => guest.provider.isSynced)
    // What files/saveAs.ts asks before it links the document to another file.
    await endGuestEditOn(r.db, r.doc)
    expect(r.rt.store.get(made.link.id)).toMatchObject({ role: 'view', revokedAt: null })
    expect(r.rt.store.get(reader.link.id)).toMatchObject({ role: 'view', revokedAt: null })
    await until('the socket that could write is closed', () => !guest.provider.isSynced, 3000)
    expect((await openLink(r, made.link.id, secretOf(made.url))).body.role).toBe('view')
    // A file no link names asks nothing of anyone.
    await endGuestEditOn(r.db, r.sheet)
  })

  it('a document that comes to be saved to another file loses its edit link at the next pass', async () => {
    const r = await rig()
    const made = await r.rt.create({ source: file(r.doc), title: 'Plan', name: 'Dana', role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
    r.db.exec('CREATE TABLE work_files_links (doc TEXT, target TEXT)')
    r.db.prepare('INSERT INTO work_files_links VALUES (?, ?)').run(r.doc, '/elsewhere/Plan.docx')
    await r.rt.tick()
    expect(r.rt.store.get(made.link.id)?.revokedAt).not.toBeNull()
    expect((await openLink(r, made.link.id, secretOf(made.url))).status).toBe(403)
  })
})

describe('a token is held to what its link is now', () => {
  it('one signed for a role the link no longer has opens no document and no sheet, however fresh it is', async () => {
    const r = await rig()
    const ws = r.base.replace('http', 'ws')
    const doc = await r.rt.create({ source: file(r.doc), title: 'Plan', name: 'Dana', role: 'view', expiresAt: days(7), bySession: null, by: LOCAL })
    // A token for Edit, signed after the link's last change, as a list that was being signed while the role went down would hold.
    const stale = (await r.signer.sign({ doc: fileDocName(r.doc), file: { path: r.doc }, role: 'edit', principal: `guest:${doc.link.id}`, link: doc.link.id }, 60)).token
    const writer = client(`${ws}/g/ws/${doc.link.id}`, fileDocName(r.doc), stale)
    const refused: string[] = []
    writer.provider.on('authenticationFailed', ({ reason }: { reason: string }) => refused.push(reason))
    await until('refused', () => refused.length > 0)
    expect(writer.provider.isSynced).toBe(false)
    const sheet = await r.rt.create({ source: file(r.sheet), title: 'Budget', name: 'Sam', role: 'view', expiresAt: days(7), bySession: null, by: LOCAL })
    const sock = new WsSocket(`${ws}/g/ws/${sheet.link.id}`)
    open.sockets.push(sock)
    const closed = new Promise<number>((res) => sock.on('close', (code) => res(code)))
    const token = (await r.signer.sign({ sheet: fileSheetId(r.sheet), role: 'edit', principal: `guest:${sheet.link.id}`, link: sheet.link.id }, 60)).token
    sock.on('open', () => sock.send(JSON.stringify({ t: 'hello', token })))
    expect(await closed).toBe(4403)
  })

  it('ops a sheet socket sent before a revoke land nowhere after it, and it hears nothing more of the sheet', async () => {
    const r = await rig()
    const ws = r.base.replace('http', 'ws')
    const a = await r.rt.create({ source: file(r.sheet), title: 'Budget', name: 'Sam', role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
    const b = await r.rt.create({ source: file(r.sheet), title: 'Budget', name: 'Kim', role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
    const join2 = async (made: typeof a) => {
      const opened = await openLink(r, made.link.id, secretOf(made.url))
      const sock = new WsSocket(`${ws}/g/ws/${made.link.id}`)
      open.sockets.push(sock)
      const messages: { t: string; rev?: number; by?: string }[] = []
      sock.on('message', (d) => messages.push(JSON.parse(String(d)) as { t: string }))
      sock.on('error', () => {})
      sock.on('open', () => sock.send(JSON.stringify({ t: 'hello', token: opened.body.token })))
      await until('the workbook arrives', () => messages.some((m) => m.t === 'state'))
      return { sock, messages, rev: () => messages.find((m) => m.t === 'state')!.rev! }
    }
    const sam = await join2(a)
    const kim = await join2(b)
    const cell = (v: string) => [{ id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: { 3: { 3: { v } } } } }]
    // The service is told Sam's link is gone (as a revoke tells it), and in the same turn Sam's queued op arrives.
    await r.rt.revoke(a.link.id)
    sam.sock.send(JSON.stringify({ t: 'ops', id: 1, baseRev: sam.rev(), mutations: cell('after the revoke') }))
    kim.sock.send(JSON.stringify({ t: 'ops', id: 1, baseRev: kim.rev(), mutations: cell('kim') }))
    await until('kim is answered', () => kim.messages.some((m) => m.t === 'ack'))
    await new Promise((res) => setTimeout(res, 200))
    expect(sam.messages.some((m) => m.t === 'ack')).toBe(false)
    // Kim's op reached Kim and not the socket whose link was revoked.
    expect(kim.messages.filter((m) => m.t === 'ops').length).toBe(1)
    expect(sam.messages.filter((m) => m.t === 'ops').length).toBe(0)
    const read = (await internal(servicePaths(join(r.folder, '..', 'data')).socketPath, '/internal/sheet/range', { sheet: { tcsheet: r.sheet }, range: 'D4' })) as { cells: { v?: unknown }[][] }
    expect(read.cells[0]![0]!.v).toBe('kim')
  })
})

describe('a guest on a .tcdoc', () => {
  it('edits live with the owner both ways on one document; revoke ends the guest within a second', async () => {
    const r = await rig()
    const made = await r.rt.create({ source: file(r.doc), title: 'Field trip plan', name: 'Dana', role: 'edit', expiresAt: days(30), bySession: null, by: LOCAL })
    const opened = await openLink(r, made.link.id, secretOf(made.url))
    expect(opened.status).toBe(200)
    expect(opened.body).toMatchObject({ kind: 'doc', role: 'edit', doc: fileDocName(r.doc), name: 'Dana' })
    // Its comments are reachable now (through main), so the page is not told to draw none.
    expect(opened.body.comments).toBeUndefined()
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
    // What the guest wrote is a version of its own in the file's History, cut as the guest's socket closed.
    const listed = async () => ((await r.ctx.service.internal('/internal/history/list', { file: r.doc, fence: { sectors: 'all' } })) as { versions: { cause: string }[] }).versions
    let causes: string[] = []
    for (const end = Date.now() + 3000; Date.now() < end && !causes.includes('guest-end'); await new Promise((done) => setTimeout(done, 50))) causes = (await listed()).map((v) => v.cause)
    expect(causes).toContain('guest-end')
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
  })
})

describe("a guest's comments on a .tcdoc", () => {
  const threadsOf = async (r: Rig, id: string, token: string) => {
    const res = await fetch(`${r.base}/g/${id}/threads`, { headers: { Authorization: `Bearer ${token}` } })
    return { status: res.status, body: (await res.json()) as { rows?: { thread: { publicId: string; quote?: string }; comments: { authorMemberId: string; body: string }[] }[]; names?: Record<string, string> } }
  }
  const say = async (r: Rig, id: string, token: string, body: unknown) => {
    const res = await fetch(`${r.base}/g/${id}/comment`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as { threadId?: string; commentId?: string; error?: string } }
  }
  /** The document open by its owner with real words in it, so a quote can be found; the guest's link beside it. */
  async function withWords(role: 'view' | 'comment' | 'edit') {
    const r = await rig()
    r.db.exec('CREATE TABLE IF NOT EXISTS work_docs_threads (doc TEXT PRIMARY KEY, rows TEXT NOT NULL)')
    const pushes: unknown[] = []
    ;(r.ctx as unknown as { push(p: unknown): void }).push = (p) => void pushes.push(p)
    const made = await r.rt.create({ source: file(r.doc), title: 'Field trip plan', name: 'Dana Lee', role, expiresAt: days(7), bySession: null, by: LOCAL })
    const opened = await openLink(r, made.link.id, secretOf(made.url))
    const ws = r.base.replace('http', 'ws')
    const own = (await r.signer.sign({ doc: fileDocName(r.doc), file: { path: r.doc }, role: 'edit', principal: 'owner' }, 300)).token
    const owner = client(`${ws}/w/doc/${encodeURIComponent(fileDocName(r.doc))}`, fileDocName(r.doc), own)
    await until('the owner is in', () => owner.provider.isSynced)
    return { r, made, opened, owner, pushes }
  }

  it('a comment link reads the threads, starts one on words of the document and replies; the owner is told, and the rows are in his own database under the guest', async () => {
    const { r, made, opened, pushes } = await withWords('comment')
    const id = made.link.id
    const token = opened.body.token!
    expect(opened.body.role).toBe('comment')
    expect(await threadsOf(r, id, token)).toEqual({ status: 200, body: { rows: [], names: { owner: 'The owner', [`guest:${id}`]: 'You' } } })
    // The owner's own thread, and another guest's: this guest reads them with no other guest named.
    const doc = fileDocName(r.doc)
    const { changeThread } = await import('../docs/threads')
    const target = { at: 'file', doc, path: r.doc, source: file(r.doc) } as never
    const his = (await changeThread(r.ctx, target, { op: 'create', body: '[{"type":"paragraph","content":[{"type":"text","text":"Check the bus time","styles":{}}]}]', quote: 'Plan' }, 'owner')) as { thread: { publicId: string } }
    await changeThread(r.ctx, target, { op: 'reply', threadId: his.thread.publicId, body: '[]' }, 'guest:someoneElse')
    const read = await threadsOf(r, id, token)
    expect(read.body.rows).toHaveLength(1)
    expect(read.body.rows![0]!.comments.map((c) => c.authorMemberId)).toEqual(['owner', 'p2'])
    expect(read.body.names).toEqual({ owner: 'The owner', [`guest:${id}`]: 'You', p2: 'A guest' })
    expect(JSON.stringify(read.body)).not.toContain('someoneElse')
    // A reply: plain words only, built into the comment by the service, written under this guest.
    const reply = await say(r, id, token, { threadId: his.thread.publicId, text: 'Bus leaves at 7:30' })
    expect(reply.status).toBe(200)
    const kept = JSON.parse((r.db.prepare('SELECT rows FROM work_docs_threads WHERE doc = ?').get(doc) as { rows: string }).rows) as { comments: { authorMemberId: string; body: string }[] }[]
    expect(kept[0]!.comments.at(-1)).toMatchObject({ authorMemberId: `guest:${id}`, body: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text: 'Bus leaves at 7:30', styles: {} }] }]) })
    expect(pushes).toContainEqual({ push: 'work.docs', doc, threads: true })
    // A new comment on words of the document: looked for in the live text, kept by main, and the words marked by the service (a comment link cannot write them).
    await r.service.collab.writeMarkdown(doc, 'owner', 'Meet at the north doors at 7:15.', { path: r.doc })
    const started = await say(r, id, token, { quote: 'north doors', text: 'Which doors exactly?' })
    expect(started.status).toBe(200)
    const after = JSON.parse((r.db.prepare('SELECT rows FROM work_docs_threads WHERE doc = ?').get(doc) as { rows: string }).rows) as { thread: { publicId: string; quote?: string }; comments: { authorMemberId: string }[] }[]
    expect(after.at(-1)).toMatchObject({ thread: { publicId: started.body.threadId, quote: 'north doors' }, comments: [{ authorMemberId: `guest:${id}` }] })
    expect((await threadsOf(r, id, token)).body.rows!.at(-1)!.comments[0]!.authorMemberId).toBe(`guest:${id}`)
    // The words carry the thread's mark in the document itself, where his editor draws it.
    const { threadAnchors, DOCUMENT_FRAGMENT } = await import('work-kit/collab')
    let anchors: string[] = []
    await r.service.collab.edit(doc, 'owner', (d) => void (anchors = threadAnchors(d.getXmlFragment(DOCUMENT_FRAGMENT)).map((x) => x.threadId)), { path: r.doc })
    expect(anchors).toContain(started.body.threadId)
    // A reply on a thread that is not this document's, and words that are not in it, are refused in words.
    expect(await say(r, id, token, { threadId: 'not-a-thread', text: 'x' })).toMatchObject({ status: 404, body: { error: 'That comment is gone.' } })
    expect(await say(r, id, token, { quote: 'words that are nowhere in it', text: 'x' })).toMatchObject({ status: 400, body: { error: 'Those words are no longer in the document.' } })
    expect(await say(r, id, token, { quote: 'Plan', text: 'x'.repeat(4001) })).toMatchObject({ status: 400 })
  })

  it('a view link reads no thread it may not and writes none; a link that is revoked, or another file link, reaches nothing', async () => {
    const { r, made, opened } = await withWords('view')
    const id = made.link.id
    expect((await say(r, id, opened.body.token!, { quote: 'Plan', text: 'hello' })).status).toBe(403)
    expect(r.db.prepare('SELECT count(*) AS n FROM work_docs_threads').get()).toEqual({ n: 0 })
    // Main itself holds a view link to it too, whatever the service passed on.
    await expect(r.rt.answerAsk({ what: 'comment', linkId: id, body: '[]', quote: 'Plan' })).rejects.toThrow('This link can view, not comment.')
    // A sheet's link, a link that never was and a revoked one are gone to main: no rows of any document are read for them.
    const sheet = await r.rt.create({ source: file(r.sheet), title: 'Budget', name: 'Sam', role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
    for (const linkId of [sheet.link.id, 'neverMade']) await expect(r.rt.answerAsk({ what: 'threads', linkId })).rejects.toThrow('gone')
    await r.rt.revoke(id)
    await expect(r.rt.answerAsk({ what: 'threads', linkId: id })).rejects.toThrow('gone')
    expect((await threadsOf(r, id, opened.body.token!)).status).toBe(403)
  })

  it('a link to a .tcdoc can be for view, comment or edit, and a sheet link for view or edit', async () => {
    const { guestRolesOf } = await import('@shared/work/guestRoles')
    const r = await rig()
    expect(guestRolesOf(file(r.doc))).toEqual(['view', 'comment', 'edit'])
    expect(guestRolesOf(file(r.sheet))).toEqual(['view', 'edit'])
    const made = await r.rt.create({ source: file(r.doc), title: 'Plan', name: 'Dana', role: 'edit', expiresAt: days(7), bySession: null, by: LOCAL })
    expect(await r.rt.setRole(made.link.id, 'comment')).toBe(true)
    expect(r.rt.store.get(made.link.id)!.role).toBe('comment')
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
    // The same name with another file under it (the held act names the id the file carried when the thread asked).
    expect(p.fileUid).toBe(fileUid(r.doc))
    await expect(r.rt.create({ ...p, fileUid: 'another-file-0000', bySession: 'thread1' })).rejects.toThrow(SHARE_REFUSALS.moved)
    const made = await r.rt.create({ ...p, bySession: 'thread1' })
    expect(made.link.source).toMatchObject({ at: 'file', path: r.doc })
    // A thread's own call to make, widen or revoke is refused: only the owner's screens do.
    for (const method of ['work.guests.create', 'work.guests.setRole', 'work.guests.revoke'])
      await expect(guests.handle!({ method, params: {} } as never, r.ctx, { kind: 'model', caps: [], sessionId: 'thread1' } as never)).rejects.toThrow('Only the owner')
    expect(guestLinkKind.words((held[0] as { payload: never }).payload).summary).toBe('Make a guest link for Dana: Field trip plan')
  })
})
