import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { fileDocName } from 'work-kit/collab-server'
import { readDocx } from 'work-kit/formats/docx'
import type { ClientRequest } from '@shared/contract'
import type { ExportAnswer, ImportAnswer } from '@shared/contract-work-formats'
import type { CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { servicePaths } from '../service/config'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { startWorkService, type RunningService } from '../service/serve'
import type { ServiceConfig } from '../service/wire'
import { ensureThreadTables } from '../docs/threads'
import { importFolderOf } from '../files/imports'
import { madeFromShared } from './exporter'
import { formats } from './index'
import { droppedWords, freePath, safeName } from './importer'
import { convertersOf, JobRunner } from './jobs'
import { setPrinter } from './print'
import { runTool, Toolchain } from './tools'

/*
 * Import and export on this host: the Work service in process (its socket
 * routes, a real Hocuspocus, history over the .tcdoc), the formats module's
 * methods called as main calls them, and the formats report's Word corpus.
 * With TEMP_CODE_WORK_TOOLS_DATA set to a userData the installer filled (the
 * box's), LibreOffice and pymupdf4llm are the real ones and the round trips
 * through OpenDocument, RTF and PDF run; without it those tests are skipped.
 */

const REAL = process.env.TEMP_CODE_WORK_TOOLS_DATA
// work-kit's Word corpus, wherever the package is installed.
const CORPUS = join(dirname(createRequire(import.meta.url).resolve('work-kit/formats/docx')), 'corpus')
const SECRET = 'f'.repeat(43)
const open: { dirs: string[]; services: RunningService[]; convex: FakeConvex[] } = { dirs: [], services: [], convex: [] }

afterEach(async () => {
  setPrinter(null)
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

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'm21-formats-'))
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
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)')
  ensureThreadTables(db)
  const work = join(dir, 'Work', 'Northside')
  mkdirSync(work, { recursive: true })
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run('w1', 'Northside', work)
  const runner = new JobRunner({ host: 'env_box', dataDir: join(dir, 'data'), converters: convertersOf([formats], () => {}), tools: new Toolchain(REAL ?? join(dir, 'data')) })
  const opened: { pane: string; source: CanvasSource; title: string }[] = []
  const closed: string[] = []
  const ctx = {
    db,
    host: 'env_box',
    dataDir: join(dir, 'data'),
    log: () => {},
    push: () => {},
    reaches: (by: Caller, path: string) => by.kind !== 'remote' || path.startsWith(work),
    scopeOf: (id: string) => (id === 't1' ? { sessionId: 't1', workspaceId: 'w1', sector: null, host: 'env_box', away: false, routineRunId: null, shared: () => false } : null),
    canvas: {
      paneOf: (id: string) => id,
      get: (id: string) => (id === 'i0' ? { id: 'i0', sessionId: 't1' } : id === 'other' ? { id: 'other', sessionId: 't2' } : null),
      open: (pane: string, _kind: string, source: CanvasSource, title: string) => (opened.push({ pane, source, title }), { id: `i${opened.length + 1}` }),
      close: (id: string) => void closed.push(id),
      // As the store does: open the new item, close the old one only when it is the same pane's.
      replace(pane: string, oldId: string | undefined, kind: string, source: CanvasSource, title: string) {
        const item = this.open(pane, kind, source, title)
        if (oldId && this.get(oldId)?.sessionId === pane) this.close(oldId)
        return item
      }
    },
    lifeos: { connected: () => false, owner: () => ({ query: async () => null, mutation: async () => null }) },
    service: { internal: (route: string, body: unknown) => post(config.socketPath, route, body) },
    convert: (job: Parameters<JobRunner['convert']>[0]) => runner.convert(job)
  } as unknown as WorkCtx
  const ask = async <T,>(method: string, params: unknown, by: Caller = { kind: 'local', caps: [] }): Promise<T> => {
    const done = await formats.handle!({ id: '1', method, params } as ClientRequest, ctx, by)
    if (!done.handled) throw new Error('not handled')
    return done.result as T
  }
  const branches = async (path: string) => ((await post(config.socketPath, '/internal/history/branches', { file: path, fence: { sectors: 'all' } })) as { branches: { authors: string[] }[] }).branches
  return { dir, work, ctx, ask, branches, opened, closed, service, post: (route: string, body: unknown) => post(config.socketPath, route, body) }
}

