import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { fileDocName } from 'work-kit/collab-server'
import type { ClientRequest } from '@shared/contract'
import type { DocOpen, DocsPush, DocThreadRow } from '@shared/contract-work-docs'
import type { CanvasItem, WorkPush } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, ToolCtx, WorkCtx } from '../modules'
import { servicePaths } from '../service/config'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { startWorkService, type RunningService } from '../service/serve'
import type { ServiceConfig } from '../service/wire'
import { docs } from './index'
import { createRelay } from './relay'
import { stopDocs } from './state'
import { fromLifeos } from './threads'
import { changedParts, docTools } from './tools'

/*
 * The docs pillar on this host: the Work service in process (its socket
 * routes, a real Hocuspocus with gc off, a .tcdoc on disk and a fake LifeOS),
 * the module's methods and the agent's tools calling it as main does.
 */

const SECRET = 'd'.repeat(43)
const open: { dirs: string[]; services: RunningService[]; convex: FakeConvex[]; ctxs: WorkCtx[] } = { dirs: [], services: [], convex: [], ctxs: [] }

afterEach(async () => {
  for (const ctx of open.ctxs.splice(0)) stopDocs(ctx)
  await Promise.all(open.services.splice(0).map((s) => s.stop().catch(() => {})))
  await Promise.all(open.convex.splice(0).map((c) => c.close()))
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function post(socketPath: string, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { error?: string }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? `HTTP ${res.statusCode}`))
        else resolve(parsed)
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const md = (...lines: string[]) => lines.join('\n\n')

async function rig(o: { ownerSaid?: string[]; shared?: boolean; routineRunId?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'm20-docs-'))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  mkdirSync(join(dir, 'data'), { recursive: true })
  const config: ServiceConfig = {
    port: 0,
    socketPath: servicePaths(join(dir, 'data')).socketPath,
    secret: SECRET,
    dataDir: join(dir, 'data', 'work-service'),
    hostedDir: join(dir, 'hosted'),
    host: 'env_box',
    lifeos: { here: true, url: convex.url },
    trusted: [],
    links: []
  }
  const service = await startWorkService(config, { jwt: async () => 'owner-jwt', log: () => {} })
  open.services.push(service)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
  db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run('t1', 'Northside PT kickoff')
  docs.ensure(db)
  const path = join(dir, 'Onboarding plan.tcdoc')
  const source = { at: 'file', host: 'env_box', path } as const
  const item: CanvasItem = { id: 'i1', sessionId: 't1', kind: 'document', title: 'Onboarding plan', source, state: null, openedAt: 1, closedAt: null } as unknown as CanvasItem
  const pushes: WorkPush[] = []
  const ctx = {
    db,
    host: 'env_box',
    log: () => {},
    push: (p: WorkPush) => pushes.push(p),
    reaches: (by: Caller) => by.kind !== 'remote',
    canvas: { get: (id: string) => (id === 'i1' ? item : null), paneOf: (id: string) => id },
    threads: { ownerSaid: (_: string, quote: string) => (o.ownerSaid ?? []).some((said) => said.includes(quote)) },
    lifeos: { connected: () => false },
    service: {
      internal: (route: string, body: unknown) => post(config.socketPath, route, body),
      url: (route: string) => `ws://127.0.0.1:${service.port}${route}`
    }
  } as unknown as WorkCtx
  open.ctxs.push(ctx)
  const toolCtx = { ...ctx, sessionId: 't1', signal: new AbortController().signal, scope: { shared: () => o.shared === true, routineRunId: o.routineRunId ?? null } } as unknown as ToolCtx
  const name = fileDocName(path)
  const tool = async (tname: string, args: Record<string, unknown>) => {
    const t = docTools.find((x) => x.name === tname)!
    const got = await t.run(t.input.parse(args), toolCtx)
    return { text: (got.content[0] as { text: string }).text, error: got.isError === true }
  }
  const ask = async <T,>(method: string, params: unknown, by: Caller = { kind: 'local', caps: [] }): Promise<T> => {
    const done = await docs.handle!({ id: '1', method, params } as ClientRequest, ctx, by)
    if (!done.handled) throw new Error('not handled')
    return done.result as T
  }
  const text = async () => (await service.collab.read(name, { path })).markdown
  const branches = async () => ((await post(config.socketPath, '/internal/history/branches', { file: path, fence: { sectors: 'all' } })) as { branches: unknown[] }).branches
  await service.collab.writeMarkdown(name, 'owner', md('# Week 1', 'Meet the team at 9:00 AM', '# Week 2', 'Shadow the front desk'), { path })
  return { dir, path, source, name, service, ctx, pushes, tool, ask, text, branches }
}

