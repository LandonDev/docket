import { IUniverInstanceService } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { headlessSheet } from 'work-kit/sheet/engine'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { GUEST_CELLS_MAX, GUEST_SPAN_MAX, guestMisfit, guestWalk, type Box, type GuestSheet } from './guest'
import { AUTO_ROWS_MAX, CELL_TEXT_MAX, FORMULA_MAX, GUEST_SEND_MAX, guestCells, plainFormula, refusal, STRUCTURAL_MAX } from './live'

/**
 * A guest's batch against the sheet as it stands (guest.ts): what an op made by hand could write
 * into the owner's sheet that the guest's own page never sends.
 */
const S = 'sheet1'
const at = (id: string, params: Record<string, unknown>): SheetMutationJson => ({ id, params: { unitId: 'workbook', subUnitId: S, ...params } })
const box = (startRow: number, endRow: number, startColumn: number, endColumn: number) => ({ startRow, endRow, startColumn, endColumn })
const sheet = (over: Partial<GuestSheet> = {}): GuestSheet => ({ rows: 1000, columns: 26, merges: [], ...over })
const misfit = (ops: SheetMutationJson[], held: GuestSheet = sheet()) => guestMisfit(ops, (id) => (id === S ? held : null))
const PAST = 'that range runs past the end of the sheet'
const byPlace = (a: Box, b: Box): number => a.startRow - b.startRow || a.startColumn - b.startColumn || a.endRow - b.endRow || a.endColumn - b.endColumn
const insertRows = (startRow: number, count: number) => at('sheet.mutation.insert-row', { range: box(startRow, startRow + count - 1, 0, 25) })
const insertCols = (startColumn: number, count: number) => at('sheet.mutation.insert-col', { range: box(0, 999, startColumn, startColumn + count - 1) })
const removeRows = (startRow: number, count: number) => at('sheet.mutation.remove-rows', { range: box(startRow, startRow + count - 1, 0, 25) })
const merge = (...ranges: ReturnType<typeof box>[]) => at('sheet.mutation.add-worksheet-merge', { ranges })
const height = (...ranges: ReturnType<typeof box>[]) => at('sheet.mutation.set-worksheet-row-height', { ranges, rowHeight: 40 })
const numfmt = (...ranges: ReturnType<typeof box>[]) => at('sheet.mutation.set.numfmt', { values: { x: { ranges } }, refMap: { x: { pattern: '0.00' } } })

