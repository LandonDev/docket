import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkScope } from '@shared/work'
import type { ToolCtx } from '../../modules'
import { makeZip, partText, readZip, writeZip } from '../zip'

/**
 * Makes the fixtures the fill's tests read (run by hand, then checked in):
 *
 *   bun --preload ./scripts/lib/electron-stub.ts src/main/server/work/templates/fixtures/make.ts
 *
 * `split.docx` and `fields.xlsx` are written part by part, as small as Word
 * and Excel still open. `split.pptx` is a deck the slides pillar's own
 * `slides_new` makes, with one field then split over three runs the way
 * PowerPoint leaves a typed `{{Client}}`. `link.pptx` is not made here: it
 * was written once with python-pptx (a text box of three paragraphs, two
 * runs with links, `{{Client}}` beside one), for the fill's link test;
 * `cell-link.pptx` the same way (a 2×2 table, a cell with `{{Client}}`
 * then a linked run).
 * Dummy names only.
 */

const here = dirname(fileURLToPath(import.meta.url))
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

// ── split.docx ────────────────────────────────────────────────────────

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const run = (text: string, bold = false): string => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`

const docx = makeZip({
  '[Content_Types].xml':
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
    '</Types>',
  '_rels/.rels':
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>',
  'word/_rels/document.xml.rels':
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
    '</Relationships>',
  'word/styles.xml': `${XML}<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
  'word/header1.xml': `${XML}<w:hdr ${W}><w:p>${run('{{Job}} · ')}${run('{{Date}}')}</w:p></w:hdr>`,
  'word/document.xml':
    `${XML}<w:document ${W}><w:body>` +
    // As Word leaves a field typed in one go: the braces and the name in runs of their own, a proofing mark between.
    `<w:p>${run('Game report for ')}${run('{{')}<w:proofErr w:type="spellStart"/>${run('Client', true)}<w:proofErr w:type="spellEnd"/>${run('}}')}${run(' at {{Site}}.')}</w:p>` +
    `<w:p>${run('Filed by {{Name}} on {{Date}}. ')}${run('{{client}}', true)}${run(' again, and {{Site}} left alone.')}</w:p>` +
    `<w:p>${run('No field here: {Client} and { {Site} }.')}</w:p>` +
    // A table cell: its paragraph is its own.
    `<w:tbl><w:tr><w:tc><w:p>${run('Crew: {{Crew}}')}</w:p></w:tc><w:tc><w:p>${run('{{Cr')}</w:p><w:p>${run('ew}}')}</w:p></w:tc></w:tr></w:tbl>` +
    '<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>' +
    '</w:body></w:document>'
})

// ── fields.xlsx ───────────────────────────────────────────────────────

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const xlsx = makeZip({
  '[Content_Types].xml':
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '</Types>',
  '_rels/.rels':
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>',
  'xl/_rels/workbook.xml.rels':
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
    '</Relationships>',
  'xl/workbook.xml': `${XML}<workbook ${S} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Invoice" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  // Style 1 is a date (numFmt 14): the lone Date cell wears it.
  'xl/styles.xml':
    `${XML}<styleSheet ${S}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
    '</styleSheet>',
  // 0 a field in words, 1 the lone Date, 2 a rich string whose field is split over two runs, 3 the Date inside a sentence.
  'xl/sharedStrings.xml':
    `${XML}<sst ${S} count="5" uniqueCount="4">` +
    '<si><t>Bill to {{Client}}</t></si>' +
    '<si><t>{{Date}}</t></si>' +
    '<si><r><t xml:space="preserve">Invoice {{Invoice </t></r><r><rPr><b/></rPr><t>number}}</t></r></si>' +
    '<si><t>Sent {{Date}}</t></si>' +
    '</sst>',
  'xl/worksheets/sheet1.xml':
    `${XML}<worksheet ${S}><sheetData>` +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>From {{Job}}</t></is></c><c r="B1" t="s"><v>0</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1" t="s"><v>1</v></c><c r="C2" s="1" t="inlineStr"><is><t>{{date}}</t></is></c></row>' +
    '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>120.5</v></c><c r="C3"><f>B3*2</f><v>241</v></c><c r="D3" s="1"/></row>' +
    '<row r="4"><c r="A4" t="s"><v>1</v></c></row>' +
    '</sheetData><headerFooter><oddHeader>&amp;C{{Job}} for {{Client}}</oddHeader><oddFooter>&amp;LPage &amp;P</oddFooter></headerFooter></worksheet>'
})

// ── split.pptx ────────────────────────────────────────────────────────

async function deck(): Promise<Uint8Array> {
  const { slides } = await import('../../slides')
  const scope = { workspaceId: 'w1', sector: null } as unknown as WorkScope
  const tool = slides.tools!(scope).find((t) => t.name === 'slides_new')!
  const dir = mkdtempSync(join(tmpdir(), 'tpl-fixture-'))
  const save = join(dir, 'split.pptx')
  try {
    const ctx = {
      host: 'env_box',
      sessionId: 's1',
      scope,
      signal: new AbortController().signal,
      log: () => {},
      canvas: { open: () => ({ id: 'item_1', sessionId: 's1', kind: 'slides', title: 'Pitch', source: { at: 'file', host: 'env_box', path: save } }) }
    } as unknown as ToolCtx
    const said = await tool.run(
      {
        title: 'Pitch',
        save,
        slides: [
          { layout: 'title', title: 'Pitch for {{Client}}', subtitle: '{{Job}} · {{Date}}' },
          { layout: 'bullets', title: 'Why {{Client}}', bullets: ['Presented by {{Name}}', 'No field here', 'Left alone: {{Budget}}'], notes: 'Notes are not scanned: {{Hidden}}' }
        ]
      },
      ctx
    )
    if (said.isError) throw new Error(JSON.stringify(said.content))
    const parts = readZip(readFileSync(save))
    const slide = parts.find((p) => p.name === 'ppt/slides/slide1.xml')!
    const xml = partText(slide)
    // PowerPoint's own split of a typed field: `{{`, the name in a run its spelling check marked (`err`), `}}`.
    const whole = /<a:r>(<a:rPr[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>))<a:t>Pitch for \{\{Client\}\}<\/a:t><\/a:r>/.exec(xml)
    if (!whole) throw new Error('the title run was not found: slides_new writes it another way now')
    const rpr = whole[1]!
    const marked = rpr.replace('<a:rPr', '<a:rPr err="1"')
    const split = `<a:r>${rpr}<a:t>Pitch for {{</a:t></a:r><a:r>${marked}<a:t>Client</a:t></a:r><a:r>${rpr}<a:t>}}</a:t></a:r>`
    return writeZip(parts, new Map([[slide.name, new TextEncoder().encode(xml.replace(whole[0], split))]]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

mkdirSync(here, { recursive: true })
writeFileSync(join(here, 'split.docx'), docx)
writeFileSync(join(here, 'fields.xlsx'), xlsx)
writeFileSync(join(here, 'split.pptx'), await deck())
console.log('wrote split.docx, fields.xlsx, split.pptx')
