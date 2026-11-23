import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { expect, test } from 'vitest'
import { patchText, readText, TextRefused, type Run, type TextEdit } from './text'
import { readText as partText, readZip, writeZip, type Entry, type Zip } from './zip'

const SHEET = 'xl/worksheets/sheet1.xml'
const SHEET2 = 'xl/worksheets/sheet2.xml'
const SST = 'xl/sharedStrings.xml'
const BOOK = 'xl/workbook.xml'
const BOOK_RELS = 'xl/_rels/workbook.xml.rels'
const STYLES = 'xl/styles.xml'
const CT = '[Content_Types].xml'
const SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, '../harness/corpus', name)))
const base = fixture('patch/base.xlsx')
const formats = fixture('formats.xlsx')
const formulas = fixture('formulas.xlsx')
const xml = (bytes: Uint8Array, part = SHEET) => partText(readZip(bytes), part)
const enc = new TextEncoder()
const entries = (parts: Record<string, string>) =>
  new Map(Object.entries(parts).map(([key, value]) => [key, enc.encode(value)]))
const parts = (
  bytes: Uint8Array,
  changes: Record<string, string>,
  added: Record<string, string> = {},
  removed: string[] = []
) => writeZip(readZip(bytes), entries(changes), new Set(removed), entries(added))
type CellRuns = [row: number, column: number, runs: Run[] | null]
const edit = (cells: CellRuns[], sheet = 'Data'): TextEdit => ({
  kind: 'text',
  sheet,
  cells: cells.map(([row, column, runs]) => ({ row, column, runs }))
})
const cell = (bytes: Uint8Array, ref: string, part = SHEET) =>
  new RegExp(`<(?:\\w+:)?c r="${ref}"[^>]*?(?:/>|>.*?</(?:\\w+:)?c>)`).exec(xml(bytes, part))?.[0]
const items = (bytes: Uint8Array, part = SST) =>
  xml(bytes, part).match(/<(?:\w+:)?si>.*?<\/(?:\w+:)?si>/gs) ?? []
// The base file's one font, as a run that sets something is written with it.
const FONT =
  '<sz val="11"/><color theme="1"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/>'

function localRecord(z: Zip, entry: Entry): Buffer {
  const view = new DataView(z.buf.buffer, z.buf.byteOffset, z.buf.byteLength)
  const at = entry.localOffset
  let end = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true) + entry.compSize
  if (entry.flags & 8) end += view.getUint32(end, true) === 0x08074b50 ? 16 : 12
  return Buffer.from(z.buf.subarray(at, end))
}

/** Runs the patch and holds it to its report: the parts it names changed, every other entry kept its bytes. */
function checked(
  input: Uint8Array,
  edits: TextEdit[],
  expected: { changed?: string[]; added?: string[] } = {},
  proof?: { name: string; holds: string; excel: string }
) {
  const { bytes, report } = patchText(input, edits)
  const { changed = [], added = [] } = expected
  expect(report.partsChanged.toSorted()).toEqual(changed.toSorted())
  expect(report.partsAdded.toSorted()).toEqual(added.toSorted())
  expect(report.partsRemoved).toEqual([])
  const before = readZip(input)
  const after = readZip(bytes)
  expect([...after.byName.keys()].toSorted()).toEqual(
    [...before.byName.keys(), ...added].toSorted()
  )
  for (const entry of before.entries)
    expect(
      localRecord(before, entry).equals(localRecord(after, after.byName.get(entry.name)!)),
      entry.name
    ).toBe(!changed.includes(entry.name))
  if (!changed.length && !added.length) expect(bytes).toBe(input)
  for (const part of [...changed, ...added]) {
    const errors: string[] = []
    new DOMParser({ onError: (_level, message) => errors.push(message) }).parseFromString(
      xml(bytes, part),
      'application/xml'
    )
    expect(errors, part).toEqual([])
  }
  // The table's own counts stay true: one item for each `si`.
  const sst = [...after.byName.keys()].find((part) => /sharedStrings\d*\.xml$/.test(part))
  if (sst) {
    const unique = /uniqueCount="(\d+)"/.exec(xml(bytes, sst))
    if (unique) expect(Number(unique[1])).toBe(items(bytes, sst).length)
  }
  if (proof && process.env.TEXT_PROOF_DIR) {
    mkdirSync(process.env.TEXT_PROOF_DIR, { recursive: true })
    writeFileSync(join(process.env.TEXT_PROOF_DIR, proof.name + '.xlsx'), bytes)
    writeFileSync(
      join(process.env.TEXT_PROOF_DIR, proof.name + '.json'),
      JSON.stringify({ ...proof, kind: 'text', edits, report, rich: readText(bytes) }, null, 2) +
        '\n'
    )
  }
  return bytes
}