const docsPushes = (pushes: WorkPush[]) => pushes.filter((p): p is DocsPush => (p as { push: string }).push === 'work.docs')

describe('an agent writing a document', () => {
  it('on his own document its own idea is written as one version, and the bar is told what with the version Undo goes back to', async () => {
    const r = await rig()
    const said = await r.tool('doc_write', { item: 'i1', markdown: md('# Week 1', 'Meet the team at 9:30 AM', '# Week 2', 'Shadow the front desk'), because: 'own' })
    expect(said).toEqual({ text: 'Wrote 1 section.', error: false })
    expect(await r.text()).toContain('9:30 AM')
    const written = docsPushes(r.pushes).find((p) => p.written)!.written!
    expect(written).toMatchObject({ text: 'Wrote 1 section', versionId: expect.any(String) })
    expect((await r.ask<DocOpen>('work.docs.open', { source: r.source })).written).toEqual(written)
    await r.ask('work.docs.dismiss', { source: r.source })
    expect((await r.ask<DocOpen>('work.docs.open', { source: r.source })).written).toBeNull()
  })

  it('set to suggest, its own idea waits as a branch and the text stays; asked in his own words, it is written', async () => {
    const r = await rig({ ownerSaid: ['Please change the meeting to 10:00 AM for everyone'] })
    expect((await r.ask<DocOpen>('work.docs.mode', { source: r.source, mode: 'suggests' })).mode).toBe('suggests')
    const own = await r.tool('doc_write', { file: r.path, markdown: md('# Week 1', 'Meet the team at 9:30 AM', '# Week 2', 'Shadow the front desk'), because: 'own' })
    expect(own.text).toMatch(/^Suggested changes to 1 section: he set this document to suggest/)
    expect(await r.text()).toContain('9:00 AM')
    expect(await r.branches()).toHaveLength(1)
    expect(docsPushes(r.pushes).some((p) => p.branches)).toBe(true)
    const asked = await r.tool('doc_write', { file: r.path, markdown: md('# Week 1', 'Meet the team at 10:00 AM', '# Week 2', 'Shadow the front desk'), because: 'asked', quote: 'change the meeting to 10:00 AM' })
    expect(asked).toEqual({ text: 'Wrote 1 section.', error: false })
    expect(await r.text()).toContain('10:00 AM')
  })

  it('on a shared document, "asked" with words he never typed is the agent\'s own idea and waits; with his words it is written', async () => {
    const r = await rig({ shared: true, ownerSaid: ['move week 2 to the clinic'] })
    const made = await r.tool('doc_write', { item: 'i1', markdown: md('# Week 1', 'Meet the team at 9:00 AM', '# Week 2', 'Shadow at the clinic'), because: 'asked', quote: 'the owner wants this' })
    expect(made.text).toBe("Suggested changes to 1 section: others share this document, so he accepts or rejects each one. The quote was not found among the owner's words in this thread, so this counts as your own idea.")
    expect(await r.text()).toContain('front desk')
    const asked = await r.tool('doc_write', { item: 'i1', markdown: md('# Week 1', 'Meet the team at 9:00 AM', '# Week 2', 'Shadow at the clinic'), because: 'asked', quote: 'move week 2 to the clinic' })
    expect(asked.text).toBe('Wrote 1 section.')
    expect(await r.text()).toContain('clinic')
    // A written change on a shared document is not the agent's own idea: no Undo line.
    expect(docsPushes(r.pushes).some((p) => p.written)).toBe(false)
  })

  it('"routine" counts only in a routine\'s run; doc_suggest always waits', async () => {
    const r = await rig({ shared: true })
    expect((await r.tool('doc_write', { item: 'i1', markdown: md('# Week 1', 'x'), because: 'routine' })).text).toMatch(/This thread runs no routine/)
    const s = await rig({ shared: true, routineRunId: 'run1' })
    expect((await s.tool('doc_write', { item: 'i1', markdown: md('# Week 1', 'Meet the team at 9:00 AM', '# Week 2', 'Routine words'), because: 'routine' })).text).toBe('Wrote 1 section.')
    expect(await s.text()).toContain('Routine words')
    expect((await s.tool('doc_suggest', { item: 'i1', markdown: md('# Week 1', 'Suggested words') })).text).toMatch(/^Suggested changes to 2 sections: he steps through them/)
    expect(await s.text()).toContain('Routine words')
  })

  it('a thread with no such item, or a path outside a .tcdoc, is told so', async () => {
    const r = await rig()
    expect(await r.tool('doc_read', { item: 'nope' })).toEqual({ text: 'This thread has no document nope in its canvas.', error: true })
    expect((await r.tool('doc_read', { file: join(r.dir, 'notes.txt') })).text).toMatch(/LifeOS document or a .tcdoc/)
  })
})

