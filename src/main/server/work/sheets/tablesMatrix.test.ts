import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { forPackage, RULE_MUTATIONS, ruleKinds, RULES_SET } from '@shared/work/sheets'
import { ensurePackageTables, PackageStore } from './packages'
import { readTables, type TableModel } from './patch/tables'
import { localJobs } from './workerClient'

/**
 * A table in an opened Excel file (the editors plan, SHT4): the grid's table mutation goes to the
 * host as the sheet's whole table list (`RULES_SET` of kind `tables`), the package store saves it
 * as a real table part, and the file read again holds it.
 */
const CORPUS = join(import.meta.dirname, 'harness/corpus')
const scratch = mkdtempSync(join(tmpdir(), 'sheets-tables-matrix-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let n = 0
async function opened() {
  const path = join(scratch, `${++n}.xlsx`)
  copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
  const db = new DatabaseSync(':memory:')
  ensurePackageTables(db)
  const store = new PackageStore(db, await localJobs(), join(scratch, `files-${n}`), () => null)
  await store.open(path)
  const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
  const sheet = workbook.sheetOrder.find((id) => workbook.sheets[id]?.name === 'Data')!
  const file = () => readTables(new Uint8Array(readFileSync(path))).sheets.Data?.tables ?? []
  const cold = (): unknown[] => {
    const { workbook: again } = importXlsx(new Uint8Array(readFileSync(path)))
    const all = JSON.parse(again.resources?.find((r) => r.name === 'SHEET_TABLE_PLUGIN')?.data ?? '{}') as Record<string, { tables?: unknown[] }>
    return all[sheet]?.tables ?? []
  }
  const save = async (list: TableModel[]): Promise<number> => {
    const got = await store.edit(path, (await store.open(path)).rev, [{ id: RULES_SET, params: { kind: 'tables', subUnitId: sheet, list } }], 'owner')
    if ('conflict' in got) throw new Error('conflict')
    return got.rev
  }
  return { path, store, sheet, file, cold, save }
}

const table = (name: string, startRow: number, endRow: number, startColumn: number, endColumn: number): TableModel => ({
  id: `id-${name}`,
  name,
  range: { startRow, endRow, startColumn, endColumn },
  options: { showHeader: true },
  columns: [],
  meta: {},
  filters: {}
}) as never

describe("a table's change, as an opened Excel file takes it", () => {
  const all = ruleKinds(['bold', 'table'])
  it('the row\'s Table control names the sheet\'s tables as a list the file keeps', () => {
    expect([...all]).toEqual(['tables'])
    expect([...ruleKinds(['bold', 'filter'])]).toEqual(['filter'])
  })

  it.each(Object.entries(RULE_MUTATIONS).filter(([, kind]) => kind === 'tables'))('%s goes as the sheet\'s whole table list', (id) => {
    const list = [{ id: 't1' }]
    const got = forPackage({ id, params: { unitId: 'workbook', subUnitId: 's1' } }, () => null, { formats: true, kinds: all, rules: (kind, sheet) => (kind === 'tables' && sheet === 's1' ? list : undefined) })
    expect(got).toEqual({ keep: [{ id: RULES_SET, params: { kind: 'tables', subUnitId: 's1', list } }] })
  })

  it('is stopped where the host lists no Table control', () => {
    const got = forPackage({ id: 'sheet.mutation.add-table', params: { subUnitId: 's1' } }, () => null, { formats: true, kinds: ruleKinds(['filter']), rules: () => [] })
    expect(got).toEqual({ stop: 'That change is not saved in an Excel file yet. Make it in Excel' })
  })
})

describe('a table made in an opened Excel file', () => {
  it('is saved as a real table part, restyled, grown and removed, each read back from the file', async () => {
    const t = await opened()
    expect(t.file()).toEqual([])
    expect(await t.save([table('Budget', 0, 8, 0, 2)])).toBe(1)
    expect(t.file()).toHaveLength(1)
    expect(t.file()[0]).toMatchObject({ name: 'Budget', range: { startRow: 0, endRow: 8, startColumn: 0, endColumn: 2 } })
    expect(t.file()[0]!.columns).toHaveLength(3)
    // what a grid opening the file again shows
    expect(t.cold()).toHaveLength(1)
    expect(t.store.history(t.path)[0]).toMatchObject({ rev: 1, label: 'Table', by: 'owner' })
    // a grid that stood before it reads the file again
    expect(t.store.since(t.path, 0)).toEqual({ rev: 1, reload: true })

    const [made] = t.file()
    await t.save([{ ...made!, options: { ...made!.options, tableStyleId: 'TableStyleMedium4' }, range: { ...made!.range, endRow: 9 } } as never])
    expect(t.file()[0]).toMatchObject({ range: { endRow: 9 }, options: { tableStyleId: 'TableStyleMedium4' } })

    await t.save([])
    expect(t.file()).toEqual([])
    expect(t.cold()).toEqual([])
  })

  it('one the file cannot hold is refused whole, in words, and nothing is written', async () => {
    const t = await opened()
    await t.save([table('Budget', 0, 8, 0, 2)])
    const before = readFileSync(t.path)
    await expect(t.save([...t.file(), table('Second', 4, 12, 1, 3)])).rejects.toThrow()
    expect(readFileSync(t.path).equals(before)).toBe(true)
    expect((await t.store.open(t.path)).rev).toBe(1)
  })
})
