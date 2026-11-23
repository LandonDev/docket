import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import { BUILTIN_NUMFMTS, columnWidthPx, importXlsx } from 'work-kit/sheet/xlsx'
import {
  columnWidthFromPx,
  FormatRefused,
  patchFormat,
  type FormatEdit,
  type FormatRange
} from './format'
import { DOMParser } from '@xmldom/xmldom'
import { readEntry, readText, readZip, writeZip, type Entry, type Zip } from './zip'

const CORPUS = join(__dirname, '../harness/corpus')
const SHEET = 'xl/worksheets/sheet1.xml'
const STYLES = 'xl/styles.xml'
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const SHEET_ORDER = (
  'sheetPr dimension sheetViews sheetFormatPr cols sheetData sheetCalcPr sheetProtection ' +
  'protectedRanges scenarios autoFilter sortState dataConsolidate customSheetViews mergeCells ' +
  'phoneticPr conditionalFormatting dataValidations hyperlinks printOptions pageMargins pageSetup ' +
  'headerFooter rowBreaks colBreaks customProperties cellWatches ignoredErrors smartTags drawing ' +
  'legacyDrawing legacyDrawingHF picture oleObjects controls webPublishItems tableParts extLst'
).split(' ')
const STYLE_ORDER =
  'numFmts fonts fills borders cellStyleXfs cellXfs cellStyles dxfs tableStyles colors extLst'.split(
    ' '
  )

const file = (name: string) => new Uint8Array(readFileSync(join(CORPUS, name)))
const base = file('patch/base.xlsx')
const xml = (bytes: Uint8Array, part = SHEET) => readText(readZip(bytes), part)
const styled = (
  range: FormatRange,
  format: Extract<FormatEdit, { kind: 'cells' }>['format'],
  sheet = 'Data'
): FormatEdit => ({ kind: 'cells', sheet, range, format })
const width = (from: number, to: number, width: number | null, sheet = 'Data'): FormatEdit => ({
  kind: 'colWidth',
  sheet,
  from,
  to,
  width
})
const height = (from: number, to: number, height: number | null, sheet = 'Data'): FormatEdit => ({
  kind: 'rowHeight',
  sheet,
  from,
  to,
  height
})
const merge = (range: FormatRange, sheet = 'Data'): FormatEdit => ({ kind: 'merge', sheet, range })
const unmerge = (range: FormatRange, sheet = 'Data'): FormatEdit => ({
  kind: 'unmerge',
  sheet,
  range
})

function replaceParts(bytes: Uint8Array, changes: Record<string, (before: string) => string>) {
  const z = readZip(bytes)
  const parts = new Map(
    Object.entries(changes).map(([part, change]) => [
      part,
      new TextEncoder().encode(change(readText(z, part)))
    ])
  )
  return writeZip(z, parts, new Set(), new Map())
}

/** An entry's whole local record, including its compressed bytes and data descriptor. */
function localRecord(z: Zip, e: Entry): Buffer {
  const v = new DataView(z.buf.buffer, z.buf.byteOffset, z.buf.byteLength)
  let end =
    e.localOffset +
    30 +
    v.getUint16(e.localOffset + 26, true) +
    v.getUint16(e.localOffset + 28, true) +
    e.compSize
  if (e.flags & 8) end += v.getUint32(end, true) === 0x08074b50 ? 16 : 12
  return Buffer.from(z.buf.subarray(e.localOffset, end))
}

function document(bytes: Uint8Array, part = SHEET) {
  return new DOMParser().parseFromString(xml(bytes, part), 'application/xml').documentElement!
}

const childrenOf = (parent: ReturnType<typeof document>) =>
  Array.from(parent.childNodes).filter((node) => node.nodeType === 1) as Array<
    ReturnType<typeof document>
  >

function ordered(root: ReturnType<typeof document>, order: string[]) {
  const ranks = childrenOf(root)
    .filter((child) => child.namespaceURI === NS)
    .map((child) => order.indexOf(child.localName!))
  expect(ranks.every((rank) => rank !== -1)).toBe(true)
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
}

function counts(root: ReturnType<typeof document>, collections: string[]) {
  for (const node of childrenOf(root)) {
    if (collections.includes(node.localName!) && node.hasAttribute('count'))
      expect(Number(node.getAttribute('count')), node.localName!).toBe(childrenOf(node).length)
  }
}

function checkPackage(before: Uint8Array, after: Uint8Array, changed: string[]) {
  const old = readZip(before),
    next = readZip(after)
  expect([...next.byName.keys()]).toEqual([...old.byName.keys()])
  for (const entry of old.entries) {
    const part = entry.name
    if (changed.includes(part)) {
      expect(Buffer.from(readEntry(old, part)).equals(readEntry(next, part)), part).toBe(false)
    } else {
      expect(localRecord(old, entry).equals(localRecord(next, next.byName.get(part)!)), part).toBe(
        true
      )
    }
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(part) && changed.includes(part)) {
      const root = document(after, part)
      ordered(root, SHEET_ORDER)
      counts(root, ['mergeCells'])
    }
  }
  const root = document(after, STYLES)
  ordered(root, STYLE_ORDER)
  counts(root, STYLE_ORDER.slice(0, 9))
}

function saveOutput(name: string, bytes: Uint8Array) {
  const dir = process.env.SHEET_FORMAT_OUTPUT_DIR
  if (dir) writeFileSync(join(dir, name), bytes)
}

function checked(input: Uint8Array, edits: FormatEdit[], changed: string[], output?: string) {
  const result = patchFormat(input, edits)
  expect([...result.report.partsChanged].sort()).toEqual([...changed].sort())
  expect(result.report.warnings).toEqual([])
  if (!changed.length) expect(result.bytes).toBe(input)
  checkPackage(input, result.bytes, changed)
  if (output) saveOutput(output, result.bytes)
  return result
}

function grid(bytes: Uint8Array, name?: string) {
  const { workbook } = importXlsx(bytes)
  const sheet = workbook.sheetOrder
    .map((id) => workbook.sheets[id]!)
    .find((sh) => !name || sh.name === name)!
  const styleOf = (row: number, col: number) => {
    const id = sheet.cellData?.[row]?.[col]?.s
    return typeof id === 'string' ? workbook.styles![id] : id
  }
  return { sheet, styleOf, styles: workbook.styles! }
}

function cellTag(bytes: Uint8Array, ref: string) {
  const el = Array.from(document(bytes).getElementsByTagNameNS(NS, 'c')).find(
    (cell) => cell.getAttribute('r') === ref
  )
  return el?.getAttribute('s')
}

const labFormat = {
  font: { bold: true },
  fill: { rgb: 'FFDD66' },
  numFmt: '0.000 "kg"',
  border: { left: { style: 'thin' as const } }
}
const labLayout = [width(1, 1, 22), height(2, 2, 25), merge('E2:F2')]

test('style is part-local and matches the lab for bold, fill, pattern and border weight', () => {
  const edits = [styled('A2', labFormat)]
  const { bytes, report } = checked(base, edits, [SHEET, STYLES], 'style.xlsx')
  expect(report.styles).toEqual({ fonts: 1, fills: 1, borders: 1, numFmts: 1, xfs: 1, reused: 0 })
  const ours = grid(bytes).styleOf(1, 0)!
  const lab = grid(file('patch/style.xlsx')).styleOf(1, 0)!
  expect(ours).toMatchObject({ bl: lab.bl, bg: lab.bg, n: lab.n, bd: { l: { s: lab.bd!.l!.s } } })
  expect(ours).toMatchObject({ bl: 1, bg: { rgb: '#FFDD66' }, n: { pattern: '0.000 "kg"' } })
  expect(grid(bytes).sheet.cellData?.[1]?.[0]?.v).toBe(12.345)
  // The lab explicitly supplied a border colour. Adding it here gives the same full style.
  const colored = checked(
    base,
    [styled('A2', { ...labFormat, border: { left: { style: 'thin', color: { rgb: '224466' } } } })],
    [SHEET, STYLES],
    'style-lab-color.xlsx'
  )
  expect(grid(colored.bytes).styleOf(1, 0)).toEqual(lab)
  expect(checked(bytes, edits, []).report.styles).toEqual({
    fonts: 0,
    fills: 0,
    borders: 0,
    numFmts: 0,
    xfs: 0,
    reused: 5
  })
})