describe('comments', () => {
  it('an agent comments on words, a table cell included; the thread is listed and named for its thread', async () => {
    const r = await rig()
    expect(await r.tool('doc_comment', { item: 'i1', quote: 'front desk', body: 'Which desk?' })).toEqual({ text: 'Commented.', error: false })
    const { rows, names } = await r.ask<{ rows: DocThreadRow[]; names: Record<string, string> }>('work.docs.threads', { source: r.source })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.thread.quote).toBe('front desk')
    expect(rows[0]!.comments[0]!.authorMemberId).toBe('agent:env_box:t1')
    expect(names['agent:env_box:t1']).toBe('Northside PT kickoff')
    expect((await r.tool('doc_read', { item: 'i1' })).text).toContain('Open comments:\n- on “front desk”: Which desk?')
  })

  it('words that are not there make no thread', async () => {
    const r = await rig()
    expect(await r.tool('doc_comment', { item: 'i1', quote: 'not in it', body: 'x' })).toEqual({ text: 'Those words are not in the document. Quote them exactly as they stand.', error: true })
    const { rows } = await r.ask<{ rows: DocThreadRow[] }>('work.docs.threads', { source: r.source })
    expect(rows.filter((x) => x.thread.deletedAt === null)).toEqual([])
  })

  it("his own replies, edits, reactions and resolve on a file's threads", async () => {
    const r = await rig()
    const made = await r.ask<DocThreadRow>('work.docs.thread', { source: r.source, change: { op: 'create', body: '[]', quote: 'Week 2' } })
    const reply = await r.ask<{ publicId: string }>('work.docs.thread', { source: r.source, change: { op: 'reply', threadId: made.thread.publicId, body: 'b' } })
    await r.ask('work.docs.thread', { source: r.source, change: { op: 'react', commentId: reply.publicId, emoji: '👍', reacted: true } })
    await r.ask('work.docs.thread', { source: r.source, change: { op: 'resolve', threadId: made.thread.publicId, resolved: true } })
    const [row] = (await r.ask<{ rows: DocThreadRow[] }>('work.docs.threads', { source: r.source })).rows
    expect(row!.thread).toMatchObject({ resolved: true, resolvedByMemberId: 'owner' })
    expect(row!.comments[1]!.reactions).toEqual([expect.objectContaining({ emoji: '👍', memberIds: ['owner'] })])
    expect(docsPushes(r.pushes).filter((p) => p.threads)).toHaveLength(4)
  })

  it("LifeOS's rows read as the editor's, an outside author by name", () => {
    expect(
      fromLifeos([
        {
          thread: { _id: 't', quote: 'q', resolved: false, at: 1, editedAt: 2 },
          comments: [{ _id: 'c', externalAuthor: { name: 'Dana Lee' }, body: '[]', reactions: [{ emoji: '👍', at: 3, by: ['owner'] }], at: 1, editedAt: 1 }]
        }
      ])
    ).toEqual([
      {
        thread: { publicId: 't', quote: 'q', resolved: false, resolvedAt: null, resolvedByMemberId: null, createdAt: 1, updatedAt: 2, deletedAt: null },
        comments: [{ publicId: 'c', body: '[]', authorMemberId: 'external:Dana Lee', reactions: [{ emoji: '👍', createdAt: 3, memberIds: ['owner'] }], createdAt: 1, updatedAt: 1, deletedAt: null }]
      }
    ])
  })
})

