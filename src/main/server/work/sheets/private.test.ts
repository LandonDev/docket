import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { readTables } from './patch/tables'
import { readPages } from './patch/pages'
import { PAGES_RESOURCE } from 'work-kit/sheet/pages/access'

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
const { setJobs, sharedCopies } = await import('./held')
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
    if (op === 'restore') return h.restore(b.sheet, b.rev, b.by)
    if (op === 'snapshot') return h.snapshot(b.sheet, b.rev, b.offset, b.length)
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
    // nor drop one: what it may not see it does not decide
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'Data!A9', v: 'dropped' }] })
    const extra = (await call<SheetView>('work.sheets.open', { itemId })).suggestions.find((s) => s.row === 8)!
    await expect(call('work.sheets.review', { itemId, which: { ids: [extra.id] }, verdict: 'reject' }, operate)).rejects.toThrow('this key may not change it')
    await expect(call('work.sheets.review', { itemId, which: 'all', verdict: 'reject' }, operate)).rejects.toThrow('this key may not change it')
    expect((await call<SheetView>('work.sheets.open', { itemId })).suggestions).toHaveLength(2)
    expect(folder()).toEqual(before)
    const approve = { kind: 'remote', keyId: 'k2', name: 'Phone', audience: 'client', caps: ['read', 'operate', 'approve'] } as never
    expect((await call<SheetView>('work.sheets.review', { itemId, which: 'all', verdict: 'accept' }, approve)).suggestions).toEqual([])
    expect(cell()).toBe(SECRET)
  })
})

