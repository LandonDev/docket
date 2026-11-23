import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fieldValues } from '@shared/work/templates'
import { dateStyles, escapeXml, fillOffice, paragraphsOf, scanOffice, tcdocPreview, unescapeXml } from './ooxml'
import { makeZip, NotZipError, partBytes, partText, readZip, writeZip } from './zip'

/*
 * The scan and the fill on the checked-in fixtures (fixtures/make.ts): a
 * field Word split over three runs, a field in a header, a workbook with a
 * shared string, an inline string and a lone date cell, and a deck that is
 * only read here. Dummy names only.
 */

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name)))
const part = (bytes: Uint8Array, name: string): string => partText(readZip(bytes).find((p) => p.name === name)!)
/** The words of a Word part, paragraph by paragraph. */
const words = (xml: string): string[] => paragraphsOf(xml, ['w:p'], 'w:t').map((runs) => runs.map((r) => unescapeXml(xml.slice(r.start, r.end))).join(''))

const VALUES = fieldValues({ Client: 'A<B & "C" \'D\'', Name: 'Sam Dummy', Date: 'November 23, 2026', Job: 'Dummy Esports', Crew: 'R, U1, U2', 'invoice NUMBER': '0042' })

describe('the zip', () => {
  it('reads what it wrote and keeps every part an edit did not name, compressed bytes and all', () => {
    const zip = makeZip({ 'a.xml': '<a>one</a>', 'b/c.xml': '<c>two</c>'.repeat(200), 'd.bin': new Uint8Array([0, 1, 2, 255]) })
    const before = readZip(zip)
    expect(before.map((e) => e.name)).toEqual(['a.xml', 'b/c.xml', 'd.bin'])
    const after = readZip(writeZip(before, new Map([['a.xml', new TextEncoder().encode('<a>changed</a>')]])))
    expect(partText(after[0]!)).toBe('<a>changed</a>')
    expect(Buffer.from(after[1]!.packed).equals(Buffer.from(before[1]!.packed))).toBe(true)
    expect([...partBytes(after[2]!)]).toEqual([0, 1, 2, 255])
    expect(after.map((e) => e.name)).toEqual(['a.xml', 'b/c.xml', 'd.bin'])
  })

  it('adds no part for a name the zip does not hold', () => {
    const zip = makeZip({ 'a.xml': '<a/>' })
    expect(readZip(writeZip(readZip(zip), new Map([['new.xml', new Uint8Array([1])]]))).map((e) => e.name)).toEqual(['a.xml'])
  })

  it('refuses bytes that are no zip, in words', () => {
    expect(() => readZip(new TextEncoder().encode('plain words, long enough to hold an end record'))).toThrow(NotZipError)
    expect(() => readZip(makeZip({ 'a.xml': '<a/>' }).subarray(10))).toThrow(NotZipError)
  })

  it('makes the same bytes twice', () => {
    expect(Buffer.from(makeZip({ 'a.xml': '<a/>' })).equals(Buffer.from(makeZip({ 'a.xml': '<a/>' })))).toBe(true)
  })
})

describe('escaping', () => {
  it('escapes what XML reads as markup and drops what it cannot hold', () => {
    expect(escapeXml('a<b>&"c"\u0001\u000b')).toBe('a&lt;b&gt;&amp;"c"')
    expect(unescapeXml('a&lt;b&gt;&amp;&quot;&apos;&#65;&#x42;&bogus;')).toBe('a<b>&"\'AB&bogus;')
  })
})