describe('opening a document', () => {
  it('a .tcdoc opens by its resolved name; a read-only key views; outside its roots a remote key is refused', async () => {
    const r = await rig()
    const opened = await r.ask<DocOpen>('work.docs.open', { source: r.source })
    expect(opened).toMatchObject({ doc: r.name, title: 'Onboarding plan', role: 'edit', shared: false, mode: 'writes', me: 'owner' })
    await expect(r.ask('work.docs.open', { source: r.source }, { kind: 'remote', caps: ['read'] })).rejects.toBeInstanceOf(FenceError)
  })

  it("the socket is relayed: a far window's frames reach the service and its answers come back", async () => {
    const r = await rig()
    ;(r.ctx as unknown as { service: Record<string, unknown> }).service.token = async () => 'tok'
    const { socket } = await r.ask<{ socket: string }>('work.docs.connect', { source: r.source })
    // A Hocuspocus auth message for a bad token: the service answers it, so a frame went there and back.
    await r.ask('work.docs.send', { socket, frames: [Buffer.from([0]).toString('base64')] })
    const got = await r.ask<{ frames: string[]; closed?: unknown }>('work.docs.recv', { socket })
    expect(got.frames.length + (got.closed ? 1 : 0)).toBeGreaterThan(0)
    await r.ask('work.docs.close', { socket })
    await expect(r.ask('work.docs.recv', { socket })).rejects.toThrow(/closed/)
  })
})

describe('the relay', () => {
  it('sends in order, holds frames sent before the socket opened, waits for an answer, says when it closed, and closes an idle one', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const seen: string[] = []
    wss.on('connection', (ws) =>
      ws.on('message', (data: Buffer) => {
        seen.push(data.toString())
        if (data.toString() === 'bye') ws.close(4403, 'stop')
        else ws.send(Buffer.from(`echo ${data.toString()}`))
      })
    )
    await new Promise((resolve) => wss.once('listening', resolve))
    const port = (wss.address() as { port: number }).port
    let now = 0
    const relay = createRelay({ now: () => now, waitMs: 2000, idleMs: 60_000 })
    const id = relay.connect(`ws://127.0.0.1:${port}/x`, 'd1')
    expect(relay.docs()).toEqual(new Set(['d1']))
    relay.send(id, [Buffer.from('one').toString('base64'), Buffer.from('two').toString('base64')])
    const frames: string[] = []
    while (frames.length < 2) frames.push(...(await relay.recv(id)).frames.map((f) => Buffer.from(f, 'base64').toString()))
    expect(seen).toEqual(['one', 'two'])
    expect(frames).toEqual(['echo one', 'echo two'])
    relay.send(id, [Buffer.from('bye').toString('base64')])
    let closed: unknown
    while (!closed) closed = (await relay.recv(id)).closed
    expect(closed).toEqual({ code: 4403, reason: 'stop' })
    expect(relay.docs()).toEqual(new Set())
    const idle = relay.connect(`ws://127.0.0.1:${port}/x`, 'd2')
    now = 120_000
    await new Promise((resolve) => setTimeout(resolve, 5_200))
    expect(() => relay.send(idle, [])).toThrow(/closed/)
    relay.stop()
    wss.close()
  }, 15_000)
})

describe('words for the bar', () => {
  it('counts sections by heading, else paragraphs', () => {
    expect(changedParts('# A\n\nx\n\n# B\n\ny', '# A\n\nx2\n\n# B\n\ny')).toEqual({ count: 1, unit: 'section' })
    expect(changedParts('a\n\nb', 'a\n\nb2\n\nc')).toEqual({ count: 2, unit: 'paragraph' })
  })
})
