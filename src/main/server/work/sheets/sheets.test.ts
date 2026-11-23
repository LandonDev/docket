import { copyFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import { SHEET_ROW, type SheetView } from '@shared/contract-work-sheets'
import type { SessionMeta } from '@shared/events'
import type { CanvasSource, WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { canvasStoreOf } from '../canvas/store'
import { SET_RANGE_VALUES } from './mutations'
import { PACKAGE_UNIT } from './packages'

/**
 * The sheets module end to end over an opened package: a real database,
 * `startWork` with the canvas and sheets modules, the methods through the
 * mount and the tools as a thread's harness calls them. The jobs run in this
 * process (the app runs them in the sheet worker).
 */
const state = vi.hoisted(() => ({ shared: false, routine: null as string | null, said: [] as string[] }))
vi.mock('../scope', async (original) => ({
  ...(await original<typeof import('../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: state.routine, shared: () => state.shared }),
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
const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas/index')
const { sheets } = await import('./index')
const { setJobs } = await import('./held')
const { localJobs } = await import('./workerClient')
setJobs(localJobs)

const CORPUS = join(import.meta.dirname, 'harness/corpus')
let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const pushes: WorkPush[] = []
const sessions = new Map<string, SessionMeta>()
const registry = {
  get: (id: string) => sessions.get(id) ?? null,
  onRemoved: () => () => {},
  onWorkspaceDeleted: () => () => {}
} as unknown as SessionRegistry

const call = async <T = unknown,>(method: string, params: unknown): Promise<T> => {
  const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), LOCAL_PRINCIPAL)
  return (out.handled ? out.result : undefined) as T
}
const tool = async (name: string, args: unknown): Promise<{ text: string; isError?: boolean }> => {
  const r = (await work.tools.call({ id: 't1', scope: 'work' }, name, args, new AbortController().signal)) as { content: Array<{ text?: string }>; isError?: boolean }
  return { text: r.content.map((c) => c.text ?? '').join(''), isError: r.isError }
}
const file = (path: string): CanvasSource => ({ at: 'file', host: 'env_test', path })
let path: string
let itemId: string
const valueAt = (sheet: string, row: number, col: number): unknown => {
  const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
  const id = workbook.sheetOrder.find((s) => workbook.sheets[s]?.name === sheet)!
  return workbook.sheets[id]?.cellData?.[row]?.[col]?.v
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-sheets-'))
  db = openDb(join(dir, 'test.db'))
  pushes.length = 0
  Object.assign(state, { shared: false, routine: null, said: [] })
  sessions.set('t1', { id: 't1', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: { roots: () => [dir], denied: () => [] } }, [canvas, sheets])
  work.pushes.onPush((p) => pushes.push(p))
  await call('work.set', { enabled: true })
  path = join(dir, 'Budget.xlsx')
  copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
  itemId = canvasStoreOf(db).open('t1', { kind: 'sheet', source: file(path), title: 'Budget.xlsx' }).id
  pushes.length = 0
})
afterEach(() => {
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a package in the canvas', () => {
  it('opens with its view and loads its bytes by range at the view\'s rev', async () => {
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view).toMatchObject({ itemId, sessionId: 't1', name: 'Budget.xlsx', store: 'package', rev: 0, shared: false, mode: 'writes', suggestions: [], charts: [] })
    expect(view.reach).toBeUndefined()
    const size = readFileSync(path).length
    const a = await call<{ data: string; size: number; format: string }>('work.sheets.load', { itemId, rev: 0, offset: 0, length: 1000 })
    const b = await call<{ data: string }>('work.sheets.load', { itemId, rev: 0, offset: 1000, length: size })
    expect(a).toMatchObject({ size, format: 'xlsx' })
    expect(Buffer.concat([Buffer.from(a.data, 'base64'), Buffer.from(b.data, 'base64')]).equals(readFileSync(path))).toBe(true)
  })

  it('saves the owner\'s edit, pushes the new rev, and takes an edit made one revision behind', async () => {
    const view = await call<SheetView>('work.sheets.open', { itemId })
    const sheet = importXlsx(new Uint8Array(readFileSync(path))).workbook.sheetOrder[0]
    const m = { id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: sheet, cellValue: { 1: { 0: { v: 42 } } } } }
    expect(await call('work.sheets.edit', { itemId, baseRev: view.rev, mutations: [m] })).toEqual({ rev: 1 })
    expect(valueAt('Data', 1, 0)).toBe(42)
    expect(pushes.some((p) => p.push === 'work.sheets' && p.itemId === itemId && p.rev === 1)).toBe(true)
    // Only cell edits came between, so the cells are where the editor saw them.
    expect(await call('work.sheets.edit', { itemId, baseRev: 0, mutations: [m] })).toEqual({ rev: 2 })
  })

  it('reads cells for an agent, with formulas', async () => {
    const r = await tool('sheet_read', { item: itemId, range: 'Data!A1:B2' })
    expect(r.isError).toBeUndefined()
    expect(r.text.split('\n')[0]).toBe('Data')
    expect(r.text).toContain('A2 1')
  })

  it('on his own sheet an agent\'s own idea is written, with the written line and Undo', async () => {
    const r = await tool('sheet_write', { item: itemId, cells: [{ at: 'A2', v: 9 }], because: 'own' })
    expect(r.text).toBe('Wrote A2.')
    expect(valueAt('Data', 1, 0)).toBe(9)
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.written?.text).toBe('Wrote A2')
    await call('work.sheets.undo', { itemId, writeId: view.written!.id })
    expect(valueAt('Data', 1, 0)).toBe(1)
    expect((await call<SheetView>('work.sheets.open', { itemId })).written).toBeUndefined()
  })

  it('on a shared sheet an agent\'s own idea waits as suggestions; what the owner asked for is written at once', async () => {
    state.shared = true
    const own = await tool('sheet_write', { item: itemId, cells: [{ at: 'A2', v: 5 }, { at: 'B2', v: 'x' }], because: 'own', reason: 'Round the totals' })
    expect(own.text).toMatch(/^Suggested 2 cells: others share this sheet/)
    expect(valueAt('Data', 1, 0)).toBe(1)
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.suggestions.map((s) => [s.row, s.col, s.base?.v, s.proposed?.v, s.state, s.reason])).toEqual([
      [1, 0, 1, 5, 'pending', 'Round the totals'],
      [1, 1, view.suggestions[1].base?.v, 'x', 'pending', 'Round the totals']
    ])
    // a quote he never typed does not count as asked
    const fake = await tool('sheet_write', { item: itemId, cells: [{ at: 'A3', v: 1 }], because: 'asked', quote: 'set A3 to one please' })
    expect(fake.text).toMatch(/quote was not found/)
    state.said = ['please set A4 to 100 in the budget']
    const asked = await tool('sheet_write', { item: itemId, cells: [{ at: 'A4', v: 100 }], because: 'asked', quote: 'set A4 to 100' })
    expect(asked.text).toBe('Wrote A4.')
    expect(valueAt('Data', 3, 0)).toBe(100)
    // A routine's run suggests on a shared sheet: no grant covers its write (milestone 50's hold review, finding 6); on his own it writes.
    state.routine = 'run1'
    expect((await tool('sheet_write', { item: itemId, cells: [{ at: 'A5', v: 7 }], because: 'routine' })).text).toMatch(/^Suggested 1 cell: .* none does, so this counts as your own idea\.$/)
    expect(valueAt('Data', 4, 0)).not.toBe(7)
    state.shared = false
    expect((await tool('sheet_write', { item: itemId, cells: [{ at: 'A6', v: 8 }], because: 'routine' })).text).toBe('Wrote A6.')
  })

  it('accepts one suggestion into the file and leaves the rest; an owner edit over a pending cell makes it a conflict', async () => {
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'A2', v: 5 }, { at: 'A3', v: 6 }, { at: 'A4', v: 8 }] })
    let view = await call<SheetView>('work.sheets.open', { itemId })
    const [a2, a3] = view.suggestions
    view = await call<SheetView>('work.sheets.review', { itemId, which: { ids: [a2.id] }, verdict: 'accept' })
    expect(valueAt('Data', 1, 0)).toBe(5)
    expect(view.suggestions.map((s) => s.row)).toEqual([2, 3])
    const m = { id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: a3.sheet, cellValue: { 2: { 0: { v: 99 } } } } }
    await call('work.sheets.edit', { itemId, baseRev: view.rev, mutations: [m] })
    view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.suggestions.find((s) => s.id === a3.id)?.state).toBe('conflict')
    view = await call<SheetView>('work.sheets.review', { itemId, which: 'all', verdict: 'reject' })
    expect(view.suggestions).toEqual([])
    expect(valueAt('Data', 2, 0)).toBe(99)
  })

  it('accepts all over a package; a change from outside orphans what waits; a cell changed since is not written', async () => {
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'A2', v: 5 }, { at: 'A3', v: 6 }] })
    let view = await call<SheetView>('work.sheets.review', { itemId, which: 'all', verdict: 'accept' })
    expect(view.suggestions).toEqual([])
    expect([valueAt('Data', 1, 0), valueAt('Data', 2, 0)]).toEqual([5, 6])

    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'A4', v: 8 }] })
    // He types over A4 in the canvas: accepting it now would write over his edit.
    const sheet = importXlsx(new Uint8Array(readFileSync(path))).workbook.sheetOrder[0]
    view = await call<SheetView>('work.sheets.open', { itemId })
    await call('work.sheets.edit', { itemId, baseRev: view.rev, mutations: [{ id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: sheet, cellValue: { 3: { 0: { v: 77 } } } } }] })
    view = await call<SheetView>('work.sheets.review', { itemId, which: 'all', verdict: 'accept' })
    expect(view.suggestions.map((s) => s.state)).toEqual(['conflict'])
    expect(valueAt('Data', 3, 0)).toBe(77)
    await call('work.sheets.review', { itemId, which: 'all', verdict: 'reject' })

    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'A5', v: 9 }] })
    // Excel saves the file with rows inserted: no cell is where the agent saw it for sure.
    copyFileSync(join(CORPUS, 'formats.xlsx'), path)
    utimesSync(path, new Date(), new Date(Date.now() + 5_000))
    view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.suggestions.map((s) => s.state)).toEqual(['orphaned'])
    await expect(call('work.sheets.review', { itemId, which: { ids: [view.suggestions[0].id] }, verdict: 'accept' })).rejects.toThrow(/changed since/)
  })

  it('lists history and compares two revisions', async () => {
    await tool('sheet_write', { item: itemId, cells: [{ at: 'A2', v: 3 }], because: 'own' })
    const { revisions } = await call<{ revisions: { rev: number; label: string }[] }>('work.sheets.history', { itemId })
    expect(revisions.map((r) => [r.rev, r.label])).toEqual([
      [1, 'Wrote A2'],
      [0, 'As opened']
    ])
    const diff = await call<{ cells: { sheetName: string; row: number; col: number; before: { v: unknown }; after: { v: unknown } }[] }>('work.sheets.compare', { itemId, from: 0, to: 1 })
    expect(diff.cells.find((c) => c.sheetName === 'Data')).toMatchObject({ row: 1, col: 0, before: { v: 1 }, after: { v: 3 } })
  })

  it('offers the switch for a file with macros, and says where Excel is not', async () => {
    const xlsm = join(dir, 'Macro.xlsm')
    copyFileSync(join(CORPUS, 'macro.xlsm'), xlsm)
    const id = canvasStoreOf(db).open('t1', { kind: 'sheet', source: file(xlsm), title: 'Macro.xlsm' }).id
    const view = await call<SheetView>('work.sheets.open', { itemId: id })
    expect(view.reach?.to).toBe('excel')
    expect(view.reach!.parts).toContain('macros')
    if (process.platform === 'linux') await expect(call('work.sheets.switch', { itemId: id })).rejects.toThrow(/Excel is not on this host/)
  })

  it('keeps a chart of ours over a range, and takes it off', async () => {
    const chart = { id: 'c1', sheet: 'sheet1', range: 'A1:B5', title: 'Totals', row: 2, col: 4 }
    expect((await call<SheetView>('work.sheets.chart', { itemId, chart })).charts).toEqual([chart])
    expect((await call<SheetView>('work.sheets.chart', { itemId, chart, remove: true })).charts).toEqual([])
  })
})