describe("a guest's batch, held to the sheet", () => {
  it('passes what the page sends: cells, a format, a size and a merge on the sheet', () => {
    expect(misfit([at('sheet.mutation.set-range-values', { cellValue: { 999: { 25: { v: 1 } } } }), numfmt(box(0, 999, 0, 0)), height(box(0, 999, 0, 0)), merge(box(0, 1, 0, 1)), at('sheet.mutation.set-worksheet-row-auto-height', { rowsAutoHeightInfo: [{ row: 999, autoHeight: 30 }] })])).toBeNull()
  })

  it('refuses a sheet it does not know', () => {
    expect(guestMisfit([at('sheet.mutation.set-range-values', { cellValue: {} })], () => null)).toBe('that sheet is not in the workbook')
  })

  it('refuses a cell, a format, a size or a fitted height past the end of the sheet', () => {
    expect(misfit([at('sheet.mutation.set-range-values', { cellValue: { 1000: { 0: { v: 1 } } } })])).toBe(PAST)
    expect(misfit([at('sheet.mutation.set-range-values', { cellValue: { 0: { 26: { v: 1 } } } })])).toBe(PAST)
    // one number format over the whole grid would write seventeen billion cells
    expect(misfit([numfmt(box(0, 1_048_575, 0, 16_383))])).toBe(PAST)
    expect(misfit([numfmt(box(0, 999, 0, 99))])).toBe(PAST)
    expect(misfit([at('sheet.mutation.remove.numfmt', { ranges: [box(0, 1000, 0, 0)] })])).toBe(PAST)
    expect(misfit([height(box(0, 1_048_575, 0, 0))])).toBe(PAST)
    expect(misfit([at('sheet.mutation.set-worksheet-col-width', { ranges: [box(0, 0, 0, 26)], colWidth: 40 })])).toBe(PAST)
    expect(misfit([at('sheet.mutation.set-worksheet-row-is-auto-height', { ranges: [box(0, 1000, 0, 0)], autoHeightInfo: 1 })])).toBe(PAST)
    // rows that are not there are not made
    expect(misfit([at('sheet.mutation.set-worksheet-row-auto-height', { rowsAutoHeightInfo: [{ row: 900_000, autoHeight: 2000 }] })])).toBe(PAST)
  })

  it('caps what one op covers on a large sheet', () => {
    const large = sheet({ rows: 500_000, columns: 100 })
    expect(misfit([height(box(0, GUEST_SPAN_MAX - 1, 0, 0))], large)).toBeNull()
    expect(misfit([height(box(0, GUEST_SPAN_MAX, 0, 0))], large)).toContain('rows or columns are sized at once')
    expect(misfit([height(box(0, 5999, 0, 0), box(6000, 11_999, 0, 0))], large)).toContain('sized at once')
    expect(misfit([numfmt(box(0, 1999, 0, 99))], large)).toBeNull()
    expect(misfit([numfmt(box(0, 2000, 0, 99))], large)).toBe(`a number format is laid on at most ${GUEST_CELLS_MAX.toLocaleString('en')} cells at once`)
    expect(misfit([merge(box(0, 2000, 0, 99))], large)).toContain('a merge covers at most')
    expect(misfit([at('sheet.mutation.set-worksheet-row-auto-height', { rowsAutoHeightInfo: Array.from({ length: AUTO_ROWS_MAX + 1 }, (_, row) => ({ row, autoHeight: 30 })) })], large)).toContain('rows are sized at once')
  })

  it('lets one send grow the sheet by a thousand rows or columns in all, and never past what a sheet holds', () => {
    expect(misfit([insertRows(10, STRUCTURAL_MAX)])).toBeNull()
    expect(misfit([insertRows(10, 600), insertRows(10, 401)])).toBe(`insert at most ${STRUCTURAL_MAX} rows or columns at once`)
    expect(misfit([insertRows(10, 600), insertCols(2, 401)])).toContain('insert at most')
    // a hundred inserts of a thousand rows each pass the route's own check, one op at a time
    const many = Array.from({ length: 100 }, () => insertRows(0, STRUCTURAL_MAX))
    expect(refusal(many, 'edit', true)).toBeNull()
    expect(misfit(many)).toContain('insert at most')
    expect(misfit([insertRows(0, 10)], sheet({ rows: 1_048_570 }))).toBe('a sheet has at most 1,048,576 rows and 16,384 columns')
    expect(misfit([insertCols(0, 10)], sheet({ columns: 16_380 }))).toContain('a sheet has at most')
    expect(misfit([insertRows(1001, 1)])).toBe(PAST)
    expect(misfit([removeRows(995, 10)])).toBe(PAST)
  })

  it('reads each op against the sheet as the ops before it in the batch leave it', () => {
    // rows added, then a height and a cell in the new rows: one press on the page
    expect(misfit([insertRows(1000, 5), height(box(1000, 1004, 0, 0)), at('sheet.mutation.set-range-values', { cellValue: { 1004: { 0: { v: 1 } } } })])).toBeNull()
    expect(misfit([insertRows(1000, 5), height(box(1000, 1005, 0, 0))])).toBe(PAST)
    // rows deleted, then a cell where the sheet no longer reaches
    expect(misfit([removeRows(0, 10), at('sheet.mutation.set-range-values', { cellValue: { 990: { 0: { v: 1 } } } })])).toBe(PAST)
    expect(misfit([at('sheet.mutation.remove-col', { range: box(0, 999, 0, 0) }), at('sheet.mutation.set-worksheet-col-width', { ranges: [box(0, 0, 25, 25)], colWidth: 40 })])).toBe(PAST)
  })

  it('follows merges through the batch as the engine does: one made, parted, or moved by rows above it', () => {
    const held = sheet({ merges: [box(4, 5, 0, 1)] })
    const part = (...ranges: ReturnType<typeof box>[]) => at('sheet.mutation.remove-worksheet-merge', { ranges })
    expect(misfit([merge(box(5, 6, 1, 2))], held)).toBe('those cells overlap a merged cell')
    expect(misfit([merge(box(6, 7, 0, 1), box(7, 8, 1, 2))], held)).toBe('those cells overlap a merged cell')
    expect(misfit([part(box(4, 5, 0, 1)), merge(box(4, 6, 0, 2))], held)).toBeNull()
    // two rows inserted above it: the merge is at rows 6 to 7 now
    expect(misfit([insertRows(0, 2), merge(box(4, 5, 0, 1))], held)).toBeNull()
    expect(misfit([insertRows(0, 2), merge(box(7, 8, 0, 0))], held)).toBe('those cells overlap a merged cell')
    // rows deleted above it: it moves up
    expect(misfit([removeRows(0, 2), merge(box(4, 5, 0, 1))], held)).toBeNull()
    expect(misfit([removeRows(0, 2), merge(box(3, 3, 0, 0))], held)).toBe('those cells overlap a merged cell')
    // a row inserted through it leaves it as it was; the grid's own insert then parts it and makes it one row taller
    expect(misfit([insertRows(5, 1), part(box(4, 5, 0, 1)), merge(box(4, 6, 0, 1))], held)).toBeNull()
    expect(misfit([insertRows(5, 1), merge(box(5, 6, 0, 0))], held)).toBe('those cells overlap a merged cell')
    // its rows deleted: the grid's own delete parts it, and the cells are free again
    expect(misfit([removeRows(4, 2), part(box(4, 5, 0, 1)), merge(box(4, 5, 0, 1))], held)).toBeNull()
    // the caller's own list is not changed
    expect(held.merges).toEqual([box(4, 5, 0, 1)])
  })

  it('names a cell by a row and a column that are indexes', () => {
    for (const key of ['-1', '1.5', '-Infinity', '-0', '01', '', '0x10', '1e1', ' 5', '__proto__'])
      expect(misfit([at('sheet.mutation.set-range-values', { cellValue: { [key]: { 0: { v: 1 } } } })]), key).toBe(PAST)
    expect(misfit([at('sheet.mutation.set-range-values', { cellValue: { 0: { '-1': { v: 1 } } } })])).toBe(PAST)
  })
})

