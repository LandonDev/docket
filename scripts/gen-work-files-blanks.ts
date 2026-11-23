// Writes the Files place's blank files once (docs/agents/work-files.md "New"): bun scripts/gen-work-files-blanks.ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import PptxGenJS from 'pptxgenjs'
import * as Y from 'yjs'
import { FileDocStore } from 'work-kit/collab-server'
import { TcsheetBackend } from '../src/main/server/work/sheets/host/backends'

const out = join(import.meta.dir, '..', 'resources', 'work-files', 'blank')
mkdirSync(out, { recursive: true })
// A fixed time in every zip, so a run again writes the same bytes.
const mtime = new Date('2026-01-01T00:00:00Z')
const zip = (parts: Record<string, string>): Uint8Array => zipSync(Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, [strToU8(text), { mtime }]])), { level: 6 })
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006'

// Word: the three parts a document needs, one empty paragraph on a Letter page.
writeFileSync(
  join(out, 'blank.docx'),
  zip({
    '[Content_Types].xml': `${XML}<Types xmlns="${PKG}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`
  })
)

// Excel: a workbook of one empty sheet, with the least stylesheet Excel reads without a repair.
const SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
writeFileSync(
  join(out, 'blank.xlsx'),
  zip({
    '[Content_Types].xml': `${XML}<Types xmlns="${PKG}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML}<workbook xmlns="${SML}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `${XML}<worksheet xmlns="${SML}"><sheetData/></worksheet>`,
    'xl/styles.xml': `${XML}<styleSheet xmlns="${SML}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  })
)

// PowerPoint: a wide deck of one blank slide, by the library the slides pillar already writes decks with.
const pres = new PptxGenJS()
pres.layout = 'LAYOUT_WIDE'
pres.addSlide()
writeFileSync(join(out, 'blank.pptx'), (await pres.write({ outputType: 'nodebuffer' })) as Buffer)

// Our document: an empty one, as the documents service stores a .tcdoc on its first save.
const tcdoc = join(out, 'blank.tcdoc')
rmSync(tcdoc, { force: true })
await new FileDocStore().store('blank', Y.encodeStateAsUpdate(new Y.Doc()), { markdown: '', plain: '' }, { path: tcdoc })

// Our sheet: an empty workbook of one sheet, as the sheets pillar makes a new .tcsheet.
const tcsheet = join(out, 'blank.tcsheet')
rmSync(tcsheet, { force: true })
TcsheetBackend.create(tcsheet, 'Untitled sheet')
console.log(`wrote the blank files to ${out}`)