/** The words the installed importer reads in a cell. */
function imported(bytes: Uint8Array, sheet: number, row: number, column: number) {
  const { workbook } = importXlsx(bytes)
  return workbook.sheets[workbook.sheetOrder[sheet]].cellData?.[row]?.[column]?.v
}

const EVERY: Run[] = [
  { text: 'bold ', font: { bold: true } },
  { text: 'italic ', font: { italic: true } },
  { text: 'under ', font: { underline: true } },
  { text: 'strike ', font: { strike: true } },
  { text: 'red ', font: { colour: '#c00000' } },
  { text: 'accent ', font: { colour: { theme: 4, tint: -0.25 } } },
  { text: 'mono ', font: { face: 'Courier New' } },
  { text: 'big ', font: { size: 16.5 } },
  { text: 'x', font: {} },
  { text: '2', font: { vertical: 'super' } },
  { text: 'n', font: { vertical: 'sub' } },
  {
    text: ' all',
    font: {
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      colour: '#0070C0',
      face: 'Arial',
      size: 9,
      vertical: 'super'
    }
  }
]

test('reads the corpus file’s rich cell as runs', () => {
  expect(readText(formats)).toEqual([
    {
      sheet: 'Styles',
      row: 27,
      column: 1,
      runs: [
        { text: 'plain ' },
        { text: 'bold ', font: { bold: true, colour: { theme: 1 }, face: 'Calibri', size: 11 } },
        { text: 'red', font: { colour: '#FF0000', face: 'Calibri', size: 11 } }
      ]
    }
  ])
  expect(readText(formats, 'Formats')).toEqual([])
  expect(readText(base)).toEqual([])
  expect(() => readText(base, 'Nowhere')).toThrow(TextRefused)
})

test('writes one run for each property in Excel’s order, each a whole font, and reads them back', () => {
  const bytes = checked(
    base,
    [edit([[0, 1, EVERY]])],
    { changed: [SHEET, SST] },
    {
      name: 'every-property',
      holds: 'Data!B1 holds one run for each property a run can set.',
      excel:
        'B1 reads "bold italic under strike red accent mono big x2n all": each word in the style it names, the rest Calibri 11 black; "2" raised, "n" lowered.'
    }
  )
  // B1 named the table before: the count of cells that do stays, one item is added.
  expect(xml(bytes, SST)).toContain('count="29" uniqueCount="3"')
  expect(cell(bytes, 'B1')).toBe('<c r="B1" t="s"><v>2</v></c>')
  expect(items(bytes)[2]).toBe(
    '<si>' +
      `<r><rPr><b/>${FONT}</rPr><t xml:space="preserve">bold </t></r>` +
      `<r><rPr><i/>${FONT}</rPr><t xml:space="preserve">italic </t></r>` +
      `<r><rPr><u/>${FONT}</rPr><t xml:space="preserve">under </t></r>` +
      `<r><rPr><strike/>${FONT}</rPr><t xml:space="preserve">strike </t></r>` +
      `<r><rPr><sz val="11"/><color rgb="FFC00000"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/></rPr><t xml:space="preserve">red </t></r>` +
      `<r><rPr><sz val="11"/><color theme="4" tint="-0.25"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/></rPr><t xml:space="preserve">accent </t></r>` +
      // a new face leaves the old one's family and theme scheme behind
      `<r><rPr><sz val="11"/><color theme="1"/><rFont val="Courier New"/></rPr><t xml:space="preserve">mono </t></r>` +
      `<r><rPr><sz val="16.5"/><color theme="1"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/></rPr><t xml:space="preserve">big </t></r>` +
      // a run that sets nothing has no properties
      '<r><t>x</t></r>' +
      `<r><rPr><vertAlign val="superscript"/>${FONT}</rPr><t>2</t></r>` +
      `<r><rPr><vertAlign val="subscript"/>${FONT}</rPr><t>n</t></r>` +
      '<r><rPr><b/><i/><strike/><u/><vertAlign val="superscript"/><sz val="9"/><color rgb="FF0070C0"/><rFont val="Arial"/></rPr><t xml:space="preserve"> all</t></r>' +
      '</si>'
  )
  const whole = { colour: { theme: 1 }, face: 'Calibri', size: 11 }
  expect(readText(bytes)).toEqual([
    {
      sheet: 'Data',
      row: 0,
      column: 1,
      runs: [
        { text: 'bold ', font: { bold: true, ...whole } },
        { text: 'italic ', font: { italic: true, ...whole } },
        { text: 'under ', font: { underline: true, ...whole } },
        { text: 'strike ', font: { strike: true, ...whole } },
        { text: 'red ', font: { ...whole, colour: '#C00000' } },
        { text: 'accent ', font: { ...whole, colour: { theme: 4, tint: -0.25 } } },
        { text: 'mono ', font: { ...whole, face: 'Courier New' } },
        { text: 'big ', font: { ...whole, size: 16.5 } },
        { text: 'x' },
        { text: '2', font: { ...whole, vertical: 'super' } },
        { text: 'n', font: { ...whole, vertical: 'sub' } },
        {
          text: ' all',
          font: {
            bold: true,
            italic: true,
            underline: true,
            strike: true,
            colour: '#0070C0',
            face: 'Arial',
            size: 9,
            vertical: 'super'
          }
        }
      ]
    }
  ])
  expect(imported(bytes, 0, 0, 1)).toBe('bold italic under strike red accent mono big x2n all')
  // A repeat finds the cell as it wants it, and so does what was read back.
  checked(bytes, [edit([[0, 1, EVERY]])])
  checked(bytes, [edit([[0, 1, readText(bytes)[0].runs]])])
})