const word = (r: Awaited<ReturnType<typeof rig>>, name = 'review.docx') => {
  const path = join(r.work, name)
  copyFileSync(join(CORPUS, name), path)
  return path
}
const threadsOf = (s: ReturnType<typeof readDocx>['sidecar']) => s.threads.map((t) => [t.quote, t.resolved, t.comments.map((c) => c.author)])
const authorsOf = (s: ReturnType<typeof readDocx>['sidecar']) => [...new Set(s.changes.filter((c) => c.kind !== 'format').map((c) => c.author))].sort()

describe('a Word file opened in the canvas', () => {
  it('becomes a .tcdoc beside it, with its threads stored, a branch per author, and the canvas item reopened on it', async () => {
    const r = await rig()
    const original = word(r)
    const before = readFileSync(original)
    const got = await r.ask<ImportAnswer>('work.formats.import', { sessionId: 't1', itemId: 'i0', from: { at: 'source', source: { at: 'file', host: 'env_box', path: original } } })
    expect(got.source).toEqual({ at: 'file', host: 'env_box', path: join(r.work, 'review.tcdoc') })
    expect(got.outsiders).toBe(true)
    expect(readFileSync(original).equals(before)).toBe(true)
    expect(r.opened).toEqual([{ pane: 't1', source: got.source, title: 'review' }])
    expect(r.closed).toEqual(['i0'])
    // An item of another thread's pane is never closed by an import.
    await r.ask<ImportAnswer>('work.formats.import', { sessionId: 't1', itemId: 'other', from: { at: 'source', source: { at: 'file', host: 'env_box', path: original } } })
    expect(r.closed).toEqual(['i0'])
    const rows = JSON.parse((r.ctx.db.prepare('SELECT rows FROM work_docs_threads WHERE doc = ?').get(fileDocName(join(r.work, 'review.tcdoc'))) as { rows: string }).rows) as unknown[]
    expect(rows).toHaveLength(3)
    expect((await r.branches(join(r.work, 'review.tcdoc'))).map((b) => b.authors[0]).sort()).toEqual(['external:Ada Reviewer', 'external:Ben Editor'])
    // A second import of the same file makes another document, never over the first.
    const again = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path: original } } })
    expect((again.source as { path: string }).path).toBe(join(r.work, 'review 3.tcdoc'))
  })

  it("a mail's attachment is read once into a .tcdoc beside its fetched copy, opens and closes nothing, and is viewed, not edited", async () => {
    const r = await rig()
    const { fetchedFile } = await import('../canvas/fetch')
    const { roleOf } = await import('../docs/index')
    const { targetOf } = await import('../docs/target')
    const source: CanvasSource = { at: 'mail', threadId: 'mt1', messageId: 'mm1', partId: '2', name: 'review.docx' }
    const item = { id: 'm1', sessionId: 't1', workspaceId: 'w1', kind: 'document', title: 'review.docx', source, state: 'open', position: 0, rev: 0, createdAt: 0, updatedAt: 0 }
    const was = r.ctx.canvas.get
    ;(r.ctx.canvas as { get: (id: string) => unknown }).get = (id: string) => (id === 'm1' ? item : was(id))
    const copy = fetchedFile(r.ctx.dataDir, item as never)
    mkdirSync(dirname(copy), { recursive: true })
    copyFileSync(join(CORPUS, 'review.docx'), copy)
    const got = await r.ask<ImportAnswer>('work.formats.import', { itemId: 'm1', from: { at: 'source', source } })
    expect(got.source).toEqual({ at: 'file', host: 'env_box', path: join(dirname(copy), 'review.tcdoc') })
    expect(existsSync(join(dirname(copy), 'review.tcdoc'))).toBe(true)
    expect(r.opened).toEqual([])
    expect(r.closed).toEqual([])
    // Asked again (a remount, another window), it is the same document: none made beside it.
    const again = await r.ask<ImportAnswer>('work.formats.import', { itemId: 'm1', from: { at: 'source', source } })
    expect(again.source).toEqual(got.source)
    expect(existsSync(join(dirname(copy), 'review 2.tcdoc'))).toBe(false)
    // An item that is not this attachment's is refused.
    await expect(r.ask('work.formats.import', { itemId: 'i0', from: { at: 'source', source } })).rejects.toThrow("not this item's")
    // Read only for every caller, this window too; a document of his edits as before.
    const local = { kind: 'local', caps: [] } as Caller
    expect(roleOf(local, r.ctx, await targetOf(r.ctx, local, 'work.docs.open', got.source))).toBe('view')
    const his = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path: word(r) } } })
    expect(roleOf(local, r.ctx, await targetOf(r.ctx, local, 'work.docs.open', his.source))).toBe('edit')
    // Its tracked changes are shown and never decided, its versions never restored or cut.
    const { history, READ_ONLY } = await import('../history/index')
    const hist = (method: string, params: unknown) => history.handle!({ id: '1', method, params } as ClientRequest, r.ctx, local)
    await expect(hist('work.history.decide', { source: got.source, branchId: 'b1', which: ['x'], accept: true })).rejects.toThrow(READ_ONLY)
    await expect(hist('work.history.restore', { source: got.source, versionId: 'v1' })).rejects.toThrow(READ_ONLY)
    await expect(hist('work.history.cut', { source: got.source })).rejects.toThrow(READ_ONLY)
    expect((await hist('work.history.branches', { source: got.source })).handled).toBe(true)
  })

  it('a remote key reaches only files inside its roots', async () => {
    const r = await rig()
    const outside = join(r.dir, 'elsewhere.docx')
    copyFileSync(join(CORPUS, 'review.docx'), outside)
    await expect(r.ask('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path: outside } } }, { kind: 'remote', caps: ['operate'] } as unknown as Caller)).rejects.toBeInstanceOf(FenceError)
  })

  it('a dropped file is kept in the thread’s workspace folder, beside its document', async () => {
    const r = await rig()
    const data = readFileSync(join(CORPUS, 'tables.docx')).toString('base64')
    const got = await r.ask<ImportAnswer>('work.formats.import', { sessionId: 't1', from: { at: 'bytes', name: '../../tables.docx', data } })
    expect(existsSync(join(r.work, 'tables.docx'))).toBe(true)
    expect((got.source as { path: string }).path).toBe(join(r.work, 'tables.tcdoc'))
    expect(got.warnings.some((w) => /inside a table/.test(w))).toBe(true)
  })

  it('HTML the window read comes in as blocks', async () => {
    const r = await rig()
    const blocks = [{ id: 'h1', type: 'heading', props: { level: 1 }, content: [{ type: 'text', text: 'Agenda', styles: {} }], children: [] }]
    const got = await r.ask<ImportAnswer>('work.formats.import', { sessionId: 't1', from: { at: 'blocks', name: 'agenda.html', blocks } })
    const md = ((await r.post('/internal/docs/read', { file: (got.source as { path: string }).path, fence: { sectors: 'all' } })) as { markdown: string }).markdown
    expect(md).toContain('# Agenda')
  })
})

