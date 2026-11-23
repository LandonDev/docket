import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { IWorkbookData } from '@univerjs/core'
import { factsOfPackage, factsOfWorkbook, sheetDrops, sheetFor, XLS_ROWS, type BookFacts } from './previewFacts'

/** What "In this format" says, counted from the workbook in hand: the corpus's workbooks and made ones. */
const CORPUS = join(import.meta.dirname, 'harness/corpus')
const facts = (name: string): BookFacts => factsOfPackage(new Uint8Array(readFileSync(join(CORPUS, name))))

describe('a package is counted from its parts', () => {
  it('counts the conditional formats by kind, and their losses in Excel 97-2003', () => {
    const f = facts('conditional.xlsx')
    expect(f.conditional.total).toBeGreaterThan(0)
    expect(f.conditional.scales + f.conditional.bars + f.conditional.icons).toBeGreaterThan(0)
    const xls = sheetDrops('xls', f)
    // The editors plan measured 4,021 conditional formats in the corpus, the colour scales among them lost to Excel 97-2003.
    expect(f.conditional).toEqual({ total: 4021, scales: 1002, bars: 2, icons: 3 })
    expect(xls).toEqual(['1,002 colour scales stay behind', '2 data bars stay behind', '3 icon sets stay behind'])
    // OpenDocument keeps every conditional format (decision 8): nothing is said of them there.
    expect(sheetDrops('ods', f).some((l) => /colour scale|conditional/.test(l))).toBe(false)
  })

  it('makes tables plain ranges in Excel 97-2003, and keeps them in OpenDocument', () => {
    const f = facts('tables.xlsx')
    expect(f.tables).toBe(2)
    expect(sheetDrops('xls', f)).toContain('2 tables become plain ranges')
    expect(sheetDrops('ods', f)).toEqual([])
  })

  it('turns a chartsheet into a sheet holding its chart in OpenDocument, and draws every chart in a PDF', () => {
    const f = facts('charts.xlsx')
    expect(f.charts).toBe(12)
    const chartTab = f.sheets.find((s) => s.chart)!
    expect(chartTab).toBeTruthy()
    expect(sheetDrops('ods', f)).toEqual([`${chartTab.name} becomes a sheet holding its chart`])
    expect(sheetDrops('pdf', f)).toEqual([])
    expect(sheetDrops('print', f)).toEqual([])
    expect(sheetDrops('xlsx', f, { package: true })).toEqual([])
  })

  it('keeps one sheet\'s values in CSV: the other sheets, its formulas, its formatting and the charts stay behind', () => {
    const f = facts('formulas.xlsx')
    expect(sheetFor(f, 'Calc')!.formulas).toBe(149)
    const lines = sheetDrops('csv', f, { sheet: 'Calc' })
    expect(lines).toEqual(['5 other sheets stay behind', '149 formulas become their values'])
    expect(sheetDrops('tsv', f, { sheet: 'Calc' })).toEqual(lines)
    // The first sheet when none is named: Data, which has formatting and no formulas.
    expect(sheetDrops('csv', f)).toEqual(['5 other sheets stay behind', 'Formatting stays behind'])
    // The sheet's own charts: the chartsheet's chart goes with the chartsheet, said once.
    const charts = facts('charts.xlsx')
    expect(sheetDrops('csv', charts)).toEqual(['ChartSheet stays behind', '16 formulas become their values', '11 charts stay behind'])
    // The sheet's own rules: the other sheet's 4,000 go with it.
    expect(sheetDrops('csv', facts('conditional.xlsx'))).toEqual(['Many stays behind', '21 rules stay behind'])
    expect(sheetDrops('csv', facts('objects.xlsx'), { sheet: 'Second' })).toEqual(['Objects stays behind'])
  })

  it('says formatting stays behind only for a sheet that has some', () => {
    expect(sheetDrops('csv', facts('formats.xlsx'))).toContain('Formatting stays behind')
    expect(sheetFor(facts('formats.xlsx'))?.styled).toBe(true)
  })

  it('reads pictures and notes, which a web page and a CSV leave behind', () => {
    const f = facts('objects.xlsx')
    expect(f.pictures).toBe(2)
    expect(f.notes).toBeGreaterThan(0)
    expect(sheetDrops('html', f)).toContain('2 pictures stay behind')
  })

  it('reads the fit and the extent of a print fixture', () => {
    const f = facts('print/fit-width.xlsx')
    const tab = f.sheets[0]
    expect(tab.fit).toEqual({ wide: 1, tall: 0 })
    expect(tab.rows).toBe(86)
    expect(tab.cols).toBe(12)
  })
})