test('keeps the cell’s style, makes a number cell and a missing cell string cells, and counts them', () => {
  const runs: Run[] = [{ text: 'a' }, { text: 'b', font: { bold: true } }]
  // A2 is a styled number, F40 is in no row of the file.
  const bytes = checked(
    base,
    [
      edit([
        [1, 0, runs],
        [39, 5, runs]
      ])
    ],
    { changed: [SHEET, SST] }
  )
  expect(cell(bytes, 'A2')).toBe('<c r="A2" s="1" t="s"><v>2</v></c>')
  expect(cell(bytes, 'F40')).toBe('<c r="F40" t="s"><v>2</v></c>')
  expect(xml(bytes, SST)).toContain('count="31" uniqueCount="3"')
  expect(xml(bytes)).toContain('<dimension ref="A1:F40"/>')
})

test('one item serves every cell with the same runs, in one patch and in a later one', () => {
  const runs: Run[] = [{ text: 'Net ' }, { text: 'total', font: { bold: true } }]
  const once = checked(
    base,
    [
      edit([
        [2, 1, runs],
        [3, 1, runs]
      ])
    ],
    { changed: [SHEET, SST] },
    {
      name: 'shared-rich-string',
      holds: 'Data!B3 and Data!B4 name one shared string item with two runs.',
      excel: 'B3 and B4 both read "Net total" with "total" bold.'
    }
  )
  expect(items(once)).toHaveLength(3)
  expect(cell(once, 'B3')).toContain('<v>2</v>')
  expect(cell(once, 'B4')).toContain('<v>2</v>')
  const again = checked(once, [edit([[4, 1, runs]])], { changed: [SHEET] })
  expect(items(again)).toHaveLength(3)
  expect(cell(again, 'B5')).toContain('<v>2</v>')
})

test('a lone run that sets nothing is plain text, and an equal plain item is taken', () => {
  const bytes = checked(
    base,
    [
      edit([
        [2, 0, [{ text: 'keep' }]],
        [3, 0, [{ text: 'new', font: {} }]]
      ])
    ],
    {
      changed: [SHEET, SST]
    }
  )
  expect(cell(bytes, 'A3')).toBe('<c r="A3" t="s"><v>0</v></c>')
  expect(items(bytes)[2]).toBe('<si><t>new</t></si>')
  expect(xml(bytes, SST)).toContain('count="31" uniqueCount="3"')
  expect(readText(bytes)).toEqual([])
})

