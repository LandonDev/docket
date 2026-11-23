import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { conditionalOf, cornerOnly, endOnly, moveFacts, moveRefusal, moveRefusalWords, readsIn, ruleReads } from './moves'
import { NotSaved } from './mutations'
import { readZip } from './patch/zip'
import { refuseMove, type StructuralOp } from './structural'

/**
 * The host's check of a move on an opened Excel file, before LibreOffice runs: what it reads from
 * the file, and which moves it refuses (each refusal was found by running the move through
 * LibreOffice: structural.test.ts holds the moves it lets through).
 */
const CORPUS = join(__dirname, 'harness/corpus')
/** conditional.xlsx's first sheet: ten formats in the sheet's own list; the extended list holds only the second half of its data bar */
const CONDITIONAL_FORMATS = 10
const facts = (file: string) => moveFacts(readZip(new Uint8Array(readFileSync(join(CORPUS, file)))))
const box = (r1: number, c1: number, r2: number, c2: number) => ({ r1, c1, r2, c2 })
const block = (r1: number, c1: number, r2: number, c2: number, row: number, col: number, to = 'Data'): StructuralOp => ({ op: 'moveRange', sheet: 'Data', r1, c1, r2, c2, to, row, col })
const rows = (at: number, count: number, to: number): StructuralOp => ({ op: 'moveRows', sheet: 'Data', at, count, to })
const cols = (at: number, count: number, to: number): StructuralOp => ({ op: 'moveCols', sheet: 'Data', at, count, to })

describe("what the move check reads from a file", () => {
  it('reads tables, merges, arrays and spills, the filter, protection and pivots, zero-based', () => {
    expect(facts('moves/tables.xlsx').sheets.get('Data')!.tables).toEqual([box(0, 0, 3, 1)])
    expect(facts('moves/rules.xlsx').sheets.get('Data')!.merges).toEqual([box(0, 5, 0, 6), box(1, 8, 1, 9)])
    expect(facts('moves/arrays.xlsx').sheets.get('Data')!.arrays).toEqual([
      { box: box(0, 2, 2, 2), dynamic: false },
      { box: box(0, 4, 2, 4), dynamic: true }
    ])
    // where each conditional format applies: A1:B3, C1:C10, N5:P7, and the two that overlap on R21:R23
    expect(facts('moves/rules.xlsx').sheets.get('Data')!.conditional).toEqual([[box(0, 0, 2, 1)], [box(0, 2, 9, 2)], [box(4, 13, 6, 15)], [box(20, 17, 22, 18)], [box(20, 17, 29, 17)]])
    expect(facts('conditional.xlsx').sheets.get('Rules')!.conditional.length).toBe(CONDITIONAL_FORMATS)
    // how much of the sheet is in use: here, to its last row and its last column
    expect(facts('moves/full.xlsx').sheets.get('Data')!.used).toEqual({ rows: 1_048_576, cols: 16_384 })
    expect(facts('moves/tables.xlsx').sheets.get('Data')!.used).toEqual({ rows: 8, cols: 6 })
    const layout = facts('moves/layout.xlsx')
    expect(layout.sheets.get('Data')).toMatchObject({ filter: box(0, 0, 9, 2), protected: false })
    expect(layout.sheets.get('Locked')!.protected).toBe(true)
    const pivot = facts('pivot.xlsx')
    // (its page field and the blank row under it, above A6:G12, are the pivot's too)
    expect(pivot.sheets.get('Pivot')!.pivots).toEqual([box(3, 0, 11, 6)])
    expect(pivot.pivotSources).toEqual([{ sheet: 'Data', box: box(0, 0, 120, 4) }])
  })
})

describe("where a sheet's conditional formats apply", () => {
  const bar = '<cfRule type="dataBar" priority="1"><dataBar/><extLst><ext><x14:id>{BAR}</x14:id></ext></extLst></cfRule>'
  const ext = (id: string, sqref: string) => `<x14:conditionalFormatting><x14:cfRule type="dataBar" id="${id}"/><xm:sqref>${sqref}</xm:sqref></x14:conditionalFormatting>`
  it('reads the sheet’s own list, each format with all its ranges', () => {
    expect(conditionalOf('<conditionalFormatting sqref="A1:B3 $D$5"><cfRule type="cellIs" priority="1"/></conditionalFormatting>')).toEqual([[box(0, 0, 2, 1), box(4, 3, 4, 3)]])
  })
  it('counts a data bar once, though Excel writes its second half in the extended list; a format only that list holds is its own', () => {
    const xml = `<conditionalFormatting sqref="B2:B9">${bar}</conditionalFormatting><extLst><ext><x14:conditionalFormattings>${ext('{BAR}', 'B2:B9')}${ext('{ICONS}', 'D2:D9')}</x14:conditionalFormattings></ext></extLst>`
    expect(conditionalOf(xml)).toEqual([[box(1, 1, 8, 1)], [box(1, 3, 8, 3)]])
  })
})

