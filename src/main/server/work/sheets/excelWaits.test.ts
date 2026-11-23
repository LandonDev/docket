import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { waitsNote, waitsOf } from './excelWaits'

/** What waits in Excel (excelWaits.ts), counted from the real importer's report of the corpus and from reports by hand. */
const CORPUS = join(import.meta.dirname, 'harness/corpus')
const of = (name: string): string[] => waitsOf(importXlsx(new Uint8Array(readFileSync(join(CORPUS, name)))).report)
const said = (...unsupported: { kind: string; count: number; where?: string }[]): string[] => waitsOf({ unsupported })

describe('what waits in Excel, from the importer', () => {
  it('counts a workbook\'s pivot tables across its sheets, and never its caches beside them', () => {
    // pivot.xlsx: a pivot on each of two sheets over one cache.
    expect(of('pivot.xlsx')).toEqual(['2 pivot tables'])
  })

  it('counts charts across sheets and chart sheets once each', () => {
    // charts.xlsx: eleven charts on Data and a chart sheet holding one.
    expect(of('charts.xlsx')).toEqual(['12 charts'])
  })

  it('names macros without a count, and counts the form control beside them', () => {
    expect(of('macro.xlsm')).toEqual(['macros', 'a form control'])
  })

  it('says a link to another workbook', () => {
    expect(of('links_dest.xlsx')).toEqual(['a link to another workbook'])
  })

  it('says nothing of a workbook our grid reaches whole, or of what it only draws differently', () => {
    for (const name of ['formulas.xlsx', 'formats.xlsx', 'conditional.xlsx', 'validation.xlsx', 'tables.xlsx', 'layout.xlsx', 'objects.xlsx', 'threaded_comments.xlsx']) expect(of(name), name).toEqual([])
  })
})

describe('the words', () => {
  it('says one as one and many with their count, in a fixed order whatever the report\'s', () => {
    expect(
      said(
        { kind: 'dataTables', count: 1 },
        { kind: 'externalLinks', count: 3 },
        { kind: 'dataConnections', count: 2 },
        { kind: 'powerQuery', count: 4 },
        { kind: 'formControls', count: 5 },
        { kind: 'slicers', count: 1 },
        { kind: 'vbaProject', count: 1 },
        { kind: 'charts', count: 1 },
        { kind: 'pivotTables', count: 1 }
      )
    ).toEqual(['a pivot table', 'a chart', 'macros', 'a slicer', '5 form controls', 'Power Query', '2 data connections', 'links to 3 other workbooks', 'a what-if table'])
    expect(said({ kind: 'slicers', count: 2 }, { kind: 'dataConnections', count: 1 }, { kind: 'dataTables', count: 12 }, { kind: 'externalLinks', count: 1 })).toEqual(['2 slicers', 'a data connection', 'a link to another workbook', '12 what-if tables'])
  })

  it('counts a pivot cache where no table is left on a sheet, and a chart sheet with nothing drawn on it', () => {
    expect(said({ kind: 'pivotCaches', count: 2 })).toEqual(['2 pivot tables'])
    expect(said({ kind: 'chartsheets', count: 1, where: 'Chart1' })).toEqual(['a chart'])
  })

  it('groups a large count as a person reads it', () => {
    expect(said({ kind: 'charts', count: 1200, where: 'Data' })).toEqual(['1,200 charts'])
  })

  it('leaves out what the importer flags but Excel is not needed for', () => {
    expect(said({ kind: 'shapes', count: 3 }, { kind: 'sparklines', count: 2 }, { kind: 'sheetProtection', count: 1 }, { kind: 'images', count: 4 })).toEqual([])
  })
})

describe('what an agent is told', () => {
  it('says what the sheet tools do not reach in the workbook it read, and nothing where they reach all of it', () => {
    expect(waitsNote(of('pivot.xlsx'))).toBe('This workbook also holds 2 pivot tables: only Excel changes those, and the owner opens the file there with the switch beside the sheet.')
    expect(waitsNote(['a pivot table'])).toBe('This workbook also holds a pivot table: only Excel changes that, and the owner opens the file there with the switch beside the sheet.')
    expect(waitsNote(['2 pivot tables', 'a chart', 'macros'])).toContain('holds 2 pivot tables, a chart and macros: only Excel changes those')
    expect(waitsNote(of('formulas.xlsx'))).toBe('')
    expect(waitsNote(undefined)).toBe('')
  })
})
