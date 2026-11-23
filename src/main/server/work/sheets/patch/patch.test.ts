import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { readEntry, readText, readZip, writeZip } from './zip'
import { ironcalc } from './recalc'
import { refs, toFileFormula, toUserFormula, translate } from './formula'
import { patchSheet, patchValues, scanCached } from './sheet'
import { patchXlsx, workbookMap, type Options } from './patch'

const enc = new TextEncoder()
const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])
function makeZip(files: Record<string, string>): Uint8Array {
  return writeZip(
    readZip(EMPTY_ZIP),
    new Map(),
    new Set(),
    new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)]))
  )
}
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const ws = (data: string, extra = '') =>
  `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:C3"/><sheetData>${data}</sheetData>${extra}</worksheet>`

describe('formula tokenizer', () => {
  test('finds references with sheet qualifiers, 3D spans and externals, skips strings and names', () => {
    const r = refs(
      `SUM(Data!A2:A21)+'My Sheet'!$B$3+SUM(Q1:Q3!A1)+[1]Prices!B2+LOG10(4)+"A1"+Tax+Sales[Q3]+A:A+3:5`
    )
    expect(r.map((x) => [x.sheet ?? '', x.a.kind, x.b?.kind ?? ''])).toEqual([
      ['Data', 'cell', 'cell'],
      ['My Sheet', 'cell', ''],
      ['Q1:Q3', 'cell', ''],
      ['[1]Prices', 'cell', ''],
      ['', 'col', 'col'],
      ['', 'row', 'row']
    ])
    expect(r[3].external).toBe(true)
  })
  test('translate shifts relative parts only and turns off-sheet refs into #REF!', () => {
    expect(translate('A1+$B$2+C$3+$D4+SUM(E1:E5)', 1, 2)).toBe('C2+$B$2+E$3+$D5+SUM(G2:G6)')
    expect(translate('A1+B2', -1, 0)).toBe('#REF!+B1')
    expect(translate('"A1"&Data!A1', 1, 0)).toBe('"A1"&Data!A2')
  })
  test('storage prefixes are added for newer functions and LET/LAMBDA parameters, and stripped back', () => {
    expect(toFileFormula('=XLOOKUP(A1,B:B,C:C)+FILTER(A1:A3,A1:A3>1)')).toBe(
      '_xlfn.XLOOKUP(A1,B:B,C:C)+_xlfn._xlws.FILTER(A1:A3,A1:A3>1)'
    )
    expect(toFileFormula('=LET(x,A1*2,x+1)')).toBe('_xlfn.LET(_xlpm.x,A1*2,_xlpm.x+1)')
    expect(toFileFormula('=SUM(A1:A3)')).toBe('SUM(A1:A3)')
    expect(toFileFormula('=WORKDAY.INTL(A1,3)+ISO.CEILING(2)')).toBe(
      'WORKDAY.INTL(A1,3)+ISO.CEILING(2)'
    ) // MS-XLSX lists these unprefixed
    expect(toUserFormula('_xlfn.LET(_xlpm.x,A1*2,_xlpm.x+1)')).toBe('=LET(x,A1*2,x+1)')
  })
})

