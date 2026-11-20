import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashCells, type SheetChange } from 'work-kit/sheet/source'
import { ensureSuggestionTables, SuggestionStore } from '../sheets/suggestions'
import { ensureExcelTables, excelStore, ExcelHelper, parseAddress, shiftOf } from './excel'
import { FakeOffice } from './fake'

/** Excel as the truth behind the grid, over an Office in memory. */
const BOOK = 'https://contoso.sharepoint.com/sites/t/Budget.xlsx'
let office: FakeOffice
let db: DatabaseSync
let suggestions: SuggestionStore
let excel: ExcelHelper

beforeEach(() => {
  office = new FakeOffice()
  office.addBook(BOOK, { Sheet1: { A1: 'Item', B1: 'Cost', A2: 'Rent', B2: 1200, A3: 'Food', B3: 300, B4: '=SUM(B2:B3)' } })
  db = new DatabaseSync(':memory:')
  ensureSuggestionTables(db)
  ensureExcelTables(db)
  suggestions = new SuggestionStore(db)
  excel = new ExcelHelper(office, db, suggestions, () => 1_000)
})

const suggest = (row: number, col: number) =>
  suggestions.add(excelStore(BOOK), 'cs1', 'agent:env_mac:t1', undefined, [{ sheet: 'Sheet1', row, col, base: { v: 300 }, proposed: { v: 350 } }])