/**
 * The same walk against the real engine: Univer's own insert and delete, as the guest's page sends
 * them, pass; and after any batch of raw inserts and deletes the walk's rows, columns and merges are
 * the engine's.
 */
describe("a guest's batch against the engine's own result", () => {
  const MERGES = [box(2, 4, 1, 2), box(7, 8, 0, 0)]
  const engine = () => {
    const grid = headlessSheet('work', { id: 'wb', sheetOrder: [S], sheets: { [S]: { id: S, name: 'D', rowCount: 10, columnCount: 8, mergeData: MERGES.map((m) => ({ ...m })), cellData: { 0: { 0: { v: 1 } } } } } })
    grid.univer.__getInjector().get(IUniverInstanceService).focusUnit('wb')
    const sheetNow = () => grid.workbook.getSheetBySheetId(S)!.getSheet()
    const held = (): GuestSheet => ({ rows: sheetNow().getRowCount(), columns: sheetNow().getColumnCount(), merges: sheetNow().getMergeData().map((m) => box(m.startRow, m.endRow, m.startColumn, m.endColumn)) })
    return { grid, held }
  }

  it.each([
    ['sheet.command.insert-row', box(3, 3, 0, 7)],
    ['sheet.command.insert-row', box(1, 1, 0, 7)],
    ['sheet.command.remove-row', box(3, 3, 0, 7)],
    ['sheet.command.remove-row', box(2, 4, 0, 7)],
    ['sheet.command.remove-row', box(0, 0, 0, 7)]
  ])("the grid's own %s at %j passes, merges and all", async (id, range) => {
    const { grid, held } = engine()
    try {
      const before = held()
      const sent: SheetMutationJson[] = []
      grid.api.addEvent(grid.api.Event.CommandExecuted, (e) => {
        if (e.type === 2 && e.id.startsWith('sheet.mutation.')) sent.push({ id: e.id, params: e.params })
      })
      await grid.api.executeCommand(id, { unitId: 'wb', subUnitId: S, range, direction: 'down', cellValue: {} })
      expect(sent.length).toBeGreaterThan(0)
      const walked = guestWalk(guestCells(sent), () => before)
      expect(walked.why).toBeNull()
      const after = held()
      expect({ ...walked.sheets.get(S)!, merges: [...walked.sheets.get(S)!.merges].sort(byPlace) }).toEqual({ ...after, merges: [...after.merges].sort(byPlace) })
    } finally {
      grid.dispose()
    }
  })

  it('after raw inserts and deletes, the rows, columns and merges it follows are the engine\'s', () => {
    let seed = 7
    const random = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
    for (let round = 0; round < 40; round++) {
      const { grid, held } = engine()
      try {
        const before = held()
        const batch: SheetMutationJson[] = []
        let rows = before.rows
        let columns = before.columns
        for (let i = 0; i < 4; i++) {
          const kind = random(4)
          if (kind === 0) {
            const startRow = random(rows + 1)
            const count = 1 + random(2)
            batch.push(at('sheet.mutation.insert-row', { unitId: 'wb', range: box(startRow, startRow + count - 1, 0, columns - 1) }))
            rows += count
          } else if (kind === 1 && rows > 3) {
            const startRow = random(rows - 2)
            const count = 1 + random(2)
            batch.push(at('sheet.mutation.remove-rows', { unitId: 'wb', range: box(startRow, startRow + count - 1, 0, columns - 1) }))
            rows -= count
          } else if (kind === 2) {
            const startColumn = random(columns + 1)
            batch.push(at('sheet.mutation.insert-col', { unitId: 'wb', range: box(0, rows - 1, startColumn, startColumn) }))
            columns += 1
          } else if (columns > 3) {
            const startColumn = random(columns - 1)
            batch.push(at('sheet.mutation.remove-col', { unitId: 'wb', range: box(0, rows - 1, startColumn, startColumn) }))
            columns -= 1
          }
        }
        const walked = guestWalk(batch, () => before)
        expect(walked.why, JSON.stringify(batch)).toBeNull()
        for (const m of batch) grid.api.syncExecuteCommand(m.id, m.params as object, { fromCollab: true })
        const after = held()
        const mine = walked.sheets.get(S) ?? before
        expect({ ...mine, merges: [...mine.merges].sort(byPlace) }, JSON.stringify(batch)).toEqual({ ...after, merges: [...after.merges].sort(byPlace) })
      } finally {
        grid.dispose()
      }
    }
  }, 60_000)
})

