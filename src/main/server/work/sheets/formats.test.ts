import { describe, expect, it } from 'vitest'
import { OFFICE_THEME, TEMPCODE_THEME } from 'work-kit/format/theme'
import { CELL_STYLES, namedStyle, styleOf, themeTag } from 'work-kit/sheet/format'
import { ADD_MERGE, AUTO_HEIGHT, COL_WIDTH, colourOf, formatEditsOf, formatOf, rectsOf, REMOVE_MERGE, ROW_HEIGHT, SET_RANGE_VALUES } from './formats'

/**
 * The grid's formatting mutations as the patch writer's format edits: each key the row can lay,
 * as the one field of the file's format that says the same thing.
 */

const cells = (sheet: string, cellValue: Record<number, Record<number, { s: unknown }>>) => ({ id: SET_RANGE_VALUES, params: { subUnitId: sheet, cellValue } })
const tab = (id: string): string | undefined => (id === 'Data' ? 'Data' : undefined)

describe('a style change as a format', () => {
  it('maps each key the row lays to its field, and a cleared key to the field given back', () => {
    expect(formatOf({ bl: 1 })).toEqual({ font: { bold: true } })
    expect(formatOf({ bl: null, it: 1, ul: { s: 1 }, st: null })).toEqual({ font: { bold: false, italic: true, underline: true, strike: false } })
    expect(formatOf({ ff: 'Cambria', fs: 14 })).toEqual({ font: { name: 'Cambria', size: 14 } })
    // a family or a size cleared goes back to the workbook's default font
    expect(formatOf({ ff: null, fs: null })).toEqual({ font: { name: null, size: null } })
    expect(formatOf({ cl: { rgb: '#c00000' }, bg: { rgb: 'rgb(255, 221, 102)' } })).toEqual({ font: { color: { rgb: 'C00000' } }, fill: { rgb: 'FFDD66' } })
    expect(formatOf({ cl: null, bg: null })).toEqual({ font: { color: null }, fill: null })
    expect(formatOf({ ht: 3, vt: 2, tb: 3 })).toEqual({ align: { horizontal: 'right', vertical: 'center', wrap: true } })
    expect(formatOf({ ht: null, vt: null, tb: null })).toEqual({ align: { horizontal: null, vertical: null, wrap: false } })
    expect(formatOf({ n: { pattern: '0.00%' } })).toEqual({ numFmt: '0.00%' })
    expect(formatOf({ n: null })).toEqual({ numFmt: 'General' })
    expect(formatOf({ tr: { a: 45 } })).toEqual({ align: { rotation: 45 } })
    expect(formatOf({ va: 3 })).toEqual({ font: { vertAlign: 'superscript' } })
  })

  it('writes a theme colour as its slot and tint, as the grid tagged it', () => {
    expect(colourOf({ rgb: '#366092', th: themeTag({ theme: 'accent1', tint: -0.25 }) })).toEqual({ theme: 4, tint: -0.25 })
    expect(colourOf({ rgb: '#FFFFFF', th: themeTag({ theme: 'lt1' }) })).toEqual({ theme: 0 })
    expect(colourOf({ rgb: '#000000', th: themeTag({ theme: 'dk1', tint: -1 }) })).toEqual({ theme: 1, tint: -1 })
    // one of Univer's own numbers is no tag of ours
    expect(colourOf({ rgb: '#123456', th: 3 })).toEqual({ rgb: '123456' })
    expect(colourOf({ rgb: 'not a colour' })).toBeNull()
  })

  it('maps borders edge by edge: an edge named, an edge cleared, every edge cleared', () => {
    expect(formatOf({ bd: { t: { s: 1, cl: { rgb: '#000000' } }, b: { s: 7, cl: { rgb: '#000000' } } } })).toEqual({ border: { top: { style: 'thin', color: { rgb: '000000' } }, bottom: { style: 'double', color: { rgb: '000000' } } } })
    expect(formatOf({ bd: { t: null, l: { s: 13 } } })).toEqual({ border: { top: null, left: { style: 'thick' } } })
    expect(formatOf({ bd: null })).toEqual({ border: { top: null, bottom: null, left: null, right: null, diagonal: null } })
  })

  it('no formatting at all is a clear; a change with nothing a file keeps is nothing', () => {
    expect(formatOf(null)).toEqual({ clear: true })
    expect(formatOf({})).toBeNull()
    expect(formatOf({ pd: { t: 1 } })).toBeNull()
  })

  it('what the row lays for each press is a format the file can take', () => {
    for (const change of [{ bold: true }, { italic: false }, { underline: true }, { strike: true }, { family: 'Arial' }, { size: 9 }, { colour: { theme: 'accent2', tint: 0.4 } as const }, { fill: null }, { align: 'center' as const }, { vertical: 'top' as const }, { wrap: true }, { pattern: '"$"#,##0.00' }]) {
      const laid = styleOf(change, OFFICE_THEME, '')
      expect(formatOf(laid!), JSON.stringify(change)).not.toBeNull()
    }
  })
})

