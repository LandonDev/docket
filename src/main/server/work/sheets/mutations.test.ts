import { describe, expect, it } from 'vitest'
import { sheetStopWords } from '@shared/work/sheets'
import { editsOf, formatsOf, NotSaved, UNSAVED } from './mutations'

/**
 * What an opened Excel file cannot keep is stopped by the canvas as he makes it and refused by the
 * host for any other caller: both in the same words.
 */
describe('what an Excel file cannot keep', () => {
  it('is said by the host in the words the canvas stops it with, and names where the workbook lives', () => {
    for (const kind of ['moved', 'rich', 'fill', 'other'] as const) expect(UNSAVED[kind]).toBe(sheetStopWords(kind))
    expect(sheetStopWords('other')).toBe('That change is not saved in an Excel file yet. Make it in Excel')
    expect(sheetStopWords('other', true)).toBe('That change is not saved in a Google sheet yet. Make it in Google Sheets')
    expect(sheetStopWords('moved', true)).toBe('Move this in Google Sheets')
    expect(sheetStopWords('moved', false, 'table')).toBe('Move this in Excel: it crosses a table')
  })

  const name = (id: string): string | undefined => (id === 's1' ? 'Data' : undefined)
  const cells = (cellValue: unknown) => [{ id: 'sheet.mutation.set-range-values', params: { subUnitId: 's1', cellValue } }]

  it('refuses each kind with its sentence, and nothing of a cell that only takes a style', () => {
    expect(() => editsOf([{ id: 'sheet.mutation.move-range', params: { subUnitId: 's1' } }], name)).toThrow(UNSAVED.moved)
    expect(() => editsOf([{ id: 'sheet.mutation.set-row-hidden', params: { subUnitId: 's1' } }], name)).toThrow(UNSAVED.other)
    expect(() => editsOf(cells({ 0: { 0: { p: { body: {} } } } }), name)).toThrow(UNSAVED.rich)
    expect(() => editsOf(cells({ 0: { 0: { si: 'x' } } }), name)).toThrow(UNSAVED.fill)
    expect(() => editsOf(cells({ 0: { 0: { t: 2 } } }), name)).toThrow(NotSaved)
    expect(editsOf(cells({ 0: { 0: { s: { bl: 1 } }, 1: { v: 5, s: { it: 1 } } } }), name)).toEqual([{ sheet: 'Data', cell: 'B1', value: 5 }])
  })

  it('carries a cell\'s style and the size and merge mutations as formats, each named by its tab', () => {
    const range = { startRow: 0, endRow: 0, startColumn: 2, endColumn: 2 }
    const got = formatsOf(
      [...cells({ 0: { 0: { s: { bl: 1 } }, 1: { v: 5 } } }), { id: 'sheet.mutation.set-worksheet-col-width', params: { subUnitId: 's1', ranges: [range], colWidth: 160 } }, { id: 'sheet.mutation.set-worksheet-row-is-auto-height', params: { subUnitId: 's1', ranges: [range], autoHeightInfo: 1 } }, { id: 'sheet.mutation.insert-row', params: { subUnitId: 's1' } }],
      name
    )
    expect(got).toEqual([
      { id: 'sheet.mutation.set-range-values', params: { subUnitId: 'Data', cellValue: { 0: { 0: { s: { bl: 1 } } } } } },
      { id: 'sheet.mutation.set-worksheet-col-width', params: { subUnitId: 'Data', ranges: [range], colWidth: 160 } },
      { id: 'sheet.mutation.set-worksheet-row-is-auto-height', params: { subUnitId: 'Data', ranges: [range], autoHeightInfo: 1 } }
    ])
    expect(() => formatsOf(cells({ 0: { 0: { s: null } } }).map((m) => ({ ...m, params: { ...m.params, subUnitId: 'gone' } })), name)).toThrow('That sheet is not in the file.')
  })
})