describe('what reads cells', () => {
  const shared = { at: { sheet: 'Data', row: 1, col: 2 }, i1: 0, i2: 98, j1: 0, j2: 0 }
  it('a formula’s references: its own sheet’s and another’s, a whole column, and none inside quoted text', () => {
    const got = readsIn(`IF(Calc!$B$2="A1",'My Data'!C3:D4,SUM(A:A)+E$5)`, 'Data')
    expect(got.map((r) => [r.sheet, r.r1, r.c1, r.r2, r.c2])).toEqual([
      ['Calc', 1, 1, 1, 1],
      ['My Data', 2, 2, 3, 3],
      ['Data', 0, 0, 1_048_575, 0],
      ['Data', 4, 4, 4, 4]
    ])
    expect(got[0]).toMatchObject({ relR1: false, relC1: false })
    expect(got[2]).toMatchObject({ allRows: true, allCols: false })
    expect(got[3]).toMatchObject({ relR1: false, relC1: true })
    // another workbook's cells are not this file's
    expect(readsIn('[1]Prices!A1+1', 'Data')).toEqual([])
  })

  it('a block holds a corner of a range without all of it, or it does not', () => {
    const [sum] = readsIn('SUM(A4:A6)', 'Data')
    expect(cornerOnly(sum, box(3, 0, 4, 0))).toBe(true)
    expect(cornerOnly(sum, box(5, 0, 5, 3))).toBe(true)
    expect(cornerOnly(sum, box(4, 0, 4, 0))).toBe(false)
    expect(cornerOnly(sum, box(3, 0, 5, 0))).toBe(false)
    expect(cornerOnly(sum, box(0, 0, 2, 5))).toBe(false)
    // a whole column has no end to take
    expect(cornerOnly(readsIn('SUM(A:A)', 'Data')[0], box(0, 0, 2, 0))).toBe(false)
  })

  it('a filled formula is read cell by cell: each of its cells reads its own', () => {
    // =A2*2 filled down C2:C100: every cell reads one cell, taken whole or not at all
    const [each] = readsIn('A2*2', 'Data', shared)
    expect(cornerOnly(each, box(1, 0, 49, 0))).toBe(false)
    // a running total, =SUM($A$2:A2) filled down: the block A6:A7 is the end of the range C6 reads
    const [running] = readsIn('SUM($A$2:A2)', 'Data', shared)
    expect(cornerOnly(running, box(5, 0, 6, 0))).toBe(true)
    expect(cornerOnly(running, box(200, 0, 201, 0))).toBe(false)
    expect(endOnly(running, true, 5, 1, 300)).toBe(true)
  })

  it('rows that hold an end of a range may move to a place inside it, and nowhere else', () => {
    const [sum] = readsIn('SUM(A4:A6)', 'Data')
    // the last row of A4:A6, to before its second row and its third: the range covers the same rows after
    expect(endOnly(sum, true, 5, 1, 4)).toBe(false)
    // to before its first row, or out of it
    expect(endOnly(sum, true, 5, 1, 3)).toBe(true)
    expect(endOnly(sum, true, 5, 1, 0)).toBe(true)
    // its first row, to before its last, and to after its last
    expect(endOnly(sum, true, 3, 1, 5)).toBe(false)
    expect(endOnly(sum, true, 3, 1, 6)).toBe(true)
    // a middle row, anywhere; the whole range; rows that only pass it; rows that straddle its end
    expect(endOnly(sum, true, 4, 1, 20)).toBe(false)
    expect(endOnly(sum, true, 3, 3, 0)).toBe(false)
    expect(endOnly(sum, true, 8, 1, 0)).toBe(false)
    expect(endOnly(sum, true, 5, 2, 4)).toBe(true)
    // columns: the range lies in one column, taken whole
    expect(endOnly(sum, false, 0, 1, 5)).toBe(false)
    expect(endOnly(readsIn('SUM(3:5)', 'Data')[0], false, 0, 1, 5)).toBe(false)
  })

  it('a rule’s formulas: a conditional format’s, a validation’s, a data bar’s end, and the extended ones', () => {
    const x14 =
      '<x14:dataValidations><x14:dataValidation type="whole" allowBlank="1"/>' +
      '<x14:dataValidation type="list"><x14:formula1><xm:f>Lists!$A$1:$A$9</xm:f></x14:formula1><xm:sqref>C2:C9 E2</xm:sqref></x14:dataValidation></x14:dataValidations>'
    expect(ruleReads(x14, 'Data')).toEqual([expect.objectContaining({ sheet: 'Lists', r1: 0, c1: 0, r2: 8, c2: 0, at: { sheet: 'Data', row: 1, col: 2 }, i1: 0, i2: 7, j1: 0, j2: 2 })])
    const sheet = facts('moves/reads.xlsx')
    expect(moveRefusal(sheet, block(0, 11, 0, 11, 9, 11))).toBeNull()
    expect(sheet.reads!.rules.map((r) => [r.r1, r.c1, r.r2, r.c2])).toEqual([
      [0, 7, 0, 7],
      [0, 4, 0, 4],
      [0, 9, 0, 9],
      [2, 7, 6, 7],
      [0, 9, 0, 9]
    ])
  })
})

