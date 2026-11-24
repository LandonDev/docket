import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { readPage } from 'work-kit/editor/page'
import { DOCUMENT_SCHEMA, fileDocName } from 'work-kit/collab-server'
import type { ClientRequest } from '@shared/contract'
import type { DocOpen, DocsPush, DocThreadRow } from '@shared/contract-work-docs'
import type { CanvasItem } from '@shared/work'
import type { WorkPush } from '@shared/contract-work'
import { FenceError } from '../../remote/fence'
import type { Caller, ToolCtx, WorkCtx } from '../modules'
import { servicePaths } from '../service/config'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { startWorkService, type RunningService } from '../service/serve'
import type { ServiceConfig } from '../service/wire'
import { NEEDS_PRESS } from '../files/policy'
import { docs } from './index'
import { createRelay, SOCKETS_MAX } from './relay'
import { docsOf, stopDocs } from './state'
import { fromLifeos } from './threads'
import { changedParts, docTools, SHARED_COMMENT } from './tools'

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
        if ((res.statusCode ?? 500) >= 400) reject(Object.assign(new Error(parsed.error ?? `HTTP ${res.statusCode}`), { status: res.statusCode }))
        else resolve(parsed)
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const md = (...lines: string[]) => lines.join('\n\n')

async function rig(o: { ownerSaid?: string[]; shared?: boolean; routineRunId?: string; sector?: string } = {}) {
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
    dataDir: join(dir, 'data'),
    log: () => {},
    push: (p: WorkPush) => pushes.push(p),
    reaches: (by: Caller) => by.kind !== 'remote',
    canvas: { get: (id: string) => (id === 'i1' ? item : null), paneOf: (id: string) => id },
    threads: { ownerSaid: (_: string, quote: string) => (o.ownerSaid ?? []).some((said) => said.includes(quote)) },
    lifeos: { connected: () => false, owner: () => ({ query: async (fn: string, args: { id?: string }) => (fn === 'docs:get' ? (convex.docs.get(args.id ?? '') ?? null) : []), mutation: async () => null }) },
    service: {
      internal: (route: string, body: unknown) => post(config.socketPath, route, body),
      url: (route: string) => `ws://127.0.0.1:${service.port}${route}`
    }
  } as unknown as WorkCtx
  open.ctxs.push(ctx)
  const toolCtx = { ...ctx, sessionId: 't1', signal: new AbortController().signal, scope: { shared: () => o.shared === true, routineRunId: o.routineRunId ?? null, sector: o.sector ?? null } } as unknown as ToolCtx
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
  return { dir, path, source, name, service, ctx, pushes, tool, ask, text, branches, convex, post: (route: string, body: unknown) => post(config.socketPath, route, body) }
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
    // Undo restores the version cut just before the write.
    await r.post('/internal/history/restore', { file: r.path, versionId: written.versionId, fence: { sectors: 'all' } })
    expect(await r.text()).toContain('9:00 AM')
    expect(await r.text()).not.toContain('9:30 AM')
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
    // On a shared document a routine's run suggests: no grant covers its write (milestone 50's hold review, finding 6).
    const s = await rig({ shared: true, routineRunId: 'run1' })
    expect((await s.tool('doc_write', { item: 'i1', markdown: md('# Week 1', 'Meet the team at 9:00 AM', '# Week 2', 'Routine words'), because: 'routine' })).text).toMatch(/^Suggested changes to 1 section: .* none does, so this counts as your own idea\.$/)
    expect(await s.text()).not.toContain('Routine words')
    // On his own document it writes.
    const mine = await rig({ routineRunId: 'run1' })
    expect((await mine.tool('doc_write', { item: 'i1', markdown: md('# Week 1', 'Meet the team at 9:00 AM', '# Week 2', 'Routine words'), because: 'routine' })).text).toBe('Wrote 1 section.')
    expect(await mine.text()).toContain('Routine words')
    expect((await mine.tool('doc_suggest', { item: 'i1', markdown: md('# Week 1', 'Suggested words') })).text).toMatch(/^Suggested changes to 2 sections: he steps through them/)
    expect(await mine.text()).toContain('Routine words')
  })

  it('a thread with no such item, or a path outside a .tcdoc, is told so', async () => {
    const r = await rig()
    expect(await r.tool('doc_read', { item: 'nope' })).toEqual({ text: 'This thread has no document nope in its canvas.', error: true })
    expect((await r.tool('doc_read', { file: join(r.dir, 'notes.txt') })).text).toMatch(/LifeOS document, a .tcdoc or a Google Doc/)
  })
})