describe('a .csv in the canvas, and the model writer', () => {
  /** The Work service's sheet host, in this process: main's calls go to it as they would over the socket. */
  const serve = async (): Promise<void> => {
    const { SheetHost } = await import('./host/host')
    const { TcsheetBackend } = await import('./host/backends')
    const host = new SheetHost((ref) => new TcsheetBackend((ref as { tcsheet: string }).tcsheet))
    const service = (work.ctx as unknown as { service: { internal: (route: string, body: Record<string, never>) => Promise<unknown> } }).service
    service.internal = async (route, b: Record<string, never>) => {
      const op = route.split('/').pop()!
      const call = host as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      if (op === 'open') return call.open(b.sheet)
      if (op === 'snapshot') return call.snapshot(b.sheet, b.rev, b.offset, b.length)
      if (op === 'apply') return call.apply(b.sheet, b.baseRev, b.mutations, b.by)
      throw new Error(`not in this test: ${op}`)
    }
  }

  it('says which format controls a sheet keeps: every one for a .tcsheet and for an opened Excel file', async () => {
    await serve()
    const { TcsheetBackend } = await import('./host/backends')
    const path = join(dir, 'Plan.tcsheet')
    TcsheetBackend.create(path, 'Plan')
    const id = canvasStoreOf(db).open('t1', { kind: 'sheet', source: file(path), title: 'Plan' }).id
    const view = await call<SheetView>('work.sheets.open', { itemId: id })
    expect(view.store).toBe('tcsheet')
    expect(view.row).toEqual([...SHEET_ROW.tcsheet])
    expect(view.row).toContain('fill')
    const pkg = await call<SheetView>('work.sheets.open', { itemId })
    expect(pkg.store).toBe('package')
    expect(pkg.row).toEqual([...SHEET_ROW.package])
    expect(pkg.row).toContain('borders')
  })

  it('opens a .csv as a sheet of its own, and saves it back as .csv and out as .xlsx', async () => {
    await serve()
    const csv = join(dir, 'People.csv')
    writeFileSync(csv, 'name,age\r\nAda,36\r\n')
    const id = canvasStoreOf(db).open('t1', { kind: 'sheet', source: file(csv), title: 'People.csv' }).id
    const view = await call<SheetView>('work.sheets.open', { itemId: id })
    expect(view).toMatchObject({ store: 'csv', rev: 0, name: 'People.csv' })
    // a sheet read from a .csv keeps cell contents only: the host lists no format control for it
    expect(view.row).toBeUndefined()
    await call('work.sheets.edit', { itemId: id, baseRev: 0, mutations: [{ id: SET_RANGE_VALUES, params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: { 2: { 0: { v: 'Grace' }, 1: { v: 45 } } } } }] })
    const back = await call<{ path: string }>('work.sheets.export', { itemId: id, format: 'csv' })
    expect(back.path).toBe(csv)
    expect(readFileSync(csv, 'utf8')).toBe('name,age\r\nAda,36\r\nGrace,45\r\n')
    const x = await call<{ path: string }>('work.sheets.export', { itemId: id, format: 'xlsx' })
    expect(x.path).toBe(join(dir, 'People.xlsx'))
    const { workbook } = importXlsx(new Uint8Array(readFileSync(x.path)))
    expect(workbook.sheets[workbook.sheetOrder[0]]?.cellData?.[2]?.[1]?.v).toBe(45)
    expect((await call<{ path: string }>('work.sheets.export', { itemId: id, format: 'xlsx' })).path).toBe(join(dir, 'People (2).xlsx'))
  })

  it('writes one sheet of an opened package as .csv beside it, and refuses to write it as .xlsx', async () => {
    const out = await call<{ path: string }>('work.sheets.export', { itemId, format: 'csv', sheet: 'Data' })
    expect(out.path).toBe(join(dir, 'Budget.csv'))
    expect(readFileSync(out.path, 'utf8').split('\r\n')[1]).toMatch(/^1,/)
    await expect(call('work.sheets.export', { itemId, format: 'xlsx' })).rejects.toThrow(/Excel file already/)
  })
})
