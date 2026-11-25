import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollabSigner, fileDocName, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE } from 'work-kit/collab-server'
import type { GuestSource } from '@shared/contract-work-guests'
import type { CanvasItem } from '@shared/work'
import type { Caller, ToolCtx, WorkCtx } from '../modules'
import { docs } from '../docs/index'
import { stopDocs } from '../docs/state'
import { docTools } from '../docs/tools'
import { servicePaths } from '../service/config'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { LIMITS } from '../service/routes/guests'
import { startWorkService, type RunningService } from '../service/serve'
import { setJobs } from '../sheets/held'
import { TcsheetBackend } from '../sheets/host/backends'
import { sheets } from '../sheets/index'
import { sheetTools } from '../sheets/tools'
import { localJobs } from '../sheets/workerClient'
import { GuestRuntime } from './links'
import { ensureGuestTables, fileLinked } from './store'

/*
 * An agent's own write to an item a guest link opens is a suggestion, and only while the link stands
 * (docs/agents/work-guests.md "Shared", "A file's link": "No LifeOS mark"). For each of the four items a link can
 * name (a LifeOS document, a LifeOS sheet, a .tcdoc, a .tcsheet): with no link the thread's own write lands; he makes a
 * link; the same write waits as a suggestion and the item is as it was; he revokes it; the write lands again.
 *
 * All four run end to end in process: the real Work service (its internal doc and sheet routes, Hocuspocus, the sheet
 * host), main's real GuestRuntime making and revoking the link (and so the LifeOS mark), and the thread's real
 * `doc_write` and `sheet_write` tools deciding. LifeOS is the fake Convex behind a small stand-in of this file's own,
 * which keeps a sheet's `shared` (the fake answers every sheet as unshared) and the suggestions LifeOS is handed.
 */

const SECRET = 'l'.repeat(43)
const LOCAL: Caller = { kind: 'local', caps: [] }
const DOC = 'kdoc1'
const SHEET = 'ksheet1'
const open: { dirs: string[]; services: RunningService[]; convex: FakeConvex[]; servers: Server[]; ctxs: WorkCtx[] } = { dirs: [], services: [], convex: [], servers: [], ctxs: [] }

setJobs(localJobs)
beforeEach(() => {
  LIMITS.requests.clear()
  LIMITS.failures.clear()
  vi.stubEnv('TEMP_CODE_WORK_PUBLIC_ORIGIN', 'https://proof.example')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of open.ctxs.splice(0)) stopDocs(ctx)
  await Promise.all(open.services.splice(0).map((s) => s.stop().catch(() => {})))
  for (const s of open.servers.splice(0)) await new Promise<void>((res) => (s.closeAllConnections(), s.close(() => res())))
  await Promise.all(open.convex.splice(0).map((c) => c.close()))
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(20)
  }
}