describe('the Excel helper', () => {
  it('reads a block with the hash work-kit gives the same cells', async () => {
    const b = await excel.read(BOOK, 'Sheet1', parseAddress('A2:B4'))
    expect(b.values).toEqual([['Rent', 1200], ['Food', 300], [null, null]])
    expect(b.formulas[2][1]).toBe('=SUM(B2:B3)')
    expect(b.hash).toBe(hashCells([{ v: 'Rent' }, { v: 1200 }, { v: 'Food' }, { v: 300 }, null, { f: '=SUM(B2:B3)' }]))
  })

  it('answers conflict and writes nothing when the cells moved on since the agent read them', async () => {
    const seen = await excel.read(BOOK, 'Sheet1', parseAddress('B3'))
    office.type(BOOK, 'Sheet1', 'B3', 310)
    const got = await excel.write(BOOK, 'Sheet1', parseAddress('B3'), [[350]], { base: seen.hash, by: 'owner' })
    expect(got).toMatchObject({ conflict: true, now: { values: [[310]] } })
    expect(office.log.filter((l) => l.verb === 'writeRange')).toEqual([])
    expect(excel.writes(BOOK)).toEqual([])
  })

  it('writes through Excel, keeps its own undo, and undoes only while the cells hold what it wrote', async () => {
    const seen = await excel.read(BOOK, 'Sheet1', parseAddress('B2:B3'))
    const got = await excel.write(BOOK, 'Sheet1', parseAddress('B2:B3'), [[1250], ['=B2/4']], { base: seen.hash, by: 'agent:env_mac:t1' })
    if (!('ok' in got)) throw new Error('conflict')
    expect((await excel.read(BOOK, 'Sheet1', parseAddress('B2:B3'))).formulas).toEqual([[''], ['=B2/4']])
    expect(excel.writes(BOOK)).toMatchObject([{ writeId: got.writeId, sheet: 'Sheet1', address: 'B2:B3', by: 'agent:env_mac:t1' }])
    await expect(excel.undo(BOOK, got.writeId)).resolves.toEqual({ ok: true })
    expect((await excel.read(BOOK, 'Sheet1', parseAddress('B2:B3'))).values).toEqual([[1200], [300]])

    const again = await excel.write(BOOK, 'Sheet1', parseAddress('B2'), [[9]], { by: 'owner' })
    if (!('ok' in again)) throw new Error('conflict')
    office.type(BOOK, 'Sheet1', 'B2', 10)
    await expect(excel.undo(BOOK, again.writeId)).resolves.toEqual({ conflict: true })
    expect((await excel.read(BOOK, 'Sheet1', parseAddress('B2'))).values).toEqual([[10]])
  })

  it('hears a change typed in Excel on the safety pass, and the waiting suggestion on that cell turns conflict', async () => {
    suggest(2, 1)
    const heard: SheetChange[] = []
    const off = excel.watch(BOOK, 'Sheet1', parseAddress('A1:B4'), (c) => heard.push(c))
    await excel.pass()
    expect(heard).toEqual([])
    office.type(BOOK, 'Sheet1', 'B3', 320)
    await excel.pass()
    expect(heard).toEqual([{ kind: 'cells', ranges: [{ sheet: 'Sheet1', startRow: 0, startColumn: 0, endRow: 3, endColumn: 1 }], by: 'excel' }])
    expect(suggestions.open(excelStore(BOOK)).map((s) => s.state)).toEqual(['conflict'])
    off()
  })

  it('takes a row inserted by a co-author as a shift, and orphans every suggestion on the workbook', async () => {
    suggest(2, 1)
    const heard: SheetChange[] = []
    excel.watch(BOOK, 'Sheet1', parseAddress('A1:B6'), (c) => heard.push(c))
    await excel.pass()
    office.insertRows(BOOK, 'Sheet1', 1, 1)
    await excel.pass()
    expect(heard[0]).toMatchObject({ kind: 'cells', shifted: true })
    expect(suggestions.open(excelStore(BOOK)).map((s) => s.state)).toEqual(['orphaned'])
  })

  it("tells a watcher of its own writes as ours, never as someone else's, and leaves suggestions on other cells waiting", async () => {
    suggest(2, 1)
    const heard: SheetChange[] = []
    excel.watch(BOOK, 'Sheet1', parseAddress('A1:B4'), (c) => heard.push(c))
    await excel.pass()
    await excel.write(BOOK, 'Sheet1', parseAddress('B2'), [[1300]], { by: 'owner' })
    await excel.pass()
    expect(heard.map((c) => c.kind === 'cells' && c.by)).toEqual(['tempcode'])
    expect(suggestions.open(excelStore(BOOK)).map((s) => s.state)).toEqual(['pending'])
  })

  it('is a SheetSource: the outline first, cell writes against the base hash, conflict when stale', async () => {
    const src = excel.source(BOOK, 'owner')
    const heard: SheetChange[] = []
    const off = src.subscribe((c) => heard.push(c))
    await new Promise((r) => setTimeout(r, 0))
    expect(heard[0]).toEqual({ kind: 'outline', sheets: [{ id: 'Sheet1', name: 'Sheet1', rowCount: 4, columnCount: 2 }] })
    const block = await src.read({ sheet: 'Sheet1', startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 })
    expect(block.cells).toEqual([[{ v: 1200 }], [{ v: 300 }]])
    // a formula cell carries the value Excel computed beside its formula
    office.books.get(BOOK)!.sheets.get('Sheet1')!.get('3,1')!.v = 1500
    expect((await src.read({ sheet: 'Sheet1', startRow: 3, startColumn: 1, endRow: 3, endColumn: 1 })).cells).toEqual([[{ f: '=SUM(B2:B3)', v: 1500 }]])
    const base = hashCells([{ v: 300 }])
    await expect(src.write([{ sheet: 'Sheet1', row: 2, column: 1, cell: { v: 333 } }], base)).resolves.toBe('ok')
    await expect(src.write([{ sheet: 'Sheet1', row: 2, column: 1, cell: { v: 444 } }], base)).resolves.toBe('conflict')
    expect((await excel.read(BOOK, 'Sheet1', parseAddress('B3'))).values).toEqual([[333]])
    off()
  })
})

describe('shiftOf', () => {
  const rows = (...xs: (string | null)[]) => xs.map((x) => [x === null ? null : { v: x }])
  it('finds rows that moved down or up, and not a plain edit', () => {
    expect(shiftOf(rows('a', 'b', 'c', null), rows(null, 'a', 'b', 'c'))).toBe(true)
    expect(shiftOf(rows('a', 'b', 'c', 'd'), rows('b', 'c', 'd', null))).toBe(true)
    expect(shiftOf(rows('a', 'b', 'c'), rows('a', 'x', 'c'))).toBe(false)
  })
})