describe("a mail's attachment read as a document", () => {
  it('an agent reads it by its item and is refused a write or a comment, by item or by path', async () => {
    const r = await rig()
    const { attachmentDocPathOf, ATTACHMENT_READ_ONLY } = await import('./target')
    const ctx = r.ctx as unknown as { dataDir: string; canvas: { get: (id: string) => unknown } }
    const mail = { id: 'm1', sessionId: 't1', kind: 'document', title: 'Brief.docx', source: { at: 'mail', threadId: 'mt1', messageId: 'mm1', partId: '2', name: 'Brief.docx' } }
    const was = ctx.canvas.get
    ctx.canvas.get = (id: string) => (id === 'm1' ? mail : was(id))
    expect((await r.tool('doc_read', { item: 'm1' })).text).toMatch(/has not been opened yet/)
    const path = attachmentDocPathOf(ctx.dataDir, mail as never)
    mkdirSync(dirname(path), { recursive: true })
    await r.service.collab.writeMarkdown(fileDocName(path), 'owner', md('# Brief', 'Doors at nine'), { path })
    // The service holds it open; its file on disk is what says the pane has read the attachment.
    if (!existsSync(path)) writeFileSync(path, '')
    expect(await r.tool('doc_read', { item: 'm1' })).toEqual({ text: '# Brief\n\nDoors at nine\n', error: false })
    expect(await r.tool('doc_write', { item: 'm1', markdown: md('# Brief', 'Doors at ten'), because: 'own' })).toEqual({ text: ATTACHMENT_READ_ONLY, error: true })
    expect(await r.tool('doc_write', { file: path, markdown: md('# Brief', 'Doors at ten'), because: 'own' })).toEqual({ text: ATTACHMENT_READ_ONLY, error: true })
    expect(await r.tool('doc_comment', { item: 'm1', quote: 'Doors', body: 'Why nine?' })).toEqual({ text: ATTACHMENT_READ_ONLY, error: true })
  })
})

describe('the fence', () => {
  it("a thread reaches only its own sector's LifeOS documents, whatever id it is handed", async () => {
    const r = await rig({ sector: 'purdue' })
    for (const [id, sector] of [['kdp', 'purdue'], ['kdc', 'cosmic']] as const) {
      r.convex.docs.set(id, { _id: id, sector, seq: 0, title: id, shared: false, markdown: '', plain: '' })
      await r.post('/internal/doc/write', { docId: id, markdown: `Words of ${sector}`, because: 'own', botId: 'k', fence: { sectors: 'all' } })
    }
    expect(await r.tool('doc_read', { doc: 'kdp' })).toEqual({ text: 'Words of purdue\n', error: false })
    for (const [name, args] of [
      ['doc_read', { doc: 'kdc' }],
      ['doc_write', { doc: 'kdc', markdown: 'mine now', because: 'own' }],
      ['doc_comment', { doc: 'kdc', quote: 'Words', body: 'x' }]
    ] as const)
      expect(await r.tool(name, args)).toEqual({ text: 'LifeOS has no such document', error: true })
    expect((await r.post('/internal/doc/read', { docId: 'kdc', fence: { sectors: 'all' } }) as { markdown: string }).markdown).toBe('Words of cosmic\n')
  })
})

