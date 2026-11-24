import { describe, expect, it } from 'vitest'
import { NOTE_STOP, sheetStopWords, spillingIn, spillStopWords } from '@shared/work/sheets'
import { editsOf, formatsOf, mutationsOf, NOTE_MOVE, NOTE_REMOVE, NOTE_UPDATE, notesOf, NotSaved, SHEET_NOTE, SHEET_TEXT, UNSAVED } from './mutations'

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

describe('what our writer is told a cell holds', () => {
  const name = (id: string): string | undefined => (id === 's1' ? 'Data' : undefined)
  const cells = (cellValue: unknown) => [{ id: 'sheet.mutation.set-range-values', params: { subUnitId: 's1', cellValue } }]

  it('a cell held as text keeps its words as they are; one he typed with no type is read as Excel reads typing', () => {
    // Council r1 (Sol 6): "007" came back as 7, and text starting with "=" went in as a formula.
    expect(editsOf(cells({ 0: { 0: { v: '007', t: 1 }, 1: { v: '=not a formula', t: 4 }, 2: { v: '1200' }, 3: { v: '1200', t: 2 } } }), name, { rich: true })).toEqual([
      { sheet: 'Data', cell: 'A1', value: '007', literal: true },
      { sheet: 'Data', cell: 'B1', value: '=not a formula', literal: true },
      { sheet: 'Data', cell: 'C1', value: '1200' },
      { sheet: 'Data', cell: 'D1', value: '1200' }
    ])
  })

  it('a string written by the app (an agent\'s, a suggestion taken, a cell put back) is typed as text', () => {
    expect(mutationsOf('book', [{ sheet: 's1', row: 0, col: 0, cell: { v: '007' } }, { sheet: 's1', row: 0, col: 1, cell: { v: 7 } }, { sheet: 's1', row: 0, col: 2, cell: { f: '=A1' } }, { sheet: 's1', row: 0, col: 3, cell: null }])).toEqual([
      { id: 'sheet.mutation.set-range-values', params: { unitId: 'book', subUnitId: 's1', cellValue: { 0: { 0: { v: '007', f: null, t: 1 }, 1: { v: 7, f: null }, 2: { v: null, f: '=A1' }, 3: null } } } }
    ])
  })

  it('refuses a formula that can spill where our writer writes the file, in the words the canvas stops it with; Excel and Google take it', () => {
    // Council r1 (Sol 7): =SEQUENCE(3) was written as a plain formula and reported saved.
    const spill = cells({ 0: { 0: { f: '=SEQUENCE(3)' } } })
    expect(() => editsOf(spill, name, { rich: true })).toThrow(new NotSaved(spillStopWords('SEQUENCE')))
    expect(spillStopWords('SEQUENCE')).toBe('A formula with SEQUENCE is not saved in an Excel file yet. Make it in Excel')
    expect(editsOf(spill, name)).toEqual([{ sheet: 'Data', cell: 'A1', formula: '=SEQUENCE(3)' }])
    expect(editsOf(cells({ 0: { 0: { f: '=SUM(A2:A9)' } } }), name, { rich: true })).toEqual([{ sheet: 'Data', cell: 'A1', formula: '=SUM(A2:A9)' }])
  })

  it('finds a spilling function by name, past its storage prefix, and not in words in quotes or a sheet name', () => {
    expect(spillingIn('=SUM(_xlfn._xlws.FILTER(A1:A9,B1:B9>1))')).toBe('FILTER')
    expect(spillingIn('=sequence(3)')).toBe('SEQUENCE')
    expect(spillingIn('=IF(A1="SORT(",1,2)')).toBeNull()
    expect(spillingIn("='UNIQUE(x'!A1+1")).toBeNull()
    expect(spillingIn('=VLOOKUP(A1,B:C,2,0)')).toBeNull()
  })
})

describe('text in more than one style and notes, for an opened Excel file', () => {
  const name = (id: string): string | undefined => (id === 's1' ? 'Data' : undefined)
  const doc = { body: { dataStream: 'Net total\r\n', textRuns: [{ st: 4, ed: 9, ts: { bl: 1 } }] } }
  const cells = (cellValue: unknown) => [{ id: 'sheet.mutation.set-range-values', params: { subUnitId: 's1', cellValue } }]

  it('reads a rich cell before its `v`: a cell the editor made rich (`v: null`) is written with its words, never empty', () => {
    // (words, kept as they stand: a rich cell's text is never read as a number or a formula)
    expect(editsOf(cells({ 0: { 0: { v: null, f: null, si: null, p: doc } } }), name, { rich: true })).toEqual([{ sheet: 'Data', cell: 'A1', value: 'Net total', literal: true }])
    // Where the store keeps no runs (a workbook Excel or Google holds), it is refused, not written empty.
    expect(() => editsOf(cells({ 0: { 0: { v: null, p: doc } } }), name)).toThrow(UNSAVED.rich)
    expect(() => editsOf(cells({ 0: { 0: { v: null, p: { body: {} } } } }), name, { rich: true })).toThrow(UNSAVED.other)
    // An emptied rich cell clears it.
    expect(editsOf(cells({ 0: { 0: { v: null, p: { body: { dataStream: '\r\n', textRuns: [] } } } } }), name, { rich: true })).toEqual([{ sheet: 'Data', cell: 'A1', value: null }])
  })

  // (a run's `ts` is a whole font, as the grid writes it: the cell's italic is the first run's, which has none of its own)
  it("carries a rich cell's runs among the formats, by its tab, beside its style, and none of a formula's", () => {
    const got = formatsOf(cells({ 0: { 0: { v: null, p: doc } }, 2: { 1: { s: { it: 1 }, p: doc }, 2: { f: '=A1', p: doc } } }), name)
    expect(got).toEqual([
      { id: 'sheet.mutation.set-range-values', params: { subUnitId: 'Data', cellValue: { 2: { 1: { s: { it: 1 } } } } } },
      {
        id: SHEET_TEXT,
        params: {
          subUnitId: 'Data',
          cells: [
            { row: 0, column: 0, runs: [{ text: 'Net ' }, { text: 'total', font: { bold: true } }] },
            { row: 2, column: 1, runs: [{ text: 'Net ' }, { text: 'total', font: { bold: true } }] }
          ]
        }
      }
    ])
  })

  it("turns a note's new words into the notes writer's edit, refuses a removal, and needs nothing for a move", () => {
    expect(notesOf({ id: NOTE_UPDATE, params: { sheetId: 's1', row: 8, col: 0, note: { id: 'n', note: 'New words' } } }, name)).toEqual([{ id: SHEET_NOTE, params: { subUnitId: 'Data', row: 8, column: 0, text: 'New words' } }])
    expect(() => notesOf({ id: NOTE_REMOVE, params: { sheetId: 's1', noteId: 'n', row: 8, col: 0 } }, name)).toThrow(NOTE_STOP.remove)
    expect(notesOf({ id: NOTE_MOVE, params: { sheetId: 's1', noteId: 'n', newPosition: { row: 9, col: 0 } } }, name)).toEqual([])
    expect(() => notesOf({ id: NOTE_UPDATE, params: { sheetId: 'gone', row: 0, col: 0, note: { note: 'x' } } }, name)).toThrow('That sheet is not in the file.')
  })
})
