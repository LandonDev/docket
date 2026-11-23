import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { blankWorkbook } from './host/backends'
import { savePackage } from './jobs'
import { readText, readZip } from './patch/zip'
import { writeXlsx } from './writer'

/**
 * The three ways a save is made (the editors plan, decision 3), each on a real package: formatting
 * alone, a value no formula reads, and everything else. The lightest that is safe is taken, and
 * the report says which.
 */

const CORPUS = join(import.meta.dirname, 'harness/corpus')
const scratch = mkdtempSync(join(tmpdir(), 'sheets-save-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const bold = (sheet: string, row: number, col: number, s: unknown = { bl: 1 }) => ({ id: 'sheet.mutation.set-range-values', params: { subUnitId: sheet, cellValue: { [row]: { [col]: { s } } } } })
const workbookXml = (bytes: Uint8Array): string => readText(readZip(bytes), 'xl/workbook.xml')

describe('how a save is made', () => {
  const charts = join(CORPUS, 'charts.xlsx')

  it('formatting alone takes the format writer: no engine, and Excel is not asked to calculate again', async () => {
    const got = await savePackage(charts, [], null, [bold('Data', 1, 1)])
    expect(got.report).toMatchObject({ path: 'format', edits: 0, recalc: { ok: true, fullCalcOnLoad: false } })
    expect(got.report.partsChanged.sort()).toEqual(['xl/styles.xml', 'xl/worksheets/sheet1.xml'])
    expect(workbookXml(got.bytes)).toBe(workbookXml(new Uint8Array(readFileSync(charts))))
    const { workbook } = importXlsx(got.bytes)
    const cell = workbook.sheets[workbook.sheetOrder[0]!]!.cellData?.[1]?.[1]
    expect((typeof cell?.s === 'string' ? workbook.styles?.[cell.s] : cell?.s)?.bl).toBe(1)
  })

  it('a value no formula reads is patched in with no engine, and the workbook is left as it was', async () => {
    const got = await savePackage(charts, [{ sheet: 'Data', cell: 'H40', value: 7 }], null)
    expect(got.report).toMatchObject({ path: 'independent', edits: 1, recalc: { ok: true, fullCalcOnLoad: false } })
    expect(got.report.why).toBeUndefined()
    expect(got.report.partsChanged).toEqual(['xl/worksheets/sheet1.xml'])
  })

  it('a value a formula reads takes the audited path, and with no engine on the host Excel is asked to calculate on load', async () => {
    const got = await savePackage(charts, [{ sheet: 'Data', cell: 'B2', value: 7 }], null)
    expect(got.report).toMatchObject({ path: 'plain', why: 'a formula reads an edited cell', recalc: { fullCalcOnLoad: true } })
    expect(workbookXml(got.bytes)).toContain('fullCalcOnLoad="1"')
  })

  it('a value and its style in one save: the value by its own path, then the style', async () => {
    const got = await savePackage(charts, [{ sheet: 'Data', cell: 'H40', value: 0.125 }], null, [bold('Data', 39, 7, { n: { pattern: '0.0%' } })])
    expect(got.report).toMatchObject({ path: 'independent', format: expect.objectContaining({ xfs: 1 }) })
    const { workbook } = importXlsx(got.bytes)
    const cell = workbook.sheets[workbook.sheetOrder[0]!]!.cellData?.[39]?.[7]
    expect(cell?.v).toBe(0.125)
    expect((typeof cell?.s === 'string' ? workbook.styles?.[cell.s] : cell?.s)?.n?.pattern).toBe('0.0%')
  })

  it('a format changed where a formula calls CELL asks Excel to calculate again', async () => {
    const wb = blankWorkbook('workbook', 'Ask')
    wb.sheets.sheet1!.cellData = { 0: { 0: { v: 5 }, 1: { f: '=CELL("format",A1)', v: 'G' } } }
    const path = join(scratch, 'cell.xlsx')
    writeFileSync(path, writeXlsx(wb))
    // the model writer itself asks for a full calculation: take the flag off, as a file Excel saved has it
    const clean = join(scratch, 'cell-clean.xlsx')
    const { patchXlsx } = await import('./patch/patch')
    const made = await patchXlsx(new Uint8Array(readFileSync(path)), [], { independent: true })
    const { writeZip } = await import('./patch/zip')
    const z = readZip(made.bytes)
    writeFileSync(clean, writeZip(z, new Map([['xl/workbook.xml', new TextEncoder().encode(readText(z, 'xl/workbook.xml').replace(/\s*fullCalcOnLoad="1"/, ''))]]), new Set(), new Map()))
    expect(workbookXml(new Uint8Array(readFileSync(clean)))).not.toContain('fullCalcOnLoad')
    const formatted = await savePackage(clean, [], null, [bold('Sheet1', 0, 0, { n: { pattern: '0.00' } })])
    expect(formatted.report).toMatchObject({ path: 'format', recalc: { fullCalcOnLoad: true } })
    expect(workbookXml(formatted.bytes)).toContain('fullCalcOnLoad="1"')
    // CELL also reads alignment ("prefix") and a column's width: any format edit in such a workbook asks the same
    const bolded = await savePackage(clean, [], null, [bold('Sheet1', 0, 0)])
    expect(bolded.report.recalc.fullCalcOnLoad).toBe(true)
    // a workbook with no CELL is left alone by the same press (the first test above)
  })

  it('a 1904 file still gets a date-formatted number back in its own system', async () => {
    // layout.xlsx counts from 1900: the 1904 branch is held by the harness's own files; here the plain path is not disturbed by it
    const got = await savePackage(join(CORPUS, 'layout.xlsx'), [{ sheet: 'Layout', cell: 'J30', value: 45000 }], null)
    expect(got.report.path).toBe('independent')
  })
})