describe('a named style', () => {
  it('is named to the file by its builtinId, with the look the grid drew; Normal is a clear', () => {
    const by = (id: string) => formatOf(namedStyle(CELL_STYLES.find((s) => s.id === id)!, OFFICE_THEME), OFFICE_THEME)
    expect(by('normal')).toEqual({ clear: true })
    expect(by('currency')).toEqual({ namedStyle: 4, namedOnly: true, numFmt: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)' })
    const heading = by('heading1')!
    expect(heading).toMatchObject({ namedStyle: 16, namedOnly: true, font: { bold: true, size: 15, name: null, italic: false, color: { theme: 3 } }, border: { top: null, left: null, right: null, bottom: { style: 'thick', color: { theme: 4 } } } })
    expect(by('good')).toMatchObject({ namedStyle: 26, namedOnly: true, font: { color: { rgb: '006100' } }, fill: { rgb: 'C6EFCE' } })
  })

  it('is told by the file\'s own theme: under another theme the same keys are plain formatting', () => {
    const laid = namedStyle(CELL_STYLES.find((s) => s.id === 'heading1')!, TEMPCODE_THEME)
    expect(formatOf(laid, TEMPCODE_THEME)?.namedStyle).toBe(16)
    // no theme given: nothing is named
    expect(formatOf(laid)?.namedStyle).toBeUndefined()
  })
})

describe('cells as rectangles', () => {
  it('joins runs along a row and down while they line up', () => {
    const block: [number, number][] = []
    for (let r = 2; r <= 5; r++) for (let c = 1; c <= 3; c++) block.push([r, c])
    expect(rectsOf(block)).toEqual([{ startRow: 2, endRow: 5, startColumn: 1, endColumn: 3 }])
    expect(rectsOf([[0, 0], [0, 1], [1, 0], [3, 0], [3, 1]])).toEqual([
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 },
      { startRow: 1, endRow: 1, startColumn: 0, endColumn: 0 },
      { startRow: 3, endRow: 3, startColumn: 0, endColumn: 1 }
    ])
    // the frame of a range: its edges, not its middle
    expect(rectsOf([[0, 0], [0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1], [2, 2]])).toHaveLength(4)
  })

  it('takes 20,000 cells in one pass', () => {
    const many: [number, number][] = []
    for (let r = 0; r < 2000; r++) for (let c = 0; c < 10; c++) many.push([r, c])
    expect(rectsOf(many)).toEqual([{ startRow: 0, endRow: 1999, startColumn: 0, endColumn: 9 }])
  })
})