describe('which moves are refused, in the words the canvas says', () => {
  it('says the reason after "Move this in Excel"', () => {
    expect(moveRefusalWords('table')).toBe('Move this in Excel: it crosses a table')
    expect(moveRefusalWords('part')).toBe('Move this in Excel: a formula reads part of it')
    expect(moveRefusalWords('full')).toBe('Move this in Excel: the sheet is full')
    expect(moveRefusalWords('large')).toBe('Move this in Excel: it is too large')
    expect(moveRefusalWords('chart')).toBe("Move this in Excel: a chart's legend would change")
  })

  it('a range something reads moves whole or from its middle, never by an end alone', () => {
    const f = facts('moves/refs.xlsx')
    // A4:A6 is read by D3, by the name Part and from the sheet Calc
    expect(moveRefusal(f, block(3, 0, 4, 0, 3, 9))).toBe('part')
    expect(moveRefusal(f, block(5, 0, 5, 0, 3, 9))).toBe('part')
    expect(moveRefusal(f, block(4, 0, 4, 0, 1, 7))).toBeNull()
    expect(moveRefusal(f, block(3, 0, 5, 0, 3, 9))).toBeNull()
    expect(moveRefusal(f, rows(4, 2, 0))).toBe('part')
    expect(moveRefusal(f, rows(3, 3, 0))).toBeNull()
    expect(moveRefusal(f, rows(5, 1, 4))).toBeNull()
    expect(moveRefusal(f, rows(5, 1, 3))).toBe('part')
    // column A alone is an end of A1:B3, which D2 and the name Block read; A:B is all of it
    expect(moveRefusal(f, cols(0, 1, 5))).toBe('part')
    expect(moveRefusal(f, cols(0, 2, 5))).toBeNull()
  })

  it('a rule’s formula counts as a reader: its range is not taken by an end, and nothing lands where it reads', () => {
    const f = facts('moves/reads.xlsx')
    // the validation's list H3:H7
    expect(moveRefusal(f, block(2, 7, 3, 7, 9, 11))).toBe('part')
    expect(moveRefusal(f, block(3, 7, 4, 7, 9, 11))).toBeNull()
    expect(moveRefusal(f, block(2, 7, 6, 7, 9, 11))).toBeNull()
    // L1 dropped on H1 (a conditional format's formula reads it), on H4 (the list) and on J1 (a data bar's lowest value)
    expect(moveRefusal(f, block(0, 11, 0, 11, 0, 7))).toBe('lands')
    expect(moveRefusal(f, block(0, 11, 0, 11, 3, 7))).toBe('lands')
    expect(moveRefusal(f, block(0, 11, 0, 11, 0, 9))).toBe('lands')
    // on E3, whose own format reads E3 alone: the cell takes the block's rules and its own goes with it
    expect(moveRefusal(f, block(0, 11, 0, 11, 2, 4))).toBeNull()
    expect(moveRefusal(f, block(0, 11, 0, 11, 0, 12))).toBeNull()
  })

  it('rows and columns are not moved on a sheet whose last ones are in use', () => {
    const f = facts('moves/full.xlsx')
    expect(moveRefusal(f, rows(0, 1, 2))).toBe('full')
    expect(moveRefusal(f, cols(0, 1, 2))).toBe('full')
    // a block needs no room
    expect(moveRefusal(f, block(0, 0, 2, 0, 0, 3))).toBeNull()
  })

  it('a block of more cells than the landing check counts is refused for its size, not for what reads it', () => {
    expect(moveRefusal(facts('moves/refs.xlsx'), block(20, 20, 220, 120, 300, 20))).toBe('large')
  })

  it('a move that takes the cells of a chart series named by typed text, where two charts read the same ranges', () => {
    // names.xlsx: two charts over A2:A5 and B2:B5, one series named "Budget" (typed), the other from H1
    const f = facts('moves/names.xlsx')
    expect(moveRefusal(f, rows(1, 4, 20))).toBe('chart')
    expect(moveRefusal(f, block(1, 0, 4, 1, 1, 9))).toBe('chart')
    // what moves is not the chart's: LibreOffice leaves the name as it is
    expect(moveRefusal(f, block(0, 7, 0, 7, 9, 11))).toBeNull()
    expect(moveRefusal(f, rows(10, 1, 20))).toBeNull()
    // one chart alone (refs.xlsx): its typed name is put back after the move
    expect(moveRefusal(facts('moves/refs.xlsx'), block(0, 0, 2, 1, 4, 5))).toBeNull()
  })

  it('a table moves only whole: part of it, or a block landing on it, or rows taken out of it, is refused', () => {
    const f = facts('moves/tables.xlsx')
    expect(moveRefusal(f, block(0, 0, 3, 1, 0, 7))).toBeNull()
    expect(moveRefusal(f, block(1, 0, 2, 1, 9, 7))).toBe('table')
    expect(moveRefusal(f, block(0, 5, 0, 5, 2, 1))).toBe('table')
    expect(moveRefusal(f, block(0, 5, 2, 5, 0, 9))).toBeNull()
    expect(moveRefusal(f, rows(1, 2, 9))).toBe('table')
    expect(moveRefusal(f, rows(0, 4, 9))).toBeNull()
    // a row moved from below to above it shifts it whole
    expect(moveRefusal(f, rows(6, 1, 0))).toBeNull()
    // a row put inside it grows it
    expect(moveRefusal(f, rows(6, 1, 2))).toBe('table')
  })

  it('a merged cell moves only whole', () => {
    const f = facts('moves/rules.xlsx')
    expect(moveRefusal(f, block(0, 5, 2, 6, 19, 9))).toBeNull()
    expect(moveRefusal(f, block(0, 8, 2, 8, 14, 11))).toBe('merge')
    expect(moveRefusal(f, cols(5, 1, 12))).toBe('merge')
    expect(moveRefusal(f, rows(1, 1, 12))).toBeNull()
  })

  it('an array formula moves only whole, and so does a spill', () => {
    const f = facts('moves/arrays.xlsx')
    expect(moveRefusal(f, block(0, 2, 2, 2, 0, 9))).toBeNull()
    expect(moveRefusal(f, block(0, 2, 1, 2, 0, 9))).toBe('array')
    expect(moveRefusal(f, block(0, 4, 2, 4, 4, 9))).toBeNull()
    expect(moveRefusal(f, block(0, 4, 0, 4, 4, 9))).toBe('spill')
    expect(moveRefusal(f, rows(0, 1, 6))).toBe('array')
    // a shared formula's group, whole or in part, and an array's own input: LibreOffice moves each as Excel does
    expect(moveRefusal(f, block(1, 6, 1, 6, 9, 9))).toBeNull()
    expect(moveRefusal(f, block(0, 0, 2, 0, 9, 11))).toBeNull()
  })

  it('a conditional format that shares cells with another is moved in part, never whole', () => {
    const f = facts('moves/rules.xlsx')
    // R21:S23 whole (R21:R30 shares R21:R23 with it): LibreOffice would make it again, at another place in the order
    expect(moveRefusal(f, block(20, 17, 22, 18, 20, 21))).toBe('rule')
    expect(moveRefusal(f, rows(20, 3, 40))).toBe('rule')
    expect(moveRefusalWords('rule')).toBe('Move this in Excel: its conditional formats overlap')
    // both whole: each would be made again
    expect(moveRefusal(f, block(20, 17, 29, 18, 20, 21))).toBe('rule')
    expect(moveRefusal(f, rows(20, 10, 40))).toBe('rule')
    expect(moveRefusal(f, cols(17, 2, 25))).toBe('rule')
    // both in part: each keeps its place
    expect(moveRefusal(f, block(20, 17, 21, 17, 20, 21))).toBeNull()
    expect(moveRefusal(f, rows(21, 1, 40))).toBeNull()
    // S alone: R21:S23 in part, R21:R30 not at all
    expect(moveRefusal(f, cols(18, 1, 25))).toBeNull()
    // a format moved whole that shares no cell with another (A1:B3, beside C1:C10)
    expect(moveRefusal(f, block(0, 0, 2, 2, 14, 9))).toBeNull()
    expect(moveRefusal(f, rows(0, 3, 12))).toBeNull()
  })

  it("the sheet's filter: rows among its own rows, or wholly outside it; no column or block that meets it", () => {
    const f = facts('moves/layout.xlsx')
    expect(moveRefusal(f, rows(2, 2, 8))).toBeNull()
    expect(moveRefusal(f, rows(0, 1, 5))).toBe('filter')
    expect(moveRefusal(f, rows(12, 1, 15))).toBeNull()
    expect(moveRefusal(f, rows(12, 1, 3))).toBe('filter')
    expect(moveRefusal(f, cols(2, 1, 0))).toBe('filter')
    expect(moveRefusal(f, cols(5, 1, 7))).toBeNull()
    expect(moveRefusal(f, block(2, 0, 3, 2, 14, 0))).toBe('filter')
  })

  it('a protected sheet, a pivot table and its source are left alone', () => {
    const layout = facts('moves/layout.xlsx')
    expect(moveRefusal(layout, { op: 'moveRange', sheet: 'Locked', r1: 0, c1: 0, r2: 1, c2: 0, to: 'Locked', row: 5, col: 0 })).toBe('protected')
    expect(moveRefusal(layout, { op: 'moveRange', sheet: 'Data', r1: 20, c1: 0, r2: 20, c2: 0, to: 'Locked', row: 5, col: 0 })).toBe('protected')
    const pivot = facts('pivot.xlsx')
    expect(moveRefusal(pivot, block(1, 0, 2, 4, 0, 10))).toBe('pivot')
    expect(moveRefusal(pivot, block(0, 6, 2, 6, 0, 10))).toBeNull()
    expect(moveRefusal(pivot, { op: 'moveRows', sheet: 'Pivot', at: 0, count: 1, to: 20 })).toBe('pivot')
  })

  it('a block lands only where no formula, name or chart reads', () => {
    const f = facts('moves/refs.xlsx')
    // F5:G7 is read by nothing; H1:I3 is read by D7 (=H1)
    expect(moveRefusal(f, block(0, 0, 2, 1, 4, 5))).toBeNull()
    expect(moveRefusal(f, block(0, 0, 2, 1, 0, 7))).toBe('lands')
    // H2 holds a value nothing reads: what stood there goes, as in Excel
    expect(moveRefusal(f, block(4, 0, 4, 0, 1, 7))).toBeNull()
    // over part of itself: its own cells move, and nothing else reads B4:C4
    expect(moveRefusal(f, block(0, 0, 2, 1, 1, 1))).toBeNull()
    // A4:A6 is read by the name Part and by D3
    expect(moveRefusal(f, block(9, 3, 9, 3, 3, 0))).toBe('lands')
    // to another sheet, where nothing reads
    expect(moveRefusal(f, block(0, 0, 2, 1, 4, 4, 'Calc'))).toBeNull()
    // the chart reads Data!B1:B3: a cell dropped on B2 lands where it reads
    expect(moveRefusal(f, block(9, 3, 9, 3, 1, 1))).toBe('lands')
  })
})

describe('the one call that refuses a move on a file (the converter, and the store before it asks for the job)', () => {
  const tables = join(CORPUS, 'moves/tables.xlsx')
  it('throws NotSaved in the canvas’s words for a move the file cannot take, and nothing for one it can', () => {
    expect(() => refuseMove(tables, [block(1, 0, 2, 1, 9, 7)])).toThrow(NotSaved)
    expect(() => refuseMove(tables, [block(1, 0, 2, 1, 9, 7)])).toThrow('Move this in Excel: it crosses a table')
    expect(() => refuseMove(tables, [block(0, 0, 3, 1, 0, 7)])).not.toThrow()
  })
  it('reads no file for ops that are not a move, and takes a move only alone', () => {
    expect(() => refuseMove(join(CORPUS, 'no-such-file.xlsx'), [{ op: 'insertRows', sheet: 'Data', at: 1, count: 1 }])).not.toThrow()
    expect(() => refuseMove(tables, [block(0, 0, 3, 1, 0, 7), rows(6, 1, 0)])).toThrow('a move comes alone')
  })
})
