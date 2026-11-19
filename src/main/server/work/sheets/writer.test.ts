import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { blankWorkbook } from './host/backends'
import { SOFFICE } from './testing'
import { readCsv, writeCsv, writeXlsx } from './writer'

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