describe('mutations as format edits', () => {
  it('gathers cells with the same change into one edit over their rectangles, in the order the changes came', () => {
    const bold = { s: { bl: 1 } }
    const got = formatEditsOf([cells('Data', { 0: { 0: bold, 1: bold }, 1: { 0: bold, 1: bold }, 4: { 2: { s: { it: 1 } } } })], tab)
    expect(got).toEqual([
      { kind: 'cells', sheet: 'Data', ranges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }], format: { font: { bold: true } } },
      { kind: 'cells', sheet: 'Data', ranges: [{ startRow: 4, endRow: 4, startColumn: 2, endColumn: 2 }], format: { font: { italic: true } } }
    ])
  })

  it('a cell with no style in the mutation makes no edit; a sheet that is not the file\'s makes none', () => {
    expect(formatEditsOf([{ id: SET_RANGE_VALUES, params: { subUnitId: 'Data', cellValue: { 0: { 0: { v: 5 } }, 1: { 0: null } } } }], tab)).toEqual([])
    expect(formatEditsOf([cells('Gone', { 0: { 0: { s: { bl: 1 } } } })], tab)).toEqual([])
  })

  it('refuses a style named by the grid\'s own id: this file\'s ids are not the grid\'s, and the canvas sends the style itself', () => {
    expect(() => formatEditsOf([cells('Data', { 2: { 3: { s: 'k9' } } })], tab)).toThrow('That formatting could not be read')
  })

  it('sizes keyed by the column\'s or the row\'s own index: an undo, a drag of several', () => {
    const range = { startRow: 0, endRow: 0, startColumn: 2, endColumn: 5 }
    const got = formatEditsOf([{ id: COL_WIDTH, params: { subUnitId: 'Data', ranges: [range], colWidth: { 2: 88, 3: 88, 4: 160, 5: null } } }], tab)
    // C:D at one width, E at another, F (named with no size) back to the sheet's default; a column the mutation does not name is left alone
    expect(got.map((e) => [e.kind, (e as { from: number }).from, (e as { to: number }).to, (e as { width: number | null }).width === null])).toEqual([
      ['colWidth', 2, 3, false],
      ['colWidth', 4, 4, false],
      ['colWidth', 5, 5, true]
    ])
    expect(formatEditsOf([{ id: COL_WIDTH, params: { subUnitId: 'Data', ranges: [range], colWidth: { 3: 120 } } }], tab)).toHaveLength(1)
    const rows = formatEditsOf([{ id: ROW_HEIGHT, params: { subUnitId: 'Data', ranges: [{ startRow: 3, endRow: 4, startColumn: 0, endColumn: 0 }], rowHeight: { 3: 40, 4: 40 } } }], tab)
    expect(rows).toEqual([{ kind: 'rowHeight', sheet: 'Data', from: 3, to: 4, height: 30 }])
  })

  it('a row told to fit what it holds gives its own height back to the file', () => {
    const range = { startRow: 6, endRow: 7, startColumn: 0, endColumn: 0 }
    expect(formatEditsOf([{ id: AUTO_HEIGHT, params: { subUnitId: 'Data', ranges: [range], autoHeightInfo: 1 } }], tab)).toEqual([{ kind: 'rowHeight', sheet: 'Data', from: 6, to: 7, height: null }])
    expect(formatEditsOf([{ id: AUTO_HEIGHT, params: { subUnitId: 'Data', ranges: [range], autoHeightInfo: 0 } }], tab)).toEqual([])
  })

  it('a column\'s width in characters, a row\'s height in points, a merge made and parted', () => {
    const range = { startRow: 3, endRow: 4, startColumn: 1, endColumn: 2 }
    const got = formatEditsOf(
      [
        { id: COL_WIDTH, params: { subUnitId: 'Data', ranges: [range], colWidth: 96 } },
        { id: ROW_HEIGHT, params: { subUnitId: 'Data', ranges: [range], rowHeight: 28 } },
        { id: ADD_MERGE, params: { subUnitId: 'Data', ranges: [range] } },
        { id: REMOVE_MERGE, params: { subUnitId: 'Data', ranges: [range] } }
      ],
      tab
    )
    expect(got[0]).toMatchObject({ kind: 'colWidth', sheet: 'Data', from: 1, to: 2 })
    expect((got[0] as { width: number }).width).toBeGreaterThan(12)
    expect(got[1]).toEqual({ kind: 'rowHeight', sheet: 'Data', from: 3, to: 4, height: 21 })
    expect(got[2]).toEqual({ kind: 'merge', sheet: 'Data', range })
    expect(got[3]).toEqual({ kind: 'unmerge', sheet: 'Data', range })
  })
})
