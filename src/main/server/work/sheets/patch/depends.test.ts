import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { independent, type DependsInput } from './depends'
import { dependsInput } from './package'
import type { EditSpec } from './patch'

/**
 * The proof that a typed value has no dependents (the editors plan, decision 3): held case by
 * case on small sheets, then on the corpus's real files. A wrong "independent" is a stale
 * number in a saved file, so every case that is not plainly safe must answer why.
 */

const sheet = (name: string, cells: string): DependsInput['sheets'][number] => ({ name, xml: () => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>` })
const f = (at: string, text: string, attrs = ''): string => `<row r="${/\d+/.exec(at)![0]}"><c r="${at}"><f${attrs}>${text}</f><v>0</v></c></row>`
const book = (sheets: DependsInput['sheets'], more: Partial<DependsInput> = {}): DependsInput => ({ sheets, workbookXml: '<workbook/>', tables: [], macros: false, ...more })
const set = (cell: string, sheetName = 'Data', value: EditSpec['value'] = 5): EditSpec => ({ sheet: sheetName, cell, value })
const why = (input: DependsInput, ...edits: EditSpec[]): string | true => {
  const got = independent(input, edits)
  return got.independent ? true : got.why
}

describe('a value nothing reads', () => {
  it('is independent when no formula names its cell, its row or its column', () => {
    const input = book([sheet('Data', f('C1', 'A1+B1') + f('C2', 'SUM(A2:B2)') + f('D9', 'SUM(F:F)') + f('D10', 'SUM(20:20)'))])
    expect(independent(input, [set('A5'), set('B7')])).toEqual({ independent: true, formulas: 4 })
    expect(why(input, set('E1'))).toBe(true)
  })

  it('counts a workbook with no formulas at all as independent', () => {
    expect(independent(book([sheet('Data', '<row r="1"><c r="A1"><v>1</v></c></row>')]), [set('A1')])).toEqual({ independent: true, formulas: 0 })
  })

  it('takes a rule\'s <formula>, a filter column and the like for what they are: not cell formulas', () => {
    const input = book([{ name: 'Data', xml: () => `<worksheet><sheetData>${f('C1', 'B1*2')}</sheetData><conditionalFormatting sqref="A1:A9"><cfRule type="expression"><formula>A1&gt;3</formula></cfRule></conditionalFormatting><autoFilter ref="A1:C9"><filterColumn colId="0"/></autoFilter></worksheet>` }])
    expect(independent(input, [set('A1')])).toEqual({ independent: true, formulas: 1 })
  })
})

describe('a value something reads', () => {
  const input = book([sheet('Data', f('C1', 'A1+B1') + f('C2', 'SUM(A2:B4)') + f('D9', 'SUM(F:F)') + f('D10', 'SUM(20:20)') + f('D11', '$A$7*2')), sheet('Summary', f('A1', 'Data!A9') + f('A2', "SUM('Data'!B10:B12)") + f('A3', 'A30'))])

  it.each([
    ['a cell', 'A1'],
    ['a range', 'B3'],
    ['a whole column', 'F400'],
    ['a whole row', 'K20'],
    ['an absolute reference', 'A7'],
    ['another sheet\'s reference', 'A9'],
    ['another sheet\'s quoted range', 'B11']
  ])('is not independent when a formula reads it through %s', (_how, cell) => {
    expect(why(input, set(cell))).toBe('a formula reads an edited cell')
  })

  it('reads a reference on the formula\'s own sheet only', () => {
    // Summary!A3 reads Summary!A30, not Data!A30
    expect(why(input, set('A30'))).toBe(true)
    expect(why(input, set('A30', 'Summary'))).toBe('a formula reads an edited cell')
  })

  it('matches a sheet\'s name whatever its case', () => {
    expect(why(book([sheet('Data', ''), sheet('S', f('A1', 'DATA!A1'))]), set('A1'))).toBe('a formula reads an edited cell')
  })
})

describe('a shared formula', () => {
  it('speaks for every follower: each relative reference grows by the shared range', () => {
    // C2:C6 is =A2*$B$1 filled down: its followers read A3:A6
    const cells = f('C2', 'A2*$B$1', ' t="shared" ref="C2:C6" si="0"') + ['C3', 'C4', 'C5', 'C6'].map((at) => `<row r="${at.slice(1)}"><c r="${at}"><f t="shared" si="0"/><v>0</v></c></row>`).join('')
    const input = book([sheet('Data', cells)])
    expect(independent(input, [set('E5')])).toEqual({ independent: true, formulas: 5 })
    expect(why(input, set('A5'))).toBe('a formula reads an edited cell')
    expect(why(input, set('B1'))).toBe('a formula reads an edited cell')
    // the absolute B1 does not grow
    expect(why(input, set('B4'))).toBe(true)
    expect(why(input, set('A8'))).toBe(true)
  })

  it('finds a formula\'s cell however its tag is written, and refuses one it cannot place', () => {
    const tables = [{ sheet: 'Data', name: 'T1', ref: 'A1:A2' }, { sheet: 'Data', name: 'T2', ref: 'G1:H9' }]
    const odd = { name: 'Data', xml: () => '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="5"><c\nr="H5"><f>[@x]*2</f><v>0</v></c></row></sheetData></worksheet>' }
    // the formula stands in T2 (H5), not in T1: an edit in T2 is read, one in T1 is not
    expect(why(book([odd], { tables }), set('G3'))).toBe('a formula reads a table an edited cell is in')
    expect(why(book([odd], { tables }), set('A2'))).toBe(true)
    const bare = { name: 'Data', xml: () => '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c><f>A1*2</f><v>2</v></c></row></sheetData></worksheet>' }
    expect(why(book([bare]), set('Z9'))).toBe('a formula cell with no address')
  })

  it('refuses a formula with no text that is no shared follower', () => {
    expect(why(book([sheet('Data', '<row r="1"><c r="C1"><f/><v>0</v></c></row>')]), set('A1'))).toBe('a formula with no text')
  })
})

describe('what the text cannot show takes the audited path', () => {
  it.each(['INDIRECT("A"&amp;B1)', 'OFFSET(D1,1,1)', 'CELL("contents")', 'GETPIVOTDATA("Sum",D1)', '_xlfn.CUBEVALUE("x")', 'CALL("user32","GetTickCount","J")', 'REGISTER.ID("lib","fn")'])('%s names cells its formula does not', (text) => {
    const got = why(book([sheet('Data', f('C1', text))]), set('A1'))
    expect(got).toMatch(/names cells its formula does not$/)
  })

  it.each(['SUMIF(A1:A10,"x",B1)', 'AVERAGEIF(A1:A10,"x",B1)', 'LOOKUP(5,A1:A10,B1)'])('%s is read at the size it really takes: its last range as large as the one before', (text) => {
    const input = book([sheet('Data', f('E1', text))])
    // B5 is in the ten cells the function reads from B1 down; B12 and D5 are not
    expect(why(input, set('B5'))).toBe('a formula reads an edited cell')
    expect(why(input, set('B12'))).toBe(true)
    expect(why(input, set('D5'))).toBe(true)
  })

  it('a budget full of SUMIFs still saves a lone value without the engine; a SUMIF over something that is no plain range does not', () => {
    const sums = f('F1', 'SUMIF(A:A,"Rent",C:C)') + f('F2', 'SUMIF(A1:A20,E2,C1:C20)') + f('F3', 'CELL("format",A1)') + f('F4', 'INFO("recalc")')
    expect(why(book([sheet('Data', sums)]), set('H9'))).toBe(true)
    expect(why(book([sheet('Data', sums)]), set('C7'))).toBe('a formula reads an edited cell')
    expect(why(book([sheet('Data', f('F1', 'SUMIF(A1:A10,"x",INDEX(B:B,1))'))]), set('H9'))).toBe('SUMIF names cells its formula does not')
  })

  it('a name of this workbook written as a link to it is not another workbook\'s', () => {
    const names = '<workbook><definedNames><definedName name="Rate">Data!$B$1</definedName></definedNames></workbook>'
    expect(why(book([sheet('Data', f('C1', '[0]!Rate*2'))], { workbookXml: names }), set('B1'))).toBe('a reference written as a link to this workbook')
  })

  it('a LET variable or a lambda parameter written with a capital is still the formula\'s own', () => {
    expect(why(book([sheet('Data', f('C1', '_xlfn.LET(_xlpm.Total,A1,_xlpm.Total*2)'))]), set('B9'))).toBe(true)
  })

  it.each([
    ['SUM(A1:INDEX(B:B,5))', 'A3'],
    ['SUM(Data!A1:Data!B5)', 'A3'],
    ['SUM(A1:B2:C5)', 'C1']
  ])('%s builds a range with a computed end', (text, cell) => {
    expect(why(book([sheet('Data', f('E9', text))]), set(cell))).toBe('a range with a computed end')
    // and from a tab no edit is on
    expect(why(book([sheet('Data', ''), sheet('S', f('E9', text.replace(/A1/, 'Data!A1')))]), set(cell))).not.toBe(true)
  })

  it('a reaching function on any tab, an edited one or not', () => {
    expect(why(book([sheet('Data', ''), sheet('Other', f('A1', 'INDIRECT("Data!A1")'))]), set('A1'))).toBe('INDIRECT names cells its formula does not')
  })

  it('a span of sheets, a what-if table, an array\'s range, macros, a formula edit', () => {
    expect(why(book([sheet('Data', ''), sheet('Sum', f('A1', 'SUM(Q1:Q3!A1)'))]), set('A1'))).toBe('a reference across a span of sheets')
    expect(why(book([sheet('Data', '<row r="2"><c r="B2"><f t="dataTable" ref="B2:B5" dt2D="0" dtr="0" r1="A1"/><v>0</v></c></row>')]), set('D1'))).toBe('a what-if table')
    const array = book([sheet('Data', f('C1', 'A1:A3*2', ' t="array" ref="C1:C3"'))])
    expect(why(array, set('C2'))).toBe("an edit inside an array formula's range")
    // its first cell too: a value over that one empties C2:C3, which another formula may read
    expect(why(array, set('C1'))).toBe("an edit inside an array formula's range")
    // a one-cell array's own cell replaced is the patch writer's business, and E9 is no one's
    expect(why(book([sheet('Data', f('C1', 'SUM(A1:A3*2)', ' t="array" ref="C1"'))]), set('C1'))).toBe(true)
    expect(why(array, set('E9'))).toBe(true)
    // a value that begins with = is written as a formula
    expect(why(book([sheet('Data', '')]), { sheet: 'Data', cell: 'A1', value: '=B1+1' })).toBe('the edit writes a formula')
    expect(why(book([sheet('Data', '')], { macros: true }), set('A1'))).toBe('the workbook has macros')
    expect(why(book([sheet('Data', '')]), { sheet: 'Data', cell: 'A1', formula: '=1+1' })).toBe('the edit writes a formula')
  })

  it('a blocked spill on the sheet, when a cell is emptied', () => {
    const input = book([sheet('Data', '<row r="1"><c r="C1" t="e"><f>_xlfn.SEQUENCE(3)</f><v>#SPILL!</v></c></row>')])
    expect(why(input, set('C2', 'Data', null))).toBe('a spill is blocked on that sheet')
    expect(why(input, set('E2', 'Data', 4))).toBe(true)
  })
})

describe('names and tables', () => {
  const names = '<workbook><definedNames><definedName name="Rate">Data!$B$1</definedName><definedName name="Costs">Data!$A$2:$A$9</definedName><definedName name="Twice">Rate*2</definedName><definedName name="Here" localSheetId="1">Other!$D$4</definedName><definedName name="Loose">A1</definedName></definedNames></workbook>'
  const input = book([sheet('Data', f('C1', 'Rate*A20') + f('C2', 'SUM(Costs)') + f('C3', 'Twice')), sheet('Other', f('A1', 'Here+1'))], { workbookXml: names })

  it('reads a name as the cells it names, through a name that names it', () => {
    expect(why(input, set('B1'))).toBe('a formula reads an edited cell')
    expect(why(input, set('A5'))).toBe('a formula reads an edited cell')
    expect(why(input, set('D4', 'Other'))).toBe('a formula reads an edited cell')
    expect(why(input, set('B2'))).toBe(true)
  })

  it('cannot place a name with a relative reference: it reads a different cell from each cell that uses it', () => {
    expect(why(book([sheet('Data', f('C1', 'Loose+1'))], { workbookXml: names }), set('Z9'))).toBe('a name with a relative reference')
    // Excel stores "the cell to the left" as a far address on the name's own sheet: still relative
    const left = '<workbook><definedNames><definedName name="LeftCell">Data!XFD1</definedName></definedNames></workbook>'
    expect(why(book([sheet('Data', f('C5', 'LeftCell*2'))], { workbookXml: left }), set('B5'))).toBe('a name with a relative reference')
  })

  it('reads a name of another tab where the formula qualifies it, and never takes a chart sheet\'s name for the workbook\'s', () => {
    const local = '<workbook><definedNames><definedName name="Rate" localSheetId="0">Data!$B$1</definedName></definedNames></workbook>'
    const input = book([sheet('Data', ''), sheet('Sum', f('A1', 'Data!Rate*2'))], { workbookXml: local })
    expect(why(input, set('B1'))).toBe('a formula reads an edited cell')
    expect(why(input, set('B2'))).toBe(true)
    // a word that is no name the proof can find, and no LET variable: unsure
    expect(why(book([sheet('Data', ''), sheet('Sum', f('A1', 'Rate*2'))], { workbookXml: local }), set('B1'))).toBe('a name that could not be placed')
    // localSheetId 5 is no worksheet here (a chart sheet): its Rate is not the workbook's
    const chart = '<workbook><definedNames><definedName name="Rate" localSheetId="5">Data!$Z$1</definedName><definedName name="Rate">Data!$B$1</definedName></definedNames></workbook>'
    expect(why(book([sheet('Data', ''), sheet('S', f('A1', 'Rate'))], { workbookXml: chart }), set('B1'))).toBe('a formula reads an edited cell')
  })

  it('reads a LAMBDA name through to the cells it names, and takes any other function that is not Excel\'s own as reading anything', () => {
    const lambda = '<workbook><definedNames><definedName name="MyFn">_xlfn.LAMBDA(_xlpm.x,_xlpm.x+Data!$B$1)</definedName></definedNames></workbook>'
    const input = book([sheet('Data', ''), sheet('S', f('A1', 'MyFn(1)') + f('A2', '_xlfn.MyFn(2)'))], { workbookXml: lambda })
    expect(why(input, set('B1'))).toBe('a formula reads an edited cell')
    expect(why(input, set('B2'))).toBe(true)
    expect(why(book([sheet('Data', ''), sheet('S', f('A1', '_xludf.MYFN(1)'))]), set('B1'))).toBe("_XLUDF.MYFN is no function of Excel's own")
    expect(why(book([sheet('Data', ''), sheet('S', f('A1', 'MYADDIN(1)'))]), set('B1'))).toBe("MYADDIN is no function of Excel's own")
    // a lambda's own parameter called as a function is the formula's
    expect(why(book([sheet('Data', f('C1', '_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2),_xlpm.f(A1))'))]), set('B9'))).toBe(true)
  })

  it('takes a word that is no name of the workbook for a LET variable: it reads no cell', () => {
    expect(why(book([sheet('Data', f('C1', '_xlfn.LET(x,A1,x*2)'))]), set('B9'))).toBe(true)
  })

  it('reads a structured reference as the whole table', () => {
    const tables = [{ sheet: 'Data', name: 'Sales', ref: 'A1:C10' }]
    const withTable = book([sheet('Data', f('E1', 'SUM(Sales[Amount])') + f('C2', '[@Qty]*[@Price]')), sheet('Other', f('A1', 'Sales[[#Totals],[Amount]]'))], { tables })
    expect(why(withTable, set('B5'))).toBe('a formula reads a table an edited cell is in')
    expect(why(withTable, set('F5'))).toBe(true)
    // a bracket with no table to belong to
    expect(why(book([sheet('Data', f('E1', '[@Qty]*2'))]), set('A1'))).toBe('a structured reference to a table that could not be placed')
  })
})

describe('the corpus', () => {
  const CORPUS = join(import.meta.dirname, '../harness/corpus')
  const input = (file: string): DependsInput => dependsInput(new Uint8Array(readFileSync(join(CORPUS, file))))

  it('formulas.xlsx uses OFFSET, so nothing in it is provable: every edit takes the audited path', () => {
    const got = input('formulas.xlsx')
    expect(got.sheets.map((s) => s.name)).toContain('Data')
    expect(why(got, set('ZZ900'))).toMatch(/names cells its formula does not$/)
  })

  it('charts.xlsx: a cell its formulas read is dependent, one far off is not; macro.xlsm is never provable', () => {
    const got = input('charts.xlsx')
    expect(independent(got, [set('ZZ900')])).toEqual({ independent: true, formulas: 8 })
    expect(why(got, set('B2'))).toBe('a formula reads an edited cell')
    expect(why(input('macro.xlsm'), set('ZZ900', 'Main'))).toBe('the workbook has macros')
  })

  it('tables.xlsx: an edit inside a table that formulas read is dependent', () => {
    const got = input('tables.xlsx')
    expect(got.tables.length).toBeGreaterThan(0)
    const table = got.tables[0]
    expect(why(got, set(table.ref.split(':')[1]!.replace(/\d+$/, (n) => String(Number(n) - 1)), table.sheet))).not.toBe(true)
  })
})