describe('a document out as a file', () => {
  it('Word: its pending branches as tracked changes and its threads as comments, with their authors, replies and resolved state', async () => {
    const r = await rig()
    const original = word(r)
    const first = readDocx(new Uint8Array(readFileSync(original)))
    const got = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path: original } } })
    const out = await r.ask<ExportAnswer>('work.formats.export', { source: got.source, format: 'docx' })
    expect(out.name).toBe('review.docx')
    const back = readDocx(new Uint8Array(Buffer.from(out.data, 'base64')))
    expect(threadsOf(back.sidecar)).toEqual(threadsOf(first.sidecar))
    expect(authorsOf(back.sidecar)).toEqual(['Ada Reviewer', 'Ben Editor'])
  })

  it('markdown: the live text', async () => {
    const r = await rig()
    const got = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path: word(r, 'long-report.docx') } } })
    const out = await r.ask<ExportAnswer>('work.formats.export', { source: got.source, format: 'md' })
    const text = Buffer.from(out.data, 'base64').toString('utf8')
    expect(out.name).toBe('long-report.md')
    expect(text).toMatch(/^# /m)
    expect(text).toMatch(/\[\^fn\d+\]: Source for 1\.1/)
  })

  it('PDF: the window’s print page printed here', async () => {
    const r = await rig()
    let printed = ''
    setPrinter(async (html, o) => ((printed = `${o.paper}:${html}`), { pdf: new TextEncoder().encode('%PDF-1.7'), warnings: [] }))
    const out = await r.ask<ExportAnswer>('work.formats.print', { name: 'Plan', html: '<h1>Plan</h1>', paper: 'Letter' })
    expect(out).toEqual({ name: 'Plan.pdf', data: Buffer.from('%PDF-1.7').toString('base64'), warnings: [] })
    expect(printed).toBe('Letter:<h1>Plan</h1>')
  })
})

