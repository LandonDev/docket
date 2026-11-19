import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { DashboardView } from '@shared/contract-work-dashboards'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import type { RouteCtx } from '../service/routes/route'
import { aggregate, barsOf, formatValue, tableOf } from './read'

/**
 * A dashboard end to end: blocks proposed by a thread's tools over a real
 * .tcsheet that the Work service's sheet host holds (its internal routes run
 * in this process), accepted or dropped by the owner, read again on his
 * press, and stale once the sheet changes under it.
 */

vi.mock('../scope', async (orig) => ({
  ...(await orig<typeof import('../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const rc = vi.hoisted(() => ({ ctx: null as unknown }))
vi.mock('../service/ctx', async (orig) => {
  const real = await orig<typeof import('../service/ctx')>()
  const { INTERNAL_ROUTES } = await import('../service/routes/index')
  return {
    ...real,
    servicePart: () => ({
      service: {
        url: (route: string) => `http://127.0.0.1:7${route}`,
        token: async () => 'x',
        internal: async (route: string, body: unknown) => INTERNAL_ROUTES.find((x) => x.path === route)!.run(body as Record<string, unknown>, rc.ctx as RouteCtx)
      }
    })
  }
})

const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas/index')
const { dashboards } = await import('./index')
const { INTERNAL_ROUTES } = await import('../service/routes/index')

let dir: string
let sheetPath: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const pushes: WorkPush[] = []
const sessions = new Map<string, SessionMeta>()
const registry = { get: (id: string) => sessions.get(id) ?? null, onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {} } as unknown as SessionRegistry

const call = async <T = unknown,>(method: string, params: unknown, principal: Parameters<typeof work.handle>[1] = LOCAL_PRINCIPAL): Promise<T> => {
  const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), principal)
  return (out.handled ? out.result : undefined) as T
}
const tool = async (name: string, args: unknown): Promise<{ text: string; isError?: boolean; item?: string }> => {
  const r = (await work.tools.call({ id: 't1', scope: 'work' }, name, args, new AbortController().signal)) as { content: Array<{ text?: string }>; isError?: boolean; structuredContent?: { item?: string } }
  return { text: r.content.map((c) => c.text ?? '').join(''), isError: r.isError, item: r.structuredContent?.item }
}
const sheetOp = (op: string, body: Record<string, unknown>): Promise<unknown> => INTERNAL_ROUTES.find((x) => x.path === `/internal/sheet/${op}`)!.run(body, rc.ctx as RouteCtx)
const write = (cells: { at: string; v: string | number }[]): Promise<unknown> => sheetOp('cells', { sheet: { tcsheet: sheetPath }, cells, by: 'owner', suggest: false })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-dash-'))
  rc.ctx = { config: () => ({ dataDir: join(dir, 'work-service'), lifeos: { here: false, host: null } }), log: () => {} }
  sheetPath = join(dir, 'Invoices 2026.tcsheet')
  await sheetOp('create', { title: 'Invoices 2026', at: { tcsheet: sheetPath } })
  await write([
    { at: 'A1', v: 'Month' }, { at: 'B1', v: 'Paid' }, { at: 'C1', v: 'Client' },
    { at: 'A2', v: 'Sep' }, { at: 'B2', v: 13100 }, { at: 'C2', v: 'Rivera Dental' },
    { at: 'A3', v: 'Oct' }, { at: 'B3', v: 10400 }, { at: 'C3', v: 'Harbor Legal' },
    { at: 'A4', v: 'Nov' }, { at: 'B4', v: 12300 }, { at: 'C4', v: 'Kline Roofing' }
  ])
  db = openDb(join(dir, 'test.db'))
  pushes.length = 0
  sessions.set('t1', { id: 't1', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: { roots: () => [join(dir, 'nowhere')], denied: () => [] } }, [canvas, dashboards])
  work.pushes.onPush((p) => pushes.push(p))
  await call('work.set', { enabled: true })
})
afterEach(() => {
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function board(): Promise<string> {
  const made = await tool('dashboard_create', { title: 'Unify receivables' })
  return made.item!
}

describe('a dashboard', () => {
  it('takes an agent\'s blocks only as proposals, read from the sheet as they are added', async () => {
    const item = await board()
    const r = await tool('dashboard_add', {
      item,
      block: {
        kind: 'figures',
        figures: [
          { label: 'Paid this quarter', sub: '3 months', format: 'money', sheet: sheetPath, range: 'B2:B4', agg: 'sum', counts: 'Paid, summed over the quarter' },
          { label: 'Balance', service: 'Stripe', counts: 'Balance on the account', value: '$2,180' }
        ]
      },
      reason: 'You asked what came in'
    })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('waits for his Accept')
    await tool('dashboard_add', { item, block: { kind: 'chart', title: 'Paid by month', sheet: sheetPath, labels: 'A2:A4', values: 'B2:B4', counts: 'Paid each month', format: 'money' } })
    await tool('dashboard_add', { item, block: { kind: 'table', title: 'Clients', sheet: sheetPath, range: 'A1:C4', counts: 'Every invoice this quarter' } })
    const view = await call<DashboardView>('work.dashboards.open', { itemId: item })
    expect(view.blocks.every((b) => b.proposed)).toBe(true)
    expect(view.asOf).not.toBeNull()
    expect(view.stale).toBe(false)
    const [figs, chart, table] = view.blocks
    expect(figs.kind === 'figures' && figs.figures.map((f) => f.value)).toEqual(['$35,800', '$2,180'])
    expect(figs.kind === 'figures' && figs.figures[0].from).toMatchObject({ sheet: { at: 'file', host: 'env_test', path: sheetPath }, sheetTitle: 'Invoices 2026', range: 'B2:B4' })
    expect(chart.kind === 'chart' && chart.bars).toEqual([
      { label: 'Sep', value: 13100 },
      { label: 'Oct', value: 10400 },
      { label: 'Nov', value: 12300 }
    ])
    expect(table.kind === 'table' && [table.head, table.rows[0], table.numeric]).toEqual([['Month', 'Paid', 'Client'], ['Sep', '13,100', 'Rivera Dental'], [false, true, false]])
    expect(pushes.some((p) => p.push === 'work.dashboards' && p.itemId === item)).toBe(true)

    // He keeps the figures and the chart, and drops the table.
    await call('work.dashboards.review', { itemId: item, which: { ids: [figs.id, chart.id] }, verdict: 'accept' })
    const after = await call<DashboardView>('work.dashboards.review', { itemId: item, which: 'all', verdict: 'reject' })
    expect(after.blocks.map((b) => [b.kind, !!b.proposed])).toEqual([
      ['figures', false],
      ['chart', false]
    ])
  })

  it('goes stale when the sheet changes, and reads the new numbers on a refresh', async () => {
    const item = await board()
    await tool('dashboard_add', { item, block: { kind: 'figures', figures: [{ label: 'November', format: 'money', sheet: sheetPath, range: 'B4', counts: 'Paid in November' }] } })
    const first = await call<DashboardView>('work.dashboards.open', { itemId: item })
    expect(first.stale).toBe(false)
    await write([{ at: 'B4', v: 14000 }])
    const moved = await call<DashboardView>('work.dashboards.open', { itemId: item })
    expect(moved.stale).toBe(true)
    // Stale says the numbers are old; it does not change them.
    expect(moved.blocks[0].kind === 'figures' && moved.blocks[0].figures[0].value).toBe('$12,300')
    const fresh = await call<DashboardView>('work.dashboards.refresh', { itemId: item })
    expect(fresh.stale).toBe(false)
    expect(fresh.asOf!).toBeGreaterThanOrEqual(first.asOf!)
    expect(fresh.blocks[0].kind === 'figures' && fresh.blocks[0].figures[0].value).toBe('$14,000')
  })

  it('takes a routine\'s refresh with the values of figures from a service', async () => {
    const item = await board()
    await tool('dashboard_add', { item, block: { kind: 'figures', figures: [{ label: 'Balance', service: 'Stripe', counts: 'Balance on the account', value: '$2,180' }] } })
    const id = (await call<DashboardView>('work.dashboards.open', { itemId: item })).blocks[0]
    const fig = id.kind === 'figures' ? id.figures[0].id : ''
    const r = await tool('dashboard_refresh', { item, values: [{ figure: fig, value: '$2,640' }] })
    expect(r.text).toContain('Balance: $2,640')
  })

  it('says why a read failed and keeps what was there', async () => {
    const item = await board()
    const r = await tool('dashboard_add', { item, block: { kind: 'figures', figures: [{ label: 'Bad', sheet: sheetPath, range: 'not a range', counts: 'x' }] } })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('could not be read')
    const view = await call<DashboardView>('work.dashboards.open', { itemId: item })
    expect(view.failed).toContain('not a range')
    expect(view.blocks).toHaveLength(1)
  })

  it('shows a remote key nothing of a page read from a file it could not name', async () => {
    const item = await board()
    await tool('dashboard_add', { item, block: { kind: 'text', text: 'Receivables for Unify.' } })
    const phone = { kind: 'remote' as const, caps: ['read', 'operate'], keyId: 'k', name: 'phone' }
    expect((await call<DashboardView>('work.dashboards.open', { itemId: item }, phone as never)).blocks).toHaveLength(1)
    await tool('dashboard_add', { item, block: { kind: 'figures', figures: [{ label: 'Nov', sheet: sheetPath, range: 'B4', counts: 'Paid in November' }] } })
    await expect(call('work.dashboards.open', { itemId: item }, phone as never)).rejects.toThrow('outside app-managed roots')
  })
})

describe('what a dashboard makes of cells', () => {
  const col = (vs: (string | number | undefined)[]) => vs.map((v, i) => [{ at: `A${i + 1}`, ...(v === undefined ? {} : { v }) }])
  it('sums, counts and averages a range, and reads one cell as it is', () => {
    expect(aggregate(col([1850, '2,400.00', undefined, '$1,920']), 'sum')).toBe(6170)
    expect(aggregate(col([1850, 'Paid', undefined]), 'count')).toBe(2)
    expect(aggregate(col([2, 4]), 'average')).toBe(3)
    expect(aggregate(col(['Nov 23']), 'cell')).toBe('Nov 23')
    expect(aggregate(col([]), 'sum')).toBeNull()
  })
  it('formats money, numbers and shares as the page shows them', () => {
    expect(formatValue(7420, 'money')).toBe('$7,420')
    expect(formatValue(1850.5, 'money')).toBe('$1,850.50')
    expect(formatValue(12300, 'number')).toBe('12,300')
    expect(formatValue(0.14, 'percent')).toBe('14%')
    expect(formatValue('Nov 23', 'money')).toBe('Nov 23')
  })
  it('pairs bar names with values and makes a flat table with its head', () => {
    expect(barsOf(col(['Jun', 'Jul', '']), col([9800, 'x', 5]))).toEqual([{ label: 'Jun', value: 9800 }])
    expect(tableOf([[{ at: 'A1', v: 'Client' }, { at: 'B1', v: 'Amount' }], [{ at: 'A2' }, { at: 'B2' }], [{ at: 'A3', v: 'Rivera' }, { at: 'B3', v: 1850 }]])).toEqual({
      head: ['Client', 'Amount'],
      rows: [['Rivera', '1,850']],
      numeric: [false, true]
    })
  })
})
