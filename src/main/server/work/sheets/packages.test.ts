import { copyFileSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { SET_RANGE_VALUES } from './mutations'
import { ensurePackageTables, PackageStore, PACKAGE_UNIT } from './packages'
import { localJobs } from './workerClient'

const CORPUS = join(__dirname, 'harness/corpus')
const IRONCALC = process.env.IRONCALC_DIR ?? '/srv/agents/temp-code-data/work-tools/ironcalc/0.9.1'
const engine = existsSync(join(IRONCALC, 'node_modules/@ironcalc/nodejs')) ? IRONCALC : null
const scratch = mkdtempSync(join(tmpdir(), 'sheets-packages-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const set = (sheet: string, row: number, col: number, cell: unknown) => ({ id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: sheet, cellValue: { [row]: { [col]: cell } } } })
const valueAt = (path: string, sheet: string, row: number, col: number): unknown => {
  const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
  const id = workbook.sheetOrder.find((s) => workbook.sheets[s]?.name === sheet)!
  return workbook.sheets[id]?.cellData?.[row]?.[col]?.v
}

let n = 0
let path: string
let store: PackageStore
beforeEach(async () => {
  const dir = join(scratch, String(++n))
  path = join(dir, 'Budget.xlsx')
  ;(await import('node:fs')).mkdirSync(dir, { recursive: true })
  copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
  const db = new DatabaseSync(':memory:')
  ensurePackageTables(db)
  let t = 1_000
  store = new PackageStore(db, await localJobs(), join(dir, 'copies'), () => engine, () => ++t)
})

describe('an opened package', () => {
  it('opens at revision 0 with its sheets, and nothing our grid cannot reach', async () => {
    const s = await store.open(path)
    expect(s.rev).toBe(0)
    expect(s.inspected.sheets.map((x) => x.name)).toEqual(['Data', 'Calc', 'Dynamic', 'Q1', 'Q2', 'Q3'])
    expect(s.inspected.reach).toBeNull()
  })

  it('saves an edit into the file as a revision, and the grids catch up through since', async () => {
    const s = await store.open(path)
    const data = s.inspected.sheets[0].id
    const got = await store.edit(path, 0, [set(data, 1, 0, { v: 100 })], 'owner')
    expect(got).toEqual({ rev: 1 })
    expect(valueAt(path, 'Data', 1, 0)).toBe(100)
    const since = store.since(path, 0)
    expect('ops' in since && since.ops.map((o) => [o.rev, o.by])).toEqual([[1, 'owner']])
    // the original stays for history; the new revision is kept too
    expect(valueAt(store.fileAt(path, 0), 'Data', 1, 0)).toBe(1)
    expect(valueAt(store.fileAt(path, 1), 'Data', 1, 0)).toBe(100)
  })

  it('takes an edit made on an older revision when only cell edits came between, and answers a conflict across a change from outside', async () => {
    const data = (await store.open(path)).inspected.sheets[0].id
    await store.edit(path, 0, [set(data, 1, 0, { v: 2 })], 'owner')
    expect(await store.edit(path, 0, [set(data, 2, 0, { v: 3 })], 'owner')).toEqual({ rev: 2 })
    writeFileSync(path, readFileSync(path))
    utimesSync(path, new Date(), new Date(Date.now() + 9_000))
    const before = readFileSync(path)
    expect(await store.edit(path, 2, [set(data, 3, 0, { v: 4 })], 'owner')).toEqual({ conflict: true, rev: 3 })
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('never overwrites a save made outside while it patched: that save stands as a revision, and the edit answers a conflict', async () => {
    const jobs = await localJobs()
    const db = new DatabaseSync(':memory:')
    ensurePackageTables(db)
    const outside: string[] = []
    const racing = new PackageStore(
      db,
      {
        ...jobs,
        async save(p, out, edits, dir) {
          const got = await jobs.save(p, out, edits, dir)
          // Excel saves while the worker patches.
          writeFileSync(path, readFileSync(join(CORPUS, 'formats.xlsx')))
          utimesSync(path, new Date(), new Date(Date.now() + 7_000))
          return got
        }
      },
      join(scratch, `${n}-race`),
      () => null,
      Date.now,
      (p) => outside.push(p)
    )
    const data = (await racing.open(path)).inspected.sheets[0].id
    expect(await racing.edit(path, 0, [set(data, 1, 0, { v: 100 })], 'owner')).toEqual({ conflict: true, rev: 1 })
    expect(readFileSync(path).equals(readFileSync(join(CORPUS, 'formats.xlsx')))).toBe(true)
    expect(racing.history(path)[0]).toMatchObject({ rev: 1, by: 'file' })
    expect(outside).toEqual([path])
  })

  it('refuses a move the file cannot take before it asks for the LibreOffice job, and saves nothing', async () => {
    const tables = join(scratch, `${n}-tables.xlsx`)
    copyFileSync(join(CORPUS, 'moves/tables.xlsx'), tables)
    const before = readFileSync(tables)
    const db = new DatabaseSync(':memory:')
    ensurePackageTables(db)
    const asked: unknown[] = []
    const moving = new PackageStore(db, await localJobs(), join(scratch, `${n}-moving`), () => null, Date.now, () => {}, async (_input, ops) => {
      asked.push(ops)
      throw new Error('no LibreOffice in this test')
    })
    const data = (await moving.open(tables)).inspected.sheets[0].id
    const range = (r1: number, c1: number, r2: number, c2: number) => ({ startRow: r1, startColumn: c1, endRow: r2, endColumn: c2 })
    // two rows of the table Sales (A1:B4) dragged out of it
    const cut = { fromRange: range(1, 0, 2, 1), toRange: range(9, 7, 10, 8), from: { subUnitId: data, value: {} }, to: { subUnitId: data, value: {} } }
    await expect(moving.edit(tables, 0, [{ id: 'sheet.mutation.move-range', params: { unitId: PACKAGE_UNIT, ...cut } }], 'owner')).rejects.toThrow('Move this in Excel: it crosses a table')
    expect(asked).toEqual([])
    expect(readFileSync(tables).equals(before)).toBe(true)
    expect((await moving.open(tables)).rev).toBe(0)
    // the whole table is a move the file takes: the job is asked for
    const whole = { fromRange: range(0, 0, 3, 1), toRange: range(0, 7, 3, 8), from: { subUnitId: data, value: {} }, to: { subUnitId: data, value: {} } }
    await expect(moving.edit(tables, 0, [{ id: 'sheet.mutation.move-range', params: { unitId: PACKAGE_UNIT, ...whole } }], 'owner')).rejects.toThrow(/no LibreOffice in this test/)
    expect(asked).toEqual([[{ op: 'moveRange', sheet: 'Data', r1: 0, c1: 0, r2: 3, c2: 1, to: 'Data', row: 0, col: 7 }]])
  })

  it('refuses moved cells and row inserts in words where it has no LibreOffice, and saves nothing', async () => {
    const data = (await store.open(path)).inspected.sheets[0].id
    const range = { startRow: 1, endRow: 1, startColumn: 0, endColumn: 4 }
    // a move goes through LibreOffice, as an insert does: a store with none refuses it
    const moved = { fromRange: range, toRange: { ...range, startRow: 5, endRow: 5 }, from: { subUnitId: data, value: {} }, to: { subUnitId: data, value: {} } }
    await expect(store.edit(path, 0, [{ id: 'sheet.mutation.move-range', params: { unitId: PACKAGE_UNIT, ...moved } }], 'owner')).rejects.toThrow(/Rows, columns and sheets cannot be changed/)
    await expect(store.edit(path, 0, [{ id: 'sheet.mutation.set-frozen', params: { unitId: PACKAGE_UNIT, subUnitId: data } }], 'owner')).rejects.toThrow('That change is not saved in an Excel file yet')
    await expect(store.edit(path, 0, [set(data, 1, 0, { p: { body: {} } })], 'owner')).rejects.toThrow('more than one style in a cell')
    await expect(store.edit(path, 0, [{ id: 'sheet.mutation.insert-row', params: { unitId: PACKAGE_UNIT, subUnitId: data, range } }], 'owner')).rejects.toThrow(/Rows, columns and sheets cannot be changed/)
    expect((await store.open(path)).rev).toBe(0)
  })

  it('saves formatting into the file: a style, a width, a height and a merge, each as its own revision, the values untouched', async () => {
    const data = (await store.open(path)).inspected.sheets[0].id
    const before = valueAt(path, 'Data', 1, 0)
    const cell = (row: number, col: number) => {
      const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
      const sheet = workbook.sheets[workbook.sheetOrder.find((s) => workbook.sheets[s]?.name === 'Data')!]!
      const s = sheet.cellData?.[row]?.[col]?.s
      return { sheet, style: (typeof s === 'string' ? workbook.styles?.[s] : s) ?? {} }
    }
    // bold and a fill on A2:B2, as the row sends them: one mutation, each cell the keys that changed
    const bold = { id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: data, cellValue: { 1: { 0: { s: { bl: 1, bg: { rgb: '#FFDD66' } } }, 1: { s: { bl: 1, bg: { rgb: '#FFDD66' } } } } } } }
    expect(await store.edit(path, 0, [bold], 'owner')).toEqual({ rev: 1 })
    expect(cell(1, 0).style).toMatchObject({ bl: 1, bg: { rgb: '#FFDD66' } })
    expect(cell(1, 1).style).toMatchObject({ bl: 1 })
    expect(valueAt(path, 'Data', 1, 0)).toBe(before)
    expect(store.history(path)[0]).toMatchObject({ rev: 1, by: 'owner', label: 'Formatting' })
    // a column's width, a row's height and a merge, in one edit
    const ranges = (r: object) => [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0, ...r }]
    const more = [
      { id: 'sheet.mutation.set-worksheet-col-width', params: { unitId: PACKAGE_UNIT, subUnitId: data, ranges: ranges({ startColumn: 2, endColumn: 2 }), colWidth: 160 } },
      { id: 'sheet.mutation.set-worksheet-row-height', params: { unitId: PACKAGE_UNIT, subUnitId: data, ranges: ranges({ startRow: 4, endRow: 4 }), rowHeight: 40 } },
      { id: 'sheet.mutation.add-worksheet-merge', params: { unitId: PACKAGE_UNIT, subUnitId: data, ranges: [{ startRow: 20, endRow: 21, startColumn: 5, endColumn: 6 }] } }
    ]
    expect(await store.edit(path, 1, more, 'owner')).toEqual({ rev: 2 })
    const { sheet } = cell(0, 0)
    expect(sheet.columnData?.[2]?.w).toBe(160)
    expect(sheet.rowData?.[4]?.h).toBe(40)
    expect(sheet.mergeData).toContainEqual(expect.objectContaining({ startRow: 20, endRow: 21, startColumn: 5, endColumn: 6 }))
    // clearing takes the formatting off again and leaves the value
    const clear = { id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: data, cellValue: { 1: { 0: { s: null } } } } }
    expect(await store.edit(path, 2, [clear], 'owner')).toEqual({ rev: 3 })
    expect(cell(1, 0).style.bl).toBeUndefined()
    expect(valueAt(path, 'Data', 1, 0)).toBe(before)
    // the grids catch up through since, the formatting among the ops
    const since = store.since(path, 0)
    expect('ops' in since && since.ops.map((o) => o.rev)).toEqual([1, 2, 3])
  })

  it('a value typed with a style lands as both, in one revision', async () => {
    const data = (await store.open(path)).inspected.sheets[0].id
    expect(await store.edit(path, 0, [set(data, 30, 7, { v: 12.5, s: { n: { pattern: '0.00%' }, it: 1 } })], 'owner')).toEqual({ rev: 1 })
    const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
    const got = workbook.sheets[workbook.sheetOrder[0]!]!.cellData?.[30]?.[7]
    expect(got?.v).toBe(12.5)
    expect((typeof got?.s === 'string' ? workbook.styles?.[got.s] : got?.s)).toMatchObject({ it: 1, n: { pattern: '0.00%' } })
  })

  it('takes a change made outside as its own revision, and tells the grids to reload', async () => {
    await store.open(path)
    writeFileSync(path, readFileSync(join(CORPUS, 'formats.xlsx')))
    utimesSync(path, new Date(), new Date(Date.now() + 5_000))
    expect(store.since(path, 0)).toEqual({ rev: 1, reload: true })
    expect(store.history(path)[0]).toMatchObject({ rev: 1, by: 'file', label: 'Changed outside TempCode' })
  })

  it('writes an agent\'s cells in A1, keeps what they held, and takes the write back', async () => {
    await store.open(path)
    const w = await store.writeCells(path, [{ at: 'A2', v: 7 }, { at: "'Data'!A3", f: 'A2*2' }], 'agent:h:t', 'Wrote 2 cells', 'w1')
    expect(w.rev).toBe(1)
    const read = await store.read(path, 'Data!A2:A3')
    expect(read.cells.map((r) => r[0])).toEqual([{ at: 'A2', v: 7 }, expect.objectContaining({ at: 'A3', f: '=A2*2' })])
    if (engine) expect(read.cells[1][0].v).toBe(14)
    await store.undo(path, 'w1')
    const back = await store.read(path, 'Data!A2:A3')
    expect(back.cells.map((r) => r[0].v)).toEqual([1, 38])
    await expect(store.undo(path, 'w1')).rejects.toThrow(/no longer/)
  })

  it('compares two revisions cell by cell and restores an older one as a new revision', async () => {
    const data = (await store.open(path)).inspected.sheets[0].id
    await store.edit(path, 0, [set(data, 1, 0, { v: 5 }), set(data, 2, 0, { v: 6 })], 'owner')
    const diff = await store.compare(path, 0, 1, 100)
    expect(diff.truncated).toBe(false)
    expect(diff.cells.filter((c) => c.sheetName === 'Data').map((c) => [c.row, c.col, c.before?.v, c.after?.v])).toEqual([
      [1, 0, 1, 5],
      [2, 0, 38, 6]
    ])
    const r = await store.restore(path, 0, 'owner')
    expect(r.rev).toBe(2)
    expect(readFileSync(path).equals(readFileSync(join(CORPUS, 'formulas.xlsx')))).toBe(true)
    expect(store.since(path, 1)).toEqual({ rev: 2, reload: true })
    expect(valueAt(path, 'Data', 1, 0)).toBe(1)
    expect(store.history(path).map((h) => h.rev)).toEqual([2, 1, 0])
  })

  it('offers the switch for a file with a pivot table or macros', async () => {
    for (const [file, part] of [
      ['pivot.xlsx', 'pivot tables'],
      ['macro.xlsm', 'macros']
    ]) {
      const p = join(scratch, `${n}-${file}`)
      copyFileSync(join(CORPUS, file), p)
      const s = await store.open(p)
      expect(s.inspected.reach?.to).toBe('excel')
      expect(s.inspected.reach?.parts).toContain(part)
    }
  })
})