test('a run’s font is whole: its face and size are the cell’s where it names none, and what the cell has on is said off', () => {
  const styles = (ref: string, row: number, runs: Run[]) => {
    const bytes = patchText(formats, [edit([[row, 1, runs]], 'Styles')]).bytes
    const index = Number(/<v>(\d+)<\/v>/.exec(cell(bytes, ref, SHEET2)!)![1])
    return items(bytes)[index]
  }
  const rest =
    '<sz val="11"/><color theme="1"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/>'
  // B9 is Courier New with no theme scheme: an italic run stays in that face.
  expect(styles('B9', 8, [{ text: 'a ' }, { text: 'b', font: { italic: true } }])).toBe(
    '<si><r><t xml:space="preserve">a </t></r><r><rPr><i/><sz val="11"/><color theme="1"/><rFont val="Courier New"/><family val="2"/></rPr><t>b</t></r></si>'
  )
  // B2 is bold: a run that is not bold says so (by `false` or by leaving it out), and a bold run is the cell's own font.
  for (const font of [{ bold: false }, {}])
    expect(
      styles('B2', 1, [
        { text: 'a', font },
        { text: 'b', font: { bold: true } }
      ])
    ).toBe(`<si><r><rPr><b val="0"/>${rest}</rPr><t>a</t></r><r><t>b</t></r></si>`)
  expect(styles('B2', 1, [{ text: 'all bold', font: { bold: true } }])).toBe(
    '<si><t>all bold</t></si>'
  )
  // B5 is underlined twice: an underlined run keeps that kind, one without says none.
  expect(
    styles('B5', 4, [
      { text: 'a', font: { underline: true, italic: true } },
      { text: 'b', font: {} }
    ])
  ).toBe(
    `<si><r><rPr><i/><u val="double"/>${rest}</rPr><t>a</t></r><r><rPr><u val="none"/>${rest}</rPr><t>b</t></r></si>`
  )
  // B8 is 16 points: a red run stays 16 points.
  expect(styles('B8', 7, [{ text: 'a' }, { text: 'b', font: { colour: '#FF0000' } }])).toContain(
    '<rPr><sz val="16"/><color rgb="FFFF0000"/><rFont val="Calibri"/><family val="2"/><scheme val="minor"/></rPr>'
  )
  // B7 is dark red: a run that names no colour is in the workbook's own ink, as the grid draws it.
  expect(styles('B7', 6, [{ text: 'a' }, { text: 'b', font: { bold: true } }])).toContain(
    `<rPr><b/>${rest}</rPr>`
  )
  // B10 is raised: a run that is not goes back to the line.
  expect(styles('B10', 9, [{ text: 'a' }, { text: 'b', font: {} }])).toContain(
    `<rPr><vertAlign val="baseline"/>${rest}</rPr>`
  )
  const proof = checked(
    formats,
    [
      edit(
        [
          [1, 1, [{ text: 'bold cell, ' }, { text: 'this run not bold', font: {} }]],
          [
            6,
            1,
            [
              { text: 'red cell, ' },
              { text: 'this run bold and red', font: { bold: true, colour: '#C00000' } }
            ]
          ],
          [
            7,
            1,
            [{ text: '16 point cell, ' }, { text: 'this run red', font: { colour: '#FF0000' } }]
          ],
          [8, 1, [{ text: 'Courier cell, ' }, { text: 'this run italic', font: { italic: true } }]],
          [9, 1, [{ text: 'raised cell, ' }, { text: 'this run on the line', font: {} }]],
          [
            27,
            1,
            [
              { text: 'plain ' },
              { text: 'bold ', font: { bold: true } },
              { text: 'green', font: { colour: '#00B050' } }
            ]
          ]
        ],
        'Styles'
      )
    ],
    { changed: [SHEET2, SST] },
    {
      name: 'cell-fonts',
      holds:
        'Styles!B2, B7, B8, B9 and B10 have a font of their own (bold; dark red; 16 points; Courier New; raised) and get a second run that differs in one thing; B28, rich before, has new runs.',
      excel:
        'B2: "this run not bold" is not bold, the rest bold. B7: all dark red, "this run bold and red" bold. B8: all 16 points, "this run red" red. B9: all Courier New, "this run italic" italic. B10: "raised cell, " raised, "this run on the line" not. B28: "plain bold green" with "bold" bold and "green" green.'
    }
  )
  expect(imported(proof, 1, 27, 1)).toBe('plain bold green')
})

test('a rich cell sent as it is read changes nothing, however its runs are cut', () => {
  const [{ row, column, runs }] = readText(formats)
  checked(formats, [edit([[row, column, runs]], 'Styles')])
  // The grid may hand one run as two.
  const cut: Run[] = [runs[0], { ...runs[1], text: 'bo' }, { ...runs[1], text: 'ld ' }, runs[2]]
  checked(formats, [edit([[row, column, cut]], 'Styles')])
})