test('styles preserve formula, cached value, and cell type byte for byte', () => {
  const result = checked(
    base,
    [styled('B2:C2', { font: { bold: true } })],
    [SHEET, STYLES],
    'formula.xlsx'
  )
  const text = xml(result.bytes)
  expect(text).toMatch(/<c r="B2" t="s" s="\d+"><v>0<\/v><\/c>/)
  expect(text).toMatch(/<c r="C2" s="\d+"><f>A2\*2<\/f><v>24\.69<\/v><\/c>/)
  const gridCells = grid(result.bytes).sheet.cellData?.[1]
  expect(gridCells?.[1]).toMatchObject({ v: 'keep', t: 1 })
  expect(gridCells?.[2]).toMatchObject({ f: '=A2*2', v: 24.69, t: 2 })
  expect(result.report.styles.fonts).toBe(1)
  expect(result.report.styles.xfs).toBe(1)
})

test('styles reuse equal existing records across syntax variants and separate xf inputs', () => {
  const source = replaceParts(base, {
    [STYLES]: (s) =>
      s
        .replace('fonts count="1"', 'fonts count="2"')
        .replace(
          '</fonts>',
          "<font><name val='Calibri'/><b val='true'></b><color theme='1'/><scheme val='minor'/><family val='2'/><sz val='11'/></font></fonts>"
        )
        .replace('cellXfs count="2"', 'cellXfs count="3"')
        .replace(
          '</cellXfs>',
          '<xf applyFont="true" xfId="0" borderId="0" fillId="0" fontId="1" numFmtId="0"></xf></cellXfs>'
        )
  })
  const edit = styled('A1:A2', { font: { bold: true } })
  const result = checked(source, [edit], [SHEET, STYLES], 'reuse.xlsx')
  expect(result.report.styles).toMatchObject({ fonts: 0, xfs: 1, reused: 3 })
  expect(cellTag(result.bytes, 'A1')).toBe('2')
  expect(cellTag(result.bytes, 'A2')).toBe('3')
  expect(grid(result.bytes).styleOf(1, 0)).toMatchObject({ n: { pattern: '0.0' }, bl: 1 })
  checked(result.bytes, [edit], [])
})

test('current xf attributes, protection, untouched alignment and unrelated border edges survive', () => {
  const source = replaceParts(file('formats.xlsx'), {
    [STYLES]: (s) =>
      s.replace(
        /(<cellXfs\b[^>]*>)(<xf[^>]*?)\/>/,
        '$1$2 quotePrefix="1" applyProtection="1"><alignment textRotation="37" shrinkToFit="1" vertical="top"/><protection locked="0" hidden="1"/></xf>'
      )
  })
  const edits = [
    styled(
      'A1',
      {
        align: { horizontal: 'center', wrap: true, indent: 2 },
        font: {
          name: 'Tahoma',
          size: 14,
          italic: true,
          underline: 'double',
          strike: true,
          color: { theme: 4, tint: -0.25 }
        },
        fill: { auto: true },
        border: { right: { style: 'dashDotDot', color: { rgb: '80504030' } } }
      },
      'Formats'
    )
  ]
  const { bytes } = checked(source, edits, [SHEET, STYLES], 'xf-details.xlsx')
  const xf = document(bytes, STYLES)
    .getElementsByTagNameNS(NS, 'cellXfs')[0]!
    .getElementsByTagNameNS(NS, 'xf')[Number(cellTag(bytes, 'A1'))]!
  expect(xf.getAttribute('quotePrefix')).toBe('1')
  expect(xf.getAttribute('xfId')).toBe('0')
  expect(xf.getAttribute('applyProtection')).toBe('1')
  expect(xf.getAttribute('applyAlignment')).toBe('1')
  expect(childrenOf(xf).map((el) => el.localName)).toEqual(['alignment', 'protection'])
  expect(childrenOf(xf)[0]!.getAttribute('textRotation')).toBe('37')
  expect(childrenOf(xf)[0]!.getAttribute('shrinkToFit')).toBe('1')
  expect(childrenOf(xf)[0]!.getAttribute('vertical')).toBe('top')
  expect(childrenOf(xf)[0]!.getAttribute('indent')).toBe('2')
  expect(childrenOf(xf)[1]!.getAttribute('locked')).toBe('0')
  expect(childrenOf(xf)[1]!.getAttribute('hidden')).toBe('1')
  expect(xml(bytes, STYLES)).toContain('<color theme="4" tint="-0.25"/>')
  expect(xml(bytes, STYLES)).toContain('<fgColor auto="1"/>')
  expect(xml(bytes, STYLES)).toContain('rgb="80504030"')
  expect(grid(bytes).styleOf(0, 0)).toMatchObject({
    ff: 'Tahoma',
    fs: 14,
    it: 1,
    cl: { rgb: '#366092' },
    ht: 2,
    vt: 1,
    tb: 3,
    tr: { a: 37 }
  })
  const updated = checked(
    bytes,
    [styled('A1', { border: { left: { style: 'double' } } }, 'Formats')],
    [SHEET, STYLES],
    'xf-details-extra-border.xlsx'
  )
  expect(grid(updated.bytes).styleOf(0, 0)?.bd).toMatchObject({
    l: { s: expect.any(Number) },
    r: { s: expect.any(Number) }
  })
  const cleared = checked(
    updated.bytes,
    [
      styled(
        'A1',
        {
          font: { italic: false, underline: false, strike: false, color: null },
          fill: null,
          border: { left: null },
          align: { horizontal: null, vertical: null, wrap: false }
        },
        'Formats'
      )
    ],
    [SHEET, STYLES],
    'xf-details-clears.xlsx'
  )
  const clearedStyle = grid(cleared.bytes).styleOf(0, 0)!
  expect(clearedStyle).toMatchObject({ tr: { a: 37 }, bd: { r: { s: expect.any(Number) } } })
  for (const key of ['it', 'ul', 'st', 'bg', 'ht', 'vt', 'tb'])
    expect(clearedStyle).not.toHaveProperty(key)
  expect(clearedStyle.bd).not.toHaveProperty('l')
  checked(
    cleared.bytes,
    [styled('A1', { clear: true, font: { bold: true } }, 'Formats')],
    [SHEET],
    'clear.xlsx'
  )
})

test('number patterns use built-in ids, the first free custom id, and equal custom records', () => {
  const source = replaceParts(base, {
    [STYLES]: (s) =>
      s
        .replace('numFmts count="1"', 'numFmts count="2"')
        .replace(
          '</numFmts>',
          '<numFmt numFmtId="166" formatCode="0.000 &quot;&amp;&quot;"/></numFmts>'
        )
  })
  const edits = [
    styled('A2', { numFmt: '0.00' }),
    styled('B2', { numFmt: '0.000 "&"' }),
    styled('C2', { numFmt: '0.000 "m"' }),
    styled('D2', { numFmt: '0.000 "m"' })
  ]
  const { bytes, report } = checked(source, edits, [SHEET, STYLES], 'number-formats.xlsx')
  expect(report.styles.numFmts).toBe(1)
  const styleXml = xml(bytes, STYLES)
  expect(styleXml).toContain('numFmtId="165" formatCode="0.000 &quot;m&quot;"')
  expect(styleXml).toContain('<xf numFmtId="2"')
  expect(styleXml).toContain('<xf numFmtId="166"')
  expect(grid(bytes).styleOf(1, 0)?.n?.pattern).toBe('0.00')
  expect(grid(bytes).styleOf(1, 1)?.n?.pattern).toBe('0.000 "&"')
  expect(grid(bytes).styleOf(1, 2)?.n?.pattern).toBe('0.000 "m"')
  expect(cellTag(bytes, 'C2')).toBe(cellTag(bytes, 'D2'))
  checked(bytes, edits, [])
  const general = [styled('A2', { numFmt: '' }), styled('B2', { numFmt: 'General' })]
  const reset = checked(bytes, general, [SHEET, STYLES], 'number-general.xlsx')
  expect(reset.report.styles.numFmts).toBe(0)
  expect(grid(reset.bytes).styleOf(1, 0)?.n).toBeUndefined()
  expect(grid(reset.bytes).styleOf(1, 1)?.n).toBeUndefined()
  checked(reset.bytes, general, [])
})

