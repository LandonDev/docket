import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { boxWithout, moveChartRef, offVacated, typedSeriesNames, vacatedBy, withTypedNames } from './graft'
import { NotSaved, SET_RANGE_VALUES } from './mutations'
import { ensurePackageTables, PackageStore } from './packages'
import { mapCell, mapRange, planOf, scriptRefusal, type StructuralOp } from './structural'
import { libreOffice, SOFFICE } from './testing'
import { localJobs } from './workerClient'

const CORPUS = join(__dirname, 'harness/corpus')
const office = existsSync(SOFFICE)
const scratch = mkdtempSync(join(tmpdir(), 'sheets-structural-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const range = (r1: number, r2: number, c1 = 0, c2 = 25) => ({
  startRow: r1,
  endRow: r2,
  startColumn: c1,
  endColumn: c2
})
const names = () =>
  new Map([
    ['sheet1', 'Data'],
    ['sheet2', 'Calc']
  ])

describe('planning a structural edit', () => {
  it("turns the grid's mutations into LibreOffice steps and patch-writer steps, in order, following names", () => {
    const n = names()
    const steps = planOf(
      [
        { id: 'sheet.mutation.insert-row', params: { subUnitId: 'sheet1', range: range(3, 4) } },
        { id: 'sheet.mutation.set-worksheet-row-height', params: { subUnitId: 'sheet1', ranges: [range(3, 4)], rowHeight: 28 } },
        {
          id: SET_RANGE_VALUES,
          params: { subUnitId: 'sheet1', cellValue: { 3: { 0: { v: 1 }, 1: { s: { bl: 1 } } } } }
        },
        {
          id: 'sheet.mutation.set-worksheet-name',
          params: { subUnitId: 'sheet2', name: 'Totals' }
        },
        {
          id: 'sheet.mutation.insert-sheet',
          params: {
            index: 2,
            sheet: { id: 'new1', name: 'Notes', cellData: { 0: { 0: { v: 'hi' } } } }
          }
        },
        {
          id: 'sheet.mutation.reorder-range',
          params: { subUnitId: 'sheet1', range: range(1, 3, 0, 2), order: { 1: 3, 2: 1, 3: 2 } }
        }
      ],
      n
    )
    expect(steps).toEqual([
      { kind: 'structural', ops: [{ op: 'insertRows', sheet: 'Data', at: 3, count: 2 }] },
      // the height the grid gave the new rows and the style it laid ride with the cells, each named by its tab: nothing he made in the batch is left out
      {
        kind: 'cells',
        edits: [{ sheet: 'Data', cell: 'A4', value: 1 }],
        formats: [
          { id: 'sheet.mutation.set-worksheet-row-height', params: { subUnitId: 'Data', ranges: [range(3, 4)], rowHeight: 28 } },
          { id: SET_RANGE_VALUES, params: { subUnitId: 'Data', cellValue: { 3: { 1: { s: { bl: 1 } } } } } }
        ]
      },
      {
        kind: 'structural',
        ops: [
          { op: 'renameSheet', sheet: 'Calc', to: 'Totals' },
          { op: 'addSheet', name: 'Notes', at: 2 }
        ]
      },
      { kind: 'cells', edits: [{ sheet: 'Notes', cell: 'A1', value: 'hi' }], formats: [] },
      {
        kind: 'structural',
        ops: [
          { op: 'reorder', sheet: 'Data', r1: 1, c1: 0, r2: 3, c2: 2, order: { 1: 3, 2: 1, 3: 2 } }
        ]
      }
    ])
    expect(n.get('sheet2')).toBe('Totals')
  })

  it('refuses what it cannot save, in words', () => {
    expect(() =>
      planOf([{ id: 'sheet.mutation.set-row-hidden', params: { subUnitId: 'sheet1' } }], names())
    ).toThrow(NotSaved)
    expect(() =>
      planOf(
        [
          {
            id: 'sheet.mutation.insert-sheet',
            params: { index: 0, sheet: { id: 'x', name: 'Calc' } }
          }
        ],
        names()
      )
    ).toThrow(/already/)
  })

  it('turns a block, rows and columns moved into moves, each a step of its own, and drops a move that goes nowhere', () => {
    const steps = planOf(
      [
        {
          id: 'sheet.mutation.move-range',
          params: { fromRange: range(0, 2, 0, 1), toRange: range(4, 6, 5, 6), from: { subUnitId: 'sheet1', value: {} }, to: { subUnitId: 'sheet2', value: {} } }
        },
        { id: 'sheet.mutation.move-rows', params: { subUnitId: 'sheet1', sourceRange: range(0, 1), targetRange: range(6, 7) } },
        { id: 'sheet.mutation.move-columns', params: { subUnitId: 'sheet1', sourceRange: range(0, 99, 3, 3), targetRange: range(0, 99, 0, 0) } },
        // the same place, and rows put just below themselves: nothing moves
        { id: 'sheet.mutation.move-range', params: { fromRange: range(1, 1, 1, 1), toRange: range(1, 1, 1, 1), from: { subUnitId: 'sheet1', value: {} }, to: { subUnitId: 'sheet1', value: {} } } },
        { id: 'sheet.mutation.move-rows', params: { subUnitId: 'sheet1', sourceRange: range(3, 4), targetRange: range(5, 5) } },
        { id: 'sheet.mutation.insert-row', params: { subUnitId: 'sheet1', range: range(9, 9) } },
        { id: 'sheet.mutation.remove-rows', params: { subUnitId: 'sheet1', range: range(9, 9) } }
      ],
      names()
    )
    expect(steps).toEqual([
      { kind: 'structural', ops: [{ op: 'moveRange', sheet: 'Data', r1: 0, c1: 0, r2: 2, c2: 1, to: 'Calc', row: 4, col: 5 }] },
      { kind: 'structural', ops: [{ op: 'moveRows', sheet: 'Data', at: 0, count: 2, to: 6 }] },
      { kind: 'structural', ops: [{ op: 'moveCols', sheet: 'Data', at: 3, count: 1, to: 0 }] },
      {
        kind: 'structural',
        ops: [
          { op: 'insertRows', sheet: 'Data', at: 9, count: 1 },
          { op: 'removeRows', sheet: 'Data', at: 9, count: 1 }
        ]
      }
    ])
  })

  it('maps a cell through a moved block: it lands at its new place, a cell under where it lands is gone, the rest stay', () => {
    const ops: StructuralOp[] = [{ op: 'moveRange', sheet: 'Data', r1: 0, c1: 0, r2: 2, c2: 1, to: 'Data', row: 4, col: 5 }]
    expect(mapCell(ops, 'Data', 1, 1)).toEqual({ sheet: 'Data', row: 5, col: 6 })
    expect(mapCell(ops, 'Data', 6, 6)).toBeNull()
    expect(mapCell(ops, 'Data', 6, 7)).toEqual({ sheet: 'Data', row: 6, col: 7 })
    expect(mapCell(ops, 'Calc', 1, 1)).toEqual({ sheet: 'Calc', row: 1, col: 1 })
    // a block that lands over part of itself: its own cells move, none is lost
    const over: StructuralOp[] = [{ op: 'moveRange', sheet: 'Data', r1: 0, c1: 0, r2: 2, c2: 0, to: 'Data', row: 1, col: 0 }]
    expect([0, 1, 2].map((r) => mapCell(over, 'Data', r, 0)?.row)).toEqual([1, 2, 3])
    // to another sheet: the cell goes with it, and what stood there is gone
    const away: StructuralOp[] = [{ op: 'moveRange', sheet: 'Data', r1: 0, c1: 0, r2: 0, c2: 0, to: 'Calc', row: 2, col: 2 }]
    expect(mapCell(away, 'Data', 0, 0)).toEqual({ sheet: 'Calc', row: 2, col: 2 })
    expect(mapCell(away, 'Calc', 2, 2)).toBeNull()
  })

  it('maps a cell through rows and columns moved: the moved lines land before the target, the ones between close up', () => {
    const down: StructuralOp[] = [{ op: 'moveRows', sheet: 'Data', at: 0, count: 2, to: 6 }]
    expect([0, 1, 2, 5, 6, 9].map((r) => mapCell(down, 'Data', r, 3)?.row)).toEqual([4, 5, 0, 3, 6, 9])
    const up: StructuralOp[] = [{ op: 'moveRows', sheet: 'Data', at: 5, count: 1, to: 0 }]
    expect([0, 4, 5, 6].map((r) => mapCell(up, 'Data', r, 3)?.row)).toEqual([1, 5, 0, 6])
    const cols: StructuralOp[] = [{ op: 'moveCols', sheet: 'Data', at: 3, count: 1, to: 0 }]
    expect([0, 2, 3, 4].map((c) => mapCell(cols, 'Data', 7, c)?.col)).toEqual([1, 3, 0, 4])
    // rows moved on one sheet leave another alone
    expect(mapCell(down, 'Calc', 0, 0)).toEqual({ sheet: 'Calc', row: 0, col: 0 })
  })

  it("maps a chart's range as LibreOffice moves a reference: along with a block only when wholly inside it, gone under where one lands", () => {
    const block: StructuralOp[] = [{ op: 'moveRange', sheet: 'Data', r1: 0, c1: 0, r2: 2, c2: 1, to: 'Data', row: 4, col: 5 }]
    expect(mapRange(block, { sheet: 'Data', r1: 0, c1: 1, r2: 2, c2: 1 })).toEqual({ sheet: 'Data', r1: 4, c1: 6, r2: 6, c2: 6 })
    // partly inside: it stays as it was
    expect(mapRange(block, { sheet: 'Data', r1: 0, c1: 0, r2: 5, c2: 0 })).toEqual({ sheet: 'Data', r1: 0, c1: 0, r2: 5, c2: 0 })
    expect(mapRange(block, { sheet: 'Data', r1: 5, c1: 5, r2: 6, c2: 5 })).toBeNull()
    // rows 1 to 3 put before row 9: a range over them follows; one across them closes up; one below moves up
    const rows: StructuralOp[] = [{ op: 'moveRows', sheet: 'Data', at: 0, count: 3, to: 8 }]
    expect(mapRange(rows, { sheet: 'Data', r1: 0, c1: 1, r2: 2, c2: 1 })).toEqual({ sheet: 'Data', r1: 5, c1: 1, r2: 7, c2: 1 })
    expect(mapRange(rows, { sheet: 'Data', r1: 0, c1: 0, r2: 5, c2: 0 })).toEqual({ sheet: 'Data', r1: 0, c1: 0, r2: 2, c2: 0 })
    expect(mapRange(rows, { sheet: 'Data', r1: 9, c1: 0, r2: 12, c2: 0 })).toEqual({ sheet: 'Data', r1: 9, c1: 0, r2: 12, c2: 0 })
    expect(moveChartRef('Data!$B$1:$B$3', rows)).toBe('Data!$B$6:$B$8')
  })

  it('maps a cell through inserts, deletes, a sort and a rename; a deleted cell maps to nothing', () => {
    const ops: StructuralOp[] = [
      { op: 'insertRows', sheet: 'Data', at: 2, count: 3 },
      { op: 'removeCols', sheet: 'Data', at: 0, count: 1 },
      { op: 'reorder', sheet: 'Data', r1: 5, c1: 0, r2: 9, c2: 9, order: { 5: 8, 8: 5 } },
      { op: 'renameSheet', sheet: 'Data', to: 'Year' }
    ]
    expect(mapCell(ops, 'Data', 5, 2)).toEqual({ sheet: 'Year', row: 5, col: 1 })
    expect(mapCell(ops, 'Data', 1, 2)).toEqual({ sheet: 'Year', row: 1, col: 1 })
    expect(mapCell(ops, 'Data', 1, 0)).toBeNull()
    expect(mapCell(ops, 'Calc', 1, 0)).toEqual({ sheet: 'Calc', row: 1, col: 0 })
    expect(
      moveChartRef("'Data'!$B$2:$B$13", [{ op: 'insertRows', sheet: 'Data', at: 4, count: 1 }])
    ).toBe('Data!$B$2:$B$14')
    expect(moveChartRef('Data!$A$1', [{ op: 'renameSheet', sheet: 'Data', to: 'My Data' }])).toBe(
      "'My Data'!$A$1"
    )
  })
})