describe("the route's shape check for a guest's formats", () => {
  const guest = (m: SheetMutationJson) => refusal([m], 'edit', true)
  it('a number format names ranges on the grid; a fitted height names rows', () => {
    expect(guest(numfmt(box(0, 9, 0, 0)))).toBeNull()
    expect(guest(at('sheet.mutation.set.numfmt', { values: { x: { ranges: 'all' } }, refMap: {} }))).toContain('a number format names at most')
    expect(guest(at('sheet.mutation.set.numfmt', { refMap: {} }))).toContain('a number format names at most')
    expect(guest(at('sheet.mutation.remove.numfmt', { ranges: [box(0, 9, 0, 0)] }))).toBeNull()
    expect(guest(at('sheet.mutation.remove.numfmt', { ranges: [{ startRow: -1, endRow: 2, startColumn: 0, endColumn: 0 }] }))).not.toBeNull()
    expect(guest(at('sheet.mutation.set-worksheet-row-is-auto-height', { ranges: [box(0, 9, 0, 0)], autoHeightInfo: 1 }))).toBeNull()
    expect(guest(at('sheet.mutation.set-worksheet-row-is-auto-height', { ranges: [] }))).not.toBeNull()
    expect(guest(at('sheet.mutation.set-worksheet-row-auto-height', { rowsAutoHeightInfo: [{ row: 3, autoHeight: 30 }] }))).toBeNull()
    expect(guest(at('sheet.mutation.set-worksheet-row-auto-height', { rowsAutoHeightInfo: [{ row: 'x' }] }))).toContain('rows are sized at once')
    expect(guest(at('sheet.mutation.set-worksheet-row-auto-height', { rowsAutoHeightInfo: Array.from({ length: AUTO_ROWS_MAX + 1 }, (_, row) => ({ row })) }))).toContain('rows are sized at once')
  })
})

