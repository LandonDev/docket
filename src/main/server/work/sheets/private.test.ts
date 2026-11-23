import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { SheetView } from '@shared/contract-work-sheets'
import type { SessionMeta } from '@shared/events'
import type { CanvasSource, WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { canvasStoreOf } from '../canvas/store'
import { readText, readZip } from './patch/zip'

/**
 * The owner's ruling (2026-11-23): what an agent proposes on a workbook anyone else can open is
 * kept on his host and shown only to him. Nothing of it is written to the file, to the folder it
 * syncs from, or to a guest's page, until he approves; then the cells are written as an ordinary
 * edit. A change he asked for in so many words is still written at once.
 *
 * Here: an opened .xlsx and a .tcsheet in a Teams or OneDrive library (`sharedOf`), through the
 * tools as a thread calls them. The guest's live page is held in service/routes/sheet.test.ts.
 */
const state = vi.hoisted(() => ({ said: [] as string[], library: '' }))
vi.mock('../scope', async (original) => ({
  ...(await original<typeof import('../scope')>()),
  scopePart: () => ({
    // The scope alone calls nothing shared: only where the file lies says so.
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
/** The test's library: a folder Files calls a place others can open. Every other path is judged by the real rule. */
vi.mock('../files/policy', async (original) => {
  const real = await original<typeof import('../files/policy')>()
  return { ...real, sharedOf: (ctx: never, source: CanvasSource) => (source.at === 'file' && !!state.library && source.path.startsWith(state.library)) || real.sharedOf(ctx, source) }
})
const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas/index')
const { sheets } = await import('./index')
const { setJobs } = await import('./held')
const { localJobs } = await import('./workerClient')
const { SheetHost } = await import('./host/host')
const { TcsheetBackend, writeTcsheet, gz, blankWorkbook } = await import('./host/backends')
setJobs(localJobs)

const CORPUS = join(import.meta.dirname, 'harness/corpus')
let dir: string
let library: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const sessions = new Map<string, SessionMeta>()
const registry = {
  get: (id: string) => sessions.get(id) ?? null,
  onRemoved: () => () => {},
  onWorkspaceDeleted: () => () => {}
} as unknown as SessionRegistry

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
const open = (path: string, title: string): string => canvasStoreOf(db).open('t1', { kind: 'sheet', source: file(path), title }).id
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
/** Every file under the library with its hash: the file itself, and anything written beside it. */
const folder = (): Record<string, string> => Object.fromEntries(readdirSync(library, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => [join(e.parentPath, e.name).slice(library.length + 1), sha(join(e.parentPath, e.name))]))
const SECRET = 'Q4-forecast-7731'

/** The Work service's sheet host in this process, keeping suggestions under this host's data as the service does. */
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
    throw new Error(`not in this test: ${op}`)
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-sheets-private-'))
  // The library is outside the app's own data, as a OneDrive folder is.
  library = mkdtempSync(join(tmpdir(), 'tc-sheets-library-'))
  Object.assign(state, { said: [], library })
  db = openDb(join(dir, 'test.db'))
  sessions.set('t1', { id: 't1', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: { roots: () => [dir, library], denied: () => [] } }, [canvas, sheets])
  await call('work.set', { enabled: true })
  serve()
})
afterEach(() => {
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(library, { recursive: true, force: true })
})

describe('an agent\'s suggestion on an Excel file others can open', () => {
  let path: string
  let itemId: string
  const cell = (): unknown => {
    const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
    return workbook.sheets[workbook.sheetOrder.find((s) => workbook.sheets[s]?.name === 'Data')!]?.cellData?.[1]?.[0]?.v
  }
  beforeEach(() => {
    mkdirSync(join(library, 'Budget'), { recursive: true })
    path = join(library, 'Budget', 'Budget.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    itemId = open(path, 'Budget.xlsx')
  })

  it('sheet_suggest leaves the file and its folder byte for byte, and the change waits on this host', async () => {
    const before = folder()
    const r = await tool('sheet_suggest', { item: itemId, cells: [{ at: 'Data!A2', v: SECRET }], reason: 'the new forecast' })
    expect(r.isError).toBeUndefined()
    expect(folder()).toEqual(before)
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.shared).toBe(true)
    expect(view.rev).toBe(0)
    expect(view.suggestions).toHaveLength(1)
    expect(view.suggestions[0].proposed).toEqual({ v: SECRET })
    expect((db.prepare('SELECT COUNT(*) AS n FROM work_sheets_suggestions').get() as { n: number }).n).toBe(1)
    expect(folder()).toEqual(before)
  })

  it('his own idea through sheet_write is a suggestion there too, whatever the sheet\'s mode, and by its path alone', async () => {
    expect((await call<SheetView>('work.sheets.open', { itemId })).mode).toBe('writes')
    const before = folder()
    const a = await tool('sheet_write', { item: itemId, cells: [{ at: 'Data!A2', v: SECRET }], because: 'own' })
    expect(a.text).toMatch(/^Suggested 1 cell: others share this sheet/)
    const b = await tool('sheet_write', { file: path, cells: [{ at: 'Data!A3', v: SECRET }], because: 'own' })
    expect(b.text).toMatch(/^Suggested 1 cell: others share this sheet/)
    // A quote he never said counts as the agent's own idea.
    const c = await tool('sheet_write', { item: itemId, cells: [{ at: 'Data!A4', v: SECRET }], because: 'asked', quote: 'put the forecast in' })
    expect(c.text).toMatch(/^Suggested 1 cell/)
    expect(folder()).toEqual(before)
  })

  it('his accept writes the cell as his own ordinary edit; a reject leaves nothing anywhere', async () => {
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'Data!A2', v: SECRET }] })
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'Data!A3', v: 'dropped' }] })
    const before = folder()
    const [first, second] = (await call<SheetView>('work.sheets.open', { itemId })).suggestions
    const rejected = await call<SheetView>('work.sheets.review', { itemId, which: { ids: [second.id] }, verdict: 'reject' })
    expect(rejected.suggestions).toHaveLength(1)
    expect(folder()).toEqual(before)
    const accepted = await call<SheetView>('work.sheets.review', { itemId, which: { ids: [first.id] }, verdict: 'accept' })
    expect(accepted.suggestions).toEqual([])
    expect(accepted.rev).toBe(1)
    expect(cell()).toBe(SECRET)
    expect(Object.keys(folder())).toEqual(Object.keys(before))
    const { revisions } = await call<{ revisions: { by: string; label: string }[] }>('work.sheets.history', { itemId })
    expect(revisions[0]).toMatchObject({ by: 'owner', label: 'Accepted 1 change' })
  })

  it('a change he asked for in so many words is written at once', async () => {
    state.said.push('Set A2 on Data to 42 please')
    const r = await tool('sheet_write', { item: itemId, cells: [{ at: 'Data!A2', v: 42 }], because: 'asked', quote: 'Set A2 on Data to 42' })
    expect(r.text).toBe('Wrote Data!A2.')
    expect(cell()).toBe(42)
  })

  it('only he reviews: a thread\'s call is refused, and a remote key needs approve to take a change there', async () => {
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'Data!A2', v: SECRET }] })
    const before = folder()
    const thread = { kind: 'model' as const, caps: [], sessionId: 't1' }
    await expect(sheets.handle!(req('work.sheets.review', { itemId, which: 'all', verdict: 'accept' }), work.ctx, thread)).rejects.toThrow('Only the owner accepts or rejects a suggestion.')
    await expect(sheets.handle!(req('work.sheets.mode', { itemId, mode: 'writes' }), work.ctx, thread)).rejects.toThrow('Only the owner sets what an agent may do to a sheet.')
    const operate = { kind: 'remote', keyId: 'k1', name: 'Phone', audience: 'client', caps: ['read', 'operate'] } as never
    await expect(call('work.sheets.review', { itemId, which: 'all', verdict: 'accept' }, operate)).rejects.toThrow('this key may not change it')
    // nor may such a key edit the cells itself, restore the file or take a write back: a change there needs approve
    const sheet = importXlsx(new Uint8Array(readFileSync(path))).workbook.sheetOrder[0]
    const typed = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: sheet, cellValue: { 1: { 0: { v: SECRET } } } } }
    await expect(call('work.sheets.edit', { itemId, baseRev: 0, mutations: [typed] }, operate)).rejects.toThrow('this key may not change it')
    await expect(call('work.sheets.restore', { itemId, rev: 0 }, operate)).rejects.toThrow('this key may not change it')
    // it may still reject, which writes nothing
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'Data!A9', v: 'dropped' }] })
    const extra = (await call<SheetView>('work.sheets.open', { itemId })).suggestions.find((s) => s.row === 8)!
    expect((await call<SheetView>('work.sheets.review', { itemId, which: { ids: [extra.id] }, verdict: 'reject' }, operate)).suggestions).toHaveLength(1)
    expect(folder()).toEqual(before)
    const approve = { kind: 'remote', keyId: 'k2', name: 'Phone', audience: 'client', caps: ['read', 'operate', 'approve'] } as never
    expect((await call<SheetView>('work.sheets.review', { itemId, which: 'all', verdict: 'accept' }, approve)).suggestions).toEqual([])
    expect(cell()).toBe(SECRET)
  })
})