describe.skipIf(!REAL)('through the real LibreOffice, pymupdf4llm and Docling (TEMP_CODE_WORK_TOOLS_DATA)', () => {
  it('a .docx with comments and tracked changes round-trips through OpenDocument with authors, replies and resolved flags intact', async () => {
    const r = await rig()
    const original = word(r)
    const first = readDocx(new Uint8Array(readFileSync(original)))
    const got = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path: original } } })
    const odt = await r.ask<ExportAnswer>('work.formats.export', { source: got.source, format: 'odt' })
    expect(odt.name).toBe('review.odt')
    const path = join(r.work, 'back.odt')
    writeFileSync(path, Buffer.from(odt.data, 'base64'))
    const again = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path } } })
    const word2 = await r.ask<ExportAnswer>('work.formats.export', { source: again.source, format: 'docx' })
    const back = readDocx(new Uint8Array(Buffer.from(word2.data, 'base64')))
    expect(threadsOf(back.sidecar)).toEqual(threadsOf(first.sidecar))
    expect(authorsOf(back.sidecar)).toEqual(['Ada Reviewer', 'Ben Editor'])
  }, 120_000)

  it('RTF out and back in keeps the words and the tracked changes', async () => {
    const r = await rig()
    const got = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path: word(r) } } })
    const rtf = await r.ask<ExportAnswer>('work.formats.export', { source: got.source, format: 'rtf' })
    const path = join(r.work, 'back.rtf')
    writeFileSync(path, Buffer.from(rtf.data, 'base64'))
    const again = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path } } })
    const md = ((await r.post('/internal/docs/read', { file: (again.source as { path: string }).path, fence: { sectors: 'all' } })) as { markdown: string }).markdown
    expect(md).toContain('Loans')
    expect((await r.branches((again.source as { path: string }).path)).length).toBeGreaterThan(0)
  }, 120_000)

  it('a scanned PDF (pictures of pages, no text) comes in through Docling’s OCR', async () => {
    const r = await rig()
    const pdf = await r.ctx.convert({ from: 'docx', to: 'pdf', input: word(r, 'long-report.docx') })
    // Each page as a picture in a new PDF: what a scanner makes.
    const scan = join(r.work, 'scanned.pdf')
    const py = new Toolchain(REAL!).bin('pdf-tools')!
    const made = await runTool(py, ['-I', '-c', 'import sys, pypdfium2 as p\nd = p.PdfDocument(sys.argv[1])\nim = [d[i].render(scale=200/72).to_pil().convert("L") for i in range(2)]\nim[0].save(sys.argv[2], save_all=True, append_images=im[1:], resolution=200)', pdf.output, scan])
    expect(made.code).toBe(0)
    const got = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path: scan } } })
    expect(got.warnings).toContain('Read from the page pictures by OCR: check the words.')
    const md = ((await r.post('/internal/docs/read', { file: (got.source as { path: string }).path, fence: { sectors: 'all' } })) as { markdown: string }).markdown
    expect(md).toMatch(/Annual Operations Report/i)
    expect(md.replace(/\s/g, '').length).toBeGreaterThan(400)
  }, 300_000)

  it('a PDF that is mostly tables comes in through Docling', async () => {
    const r = await rig()
    const pdf = await r.ctx.convert({ from: 'docx', to: 'pdf', input: word(r, 'tables.docx') })
    const path = join(r.work, 'tables-heavy.pdf')
    copyFileSync(pdf.output, path)
    const got = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path } } })
    expect(got.warnings).toContain('Its tables were read by Docling, which keeps no bold or italic.')
    const md = ((await r.post('/internal/docs/read', { file: (got.source as { path: string }).path, fence: { sectors: 'all' } })) as { markdown: string }).markdown
    expect(md.split('\n').filter((l) => l.startsWith('|')).length).toBeGreaterThan(20)
  }, 300_000)

  it('a PDF of text comes in through pymupdf4llm, and Docling is not asked', async () => {
    const r = await rig()
    const pdf = await r.ctx.convert({ from: 'docx', to: 'pdf', input: word(r, 'review.docx') })
    const path = join(r.work, 'review.pdf')
    copyFileSync(pdf.output, path)
    const got = await r.ask<ImportAnswer>('work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path } } })
    expect(got.warnings).toEqual([])
    const md = ((await r.post('/internal/docs/read', { file: (got.source as { path: string }).path, fence: { sectors: 'all' } })) as { markdown: string }).markdown
    expect(md).toContain('Loans')
  }, 120_000)
})