test('built-in named styles create linked style xfs and reuse both new and present names', () => {
  const named = [0, 16, 17, 25, 20, 10, 26, 27, 28, 4, 5, 3]
  const edits = named.map((namedStyle, i) => styled(`A${i + 1}`, { namedStyle }))
  const { bytes } = checked(base, edits, [SHEET, STYLES], 'named-styles.xlsx')
  const styles = document(bytes, STYLES)
  const namedXfs = childrenOf(styles.getElementsByTagNameNS(NS, 'cellStyleXfs')[0]!)
  const xfs = childrenOf(styles.getElementsByTagNameNS(NS, 'cellXfs')[0]!)
  const entries = childrenOf(styles.getElementsByTagNameNS(NS, 'cellStyles')[0]!)
  expect(entries.map((el) => Number(el.getAttribute('builtinId')))).toEqual(named)
  expect(entries.map((el) => el.getAttribute('name'))).toEqual([
    'Normal',
    'Heading 1',
    'Heading 2',
    'Total',
    'Input',
    'Note',
    'Good',
    'Bad',
    'Neutral',
    'Currency',
    'Percent',
    'Comma'
  ])
  entries.forEach((el, i) => {
    const xf = xfs[Number(cellTag(bytes, `A${i + 1}`))]!
    expect(xf.getAttribute('xfId')).toBe(el.getAttribute('xfId'))
    expect(namedXfs[Number(el.getAttribute('xfId'))]).toBeDefined()
  })
  expect(grid(bytes).styleOf(6, 0)).toMatchObject({
    bg: { rgb: '#C6EFCE' },
    cl: { rgb: '#006100' }
  })
  expect(grid(bytes).styleOf(10, 0)?.n?.pattern).toBe('0%')
  checked(bytes, edits, [])
  const repeat = checked(
    bytes,
    [styled('C2', { namedStyle: 26, font: { italic: true } })],
    [SHEET, STYLES],
    'named-override.xlsx'
  )
  expect(grid(repeat.bytes).styleOf(1, 2)).toMatchObject({ it: 1, bg: { rgb: '#C6EFCE' } })
  expect(xml(repeat.bytes, STYLES).match(/<cellStyleXfs[^>]+>/)?.[0]).toBe(
    xml(bytes, STYLES).match(/<cellStyleXfs[^>]+>/)?.[0]
  )
})

test('missing style collections and empty prefixed sheetData get Excel defaults without rewriting other XML', () => {
  const source = replaceParts(base, {
    [STYLES]: () =>
      `<?xml version="1.0"?>\n<x:styleSheet xmlns:x="${NS}"><x:dxfs count='0' /></x:styleSheet>`,
    [SHEET]: () =>
      `\uFEFF<?xml version="1.0"?>\n<x:worksheet xmlns:x="${NS}"><!-- <x:sheetProtection sheet="1"/> -->` +
      '<x:dimension ref="A1"/><x:sheetData /><x:pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></x:worksheet>'
  })
  // Input has no other sheet's style references, so the two minimal collections can be seeded safely.
  const edits = [styled('B7', { font: { bold: true } }), width(0, 0, 12), merge('G9:H9')]
  const { bytes } = checked(source, edits, [SHEET, STYLES], 'prefixed.xlsx')
  const raw = Buffer.from(readEntry(readZip(bytes), SHEET)).toString()
  expect(raw.startsWith('\uFEFF<?xml version="1.0"?>\n')).toBe(true)
  expect(raw).toContain('<!-- <x:sheetProtection sheet="1"/> -->')
  expect(raw).toContain('<x:row r="7"><x:c r="B7" s="1"/></x:row>')
  expect(raw).toContain('<x:mergeCell ref="G9:H9"/>')
  expect(raw).toContain('<x:dimension ref="A1:H9"/>')
  expect(xml(bytes, STYLES)).toContain("<x:dxfs count='0' />")
  expect(xml(bytes, STYLES)).toContain('<x:fonts count="2">')
  expect(grid(bytes).styleOf(6, 1)?.bl).toBe(1)
  checked(bytes, edits, [])
  const empty = replaceParts(source, { [STYLES]: () => `<x:styleSheet xmlns:x="${NS}"/>` })
  const seeded = checked(
    empty,
    [styled('B7', { font: { bold: true } })],
    [SHEET, STYLES],
    'empty-styles.xlsx'
  )
  expect(grid(seeded.bytes).styleOf(6, 1)?.bl).toBe(1)
})

test('merges, widths and heights reproduce the lab layout and each preserves untouched part records', () => {
  const lab = grid(file('patch/layout.xlsx')).sheet
  const w = checked(base, [labLayout[0]], [SHEET], 'width.xlsx')
  expect(grid(w.bytes).sheet.columnData?.[1]?.w).toBe(columnWidthPx(22))
  expect(grid(w.bytes).sheet.columnData?.[1]?.w).toBe(lab.columnData?.[1]?.w)
  expect(xml(w.bytes)).toContain('<col min="2" max="2" width="22" customWidth="1"/>')
  checked(w.bytes, [labLayout[0]], [])
  const h = checked(base, [labLayout[1]], [SHEET], 'height.xlsx')
  expect(grid(h.bytes).sheet.rowData?.[2]?.h).toBe(Math.round((25 * 4) / 3))
  expect(grid(h.bytes).sheet.rowData?.[2]?.h).toBe(lab.rowData?.[2]?.h)
  expect(xml(h.bytes)).toMatch(/<row r="3"[^>]+ht="25" customHeight="1">/)
  checked(h.bytes, [labLayout[1]], [])
  const m = checked(base, [labLayout[2]], [SHEET], 'merge.xlsx')
  expect(grid(m.bytes).sheet.mergeData).toEqual(lab.mergeData)
  expect(xml(m.bytes)).toContain('<mergeCells count="1"><mergeCell ref="E2:F2"/></mergeCells>')
  checked(m.bytes, [labLayout[2]], [])
  const u = checked(m.bytes, [unmerge('$F$2:$E$2')], [SHEET], 'unmerge.xlsx')
  expect(xml(u.bytes)).not.toContain('mergeCells')
  expect(grid(u.bytes).sheet.mergeData).toEqual([])
  checked(u.bytes, [unmerge('E2:F2')], [])

  const all = checked(base, labLayout, [SHEET], 'layout.xlsx')
  expect(grid(all.bytes).sheet).toMatchObject({
    mergeData: lab.mergeData,
    columnData: lab.columnData,
    rowData: lab.rowData
  })
})

test('width splits an existing range and clears size without losing style, visibility or outline', () => {
  const source = replaceParts(file('layout.xlsx'), {
    [SHEET]: (s) =>
      s.replace(
        /<cols>.*?<\/cols>/s,
        '<cols><col min="1" max="5" width="18" customWidth="1" hidden="1" outlineLevel="2" style="1"/></cols>' +
          '<cols><col min="8" max="8" width="10"/></cols>'
      )
  })
  const edit = width(2, 2, 22, 'Layout')
  const { bytes } = checked(source, [edit], [SHEET], 'split-width.xlsx')
  expect(xml(bytes)).toContain(
    '<col min="1" max="2" width="18" customWidth="1" hidden="1" outlineLevel="2" style="1"/>' +
      '<col min="3" max="3" width="22" customWidth="1" hidden="1" outlineLevel="2" style="1"/>' +
      '<col min="4" max="5" width="18" customWidth="1" hidden="1" outlineLevel="2" style="1"/>'
  )
  expect(grid(bytes).sheet.columnData?.[2]).toMatchObject({ w: columnWidthPx(22), hd: 1 })
  checked(bytes, [edit], [])
  const clearEdit = width(2, 2, null, 'Layout')
  const clear = checked(bytes, [clearEdit], [SHEET], 'split-width-clear.xlsx')
  expect(xml(clear.bytes)).toContain(
    '<col min="3" max="3" hidden="1" outlineLevel="2" style="1" width="9.140625"/>'
  )
  expect(grid(clear.bytes).sheet.columnData?.[2]?.w).toBeUndefined()
  expect(grid(clear.bytes).sheet.columnData?.[2]?.hd).toBe(1)
  expect(grid(clear.bytes).sheet.columnData?.[1]?.w).toBe(columnWidthPx(18))
  checked(clear.bytes, [clearEdit], [])
  const removed = checked(base, [width(1, 1, null)], [SHEET], 'width-clear.xlsx')
  expect(xml(removed.bytes)).not.toContain('<cols')
})