describe('worksheet surgery', () => {
  const base = ws(
    '<row r="1" spans="1:2"><c r="A1" s="3" t="s"><v>0</v></c><c r="B1"><f>A1*2</f><v>2</v></c></row><row r="3"><c r="C3"><v>1</v></c></row>'
  )
  test('replaces a cell in place, keeps its style, leaves every other byte', () => {
    const { xml, report } = patchSheet(
      base,
      [{ row: 1, col: 1, write: { kind: 'number', value: 5 } }],
      { strings: 'inline' }
    )
    expect(xml).toBe(
      base.replace('<c r="A1" s="3" t="s"><v>0</v></c>', '<c r="A1" s="3"><v>5</v></c>')
    )
    expect(report.replaced).toEqual(['A1'])
  })
  test('inserts cells in column order, widens spans and dimension, adds rows in row order', () => {
    const { xml } = patchSheet(
      base,
      [
        { row: 1, col: 4, write: { kind: 'text', value: ' a<b ' } },
        { row: 2, col: 2, write: { kind: 'bool', value: true } },
        { row: 9, col: 1, write: { kind: 'number', value: 1.5 } }
      ],
      { strings: 'inline' }
    )
    expect(xml).toContain('<row r="1" spans="1:4">')
    expect(xml).toContain(
      '<v>2</v></c><c r="D1" t="inlineStr"><is><t xml:space="preserve"> a&lt;b </t></is></c></row><row r="2"><c r="B2" t="b"><v>1</v></c></row><row r="3">'
    )
    expect(xml).toContain('</row><row r="9"><c r="A9"><v>1.5</v></c></row></sheetData>')
    expect(xml).toContain('<dimension ref="A1:D9"/>')
  })
  test('works under a namespace prefix and on self-closing rows', () => {
    const x = `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="2" s="4" customFormat="1"/></x:sheetData></x:worksheet>`
    const { xml } = patchSheet(x, [{ row: 2, col: 2, write: { kind: 'number', value: 7 } }], {
      strings: 'inline'
    })
    expect(xml).toBe(
      `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="2" s="4" customFormat="1"><x:c r="B2" s="4"><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>`
    )
  })
  test('a new cell takes its column style', () => {
    const x = `<worksheet ${NS}><cols><col min="2" max="3" style="9" width="5" customWidth="1"/></cols><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`
    expect(
      patchSheet(x, [{ row: 1, col: 3, write: { kind: 'number', value: 2 } }], {
        strings: 'inline'
      }).xml
    ).toContain('<c r="C1" s="9"><v>2</v></c>')
  })
  test('overwriting a shared-formula master moves the formula to the next cell of the group', () => {
    const x = ws(
      '<row r="1"><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row><row r="2"><c r="B2"><f t="shared" si="0"/><v>4</v></c></row><row r="3"><c r="B3"><f t="shared" si="0"/><v>6</v></c></row>'
    )
    const { xml, report } = patchSheet(
      x,
      [{ row: 1, col: 2, write: { kind: 'number', value: 0 } }],
      { strings: 'inline' }
    )
    expect(xml).toContain('<c r="B2"><f t="shared" si="0" ref="B2:B3">A2*2</f><v>4</v></c>')
    expect(xml).toContain('<c r="B3"><f t="shared" si="0"/>')
    expect(report.remastered).toEqual(['si=0 B1→B2'])
    expect(report.formulasRemoved).toBe(1)
  })
  test('a 2-D group whose new top-left is gone is expanded to plain formulas', () => {
    const x = ws(
      '<row r="1"><c r="B1"><f t="shared" ref="B1:C2" si="3">$A1+B$9</f><v>1</v></c><c r="C1"><f t="shared" si="3"/><v>1</v></c></row><row r="2"><c r="B2"><f t="shared" si="3"/><v>1</v></c><c r="C2"><f t="shared" si="3"/><v>1</v></c></row>'
    )
    const { xml, report } = patchSheet(
      x,
      [{ row: 1, col: 2, write: { kind: 'number', value: 0 } }],
      { strings: 'inline' }
    )
    expect(xml).toContain('<c r="C1"><f>$A1+C$9</f>')
    expect(xml).toContain('<c r="B2"><f>$A2+B$9</f>')
    expect(xml).toContain('<c r="C2"><f>$A2+C$9</f>')
    expect(report.expanded).toEqual(['si=3: 3 cells'])
  })
  test('refuses part of a legacy array; clears a dynamic array spill when its anchor is overwritten', () => {
    const cse = ws(
      '<row r="1"><c r="A1"><f t="array" ref="A1:A2">B1:B2*2</f><v>2</v></c></row><row r="2"><c r="A2"><v>4</v></c></row>'
    )
    expect(() =>
      patchSheet(cse, [{ row: 2, col: 1, write: { kind: 'number', value: 1 } }], {
        strings: 'inline'
      })
    ).toThrow(/array formula/)
    const dyn = cse.replace('<c r="A1">', '<c r="A1" cm="1">')
    const { xml, report } = patchSheet(
      dyn,
      [{ row: 1, col: 1, write: { kind: 'number', value: 1 } }],
      { strings: 'inline' }
    )
    expect(xml).toContain('<c r="A1"><v>1</v></c></row><row r="2"><c r="A2"/></row>')
    expect(report.arrayCleared).toEqual(['A1:A2'])
  })
  test('patchValues rewrites only <v> and t= of formula cells, and reports constants and missing cells', () => {
    const { xml, hits } = patchValues(
      base,
      new Map([
        ['B1', { t: 'str', v: 'x&y' } as const],
        ['C3', { t: 'n', v: '1' } as const],
        ['Z9', { t: 'n', v: '1' } as const]
      ]),
      () => true
    )
    expect(xml).toContain('<c r="B1" t="str"><f>A1*2</f><v>x&amp;y</v></c>')
    expect(hits.map((h) => h.status)).toEqual(['patched', 'not-formula', 'missing'])
    expect(scanCached(xml).get('B1')).toEqual({ t: 'str', v: 'x&y' })
  })
})