function internal(socketPath: string, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` } }, (res) => {
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

/**
 * LifeOS as the service reaches it: the fake Convex, with a sheet's `shared` as this test keeps it (the guest link's
 * mark), and the sheet suggestions it is handed kept and answered, as LifeOS keeps them.
 */
async function lifeosStandIn(convex: FakeConvex) {
  const sharedSheets = new Set<string>()
  const suggested: { sheetId: string; changeSetId: string; cells: { sheet: string; row: number; col: number; base: string | null; proposed: string | null }[] }[] = []
  const rows: Record<string, unknown>[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const call = (() => {
      try {
        return JSON.parse(body.toString()) as { path?: string; args?: Record<string, unknown> }
      } catch {
        return {}
      }
    })()
    const json = (v: unknown) => (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify({ status: 'success', value: v })))
    if (call.path === 'sheets:suggest') {
      const s = call.args as (typeof suggested)[number] & { by: string }
      suggested.push(s)
      for (const c of s.cells) rows.push({ _id: `sg${rows.length + 1}`, sheetId: s.sheetId, changeSetId: s.changeSetId, by: s.by, ...c, state: 'pending' })
      return json(null)
    }
    if (call.path === 'sheets:suggestions') return json(rows.filter((x) => x.sheetId === call.args?.sheetId && x.state === call.args?.state))
    if (call.path === 'sheets:setSuggestions') {
      for (const u of (call.args?.cells ?? []) as { id: string }[]) Object.assign(rows.find((x) => x._id === u.id) ?? {}, u)
      return json(null)
    }
    const got = await fetch(`${convex.url}${req.url}`, { method: req.method, headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) }, ...(req.method === 'GET' ? {} : { body }) })
    const bytes = Buffer.from(await got.arrayBuffer())
    if (call.path === 'sheets:get') {
      const answer = JSON.parse(bytes.toString()) as { value?: { shared?: boolean } | null }
      if (answer.value) answer.value.shared = sharedSheets.has(String(call.args?.id))
      res.writeHead(got.status, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(answer))
    }
    res.writeHead(got.status, { 'Content-Type': got.headers.get('content-type') ?? 'application/octet-stream' })
    return res.end(bytes)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  open.servers.push(server)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sharedSheets, suggested }
}

async function rig() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'linked-writes-')))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  const lifeos = await lifeosStandIn(convex)
  convex.docs.set(DOC, { _id: DOC, sector: 'life', seq: 0, title: 'Run of show', shared: false, markdown: '', plain: '' })
  convex.sheets.set(SHEET, { title: 'Budget', sector: 'life', ops: [] })
  const keys = await generateCollabKeys('k')
  const signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  const hosted = join(dir, 'hosted')
  mkdirSync(join(hosted, 'guest'), { recursive: true })
  writeFileSync(join(hosted, 'guest', 'index.html'), '<!doctype html><p>guest page</p>')
  const folder = join(dir, 'workspace')
  for (const d of [join(dir, 'data'), folder]) mkdirSync(d, { recursive: true })
  const socketPath = servicePaths(join(dir, 'data')).socketPath
  const service = await startWorkService(
    {
      port: 0,
      socketPath,
      secret: SECRET,
      dataDir: join(dir, 'data', 'work-service'),
      hostedDir: hosted,
      host: 'env_box',
      lifeos: { here: true, url: lifeos.url },
      trusted: [{ by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }],
      links: []
    },
    { jwt: async () => 'owner-jwt', log: (line) => void (process.env.LINKED_LOG && console.error(line)) }
  )
  open.services.push(service)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, kind TEXT, sector TEXT)')
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Dummy job', ?, 'work', 'life')").run(folder)
  ensureGuestTables(db)
  docs.ensure!(db)
  sheets.ensure!(db)
  const items = new Map<string, CanvasItem>()
  const ctx = {
    db,
    host: 'env_box',
    dataDir: join(dir, 'data'),
    log: () => {},
    push: () => {},
    reaches: () => true,
    scopeOf: () => ({ sessionId: 't1', workspaceId: null, sector: null, host: 'env_box', away: false, routineRunId: null, shared: () => false }),
    canvas: { get: (id: string) => items.get(id) ?? null, paneOf: (s: string) => s },
    threads: { ownerSaid: () => false, resume: async () => {} },
    service: { url: (route: string) => `http://127.0.0.1:${service.port}${route}`, token: async () => 'ok', internal: (route: string, body: unknown) => internal(socketPath, route, body) },
    lifeos: {
      connected: () => true,
      owner: () => ({
        query: async (fn: string, args: { id: string }) => {
          if (fn === 'docs:get') return convex.docs.get(args.id) ?? null
          if (fn === 'docs:threads') return []
          if (fn === 'sheets:get') {
            const sh = convex.sheets.get(args.id)
            return sh ? { _id: args.id, title: sh.title, sector: sh.sector, shared: lifeos.sharedSheets.has(args.id) } : null
          }
          return null
        },
        // The guest link's mark, as LifeOS takes it: the row's `shared`, which every write guard reads.
        mutation: async (fn: string, args: { id: string; shared: boolean }) => {
          if (fn === 'docs:setShared') convex.docs.get(args.id)!.shared = args.shared
          else if (fn === 'sheets:setShared') args.shared ? lifeos.sharedSheets.add(args.id) : lifeos.sharedSheets.delete(args.id)
          return null
        }
      })
    }
  } as unknown as WorkCtx
  open.ctxs.push(ctx)
  const toolCtx = { ...ctx, sessionId: 't1', signal: new AbortController().signal, scope: { shared: () => false, routineRunId: null, sector: null, workspaceId: null } } as unknown as ToolCtx
  const rt = new GuestRuntime(ctx, () => ({ tokenSigner: () => signer, setLinks: (links) => service.setLinks(links), setProject: (id, project) => service.setProject(id, project) }))
  /** A thread's tool, as its harness calls it. */
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> => {
    const t = [...docTools, ...sheetTools].find((x) => x.name === name)!
    const got = await t.run(t.input.parse(args), toolCtx)
    return { text: (got.content[0] as { text: string }).text, error: got.isError === true }
  }
  /** `doc_write` over the text it just read, as an agent writes one. */
  const docWrite = async (target: { doc?: string; file?: string }, markdown: string) => {
    const read = await tool('doc_read', target)
    if (read.error) throw new Error(`doc_read: ${read.text}`)
    return tool('doc_write', { ...target, markdown, because: 'own', revision: /Revision (r[0-9a-f]+)/.exec(read.text)?.[1] })
  }
  const link = (source: GuestSource, title: string) => rt.create({ source, title, name: 'Dana Lee', role: 'edit', expiresAt: Date.now() + 7 * 24 * 60 * 60_000, bySession: null, by: LOCAL })
  const cell = async (sheet: Record<string, string>, at: string): Promise<unknown> => ((await internal(socketPath, '/internal/sheet/range', { sheet, range: at })) as { cells: { v?: unknown }[][] }).cells[0]?.[0]?.v
  return { dir, folder, convex, lifeos, service, socketPath, ctx, rt, items, tool, docWrite, link, cell }
}
/** A file's bytes once the document store has stopped writing it (it stores a second after the last change, five at most). */
async function settledBytes(path: string): Promise<Buffer> {
  let last = readFileSync(path)
  let since = Date.now()
  const end = Date.now() + 10_000
  while (Date.now() - since < 1500) {
    if (Date.now() > end) throw new Error(`${path} kept changing`)
    await sleep(100)
    const now = readFileSync(path)
    if (!now.equals(last)) (last = now), (since = Date.now())
  }
  return last
}

