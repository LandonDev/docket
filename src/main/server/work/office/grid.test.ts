import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasSource } from '@shared/work'
import type { WorkCtx } from '../modules'
import { SET_RANGE_VALUES } from '../sheets/mutations'
import { SuggestionStore } from '../sheets/suggestions'
import { excelStore } from './excel'
import { FakeOffice } from './fake'
import { edit, excelRefOf, follow, review, revOf, snapshot, unfollowAll } from './grid'
import { hereOf, office as officeModule, setCarrier } from './index'

/** A workbook in Excel in the sheet canvas: loaded from Excel, a change typed there reaching the grid, edits and review written back. */
const BOOK = 'https://contoso.sharepoint.com/sites/t/Budget.xlsx'
const source: CanvasSource = { at: 'microsoft', host: 'env_mac', app: 'excel', name: 'Budget.xlsx', ref: { kind: 'url', url: BOOK } }
const ref = excelRefOf(source)!
let office: FakeOffice
let ctx: WorkCtx

beforeEach(() => {
  office = new FakeOffice()
  office.addBook(BOOK, { Sheet1: { A1: 'Rent', B1: 1200, B2: '=B1*12' } })
  setCarrier(() => office)
  const db = new DatabaseSync(':memory:')
  officeModule.ensure(db)
  ctx = { db, host: 'env_mac', log: () => {} } as unknown as WorkCtx
})
afterEach(() => {
  unfollowAll()
  hereOf(ctx)?.excel.stop()
})

const set = (r: number, c: number, cell: unknown) => ({ id: SET_RANGE_VALUES, params: { unitId: 'u', subUnitId: 'Sheet1', cellValue: { [r]: { [c]: cell } } } })

describe('a workbook in Excel, in the sheet canvas', () => {
  it('loads as a snapshot of what Excel holds, sheets named by their tabs', async () => {
    await follow(ctx, ref, () => {})
    const data = JSON.parse((await snapshot(ctx, ref, revOf(ref))).toString()) as { sheetOrder: string[]; sheets: Record<string, { cellData: unknown }> }
    expect(data.sheetOrder).toEqual(['Sheet1'])
    expect(data.sheets.Sheet1.cellData).toEqual({ 0: { 0: { v: 'Rent' }, 1: { v: 1200 } }, 1: { 1: { f: '=B1*12' } } })
  })

  it('hears a change typed in Excel: the rev moves and the canvas is told', async () => {
    let told = 0
    const rev = await follow(ctx, ref, () => told++)
    await new Promise((r) => setTimeout(r, 0))
    await hereOf(ctx)!.excel.pass()
    office.type(BOOK, 'Sheet1', 'B1', 1250)
    await hereOf(ctx)!.excel.pass()
    expect(told).toBe(1)
    expect(revOf(ref)).toBe(rev + 1)
  })

  it('writes the grid\'s cell edits through Excel, and answers conflict to a grid behind the workbook', async () => {
    const rev = await follow(ctx, ref, () => {})
    await new Promise((r) => setTimeout(r, 0))
    await expect(edit(ctx, ref, rev + 5, [set(0, 1, { v: 1 })], 'owner')).resolves.toEqual({ conflict: true, rev })
    const got = await edit(ctx, ref, rev, [set(0, 1, { v: 1300 }), set(2, 0, { f: '=B2/12' })], 'owner')
    // one write (the block A1:B3), heard once
    expect(got).toEqual({ rev: rev + 1 })
    expect((await office.readRange(BOOK, 'Sheet1', 'A1:B3')).values).toEqual([['Rent', 1300], [null, null], [null, null]])
    expect((await office.readRange(BOOK, 'Sheet1', 'A3')).formulas).toEqual([['=B2/12']])
    expect((await office.readRange(BOOK, 'Sheet1', 'B2')).formulas).toEqual([['=B1*12']])
  })

  it('accepts a suggestion only while its cell holds what the agent saw', async () => {
    const store = new SuggestionStore(ctx.db)
    store.add(excelStore(BOOK), 'cs', 'agent:env_mac:t1', undefined, [
      { sheet: 'Sheet1', row: 0, col: 1, base: { v: 1200 }, proposed: { v: 1500 } },
      { sheet: 'Sheet1', row: 0, col: 0, base: { v: 'Rent' }, proposed: { v: 'Lease' } }
    ])
    office.type(BOOK, 'Sheet1', 'A1', 'Housing')
    await review(ctx, ref, 'all', 'accept', 'owner')
    expect((await office.readRange(BOOK, 'Sheet1', 'A1:B1')).values).toEqual([['Housing', 1500]])
    expect(store.open(excelStore(BOOK)).map((s) => [s.col, s.state])).toEqual([[0, 'conflict']])
  })

  it('refuses a workbook that lives on another host', async () => {
    await expect(follow(ctx, { ...ref, host: 'env_box' }, () => {})).rejects.toThrow('another host')
  })
})