describe('a workbook in a library, from a window that reaches this host with a remote key', () => {
  let path: string
  let itemId: string
  const approve = { kind: 'remote', keyId: 'k2', name: 'His Mac', audience: 'client', caps: ['read', 'operate', 'approve'] } as never
  const operate = { kind: 'remote', keyId: 'k1', name: 'Phone', audience: 'client', caps: ['read', 'operate'] } as never
  beforeEach(() => {
    mkdirSync(join(library, 'Budget'), { recursive: true })
    path = join(library, 'Budget', 'Budget.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    itemId = open(path, 'Budget.xlsx')
  })

  it('opens as the full editor, loads the file itself, and saves his edit and his format back into it with nothing written beside it', async () => {
    const view = await call<SheetView>('work.sheets.open', { itemId }, approve)
    expect(view).toMatchObject({ store: 'package', shared: true, rev: 0 })
    // the format row and the Data menu's rows: the host keeps what they make in this file
    expect(view.row).toEqual(expect.arrayContaining(['bold', 'fill', 'number', 'merge']))
    const frame = await call<{ data: string; size: number; format: string }>('work.sheets.load', { itemId, rev: 0, offset: 0, length: 4 * 1024 * 1024 }, approve)
    expect(frame.format).toBe('xlsx')
    expect(Buffer.from(frame.data, 'base64').equals(readFileSync(path))).toBe(true)
    const before = Object.keys(folder())
    const wb = importXlsx(new Uint8Array(readFileSync(path))).workbook
    const sheet = wb.sheetOrder.find((s) => wb.sheets[s]?.name === 'Data')!
    const typed = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: sheet, cellValue: { 1: { 0: { v: 4242 } } } } }
    const bold = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: sheet, cellValue: { 1: { 0: { s: { bl: 1 } } } } } }
    expect(await call('work.sheets.edit', { itemId, baseRev: 0, mutations: [typed] }, approve)).toEqual({ rev: 1 })
    expect(await call('work.sheets.edit', { itemId, baseRev: 1, mutations: [bold] }, approve)).toEqual({ rev: 2 })
    const after = importXlsx(new Uint8Array(readFileSync(path))).workbook
    const cell = after.sheets[sheet]!.cellData![1]![0]!
    expect(cell.v).toBe(4242)
    const style = (typeof cell.s === 'string' ? after.styles?.[cell.s] : cell.s) as { bl?: number }
    expect(style.bl).toBe(1)
    // the library's folder holds the workbook and nothing new: no temporary, no sidecar
    expect(Object.keys(folder())).toEqual(before)
  })

  it('a key that may not approve reads it and changes nothing', async () => {
    const before = folder()
    expect((await call<SheetView>('work.sheets.open', { itemId }, operate)).store).toBe('package')
    const sheet = importXlsx(new Uint8Array(readFileSync(path))).workbook.sheetOrder[0]
    const typed = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: sheet, cellValue: { 1: { 0: { v: 1 } } } } }
    await expect(call('work.sheets.edit', { itemId, baseRev: 0, mutations: [typed] }, operate)).rejects.toThrow('Others can open this sheet: this key may not change it.')
    expect(folder()).toEqual(before)
  })
})