// An Excel-shaped package: x: prefix on the sheet, calcChain, shared strings, a protected sheet and a table.
const FULL_STYLES = `<?xml version="1.0"?><styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
const BARE_STYLES = `<?xml version="1.0"?><styleSheet ${NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="0" applyProtection="1"><protection locked="0"/></xf></cellXfs></styleSheet>`
function excelLike(styles = FULL_STYLES) {
  return makeZip({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15"><sheets><sheet name="S &amp; P" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/><extLst><ext uri="{X}"/></extLst></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><x:dimension ref="A1:B2"/><x:sheetData><x:row r="1" x14ac:dyDescent="0.25"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1"><x:f>A2*2</x:f><x:v>2</x:v></x:c></x:row><x:row r="2"><x:c r="A2" s="1"><x:v>1</x:v></x:c></x:row></x:sheetData><x:sheetProtection sheet="1"/><x:tableParts count="1"><x:tablePart xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></x:tableParts></x:worksheet>`,
    'xl/worksheets/_rels/sheet1.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>`,
    'xl/tables/table1.xml': `<?xml version="1.0"?><table ${NS} id="1" name="T" displayName="T" ref="D1:E3"><tableColumns count="2"><tableColumn id="1" name="a"/><tableColumn id="2" name="b"/></tableColumns></table>`,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${NS} count="1" uniqueCount="1"><si><t>hello</t></si></sst>`,
    'xl/calcChain.xml': `<?xml version="1.0"?><calcChain ${NS}><c r="B1" i="1"/></calcChain>`,
    'xl/styles.xml': styles
  })
}

/** IronCalc as the toolchain installs it; the engine cases run only where it is. */
const IRONCALC = process.env.IRONCALC_DIR ?? '/srv/agents/temp-code-data/work-tools/ironcalc/0.9.1'
const hasEngine = existsSync(join(IRONCALC, 'node_modules/@ironcalc/nodejs'))
const scratch = mkdtempSync(join(tmpdir(), 'sheets-patch-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
/** The writer's options with IronCalc in this process, reading the package from disk as the sheet worker does. */
function withEngine(bytes: Uint8Array): Options {
  const inputPath = join(scratch, `in-${Math.random().toString(36).slice(2)}.xlsx`)
  writeFileSync(inputPath, bytes)
  return { inputPath, recalc: (path, edits, keys) => ironcalc(IRONCALC, path, edits, keys) }
}

describe('package', () => {
  test('a value edit with no engine: calcChain gone with its rel and override, fullCalcOnLoad set, other parts raw-copied', async () => {
    const src = excelLike()
    const { bytes, report } = await patchXlsx(src, [{ sheet: 'S & P', cell: 'A2', value: '5' }], {})
    const z = readZip(bytes)
    expect(z.byName.has('xl/calcChain.xml')).toBe(false)
    expect(readText(z, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain')
    expect(readText(z, '[Content_Types].xml')).not.toContain('calcChain')
    expect(readText(z, 'xl/workbook.xml')).toContain(
      '<calcPr calcId="191029" fullCalcOnLoad="1"/><extLst><ext uri="{X}"/></extLst>'
    )
    expect(readText(z, 'xl/worksheets/sheet1.xml')).toContain(
      '<x:c r="A2" s="1"><x:v>5</x:v></x:c>'
    )
    expect(report.warnings).toEqual([]) // A2's style is unlocked
    const orig = readZip(src)
    for (const n of [
      'xl/sharedStrings.xml',
      'xl/styles.xml',
      'xl/tables/table1.xml',
      '_rels/.rels'
    ])
      expect(Buffer.compare(Buffer.from(readEntry(z, n)), Buffer.from(readEntry(orig, n)))).toBe(0)
    expect(report.partsChanged.sort()).toEqual([
      '[Content_Types].xml',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml'
    ])
  })
  test('shared-string mode reuses an entry or appends one and keeps count/uniqueCount honest; locked cells warn', async () => {
    const { bytes, report } = await patchXlsx(
      excelLike(),
      [
        { sheet: 'S & P', cell: 'A1', value: 'hello' },
        { sheet: 'S & P', cell: 'C1', value: 'new' }
      ],
      { strings: 'shared' }
    )
    const z = readZip(bytes)
    expect(readText(z, 'xl/sharedStrings.xml')).toContain(
      'count="3" uniqueCount="2"><si><t>hello</t></si><si><t>new</t></si></sst>'
    )
    expect(readText(z, 'xl/worksheets/sheet1.xml')).toContain(
      '<x:c r="C1" t="s"><x:v>1</x:v></x:c>'
    )
    expect(report.warnings.filter((w) => w.includes('locked')).length).toBe(2)
  })
  test('manual calculation mode is reported, because fullCalcOnLoad does nothing there', async () => {
    const src = excelLike()
    const z0 = readZip(src)
    const wbx = readText(z0, 'xl/workbook.xml').replace(
      '<calcPr calcId="191029"/>',
      '<calcPr calcId="191029" calcMode="manual"/>'
    )
    const src2 = writeZip(z0, new Map([['xl/workbook.xml', enc.encode(wbx)]]), new Set(), new Map())
    const { report } = await patchXlsx(src2, [{ sheet: 'S & P', cell: 'A2', value: 3 }], {})
    expect(report.warnings.some((w) => w.includes('calcMode="manual"'))).toBe(true)
  })
  test('a table header edit is refused', async () => {
    await expect(
      patchXlsx(excelLike(), [{ sheet: 'S & P', cell: 'E1', value: 'x' }], {})
    ).rejects.toThrow(/header of table T/)
  })
  test.skipIf(!hasEngine)(
    'with IronCalc, dependents get new cached values and an agreeing engine leaves calcChain and calcPr alone',
    async () => {
      const src = excelLike()
      const { bytes, report } = await patchXlsx(
        src,
        [{ sheet: 'S & P', cell: 'A2', value: 21 }],
        withEngine(src)
      )
      const z = readZip(bytes)
      expect(report.recalc.ok).toBe(true)
      expect(report.recalc.pathA).toEqual([{ cell: 'S & P!B1', path: 'a', value: '42' }])
      expect(report.recalc.pathB).toEqual([])
      expect(readText(z, 'xl/worksheets/sheet1.xml')).toContain(
        '<x:c r="B1"><x:f>A2*2</x:f><x:v>42</x:v></x:c>'
      )
      expect(z.byName.has('xl/calcChain.xml')).toBe(true)
      expect(report.recalc.fullCalcOnLoad).toBe(false)
    }
  )
  test.skipIf(!hasEngine)(
    'a new formula gets its engine value; overwriting a formula with a value drops calcChain',
    async () => {
      const src = excelLike()
      const { bytes, report } = await patchXlsx(
        src,
        [
          { sheet: 'S & P', cell: 'C2', formula: '=XLOOKUP(1,A2:A2,A2:A2)*3' },
          { sheet: 'S & P', cell: 'B1', value: 7 }
        ],
        withEngine(src)
      )
      const x = readText(readZip(bytes), 'xl/worksheets/sheet1.xml')
      expect(x).toContain('<x:c r="C2"><x:f>_xlfn.XLOOKUP(1,A2:A2,A2:A2)*3</x:f><x:v>3</x:v></x:c>')
      expect(report.recalc.calcChainRemoved).toBe(true)
    }
  )
  test('an engine that fails (IronCalc 0.9.1 panics on a styles.xml without fonts, and its process dies) falls back to path (b), and the patch still lands', async () => {
    const src = excelLike(BARE_STYLES)
    const { bytes, report } = await patchXlsx(src, [{ sheet: 'S & P', cell: 'A2', value: 21 }], {
      inputPath: '/nowhere.xlsx',
      recalc: () => {
        throw new Error('the sheet worker died')
      }
    })
    expect(report.recalc.ok).toBe(false)
    expect(report.recalc.error).toMatch(/sheet worker died/)
    expect(report.recalc.fullCalcOnLoad).toBe(true)
    expect(readText(readZip(bytes), 'xl/worksheets/sheet1.xml')).toContain(
      '<x:c r="A2" s="1"><x:v>21</x:v></x:c>'
    )
  })
  test('null clears a cell and keeps its style; clearing a cell that is not there adds nothing', async () => {
    const { bytes, report } = await patchXlsx(
      excelLike(),
      [
        { sheet: 'S & P', cell: 'B1', value: null },
        { sheet: 'S & P', cell: 'C9', value: null }
      ],
      {}
    )
    const x = readText(readZip(bytes), 'xl/worksheets/sheet1.xml')
    expect(x).toContain('<x:c r="B1"/></x:row>')
    expect(x).not.toContain('C9')
    expect(report.recalc.calcChainRemoved).toBe(true)
  })
})

/**
 * A formula he types into a cell that names a table goes into the file in the words Excel keeps
 * there (the table proof, E-sheets/SHT4-excel-tables-proof.md: Excel reads the typed words as
 * #REF! and #NAME?). The cases are the four the proof ran in real Excel.
 */
describe('a typed formula that names a table', () => {
  const corpus = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'harness/corpus/tables.xlsx')))
  const formulaAt = (bytes: Uint8Array, sheet: string, cell: string): string | undefined => {
    const zip = readZip(bytes)
    const part = workbookMap(zip).sheets.find((s) => s.name === sheet)!.part
    return new RegExp(`<c r="${cell}"[^>]*>\\s*<f[^>]*>([^<]*)</f>`).exec(readText(zip, part))?.[1]
  }

  test('this row, a whole table and a table on another sheet are written as Excel keeps them; a formula that names no table is as typed', async () => {
    const { bytes } = await patchXlsx(
      corpus,
      [
        { sheet: 'Sales', cell: 'F5', value: '=[@Units]*[@Price]*1' },
        { sheet: 'Sales', cell: 'L9', value: '=ROWS(Sales)+SUM(Targets[Target])' },
        { sheet: 'Report', cell: 'D3', value: '=COUNTA(targets)' },
        { sheet: 'Report', cell: 'D4', value: '=SUM(A1:A3)*2' }
      ],
      {}
    )
    expect(formulaAt(bytes, 'Sales', 'F5')).toBe('Sales[[#This Row],[Units]]*Sales[[#This Row],[Price]]*1')
    expect(formulaAt(bytes, 'Sales', 'L9')).toBe('ROWS(Sales[])+SUM(Targets[Target])')
    expect(formulaAt(bytes, 'Report', 'D3')).toBe('COUNTA(targets[])')
    expect(formulaAt(bytes, 'Report', 'D4')).toBe('SUM(A1:A3)*2')
  })

  test('a workbook with no table gets its formulas as they came', async () => {
    const { bytes } = await patchXlsx(excelLike(), [{ sheet: 'S & P', cell: 'D9', value: '=SUM(A1:A3)' }], {})
    const zip = readZip(bytes)
    const part = workbookMap(zip).sheets.find((s) => s.name === 'S & P')!.part
    expect(readText(zip, part)).toMatch(/<x:f>SUM\(A1:A3\)<\/x:f>/)
  })
})