describe('what waits on a workbook others can open is his alone to see', () => {
  let path: string
  let itemId: string
  const read = { kind: 'remote', keyId: 'k0', name: 'Watcher', audience: 'client', caps: ['read'] } as never
  const operate = { kind: 'remote', keyId: 'k1', name: 'Phone', audience: 'client', caps: ['read', 'operate'] } as never
  const approve = { kind: 'remote', keyId: 'k2', name: 'His Mac', audience: 'client', caps: ['read', 'operate', 'approve'] } as never
  beforeEach(() => {
    mkdirSync(join(library, 'Budget'), { recursive: true })
    path = join(library, 'Budget', 'Budget.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    itemId = open(path, 'Budget.xlsx')
  })

  it('a key that could not take a suggestion is answered the sheet as it stands and nothing that waits', async () => {
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'Data!A2', v: SECRET }] })
    await tool('sheet_format', { item: itemId, range: 'Data!A2:B3', format: { bold: true }, because: 'own' })
    for (const by of [undefined, approve]) {
      const his = await call<SheetView>('work.sheets.open', { itemId }, by)
      expect(his.suggestions.map((s) => s.proposed?.v)).toEqual([SECRET])
      expect(his.changes).toHaveLength(1)
    }
    for (const by of [read, operate]) {
      const view = await call<SheetView>('work.sheets.open', { itemId }, by)
      expect(view).toMatchObject({ shared: true, store: 'package', suggestions: [] })
      expect(view.changes).toBeUndefined()
      expect(JSON.stringify(view)).not.toContain(String(SECRET))
    }
    // a thread's call on the wire is no more his than a read key's
    const thread = { kind: 'model' as const, caps: [], sessionId: 't1' }
    const answer = await sheets.handle!(req('work.sheets.open', { itemId }), work.ctx, thread)
    expect(JSON.stringify(answer)).not.toContain(String(SECRET))
  })

  it('a push says the view changed and carries none of it: every key hears a push', async () => {
    const heard: unknown[] = []
    const off = work.pushes.onPush((p) => void heard.push(p), read)
    try {
      await tool('sheet_suggest', { item: itemId, cells: [{ at: 'Data!A2', v: SECRET }] })
      await call('work.sheets.mode', { itemId, mode: 'suggests' })
      const mine = heard.filter((p) => (p as { push: string; itemId?: string }).push === 'work.sheets' && (p as { itemId?: string }).itemId === itemId)
      expect(mine.length).toBeGreaterThan(0)
      for (const p of mine) {
        expect(p).toMatchObject({ stale: true })
        expect(p).not.toHaveProperty('view')
      }
      expect(JSON.stringify(heard)).not.toContain(String(SECRET))
    } finally {
      off()
    }
  })

  it('his own workbook still sends its view with the push', async () => {
    const own = join(dir, 'Own.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), own)
    const id = open(own, 'Own.xlsx')
    const heard: unknown[] = []
    const off = work.pushes.onPush((p) => void heard.push(p))
    try {
      await call('work.sheets.mode', { itemId: id, mode: 'suggests' })
      expect(heard.find((p) => (p as { itemId?: string }).itemId === id)).toMatchObject({ view: { shared: false } })
    } finally {
      off()
    }
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

describe('a format or a rule an agent proposes on an Excel file others can open', () => {
  let path: string
  let itemId: string
  const book = () => importXlsx(new Uint8Array(readFileSync(path))).workbook
  const data = (wb: ReturnType<typeof book>): string => wb.sheetOrder.find((s) => wb.sheets[s]?.name === 'Data')!
  const styleOf = (wb: ReturnType<typeof book>, row: number, col: number): Record<string, unknown> => {
    const s = wb.sheets[data(wb)]?.cellData?.[row]?.[col]?.s
    return ((typeof s === 'string' ? wb.styles?.[s] : s) ?? {}) as Record<string, unknown>
  }
  const rulesOf = (wb: ReturnType<typeof book>, name: string): unknown[] => ((JSON.parse(wb.resources?.find((r) => r.name === name)?.data ?? '{}') as Record<string, unknown[]>)[data(wb)] ?? []) as unknown[]
  beforeEach(() => {
    mkdirSync(join(library, 'Budget'), { recursive: true })
    path = join(library, 'Budget', 'Budget.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    itemId = open(path, 'Budget.xlsx')
  })

  it('sheet_format and sheet_rule leave the file and its folder byte for byte: each waits on this host, in words', async () => {
    const before = folder()
    const f = await tool('sheet_format', { item: itemId, range: 'Data!A2:B3', format: { bold: true, fill: '#FFF2CC' }, because: 'own', reason: 'the totals' })
    expect(f.text).toMatch(/^Suggested: Bold, yellow fill on Data!A2:B3\. Others share this sheet/)
    const r = await tool('sheet_rule', { file: path, rule: { kind: 'highlight', range: 'Data!A2:A9', when: 'greater', value: 100, look: { colour: '#C00000' } }, because: 'own' })
    expect(r.text).toMatch(/^Suggested: Red text where Data!A2:A9 is greater than 100\./)
    // a quote he never said counts as the agent's own idea
    const q = await tool('sheet_rule', { item: itemId, rule: { kind: 'list', range: 'Data!C2:C9', items: ['Open', 'Done'] }, because: 'asked', quote: 'add a status list' })
    expect(q.text).toMatch(/^Suggested: A list \(Open, Done\) on Data!C2:C9\./)
    expect(folder()).toEqual(before)
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view).toMatchObject({ shared: true, rev: 0 })
    expect(view.changes!.map((c) => [c.kind, c.words, c.state])).toEqual([
      ['format', 'Bold, yellow fill on Data!A2:B3', 'pending'],
      ['rule', 'Red text where Data!A2:A9 is greater than 100', 'pending'],
      ['rule', 'A list (Open, Done) on Data!C2:C9', 'pending']
    ])
    expect(view.changes![0]).toMatchObject({ reason: 'the totals', range: { startRow: 1, endRow: 2, startColumn: 0, endColumn: 1 } })
    // the view carries the words, never the ask
    expect(JSON.stringify(view.changes)).not.toContain('FFF2CC')
    expect((db.prepare('SELECT COUNT(*) AS n FROM work_sheets_changes').get() as { n: number }).n).toBe(3)
    expect(folder()).toEqual(before)
  })

  it('his accept lays each as his own ordinary edit; a reject leaves nothing anywhere', async () => {
    await tool('sheet_format', { item: itemId, range: 'Data!A2:B3', format: { bold: true, fill: '#FFF2CC' }, because: 'own' })
    await tool('sheet_rule', { item: itemId, rule: { kind: 'highlight', range: 'Data!A2:A9', when: 'greater', value: 100, look: { colour: '#C00000' } }, because: 'own' })
    await tool('sheet_rule', { item: itemId, rule: { kind: 'list', range: 'Data!C2:C9', items: ['Open', 'Done'] }, because: 'own' })
    const before = folder()
    const [format, highlight, list] = (await call<SheetView>('work.sheets.open', { itemId })).changes!
    const value = book().sheets[data(book())]?.cellData?.[1]?.[0]?.v
    const rejected = await call<SheetView>('work.sheets.review', { itemId, which: { ids: [list.id] }, verdict: 'reject' })
    expect(rejected.changes).toHaveLength(2)
    expect(folder()).toEqual(before)
    const one = await call<SheetView>('work.sheets.review', { itemId, which: { ids: [format.id] }, verdict: 'accept' })
    expect(one).toMatchObject({ rev: 1 })
    expect(one.changes!.map((c) => c.id)).toEqual([highlight.id])
    expect(styleOf(book(), 1, 0)).toMatchObject({ bl: 1, bg: { rgb: '#FFF2CC' } })
    expect(styleOf(book(), 2, 1)).toMatchObject({ bl: 1 })
    expect(book().sheets[data(book())]?.cellData?.[1]?.[0]?.v).toEqual(value)
    const all = await call<SheetView>('work.sheets.review', { itemId, which: 'all', verdict: 'accept' })
    expect(all.changes).toBeUndefined()
    expect(all.rev).toBe(2)
    const rules = rulesOf(book(), 'SHEET_CONDITIONAL_FORMATTING_PLUGIN') as { ranges: unknown[]; rule: { subType: string; operator: string; value: number } }[]
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ ranges: [{ startRow: 1, endRow: 8, startColumn: 0, endColumn: 0 }], rule: { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value: 100 } })
    expect(rulesOf(book(), 'SHEET_DATA_VALIDATION_PLUGIN')).toEqual([])
    // nothing was written beside the file
    expect(Object.keys(folder())).toEqual(Object.keys(before))
    const { revisions } = await call<{ revisions: { by: string; label: string }[] }>('work.sheets.history', { itemId })
    expect(revisions.slice(0, 2).map((r) => [r.by, r.label])).toEqual([
      ['owner', 'Red text where Data!A2:A9 is greater than 100'],
      ['owner', 'Bold, yellow fill on Data!A2:B3']
    ])
  })

  it('a format or a rule he asked for in so many words is written at once', async () => {
    state.said.push('make the header bold and add a filter please')
    const f = await tool('sheet_format', { item: itemId, range: 'Data!A1:C1', format: { bold: true }, because: 'asked', quote: 'make the header bold' })
    expect(f.text).toBe('Bold on Data!A1:C1.')
    expect(styleOf(book(), 0, 0)).toMatchObject({ bl: 1 })
    const r = await tool('sheet_rule', { item: itemId, rule: { kind: 'check', range: 'Data!B2:B9', of: 'whole', when: 'between', value: 1, value2: 21 }, because: 'asked', quote: 'add a filter' })
    expect(r.text).toBe('Data!B2:B9 takes only a whole number that is between 1 and 21.')
    const [rule] = rulesOf(book(), 'SHEET_DATA_VALIDATION_PLUGIN') as Record<string, unknown>[]
    // a value outside the rule is refused in Excel, as its own dialog sets a new rule
    expect(rule).toMatchObject({ type: 'whole', operator: 'between', formula1: '1', formula2: '21', showErrorMessage: true })
    expect((await call<SheetView>('work.sheets.open', { itemId })).changes).toBeUndefined()
  })

  it('only he takes one: a thread is refused, and a remote key needs approve there', async () => {
    await tool('sheet_format', { item: itemId, range: 'Data!A2', format: { italic: true }, because: 'own' })
    const before = folder()
    const thread = { kind: 'model' as const, caps: [], sessionId: 't1' }
    await expect(sheets.handle!(req('work.sheets.review', { itemId, which: 'all', verdict: 'accept' }), work.ctx, thread)).rejects.toThrow('Only the owner accepts or rejects a suggestion.')
    const operate = { kind: 'remote', keyId: 'k1', name: 'Phone', audience: 'client', caps: ['read', 'operate'] } as never
    await expect(call('work.sheets.review', { itemId, which: 'all', verdict: 'accept' }, operate)).rejects.toThrow('this key may not change it')
    expect(folder()).toEqual(before)
    expect((await call<SheetView>('work.sheets.open', { itemId })).changes).toHaveLength(1)
  })

  it('a rule that would replace what the sheet holds, or that the file cannot keep, is refused as it is asked', async () => {
    state.said.push('name the rate and filter the table please')
    expect((await tool('sheet_rule', { item: itemId, rule: { kind: 'name', name: 'Markup', refersTo: '=0.08' }, because: 'asked', quote: 'name the rate' })).text).toBe('The name Markup for =0.08.')
    expect((await tool('sheet_rule', { item: itemId, rule: { kind: 'filter', range: 'Data!A1:C9' }, because: 'asked', quote: 'filter the table' })).text).toBe('A filter on Data!A1:C9.')
    expect((await tool('sheet_rule', { item: itemId, rule: { kind: 'list', range: 'Data!C2:C5', items: ['Open', 'Done'] }, because: 'asked', quote: 'filter the table' })).isError).toBeFalsy()
    const bytes = sha(path)
    const refused = async (rule: unknown): Promise<string> => {
      const got = await tool('sheet_rule', { item: itemId, rule, because: 'own' })
      expect(got.isError).toBe(true)
      return got.text
    }
    expect(await refused({ kind: 'name', name: 'markup', refersTo: '=0.1' })).toContain("The name markup is already there: change it in the sheet's Rules.")
    expect(await refused({ kind: 'filter', range: 'Data!A1:B9' })).toContain('Data already has a filter on A1:C9: take it off first.')
    expect(await refused({ kind: 'filter', range: null, sheet: 'Calc' })).toContain('Calc has no filter.')
    expect(await refused({ kind: 'check', range: 'Data!C4:C9', of: 'whole', when: 'greater', value: 1 })).toContain('C2:C5 already has a validation')
    expect(await refused({ kind: 'name', name: 'TRUE', refersTo: '=1' })).toContain('TRUE is a name Excel keeps for itself')
    expect(await refused({ kind: 'highlight', range: 'Data!A2:A9', when: 'top', value: 5000, look: { bold: true } })).toContain('Top and bottom take a whole number from 1 to 1,000.')
    // nothing waits, nothing was written
    expect((await call<SheetView>('work.sheets.open', { itemId })).changes).toBeUndefined()
    expect(sha(path)).toBe(bytes)
  })

  it('an accept of all goes on past a change the sheet has no place for now', async () => {
    // the same name proposed twice: the second has no place once the first is taken
    await tool('sheet_rule', { item: itemId, rule: { kind: 'name', name: 'Markup', refersTo: '=0.08' }, because: 'own' })
    await tool('sheet_rule', { item: itemId, rule: { kind: 'name', name: 'Markup', refersTo: '=0.09' }, because: 'own' })
    await tool('sheet_format', { item: itemId, range: 'Data!A1:C1', format: { bold: true }, because: 'own' })
    const all = await call<SheetView>('work.sheets.review', { itemId, which: 'all', verdict: 'accept' })
    expect(all.changes!.map((c) => [c.words, c.state])).toEqual([['The name Markup for =0.09', 'orphaned']])
    expect(all.rev).toBe(2)
    expect(styleOf(book(), 0, 0)).toMatchObject({ bl: 1 })
    // taken alone, it says why
    await expect(call('work.sheets.review', { itemId, which: { ids: [all.changes![0].id] }, verdict: 'accept' })).rejects.toThrow('Rows or columns changed since the agent suggested this')
  })

  it('a passing fault as he takes one leaves it waiting: only a change with no place turns orphaned', async () => {
    const real = await localJobs()
    let broken = false
    setJobs(async () => ({
      ...real,
      compose: async (ask) => {
        if (broken) throw new Error('the sheet worker stopped')
        return real.compose(ask)
      }
    }))
    try {
      await tool('sheet_format', { item: itemId, range: 'Data!A1:C1', format: { bold: true }, because: 'own' })
      broken = true
      await expect(call('work.sheets.review', { itemId, which: 'all', verdict: 'accept' })).rejects.toThrow('the sheet worker stopped')
      expect((await call<SheetView>('work.sheets.open', { itemId })).changes!.map((c) => c.state)).toEqual(['pending'])
      broken = false
      expect((await call<SheetView>('work.sheets.review', { itemId, which: 'all', verdict: 'accept' })).changes).toBeUndefined()
      expect(styleOf(book(), 0, 0)).toMatchObject({ bl: 1 })
    } finally {
      setJobs(localJobs)
    }
  })

  it('rows inserted since it was proposed: the change is not laid where the agent no longer saw it', async () => {
    await tool('sheet_rule', { item: itemId, rule: { kind: 'highlight', range: 'Data!A2:A9', when: 'duplicate', look: { fill: '#FFC7CE' } }, because: 'own' })
    // (the store answers an edit made on an older revision with a conflict once a restore or an outside change came between)
    await call('work.sheets.restore', { itemId, rev: 0 })
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.changes!.map((c) => c.state)).toEqual(['orphaned'])
    const bytes = sha(path)
    await expect(call('work.sheets.review', { itemId, which: { ids: [view.changes![0].id] }, verdict: 'accept' })).rejects.toThrow('Rows or columns changed since the agent suggested this')
    expect(sha(path)).toBe(bytes)
    expect((await call<SheetView>('work.sheets.review', { itemId, which: 'all', verdict: 'reject' })).changes).toBeUndefined()
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

describe('a format or a rule an agent proposes on a .tcsheet others can open', () => {
  let path: string
  let itemId: string
  const side = (): string[] => (existsSync(join(dir, 'sheets', 'suggestions')) ? readdirSync(join(dir, 'sheets', 'suggestions')) : [])
  /** The sheet as a cold engine reads the file. */
  const cold = async () => {
    const host = new SheetHost(() => new TcsheetBackend(path, join(dir, 'sheets', 'suggestions')))
    try {
      return JSON.parse((await host.snapshotJson({ tcsheet: path })).json) as { sheets: Record<string, { cellData?: Record<string, Record<string, { s?: unknown; v?: unknown }>> }>; styles?: Record<string, Record<string, unknown>>; resources?: { name: string; data: string }[] }
    } finally {
      host.close()
    }
  }
  beforeEach(() => {
    path = join(library, 'Plan.tcsheet')
    TcsheetBackend.create(path, 'Plan')
    itemId = open(path, 'Plan')
  })

  it('they leave the file and its folder byte for byte, wait in this host\'s own database, and land as his edit when he takes them', async () => {
    const before = folder()
    expect((await tool('sheet_format', { item: itemId, range: 'A1:B2', format: { bold: true, borders: 'outside' }, because: 'own' })).text).toMatch(/^Suggested: Bold, an outside border on A1:B2\. Others share this sheet/)
    expect((await tool('sheet_rule', { item: itemId, rule: { kind: 'list', range: 'C1:C9', items: ['Open', 'Done'] }, because: 'own' })).text).toMatch(/^Suggested: A list \(Open, Done\) on C1:C9\./)
    expect((await tool('sheet_rule', { item: itemId, rule: { kind: 'name', name: 'Status', refersTo: 'C1:C9' }, because: 'own' })).text).toMatch(/^Suggested: The name Status for C1:C9\./)
    expect(folder()).toEqual(before)
    // nothing of them in the Work service's folder either: they are main's own rows
    expect(side()).toEqual([])
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view).toMatchObject({ shared: true, rev: 0, suggestions: [] })
    expect(view.changes!.map((c) => c.words)).toEqual(['Bold, an outside border on A1:B2', 'A list (Open, Done) on C1:C9', 'The name Status for C1:C9'])

    const taken = await call<SheetView>('work.sheets.review', { itemId, which: 'all', verdict: 'accept' })
    expect(taken.changes).toBeUndefined()
    expect(taken.rev).toBe(3)
    const wb = await cold()
    const style = (row: number, col: number): Record<string, unknown> => {
      const s = wb.sheets.sheet1!.cellData?.[row]?.[col]?.s
      return ((typeof s === 'string' ? wb.styles?.[s] : s) ?? {}) as Record<string, unknown>
    }
    expect(style(0, 0)).toMatchObject({ bl: 1 })
    expect(Object.keys((style(0, 0).bd ?? {}) as object).sort()).toEqual(['l', 't'])
    const resource = (name: string): Record<string, unknown> => JSON.parse(wb.resources?.find((r) => r.name === name)?.data ?? '{}') as Record<string, unknown>
    expect((resource('SHEET_DATA_VALIDATION_PLUGIN').sheet1 as Record<string, unknown>[])[0]).toMatchObject({ type: 'list', formula1: 'Open,Done', showErrorMessage: true })
    expect(Object.values(resource('SHEET_DEFINED_NAME_PLUGIN'))[0]).toMatchObject({ name: 'Status', formulaOrRefString: 'Sheet1!$C$1:$C$9' })
  })

  it('on his own sheet set to write, the agent\'s own format is written and said in the bar, with no Undo on the line', async () => {
    const own = join(dir, 'Own.tcsheet')
    TcsheetBackend.create(own, 'Own')
    const id = open(own, 'Own')
    await call('work.sheets.mode', { itemId: id, mode: 'writes' })
    expect((await tool('sheet_format', { item: id, range: 'A1:B1', format: { bold: true }, because: 'own' })).text).toBe('Bold on A1:B1.')
    const view = await call<SheetView>('work.sheets.open', { itemId: id })
    expect(view.rev).toBe(1)
    expect(view.written).toMatchObject({ text: 'Bold on A1:B1', undo: false })
    // what he asked for in so many words leaves no line: he knows
    state.said.push('make the second row italic')
    await tool('sheet_format', { item: id, range: 'A2:B2', format: { italic: true }, because: 'asked', quote: 'second row italic' })
    expect((await call<SheetView>('work.sheets.open', { itemId: id })).written).toMatchObject({ text: 'Bold on A1:B1' })
  })

  it('a restore turns what waits orphaned: the sheet is another revision\'s now', async () => {
    const typed = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: { 0: { 0: { v: 1 } } } } }
    await call('work.sheets.edit', { itemId, baseRev: 0, mutations: [typed] })
    await tool('sheet_format', { item: itemId, range: 'A1', format: { bold: true }, because: 'own' })
    const restored = await call<SheetView>('work.sheets.restore', { itemId, rev: 0 })
    expect(restored.changes!.map((c) => c.state)).toEqual(['orphaned'])
    await expect(call('work.sheets.review', { itemId, which: { ids: [restored.changes![0].id] }, verdict: 'accept' })).rejects.toThrow('Rows or columns changed since the agent suggested this')
  })

  it('a rule he asked for is written at once; a sheet read from a .csv takes neither', async () => {
    state.said.push('highlight anything over 100 in column A')
    const r = await tool('sheet_rule', { item: itemId, rule: { kind: 'highlight', range: 'A1:A9', when: 'greater', value: 100, look: { bold: true } }, because: 'asked', quote: 'highlight anything over 100' })
    expect(r.text).toBe('Bold where A1:A9 is greater than 100.')
    const wb = await cold()
    const rules = (JSON.parse(wb.resources?.find((x) => x.name === 'SHEET_CONDITIONAL_FORMATTING_PLUGIN')?.data ?? '{}') as Record<string, unknown[]>).sheet1
    expect(rules).toHaveLength(1)
    const csv = join(dir, 'list.csv')
    writeFileSync(csv, 'a,b\n1,2\n')
    const refused = await tool('sheet_format', { file: csv, range: 'A1', format: { bold: true }, because: 'own' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('A .csv keeps cell contents only')
  })
})

/**
 * A workbook others can open keeps nothing on this host past its tab or thread, and nothing of it
 * where a backup reads (the editors plan, "University files"): held through the pillar's own wire.
 */
describe('what this host keeps of an Excel file others can open', () => {
  let path: string
  let itemId: string
  const filesUnder = (root: string): string[] => (existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : [])
  beforeEach(() => {
    mkdirSync(join(library, 'Budget'), { recursive: true })
    path = join(library, 'Budget', 'Budget.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    itemId = open(path, 'Budget.xlsx')
  })

  it('its copies lie in the scratch the backups leave out, its log holds no word he typed, and both the copies and nothing else go with its tab', async () => {
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view).toMatchObject({ shared: true, rev: 0 })
    const book = importXlsx(new Uint8Array(readFileSync(path))).workbook
    const sheet = book.sheetOrder.find((s) => book.sheets[s]?.name === 'Data')!
    const typed = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: sheet, cellValue: { 30: { 0: { v: SECRET } } } } }
    expect(await call('work.sheets.edit', { itemId, baseRev: 0, mutations: [typed] })).toMatchObject({ rev: 1 })
    await tool('sheet_suggest', { item: itemId, cells: [{ at: 'Data!A2', v: 41 }], reason: 'a guess' })
    // the copies: in the scratch alone
    expect(filesUnder(join(dir, 'sheets', 'files'))).toEqual([])
    expect(filesUnder(sharedCopies(dir)).length).toBe(2)
    // what he typed is in the file and in no row of the edit log
    expect(JSON.stringify(db.prepare('SELECT * FROM work_sheets_ops').all())).not.toContain(SECRET)
    // the tab closed for good: the copies go; the suggestion still waits on this host, as he ruled
    const item = work.ctx.canvas.get(itemId)!
    work.ctx.canvas.remove([itemId])
    // (the canvas tells every loaded pillar; this rig loads the two by hand, so the pillar is told here; the thread that suggested holds it too)
    sheets.itemsRemoved!([item], work.ctx)
    sheets.sessionsRemoved!(['t1'], work.ctx)
    await vi.waitFor(() => expect(filesUnder(sharedCopies(dir))).toEqual([]))
    expect((db.prepare('SELECT COUNT(*) AS n FROM work_sheets_shared').get() as { n: number }).n).toBe(0)
    const again = open(path, 'Budget.xlsx')
    const back = await call<SheetView>('work.sheets.open', { itemId: again })
    expect(back.rev).toBe(1)
    expect(back.suggestions.filter((s) => s.state === 'pending')).toHaveLength(1)
    // what he decides leaves this host's database with his press
    await tool('sheet_format', { item: again, range: 'Data!A1:C1', format: { bold: true }, because: 'own' })
    expect((db.prepare('SELECT COUNT(*) AS n FROM work_sheets_suggestions').get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM work_sheets_changes').get() as { n: number }).n).toBe(1)
    await call('work.sheets.review', { itemId: again, which: 'all', verdict: 'reject' })
    expect((db.prepare('SELECT COUNT(*) AS n FROM work_sheets_suggestions').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM work_sheets_changes').get() as { n: number }).n).toBe(0)
  })

  it('a thread working on it by its item holds it too', async () => {
    await tool('sheet_read', { item: itemId, range: 'Data!A1:B2' })
    expect(db.prepare('SELECT item, session FROM work_sheets_shared').all()).toEqual([{ item: itemId, session: 't1' }])
  })

  it('a thread that read it by its path holds it until the thread is deleted', async () => {
    expect((await tool('sheet_read', { file: path, range: 'Data!A1:B2' })).isError).toBeFalsy()
    expect(filesUnder(sharedCopies(dir)).length).toBe(1)
    expect(db.prepare('SELECT item, session FROM work_sheets_shared').all()).toEqual([{ item: '', session: 't1' }])
    sheets.sessionsRemoved!(['t1'], work.ctx)
    await vi.waitFor(() => expect(filesUnder(sharedCopies(dir))).toEqual([]))
  })
})

/**
 * A .csv others can open, and what is written out of a sheet others can open (the editors plan,
 * "University files"): the .csv's sheet is a cache in Files' scratch, and since the cache does not
 * last each edit is saved through to the file; an export never lands beside the shared file or
 * where a backup reads, and goes with its tab.
 */
describe('a .csv and an export in a folder others can open', () => {
  const filesUnder = (root: string): string[] => (existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : [])
  const scratch = (): string => join(dir, 'work-files', 'preview-scratch', 'sheets')

  it('a shared .csv is read into a cache in the scratch, nothing of it among the app\'s own files; an edit and an asked write are saved through to the file (formatsIn.wired.test.ts holds the rest)', async () => {
    const csv = join(library, 'List.csv')
    writeFileSync(csv, `name,code\nAda,${SECRET}\n`)
    const itemId = open(csv, 'List.csv')
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view).toMatchObject({ store: 'csv', shared: true })
    expect(view.readOnly).toBeUndefined()
    expect(filesUnder(join(dir, 'sheets', 'csv'))).toEqual([])
    expect(filesUnder(join(scratch(), 'csv'))).toHaveLength(1)
    const typed = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: { 5: { 0: { v: 'x' } } } } }
    expect(await call('work.sheets.edit', { itemId, baseRev: view.rev, mutations: [typed] })).toEqual({ rev: view.rev + 1 })
    expect(readFileSync(csv, 'utf8')).toBe(`name,code\nAda,${SECRET}\n\n\n\nx\n`)
    state.said.push('put y in A7 please')
    const wrote = await tool('sheet_write', { item: itemId, cells: [{ at: 'A7', v: 'y' }], because: 'asked', quote: 'put y in A7' })
    expect(wrote.isError).toBeUndefined()
    expect(readFileSync(csv, 'utf8')).toBe(`name,code\nAda,${SECRET}\n\n\n\nx\ny\n`)
    expect(filesUnder(join(dir, 'sheets', 'csv'))).toEqual([])
    expect(readdirSync(library)).toEqual(['List.csv'])
  })

  it('his own .csv is a sheet he edits, kept among the app\'s files as before', async () => {
    const csv = join(dir, 'Own.csv')
    writeFileSync(csv, 'a,b\n1,2\n')
    const itemId = open(csv, 'Own.csv')
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.readOnly).toBeUndefined()
    expect(filesUnder(join(dir, 'sheets', 'csv'))).toHaveLength(1)
    expect(filesUnder(join(scratch(), 'csv'))).toEqual([])
  })

  it('a sheet of a shared workbook written out as .csv is a copy he takes: in his workspace\'s own folder, never beside the file', async () => {
    mkdirSync(join(library, 'Budget'), { recursive: true })
    const path = join(library, 'Budget', 'Budget.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    const itemId = open(path, 'Budget.xlsx')
    const before = folder()
    // no folder of his own here: said, and nothing written
    await expect(call('work.sheets.export', { itemId, format: 'csv' })).rejects.toThrow('there is no folder of your own here')
    const mine = join(dir, 'My workspace')
    mkdirSync(mine)
    const cols = (db.prepare(`PRAGMA table_info(workspaces)`).all() as { name: string; notnull: number; dflt_value: unknown; pk: number }[]).filter((c) => c.notnull && c.dflt_value === null && !['id', 'name', 'path'].includes(c.name))
    db.prepare(`INSERT INTO workspaces (id, name, path, kind${cols.map((c) => `, ${c.name}`).join('')}) VALUES ('w1', 'Mine', ?, 'work'${cols.map(() => ', 0').join('')})`).run(mine)
    const out = await call<{ path: string }>('work.sheets.export', { itemId, format: 'csv' })
    expect(out.path).toBe(join(mine, 'Budget.csv'))
    expect(readFileSync(out.path, 'utf8').length).toBeGreaterThan(0)
    // a second one does not write over the first
    expect((await call<{ path: string }>('work.sheets.export', { itemId, format: 'csv' })).path).not.toBe(out.path)
    expect(folder()).toEqual(before)
  })

  it('a shared .csv he was already editing here keeps its sheet and his edits: it is not made read-only under him, and saves back', async () => {
    const csv = join(library, 'Edited.csv')
    writeFileSync(csv, 'a,b\n1,2\n')
    // as it stood before the rule: a sheet among the app's own files, with an edit of his
    state.library = ''
    const itemId = open(csv, 'Edited.csv')
    const first = await call<SheetView>('work.sheets.open', { itemId })
    const typed = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: { 1: { 0: { v: 'his edit' } } } } }
    expect(await call('work.sheets.edit', { itemId, baseRev: first.rev, mutations: [typed] })).toMatchObject({ rev: first.rev + 1 })
    // now its folder counts as one others can open
    state.library = library
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.readOnly).toBeUndefined()
    expect(view.rev).toBe(first.rev + 1)
    expect(filesUnder(join(dir, 'sheets', 'csv'))).toHaveLength(1)
    expect(filesUnder(join(scratch(), 'csv'))).toEqual([])
    const out = await call<{ path: string }>('work.sheets.export', { itemId, format: 'csv' })
    expect(out.path).toBe(csv)
    expect(readFileSync(csv, 'utf8')).toContain('his edit')
  })

  it('a sheet of his that cannot be read just now is never taken for an unedited cache and removed', async () => {
    const { csvEdited, ownCsvPath, csvSheetPath } = await import('./held')
    const csv = join(library, 'Busy.csv')
    writeFileSync(csv, 'a\n1\n')
    const own = ownCsvPath(dir, csv)
    mkdirSync(join(dir, 'sheets', 'csv'), { recursive: true })
    // a sheet that is there but is no readable .tcsheet (a write in flight, a file the disk will not give up)
    writeFileSync(own, 'not a zip')
    expect(csvEdited(own)).toBe(true)
    expect(csvSheetPath(dir, csv)).toBe(own)
    // one read at revision 0 is the only thing that lets it go
    rmSync(own)
    TcsheetBackend.create(own, 'Busy')
    expect(csvEdited(own)).toBe(false)
    expect(csvSheetPath(dir, csv)).not.toBe(own)
    expect(csvEdited(join(dir, 'sheets', 'csv', 'missing.tcsheet'))).toBe(false)
  })

  it('a shared .csv that changes on disk is read again: its cache is named for the file as it stands', async () => {
    const csv = join(library, 'Fresh.csv')
    writeFileSync(csv, 'a\nold\n')
    const itemId = open(csv, 'Fresh.csv')
    await call<SheetView>('work.sheets.open', { itemId })
    expect((await tool('sheet_read', { item: itemId, range: 'A2' })).text).toContain('old')
    writeFileSync(csv, 'a\nnewer value\n')
    await call<SheetView>('work.sheets.open', { itemId })
    expect((await tool('sheet_read', { item: itemId, range: 'A2' })).text).toContain('newer value')
    // the cache of the file as it stood is gone
    expect(filesUnder(join(scratch(), 'csv'))).toHaveLength(1)
  })
})

