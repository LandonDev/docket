import { describe, expect, it } from 'vitest'
import { excelSerial, fieldValues } from '@shared/work/templates'
import { dateStyles, fillOffice, scanOffice } from '../ooxml'
import { partText, readZip } from '../zip'
import { colName, stylesXml, writeXlsx, type SheetIn } from './xlsx'

/* The starters' sheet writer: Excel's own named styles, theme colours only, read back and filled by the fill's own reader. */

const part = (bytes: Uint8Array, name: string): string => partText(readZip(bytes).find((p) => p.name === name)!)

const SHEET: SheetIn = {
  name: "Bill's sheet",
  cols: [30, 12, 14],
  rows: [
    [{ v: 'Invoice for {{Client}}', s: 'title' }],
    [{ v: 'Date', s: 'label' }, { v: '{{Date}}', s: 'inputDate' }],
    [{ v: 'Number', s: 'label' }, { v: '{{Invoice number}}', s: 'input' }],
    [{ v: 'Item one', s: 'input' }, { v: 2, s: 'inputNumber' }, { v: 10.5, s: 'inputCurrency' }],
    [{ v: 'Total', s: 'total' }, null, { f: 'B4*C4', s: 'totalCurrency', v: 21 }],
    [{ f: 'IF(C4="","",C4)', s: 'normal', v: '' }]
  ],
  freeze: 3,
  printTitles: [3, 3],
  landscape: true,
  lists: [{ range: 'B4:B9', values: ['Yes', 'No'] }],
  header: '&L{{Job}}'
}

describe('the starters’ sheet writer', () => {
  it('names columns as Excel does', () => {
    expect([0, 25, 26, 27, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })

  it("carries Excel's built-in cell styles by name and number", () => {
    const xml = stylesXml()
    for (const [name, id] of [
      ['Normal', 0],
      ['Heading 1', 16],
      ['Heading 2', 17],
      ['Total', 25],
      ['Input', 20],
      ['Note', 10],
      ['Currency', 4],
      ['Percent', 5]
    ] as const)
      expect(xml).toMatch(new RegExp(`<cellStyle name="${name}" xfId="\\d+" builtinId="${id}"/>`))
  })

  it('writes no literal colour outside the theme, and only the theme’s fonts', () => {
    const bytes = writeXlsx([SHEET])
    for (const p of readZip(bytes)) {
      const xml = partText(p)
      if (p.name === 'xl/theme/theme1.xml') {
        expect(xml).toContain('<a:majorFont>')
        continue
      }
      expect(xml, p.name).not.toMatch(/\brgb="|srgbClr|sysClr/)
    }
    const fonts = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(part(bytes, 'xl/styles.xml'))![1]!
    const each = fonts.match(/<font>[\s\S]*?<\/font>/g)!
    expect(each.every((f) => /<scheme val="(major|minor)"\/>/.test(f))).toBe(true)
  })

  it("writes a formula's result with it, a text result as a string", () => {
    const sheet = part(writeXlsx([SHEET]), 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="C5" s="4"><f>B4*C4</f><v>21</v></c>')
    expect(sheet).toContain('<c r="A6" t="str"><f>IF(C4=&quot;&quot;,&quot;&quot;,C4)</f><v></v></c>'.replace(/&quot;/g, '"'))
  })

  it('is the same bytes when written twice', () => {
    expect(Buffer.from(writeXlsx([SHEET])).equals(Buffer.from(writeXlsx([SHEET])))).toBe(true)
  })

  it('freezes the head, sets the page up and keeps the formulas', () => {
    const bytes = writeXlsx([SHEET])
    const sheet = part(bytes, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/>')
    expect(sheet).toContain('orientation="landscape" fitToWidth="1" fitToHeight="0"')
    expect(sheet).toContain('<f>B4*C4</f>')
    expect(sheet).toContain('<formula1>"Yes,No"</formula1>')
    expect(part(bytes, 'xl/workbook.xml')).toContain(`<definedName name="_xlnm.Print_Titles" localSheetId="0">'Bill''s sheet'!$3:$3</definedName>`)
    expect(part(bytes, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"')
  })

  it("is read back by the fill's own scan, and filled, its lone Date cell made a true date", () => {
    const bytes = writeXlsx([SHEET])
    expect(scanOffice('xlsx', bytes)).toEqual(['Client', 'Date', 'Invoice number', 'Job'])
    const dated = dateStyles(part(bytes, 'xl/styles.xml'))
    const dateCell = /<c r="B2" s="(\d+)"/.exec(part(bytes, 'xl/worksheets/sheet1.xml'))![1]!
    expect(dated.has(+dateCell)).toBe(true)
    const values = fieldValues({ Client: 'Dummy Co', 'Invoice number': '0042', Date: 'November 23, 2026', Job: 'Dummy Studio' })
    const filled = fillOffice('xlsx', bytes, values, { today: '2026-11-23' })
    expect(scanOffice('xlsx', filled.bytes)).toEqual([])
    const sheet = part(filled.bytes, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain(`<c r="B2" s="${dateCell}"><v>${excelSerial('2026-11-23')}</v></c>`)
    expect(part(filled.bytes, 'xl/sharedStrings.xml')).toContain('Invoice for Dummy Co')
    expect(sheet).toContain('&amp;LDummy Studio')
  })
})
