import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MAX_COLUMNS, MAX_ROWS, paperOf, sameSetup, type SheetPageSetup } from 'work-kit/sheet/pages'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { PagesRefused, patchPages, readPages, type PagesEdit } from './pages'
import * as zip from './zip'
import { readEntry, readText, readZip, writeZip } from './zip'

const CORPUS = join(import.meta.dirname, '../harness/corpus')
const PRINT = join(CORPUS, 'print')
const BOOK = 'xl/workbook.xml'
const file = (name: string): Uint8Array => new Uint8Array(readFileSync(join(CORPUS, name)))
const workbook = (bytes: Uint8Array): string => readText(readZip(bytes), BOOK)

function withPart(bytes: Uint8Array, part: string, change: (xml: string) => string): Uint8Array {
  const source = readZip(bytes)
  const xml = readText(source, part)
  const next = change(xml)
  expect(next).not.toBe(xml)
  return writeZip(source, new Map([[part, new TextEncoder().encode(next)]]), new Set(), new Map())
}

function expectParts(
  before: Uint8Array,
  output: ReturnType<typeof patchPages>,
  parts: string[]
): void {
  expect([...output.report.partsChanged].sort()).toEqual([...parts].sort())
  const previous = readZip(before)
  const next = readZip(output.bytes)
  expect([...next.byName.keys()]).toEqual([...previous.byName.keys()])
  for (const name of previous.byName.keys()) {
    const equal = Buffer.from(readEntry(previous, name)).equals(readEntry(next, name))
    expect(equal, name).toBe(!parts.includes(name))
  }
}

function expectRefusal(bytes: Uint8Array, edits: PagesEdit[], message: string): void {
  const original = bytes.slice()
  const write = vi.spyOn(zip, 'writeZip')
  try {
    expect(() => patchPages(bytes, edits)).toThrow(expect.objectContaining({
      constructor: PagesRefused,
      message
    }))
    expect(write).not.toHaveBeenCalled()
    expect(bytes).toEqual(original)
  } finally {
    write.mockRestore()
  }
}

const area = { startRow: 0, endRow: 20, startColumn: 0, endColumn: 4, whole: null }
const repeatRows = { start: 0, end: 1 }
const repeatColumns = { start: 0, end: 1 }
const footer = '&L&F, &A&CPage &P of &N&R&D &T && <&> _x000D_'
const margins = (side: keyof SheetPageSetup['margins']) => (setup: SheetPageSetup) => ({
  margins: { ...setup.margins, [side]: 0.42 }
})

interface SetupCase {
  name: string
  fixture?: string
  change: Partial<SheetPageSetup> | ((setup: SheetPageSetup) => Partial<SheetPageSetup>)
  part?: 'workbook'
}

const cases: SetupCase[] = [
  { name: 'A4 paper', change: { paper: paperOf(9) } },
  { name: 'Legal paper', change: { paper: paperOf(5) } },
  { name: 'unknown paper code 200', change: { paper: paperOf(200) } },
  { name: 'landscape orientation', change: { orientation: 'landscape' } },
  { name: 'portrait orientation', change: { orientation: 'portrait' } },
  { name: 'default orientation', fixture: 'print/landscape.xlsx', change: { orientation: 'default' } },
  { name: 'left margin', change: margins('left') },
  { name: 'right margin', change: margins('right') },
  { name: 'top margin', change: margins('top') },
  { name: 'bottom margin', change: margins('bottom') },
  { name: 'header margin', change: margins('header') },
  { name: 'footer margin', change: margins('footer') },
  { name: 'scale of 70 percent', change: { scaling: { kind: 'scale', percent: 70 } } },
  { name: 'fit one page wide with no height limit', change: { scaling: { kind: 'fit', wide: 1, tall: 0 } } },
  { name: 'fit two pages wide by three tall', change: { scaling: { kind: 'fit', wide: 2, tall: 3 } } },
  { name: 'automatic scale', fixture: 'print/fit-width.xlsx', change: { scaling: { kind: 'auto' } } },
  { name: 'one print area', part: 'workbook', change: { printAreas: [area] } },
  {
    name: 'several print areas in order',
    part: 'workbook',
    change: { printAreas: [{ ...area, startRow: 25, endRow: 28 }, area] }
  },
  {
    name: 'whole-column print area',
    part: 'workbook',
    change: { printAreas: [{ ...area, endRow: MAX_ROWS - 1, whole: 'columns' }] }
  },
  {
    name: 'whole-row print area',
    part: 'workbook',
    change: { printAreas: [{ ...area, endColumn: MAX_COLUMNS - 1, whole: 'rows' }] }
  },
  { name: 'manual row breaks', change: { rowBreaks: [9, 19] } },
  { name: 'manual column breaks', change: { columnBreaks: [2, 4] } },
  { name: 'repeat rows', part: 'workbook', change: { repeatRows } },
  { name: 'repeat columns', part: 'workbook', change: { repeatColumns } },
  { name: 'repeat both rows and columns', part: 'workbook', change: { repeatRows, repeatColumns } },
  { name: 'page order across then down', change: { pageOrder: 'over' } },
  { name: 'gridlines', change: { gridlines: true } },
  { name: 'headings', change: { headings: true } },
  { name: 'horizontal centring', change: { centerHorizontally: true } },
  { name: 'vertical centring', change: { centerVertically: true } },
  { name: 'header', change: { header: '&CBudget &P' } },
  { name: 'footer with Excel codes and escaped text', change: { footer } },
  { name: 'positive first page number', change: { firstPageNumber: 7 } },
  { name: 'negative first page number', change: { firstPageNumber: -3 } },
  { name: 'automatic first page number', fixture: 'protect_print.xlsx', change: { firstPageNumber: null } }
]