describe('which reader a PDF gets', () => {
  it('pymupdf4llm stands for text; Docling reads a scan and a PDF with tables', async () => {
    const { needsDocling } = await import('./pdfIn')
    const prose = 'A paragraph of ordinary words. '.repeat(10)
    expect(needsDocling(prose, 0)).toBeNull()
    expect(needsDocling('  \n ', 0)).toBe('scan')
    expect(needsDocling(prose, 3)).toBe('tables')
  })
})

describe('a document made from a file others can open', () => {
  it('is known by where the importer wrote it, and its conversions are told so they never leave this host', async () => {
    const r = await rig()
    const data = join(r.dir, 'data')
    const ctx = { db: r.ctx.db, host: 'env_box', dataDir: data }
    const imported = join(importFolderOf(data, { host: 'env_box', path: '/Users/him/OneDrive - Purdue/Roster.docx' }), 'Roster.tcdoc')
    expect(madeFromShared(ctx, { at: 'file', host: 'env_box', path: imported })).toBe(true)
    // his own things under the app's data are his own: an item's folder, the imports root itself
    expect(madeFromShared(ctx, { at: 'file', host: 'env_box', path: join(data, 'canvas', 'i1', 'Notes.tcdoc') })).toBe(false)
    expect(madeFromShared(ctx, { at: 'file', host: 'env_box', path: join(data, 'work-files', 'imports') })).toBe(false)
    // a file this host cannot see is taken as shared, as the files door rules
    expect(madeFromShared(ctx, { at: 'file', host: 'env_mac', path: '/Users/him/Plan.tcdoc' })).toBe(true)
    expect(madeFromShared(ctx, { at: 'lifeos', table: 'docs', id: 'd1' } as CanvasSource)).toBe(false)

    // The export of such a document converts a scratch copy: the job itself must say shared.
    const jobs: { shared?: boolean; input: string }[] = []
    const real = r.ctx.convert
    ;(r.ctx as { convert: unknown }).convert = async (job: { shared?: boolean; input: string; to: string }) => {
      jobs.push(job)
      writeFileSync(`${job.input}.${job.to}`, 'converted')
      return { output: `${job.input}.${job.to}`, ranOn: 'env_box', warnings: [] }
    }
    mkdirSync(dirname(imported), { recursive: true })
    const mine = await r.ask<ImportAnswer>('work.formats.import', { sessionId: 't1', from: { at: 'source', source: { at: 'file', host: 'env_box', path: word(r) } } })
    await r.ask<ExportAnswer>('work.formats.export', { source: mine.source, format: 'odt' })
    expect(jobs.at(-1)).toMatchObject({ shared: false })
    copyFileSync((mine.source as { path: string }).path, imported)
    await r.ask<ExportAnswer>('work.formats.export', { source: { at: 'file', host: 'env_box', path: imported }, format: 'rtf' })
    expect(jobs.at(-1)).toMatchObject({ shared: true })
    ;(r.ctx as { convert: unknown }).convert = real
  })
})

describe('names and words', () => {
  it('a file name keeps no path, and a free name is found beside a taken one', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd')
    expect(safeName('a:b?.docx')).toBe('a b .docx')
    const dir = mkdtempSync(join(tmpdir(), 'm21-names-'))
    open.dirs.push(dir)
    writeFileSync(join(dir, 'Plan.tcdoc'), '')
    expect(freePath(dir, 'Plan', '.tcdoc')).toBe(join(dir, 'Plan 2.tcdoc'))
    expect(droppedWords({ imageInCell: 1, nestedTable: 2, zero: 0 })).toEqual(['1 picture inside a table cell left out', '2 tables inside a table kept as text'])
  })
})

describe('the print window', () => {
  it('loads nothing but its own page and inline data: no network, no other file on this host', async () => {
    const { mayLoad } = await import('./print')
    expect(mayLoad('data:image/png;base64,AAAA')).toBe(true)
    expect(mayLoad('file:///etc/passwd')).toBe(false)
    expect(mayLoad('https://example.org/a.png')).toBe(false)
    expect(mayLoad('blob:file:///x')).toBe(false)
  })
})