test('runs: null turns a rich cell back into plain text and leaves every other cell alone', () => {
  const bytes = checked(formats, [edit([[27, 1, null]], 'Styles')], { changed: [SHEET2, SST] })
  expect(readText(bytes)).toEqual([])
  expect(items(bytes).at(-1)).toBe('<si><t>plain bold red</t></si>')
  expect(cell(bytes, 'B28', SHEET2)).toBe('<c r="B28" t="s"><v>54</v></c>')
  expect(imported(bytes, 1, 27, 1)).toBe('plain bold red')
  // a plain cell, a number, a formula and a cell that is not there
  checked(base, [
    edit([
      [0, 1, null],
      [0, 0, null],
      [1, 2, null],
      [99, 9, null]
    ])
  ])
  // Runs with no text in them say the same: nothing here is styled.
  const emptied = checked(
    formats,
    [edit([[27, 1, [{ text: '', font: { bold: true } }, { text: '\u0001' }]]], 'Styles')],
    { changed: [SHEET2, SST] }
  )
  expect(readText(emptied)).toEqual([])
  checked(base, [
    edit([
      [0, 1, []],
      [1, 2, [{ text: '' }]]
    ])
  ])
})

test('white space, markup, line ends and characters XML refuses', () => {
  const runs: Run[] = [
    { text: ' lead', font: { bold: true } },
    { text: 'a < b & "c"\r\nnext\rline\ttab' },
    { text: 'bell\u0007 _x0041_ half\ud83d \ufffe', font: { italic: true } },
    { text: '\u0001', font: { bold: true } }
  ]
  const bytes = checked(base, [edit([[0, 1, runs]])], { changed: [SHEET, SST] })
  const item = items(bytes)[2]
  expect(item).toContain('<t xml:space="preserve"> lead</t>')
  expect(item).toContain(
    '<t xml:space="preserve">a &lt; b &amp; &quot;c&quot;\nnext\nline\ttab</t>'
  )
  expect(item).toContain('<t xml:space="preserve">bell _x005F_x0041_ half </t>')
  expect(item.match(/<r>/g)).toHaveLength(3)
  expect(readText(bytes)[0].runs.map((run) => run.text)).toEqual([
    ' lead',
    'a < b & "c"\nnext\nline\ttab',
    'bell _x0041_ half '
  ])
  expect(imported(bytes, 0, 0, 1)).toBe(' leada < b & "c"\nnext\nline\ttabbell _x0041_ half ')
})

// The base file with its text inline and no shared strings part at all.
function noTable() {
  const drop = (text: string, pattern: RegExp) => {
    expect(text).toMatch(pattern)
    return text.replace(pattern, '')
  }
  const inline = (part: string, words: string[]) =>
    xml(base, part).replace(
      /<c r="(\w+)" t="s"><v>(\d)<\/v><\/c>/g,
      (_, ref, index) => `<c r="${ref}" t="inlineStr"><is><t>${words[index]}</t></is></c>`
    )
  return parts(
    base,
    {
      [SHEET]: inline(SHEET, ['keep', 'keep shared string']),
      [SHEET2]: inline(SHEET2, ['keep', 'keep shared string']),
      [BOOK_RELS]: drop(xml(base, BOOK_RELS), /<Relationship Id="rId5"[^>]*\/>/),
      [CT]: drop(xml(base, CT), /<Override PartName="\/xl\/sharedStrings\.xml"[^>]*\/>/)
    },
    {},
    [SST]
  )
}