describe('a page set-up saved into an Excel file', () => {
  it.each(cases)('round trips $name', ({ fixture = 'formulas.xlsx', change, part }) => {
    const bytes = file(fixture)
    const before = readPages(bytes)
    const [first, ...others] = before
    const fields = typeof change === 'function' ? change(first!.setup) : change
    const setup = { ...first!.setup, ...fields }
    expect(sameSetup(setup, first!.setup)).toBe(false)

    const edits = [{ sheet: first!.sheet, setup }]
    const parts = [part === 'workbook' ? BOOK : first!.part]
    const patched = patchPages(bytes, edits)
    expectParts(bytes, patched, parts)

    const [after, ...otherSheets] = readPages(patched.bytes)
    expect(sameSetup(after!.setup, setup)).toBe(true)
    expect(after!.setup).toEqual(setup)
    expect(otherSheets).toEqual(others)

    const repeat = patchPages(patched.bytes, edits)
    expect(repeat.report.partsChanged).toEqual([])
    expect(repeat.bytes).toBe(patched.bytes)

    const restored = patchPages(patched.bytes, [{ sheet: first!.sheet, setup: first!.setup }])
    expectParts(patched.bytes, restored, parts)
    expect(readPages(restored.bytes)).toEqual(before)
  })

  it('returns the same bytes for no edits', () => {
    const bytes = file('formulas.xlsx')
    const result = patchPages(bytes, [])
    expect(result.report.partsChanged).toEqual([])
    expect(result.bytes).toBe(bytes)
  })

  it.each(readdirSync(PRINT).filter((name) => name.endsWith('.xlsx')).sort())(
    'returns the same bytes for the setup already in %s',
    (name) => {
      const bytes = file(join('print', name))
      const pages = readPages(bytes)
      expect(pages.length).toBeGreaterThan(0)
      const result = patchPages(bytes, pages.map(({ sheet, setup }) => ({ sheet, setup })))
      expect(result.report.partsChanged).toEqual([])
      expect(result.bytes).toBe(bytes)
    }
  )

  it('ignores top-level and nested key order in a no-op', () => {
    const bytes = file('protect_print.xlsx')
    const [first] = readPages(bytes)
    const { scaling, ...fields } = first!.setup
    if (scaling.kind !== 'fit') throw new Error('Expected a fixture with fit scaling.')
    const { wide, tall } = scaling
    const setup: SheetPageSetup = { scaling: { tall, wide, kind: 'fit' }, ...fields }
    expect(JSON.stringify(setup)).not.toBe(JSON.stringify(first!.setup))
    const result = patchPages(bytes, [{ sheet: first!.sheet, setup }])
    expect(result.report.partsChanged).toEqual([])
    expect(result.bytes).toBe(bytes)
  })

  it('keeps explicit paper size, attribute order and existing print names when turning the page', () => {
    const bytes = withPart(file('print/titles.xlsx'), BOOK, (xml) =>
      xml.replace('Data!$A:$A,Data!$1:$2', "'Data'!$1:$2,'Data'!$A:$A")
    )
    const [first] = readPages(bytes)
    const tag = (input: Uint8Array) => /<pageSetup\b[^>]*>/.exec(readText(readZip(input), first!.part))?.[0]
    const before = tag(bytes)
    expect(before).toContain('paperSize="1"')
    expect(before).toContain('orientation="portrait"')
    const setup = { ...first!.setup, orientation: 'landscape' as const }
    const result = patchPages(bytes, [{ sheet: first!.sheet, setup }])
    expectParts(bytes, result, [first!.part])
    expect(tag(result.bytes)).toBe(before!.replace('orientation="portrait"', 'orientation="landscape"'))
    expect(readPages(result.bytes)[0]?.setup).toEqual(setup)
  })

  it('keeps a single-quoted paper size when changing orientation', () => {
    const fixture = file('print/landscape.xlsx')
    const [first] = readPages(fixture)
    const bytes = withPart(fixture, first!.part, (xml) => xml.replace('paperSize="1"', "paperSize='1'"))
    const setup = { ...first!.setup, orientation: 'portrait' as const }
    const result = patchPages(bytes, [{ sheet: first!.sheet, setup }])
    const tag = /<pageSetup\b[^>]*>/.exec(readText(readZip(result.bytes), first!.part))?.[0]
    expect(tag).toBe(`<pageSetup paperSize='1' orientation="portrait"/>`)
  })

  it('writes each break once and keeps a repeat of the same edit a no-op', () => {
    const bytes = file('print/manual-breaks.xlsx')
    const [first] = readPages(bytes)
    const edits = [{ sheet: first!.sheet, setup: { ...first!.setup, rowBreaks: [30, 3, 3] } }]
    const result = patchPages(bytes, edits)
    expectParts(bytes, result, [first!.part])
    expect(readPages(result.bytes)[0]?.setup.rowBreaks).toEqual([3, 30])
    const xml = readText(readZip(result.bytes), first!.part)
    expect(xml).toContain('<rowBreaks count="2" manualBreakCount="2">')
    expect([...xml.matchAll(/<brk id="4"/g)]).toHaveLength(1)
    const repeat = patchPages(result.bytes, edits)
    expect(repeat.report.partsChanged).toEqual([])
    expect(repeat.bytes).toBe(result.bytes)
  })

  it.each([
    ['My Data', "'My Data'"],
    ["O'Brien", "'O''Brien'"]
  ])('quotes print names for %s', (name, quoted) => {
    const bytes = withPart(file('layout.xlsx'), BOOK, (xml) => xml.replace('name="FrozenRows"', `name="${name}"`))
    const first = readPages(bytes).find((page) => page.sheet === name)!
    const setup = { ...first.setup, printAreas: [area], repeatRows, repeatColumns }
    const result = patchPages(bytes, [{ sheet: name, setup }])
    expectParts(bytes, result, [BOOK])
    const xml = workbook(result.bytes)
    expect(xml).toContain(`<definedName name="_xlnm.Print_Area" localSheetId="3">${quoted}!$A$1:$E$21</definedName>`)
    expect(xml).toContain(`<definedName name="_xlnm.Print_Titles" localSheetId="3">${quoted}!$A:$B,${quoted}!$1:$2</definedName>`)
    expect(readPages(result.bytes).find((page) => page.sheet === name)?.setup).toEqual(setup)
  })

  it('counts a hidden sheet before the target in localSheetId', () => {
    const bytes = file('layout.xlsx')
    const before = readPages(bytes)
    const target = before.find((page) => page.sheet === 'FrozenRows')!
    expect(workbook(bytes)).toMatch(/<sheet\b[^>]*name="HiddenSheet"[^>]*state="hidden"[^>]*\/>/)
    expect(target.sheetIndex).toBe(3)
    const setup = { ...target.setup, printAreas: [area] }
    const result = patchPages(bytes, [{ sheet: target.sheet, setup }])
    expectParts(bytes, result, [BOOK])
    expect(workbook(result.bytes)).toContain('<definedName name="_xlnm.Print_Area" localSheetId="3">FrozenRows!$A$1:$E$21</definedName>')
    expect(readPages(result.bytes)).toEqual(before.map((page) => page === target ? { ...page, setup } : page))
  })

  it('counts a chartsheet before the target in localSheetId', () => {
    const bytes = withPart(file('charts.xlsx'), BOOK, (xml) =>
      xml.replace(/(<sheet\b[^>]*name="Data"[^>]*\/>)(<sheet\b[^>]*name="ChartSheet"[^>]*\/>)/, '$2$1')
    )
    const before = readPages(bytes)
    expect(before.map(({ sheet, sheetIndex }) => [sheet, sheetIndex])).toEqual([['Data', 1]])
    const [first] = before
    const setup = { ...first!.setup, printAreas: [area] }
    const result = patchPages(bytes, [{ sheet: first!.sheet, setup }])
    expectParts(bytes, result, [BOOK])
    expect(workbook(result.bytes)).toContain('<definedName name="_xlnm.Print_Area" localSheetId="1">Data!$A$1:$E$21</definedName>')
    expect(readPages(result.bytes)).toEqual([{ ...first, setup }])
  })

  it('writes print names at the workbook path in the package relationship', () => {
    const source = readZip(file('formulas.xlsx'))
    const root = '_rels/.rels'
    const rels = 'xl/_rels/workbook.xml.rels'
    const moved = 'xl/book.xml'
    const encoder = new TextEncoder()
    const bytes = writeZip(source, new Map([
      [root, encoder.encode(readText(source, root).replace('Target="xl/workbook.xml"', "Target='./xl/book.xml'"))],
      ['[Content_Types].xml', encoder.encode(readText(source, '[Content_Types].xml').replace('/xl/workbook.xml', '/xl/book.xml'))]
    ]), new Set([BOOK, rels]), new Map([
      [moved, readEntry(source, BOOK)],
      ['xl/_rels/book.xml.rels', readEntry(source, rels)]
    ]))
    const [first] = readPages(bytes)
    const setup = { ...first!.setup, repeatRows }
    const result = patchPages(bytes, [{ sheet: first!.sheet, setup }])
    expectParts(bytes, result, [moved])
    expect(readPages(result.bytes)[0]?.setup).toEqual(setup)
  })

  it('saves a batch across two sheets, keeping the cells and other names', () => {
    const bytes = file('formulas.xlsx')
    const [first, second, ...others] = readPages(bytes)
    const firstSetup = { ...first!.setup, header: '&CBudget', printAreas: [area] }
    const secondSetup = { ...second!.setup, repeatRows }
    const edits = [{ sheet: first!.sheet, setup: firstSetup }, { sheet: second!.sheet, setup: secondSetup }]
    const result = patchPages(bytes, edits)
    expectParts(bytes, result, [first!.part, BOOK])
    expect(readPages(result.bytes)).toEqual([{ ...first, setup: firstSetup }, { ...second, setup: secondSetup }, ...others])
    expect(importXlsx(result.bytes).workbook.sheets).toEqual(importXlsx(bytes).workbook.sheets)
    const otherNames = (b: Uint8Array) => [...workbook(b).matchAll(/<definedName\b[^>]*\bname="(?!_xlnm\.)[^"]+"[^>]*>[^<]*<\/definedName>/g)].map(([tag]) => tag)
    expect(otherNames(bytes).length).toBeGreaterThan(0)
    expect(otherNames(result.bytes)).toEqual(otherNames(bytes))
    const repeat = patchPages(result.bytes, edits)
    expect(repeat.report.partsChanged).toEqual([])
    expect(repeat.bytes).toBe(result.bytes)
  })

  it('refuses a duplicate sheet even when one edit matches the file', () => {
    const bytes = file('formulas.xlsx')
    const [first] = readPages(bytes)
    expectRefusal(bytes, [
      { sheet: first!.sheet, setup: { ...first!.setup, gridlines: true } },
      { sheet: first!.sheet, setup: first!.setup }
    ], 'More than one page set-up for worksheet “Data”.')
  })

  const refusals: Array<{ name: string; sheet?: string; change?: Partial<SheetPageSetup>; message: string }> = [
    { name: 'a missing worksheet', sheet: 'Gone', message: 'No worksheet named “Gone”.' },
    {
      name: 'a scale of 4000',
      change: { scaling: { kind: 'scale', percent: 4000 } },
      message: 'page set-up: scale must be a whole number from 10 to 400, not 4000'
    },
    {
      name: 'a negative margin',
      change: { margins: { left: -1, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 } },
      message: 'page set-up: margin left must be a number of inches from 0, not -1'
    },
    {
      name: 'a row break past the grid',
      change: { rowBreaks: [MAX_ROWS] },
      message: `page set-up: row break must be a whole number from 0 to ${MAX_ROWS - 2}, not ${MAX_ROWS}`
    },
    {
      name: 'a column break past the grid',
      change: { columnBreaks: [MAX_COLUMNS] },
      message: `page set-up: column break must be a whole number from 0 to ${MAX_COLUMNS - 2}, not ${MAX_COLUMNS}`
    },
    {
      name: 'an invalid first page number that would compare equal to automatic',
      change: { firstPageNumber: Number.NaN },
      message: 'page set-up: first page number must be a whole number from -2147483648 to 2147483647, not NaN'
    }
  ]
  it.each(refusals)('refuses $name before writing the batch', ({ sheet, change, message }) => {
    const bytes = file('formulas.xlsx')
    const [first, second] = readPages(bytes)
    expectRefusal(bytes, [
      { sheet: first!.sheet, setup: { ...first!.setup, gridlines: true, printAreas: [area] } },
      { sheet: sheet ?? second!.sheet, setup: { ...second!.setup, ...change } }
    ], message)
  })
})