describe("a guest's cells, as the route takes them", () => {
  const cells = (cellValue: unknown) => at('sheet.mutation.set-range-values', { cellValue })
  const guest = (m: SheetMutationJson) => refusal([m], 'edit', true)

  it('refuses a key that is no index, a value or a formula longer than Excel takes, and a send over 2 MiB', () => {
    expect(guest(cells({ 3: { 2: { v: 'x'.repeat(CELL_TEXT_MAX), f: '=' + '1+'.repeat(100) + '1', s: { bl: 1 }, t: 2 } } }))).toBeNull()
    for (const key of ['-1', '1.5', '01', '', '1e1', '__proto__']) expect(guest(cells(JSON.parse(`{"${key}": {"0": {"v": 1}}}`))), key).toBe('a cell is named by its row and column')
    expect(guest(cells({ 0: { '-1': { v: 1 } } }))).toBe('a cell is named by its row and column')
    expect(guest(cells({ 0: { 0: { v: 'x'.repeat(CELL_TEXT_MAX + 1) } } }))).toBe('a cell holds at most 32,767 characters')
    expect(guest(cells({ 0: { 0: { v: { deep: 1 } } } }))).toBe('a cell holds at most 32,767 characters')
    expect(guest(cells({ 0: { 0: { f: '=' + '1+'.repeat(FORMULA_MAX / 2) + '1' } } }))).toBe('a formula is at most 8,192 characters')
    expect(guest(cells({ 0: { 0: { f: 7 } } }))).toBe('a cell is a value, a formula and a format')
    expect(guest(cells({ 0: { 0: { s: [1] } } }))).toBe('a cell is a value, a formula and a format')
    const heavy = cells(Object.fromEntries(Array.from({ length: 80 }, (_, r) => [r, { 0: { v: 'x'.repeat(30_000) } }])))
    expect(JSON.stringify([heavy]).length).toBeGreaterThan(GUEST_SEND_MAX)
    expect(guest(heavy)).toBe('a guest sends at most 2 MiB at once')
    // the owner's own page is held to the formula's length alone
    expect(refusal([cells({ 0: { 0: { f: '=' + '1+'.repeat(FORMULA_MAX / 2) + '1' } } })], 'edit', false)).toBe('a formula is at most 8,192 characters')
    expect(refusal([heavy], 'edit', false)).toBeNull()
  })

  it('keeps a style to the grid\'s own shape: short keys, numbers, flags and short strings', () => {
    const [cut] = guestCells([cells({ 0: { 0: { v: 1, s: { bl: 1, ff: 'Arial', cl: { rgb: '#C00000' }, bd: { t: { s: 1, cl: { rgb: '#000' } } }, n: { pattern: '0.00' }, junk: 'x'.repeat(100_000), 'a key that is long': 1, deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } } }, 1: { s: 'x'.repeat(65) }, 2: { s: 'style-1' }, 3: { v: 2, s: null } } })])
    const row = (cut!.params as { cellValue: Record<string, Record<string, { s?: unknown; v?: unknown }>> }).cellValue[0]!
    expect(row[0]).toEqual({ v: 1, s: { bl: 1, ff: 'Arial', cl: { rgb: '#C00000' }, bd: { t: { s: 1, cl: { rgb: '#000' } } }, n: { pattern: '0.00' }, deep: { a: { b: { c: {} } } } } })
    expect(row[1]).toEqual({})
    expect(row[2]).toEqual({ s: 'style-1' })
    // a number no style holds is dropped
    const [big] = guestCells([cells({ 0: { 0: { s: { fs: 1e300, bl: 1 } } } })])
    expect((big!.params as { cellValue: Record<string, Record<string, { s?: unknown }>> }).cellValue[0]![0]!.s).toEqual({ bl: 1 })
    expect(row[3]).toEqual({ v: 2, s: null })
    // a key from JSON never becomes the object's prototype
    const [proto] = guestCells([cells(JSON.parse('{"0": {"0": {"v": 1, "s": {"__proto__": {"bl": 1}, "it": 1}}}, "__proto__": {"5": {"v": 9}}}'))])
    const kept = (proto!.params as { cellValue: Record<string, Record<string, { s?: object }>> }).cellValue
    expect(Object.keys(kept)).toEqual(['0'])
    expect(kept[0]![0]!.s).toEqual({ it: 1 })
    expect(Object.getPrototypeOf(kept[0]![0]!.s)).toBe(Object.prototype)
  })

  it('reads a formula in plain names: the prefixes an Excel file gives newer functions are dropped, quoted text is kept', () => {
    expect(plainFormula('=_xlfn.MAP({1,2},_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2))')).toBe('=MAP({1,2},LAMBDA(x,x*2))')
    expect(plainFormula('=_xlfn._xlws.FILTER(A1:A9,B1:B9="_xlfn.kept ""as"" is")')).toBe('=FILTER(A1:A9,B1:B9="_xlfn.kept ""as"" is")')
    expect(plainFormula('=SUM(A1:A9)')).toBe('=SUM(A1:A9)')
    expect(plainFormula('=_xludf.MYFN(1)')).toBe('=MYFN(1)')
    const [cut] = guestCells([cells({ 0: { 0: { f: '=_xlfn.XLOOKUP(1,A:A,B:B)' } } })])
    expect((cut!.params as { cellValue: Record<string, Record<string, { f?: string }>> }).cellValue[0]![0]!.f).toBe('=XLOOKUP(1,A:A,B:B)')
  })

  it('an inserted row or column carries its size and nothing else: not hidden, no other key', () => {
    const [rows, cols] = guestCells([
      at('sheet.mutation.insert-row', { unitId: 'wb', range: box(2, 3, 0, 7), rowInfo: { 0: { hd: 1, h: 30, junk: 'x'.repeat(1000) }, 1: { hd: 1 }, '-1': { h: 20 } }, extra: 'dropped' }),
      at('sheet.mutation.insert-col', { unitId: 'wb', range: box(0, 9, 1, 1), colInfo: { 0: { hd: 1, w: 0, junk: 'y' }, 1: { w: 99_999 } } })
    ])
    expect(rows!.params).toEqual({ unitId: 'wb', subUnitId: S, range: box(2, 3, 0, 7), rowInfo: { 0: { h: 30 } } })
    expect(cols!.params).toEqual({ unitId: 'wb', subUnitId: S, range: box(0, 9, 1, 1), colInfo: { 0: { w: 0 } } })
    expect(guestCells([insertRows(0, 1)])[0]!.params).toEqual({ unitId: 'workbook', subUnitId: S, range: box(0, 0, 0, 25) })
  })
})
