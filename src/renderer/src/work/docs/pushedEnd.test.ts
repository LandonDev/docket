// @vitest-environment node
import { request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationClient, DOCUMENT_SCHEMA, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, fileDocName, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE } from 'work-kit/collab-server'
import type { ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { Caller, WorkCtx } from '../../../../main/server/work/modules'
import { servicePaths } from '../../../../main/server/work/service/config'
import { startFakeConvex, type FakeConvex } from '../../../../main/server/work/service/fakeConvex'
import { startWorkService, type RunningService } from '../../../../main/server/work/service/serve'
import type { ServiceConfig } from '../../../../main/server/work/service/wire'
import { docs } from '../../../../main/server/work/docs/index'
import { stopDocs } from '../../../../main/server/work/docs/state'

/**
 * A document's frames pushed end to end (perf M11): the window's own socket class (renderer work/docs/host.ts) and
 * work-kit's collaboration client, through this host's docs module, to the real Work service. The window's link is a
 * stand-in that hands each request to the module with the asking socket's pushes, and can be cut.
 */

type Listener<T> = Set<(value: T) => void>
const win = vi.hoisted(() => ({
  link: null as null | {
    request(method: string, params?: Record<string, unknown>): Promise<unknown>
    onPush(listener: (push: unknown) => void): () => void
    onClose(listener: () => void): () => void
  },
}))
vi.mock('../../lib/connection', () => ({ registry: { linkOf: () => win.link } }))
const { docHost } = await import('./host')

const SECRET = 'p'.repeat(43)
const open: { dirs: string[]; services: RunningService[]; convex: FakeConvex[]; ctxs: WorkCtx[]; clients: CollaborationClient[] } = { dirs: [], services: [], convex: [], ctxs: [], clients: [] }
afterEach(async () => {
  await Promise.all(open.clients.splice(0).map((c) => c.destroy()))
  for (const ctx of open.ctxs.splice(0)) stopDocs(ctx)
  await Promise.all(open.services.splice(0).map((s) => s.stop().catch(() => {})))
  await Promise.all(open.convex.splice(0).map((c) => c.close()))
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const until = async (what: string, ok: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function post(socketPath: string, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => ((res.statusCode ?? 500) >= 400 ? reject(new Error(Buffer.concat(chunks).toString())) : resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'))))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

async function rig(o: { old?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'm11-docs-'))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  mkdirSync(join(dir, 'data'), { recursive: true })
  const keys = await generateCollabKeys('k')
  const signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  const config: ServiceConfig = {
    port: 0,
    socketPath: servicePaths(join(dir, 'data')).socketPath,
    secret: SECRET,
    dataDir: join(dir, 'data', 'work-service'),
    hostedDir: join(dir, 'hosted'),
    host: 'env_box',
    lifeos: { here: true, url: convex.url },
    trusted: [{ by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }],
    links: [],
  }
  const service = await startWorkService(config, { jwt: async () => 'owner-jwt', log: () => {} })
  open.services.push(service)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
  docs.ensure(db)
  const path = join(dir, 'Plan.tcdoc')
  const name = fileDocName(path)
  const ctx = {
    db,
    host: 'env_box',
    dataDir: join(dir, 'data'),
    log: () => {},
    push: () => {},
    reaches: (by: Caller) => by.kind !== 'remote',
    canvas: { get: () => null, paneOf: (id: string) => id },
    threads: { ownerSaid: () => false },
    lifeos: { connected: () => false, owner: () => ({ query: async () => null, mutation: async () => null }) },
    service: {
      internal: (route: string, body: unknown) => post(config.socketPath, route, body),
      url: (route: string) => `ws://127.0.0.1:${service.port}${route}`,
      token: async (claims: { item: { doc: string }; role: 'edit' | 'view'; principal: string }) => (await signer.sign({ doc: claims.item.doc, role: claims.role, principal: claims.principal, file: { path } } as never, 300)).token,
    },
  } as unknown as WorkCtx
  open.ctxs.push(ctx)
  await service.collab.writeMarkdown(name, 'owner', '# Plan\n\nMeet at 9', { path })
  await service.collab.flush()

  // The window's link: each request handed to the docs module as from his window, its pushes to the link's listeners.
  const asked: string[] = []
  const pushes: Listener<unknown> = new Set()
  const closes: Listener<void> = new Set()
  let socket = new AbortController()
  win.link = {
    async request(method, params = {}) {
      asked.push(method)
      // A host or a socket a release behind hands the module no socket of its own: the window is read by recv.
      const by: Caller = o.old ? { kind: 'local', caps: [] } : { kind: 'local', caps: [], reply: { send: (p: WorkPush) => void [...pushes].forEach((l) => l(p)), signal: socket.signal } }
      const done = await docs.handle!({ id: '1', method, params } as ClientRequest, ctx, by)
      if (!done.handled) throw new Error('not handled')
      return done.result
    },
    onPush: (l) => (pushes.add(l), () => void pushes.delete(l)),
    onClose: (l) => (closes.add(l), () => void closes.delete(l)),
  }
  /** The window's socket to the host goes, as a sleep or a network change cuts it, and a new one opens. */
  const cut = (): void => {
    socket.abort()
    for (const close of [...closes]) close()
    socket = new AbortController()
  }
  /** A second window's client straight on the service: what it syncs is the shared state. */
  const other = async (): Promise<CollaborationClient> => {
    const token = (await signer.sign({ doc: name, role: 'edit', principal: 'owner', file: { path } } as never, 300)).token
    const client = createCollaborationClient({ documentName: name, token, url: `ws://127.0.0.1:${service.port}/w/doc/${name}`, offline: false })
    open.clients.push(client)
    await until('the other client synced', () => client.provider.isSynced)
    return client
  }
  const source = { at: 'file', host: 'env_box', path } as const
  return { asked, cut, other, source, name }
}

/** His window's editor on the document: the ready open, then work-kit's client on the window's socket class. */
async function window(r: Awaited<ReturnType<typeof rig>>) {
  const host = docHost('env_box', r.source)
  const doc = await host.open({ schema: DOCUMENT_SCHEMA })
  const client = createCollaborationClient({ documentName: doc.doc, token: async () => (await host.token()).token, url: `ws://work-docs.invalid/w/doc/${encodeURIComponent(doc.doc)}`, offline: false, socket: host.socket })
  open.clients.push(client)
  return { host, client }
}

const said = (c: CollaborationClient): string => c.document.getText('m11').toString()

describe("a document's frames pushed to the window", () => {
  it('syncs with no work.docs.recv, in two requests before synced, and the save line waits on the service acks', async () => {
    const r = await rig()
    const { host, client } = await window(r)
    await until('synced', () => client.provider.isSynced)
    const before = r.asked.filter((m) => m !== 'work.docs.send')
    expect(before).toEqual(['work.docs.open'])
    expect(r.asked).not.toContain('work.docs.recv')
    expect(r.asked).not.toContain('work.docs.connect')
    expect(r.asked).not.toContain('work.docs.token')
    client.document.getText('m11').insert(0, 'typed in the window')
    // A close's flush: every update sent and heard applied (its SyncStatus came as a push), then stored.
    await host.flush()
    const other = await r.other()
    expect(said(other)).toBe('typed in the window')
    expect(r.asked).not.toContain('work.docs.recv')
  }, 30_000)

  it('where no socket of its own comes with the call, syncs by work.docs.recv as before', async () => {
    const r = await rig({ old: true })
    const { host, client } = await window(r)
    await until('synced', () => client.provider.isSynced)
    expect(r.asked).toContain('work.docs.recv')
    client.document.getText('m11').insert(0, 'by recv')
    await host.flush()
    expect(said(await r.other())).toBe('by recv')
  }, 30_000)

  it('converges after the link is cut: what each side typed meanwhile reaches the other, once', async () => {
    const r = await rig()
    const { host, client } = await window(r)
    await until('synced', () => client.provider.isSynced)
    const other = await r.other()
    client.document.getText('m11').insert(0, 'A')
    await until('the other heard A', () => said(other) === 'A')
    r.cut()
    // Typed on both sides while the window's link is down.
    client.document.getText('m11').insert(1, 'B')
    other.document.getText('m11').insert(0, 'C')
    // The provider makes another socket (a new connect, pushed again) and syncs.
    await until('both have all three', () => said(client).length === 3 && said(other).length === 3, 20_000)
    expect(said(client)).toBe(said(other))
    expect([...said(client)].sort().join('')).toBe('ABC')
    expect(r.asked.filter((m) => m === 'work.docs.connect').length).toBeGreaterThanOrEqual(1)
    expect(r.asked).not.toContain('work.docs.recv')
    await host.flush()
  }, 40_000)
})