const md = (...lines: string[]) => lines.join('\n\n')
const SUGGESTED_DOC = /^Suggested in the document: changes to 1 paragraph, because others share this document\. The file has not changed\./
const SUGGESTED_SHEET = /^Suggested in the sheet: 1 cell, because others share this sheet/

describe("an agent's own write to an item a guest link opens", () => {
  it('a LifeOS document: written while nobody else can open it, a suggestion while the link stands, written again once it is revoked', async () => {
    const r = await rig()
    const target = { doc: DOC }
    const text = async () => (await r.service.collab.read(DOC)).markdown
    const branches = () => r.convex.branches.filter((b) => b.docId === DOC && b.state === 'pending')
    await r.service.collab.writeMarkdown(DOC, 'owner', 'Doors at nine')
    // (a) No link: the agent's own idea is written.
    expect(await r.docWrite(target, 'Doors at ten')).toEqual({ text: 'Wrote 1 paragraph.', error: false })
    expect(await text()).toContain('Doors at ten')
    // (b) He makes a link: LifeOS marks the row shared.
    const made = await r.link({ at: 'lifeos', table: 'docs', id: DOC }, 'Run of show')
    expect(r.convex.docs.get(DOC)!.shared).toBe(true)
    // (c) The same kind of write waits as a branch, and the text stays.
    const before = await text()
    const held = await r.docWrite(target, 'Doors at eleven')
    expect(held.error).toBe(false)
    expect(held.text).toMatch(SUGGESTED_DOC)
    expect(await text()).toBe(before)
    expect(await text()).not.toContain('eleven')
    expect(branches()).toHaveLength(1)
    // (d) He revokes it: the mark comes off.
    await r.rt.revoke(made.link.id)
    await r.rt.settle()
    expect(r.convex.docs.get(DOC)!.shared).toBe(false)
    // (e) Written again.
    expect(await r.docWrite(target, 'Doors at noon')).toEqual({ text: 'Wrote 1 paragraph.', error: false })
    expect(await text()).toContain('Doors at noon')
    expect(branches()).toHaveLength(1)
  })

  it('a LifeOS sheet: written while nobody else can open it, a suggestion while the link stands, written again once it is revoked', async () => {
    const r = await rig()
    r.items.set('s1', { id: 's1', sessionId: 't1', kind: 'sheet', title: 'Budget', source: { at: 'lifeos', table: 'sheets', id: SHEET }, state: null, openedAt: 1, closedAt: null } as unknown as CanvasItem)
    const ref = { lifeos: SHEET }
    const write = (v: number) => r.tool('sheet_write', { item: 's1', cells: [{ at: 'B2', v }], because: 'own' })
    // (a) No link: written.
    expect(await write(1)).toEqual({ text: 'Wrote B2.', error: false })
    expect(await r.cell(ref, 'B2')).toBe(1)
    const ops = r.convex.sheets.get(SHEET)!.ops.length
    // (b) He makes a link: LifeOS marks the sheet shared.
    const made = await r.link({ at: 'lifeos', table: 'sheets', id: SHEET }, 'Budget')
    expect(r.lifeos.sharedSheets.has(SHEET)).toBe(true)
    // (c) The same write waits as a suggestion in LifeOS; no op reaches the sheet and the cell stays.
    const held = await write(2)
    expect(held.error).toBe(false)
    expect(held.text).toMatch(SUGGESTED_SHEET)
    expect(await r.cell(ref, 'B2')).toBe(1)
    expect(r.convex.sheets.get(SHEET)!.ops).toHaveLength(ops)
    expect(r.lifeos.suggested).toHaveLength(1)
    expect(r.lifeos.suggested[0]).toMatchObject({ sheetId: SHEET, cells: [expect.objectContaining({ row: 1, col: 1 })] })
    // (d) Revoked: the mark comes off.
    await r.rt.revoke(made.link.id)
    await r.rt.settle()
    expect(r.lifeos.sharedSheets.has(SHEET)).toBe(false)
    // (e) Written again.
    expect(await write(3)).toEqual({ text: 'Wrote B2.', error: false })
    expect(await r.cell(ref, 'B2')).toBe(3)
    expect(r.lifeos.suggested).toHaveLength(1)
  })

  it('a .tcdoc: written while nobody else can open it, a suggestion while the link stands with the file unchanged, written again once it is revoked', async () => {
    const r = await rig()
    const path = join(r.folder, 'Field trip plan.tcdoc')
    const name = fileDocName(path)
    const target = { file: path }
    const text = async () => (await r.service.collab.read(name, { path })).markdown
    const branches = async () => ((await internal(r.socketPath, '/internal/history/branches', { file: path, fence: { sectors: 'all' } })) as { branches: unknown[] }).branches
    await r.service.collab.writeMarkdown(name, 'owner', md('Bus at seven'), { path })
    await until('the file is written', () => existsSync(path))
    // (a) No link: written.
    expect(await r.docWrite(target, 'Bus at eight')).toEqual({ text: 'Wrote 1 paragraph.', error: false })
    expect(await text()).toContain('Bus at eight')
    await until('the file holds the write', async () => (await settledBytes(path)).length > 0 && (await text()).includes('eight'))
    // (b) He makes a link: no LifeOS row, the live link itself is the mark.
    const made = await r.link({ at: 'file', host: 'env_box', path }, 'Field trip plan')
    expect(fileLinked(r.ctx.db, path)).toBe(true)
    // (c) The same write waits as a branch: the text and the file's bytes are as they were.
    const bytes = await settledBytes(path)
    const before = await text()
    const held = await r.docWrite(target, 'Bus at nine')
    expect(held.error).toBe(false)
    expect(held.text).toMatch(SUGGESTED_DOC)
    expect(await text()).toBe(before)
    expect(await branches()).toHaveLength(1)
    expect((await settledBytes(path)).equals(bytes)).toBe(true)
    // (d) Revoked: the file reads as his alone again.
    await r.rt.revoke(made.link.id)
    expect(fileLinked(r.ctx.db, path)).toBe(false)
    // (e) Written again.
    expect(await r.docWrite(target, 'Bus at ten')).toEqual({ text: 'Wrote 1 paragraph.', error: false })
    expect(await text()).toContain('Bus at ten')
  })

  it('a .tcsheet: written while nobody else can open it, a suggestion while the link stands with the file unchanged, written again once it is revoked', async () => {
    const r = await rig()
    const path = join(r.folder, 'Field trip budget.tcsheet')
    TcsheetBackend.create(path, 'Field trip budget')
    const ref = { tcsheet: path }
    const write = (v: number) => r.tool('sheet_write', { file: path, cells: [{ at: 'C3', v }], because: 'own' })
    // (a) No link: written, to the file.
    expect(await write(10)).toEqual({ text: 'Wrote C3.', error: false })
    expect(await r.cell(ref, 'C3')).toBe(10)
    // (b) He makes a link: the live link is the mark.
    const made = await r.link({ at: 'file', host: 'env_box', path }, 'Field trip budget')
    expect(fileLinked(r.ctx.db, path)).toBe(true)
    // (c) The same write waits as a suggestion: the cell and the file's bytes are as they were.
    const bytes = readFileSync(path)
    const held = await write(20)
    expect(held.error).toBe(false)
    expect(held.text).toMatch(SUGGESTED_SHEET)
    expect(await r.cell(ref, 'C3')).toBe(10)
    await sleep(300)
    expect(readFileSync(path).equals(bytes)).toBe(true)
    const opened = (await internal(r.socketPath, '/internal/sheet/open', { sheet: ref })) as { shared: boolean; suggestions: unknown[] }
    expect(opened.suggestions).toHaveLength(1)
    // (d) Revoked.
    await r.rt.revoke(made.link.id)
    expect(fileLinked(r.ctx.db, path)).toBe(false)
    // (e) Written again.
    expect(await write(30)).toEqual({ text: 'Wrote C3.', error: false })
    expect(await r.cell(ref, 'C3')).toBe(30)
  })
})