/**
 * The agent's side of what a hand does in the grid's Table menu (sheet_table): the same rule as a
 * format's. On a workbook others can open its own idea waits in words on this host and the file and
 * its folder stay byte for byte until his press; asked for in so many words, or on his own sheet set
 * to write, it is written at once; each read back from the file.
 */
describe('a table an agent makes or changes', () => {
  const tablesIn = (path: string) => readTables(new Uint8Array(readFileSync(path))).sheets.Data?.tables ?? []
  let path: string
  let itemId: string
  beforeEach(() => {
    mkdirSync(join(library, 'Budget'), { recursive: true })
    path = join(library, 'Budget', 'Budget.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    itemId = open(path, 'Budget.xlsx')
  })

  it('on an Excel file others can open, its own idea waits in words, the file and its folder byte for byte; his accept writes the table part', async () => {
    const before = folder()
    const made = await tool('sheet_table', { item: itemId, table: { op: 'make', range: 'Data!A1:C21', name: 'Budget', style: 'Medium 4', total: true }, because: 'own', reason: 'easier to sort' })
    expect(made.isError, made.text).toBeFalsy()
    expect(made.text).toMatch(/^Suggested: Table Budget on Data!A1:C22, Medium 4, total row\. Others share this sheet/)
    expect(folder()).toEqual(before)
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.changes!.map((c) => [c.kind, c.state, c.reason])).toEqual([['table', 'pending', 'easier to sort']])
    expect(JSON.stringify(view.changes)).not.toContain('TableStyleMedium4')
    // a reject leaves nothing anywhere
    await tool('sheet_table', { item: itemId, table: { op: 'make', range: 'Data!E1:F4' }, because: 'own' })
    const [first, second] = (await call<SheetView>('work.sheets.open', { itemId })).changes!
    await call('work.sheets.review', { itemId, which: { ids: [second!.id] }, verdict: 'reject' })
    expect(folder()).toEqual(before)
    const taken = await call<SheetView>('work.sheets.review', { itemId, which: { ids: [first!.id] }, verdict: 'accept' })
    expect(taken).toMatchObject({ rev: 1 })
    expect(taken.changes).toBeUndefined()
    const [table] = tablesIn(path)
    expect(table).toMatchObject({ name: 'Budget', range: { startRow: 0, startColumn: 0, endColumn: 2 }, options: { tableStyleId: 'TableStyleMedium4' } })
    expect((table!.options as { hasTotalRow?: boolean }).hasTotalRow).toBe(true)
    // nothing was written beside the file
    expect(Object.keys(folder())).toEqual(Object.keys(before))
  })

  it('asked for in so many words it is written at once; a quote he never said waits', async () => {
    state.said.push('turn the data into a table please')
    const asked = await tool('sheet_table', { item: itemId, table: { op: 'make', range: 'Data!A1:C9' }, because: 'asked', quote: 'into a table' })
    expect(asked.text).toBe('Table Table1 on Data!A1:C9, Medium 2.')
    expect(tablesIn(path).map((t) => t.name)).toEqual(['Table1'])
    const before = folder()
    const unsaid = await tool('sheet_table', { item: itemId, table: { op: 'change', table: 'Table1', style: 'Light 9' }, because: 'asked', quote: 'make it light blue' })
    expect(unsaid.text).toMatch(/^Suggested: Table Table1: Light 9\. .*counts as your own idea\.$/)
    expect(folder()).toEqual(before)
  })

  it('what the sheet has no place for is refused as it is asked, and nothing is kept', async () => {
    state.said.push('make a table of it')
    await tool('sheet_table', { item: itemId, table: { op: 'make', range: 'Data!A1:C9', name: 'Budget' }, because: 'asked', quote: 'make a table' })
    const before = folder()
    for (const table of [
      { op: 'make', range: 'Data!B2:D5' },
      { op: 'make', range: 'Data!E1:F4', name: 'Budget' },
      { op: 'make', range: 'Data!E1:F4', style: 'Medium 99' },
      { op: 'change', table: 'Nope', style: 'Light 1' },
      { op: 'total', table: 'Budget', column: 'Zebra', fn: 'sum' }
    ]) {
      const got = await tool('sheet_table', { item: itemId, table, because: 'own' })
      expect(got.isError, JSON.stringify(table)).toBe(true)
    }
    expect(folder()).toEqual(before)
    expect((await call<SheetView>('work.sheets.open', { itemId })).changes).toBeUndefined()
  })

  it('on his own Excel file set to write: made, totalled, renamed and converted back, each read back from the file', async () => {
    const own = join(dir, 'Own.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), own)
    const id = open(own, 'Own.xlsx')
    await call('work.sheets.mode', { itemId: id, mode: 'writes' })
    expect((await tool('sheet_table', { item: id, table: { op: 'make', range: 'Data!A1:C21', name: 'Costs' }, because: 'own' })).text).toBe('Table Costs on Data!A1:C21, Medium 2.')
    expect((await call<SheetView>('work.sheets.open', { itemId: id })).written).toMatchObject({ text: 'Table Costs on Data!A1:C21, Medium 2', undo: false })
    const total = await tool('sheet_table', { item: id, table: { op: 'total', table: 'Costs', column: 'C', fn: 'average' }, because: 'own' })
    expect(total.isError, total.text).toBeFalsy()
    let [t] = tablesIn(own)
    expect((t!.options as { hasTotalRow?: boolean }).hasTotalRow).toBe(true)
    expect((t!.columns[2] as { totalsRowFunction?: string }).totalsRowFunction).toBe('average')
    expect((await tool('sheet_table', { item: id, table: { op: 'change', table: 'costs', name: 'Spend', bandedRows: false }, because: 'own' })).text).toBe('Table Costs: renamed Spend, no banded rows.')
    ;[t] = tablesIn(own)
    expect(t).toMatchObject({ name: 'Spend', options: { showRowStripes: false } })
    expect((await tool('sheet_table', { item: id, table: { op: 'convert', table: 'Spend' }, because: 'own' })).text).toBe('Table Spend back to a plain range.')
    expect(tablesIn(own)).toEqual([])
  })

  it('on a .tcsheet others can open it waits in this host\'s database and lands in the sheet when he takes it', async () => {
    const plan = join(library, 'Plan.tcsheet')
    TcsheetBackend.create(plan, 'Plan')
    const id = open(plan, 'Plan')
    const cells = { 0: { 0: { v: 'Item' }, 1: { v: 'Cost' } }, 1: { 0: { v: 'Bus' }, 1: { v: 40 } }, 2: { 0: { v: 'Hotel' }, 1: { v: 90 } } }
    await call('work.sheets.edit', { itemId: id, baseRev: 0, mutations: [{ id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: cells } }] })
    const before = folder()
    expect((await tool('sheet_table', { item: id, table: { op: 'make', range: 'A1:B3', name: 'Trip', total: true }, because: 'own' })).text).toMatch(/^Suggested: Table Trip on A1:B4, Medium 2, total row\./)
    expect(folder()).toEqual(before)
    const taken = await call<SheetView>('work.sheets.review', { itemId: id, which: 'all', verdict: 'accept' })
    expect(taken.changes).toBeUndefined()
    const host = new SheetHost(() => new TcsheetBackend(plan, join(dir, 'sheets', 'suggestions')))
    try {
      const wb = JSON.parse((await host.snapshotJson({ tcsheet: plan })).json) as { sheets: Record<string, { cellData?: Record<string, Record<string, { v?: unknown; f?: unknown }>> }>; resources?: { name: string; data: string }[] }
      const tables = (JSON.parse(wb.resources?.find((r) => r.name === 'SHEET_TABLE_PLUGIN')?.data ?? '{}') as Record<string, { tables?: { name: string; range: unknown }[] }>).sheet1?.tables ?? []
      expect(tables.map((t) => [t.name, t.range])).toEqual([['Trip', { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 }]])
      // the total row's cells, as the kit fills them: a label under the first column, a sum under the last
      expect(wb.sheets.sheet1!.cellData?.[3]?.[0]?.v).toBe('Total')
      expect(wb.sheets.sheet1!.cellData?.[3]?.[1]?.f).toBe('=SUBTOTAL(109,B2:B3)')
    } finally {
      host.close()
    }
  })
})