test('a workbook with no shared strings part gains one with its relationship and content type', () => {
  const source = noTable()
  expect(readZip(source).byName.has(SST)).toBe(false)
  const runs: Run[] = [{ text: 'first ' }, { text: 'table', font: { bold: true } }]
  const bytes = checked(
    source,
    [
      edit([
        [0, 1, runs],
        [5, 5, runs]
      ])
    ],
    { changed: [SHEET, BOOK_RELS, CT], added: [SST] },
    {
      name: 'no-shared-strings',
      holds:
        'A file whose text was all inline: Data!B1 and Data!F6 hold rich text in a shared strings part the patch made.',
      excel: 'B1 and F6 read "first table" with "table" bold; B2 and below still read "keep".'
    }
  )
  expect(xml(bytes, SST)).toBe(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<sst xmlns="${SML}" count="2" uniqueCount="1"><si><r><t xml:space="preserve">first </t></r><r><rPr><b/>${FONT}</rPr><t>table</t></r></si></sst>`
  )
  expect(xml(bytes, BOOK_RELS)).toContain(
    '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
  )
  expect(xml(bytes, CT)).toContain(
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
  )
  expect(readText(bytes).map(({ row, column }) => [row, column])).toEqual([
    [0, 1],
    [5, 5]
  ])
  expect(imported(bytes, 0, 0, 1)).toBe('first table')
  expect(imported(bytes, 0, 1, 1)).toBe('keep')
  checked(bytes, [
    edit([
      [0, 1, runs],
      [5, 5, runs]
    ])
  ])
  // A part of that name nobody names is left alone: the new one takes the next free name.
  const orphan = parts(source, {}, { [SST]: '<sst/>' })
  expect(patchText(orphan, [edit([[0, 1, runs]])]).report.partsAdded).toEqual([
    'xl/sharedStrings1.xml'
  ])
})

test('an inline rich string is read, kept when sent as it is, and moved to the table when it changes', () => {
  const rich =
    '<c r="B1" t="inlineStr"><is><r><t xml:space="preserve">in </t></r><r><rPr><i/></rPr><t>line</t></r></is></c>'
  const source = parts(base, { [SHEET]: xml(base).replace('<c r="B1" t="s"><v>0</v></c>', rich) })
  expect(readText(source)).toEqual([
    {
      sheet: 'Data',
      row: 0,
      column: 1,
      runs: [{ text: 'in ' }, { text: 'line', font: { italic: true } }]
    }
  ])
  const changed = checked(
    source,
    [edit([[0, 1, [{ text: 'in ' }, { text: 'line', font: { bold: true } }]]])],
    {
      changed: [SHEET, SST]
    }
  )
  expect(cell(changed, 'B1')).toBe('<c r="B1" t="s"><v>2</v></c>')
  expect(xml(changed, SST)).toContain('count="30" uniqueCount="3"')
  const plain = checked(source, [edit([[0, 1, null]])], { changed: [SHEET, SST] })
  expect(items(plain)[2]).toBe('<si><t>in line</t></si>')
})

test('a formula cell and a cell an array fills are refused', () => {
  expect(() => patchText(base, [edit([[1, 2, [{ text: 'x', font: { bold: true } }]]])])).toThrow(
    /C2 holds a formula/
  )
  expect(() => patchText(formulas, [edit([[2, 0, [{ text: 'x' }]]], 'Dynamic')])).toThrow(
    TextRefused
  )
})

test('Excel is asked to calculate again only where a formula may read words that changed', () => {
  const quiet = (text: string) => text.replace(' fullCalcOnLoad="1"', '')
  const source = parts(base, {
    [BOOK]: quiet(xml(base, BOOK)),
    [SHEET]: xml(base).replace('<f>A2*2</f><v>24.69</v>', '<f>B2&amp;A2</f><v>keep12.345</v>')
  })
  const runs: Run[] = [{ text: 'ke' }, { text: 'pt', font: { bold: true } }]
  // B2's words change and C2 reads them.
  const read = patchText(source, [edit([[1, 1, runs]])])
  expect(read.report.fullCalcOnLoad).toBe(true)
  expect(read.report.partsChanged.toSorted()).toEqual([SHEET, SST, BOOK].toSorted())
  expect(xml(read.bytes, BOOK)).toContain('<calcPr calcId="124519" fullCalcOnLoad="1"/>')
  // The same words in new styles change no answer.
  const styled = patchText(source, [
    edit([[1, 1, [{ text: 'ke' }, { text: 'ep', font: { bold: true } }]]])
  ])
  expect(styled.report.fullCalcOnLoad).toBe(false)
  expect(styled.report.partsChanged.toSorted()).toEqual([SHEET, SST].toSorted())
  // B9's words change and no formula reads them.
  const apart = patchText(source, [edit([[8, 1, runs]])])
  expect(apart.report.fullCalcOnLoad).toBe(false)
  expect(apart.report.partsChanged.toSorted()).toEqual([SHEET, SST].toSorted())
  const proof = checked(
    formulas,
    [
      edit([
        [1, 1, [{ text: 'Nor' }, { text: 'th', font: { bold: true, colour: '#C00000' } }]],
        [2, 1, [{ text: 'Far ' }, { text: 'South', font: { italic: true } }]]
      ])
    ],
    { changed: [SHEET, SST] },
    {
      name: 'beside-formulas',
      holds:
        'Data!B2 keeps its word "North" in two styles; Data!B3 changes from "South" to "Far South". Formulas on Calc count and sum by those words.',
      excel:
        'Data!B2 reads "North" with "th" bold and dark red; B3 reads "Far South" with "South" italic. Calc!B6 (COUNTIF North) still answers as before; Calc!B9 (AVERAGEIF South) answers without row 3 once Excel has calculated.'
    }
  )
  // The corpus file already asks for a full calculation: the mark is true and the workbook part is not rewritten.
  expect(patchText(formulas, [edit([[2, 1, runs]])]).report.fullCalcOnLoad).toBe(true)
  expect(imported(proof, 0, 1, 1)).toBe('North')
})

test('a table header may take styles and may not take new words', () => {
  const tables = fixture('tables.xlsx')
  const styled = checked(
    tables,
    [edit([[1, 1, [{ text: 'Reg' }, { text: 'ion', font: { italic: true } }]]], 'Sales')],
    {
      changed: [SHEET, SST]
    }
  )
  expect(readText(styled, 'Sales')).toHaveLength(1)
  expect(() =>
    patchText(tables, [edit([[1, 1, [{ text: 'Area', font: { italic: true } }]]], 'Sales')])
  ).toThrow(/B2 names a table column/)
})

test('refuses what a cell cannot hold, before anything is written', () => {
  const refused =
    (cells: unknown, sheet = 'Data') =>
    () =>
      patchText(base, [{ kind: 'text', sheet, cells } as TextEdit])
  const one = (runs: unknown, row = 0, column = 1) => refused([{ row, column, runs }])
  expect(refused([], 'Nowhere')).toThrow(/No worksheet named “Nowhere”/)
  expect(one([{ text: 'x' }], -1)).toThrow(/outside the worksheet/)
  expect(one([{ text: 'x' }], 0, 16_384)).toThrow(/outside the worksheet/)
  expect(one([{ text: 'x' }], 1.5)).toThrow(/outside the worksheet/)
  expect(one('bold')).toThrow(/list of runs/)
  expect(one([{ font: {} }])).toThrow(/list of runs/)
  expect(one([{ text: 'a'.repeat(32_767) }, { text: 'b' }])).toThrow(/more than 32,767 characters/)
  expect(one(Array.from({ length: 1_025 }, () => ({ text: 'a' })))).toThrow(/more than 1,024 times/)
  expect(one([{ text: 'x', font: { colour: 'red' } }])).toThrow(/“red” is not a colour/)
  expect(one([{ text: 'x', font: { colour: { theme: 1.5 } } }])).toThrow(/theme colour/)
  expect(one([{ text: 'x', font: { colour: { theme: 1, tint: 2 } } }])).toThrow(/tint/)
  expect(one([{ text: 'x', font: { size: 0 } }])).toThrow(/between 1 and 409/)
  expect(one([{ text: 'x', font: { size: Number.NaN } }])).toThrow(/between 1 and 409/)
  expect(one([{ text: 'x', font: { face: 'F'.repeat(32) } }])).toThrow(/1 to 31 characters/)
  expect(one([{ text: 'x', font: { bold: 'yes' } }])).toThrow(/on or off/)
  expect(one([{ text: 'x', font: { vertical: 'up' } }])).toThrow(/superscript/)
  expect(
    refused(Array.from({ length: 20_001 }, (_, row) => ({ row, column: 0, runs: null })))
  ).toThrow(/at most 20,000 cells/)
  for (const attempt of [one([{ text: 'x', font: { size: 0 } }]), refused([], 'Nowhere')])
    expect(attempt).toThrow(TextRefused)
  // A refusal on the last cell leaves nothing of the first.
  expect(() =>
    patchText(base, [
      edit([
        [0, 1, [{ text: 'fine' }]],
        [1, 2, [{ text: 'formula' }]]
      ])
    ])
  ).toThrow(TextRefused)
  // The most a cell takes is taken.
  const full = patchText(base, [
    edit([[0, 1, [{ text: 'a'.repeat(32_766) }, { text: 'b', font: { bold: true } }]]])
  ])
  expect(readText(full.bytes)[0].runs[0].text).toHaveLength(32_766)
  expect(patchText(base, []).bytes).toBe(base)
})

test('prefixes and unusual namespaces survive', () => {
  const prefixed = (text: string, prefix: string) =>
    text
      .replace(/(<\/?)(\w+)(?=[\s/>])/g, `$1${prefix}:$2`)
      .replace(`xmlns="${SML}"`, `xmlns:${prefix}="${SML}"`)
  const source = parts(base, {
    [SHEET]: prefixed(xml(base), 'm'),
    [SST]: prefixed(xml(base, SST), 'x'),
    [STYLES]: prefixed(xml(base, STYLES), 'st')
  })
  const runs: Run[] = [{ text: 'a ' }, { text: 'b', font: { bold: true } }]
  const bytes = checked(
    source,
    [
      edit([
        [0, 1, runs],
        [0, 0, runs]
      ])
    ],
    { changed: [SHEET, SST] }
  )
  expect(xml(bytes, SST)).toContain('<x:sst xmlns:x="' + SML + '" count="30" uniqueCount="3">')
  expect(xml(bytes, SST)).toContain(
    '<x:si><x:r><x:t xml:space="preserve">a </x:t></x:r><x:r><x:rPr><x:b/><x:sz val="11"/><x:color theme="1"/><x:rFont val="Calibri"/><x:family val="2"/><x:scheme val="minor"/></x:rPr><x:t>b</x:t></x:r></x:si></x:sst>'
  )
  expect(cell(bytes, 'B1')).toBe('<m:c r="B1" t="s"><m:v>2</m:v></m:c>')
  expect(readText(bytes)).toHaveLength(2)
  expect(imported(bytes, 0, 0, 1)).toBe('a b')
  checked(bytes, [
    edit([
      [0, 1, runs],
      [0, 0, runs]
    ])
  ])
  // Single quotes, a table with no counts and an item with what the model does not hold.
  const odd = parts(base, {
    [SST]: `<sst xmlns='${SML}'><si><t>keep</t></si><si><r><rPr><b/><outline/></rPr><t>odd</t></r><rPh sb="0" eb="1"><t>o</t></rPh></si></sst>`,
    [SHEET2]: xml(base, SHEET2)
  })
  const kept = checked(odd, [edit([[2, 1, [{ text: 'odd', font: { bold: true } }]]])], {
    changed: [SHEET, SST]
  })
  // The odd item is not taken for another cell: its outline and its phonetic run are not what was asked for.
  expect(items(kept)).toHaveLength(3)
  expect(xml(kept, SST)).toMatch(/^<sst xmlns='[^']+'><si>/)
})

test('hostile input is refused in words or read within bounds', () => {
  const broken = parts(base, { [SST]: xml(base, SST).replace('</sst>', '') })
  expect(() => patchText(broken, [edit([[0, 1, [{ text: 'x', font: { bold: true } }]]])])).toThrow(
    TextRefused
  )
  expect(() => readText(broken)).toThrow(/could not be read/)
  expect(() => readText(new Uint8Array(64))).toThrow(TextRefused)
  expect(() => patchText(new Uint8Array(64), [edit([[0, 0, [{ text: 'x' }]]])])).toThrow(
    TextRefused
  )
  // An item of ten thousand runs, a cell that names no item, and counts that are not numbers.
  const many = '<si>' + '<r><rPr><b/><i/></rPr><t>ab</t></r>'.repeat(10_000) + '</si>'
  const big = parts(base, {
    [SST]: xml(base, SST)
      .replace('count="29" uniqueCount="2"', 'count="lots" uniqueCount="-1"')
      .replace('</sst>', many + '</sst>'),
    [SHEET]: xml(base)
      .replace('<c r="B1" t="s"><v>0</v></c>', '<c r="B1" t="s"><v>2</v></c>')
      .replace('<c r="B2" t="s"><v>0</v></c>', '<c r="B2" t="s"><v>999999</v></c>')
  })
  const started = performance.now()
  const cells = readText(big)
  expect(cells).toHaveLength(1)
  expect(cells[0].runs).toHaveLength(10_000)
  const done = patchText(big, [
    edit([
      [1, 1, [{ text: 'x', font: { bold: true } }]],
      [0, 1, null]
    ])
  ])
  expect(readText(done.bytes).map(({ row }) => row)).toEqual([1])
  expect(performance.now() - started).toBeLessThan(5_000)
  // A sheet whose rows carry no numbers cannot take a new row: said in words.
  const bare = parts(base, { [SHEET]: xml(base).replace(/<row r="\d+"/g, '<row') })
  expect(() => patchText(bare, [edit([[99, 0, [{ text: 'x' }]]])])).toThrow(/cannot add a cell/)
})