describe('an agent\'s suggestion on a .tcsheet others can open', () => {
  let path: string
  let itemId: string
  const side = (): string[] => (existsSync(join(dir, 'sheets', 'suggestions')) ? readdirSync(join(dir, 'sheets', 'suggestions')) : [])
  const inFile = (): string => readText(readZip(new Uint8Array(readFileSync(path))), 'suggestions.json')
  beforeEach(() => {
    path = join(library, 'Plan.tcsheet')
    TcsheetBackend.create(path, 'Plan')
    itemId = open(path, 'Plan')
  })

  it('sheet_suggest and his own sheet_write leave the file and its folder byte for byte; the change waits under this host\'s data', async () => {
    const before = folder()
    expect((await tool('sheet_suggest', { item: itemId, cells: [{ at: 'A1', v: SECRET }], reason: 'the new forecast' })).isError).toBeUndefined()
    expect((await tool('sheet_write', { item: itemId, cells: [{ at: 'A2', v: SECRET }], because: 'own' })).text).toMatch(/^Suggested 1 cell: others share this sheet/)
    expect(folder()).toEqual(before)
    expect(readFileSync(path).includes(SECRET)).toBe(false)
    expect(inFile()).toBe('[]')
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view).toMatchObject({ shared: true, rev: 0 })
    expect(view.suggestions.map((s) => s.proposed)).toEqual([{ v: SECRET }, { v: SECRET }])
    expect(side()).toHaveLength(1)
    expect(readFileSync(join(dir, 'sheets', 'suggestions', side()[0]), 'utf8')).toContain(SECRET)
  })

  it('his accept writes the cell into the file; a reject leaves nothing, in the file or on the host', async () => {
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'A1', v: SECRET }] })
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'A2', v: 'dropped' }] })
    const before = folder()
    const [first, second] = (await call<SheetView>('work.sheets.open', { itemId })).suggestions
    await call('work.sheets.review', { itemId, which: { ids: [second.id] }, verdict: 'reject' })
    expect(folder()).toEqual(before)
    const accepted = await call<SheetView>('work.sheets.review', { itemId, which: { ids: [first.id] }, verdict: 'accept' })
    expect(accepted).toMatchObject({ rev: 1, suggestions: [] })
    expect((await tool('sheet_read', { item: itemId, range: 'A1:A2' })).text).toContain(`A1 "${SECRET}"`)
    expect(inFile()).toBe('[]')
    expect(side()).toEqual([])
    expect(Object.keys(folder())).toEqual(Object.keys(before))
  })

  it('his own file in his own folder takes a remote key\'s edit with operate alone', async () => {
    const own = join(dir, 'Own.tcsheet')
    TcsheetBackend.create(own, 'Own')
    const id = open(own, 'Own')
    const operate = { kind: 'remote', keyId: 'k1', name: 'Phone', audience: 'client', caps: ['read', 'operate'] } as never
    const typed = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: { 0: { 0: { v: 1 } } } } }
    expect(await call('work.sheets.edit', { itemId: id, baseRev: 0, mutations: [typed] }, operate)).toEqual({ rev: 1 })
  })

  it('a file written before the rule gives up the suggestions it carries the first time it is read', async () => {
    const old = join(library, 'Old.tcsheet')
    writeTcsheet(old, {
      meta: { title: 'Old', rev: 0, snapRev: 0 },
      snapshots: new Map([[0, gz(blankWorkbook('workbook', 'Old'))]]),
      ops: [],
      suggestions: [{ id: 'cs1:sheet1:0:0', changeSet: 'cs1', by: 'agent:env_test:t1', sheet: 'sheet1', row: 0, col: 0, base: null, proposed: { v: SECRET }, state: 'pending' }]
    })
    expect(readText(readZip(new Uint8Array(readFileSync(old))), 'suggestions.json')).toContain(SECRET)
    const view = await call<SheetView>('work.sheets.open', { itemId: open(old, 'Old') })
    expect(view.suggestions.map((s) => s.proposed)).toEqual([{ v: SECRET }])
    expect(readText(readZip(new Uint8Array(readFileSync(old))), 'suggestions.json')).toBe('[]')
    expect(readFileSync(old).includes(SECRET)).toBe(false)
  })
})