test('new sized rows and styled cells stay sorted, and clearing height removes both attributes', () => {
  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s.replace(
        /<sheetData>.*?<\/sheetData>/s,
        '<sheetData><row r="2" spans="1:3"><c r="A2"/><c r="C2" t="b"><v>1</v></c></row><row r="4"/></sheetData>'
      )
  })
  const edits = [height(0, 2, 25), styled('B2:B4', { font: { bold: true } })]
  const { bytes } = checked(source, edits, [SHEET, STYLES], 'rows-cells.xlsx')
  expect(xml(bytes)).toMatch(
    /<row r="1" ht="25" customHeight="1"\/><row r="2" ht="25" customHeight="1"><c r="A2"\/><c r="B2" s="\d+"\/><c r="C2" t="b"><v>1<\/v><\/c><\/row>/
  )
  expect(xml(bytes)).toMatch(
    /<row r="3" ht="25" customHeight="1"><c r="B3" s="\d+"\/><\/row><row r="4"><c r="B4" s="\d+"\/><\/row>/
  )
  expect(grid(bytes).sheet.rowData?.[0]?.h).toBe(33)
  expect(grid(bytes).styleOf(3, 1)?.bl).toBe(1)
  checked(bytes, edits, [])
  const clear = checked(bytes, [height(0, 2, null)], [SHEET], 'height-clear.xlsx')
  expect(xml(clear.bytes)).not.toMatch(/ht="25"|customHeight=/)
  expect(grid(clear.bytes).sheet.rowData?.[2]?.h).toBeUndefined()
  checked(clear.bytes, [height(0, 2, null)], [])
})

test('merges follow filters and precede conditional formatting, preserve data, and remove one entry at a time', () => {
  const source = file('patch/filter.xlsx')
  const edits = [merge('B2:C2'), merge('E2:F2')]
  const { bytes } = checked(source, edits, [SHEET], 'merge-order.xlsx')
  expect(xml(bytes)).toMatch(
    /<autoFilter[^>]*\/><mergeCells count="2">.*<\/mergeCells><conditionalFormatting/
  )
  expect(grid(bytes).sheet.cellData?.[1]?.[2]).toMatchObject({ f: '=A2*2', v: 24.69 })
  expect(grid(bytes).sheet.mergeData).toHaveLength(2)
  const { bytes: one } = checked(bytes, [unmerge('B2:C2')], [SHEET], 'merge-remaining.xlsx')
  expect(xml(one)).toContain('<mergeCells count="1"><mergeCell ref="E2:F2"/></mergeCells>')
  expect(grid(one).sheet.mergeData).toHaveLength(1)

  const existing = checked(
    file('layout.xlsx'),
    [merge('L1:M1', 'Layout')],
    [SHEET],
    'layout-extra-merge.xlsx'
  )
  expect(grid(existing.bytes).sheet.mergeData).toHaveLength(5)
})

test('protection flags are inverted separately for cell formats, column widths and row heights', () => {
  const protectedFile = file('protect_print.xlsx')
  const format = styled('A2', { font: { bold: true } }, 'Report')
  checked(protectedFile, [format], [SHEET, STYLES], 'protected-allowed.xlsx')
  for (const edit of [
    width(0, 0, 10, 'Report'),
    height(1, 1, 20, 'Report'),
    merge('A1:B1', 'Report'),
    unmerge('A1:B1', 'Report')
  ])
    expect(() => patchFormat(protectedFile, [edit])).toThrowError(
      /Report.*protected.*Unprotect the sheet in Excel first/
    )
  const inverted = replaceParts(protectedFile, {
    [SHEET]: (s) =>
      s.replace('formatCells="0"', 'formatCells="1" formatRows="false" formatColumns="0"')
  })
  expect(() => patchFormat(inverted, [format])).toThrowError(FormatRefused)
  checked(
    inverted,
    [width(0, 0, 10, 'Report'), height(1, 1, 20, 'Report')],
    [SHEET],
    'protected-sizes.xlsx'
  )
})

test('refuses partly overlapping merges, bad references, invalid axes, unknown sheets and unsupported styles', () => {
  const merged = patchFormat(base, [merge('E2:F2')]).bytes
  for (const edit of [merge('F2:G2'), merge('D1:G3'), unmerge('E2'), unmerge('D1:G3')])
    expect(() => patchFormat(merged, [edit])).toThrowError(/overlaps the existing merge E2:F2/)
  for (const range of ['XFE1', 'A0', 'A1048577', 'XFE:XFE', '0:1', 'A1:', 'A1:B2:C3'])
    expect(() => patchFormat(base, [styled(range, { clear: true })])).toThrowError(FormatRefused)
  for (const edit of [
    width(-1, 0, 22),
    width(9, 8, null),
    width(16_384, 16_384, 22),
    height(0, 1_048_576, 20),
    height(0, 0, Infinity),
    height(0, 0, -1),
    width(0, 0, 256)
  ])
    expect(() => patchFormat(base, [edit])).toThrowError(FormatRefused)
  expect(() => patchFormat(base, [merge('A1')])).toThrowError(/at least two cells/)
  expect(() => patchFormat(base, [merge('A1:B1', 'Wrong Tab')])).toThrowError(/No worksheet named/)
  expect(() => patchFormat(base, [styled('A1', { namedStyle: 900 })])).toThrowError(
    /900.*not supported/
  )
  expect(() => patchFormat(base, [styled('A1', { fill: { rgb: '#wrong' } })])).toThrowError(
    /RGB colour/
  )
  expect(() => patchFormat(base, [styled('A1', { fill: { theme: 4, tint: -2 } })])).toThrowError(
    /outside Excel's range/
  )
})

test('parts can change across tabs in one call while ordered edits reuse their workbook styles', () => {
  const edits = [
    styled('B2', { font: { bold: true } }),
    styled('A1', { font: { bold: true } }, 'Untouched'),
    styled('B2', { font: { italic: true } }),
    styled('B3', { font: { bold: true, italic: true } })
  ]
  const result = checked(
    base,
    edits,
    [SHEET, STYLES, 'xl/worksheets/sheet2.xml'],
    'ordered-multi-tab.xlsx'
  )
  expect(result.report.styles).toMatchObject({ xfs: 2, fonts: 2 })
  expect(grid(result.bytes).styleOf(1, 1)).toMatchObject({ bl: 1, it: 1 })
  expect(grid(result.bytes).styleOf(2, 1)).toEqual(grid(result.bytes).styleOf(1, 1))
  expect(grid(result.bytes, 'Untouched').styleOf(0, 0)).toMatchObject({ bl: 1 })
  expect(grid(result.bytes, 'Untouched').sheet.cellData?.[0]?.[0]?.v).toBe('keep shared string')
})

test.each([
  ['conditional.xlsx', 'Rules', 'A2'],
  ['tables.xlsx', 'Sales', 'B2'],
  ['macro.xlsm', 'Main', 'A1']
])(
  'styles %s while keeping related package parts and worksheet children byte-identical',
  (name, sheet, target) => {
    const source = file(name)
    const edit = styled(target, { font: { italic: true } }, sheet)
    const { bytes } = checked(source, [edit], [SHEET, STYLES], 'edited-' + name)
    expect(grid(bytes, sheet).styleOf(Number(target[1]) - 1, target.charCodeAt(0) - 65)?.it).toBe(1)
    expect(xml(bytes).replace(/(<c r="(?:A1|A2|B2)"[^>]*?) s="\d+"/g, '$1')).toBe(
      xml(source).replace(/(<c r="(?:A1|A2|B2)"[^>]*?) s="\d+"/g, '$1')
    )
    checked(bytes, [edit], [])
  }
)

