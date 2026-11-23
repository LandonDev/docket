import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { blankWorkbook } from './host/backends'
import { SOFFICE } from './testing'
import { ruleModel, place } from './asks'
import { readRules } from './patch/rules'
import { readTables } from './patch/tables'
import { readText, readZip } from './patch/zip'
import { readCsv, rulesOf, tablesOf, writeCsv, writeXlsx, writeXlsxWhole } from './writer'

const scratch = mkdtempSync(join(tmpdir(), 'sheets-writer-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const LOPY = join(dirname(SOFFICE), 'python')

/** A sheet made in our grid: values, a formula with its last value, styles, a merge, sizes, a frozen row, a hidden second sheet. */
function made(): IWorkbookData {
  const wb = blankWorkbook('book', 'Budget')
  wb.styles = {
    head: { bl: 1, bg: { rgb: '#E8F0FE' }, ht: 2 },
    money: { n: { pattern: '#,##0.00' } }
  }
  wb.sheets.sheet1 = {
    ...wb.sheets.sheet1!,
    name: 'Q1 Budget',
    cellData: {
      0: { 0: { v: 'Item', s: 'head' }, 1: { v: 'Amount', s: 'head' } },
      1: { 0: { v: 'Rent' }, 1: { v: 1200, s: 'money' } },
      2: { 0: { v: 'Food, "fresh"' }, 1: { v: 300.5, s: 'money' } },
      3: {
        0: { v: 'Total' },
        1: { f: '=SUM(B2:B3)', v: 1500.5, s: { bl: 1, n: { pattern: '#,##0.00' } } }
      },
      4: { 0: { v: true, t: 3 }, 1: { f: '=XLOOKUP("Rent",A2:A3,B2:B3)', v: 1200 } }
    },
    mergeData: [{ startRow: 6, endRow: 6, startColumn: 0, endColumn: 1 }],
    columnData: { 0: { w: 180 } },
    rowData: { 0: { h: 28 } },
    freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 }
  } as IWorkbookData['sheets'][string]
  wb.sheetOrder = ['sheet1', 'sheet2']
  wb.sheets.sheet2 = {
    id: 'sheet2',
    name: 'Notes',
    hidden: 1,
    rowCount: 100,
    columnCount: 10,
    cellData: { 0: { 0: { v: 'kept' } } }
  } as IWorkbookData['sheets'][string]
  return wb
}

describe('the model writer', () => {
  it('writes a package our importer reads back as it was made', () => {
    const { workbook, report } = importXlsx(writeXlsx(made()))
    expect(report.unsupported).toEqual([])
    expect(workbook.sheetOrder.map((id) => workbook.sheets[id]?.name)).toEqual([
      'Q1 Budget',
      'Notes'
    ])
    const [a, b] = workbook.sheetOrder.map((id) => workbook.sheets[id]!)
    const cell = (r: number, c: number) => a.cellData?.[r]?.[c]
    expect([
      cell(0, 0)?.v,
      cell(1, 1)?.v,
      cell(2, 0)?.v,
      cell(3, 1)?.f,
      cell(3, 1)?.v,
      cell(4, 1)?.f
    ]).toEqual([
      'Item',
      1200,
      'Food, "fresh"',
      '=SUM(B2:B3)',
      1500.5,
      '=XLOOKUP("Rent",A2:A3,B2:B3)'
    ])
    expect(cell(4, 0)?.v).toBe(1)
    const style = (s: unknown) =>
      (typeof s === 'string' ? workbook.styles?.[s] : s) as
        { bl?: number; n?: { pattern?: string }; bg?: { rgb?: string } } | undefined
    expect(style(cell(0, 0)?.s)).toMatchObject({ bl: 1 })
    expect(style(cell(1, 1)?.s)?.n?.pattern).toBe('#,##0.00')
    expect(a.mergeData).toMatchObject([{ startRow: 6, endRow: 6, startColumn: 0, endColumn: 1 }])
    expect(a.freeze).toMatchObject({ ySplit: 1, startRow: 1 })
    expect(b.hidden).toBe(1)
    expect(b.cellData?.[0]?.[0]?.v).toBe('kept')
  })

  it.skipIf(!existsSync(LOPY))(
    'writes a package LibreOffice opens and recalculates to the same values',
    () => {
      const out = join(scratch, 'made.xlsx')
      writeFileSync(out, writeXlsx(made()))
      const dump = join(scratch, 'made.json')
      const p = spawnSync(LOPY, [join(__dirname, 'harness/lo_dump.py'), out, dump], {
        encoding: 'utf8',
        timeout: 120_000
      })
      expect(p.status, p.stderr).toBe(0)
      const sheets = JSON.parse(readFileSync(dump, 'utf8')).sheets as Record<
        string,
        Record<string, [string, unknown]>
      >
      expect(sheets['Q1 Budget'].B4.slice(0, 2)).toEqual(['n', 1500.5])
      expect(sheets['Q1 Budget'].B5.slice(0, 2)).toEqual(['n', 1200])
      expect(sheets['Q1 Budget'].A3.slice(0, 2)).toEqual(['s', 'Food, "fresh"'])
      expect(sheets.Notes.A1.slice(0, 2)).toEqual(['s', 'kept'])
    }
  )

  it('writes one sheet as CSV and reads it back', () => {
    const csv = writeCsv(made())
    expect(csv.split('\r\n').slice(0, 5)).toEqual([
      'Item,Amount',
      'Rent,1200',
      '"Food, ""fresh""",300.5',
      'Total,1500.5',
      'TRUE,1200'
    ])
    const back = readCsv(csv, 'id', 'Budget.csv')
    expect(back.sheets.sheet1!.name).toBe('Budget')
    expect(back.sheets.sheet1!.cellData?.[2]).toEqual({
      0: { v: 'Food, "fresh"', t: 1 },
      1: { v: 300.5, t: 2 }
    })
    expect(readCsv('code,n\r\n007,"a\nb"\n', 'i', 'x.csv').sheets.sheet1!.cellData).toEqual({
      0: { 0: { v: 'code', t: 1 }, 1: { v: 'n', t: 1 } },
      1: { 0: { v: '007', t: 1 }, 1: { v: 'a\nb', t: 1 } }
    })
    expect(writeCsv(made(), 'Notes')).toBe('kept\r\n')
  })
})

describe('the rules of a sheet made here, in its export', () => {
  /** A sheet with one rule of each list, as the grid's plugins keep them in the snapshot. */
  function ruled(): IWorkbookData {
    const wb = made()
    const sheets = [{ id: 'sheet1', name: 'Q1 Budget' }]
    const at = (range: string) => place(range, sheets)
    const cf = ruleModel({ kind: 'highlight', range: 'B2:B9', when: 'greater', value: 1000, look: { colour: '#C00000', bold: true } }, at('B2:B9'), sheets)
    const scale = ruleModel({ kind: 'scale', range: 'B2:B9', colours: ['#F8696B', '#63BE7B'] }, at('B2:B9'), sheets)
    const dv = ruleModel({ kind: 'list', range: 'C2:C9', items: ['Open', 'Done'] }, at('C2:C9'), sheets)
    const name = ruleModel({ kind: 'name', name: 'Amounts', refersTo: 'B2:B9' }, null, sheets)
    if (cf.list !== 'conditional' || scale.list !== 'conditional' || dv.list !== 'validation' || name.list !== 'names') throw new Error('unexpected')
    wb.resources = [
      { name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: JSON.stringify({ sheet1: [cf.rule, scale.rule] }) },
      { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: JSON.stringify({ sheet1: [dv.rule] }) },
      { name: 'SHEET_DEFINED_NAME_PLUGIN', data: JSON.stringify({ [name.rule.id]: name.rule }) },
      { name: 'SHEET_FILTER_PLUGIN', data: JSON.stringify({ sheet1: { ref: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 } } }) }
    ]
    return wb
  }

  it('reads each list from the snapshot by its tab\'s name in the file', () => {
    const edits = rulesOf(ruled(), (id) => (id === 'sheet1' ? 'Q1 Budget' : undefined))
    expect(edits.map((e) => [e.kind, 'sheet' in e ? e.sheet : null])).toEqual([
      ['names', null],
      ['conditional', 'Q1 Budget'],
      ['validation', 'Q1 Budget'],
      ['filter', 'Q1 Budget']
    ])
    // a sheet that is gone, an empty list and a resource that does not parse give nothing
    const odd = made()
    odd.resources = [
      { name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: JSON.stringify({ gone: [{ cfId: 'x' }], sheet1: [] }) },
      { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: '{not json' }
    ]
    expect(rulesOf(odd, (id) => (id === 'sheet1' ? 'Q1 Budget' : undefined))).toEqual([])
  })

  it('writes them into the .xlsx, where the importer and the rules reader find each again', () => {
    const { bytes, left } = writeXlsxWhole(ruled())
    expect(left).toEqual([])
    const got = readRules(bytes)
    const tab = got.sheets['Q1 Budget']!
    expect(tab.conditional.map((r) => (r.rule as { type: string; subType?: string }).subType ?? (r.rule as { type: string }).type)).toEqual(['number', 'colorScale'])
    expect(tab.conditional[0]).toMatchObject({ ranges: [{ startRow: 1, endRow: 8, startColumn: 1, endColumn: 1 }], rule: { operator: 'greaterThan', value: 1000, style: { bl: 1 } } })
    expect(tab.validation).toHaveLength(1)
    expect(tab.validation[0]).toMatchObject({ type: 'list', formula1: 'Open,Done', showErrorMessage: true })
    expect(tab.filter).toMatchObject({ ref: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 } })
    expect(Object.values(got.names).map((n) => [n.name, n.formulaOrRefString])).toEqual([['Amounts', "'Q1 Budget'!$B$2:$B$9"]])
    // the cells and their styles are what they were without the rules
    const { workbook } = importXlsx(bytes)
    const plain = importXlsx(writeXlsx(made())).workbook
    const first = workbook.sheetOrder[0]!
    expect(workbook.sheets[first]!.cellData).toEqual(plain.sheets[plain.sheetOrder[0]!]!.cellData)
    // and writeXlsx is the same bytes
    expect(Buffer.from(writeXlsx(ruled())).equals(Buffer.from(bytes))).toBe(true)
  })

  it('leaves out a list the file cannot hold and says which, keeping the others', () => {
    const wb = ruled()
    const names = wb.resources!.find((r) => r.name === 'SHEET_DEFINED_NAME_PLUGIN')!
    names.data = JSON.stringify({ bad: { id: 'bad', name: 'two words', formulaOrRefString: '=1' } })
    const { bytes, left } = writeXlsxWhole(wb)
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ what: 'names' })
    expect(left[0]!.why).toContain('two words')
    const got = readRules(bytes)
    expect(Object.keys(got.names)).toEqual([])
    expect(got.sheets['Q1 Budget']!.conditional).toHaveLength(2)
    expect(got.sheets['Q1 Budget']!.validation).toHaveLength(1)
  })
})