describe('a Word file', () => {
  const docx = fixture('split.docx')

  it('finds a field split over three runs, a field in a header, and each name once', () => {
    expect(scanOffice('docx', docx)).toEqual(['Client', 'Site', 'Name', 'Date', 'Crew', 'Job'])
  })

  it('never joins a field across two paragraphs', () => {
    expect(words(part(docx, 'word/document.xml')).slice(-2)).toEqual(['{{Cr', 'ew}}'])
    const filled = fillOffice('docx', docx, VALUES).bytes
    expect(words(part(filled, 'word/document.xml')).slice(-2)).toEqual(['{{Cr', 'ew}}'])
  })

  it('fills each field where it stands and leaves one with no value as written', () => {
    const { bytes, changed } = fillOffice('docx', docx, VALUES)
    expect(changed.sort()).toEqual(['word/document.xml', 'word/header1.xml'])
    expect(words(part(bytes, 'word/document.xml'))).toEqual([
      'Game report for A<B & "C" \'D\' at {{Site}}.',
      'Filed by Sam Dummy on November 23, 2026. A<B & "C" \'D\' again, and {{Site}} left alone.',
      'No field here: {Client} and { {Site} }.',
      'Crew: R, U1, U2',
      '{{Cr',
      'ew}}'
    ])
    expect(words(part(bytes, 'word/header1.xml'))).toEqual(['Dummy Esports · November 23, 2026'])
    expect(scanOffice('docx', bytes)).toEqual(['Site'])
  })

  it('writes the value into the run where the field starts and keeps every run and its formatting', () => {
    const before = part(docx, 'word/document.xml')
    const after = part(fillOffice('docx', docx, VALUES).bytes, 'word/document.xml')
    const runs = (xml: string): number => xml.match(/<w:r>/g)!.length
    expect(runs(after)).toBe(runs(before))
    expect(after.match(/<w:b\/>/g)!.length).toBe(before.match(/<w:b\/>/g)!.length)
    // The braces' run takes the value; the bold run that held the name is empty, and still bold.
    expect(after).toContain('<w:r><w:t xml:space="preserve">A&lt;B &amp; "C" \'D\'</w:t></w:r>')
    expect(after).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"></w:t></w:r>')
    expect(after).toContain('<w:proofErr w:type="spellStart"/>')
  })

  it('keeps the bytes of every part that held no field', () => {
    const before = readZip(docx)
    const after = readZip(fillOffice('docx', docx, VALUES).bytes)
    expect(after.map((e) => e.name)).toEqual(before.map((e) => e.name))
    for (const [i, entry] of before.entries()) {
      if (entry.name === 'word/document.xml' || entry.name === 'word/header1.xml') continue
      expect(Buffer.from(after[i]!.packed).equals(Buffer.from(entry.packed)), entry.name).toBe(true)
      expect(after[i]!.crc).toBe(entry.crc)
    }
  })

  it('answers the same bytes when no field has a value', () => {
    const { bytes, changed } = fillOffice('docx', docx, fieldValues({ Other: 'x' }))
    expect(changed).toEqual([])
    expect(bytes).toBe(docx)
  })

  it('says its spaces count when a filled run starts or ends with one', () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    const zip = makeZip({ 'word/document.xml': `<w:document ${W}><w:body><w:p><w:r><w:t>{{A}}</w:t></w:r><w:r><w:t>{{B}}tail</w:t></w:r></w:p></w:body></w:document>` })
    const xml = part(fillOffice('docx', zip, fieldValues({ A: 'lead ', B: ' x ' })).bytes, 'word/document.xml')
    expect(xml).toContain('<w:t xml:space="preserve">lead </w:t>')
    expect(xml).toContain('<w:t xml:space="preserve"> x tail</w:t>')
  })

  it('fills a text box inside a paragraph as its own paragraph', () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    const zip = makeZip({
      'word/document.xml': `<w:document ${W}><w:body><w:p><w:r><w:t>{{</w:t></w:r><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>{{Box}}</w:t></w:r></w:p></w:txbxContent></w:pict></w:r><w:r><w:t>Out}}</w:t></w:r></w:p></w:body></w:document>`
    })
    expect(scanOffice('docx', zip)).toEqual(['Out', 'Box'])
    expect(words(part(fillOffice('docx', zip, fieldValues({ Box: 'in', Out: 'out' })).bytes, 'word/document.xml'))).toEqual(['out', 'in'])
  })
})