/** The agent's side of Page Setup and the Page breaks view (sheet_page): the same rule, each read back from the file. */
describe('a page set-up an agent changes', () => {
  const pagesIn = (path: string) => readPages(new Uint8Array(readFileSync(path))).find((e) => e.sheet === 'Data')!.setup
  let path: string
  let itemId: string
  beforeEach(() => {
    mkdirSync(join(library, 'Budget'), { recursive: true })
    path = join(library, 'Budget', 'Budget.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    itemId = open(path, 'Budget.xlsx')
  })

  it('on an Excel file others can open its own idea waits in words, the folder byte for byte; his accept writes the set-up', async () => {
    const before = folder()
    const got = await tool('sheet_page', { item: itemId, page: { sheet: 'Data', orientation: 'landscape', paper: 'A4', margins: 'narrow', fit: { wide: 1, tall: 0 }, printArea: 'A1:C21', titleRows: '1' }, because: 'own' })
    expect(got.isError, got.text).toBeFalsy()
    expect(got.text).toMatch(/^Suggested: Data's page: landscape, A4, narrow margins, fit to 1 page wide, rows 1 on every page, print area A1:C21\. Others share this sheet/)
    expect(folder()).toEqual(before)
    const [change] = (await call<SheetView>('work.sheets.open', { itemId })).changes!
    expect(change).toMatchObject({ kind: 'page', range: { startRow: 0, endRow: 20, startColumn: 0, endColumn: 2 } })
    await call('work.sheets.review', { itemId, which: 'all', verdict: 'accept' })
    const setup = pagesIn(path)
    expect(setup).toMatchObject({ orientation: 'landscape', paper: { name: 'A4' }, margins: { left: 0.25 }, scaling: { kind: 'fit', wide: 1, tall: 0 }, repeatRows: { start: 0, end: 0 } })
    expect(setup.printAreas).toMatchObject([{ startRow: 0, endRow: 20, startColumn: 0, endColumn: 2 }])
  })

  it('asked for in so many words a break and a scale are written at once; what Excel would not take is refused as it is asked', async () => {
    state.said.push('print it at 80% and break after row 10')
    const asked = await tool('sheet_page', { item: itemId, page: { sheet: 'Data', scale: 80, breakAfterRow: 10 }, because: 'asked', quote: 'break after row 10' })
    expect(asked.text).toBe("Data's page: 80%, a page break under row 10.")
    expect(pagesIn(path)).toMatchObject({ scaling: { kind: 'scale', percent: 80 }, rowBreaks: [9] })
    const before = folder()
    for (const page of [{ paper: 'Napkin' }, { scale: 80, fit: { wide: 1, tall: 1 } }, { sheet: 'Nope', orientation: 'portrait' }, { sheet: 'Data', breakAfterRow: 10 }, { sheet: 'Data' }]) {
      const got = await tool('sheet_page', { item: itemId, page, because: 'asked', quote: 'break after row 10' })
      expect(got.isError, JSON.stringify(page)).toBe(true)
    }
    // past what the schema takes: refused before the sheet is read
    expect((await tool('sheet_page', { item: itemId, page: { scale: 5 }, because: 'own' })).isError).toBe(true)
    expect(folder()).toEqual(before)
  })

  it('on a .tcsheet of his own set to write it is written, and a cold load has it', async () => {
    const own = join(dir, 'Own.tcsheet')
    TcsheetBackend.create(own, 'Own')
    const id = open(own, 'Own')
    await call('work.sheets.mode', { itemId: id, mode: 'writes' })
    expect((await tool('sheet_page', { item: id, page: { orientation: 'landscape', titleColumns: 'a:b' }, because: 'own' })).text).toBe('Page: landscape, columns A:B on every page.')
    const host = new SheetHost(() => new TcsheetBackend(own, join(dir, 'sheets', 'suggestions')))
    try {
      const wb = JSON.parse((await host.snapshotJson({ tcsheet: own })).json) as { resources?: { name: string; data: string }[] }
      expect(wb.resources?.find((r) => r.name === PAGES_RESOURCE)?.data).toMatch(/"orientation":"landscape"/)
    } finally {
      host.close()
    }
  })
})