describe.skipIf(!office)('structural edits through LibreOffice', () => {
  const store = async (dir: string): Promise<PackageStore> => {
    const db = new DatabaseSync(':memory:')
    ensurePackageTables(db)
    return new PackageStore(
      db,
      await localJobs(),
      join(dir, 'copies'),
      () => null,
      Date.now,
      () => {},
      libreOffice
    )
  }
  const at = (path: string, sheet: string, row: number, col: number): unknown => {
    const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
    const id = workbook.sheetOrder.find((s) => workbook.sheets[s]?.name === sheet)!
    const c = workbook.sheets[id]?.cellData?.[row]?.[col]
    return c?.f ?? c?.v
  }

  it('inserts a row and types into it in one edit; the formulas below follow; grids reload; it is a revision', async () => {
    const dir = join(scratch, 'insert')
    mkdirSync(dir)
    const path = join(dir, 'Budget.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    const s = await store(dir)
    const data = (await s.open(path)).inspected.sheets[0].id
    const was = at(path, 'Data', 2, 0)
    const got = await s.edit(
      path,
      0,
      [
        {
          id: 'sheet.mutation.insert-row',
          params: { unitId: 'workbook', subUnitId: data, range: range(1, 1) }
        },
        {
          id: SET_RANGE_VALUES,
          params: { unitId: 'workbook', subUnitId: data, cellValue: { 1: { 0: { v: 42 } } } }
        }
      ],
      'owner'
    )
    expect(got).toMatchObject({
      rev: 1,
      moved: { ops: [{ op: 'insertRows', sheet: 'Data', at: 1, count: 1 }] }
    })
    expect(at(path, 'Data', 1, 0)).toBe(42)
    expect(at(path, 'Data', 3, 0)).toBe(was)
    expect(s.since(path, 0)).toEqual({ rev: 1, reload: true })
    expect(s.history(path)[0]).toMatchObject({ rev: 1, label: 'Inserted a row' })
  })

  it('keeps the macro project byte for byte and the chartsheet through a row insert, and renames and adds sheets', async () => {
    const dir = join(scratch, 'keep')
    mkdirSync(dir)
    const xlsm = join(dir, 'Macro.xlsm')
    copyFileSync(join(CORPUS, 'macro.xlsm'), xlsm)
    const s = await store(dir)
    const st = await s.open(xlsm)
    const first = st.inspected.sheets[0]
    await s.edit(
      xlsm,
      0,
      [
        { id: 'sheet.mutation.insert-row', params: { subUnitId: first.id, range: range(0, 0) } },
        {
          id: 'sheet.mutation.set-worksheet-name',
          params: { subUnitId: first.id, name: 'Renamed' }
        },
        {
          id: 'sheet.mutation.insert-sheet',
          params: { index: 9, sheet: { id: 'n1', name: 'Added' } }
        }
      ],
      'owner'
    )
    const { readZip, readEntry } = await import('./patch/zip')
    const vba = (p: string) =>
      Buffer.from(readEntry(readZip(new Uint8Array(readFileSync(p))), 'xl/vbaProject.bin'))
    expect(vba(xlsm).equals(vba(join(CORPUS, 'macro.xlsm')))).toBe(true)
    expect((await s.open(xlsm)).inspected.sheets.map((x) => x.name)).toEqual(
      expect.arrayContaining(['Renamed', 'Added'])
    )

    const charts = join(dir, 'Charts.xlsx')
    copyFileSync(join(CORPUS, 'charts.xlsx'), charts)
    const data = (await s.open(charts)).inspected.sheets[0].id
    await s.edit(
      charts,
      0,
      [{ id: 'sheet.mutation.insert-row', params: { subUnitId: data, range: range(1, 1) } }],
      'owner'
    )
    const z = readZip(new Uint8Array(readFileSync(charts)))
    expect(
      [...z.byName.keys()].filter((n) => /^xl\/chartsheets\/sheet\d+\.xml$/.test(n))
    ).toHaveLength(1)
  })

  it('refuses a row insert on a protected sheet, in words, and leaves the file', async () => {
    const dir = join(scratch, 'protected')
    mkdirSync(dir)
    const path = join(dir, 'Locked.xlsx')
    copyFileSync(join(CORPUS, 'protect_print.xlsx'), path)
    const before = readFileSync(path)
    const s = await store(dir)
    const st = await s.open(path)
    const { readZip, readText } = await import('./patch/zip')
    const z = readZip(new Uint8Array(before))
    const lockedPart = [...z.byName.keys()].find(
      (n) =>
        /worksheets\/sheet\d+\.xml$/.test(n) &&
        /<sheetProtection[^>]*sheet="1"/.test(readText(z, n))
    )!
    const index = Number(/sheet(\d+)\.xml$/.exec(lockedPart)![1]) - 1
    const sheet = st.inspected.sheets[index] ?? st.inspected.sheets[0]
    await expect(
      s.edit(
        path,
        0,
        [{ id: 'sheet.mutation.insert-row', params: { subUnitId: sheet.id, range: range(0, 0) } }],
        'owner'
      )
    ).rejects.toThrow(/is protected/)
    expect(readFileSync(path).equals(before)).toBe(true)
  })
})

describe('what a moved block leaves behind (graft)', () => {
  const box = (r1: number, c1: number, r2: number, c2: number) => ({ r1, c1, r2, c2 })
  it('cuts a box out of another: nothing, the whole, or up to four boxes around it', () => {
    expect(boxWithout(box(0, 0, 9, 0), box(20, 0, 22, 0))).toEqual([box(0, 0, 9, 0)])
    expect(boxWithout(box(0, 0, 2, 0), box(0, 0, 9, 3))).toEqual([])
    expect(boxWithout(box(0, 0, 9, 0), box(0, 0, 2, 2))).toEqual([box(3, 0, 9, 0)])
    // a hole in the middle: above, below, left, right
    expect(boxWithout(box(0, 0, 4, 4), box(2, 2, 2, 2))).toEqual([box(0, 0, 1, 4), box(3, 0, 4, 4), box(2, 0, 2, 1), box(2, 3, 2, 4)])
  })

  it('the cells a block left: all of it on another sheet, and less where it landed on its own', () => {
    const op = { op: 'moveRange' as const, sheet: 'Data', r1: 0, c1: 0, r2: 2, c2: 1, to: 'Data', row: 1, col: 1 }
    expect(vacatedBy({ ...op, to: 'Calc' })).toEqual([box(0, 0, 2, 1)])
    expect(vacatedBy({ ...op, row: 14, col: 9 })).toEqual([box(0, 0, 2, 1)])
    // dropped over part of itself: B2:B3 is filled again
    expect(vacatedBy(op)).toEqual([box(0, 0, 0, 1), box(1, 0, 2, 0)])
  })

  it('takes a conditional format off the cells a block left, in the sheet’s list and the extended one, and leaves the rest as it was', () => {
    const rule = '<cfRule type="cellIs" priority="2" operator="lessThan" dxfId="0"><formula>0</formula></cfRule>'
    const xml =
      `<worksheet><sheetData/><conditionalFormatting sqref="C2:C10 L15:L17">${rule}</conditionalFormatting>` +
      `<conditionalFormatting sqref="C1:C3">${rule}</conditionalFormatting><conditionalFormatting sqref="N5:P7">${rule}</conditionalFormatting>` +
      '<dataValidations count="1"><dataValidation type="whole" sqref="C1:C3"/></dataValidations>' +
      '<extLst><ext><x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="x"><x14:cfRule type="dataBar" id="{1}"/><xm:sqref>C1:C10</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst></worksheet>'
    const out = offVacated(xml, [box(0, 0, 2, 2)])
    expect([...out.matchAll(/<conditionalFormatting sqref="([^"]*)"/g)].map((m) => m[1])).toEqual(['C4:C10 L15:L17', 'N5:P7'])
    expect(out).toContain('<xm:sqref>C4:C10</xm:sqref>')
    // a validation is LibreOffice's own to move (it does, cell for cell): not touched here
    expect(out).toContain('<dataValidation type="whole" sqref="C1:C3"/>')
    // nothing of it on those cells: the same text comes back
    const far = offVacated(xml, [box(40, 0, 42, 2)])
    expect(far).toBe(xml)
  })
})

describe("a chart series' typed name (graft)", () => {
  const ser = (tx: string, cat: string, val: string) => `<c:ser><c:idx val="0"/>${tx}<c:cat><c:numRef><c:f>${cat}</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>${val}</c:f></c:numRef></c:val></c:ser>`
  const typed = '<c:tx><c:v>Block</c:v></c:tx>'
  const asRef = (cell: string) => `<c:tx><c:strRef><c:f>${cell}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:strCache></c:strRef></c:tx>`
  const move = [{ op: 'moveRange' as const, sheet: 'Data', r1: 0, c1: 0, r2: 2, c2: 1, to: 'Data', row: 4, col: 5 }]

  it('is put back on the series that reads the same ranges once they have moved', () => {
    const original = `<c:chart>${ser(typed, 'Data!$A$1:$A$3', 'Data!$B$1:$B$3')}</c:chart>`
    // LibreOffice: the name is a reference to the first category cell
    const written = `<c:chart>${ser(asRef('Data!$F$5'), 'Data!$F$5:$F$7', 'Data!$G$5:$G$7')}</c:chart>`
    const names = typedSeriesNames([original], move)
    expect(withTypedNames(written, names)).toBe(`<c:chart>${ser(typed, 'Data!$F$5:$F$7', 'Data!$G$5:$G$7')}</c:chart>`)
    // quoted or not, with or without `$`: the same ranges
    expect(withTypedNames(`<c:chart>${ser(asRef("'Data'!$F$5"), "'Data'!$F$5:$F$7", "'Data'!$G$5:$G$7")}</c:chart>`, names)).toContain(typed)
  })

  it('never gives a series named from a cell another chart’s typed name, though both charts read the same ranges', () => {
    // chart 1: the typed name "Budget"; chart 2: a name read from Data!$H$1; the same values. A row is inserted on another sheet.
    const one = (tx: string) => `<c:chart><c:ser><c:idx val="0"/>${tx}<c:val><c:numRef><c:f>Data!$B$2:$B$5</c:f></c:numRef></c:val></c:ser></c:chart>`
    const linked = '<c:tx><c:strRef><c:f>Data!$H$1</c:f></c:strRef></c:tx>'
    const names = typedSeriesNames([one('<c:tx><c:v>Budget</c:v></c:tx>'), one(linked)], [{ op: 'insertRows', sheet: 'Other', at: 0, count: 1 }])
    expect(withTypedNames(one(linked), names)).toBe(one(linked))
    // which of the two is which cannot be told from LibreOffice's file, so the typed one is left as LibreOffice wrote it too
    const asFormula = '<c:tx><c:strRef><c:f>&quot;Budget&quot;</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Budget</c:v></c:pt></c:strCache></c:strRef></c:tx>'
    expect(withTypedNames(one(asFormula), names)).toBe(one(asFormula))
    expect(names.size).toBe(0)
  })

  it('tells charts apart by all the ranges their series read: a typed name goes back on its own chart alone', () => {
    const body = (tx: string, val: string) => `<c:ser><c:idx val="0"/>${tx}<c:val><c:numRef><c:f>${val}</c:f></c:numRef></c:val></c:ser>`
    const linked = (cell: string) => `<c:tx><c:strRef><c:f>${cell}</c:f></c:strRef></c:tx>`
    // chart A: one typed series over B2:B5; chart B: the same values named from H1, and a second series
    const a = `<c:chart>${body('<c:tx><c:v>Budget</c:v></c:tx>', 'Data!$B$2:$B$5')}</c:chart>`
    const b = `<c:chart>${body(linked('Data!$H$1'), 'Data!$B$2:$B$5')}${body(linked('Data!$I$1'), 'Data!$C$2:$C$5')}</c:chart>`
    const names = typedSeriesNames([a, b], [])
    expect(withTypedNames(`<c:chart>${body(linked('Data!$B$2'), 'Data!$B$2:$B$5')}</c:chart>`, names)).toBe(a)
    expect(withTypedNames(b, names)).toBe(b)
  })

  it('leaves a name read from a cell, a series that reads other ranges, and two typed names over the same ranges', () => {
    const fromCell = `<c:chart>${ser(asRef('Data!$B$1'), 'Data!$A$2:$A$9', 'Data!$B$2:$B$9')}</c:chart>`
    expect(typedSeriesNames([fromCell], []).size).toBe(0)
    const names = typedSeriesNames([`<c:chart>${ser(typed, 'Data!$A$1:$A$3', 'Data!$B$1:$B$3')}</c:chart>`], [])
    const other = `<c:chart>${ser(asRef('Data!$D$1'), 'Data!$D$1:$D$3', 'Data!$E$1:$E$3')}</c:chart>`
    expect(withTypedNames(other, names)).toBe(other)
    const twice = typedSeriesNames([`<c:chart>${ser(typed, 'Data!$A$1:$A$3', 'Data!$B$1:$B$3')}${ser('<c:tx><c:v>Other</c:v></c:tx>', 'Data!$A$1:$A$3', 'Data!$B$1:$B$3')}</c:chart>`], [])
    const same = `<c:chart>${ser(asRef('Data!$A$1'), 'Data!$A$1:$A$3', 'Data!$B$1:$B$3')}</c:chart>`
    expect(withTypedNames(same, twice)).toBe(same)
  })
})

describe('what the script says as it gives up, in the words he reads', () => {
  const move: StructuralOp[] = [{ op: 'moveRows', sheet: 'Data', at: 0, count: 1, to: 5 }]
  const insert: StructuralOp[] = [{ op: 'insertRows', sheet: 'Data', at: 0, count: 1 }]
  it('a move: each reason in the canvas’s words, never the script’s own line', () => {
    expect(scriptRefusal(move, 'full: Data', 1)).toBeInstanceOf(NotSaved)
    expect(scriptRefusal(move, 'full: Data', 1).message).toBe('Move this in Excel: the sheet is full')
    expect(scriptRefusal(move, 'protected: Data', 1).message).toBe('Move this in Excel: the sheet is protected')
    expect(scriptRefusal(move, 'unmoved: Data', 1).message).toBe('Move this in Excel')
  })
  it('an insert keeps its own words, and anything else names what LibreOffice said', () => {
    expect(scriptRefusal(insert, 'full: Data', 1).message).toMatch(/^There is no room in Data/)
    expect(scriptRefusal(insert, 'protected: Data', 1).message).toMatch(/^Data is protected/)
    expect(scriptRefusal(move, 'RuntimeError: no sheet named X', 1).message).toBe('LibreOffice could not make that change: RuntimeError: no sheet named X')
    expect(scriptRefusal(insert, '', 3).message).toBe('LibreOffice could not make that change: exit 3')
  })
})
