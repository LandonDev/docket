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

  it('refuses formatting and row inserts in words, and saves nothing', async () => {
    const data = (await store.open(path)).inspected.sheets[0].id
    await expect(store.edit(path, 0, [set(data, 1, 0, { s: { bl: 1 } })], 'owner')).rejects.toThrow(/formatting/)
    await expect(store.edit(path, 0, [{ id: 'sheet.mutation.insert-row', params: { unitId: PACKAGE_UNIT, subUnitId: data, range: { startRow: 1, endRow: 1, startColumn: 0, endColumn: 4 } } }], 'owner')).rejects.toThrow(/rows and columns/)
    expect((await store.open(path)).rev).toBe(0)
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
