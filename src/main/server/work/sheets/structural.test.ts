import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { moveChartRef } from './graft'
import { NotSaved, SET_RANGE_VALUES } from './mutations'
import { ensurePackageTables, PackageStore } from './packages'
import { mapCell, planOf, type StructuralOp } from './structural'
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
      planOf([{ id: 'sheet.mutation.move-rows', params: { subUnitId: 'sheet1' } }], names())
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