test('whole axes style defaults and existing cells and create only required intersections', () => {
  const edit = styled('B:B', { font: { bold: true } })
  const { bytes } = checked(base, [edit], [SHEET, STYLES], 'whole-column.xlsx')
  const originalCells = (xml(base).match(/<c\b/g) ?? []).length
  expect(xml(bytes).match(/<c\b/g)).toHaveLength(originalCells)
  expect(xml(bytes)).toMatch(/<col min="2" max="2"[^>]+style="2"/)
  expect(grid(bytes).sheet.columnData?.[1]?.s).toBeDefined()
  expect(grid(bytes).styleOf(1, 1)?.bl).toBe(1)
  checked(bytes, [edit], [])
  const blankCol = checked(
    bytes,
    [styled('F1:F1048576', { fill: { rgb: 'FFEEDD' } })],
    [SHEET, STYLES],
    'whole-column-empty.xlsx'
  )
  expect(xml(blankCol.bytes).match(/<c\b/g)).toHaveLength(originalCells)
  expect(xml(blankCol.bytes)).toMatch(/<col[^>]+min="6" max="6"/)

  const rowEdit = styled('3:3', { font: { italic: true } })
  const row = checked(bytes, [rowEdit], [SHEET, STYLES], 'whole-row.xlsx')
  expect(xml(row.bytes).match(/<c\b/g)).toHaveLength(originalCells)
  expect(xml(row.bytes)).toMatch(/<row r="3"[^>]+s="\d+" customFormat="1"/)
  expect(grid(row.bytes).styleOf(2, 0)?.it).toBe(1)
  expect(grid(row.bytes).styleOf(2, 1)).toMatchObject({ bl: 1, it: 1 })
  checked(row.bytes, [rowEdit], [])
  const empty = checked(
    row.bytes,
    [styled('A31:XFD31', { fill: { rgb: 'FFEEDD' } })],
    [SHEET, STYLES],
    'whole-row-empty.xlsx'
  )
  expect(xml(empty.bytes)).toMatch(
    /<row r="31" s="\d+" customFormat="1"><c r="B31" s="\d+"\/><\/row>/
  )
  expect(xml(empty.bytes).match(/<c\b/g)).toHaveLength(originalCells + 1)
  expect(grid(empty.bytes).styleOf(30, 1)).toMatchObject({ bl: 1, bg: { rgb: '#FFEEDD' } })

  const wholeGrid = checked(
    base,
    [styled('A1:XFD1048576', { font: { italic: true } })],
    [SHEET, STYLES],
    'whole-sheet.xlsx'
  )
  expect(xml(wholeGrid.bytes).match(/<c\b/g)).toHaveLength(originalCells)
  expect(xml(wholeGrid.bytes).match(/<row\b/g)).toHaveLength(
    (xml(base).match(/<row\b/g) ?? []).length
  )
  expect(xml(wholeGrid.bytes)).toContain('max="16384"')
})

test('whole-column style splits a width range and seeds later blank cells from its style', () => {
  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s.replace(
        /<cols>.*?<\/cols>/s,
        '<cols><col min="1" max="5" width="18" customWidth="1" outlineLevel="2" style="1"/></cols>'
      )
  })
  const { bytes } = checked(
    source,
    [styled('C:D', { font: { bold: true } })],
    [SHEET, STYLES],
    'split-style.xlsx'
  )
  const cols = document(bytes).getElementsByTagNameNS(NS, 'col')
  expect(
    Array.from(cols).map((col) =>
      ['min', 'max', 'width', 'outlineLevel', 'style'].map((name) => col.getAttribute(name))
    )
  ).toEqual([
    ['1', '2', '18', '2', '1'],
    ['3', '4', '18', '2', '2'],
    ['5', '5', '18', '2', '1']
  ])
  expect(grid(bytes).styleOf(1, 2)).toMatchObject({ bl: 1 })
  const inserted = checked(
    bytes,
    [styled('C31', { font: { italic: true } })],
    [SHEET, STYLES],
    'inherited-style.xlsx'
  )
  expect(grid(inserted.bytes).styleOf(30, 2)).toMatchObject({ n: { pattern: '0.0' }, bl: 1, it: 1 })
  const reset = checked(
    inserted.bytes,
    [styled('C:C', { clear: true })],
    [SHEET],
    'whole-column-clear.xlsx'
  )
  expect(xml(reset.bytes)).toMatch(
    /<col min="3" max="3" width="18" customWidth="1" outlineLevel="2" style="0"/
  )
  expect(cellTag(reset.bytes, 'C31')).toBe('0')
  checked(reset.bytes, [styled('C:C', { clear: true })], [])
})

test('extension markup and implicit coordinates survive cell and row splices', () => {
  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s
        .replace(
          /<sheetData>.*?<\/sheetData>/s,
          '<sheetData><row><c t="b"><v>1</v></c><c r="C1"/></row>' +
            '<row r="3" hidden="1" outlineLevel="1" ht="20" customHeight="1"><c/></row></sheetData>'
        )
        .replace(
          '</worksheet>',
          '<extLst><ext uri="format-test"/></extLst></worksheet><!-- </worksheet> -->'
        )
  })
  const { bytes } = checked(
    source,
    [styled('B1:B3', { font: { bold: true } }), height(2, 2, null)],
    [SHEET, STYLES],
    'implicit-cells.xlsx'
  )
  expect(xml(bytes)).toMatch(/<row><c t="b"><v>1<\/v><\/c><c r="B1" s="\d+"\/><c r="C1"\/><\/row>/)
  expect(xml(bytes)).toMatch(
    /<row r="3" hidden="1" outlineLevel="1"><c\/><c r="B3" s="\d+"\/><\/row>/
  )
  expect(xml(bytes)).toContain(
    '<extLst><ext uri="format-test"/></extLst></worksheet><!-- </worksheet> -->'
  )
  expect(grid(bytes).sheet.rowData?.[2]).toMatchObject({ hd: 1 })
  expect(grid(bytes).styleOf(1, 1)?.bl).toBe(1)
})

test('20,000 cells sharing an xf get one new xf', () => {
  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s
        .replace(
          /<sheetData>.*?<\/sheetData>/s,
          () =>
            '<sheetData>' +
            Array.from({ length: 10_000 }, (_, i) => {
              const r = i + 1
              return `<row r="${r}"><c r="A${r}"><v>1</v></c><c r="B${r}"><v>2</v></c></row>`
            }).join('') +
            '</sheetData>'
        )
        .replace('A1:D28', 'A1:B10000')
  })
  const edit = styled('A1:B10000', { font: { italic: true } })
  const start = performance.now()
  const result = patchFormat(source, [edit])
  const ms = Math.round(performance.now() - start)
  console.info(`20,000-cell format patch took ${ms} ms`)
  expect(ms).toBeLessThan(5000)
  checkPackage(source, result.bytes, [SHEET, STYLES])
  expect(result.report.styles).toMatchObject({ fonts: 1, xfs: 1 })
  expect(xml(result.bytes).match(/ s="2"/g)).toHaveLength(20_000)
  expect(grid(result.bytes).styleOf(9999, 1)?.it).toBe(1)
  saveOutput('range-20000.xlsx', result.bytes)
})

function xfAt(bytes: Uint8Array, ref: string) {
  return childrenOf(document(bytes, STYLES).getElementsByTagNameNS(NS, 'cellXfs')[0]!)[
    Number(cellTag(bytes, ref))
  ]
}

function gridRange(
  startRow: number,
  endRow: number,
  startColumn: number,
  endColumn: number,
  rangeType?: 0 | 1 | 2 | 3
) {
  return { startRow, endRow, startColumn, endColumn, rangeType }
}