describe('the lines', () => {
  const made = (over: Partial<BookFacts> = {}): BookFacts => ({
    sheets: [{ name: 'Data', chart: false, formulas: 0, newFunctions: 0, rules: 0, charts: 0, pictures: 0, styled: false, rows: 0, cols: 0 }],
    conditional: { total: 0, scales: 0, bars: 0, icons: 0 },
    validations: 0,
    tables: 0,
    names: 0,
    charts: 0,
    newCharts: 0,
    pictures: 0,
    notes: 0,
    filters: 0,
    ours: 0,
    ...over
  })

  it('cuts rows and columns past Excel 97-2003\'s grid, by sheet', () => {
    const f = made({ sheets: [{ name: 'Log', chart: false, formulas: 0, newFunctions: 0, rules: 0, charts: 0, pictures: 0, styled: false, rows: XLS_ROWS + 34_464, cols: 300 }] })
    expect(sheetDrops('xls', f)).toEqual(['Log loses 34,464 rows past row 65,536', 'Log loses 44 columns past column IV'])
  })

  it('says nothing when nothing is lost', () => {
    for (const format of ['xlsx', 'pdf', 'print', 'ods', 'xls', 'csv', 'tsv', 'html'] as const) expect(sheetDrops(format, made())).toEqual([])
  })

  it('names a chart of a newer kind as not drawn, and in the Excel file as kept', () => {
    const f = made({ newCharts: 2 })
    expect(sheetDrops('pdf', f)).toEqual(['2 charts of newer kinds are not drawn'])
    expect(sheetDrops('xlsx', f, { package: true })).toEqual(['2 charts of newer kinds are not drawn here; the file keeps them'])
  })

  it('says what the model writer could not hold, and the charts made here, for a sheet the service holds', () => {
    const f = made({ ours: 1, notes: 3 })
    expect(sheetDrops('xlsx', f, { left: ['the names', 'the filter on Q1'] })).toEqual(['3 notes stay behind', 'The names stay behind', 'The filter on Q1 stays behind', '1 chart made here stays behind'])
    expect(sheetDrops('pdf', f)).toEqual(['1 chart made here stays behind'])
  })

  it('names up to three other sheets, and counts more', () => {
    const tab = (name: string) => ({ name, chart: false, formulas: 0, newFunctions: 0, rules: 0, charts: 0, pictures: 0, styled: false, rows: 1, cols: 1 })
    expect(sheetDrops('csv', made({ sheets: [tab('Budget'), tab('Flights'), tab('Hotel')] }))).toEqual(['Flights and Hotel stay behind'])
    expect(sheetDrops('csv', made({ sheets: [tab('A'), tab('B'), tab('C'), tab('D'), tab('E')] }), { sheet: 'C' })).toEqual(['4 other sheets stay behind'])
  })
})

describe('a sheet the service holds is counted from its snapshot', () => {
  it('counts formulas, styles, rules and notes from the cells and resources', () => {
    const wb = {
      id: 'w',
      sheetOrder: ['s1', 's2'],
      sheets: {
        s1: { id: 's1', name: 'Q1', cellData: { 0: { 0: { v: 1 }, 1: { f: '=A1*2', v: 2, s: 'x' } }, 4: { 2: { v: 'end' } } } },
        s2: { id: 's2', name: 'Q2', cellData: {} }
      },
      resources: [
        { name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: JSON.stringify({ s1: [{ rule: { type: 'colorScale' } }, { rule: { type: 'highlightCell' } }] }) },
        { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: JSON.stringify({ s1: [{ uid: 'v' }] }) },
        { name: 'SHEET_NOTE_PLUGIN', data: JSON.stringify({ s1: { 0: { 0: { note: 'n' } } } }) }
      ]
    } as unknown as IWorkbookData
    const f = factsOfWorkbook(wb, 2)
    expect(f.sheets[0]).toMatchObject({ name: 'Q1', formulas: 1, styled: true, rows: 5, cols: 3 })
    expect(f.conditional).toEqual({ total: 2, scales: 1, bars: 0, icons: 0 })
    expect(f.validations).toBe(1)
    expect(f.notes).toBe(1)
    expect(sheetDrops('xls', f)).toEqual(['1 colour scale stays behind', '2 charts made here stay behind'])
    expect(sheetDrops('csv', f, { sheet: 'Q1' })).toEqual(['Q2 stays behind', '1 formula becomes its value', 'Formatting stays behind', '3 rules stay behind', '2 charts made here stay behind'])
  })
})

describe('functions Excel 97-2003 does not have', () => {
  it('counts the formulas that name one (`_xlfn.`), shared ones by their cells', () => {
    const f = facts('formulas.xlsx')
    expect(f.sheets.map((t) => t.newFunctions)).toEqual([0, 24, 15, 0, 0, 0])
    expect(sheetDrops('xls', f)).toEqual(['39 formulas use functions Excel 97-2003 does not have'])
    expect(sheetDrops('xls', facts('tables.xlsx'))).toContain('1 formula uses a function Excel 97-2003 does not have')
    expect(sheetDrops('ods', f)).toEqual([])
  })

  it('reads them from a held sheet\'s formulas as the file would write them', () => {
    const wb = { id: 'w', sheetOrder: ['s1'], sheets: { s1: { id: 's1', name: 'Q1', cellData: { 0: { 0: { f: '=XLOOKUP(1,A2:A9,B2:B9)', v: 3 }, 1: { f: '=SUM(A1:A9)', v: 4 } } } } } } as unknown as IWorkbookData
    expect(factsOfWorkbook(wb).sheets[0].newFunctions).toBe(1)
    expect(sheetDrops('xls', factsOfWorkbook(wb))).toEqual(['1 formula uses a function Excel 97-2003 does not have'])
  })
})