describe('the tables of a sheet made here, in its export', () => {
  /** A workbook with a header row and data, and a table over it as the grid's table plugin keeps one. */
  const withTable = (over: Record<string, unknown> = {}): IWorkbookData => {
    const wb = blankWorkbook('workbook', 'Budget')
    const id = wb.sheetOrder[0]!
    wb.sheets[id]!.name = 'Q1 Budget'
    wb.sheets[id]!.cellData = { 0: { 0: { v: 'Line' }, 1: { v: 'Qty' }, 2: { v: 'Each' } }, 1: { 0: { v: 'Venue' }, 1: { v: 1 }, 2: { v: 4200 } }, 2: { 0: { v: 'Audio' }, 1: { v: 2 }, 2: { v: 475 } } }
    const table = { id: 't1', name: 'Costs', range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 }, options: {}, columns: [], meta: {}, filters: {}, ...over }
    wb.resources = [...(wb.resources ?? []), { name: 'SHEET_TABLE_PLUGIN', data: JSON.stringify({ [id]: { tables: [table], tableFilteredOutRows: [] } }) }]
    return wb
  }

  it('reads each sheet\'s tables from the snapshot by its tab\'s name in the file', () => {
    const wb = withTable()
    expect(tablesOf(wb, () => 'Q1 Budget')).toMatchObject([{ kind: 'tables', sheet: 'Q1 Budget', tables: [{ id: 't1', name: 'Costs' }] }])
    expect(tablesOf(blankWorkbook('workbook', 'Empty'), () => 'Sheet1')).toEqual([])
  })

  it('writes them as real table parts: the table reader and the importer find the table again', () => {
    const { bytes, left } = writeXlsxWhole(withTable())
    expect(left).toEqual([])
    const read = readTables(bytes).sheets['Q1 Budget']!.tables
    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ name: 'Costs', range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 } })
    expect(read[0]!.columns.map((c) => c.displayName)).toEqual(['Line', 'Qty', 'Each'])
    const again = importXlsx(bytes).workbook
    const tables = JSON.parse(again.resources!.find((r) => r.name === 'SHEET_TABLE_PLUGIN')!.data) as Record<string, { tables: { name: string }[] }>
    expect(Object.values(tables)[0]!.tables.map((t) => t.name)).toEqual(['Costs'])
  })

  it('writes a cell\'s formula that names the table in the words Excel keeps in a file', () => {
    const wb = withTable()
    const id = wb.sheetOrder[0]!
    // inside the table: this row; outside it: the whole table by its bare name
    wb.sheets[id]!.cellData![1]![2] = { f: '=[@Qty]*100' }
    wb.sheets[id]!.cellData![6] = { 0: { f: '=ROWS(Costs)+SUM(Costs[Qty])' }, 1: { f: '=SUM(A1:A3)' } }
    const { bytes } = writeXlsxWhole(wb)
    const zip = readZip(bytes)
    const xml = readText(zip, [...zip.byName.keys()].find((name) => /worksheets\/sheet1\.xml$/.test(name))!)
    expect(xml).toContain('<f>Costs[[#This Row],[Qty]]*100</f>')
    expect(xml).toContain('<f>ROWS(Costs[])+SUM(Costs[Qty])</f>')
    expect(xml).toContain('<f>SUM(A1:A3)</f>')
  })

  it('leaves out the tables of a sheet the file cannot hold them on and says so, keeping the cells', () => {
    // a name Excel would not take for a table
    const { bytes, left } = writeXlsxWhole(withTable({ name: 'A1' }))
    expect(left).toMatchObject([{ what: 'tables', sheet: 'Q1 Budget' }])
    expect(readTables(bytes).sheets['Q1 Budget']?.tables ?? []).toEqual([])
    const again = importXlsx(bytes).workbook
    expect(again.sheets[again.sheetOrder[0]!]!.cellData?.[1]?.[0]?.v).toBe('Venue')
  })
})