describe('an Excel file', () => {
  const xlsx = fixture('fields.xlsx')

  it('finds fields in the cells\' order: an inline string, shared strings, a rich string split over two runs, then the header', () => {
    expect(scanOffice('xlsx', xlsx)).toEqual(['Job', 'Client', 'Invoice number', 'Date'])
  })

  it('fills shared strings, inline strings and the header', () => {
    const { bytes, changed } = fillOffice('xlsx', xlsx, VALUES, { today: '2026-11-23' })
    expect(changed.sort()).toEqual(['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml'])
    const strings = part(bytes, 'xl/sharedStrings.xml')
    expect(strings).toContain('<si><t>Bill to A&lt;B &amp; "C" \'D\'</t></si>')
    expect(strings).toContain('<si><r><t xml:space="preserve">Invoice 0042</t></r><r><rPr><b/></rPr><t></t></r></si>')
    expect(strings).toContain('<si><t>Sent November 23, 2026</t></si>')
    const sheet = part(bytes, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t>From Dummy Esports</t></is></c>')
    // An ampersand in a header starts one of Excel's codes: a value's own is doubled.
    expect(sheet).toContain('<oddHeader>&amp;CDummy Esports for A&lt;B &amp;&amp; "C" \'D\'</oddHeader>')
    expect(sheet).toContain('<oddFooter>&amp;LPage &amp;P</oddFooter>')
    expect(scanOffice('xlsx', bytes)).toEqual([])
  })

  it('makes a lone Date cell in a date format a true date, and keeps the format', () => {
    const sheet = part(fillOffice('xlsx', xlsx, VALUES, { today: '2026-11-23' }).bytes, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="B2" s="1"><v>46349</v></c>')
    expect(sheet).toContain('<c r="C2" s="1"><v>46349</v></c>')
  })

  it('writes the day in words in a lone Date cell of any other format, and inside a sentence', () => {
    const { bytes } = fillOffice('xlsx', xlsx, VALUES, { today: '2026-11-23' })
    expect(part(bytes, 'xl/worksheets/sheet1.xml')).toContain('<c r="A4" t="s"><v>1</v></c>')
    const strings = part(bytes, 'xl/sharedStrings.xml')
    expect(strings).toContain('<si><t>November 23, 2026</t></si>')
    // One cell stopped pointing at a string: the table's count of uses says four.
    expect(strings).toContain('count="4" uniqueCount="4"')
  })

  it('leaves the date cells as words when the caller gave no day', () => {
    const sheet = part(fillOffice('xlsx', xlsx, VALUES).bytes, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="B2" s="1" t="s"><v>1</v></c>')
    expect(sheet).toContain('<c r="C2" s="1" t="inlineStr"><is><t>November 23, 2026</t></is></c>')
  })

  it('leaves numbers, formulas and empty cells alone, and every other part\'s bytes', () => {
    const { bytes } = fillOffice('xlsx', xlsx, VALUES, { today: '2026-11-23' })
    expect(part(bytes, 'xl/worksheets/sheet1.xml')).toContain('<c r="B3"><v>120.5</v></c><c r="C3"><f>B3*2</f><v>241</v></c><c r="D3" s="1"/>')
    const before = readZip(xlsx)
    const after = readZip(bytes)
    for (const [i, entry] of before.entries()) {
      if (entry.name === 'xl/sharedStrings.xml' || entry.name === 'xl/worksheets/sheet1.xml') continue
      expect(Buffer.from(after[i]!.packed).equals(Buffer.from(entry.packed)), entry.name).toBe(true)
    }
  })

  it('counts from 1904 in a workbook that does', () => {
    const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    const zip = makeZip({
      'xl/workbook.xml': `<workbook ${S}><workbookPr date1904="1"/></workbook>`,
      'xl/styles.xml': `<styleSheet ${S}><cellXfs count="1"><xf numFmtId="14"/></cellXfs></styleSheet>`,
      'xl/worksheets/sheet1.xml': `<worksheet ${S}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{{Date}}</t></is></c></row></sheetData></worksheet>`
    })
    expect(part(fillOffice('xlsx', zip, VALUES, { today: '2026-11-23' }).bytes, 'xl/worksheets/sheet1.xml')).toContain(`<c r="A1"><v>${46349 - 1462}</v></c>`)
  })

  it('knows a date format, built in or his own', () => {
    const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    const styles =
      `<styleSheet ${S}><numFmts count="3"><numFmt numFmtId="164" formatCode="[$-409]mmmm\\ d\\,\\ yyyy"/><numFmt numFmtId="165" formatCode="&quot;days&quot; 0.00"/><numFmt numFmtId="166" formatCode="[Red]General"/></numFmts>` +
      '<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs></styleSheet>'
    expect([...dateStyles(styles)]).toEqual([1, 2])
  })
})

describe('a deck', () => {
  const pptx = fixture('split.pptx')

  it('is read: a field PowerPoint split over three runs, slides in the deck\'s order, notes left out', () => {
    expect(scanOffice('pptx', pptx)).toEqual(['Client', 'Job', 'Date', 'Name', 'Budget'])
  })

  it('holds the split as PowerPoint writes it', () => {
    const slide = part(pptx, 'ppt/slides/slide1.xml')
    expect(slide).toMatch(/<a:t>Pitch for \{\{<\/a:t><\/a:r><a:r><a:rPr err="1"[^>]*\/?>(?:[\s\S]*?<\/a:rPr>)?<a:t>Client<\/a:t><\/a:r><a:r>/)
  })
})

describe('our own document', () => {
  it('reads the markdown preview a .tcdoc carries', () => {
    expect(tcdocPreview(makeZip({ 'state.yjs': new Uint8Array([1, 2]), 'preview.md': '# {{Client}}\n' }))).toBe('# {{Client}}\n')
    expect(tcdocPreview(makeZip({ 'state.yjs': new Uint8Array([1, 2]) }))).toBeNull()
    expect(tcdocPreview(new TextEncoder().encode('{}'))).toBeNull()
  })
})
