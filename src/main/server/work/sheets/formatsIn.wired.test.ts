import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { SheetView } from '@shared/contract-work-sheets'
import type { SessionMeta } from '@shared/events'
import type { CanvasSource, WorkScope } from '@shared/work'
import type { SheetImportDone } from '@shared/work/sheetFormats'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { canvasStoreOf } from '../canvas/store'
import type { ConvertJob } from '../formats/jobs'

/**
 * The other formats in and the shared .csv, through the pillar as a window and a thread call it
 * (SHT8): `work.sheets.*` and the tools on an .xls, an .ods and a .tsv that open as an Excel copy,
 * and on a .csv in a folder others can open, whose edits reach the file. The library is a dummy
 * folder Files calls a place others can open; the converter is a stand-in (the real one is in
 * formatsIn.live.test.ts).
 */
const state = vi.hoisted(() => ({ said: [] as string[], library: '' }))
vi.mock('../scope', async (original) => ({
  ...(await original<typeof import('../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
vi.mock('../threads', () => ({
  threadsPart: () => ({
    threads: {
      start: async () => 'x',
      resume: async () => {},
      ownerSaid: (_id: string, quote: string) => state.said.some((w) => w.includes(quote))
    }
  })
}))
vi.mock('../files/policy', async (original) => {
  const real = await original<typeof import('../files/policy')>()
  return { ...real, sharedOf: (ctx: never, source: CanvasSource) => (source.at === 'file' && !!state.library && source.path.startsWith(state.library)) || real.sharedOf(ctx, source) }
})
const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas/index')
const { sheets } = await import('./index')
const { setJobs } = await import('./held')
const { sheetFileMoved } = await import('./moved')
const { forgetCsvCaches } = await import('./formatsInCsv')
const { localJobs } = await import('./workerClient')
const { SheetHost } = await import('./host/host')
const { TcsheetBackend } = await import('./host/backends')
setJobs(localJobs)

const CORPUS = join(import.meta.dirname, 'harness/corpus')
let dir: string
let library: string
let mine: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
let jobs: ConvertJob[]
const sessions = new Map<string, SessionMeta>()
const registry = { get: (id: string) => sessions.get(id) ?? null, onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {} } as unknown as SessionRegistry

const req = (method: string, params: unknown): ClientRequest => ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest)
const call = async <T = unknown,>(method: string, params: unknown, by: Parameters<typeof work.handle>[1] = LOCAL_PRINCIPAL): Promise<T> => {
  const out = await work.handle(req(method, params), by)
  return (out.handled ? out.result : undefined) as T
}
const tool = async (name: string, args: unknown): Promise<{ text: string; isError?: boolean }> => {
  const r = (await work.tools.call({ id: 't1', scope: 'work' }, name, args, new AbortController().signal)) as { content: Array<{ text?: string }>; isError?: boolean }
  return { text: r.content.map((c) => c.text ?? '').join(''), isError: r.isError }
}
const file = (path: string): CanvasSource => ({ at: 'file', host: 'env_test', path })
const open = (path: string, owner = 't1'): string => canvasStoreOf(db).open(owner, { kind: 'sheet', source: file(path), title: path.split('/').pop()! }).id
const filesUnder = (root: string): string[] => (existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : [])
const scratch = (): string => join(dir, 'work-files', 'preview-scratch')
const typed = (sheet: string, row: number, col: number, v: unknown) => ({ id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: sheet, cellValue: { [row]: { [col]: { v } } } } })
/** The copy's first sheet, cell A2, read from the bytes the grid loads. */
async function loaded(itemId: string): Promise<{ sheet: string; a2: unknown; rev: number }> {
  const view = await call<SheetView>('work.sheets.open', { itemId })
  const got = await call<{ data: string; format: string }>('work.sheets.load', { itemId, rev: view.rev, offset: 0, length: 4 * 1024 * 1024 })
  expect(got.format).toBe('xlsx')
  const { workbook } = importXlsx(new Uint8Array(Buffer.from(got.data, 'base64')))
  const sheet = workbook.sheetOrder[0]!
  return { sheet, a2: workbook.sheets[sheet]?.cellData?.[1]?.[0]?.v, rev: view.rev }
}
const a2Of = (bytes: Uint8Array): unknown => {
  const { workbook } = importXlsx(bytes)
  return workbook.sheets[workbook.sheetOrder[0]!]?.cellData?.[1]?.[0]?.v
}
/** What the stand-in wrote for a save back: the copy's own bytes behind the name of the pair that recalculates. */
const written = (path: string, format: string): Uint8Array => new Uint8Array(readFileSync(path).subarray(`${format}+calc:`.length))

function serve(): void {
  const host = new SheetHost((ref) => new TcsheetBackend((ref as { tcsheet: string }).tcsheet, join(dir, 'sheets', 'suggestions')))
  const service = (work.ctx as unknown as { service: { internal: (route: string, body: Record<string, never>) => Promise<unknown> } }).service
  service.internal = async (route, b: Record<string, never>) => {
    const op = route.split('/').pop()!
    const h = host as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    if (op === 'open') return h.open(b.sheet)
    if (op === 'range') return h.range(b.sheet, b.range)
    if (op === 'apply') return h.apply(b.sheet, b.baseRev, b.mutations, b.by)
    if (op === 'cells') return h.cells(b.sheet, b.cells, b.by, b.suggest === true, b.reason)
    if (op === 'review') return h.review(b.sheet, b.which, b.verdict)
    if (op === 'snapshot') return h.snapshot(b.sheet, b.rev, b.offset, b.length)
    if (op === 'since') return h.since(b.sheet, b.rev)
    throw new Error(`not in this test: ${op}`)
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-sheets-formats-'))
  library = mkdtempSync(join(tmpdir(), 'tc-sheets-library-'))
  mine = mkdtempSync(join(tmpdir(), 'tc-sheets-mine-'))
  Object.assign(state, { said: [], library })
  jobs = []
  forgetCsvCaches()
  db = openDb(join(dir, 'test.db'))
  sessions.set('t1', { id: 't1', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: { roots: () => [dir, library, mine], denied: () => [] } }, [canvas, sheets])
  await call('work.set', { enabled: true })
  const cols = (db.prepare(`PRAGMA table_info(workspaces)`).all() as { name: string; notnull: number; dflt_value: unknown }[]).filter((c) => c.notnull && c.dflt_value === null && !['id', 'name', 'path'].includes(c.name))
  db.prepare(`INSERT INTO workspaces (id, name, path, kind${cols.map((c) => `, ${c.name}`).join('')}) VALUES ('w1', 'Mine', ?, 'work'${cols.map(() => ', 0').join('')})`).run(mine)
  serve()
  Object.assign(work.ctx, {
    convert: async (job: ConvertJob) => {
      jobs.push(job)
      if (job.to === 'xlsx') copyFileSync(join(CORPUS, 'formulas.xlsx'), job.output!)
      else writeFileSync(job.output!, Buffer.concat([Buffer.from(`${job.to}:`), readFileSync(job.input)]))
      return { output: job.output!, ranOn: 'env_test', warnings: [] }
    }
  })
})
afterEach(() => {
  work.close()
  db.close()
  for (const d of [dir, library, mine]) rmSync(d, { recursive: true, force: true })
})

describe('his own .xls, .ods or .tsv in the sheet editor', () => {
  it('opens as an Excel copy under the file\'s own name: the grid loads a workbook, an edit saves into the copy, the file is untouched', async () => {
    const path = join(mine, 'Ledger.xls')
    writeFileSync(path, 'an old workbook')
    const itemId = open(path)
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view).toMatchObject({ store: 'package', name: 'Ledger.xls', shared: false, imported: { format: 'xls', name: 'Ledger.xls' } })
    expect(view.readOnly).toBeUndefined()
    const first = await loaded(itemId)
    expect(first.a2).toBe(1)
    expect(await call('work.sheets.edit', { itemId, baseRev: first.rev, mutations: [typed(first.sheet, 1, 0, 4242)] })).toEqual({ rev: first.rev + 1 })
    expect((await loaded(itemId)).a2).toBe(4242)
    expect(readFileSync(path, 'utf8')).toBe('an old workbook')
    expect(readdirSync(mine)).toEqual(['Ledger.xls'])
    // converted once, however often it is asked for
    expect(jobs.filter((j) => j.to === 'xlsx')).toHaveLength(1)
  })

  it('Save back writes the copy as the format it was; Save as Excel writes an .xlsx beside it and opens that', async () => {
    const path = join(mine, 'Ledger.ods')
    writeFileSync(path, 'an old workbook')
    const itemId = open(path)
    const first = await loaded(itemId)
    await call('work.sheets.edit', { itemId, baseRev: first.rev, mutations: [typed(first.sheet, 1, 0, 'back')] })
    const back = await call<SheetImportDone>('work.sheets.imported', { itemId, act: 'back' })
    expect(back.path).toBe(path)
    expect(a2Of(written(path, 'ods'))).toBe('back')
    expect((await call<SheetView>('work.sheets.open', { itemId })).imported).toEqual({ format: 'ods', name: 'Ledger.ods' })
    const out = await call<SheetImportDone>('work.sheets.imported', { itemId, act: 'xlsx' })
    expect(out.path).toBe(join(mine, 'Ledger.xlsx'))
    expect(a2Of(new Uint8Array(readFileSync(out.path!)))).toBe('back')
    // the .xlsx is an ordinary opened Excel file: no copy, nothing to save back
    const next = await call<SheetView>('work.sheets.open', { itemId: out.itemId })
    expect(next).toMatchObject({ store: 'package', name: 'Ledger.xlsx' })
    expect(next.imported).toBeUndefined()
  })

  it('a thread reads and writes it through the copy, by item or by path; the file changes by his press alone', async () => {
    const path = join(mine, 'Scores.tsv')
    writeFileSync(path, 'name\tpoints\nAda\t1.50\n')
    const itemId = open(path)
    // (a .tsv is read here, with no converter)
    const read = await tool('sheet_read', { file: path, range: 'A1:B2' })
    expect(read.isError).toBeUndefined()
    expect(read.text).toContain('points')
    expect(jobs).toEqual([])
    state.said.push('put 77 in B2 please')
    const wrote = await tool('sheet_write', { item: itemId, cells: [{ at: 'B2', v: 77 }], because: 'asked', quote: 'put 77 in B2' })
    expect(wrote.isError).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe('name\tpoints\nAda\t1.50\n')
    const thread = { kind: 'model' as const, caps: [], sessionId: 't1' }
    await expect(sheets.handle!(req('work.sheets.imported', { itemId, act: 'back' }), work.ctx, thread)).rejects.toThrow('Only the owner saves a copy back or out')
    expect(readFileSync(path, 'utf8')).toBe('name\tpoints\nAda\t1.50\n')
    // his press writes the one field the thread changed
    await call('work.sheets.imported', { itemId, act: 'back' })
    expect(readFileSync(path, 'utf8')).toBe('name\tpoints\nAda\t77\n')
  })

  it('a file he changed in another program is read again while the copy holds nothing of his; an edited copy is kept and says so, until he reads again', async () => {
    const path = join(mine, 'Ledger.xls')
    writeFileSync(path, 'an old workbook')
    const itemId = open(path)
    const first = await call<SheetView>('work.sheets.open', { itemId })
    writeFileSync(path, 'saved again from Excel, longer')
    const second = await call<SheetView>('work.sheets.open', { itemId })
    expect(jobs.filter((j) => j.to === 'xlsx')).toHaveLength(2)
    // the grids load the new copy: a revision from outside
    expect(second.rev).toBe(first.rev + 1)
    const now = await loaded(itemId)
    await call('work.sheets.edit', { itemId, baseRev: now.rev, mutations: [typed(now.sheet, 1, 0, 'mine')] })
    writeFileSync(path, 'and once more from Excel, longer still')
    const kept = await call<SheetView>('work.sheets.open', { itemId })
    expect(kept.imported).toEqual({ format: 'xls', name: 'Ledger.xls', stale: true })
    expect((await loaded(itemId)).a2).toBe('mine')
    await expect(call('work.sheets.imported', { itemId, act: 'back' })).rejects.toThrow('Ledger.xls changed since this copy was made. Save as Excel to keep your edits.')
    expect(readFileSync(path, 'utf8')).toBe('and once more from Excel, longer still')
    await call('work.sheets.imported', { itemId, act: 'again' })
    const again = await call<SheetView>('work.sheets.open', { itemId })
    expect(again.imported).toEqual({ format: 'xls', name: 'Ledger.xls' })
    expect(again.rev).toBeGreaterThan(kept.rev)
    expect((await loaded(itemId)).a2).toBe(1)
  })

  it('renamed in Files, the file keeps its copy, its edits and its revisions', async () => {
    const a = join(mine, 'Ledger.xls')
    const b = join(mine, 'Ledger 2025.xls')
    writeFileSync(a, 'an old workbook')
    const itemId = open(a)
    const first = await loaded(itemId)
    await call('work.sheets.edit', { itemId, baseRev: first.rev, mutations: [typed(first.sheet, 1, 0, 'carried')] })
    const { sheetsOf } = await import('./held')
    await (await sheetsOf(work.ctx)).packages.idle()
    renameSync(a, b)
    sheetFileMoved(file(a), file(b), { db, dataDir: dir, host: 'env_test' } as never)
    const moved = open(b)
    const view = await call<SheetView>('work.sheets.open', { itemId: moved })
    expect(view).toMatchObject({ name: 'Ledger 2025.xls', rev: first.rev + 1, imported: { format: 'xls', name: 'Ledger 2025.xls' } })
    expect((await loaded(moved)).a2).toBe('carried')
    expect(jobs.filter((j) => j.to === 'xlsx')).toHaveLength(1)
  })
})

describe('an .xls, .ods or .tsv in a folder others can open', () => {
  it('opens as a copy in its tab\'s own folder under Files\' scratch: nothing beside the file, nothing among what the app keeps, gone with the tab', async () => {
    mkdirSync(join(library, 'Budget'))
    const path = join(library, 'Budget', 'Ledger.xls')
    writeFileSync(path, 'a shared old workbook')
    const itemId = open(path)
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view).toMatchObject({ store: 'package', name: 'Ledger.xls', shared: true, imported: { format: 'xls', name: 'Ledger.xls' } })
    expect(jobs[0]).toMatchObject({ from: 'xls', to: 'xlsx', shared: true })
    const first = await loaded(itemId)
    await call('work.sheets.edit', { itemId, baseRev: first.rev, mutations: [typed(first.sheet, 1, 0, 'in the tab')] })
    const { sheetsOf } = await import('./held')
    await (await sheetsOf(work.ctx)).packages.idle()
    expect(readdirSync(join(library, 'Budget'))).toEqual(['Ledger.xls'])
    expect(filesUnder(join(scratch(), 'sheets', 'imports', itemId)).length).toBeGreaterThan(0)
    // everything made of it lies under the scratch both backups leave out; the log keeps no typed value
    expect(filesUnder(dir).filter((f) => !f.startsWith(scratch()) && !/\/test(-cold)?\.db/.test(f))).toEqual([])
    expect(JSON.stringify(db.prepare('SELECT mutations FROM work_sheets_ops').all())).not.toContain('in the tab')
    // its tab closed for good
    sheets.itemsRemoved!([canvasStoreOf(db).get(itemId)!], work.ctx)
    await new Promise((r) => setTimeout(r, 20))
    await (await sheetsOf(work.ctx)).packages.idle()
    expect(filesUnder(join(scratch(), 'sheets'))).toEqual([])
  })

  it('Save back goes through Files\' door into the file; Save as Excel lands in his own workspace\'s folder, never beside the file', async () => {
    const path = join(library, 'Ledger.ods')
    writeFileSync(path, 'a shared old workbook')
    const itemId = open(path)
    const first = await loaded(itemId)
    await call('work.sheets.edit', { itemId, baseRev: first.rev, mutations: [typed(first.sheet, 1, 0, 'for the team')] })
    await call('work.sheets.imported', { itemId, act: 'back' })
    expect(a2Of(written(path, 'ods'))).toBe('for the team')
    expect(readdirSync(library)).toEqual(['Ledger.ods'])
    const out = await call<SheetImportDone>('work.sheets.imported', { itemId, act: 'xlsx' })
    expect(out.path).toBe(join(mine, 'Ledger.xlsx'))
    expect(readdirSync(library)).toEqual(['Ledger.ods'])
    // a remote key without approve changes nothing there
    const operate = { kind: 'remote', keyId: 'k1', name: 'Phone', audience: 'client', caps: ['read', 'operate'] } as never
    await expect(call('work.sheets.imported', { itemId, act: 'back' }, operate)).rejects.toThrow('this key may not change it')
  })

  it('by its path alone, with no tab to hold a copy, a thread is told to open it first', async () => {
    const path = join(library, 'Ledger.xls')
    writeFileSync(path, 'a shared old workbook')
    const read = await tool('sheet_read', { file: path, range: 'A1:B2' })
    expect(read.isError).toBe(true)
    expect(read.text).toContain('Ledger.xls is in a folder others can open, so its copy lasts only as long as its tab: open it in the canvas first.')
    expect(jobs).toEqual([])
  })
})

describe('a .csv in a folder others can open takes an edit, and the file holds it', () => {
  const SECRET = 'Q4-forecast-7731'

  it('his edit in the grid is saved through to the file at once: one field changed, nothing beside it, nothing among what the app keeps', async () => {
    const csv = join(library, 'List.csv')
    writeFileSync(csv, `name,code\r\n"Ada",1.50\r\nBo,007\r\n`)
    const itemId = open(csv)
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view).toMatchObject({ store: 'csv', shared: true })
    expect(view.readOnly).toBeUndefined()
    expect(await call('work.sheets.edit', { itemId, baseRev: view.rev, mutations: [typed('sheet1', 2, 0, SECRET)] })).toEqual({ rev: view.rev + 1 })
    expect(readFileSync(csv, 'utf8')).toBe(`name,code\r\n"Ada",1.50\r\n${SECRET},007\r\n`)
    expect(readdirSync(library)).toEqual(['List.csv'])
    expect(filesUnder(join(dir, 'sheets', 'csv'))).toEqual([])
    // the same sheet goes on: the next edit builds on the last, and the grid is not sent back to the start
    const after = await call<SheetView>('work.sheets.open', { itemId })
    expect(after.rev).toBe(view.rev + 1)
    await call('work.sheets.edit', { itemId, baseRev: after.rev, mutations: [typed('sheet1', 3, 0, 'Cy')] })
    expect(readFileSync(csv, 'utf8')).toBe(`name,code\r\n"Ada",1.50\r\n${SECRET},007\r\nCy\r\n`)
  })

  it('a thread\'s asked write reaches the file too; its own idea waits as a suggestion and the file stays byte for byte until he accepts', async () => {
    const csv = join(library, 'List.csv')
    writeFileSync(csv, 'name,code\nAda,1\n')
    const itemId = open(csv)
    await call<SheetView>('work.sheets.open', { itemId })
    const own = await tool('sheet_write', { item: itemId, cells: [{ at: 'A2', v: SECRET }], because: 'own' })
    expect(own.text).toMatch(/^Suggested 1 cell/)
    expect(readFileSync(csv, 'utf8')).toBe('name,code\nAda,1\n')
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.suggestions).toHaveLength(1)
    await call('work.sheets.review', { itemId, which: 'all', verdict: 'accept' })
    expect(readFileSync(csv, 'utf8')).toBe(`name,code\n${SECRET},1\n`)
    state.said.push('put x in B2 please')
    const asked = await tool('sheet_write', { item: itemId, cells: [{ at: 'B2', v: 'x' }], because: 'asked', quote: 'put x in B2' })
    expect(asked.isError).toBeUndefined()
    expect(readFileSync(csv, 'utf8')).toBe(`name,code\n${SECRET},x\n`)
  })

  it('a co-author\'s newer file is never written over, and one a save would damage opens to read', async () => {
    const csv = join(library, 'List.csv')
    writeFileSync(csv, 'name,code\nAda,1\n')
    const itemId = open(csv)
    const view = await call<SheetView>('work.sheets.open', { itemId })
    await call('work.sheets.edit', { itemId, baseRev: view.rev, mutations: [typed('sheet1', 1, 1, 2)] })
    writeFileSync(csv, 'name,code\nTheirs,9,more\n')
    // the newer file is read into a sheet of its own: the open grid's next edit meets an earlier revision and is not written
    expect(await call('work.sheets.edit', { itemId, baseRev: view.rev + 1, mutations: [typed('sheet1', 2, 0, 'mine')] })).toEqual({ conflict: true, rev: 0 })
    expect(readFileSync(csv, 'utf8')).toBe('name,code\nTheirs,9,more\n')
    // so the grid reads the newer file, and the edit sent again lands on top of it
    expect(await call('work.sheets.since', { itemId, rev: view.rev + 1 })).toEqual({ rev: 0, reload: true })
    expect(await call('work.sheets.edit', { itemId, baseRev: 0, mutations: [typed('sheet1', 2, 0, 'mine')] })).toEqual({ rev: 1 })
    expect(readFileSync(csv, 'utf8')).toBe('name,code\nTheirs,9,more\nmine\n')
    const latin = join(library, 'Latin.csv')
    writeFileSync(latin, Buffer.from([0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]))
    const other = open(latin)
    const read = await call<SheetView>('work.sheets.open', { itemId: other })
    expect(read.readOnly).toContain('not UTF-8')
    await expect(call('work.sheets.edit', { itemId: other, baseRev: read.rev, mutations: [typed('sheet1', 0, 0, 'x')] })).rejects.toThrow('not UTF-8')
    expect([...readFileSync(latin)]).toEqual([0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a])
  })
})
