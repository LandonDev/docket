import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync, strFromU8 } from 'fflate'
import { afterAll, describe, expect, it } from 'vitest'
import type { IWorkbookData } from '@univerjs/core'
import type { MoneyActed, MoneyRead } from '@shared/contract-work-money'
import { sigOf } from '@shared/work/money'
import type { WorkCtx } from '../modules'
import { hostOf, internalSheetRoutes } from '../service/routes/internalSheet'
import type { RouteCtx } from '../service/routes/route'
import { writeXlsx } from '../sheets/writer'
import { money } from '.'
import { ensureMoneyTables } from './store'
import { LOCAL, req } from './testing'

/*
 * The ledger over the Work service's own sheet host and a real `.tcsheet`:
 * the routes Money calls are the service's (`internalSheetRoutes`), run in
 * this process the way the service runs them.
 */

const root = mkdtempSync(join(tmpdir(), 'money-real-'))
const routeCtx = { log: () => {}, convex: async () => null, config: () => ({ lifeos: { here: false } }) } as unknown as RouteCtx
const routes = new Map(internalSheetRoutes.map((r) => [r.path, r]))
const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, kind TEXT, sector TEXT, created_at INTEGER)')
const folder = join(root, 'Ref')
mkdirSync(folder)
db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run('ws-ref', 'Ref', folder, 'work', 'ref', 1)
ensureMoneyTables(db)
const ctx = {
  db,
  host: 'env_box',
  log: () => {},
  reaches: () => true,
  lifeos: { connected: () => false },
  push: () => {},
  service: { internal: (route: string, body: unknown) => routes.get(route)!.run(body as Record<string, unknown>, routeCtx) }
} as unknown as WorkCtx
const call = async <T>(method: string, params: unknown): Promise<T> => ((await money.handle!(req(method, params), ctx, LOCAL)) as { result: T }).result
const ledger = join(folder, 'Money', 'Ledger.tcsheet')

afterAll(() => {
  hostOf(routeCtx).close()
  rmSync(root, { recursive: true, force: true })
})

describe('the ledger on the real sheet host', () => {
  it('makes the books, appends rows, reads them back, and changes one row by what the window saw', async () => {
    const add = (fields: Record<string, unknown>) => call<MoneyActed>('work.money.entry', { workspaceId: 'ws-ref', fields: { date: '2026-11-21', who: 'Blue Heron Coffee', way: 'out', amount: 1043, ...fields } })
    expect(await add({ category: 'Meals' })).toMatchObject({ ok: true, row: 2 })
    expect(await add({ who: 'Harrison HS', way: 'in', amount: 7500, status: 'Unpaid', date: '2026-11-20' })).toMatchObject({ ok: true, row: 3 })
    const read = () => call<MoneyRead>('work.money.read', { workspaceId: 'ws-ref', from: '2026-11-01', to: '2026-12-01' })
    const first = await read()
    expect(first.rows.map((r) => [r.row, r.who, r.in, r.out, r.status])).toEqual([
      [2, 'Blue Heron Coffee', 0, 1043, 'Paid'],
      [3, 'Harrison HS', 7500, 0, 'Unpaid']
    ])
    expect(first.sums).toEqual({ in: 0, out: 1043, net: -1043, owedToHim: 7500, heOwes: 0 })

    // His own edit in the sheet, through the same host: Money shows it, and an act on the old reading is refused.
    await ctx.service.internal('/internal/sheet/cells', { sheet: { tcsheet: ledger }, cells: [{ at: 'E3', v: 80 }], by: 'owner', suggest: false })
    const stale = first.rows[1]
    expect(await call('work.money.paid', { workspaceId: 'ws-ref', at: { ref: null, row: stale.row, sig: sigOf(stale) } })).toEqual({ changed: true })
    const fresh = (await read()).rows[1]
    expect(fresh.in).toBe(8000)
    expect(await call('work.money.paid', { workspaceId: 'ws-ref', at: { ref: fresh.ref, row: fresh.row, sig: sigOf(fresh) }, on: '2026-11-23' })).toMatchObject({ ok: true, row: 3 })
    expect((await read()).rows[1]).toMatchObject({ status: 'Paid', paidOn: '2026-11-23' })
  })

  it('dresses the sheet so the look reaches an exported Excel file: a bold first row that stays in view', async () => {
    const { json } = await hostOf(routeCtx).snapshotJson({ tcsheet: ledger })
    const book = JSON.parse(json) as IWorkbookData
    const files = unzipSync(writeXlsx(book))
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')
    // The header cell carries a style whose font is bold.
    const styleOfA1 = /<c r="A1"[^>]* s="(\d+)"/.exec(sheet)?.[1]
    expect(styleOfA1).toBeDefined()
    const styles = strFromU8(files['xl/styles.xml'])
    expect(styles).toContain('<b/>')
    // And the header still reads as text, the amounts as numbers.
    expect(sheet).toMatch(/<c r="F2"[^>]*><v>10\.43<\/v>/)
  })
})