describe('an agent formatting a document', () => {
  const blue = { on: { styled: 'Heading 1' }, run: { color: '#0F4761' } }
  const margins = { setup: { margins: { left: 36, right: 36 } } }
  const snapshot = async (r: Awaited<ReturnType<typeof rig>>) => {
    const direct = await r.service.collab.hocuspocus.openDirectConnection(r.name, { principal: 'owner', role: 'edit', file: { path: r.path } })
    try {
      return { bytes: Y.encodeStateAsUpdate(direct.document!), page: readPage(direct.document!) }
    } finally {
      await direct.disconnect({ unloadImmediately: false })
    }
  }

  it('formats his own document with an Undo version, which restores the text formatting and margins', async () => {
    const r = await rig()
    expect(await r.tool('doc_format', { item: 'i1', ...blue, ...margins, because: 'own' })).toMatchObject({
      error: false, text: expect.stringMatching(/^Applied 3 formatting changes:.*Text colour set to #0F4761.*Margins become/)
    })
    const written = docsPushes(r.pushes).find((p) => p.written)?.written
    expect(written?.versionId).toBeTruthy()
    expect((await snapshot(r)).page?.setup.margins).toMatchObject({ left: 36, right: 36 })
    await r.post('/internal/history/restore', { file: r.path, versionId: written!.versionId, fence: { sectors: 'all' } })
    expect((await snapshot(r)).page?.setup.margins).toMatchObject({ left: 72, right: 72 })
    expect((await r.tool('doc_read', { item: 'i1', with: 'styles' })).text).not.toContain('#0F4761')
  })

  it('a shared document keeps its bytes when asked has no owner quote, and writes with a verified quote', async () => {
    const r = await rig({ shared: true, ownerSaid: ['Make both headings blue'] })
    const before = await snapshot(r)
    const no = await r.tool('doc_format', { file: r.path, ...blue, because: 'asked', quote: 'words he never typed' })
    expect(no.text).toMatch(/^Suggested formatting on 2 paragraphs: .*quote was not found/)
    expect((await snapshot(r)).bytes).toEqual(before.bytes)
    expect((await snapshot(r)).page).toBeNull()
    expect(await r.branches()).toHaveLength(1)
    const asked = await r.tool('doc_format', { file: r.path, ...blue, because: 'asked', quote: 'both headings blue' })
    expect(asked).toEqual({ error: false, text: 'Formatted 2 paragraphs: Text colour set to #0F4761.' })
    expect((await snapshot(r)).page?.schema).toBe(1)
    expect(docsPushes(r.pushes).some((p) => p.written)).toBe(false)
  })

  it('a routine can write only in a run on his own document', async () => {
    const noRun = await rig({ shared: true })
    expect((await noRun.tool('doc_format', { item: 'i1', ...margins, because: 'routine' })).text).toMatch(/This thread runs no routine/)
    expect((await snapshot(noRun)).page).toBeNull()
    const sharedRun = await rig({ shared: true, routineRunId: 'run1' })
    expect((await sharedRun.tool('doc_format', { item: 'i1', ...margins, because: 'routine' })).text).toMatch(/^Suggested.*none does, so this counts as your own idea/)
    expect((await snapshot(sharedRun)).page).toBeNull()
    const privateRun = await rig({ routineRunId: 'run1' })
    expect((await privateRun.tool('doc_format', { item: 'i1', ...margins, because: 'routine' })).text).toMatch(/^Applied 1 formatting change/)
    expect((await snapshot(privateRun)).page?.setup.margins.left).toBe(36)
  })

  it('own ideas stay private on a shared document or in Suggests mode, and the page can be taken alone', async () => {
    const r = await rig({ shared: true })
    const before = await snapshot(r)
    const result = await r.tool('doc_format', { item: 'i1', ...blue, ...margins, because: 'own' })
    expect(result.text).toMatch(/^Suggested formatting on 3 formatting changes/)
    expect((await snapshot(r)).bytes).toEqual(before.bytes)
    expect(docsPushes(r.pushes).some((p) => p.branches)).toBe(true)
    const [branch] = await r.branches() as { id: string; diff: { page: string[]; rows: unknown[] } }[]
    expect(branch!.diff.page).toContainEqual(expect.stringMatching(/^Margins become/))
    expect(await r.post('/internal/history/decide', { file: r.path, branchId: branch!.id, which: ['@page'], accept: true, fence: { sectors: 'all' } })).toMatchObject({ left: 2 })
    expect((await snapshot(r)).page?.setup.margins.left).toBe(36)
    expect((await r.tool('doc_read', { item: 'i1', with: 'styles' })).text).not.toContain('#0F4761')

    const mine = await rig()
    await mine.ask('work.docs.mode', { source: mine.source, mode: 'suggests' })
    expect((await mine.tool('doc_format', { item: 'i1', ...margins, because: 'own' })).text).toMatch(/^Suggested formatting/)
    expect((await snapshot(mine)).page).toBeNull()
  })

  it('missing does not raise the schema, and the socket refuses malformed formatting with 400', async () => {
    const r = await rig()
    const before = await snapshot(r)
    expect(await r.tool('doc_format', { item: 'i1', on: { quote: 'no such words' }, run: { size: 17 }, ...margins, because: 'own' }))
      .toEqual({ error: false, text: 'Nothing in the document matches that.' })
    for (const change of [
      { setup: { columns: 5 } }, { setup: { margins: { left: -1 } } },
      { style: { name: 'Title', fontSize: 900 } }, { theme: { name: 'Incomplete' } },
      { header: { start: [{ field: 'unsupported' }], center: [], end: [] } },
      { text: { target: { all: true, styled: 'Title' }, run: { bold: true } } },
      { text: { target: { all: true }, run: { color: '#QQQQQQ' } } }
    ]) {
      await expect(r.post('/internal/docs/format', { file: r.path, principal: 'agent:env_box:t1', because: 'own', fence: { sectors: 'all' }, change }))
        .rejects.toMatchObject({ status: 400 })
    }
    await expect(r.post('/internal/docs/format', {
      file: r.path, principal: 'agent:env_box:t1', because: 'own', fence: { sectors: 'all', draftOnly: 0 }, change: margins
    })).rejects.toMatchObject({ status: 400 })
    expect((await snapshot(r)).bytes).toEqual(before.bytes)
    expect(await r.branches()).toEqual([])
  })

  it('doc_read describes a classic document and reports resolved style, theme, page and block formatting when styled', async () => {
    const r = await rig()
    const classic = await r.tool('doc_read', { file: r.path, with: 'styles' })
    expect(classic.text).toContain('This document has no styles of its own yet.')
    expect((await r.tool('doc_format', { file: r.path, ...blue, ...margins, style: { name: 'Heading 1', fontFamily: 'Arial', color: 'theme:accent1' }, because: 'own' })).error).toBe(false)
    const styled = await r.tool('doc_read', { file: r.path, with: 'styles' })
    expect(styled.text).toMatch(/^# Week 1/)
    expect(styled.text).toContain('Theme TempCode. Heading font')
    expect(styled.text).toContain('36 pt left')
    expect(styled.text).toContain('Heading 1: Arial, 16 pt, bold, #2A78D6 (theme:accent1)')
    expect(styled.text).toContain('Week 1: Heading 1, Text colour set to #0F4761.')
  })

  it('the fence refuses doc_format on a document outside the thread sector', async () => {
    const r = await rig({ sector: 'purdue' })
    r.convex.docs.set('kdc', { _id: 'kdc', sector: 'cosmic', seq: 0, title: 'kdc', shared: false, markdown: '', plain: '' })
    await r.post('/internal/doc/write', { docId: 'kdc', markdown: 'Words of cosmic', because: 'own', botId: 'k', fence: { sectors: 'all' } })
    expect(await r.tool('doc_format', { doc: 'kdc', ...margins, because: 'own' })).toEqual({ text: 'LifeOS has no such document', error: true })
    expect((await r.post('/internal/docs/read', { docId: 'kdc', with: 'styles', fence: { sectors: 'all' } }) as { styles: string[] }).styles)
      .toEqual(['This document has no styles of its own yet.'])
  })

  it('the doc_format description fits 400 UTF-8 bytes', () => {
    expect(Buffer.byteLength(docTools.find((tool) => tool.name === 'doc_format')!.description, 'utf8')).toBeLessThanOrEqual(400)
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

  it('is refused on a shared document, which others read before he would', async () => {
    const r = await rig({ shared: true })
    expect(await r.tool('doc_comment', { item: 'i1', quote: 'front desk', body: 'Which desk?' })).toEqual({ text: SHARED_COMMENT, error: true })
    const { rows } = await r.ask<{ rows: DocThreadRow[] }>('work.docs.threads', { source: r.source })
    expect(rows).toEqual([])
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
    // The host says the highest document schema it reads and writes, so a window offers nothing newer.
    expect(opened.schema).toBe(DOCUMENT_SCHEMA)
    expect(DOCUMENT_SCHEMA).toBeGreaterThanOrEqual(1)
    await expect(r.ask('work.docs.open', { source: r.source }, { kind: 'remote', caps: ['read'] })).rejects.toBeInstanceOf(FenceError)
  })

  it('a document others read is edited, commented on and renamed by his press alone: his window or a key that may approve', async () => {
    const r = await rig()
    r.convex.docs.set('kds', { _id: 'kds', sector: 'life', seq: 0, title: 'Plan', shared: true, markdown: '', plain: '' })
    const source = { at: 'lifeos', table: 'docs', id: 'kds' } as const
    const roles: string[] = []
    ;(r.ctx as unknown as { service: Record<string, unknown> }).service.token = async (t: { role: string }) => (roles.push(t.role), 'tok')
    const operator: Caller = { kind: 'remote', caps: ['read', 'operate'] }
    const approver: Caller = { kind: 'remote', caps: ['read', 'operate', 'approve'] }
    expect((await r.ask<DocOpen>('work.docs.open', { source }, operator)).role).toBe('view')
    expect((await r.ask<DocOpen>('work.docs.open', { source }, approver)).role).toBe('edit')
    expect((await r.ask<DocOpen>('work.docs.open', { source })).role).toBe('edit')
    for (const by of [operator, approver, { kind: 'local', caps: [] } as Caller]) await r.ask('work.docs.token', { source }, by)
    expect(roles).toEqual(['view', 'edit', 'edit'])
    await expect(r.ask('work.docs.thread', { source, change: { op: 'create', body: '[]', quote: 'Plan' } }, operator)).rejects.toThrow(NEEDS_PRESS)
    await expect(r.ask('work.docs.rename', { source, title: 'Other' }, operator)).rejects.toThrow(NEEDS_PRESS)
    // One only he reads: a key that may operate edits it as before.
    r.convex.docs.get('kds')!.shared = false
    expect((await r.ask<DocOpen>('work.docs.open', { source }, operator)).role).toBe('edit')
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

describe('the schema a window knows', () => {
  it("is said to the service in the socket's address, for the window whose socket this host opens; a window that says none says nothing", async () => {
    const r = await rig()
    ;(r.ctx as unknown as { service: Record<string, unknown> }).service.token = async () => 'tok'
    const asked: string[] = []
    const relay = docsOf(r.ctx).relay
    const connect = relay.connect.bind(relay)
    relay.connect = (url: string, doc: string) => (asked.push(url), connect(url, doc))
    const a = await r.ask<{ socket: string }>('work.docs.connect', { source: r.source, schema: 1 })
    const b = await r.ask<{ socket: string }>('work.docs.connect', { source: r.source })
    expect(asked[0]).toMatch(/\/w\/doc\/[^?]+\?schema=1$/)
    expect(asked[1]).toMatch(/\/w\/doc\/[^?]+$/)
    await r.ask('work.docs.close', { socket: a.socket })
    await r.ask('work.docs.close', { socket: b.socket })
    // Only a whole number is ever written into the address: nothing a socket could be steered with.
    const c = await r.ask<{ socket: string }>('work.docs.connect', { source: r.source, schema: '1&x=y' })
    expect(asked[2]).toMatch(/\/w\/doc\/[^?&]+$/)
    await r.ask('work.docs.close', { socket: c.socket })
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
    // A waiting recv hears the host stop at once.
    const waiting = relay.connect(`ws://127.0.0.1:${port}/x`, 'd3')
    const heard = relay.recv(waiting)
    relay.stop()
    expect((await heard).closed).toEqual({ code: 1001, reason: 'the host stopped' })
    wss.close()
  }, 15_000)
})

describe('the relay\'s limits', () => {
  it('refuses a socket past the most a host holds', () => {
    const fake = () => ({ on() {}, close() {}, terminate() {}, send() {}, readyState: 0, binaryType: '' }) as never
    const relay = createRelay({ socket: fake })
    for (let i = 0; i < SOCKETS_MAX; i++) relay.connect('ws://x', `d${i}`)
    expect(() => relay.connect('ws://x', 'one more')).toThrow(/too many documents/)
    relay.stop()
  })
})

describe('words for the bar', () => {
  it('counts sections by heading, else paragraphs', () => {
    expect(changedParts('# A\n\nx\n\n# B\n\ny', '# A\n\nx2\n\n# B\n\ny')).toEqual({ count: 1, unit: 'section' })
    expect(changedParts('a\n\nb', 'a\n\nb2\n\nc')).toEqual({ count: 2, unit: 'paragraph' })
  })
})