test('redefined built-in IDs keep their file definitions and explicit dollar requests stay dollars', () => {
  const dollar = BUILTIN_NUMFMTS[44]
  const euro = '0.00 "€"'
  const source = replaceParts(base, {
    [STYLES]: (s) =>
      s
        .replace('numFmts count="1"', 'numFmts count="3"')
        .replace(
          '</numFmts>',
          '<numFmt numFmtId="44" formatCode="0.00 &quot;€&quot;"/><numFmt numFmtId="2" formatCode="0.0000"/></numFmts>'
        )
  })
  const edits = [
    styled('A3', { numFmt: dollar }),
    styled('B3', { numFmt: euro }),
    styled('C3', { numFmt: '0.00' }),
    styled('D3', { numFmt: '0.0000' })
  ]
  const { bytes, report } = checked(source, edits, [SHEET, STYLES], 'redefined-formats.xlsx')
  expect(report.styles.numFmts).toBe(2)
  expect(['A3', 'B3', 'C3', 'D3'].map((ref) => xfAt(bytes, ref)?.getAttribute('numFmtId'))).toEqual(
    ['165', '44', '166', '2']
  )
  expect(grid(bytes).styleOf(2, 0)?.n?.pattern).toBe(dollar)
  expect(grid(bytes).styleOf(2, 1)?.n?.pattern).toBe(euro)
  checked(bytes, edits, [])
})

test('literal currency, date and time patterns use locale-neutral custom records', () => {
  const ids = [7, 14, 22, 43, 44]
  const edits = ids.map((id, i) => styled(`A${3 + i}`, { numFmt: BUILTIN_NUMFMTS[id] }))
  const { bytes, report } = checked(base, edits, [SHEET, STYLES], 'literal-formats.xlsx')
  expect(report.styles.numFmts).toBe(ids.length)
  ids.forEach((id, i) => {
    expect(Number(xfAt(bytes, `A${3 + i}`)?.getAttribute('numFmtId'))).toBe(165 + i)
    expect(grid(bytes).styleOf(2 + i, 0)?.n?.pattern).toBe(BUILTIN_NUMFMTS[id])
  })
})

test('column groups always carry widths after new styles and clearing explicit sizes', () => {
  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s
        .replace('defaultRowHeight="15"', 'defaultRowHeight="15" defaultColWidth="11.25"')
        .replace('</cols>', '<col min="5" max="5" hidden="1"/></cols>')
  })
  const edits = [
    styled('B:B', { font: { bold: true } }),
    styled('F:F', { fill: { rgb: '#FFDD66' } }),
    width(1, 1, null)
  ]
  const { bytes } = checked(source, edits, [SHEET, STYLES], 'default-widths.xlsx')
  const cols = Array.from(document(bytes).getElementsByTagNameNS(NS, 'col'))
  expect(
    cols.map((col) => [
      col.getAttribute('min'),
      col.getAttribute('width'),
      col.hasAttribute('customWidth')
    ])
  ).toEqual([
    ['2', '11.25', false],
    ['5', '11.25', false],
    ['6', '11.25', false]
  ])
  expect(grid(bytes).sheet.columnData?.[1]?.w).toBe(columnWidthPx(11.25))
  checked(bytes, edits, [])
  const fallback = checked(base, [styled('F:F', { fill: { rgb: 'FFDD66' } })], [SHEET, STYLES])
  const col = Array.from(document(fallback.bytes).getElementsByTagNameNS(NS, 'col')).find(
    (entry) => entry.getAttribute('min') === '6'
  )!
  expect(col.getAttribute('width')).toBe('9.140625')
  expect(columnWidthPx(9.140625)).toBe(64)
  expect(col.hasAttribute('customWidth')).toBe(false)
})

test('row s without customFormat never supplies the base xf for an edit', () => {
  const source = replaceParts(base, { [SHEET]: (s) => s.replace('<row r="3"', '<row r="3" s="1"') })
  const single = checked(source, [styled('F3', { font: { bold: true } })], [SHEET, STYLES])
  expect(grid(single.bytes).styleOf(2, 5)).toMatchObject({ bl: 1 })
  expect(grid(single.bytes).styleOf(2, 5)?.n).toBeUndefined()
  const whole = checked(source, [styled('3:3', { font: { bold: true } })], [SHEET, STYLES])
  const row = Array.from(document(whole.bytes).getElementsByTagNameNS(NS, 'row')).find(
    (entry) => entry.getAttribute('r') === '3'
  )!
  expect(row.getAttribute('customFormat')).toBe('1')
  expect(row.getAttribute('s')).toBe(cellTag(whole.bytes, 'A3'))
  expect(grid(whole.bytes).styleOf(2, 0)?.n).toBeUndefined()
})

test('a whole-row edit layers over a styled column at a blank intersection', () => {
  const fill = styled('F:F', { fill: { rgb: 'FFFF00' } })
  const italic = styled('3:3', { font: { italic: true } })
  const { bytes } = checked(base, [fill, italic], [SHEET, STYLES], 'row-cross-point.xlsx')
  expect(grid(bytes).styleOf(2, 5)).toMatchObject({ bg: { rgb: '#FFFF00' }, it: 1 })
  expect(cellTag(bytes, 'F4')).toBeUndefined()
  checked(bytes, [italic], [])
})

test('a whole-column edit layers over a styled row at a blank intersection', () => {
  const italic = styled('5:5', { font: { italic: true } })
  const bold = styled('F:F', { font: { bold: true } })
  const { bytes } = checked(base, [italic, bold], [SHEET, STYLES], 'column-cross-point.xlsx')
  expect(grid(bytes).styleOf(4, 5)).toMatchObject({ it: 1, bl: 1 })
  expect(cellTag(bytes, 'F6')).toBeUndefined()
  checked(bytes, [bold], [])
})

test('whole-grid edits update styled row defaults without materializing blank intersections', () => {
  const row = checked(base, [styled('31:31', { font: { italic: true } })], [SHEET, STYLES])
  const { bytes } = checked(
    row.bytes,
    [styled('A:XFD', { font: { bold: true } })],
    [SHEET, STYLES],
    'styled-row-grid.xlsx'
  )
  expect(xml(bytes).match(/<c\b/g)).toHaveLength((xml(row.bytes).match(/<c\b/g) ?? []).length)
  const probe = checked(bytes, [styled('F31', { align: { wrap: true } })], [SHEET, STYLES])
  expect(grid(probe.bytes).styleOf(30, 5)).toMatchObject({ it: 1, bl: 1, tb: 3 })
})

test('refuses an edit that would create over 20,000 styled intersections', () => {
  const source = replaceParts(base, {
    [SHEET]: (s) =>
      s.replace(
        /<cols>.*?<\/cols>/s,
        '<cols><col min="1" max="10005" width="8.43" style="1"/></cols>'
      )
  })
  expect(() => patchFormat(source, [styled('3:4', { font: { bold: true } })])).toThrowError(
    /20,000 cells where styled rows and columns cross/
  )
})

test('a named style reuses an existing case-insensitive name when builtinId is absent', () => {
  const source = replaceParts(base, {
    [STYLES]: (s) =>
      s
        .replace('cellStyles count="1"', 'cellStyles count="2"')
        .replace('</cellStyles>', '<cellStyle name="gOoD" xfId="1"/></cellStyles>')
        .replace('cellStyleXfs count="1"', 'cellStyleXfs count="2"')
        .replace(
          '</cellStyleXfs>',
          '<xf numFmtId="164" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        )
  })
  const edit = styled('A3', { namedStyle: 26 })
  const { bytes } = checked(source, [edit], [SHEET, STYLES], 'existing-style-name.xlsx')
  expect(xfAt(bytes, 'A3')?.getAttribute('xfId')).toBe('1')
  expect(grid(bytes).styleOf(2, 0)?.n?.pattern).toBe('0.0')
  expect(xml(bytes, STYLES).replace(/<cellXfs.*?<\/cellXfs>/s, '')).toBe(
    xml(source, STYLES).replace(/<cellXfs.*?<\/cellXfs>/s, '')
  )
  expect(xml(bytes, STYLES)).toContain('<cellStyles count="2">')
  checked(bytes, [edit], [])
})

test('a new named style owns its own xf even if another named style looks identical', () => {
  const source = replaceParts(base, {
    [STYLES]: (s) =>
      s
        .replace('cellStyles count="1"', 'cellStyles count="2"')
        .replace('</cellStyles>', '<cellStyle name="MyPct" xfId="1"/></cellStyles>')
        .replace('cellStyleXfs count="1"', 'cellStyleXfs count="2"')
        .replace(
          '</cellStyleXfs>',
          '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellStyleXfs>'
        )
  })
  const edit = styled('A3', { namedStyle: 5 })
  const { bytes } = checked(source, [edit], [SHEET, STYLES], 'separate-style-xfs.xlsx')
  expect(xml(bytes, STYLES)).toContain('<cellStyle name="MyPct" xfId="1"/>')
  expect(xml(bytes, STYLES)).toContain('<cellStyle name="Percent" xfId="2" builtinId="5"/>')
  expect(xfAt(bytes, 'A3')?.getAttribute('xfId')).toBe('2')
  checked(bytes, [edit], [])
})

test('merge refuses table overlaps and a partial array-formula range', () => {
  const source = file('tables.xlsx')
  for (const range of ['C5:D5', 'A5:C5'])
    expect(() => patchFormat(source, [merge(range, 'Sales')])).toThrowError(
      /Cells in a table can't be merged/
    )
  checked(source, [merge('A1:B1', 'Sales')], [SHEET], 'outside-table-merge.xlsx')
  const array = replaceParts(base, {
    [SHEET]: (s) => s.replace('<f>A2*2</f>', '<f t="array" ref="C2:C4">A2*2</f>')
  })
  expect(() => patchFormat(array, [merge('B3:C3')])).toThrowError(/array formula range C2:C4/)
  const full = checked(array, [merge('C2:D4')], [SHEET])
  expect(xml(full.bytes)).toContain('<f t="array" ref="C2:C4">A2*2</f><v>24.69</v>')
})

test('font size, font name and indent reject invalid values before writing XML', () => {
  for (const size of [0, NaN, Infinity, 409.01])
    expect(() => patchFormat(base, [styled('A1', { font: { size } })])).toThrowError(
      /size from 1 to 409/
    )
  for (const name of ['', '  ', 'x'.repeat(32)])
    expect(() => patchFormat(base, [styled('A1', { font: { name } })])).toThrowError(
      /name from 1 to 31/
    )
  for (const indent of [-2, 1.5, 251])
    expect(() => patchFormat(base, [styled('A1', { align: { indent } })])).toThrowError(
      /indent from 0 to 250/
    )
  checked(
    base,
    [styled('A1', { font: { size: 409, name: 'x'.repeat(31) }, align: { indent: 250 } })],
    [SHEET, STYLES]
  )
})

test('rejects enormous sparse rectangles and almost-full height ranges at the creation ceiling', () => {
  expect(() => patchFormat(base, [styled('F1:AZ40000', { font: { bold: true } })])).toThrowError(
    /more than one million cells or rows/
  )
  expect(() => patchFormat(base, [height(0, 1_048_574, 20)])).toThrowError(
    /more than one million cells or rows/
  )
})

test('a full-sheet height writes the sheet default and clears old row overrides in edit order', () => {
  const source = file('layout.xlsx')
  const edits = [
    height(0, 100, 24, 'Layout'),
    height(0, 1_048_575, 20, 'Layout'),
    height(4, 4, 30, 'Layout')
  ]
  const { bytes } = checked(source, edits, [SHEET], 'sheet-default-height.xlsx')
  const originalRows = (xml(source).match(/<row\b/g) ?? []).length
  expect(xml(bytes).match(/<row\b/g)).toHaveLength(originalRows)
  expect(xml(bytes)).toMatch(/<sheetFormatPr defaultRowHeight="20"[^>]* customHeight="1"/)
  expect(xml(bytes).match(/ ht="/g)).toHaveLength(1)
  expect(grid(bytes).sheet.defaultRowHeight).toBe(Math.round((20 * 4) / 3))
  expect(grid(bytes).sheet.rowData?.[4]?.h).toBe(40)
  const clear = checked(bytes, [height(0, 1_048_575, null, 'Layout')], [SHEET])
  expect(xml(clear.bytes)).toMatch(/<sheetFormatPr defaultRowHeight="15"/)
  expect(xml(clear.bytes)).not.toContain('customHeight=')
  expect(xml(clear.bytes).match(/<row\b/g)).toHaveLength(originalRows)
})

test('merge spreads the anchor xf to edge cells while preserving stored values and formulas', () => {
  const edits = [
    styled('B2', { border: { right: { style: 'thick' }, bottom: { style: 'double' } } }),
    merge('B2:E3'),
    styled('D2', { font: { bold: true } })
  ]
  const { bytes } = checked(base, edits, [SHEET, STYLES], 'merged-style.xlsx')
  const anchor = cellTag(bytes, 'B2')
  expect(anchor).toBeDefined()
  for (const ref of ['C2', 'E2', 'B3', 'C3', 'D3', 'E3']) expect(cellTag(bytes, ref)).toBe(anchor)
  expect(grid(bytes).styleOf(1, 3)).toMatchObject({ bl: 1, bd: { r: { s: expect.any(Number) } } })
  expect(grid(bytes).styleOf(2, 4)?.bd).toEqual(grid(bytes).styleOf(1, 1)?.bd)
  expect(xml(bytes)).toContain(`<c r="C2" s="${anchor}"><f>A2*2</f><v>24.69</v></c>`)
  const unmerged = checked(bytes, [unmerge('B2:E3')], [SHEET])
  expect(cellTag(unmerged.bytes, 'E3')).toBe(anchor)
})

test('one edit accepts mixed A1 and grid ranges and respects preceding edits and whole axes', () => {
  const edits: FormatEdit[] = [
    styled(gridRange(4, 4, -1, -1, 1), { font: { italic: true } }),
    {
      kind: 'cells',
      sheet: 'Data',
      range: 'A2',
      ranges: [gridRange(1, 1, 0, 1), gridRange(-1, -1, 5, 5, 2), 'C4'],
      format: { font: { bold: true } }
    },
    styled(gridRange(-1, -1, -1, -1, 3), { align: { wrap: true } }),
    merge(gridRange(1, 1, 7, 8))
  ]
  const { bytes } = checked(base, edits, [SHEET, STYLES], 'mixed-ranges.xlsx')
  expect(grid(bytes).styleOf(1, 0)).toMatchObject({ bl: 1, tb: 3, n: { pattern: '0.0' } })
  expect(grid(bytes).styleOf(1, 1)).toMatchObject({ bl: 1, tb: 3 })
  expect(grid(bytes).styleOf(4, 5)).toMatchObject({ bl: 1, it: 1, tb: 3 })
  expect(grid(bytes).styleOf(3, 2)).toMatchObject({ bl: 1, tb: 3 })
  expect(xml(bytes)).toContain('<mergeCell ref="H2:I2"/>')
  expect(() => patchFormat(base, [styled(gridRange(1.5, 2, 0, 0), { clear: true })])).toThrowError(
    FormatRefused
  )
})

test('grid formatting round-trips rotation and writes shrink, superscript and diagonal attributes', () => {
  const edits = [
    styled('A1', {
      font: { name: 'Tahoma', size: 13, bold: true, italic: true, vertAlign: 'superscript' },
      fill: { rgb: '#ffcc33' },
      border: { diagonal: { up: true, style: 'thin', color: { rgb: '#234567' } } },
      align: { rotation: -30, shrink: true, horizontal: 'distributed', vertical: 'justify' }
    }),
    styled('A1', { border: { diagonal: { down: true } } }),
    styled('A2', { font: { vertAlign: 'subscript' }, align: { rotation: 'vertical' } })
  ]
  const source = replaceParts(base, {
    [STYLES]: (s) => s.replace('<scheme val="minor"/>', '<charset val="1"/><scheme val="minor"/>')
  })
  const { bytes } = checked(source, edits, [SHEET, STYLES], 'grid-format-fields.xlsx')
  const table = document(bytes, STYLES)
  const xf1 = xfAt(bytes, 'A1')!
  const align = xf1.getElementsByTagNameNS(NS, 'alignment')[0]!
  expect(align.getAttribute('horizontal')).toBe('distributed')
  expect(align.getAttribute('vertical')).toBe('justify')
  expect(align.getAttribute('shrinkToFit')).toBe('1')
  expect(align.getAttribute('textRotation')).toBe('120')
  expect(grid(bytes).styleOf(0, 0)).toMatchObject({ tr: { a: -30 }, bg: { rgb: '#FFCC33' } })
  expect(grid(bytes).styleOf(1, 0)?.tr).toEqual({ a: 0, v: 1 })
  const font = table.getElementsByTagNameNS(NS, 'font')[Number(xf1.getAttribute('fontId'))]!
  expect(childrenOf(font).map((el) => el.localName)).toEqual([
    'b',
    'i',
    'vertAlign',
    'sz',
    'color',
    'name',
    'family'
  ])
  expect(font.getElementsByTagNameNS(NS, 'vertAlign')[0]?.getAttribute('val')).toBe('superscript')
  expect(xml(bytes, STYLES)).toContain('<vertAlign val="subscript"/>')
  const border = table.getElementsByTagNameNS(NS, 'border')[Number(xf1.getAttribute('borderId'))]!
  expect(border.getAttribute('diagonalUp')).toBe('1')
  expect(border.getAttribute('diagonalDown')).toBe('1')
  expect(border.getElementsByTagNameNS(NS, 'diagonal')[0]?.getAttribute('style')).toBe('thin')
  expect(border.getElementsByTagNameNS(NS, 'color')[0]?.getAttribute('rgb')).toBe('FF234567')
  const clear = checked(
    bytes,
    [
      styled('A1', {
        border: { diagonal: null },
        font: { vertAlign: null },
        align: { rotation: null, shrink: false }
      })
    ],
    [SHEET, STYLES]
  )
  const reset = xfAt(clear.bytes, 'A1')!
  expect(reset.getElementsByTagNameNS(NS, 'alignment')[0]?.hasAttribute('textRotation')).toBe(false)
  expect(reset.getElementsByTagNameNS(NS, 'alignment')[0]?.getAttribute('shrinkToFit')).toBe('0')
  expect(reset.getAttribute('borderId')).toBe('0')
  expect(() => patchFormat(base, [styled('A1', { align: { rotation: NaN } })])).toThrowError(
    /text rotation/
  )
})

test('column width pixel conversion agrees with the importer', () => {
  for (const pixels of [0, 1, 7, 13, 64, 154, 1785])
    expect(columnWidthPx(columnWidthFromPx(pixels))).toBe(pixels)
  expect(columnWidthFromPx(100) * 256).toBe(Math.round(columnWidthFromPx(100) * 256))
})

test('2,000 single-cell edits on base.xlsx resolve in one call and share one xf', () => {
  const edits = Array.from({ length: 2000 }, (_, i) =>
    styled(`F${i + 1}`, { font: { bold: true } })
  )
  const start = performance.now()
  const result = patchFormat(base, edits)
  const ms = Math.round(performance.now() - start)
  console.info(`2,000 single-cell edits took ${ms} ms`)
  expect(ms).toBeLessThan(1500)
  checkPackage(base, result.bytes, [SHEET, STYLES])
  expect(result.report.styles).toEqual({
    fonts: 1,
    fills: 0,
    borders: 0,
    numFmts: 0,
    xfs: 1,
    reused: 0
  })
  expect(grid(result.bytes).styleOf(1999, 5)?.bl).toBe(1)
  expect(xml(result.bytes).match(/<c r="F\d+"/g)).toHaveLength(2000)
  checked(result.bytes, edits, [])
})

const SOFFICE =
  '/srv/agents/temp-code-data/work-tools/libreoffice/26.8.3/opt/libreoffice26.8/program/soffice'
test.skipIf(process.env.SHEET_HARNESS !== '1' || !existsSync(SOFFICE))(
  'LibreOffice prints three format-patched packages to nonempty PDFs',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'sheet-format-'))
    try {
      const outputs = [
        ['lo-style.xlsx', patchFormat(base, [styled('A2', labFormat)]).bytes],
        ['lo-layout.xlsx', patchFormat(base, labLayout).bytes],
        [
          'lo-macro.xlsm',
          patchFormat(file('macro.xlsm'), [styled('A1', { font: { bold: true } }, 'Main')]).bytes
        ]
      ] as const
      const inputs = outputs.map(([name, bytes]) => {
        saveOutput(name, bytes)
        const path = join(dir, name)
        writeFileSync(path, bytes)
        return path
      })
      const result = spawnSync(
        SOFFICE,
        [
          '-env:UserInstallation=' + pathToFileURL(join(dir, 'profile')).href,
          '--headless',
          '--convert-to',
          'pdf',
          '--outdir',
          dir,
          ...inputs
        ],
        { encoding: 'utf8', timeout: 35_000 }
      )
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr + result.stdout).toBe(0)
      for (const input of inputs) {
        const size = statSync(join(dir, basename(input).replace(/\.xls[mx]$/, '.pdf'))).size
        expect(size).toBeGreaterThan(0)
        console.info(`${basename(input)} printed a ${size}-byte PDF`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  40_000
)

test('a family or a size given back takes the workbook\'s default font\'s, and leaves the rest of the font', () => {
  const made = checked(base, [styled('A3', { font: { name: 'Tahoma', size: 18, bold: true } })], [SHEET, STYLES]).bytes
  expect(grid(made).styleOf(2, 0)).toMatchObject({ ff: 'Tahoma', fs: 18, bl: 1 })
  const { bytes } = checked(made, [styled('A3', { font: { name: null, size: null } })], [SHEET, STYLES], 'default-font.xlsx')
  const normal = grid(bytes).styleOf(0, 3) ?? {}
  const back = grid(bytes).styleOf(2, 0)!
  // the family and size are the default font's again (the importer reads neither on a cell in the default font); bold stays
  expect(back.bl).toBe(1)
  expect(back.ff).toBe(normal.ff)
  expect(back.fs).toBe(normal.fs)
  const fonts = document(bytes, STYLES).getElementsByTagNameNS(NS, 'font')
  const first = fonts[0]!
  const last = fonts[fonts.length - 1]!
  const val = (font: typeof first, tag: string) => font.getElementsByTagNameNS(NS, tag)[0]?.getAttribute('val')
  expect(val(last, 'name')).toBe(val(first, 'name'))
  expect(val(last, 'sz')).toBe(val(first, 'sz'))
  expect(val(last, 'scheme')).toBe(val(first, 'scheme'))
  expect(last.getElementsByTagNameNS(NS, 'b')).toHaveLength(1)
})

test('a style named only: the cell wears its name and keeps the look it is given, not the record\'s', () => {
  // Currency on a bold cell, as the grid lays it: the number format alone, the bold the cell's own
  const bold = checked(base, [styled('B4', { font: { bold: true } })], [SHEET, STYLES]).bytes
  const edit = styled('B4', { namedStyle: 4, namedOnly: true, numFmt: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)' })
  const { bytes } = checked(bold, [edit], [SHEET, STYLES], 'named-only.xlsx')
  const styles = document(bytes, STYLES)
  const entry = childrenOf(styles.getElementsByTagNameNS(NS, 'cellStyles')[0]!).find((el) => el.getAttribute('builtinId') === '4')!
  expect(entry.getAttribute('name')).toBe('Currency')
  expect(xfAt(bytes, 'B4')?.getAttribute('xfId')).toBe(entry.getAttribute('xfId'))
  expect(grid(bytes).styleOf(3, 1)).toMatchObject({ bl: 1, n: { pattern: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)' } })
  // alone, a named style still takes the record's look, as before
  const alone = checked(bold, [styled('B4', { namedStyle: 26 })], [SHEET, STYLES]).bytes
  expect(grid(alone).styleOf(3, 1)).toMatchObject({ bg: { rgb: '#C6EFCE' }, cl: { rgb: '#006100' } })
  checked(bytes, [edit], [])
})
