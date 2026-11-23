import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readDocx } from 'work-kit/formats/docx'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { kindOfEntry } from '@shared/work/files'
import { askedFields, fieldValues, isFilledField, starterSlug, STARTER_KEY } from '@shared/work/templates'
import { fillOffice, scanOffice } from '../ooxml'
import { partBytes, partText, readZip } from '../zip'
import { DECKS } from './decks'
import { DOCS } from './docs'
import { STARTERS, starterFile, starterKey } from './manifest'
import { SHEETS } from './sheets'

/*
 * Our starter templates as checked in (resources/work-templates, built by
 * scripts/build-work-templates.ts): one file per manifest entry and no
 * other, colours only in the theme, no picture, font or name of anyone real,
 * and each file's fields the manifest's.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const shelf = join(root, 'resources', 'work-templates')
const bytesOf = (file: string): Uint8Array => new Uint8Array(readFileSync(join(shelf, file)))

/** Literal colours an Office part may hold; `auto` is automatic ink and no colour. */
const LITERAL = [
  /<w:color\b[^>]*\bw:val="(?!auto")[^"]*"/,
  /\b(?:w:color|w:fill|w:themeFill|rgb|lastClr)="(?!auto")[0-9A-Fa-f]{6,8}"/,
  /<(?:a:srgbClr|a:sysClr|a:scrgbClr|a:prstClr|w:highlight)\b/,
  /<(?:fgColor|bgColor|color)\b[^>]*\brgb=/
]
/** Employers, schools, leagues, games and people: none of them is in any starter. */
const DENY = ['Cosmic', 'CosmicGames', 'Hypixel', 'Purdue', 'RecWell', 'Unify', 'UnifyPlatforms', 'Landon', 'IHSA', 'NFHS', 'Big Ten', 'Minecraft', 'Boilermaker']

const files = (): string[] => readdirSync(shelf).flatMap((sector) => readdirSync(join(shelf, sector)).map((name) => `${sector}/${name}`))

describe('the starter manifest', () => {
  it('names each starter once, its slug from its name, with the keys callers use', () => {
    const keys = STARTERS.map(starterKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of STARTERS) {
      expect(s.slug).toBe(starterSlug(s.name))
      expect(starterKey(s)).toMatch(STARTER_KEY)
      expect(s.fields.some(isFilledField)).toBe(false)
    }
    expect(keys).toContain('unify/invoice')
    expect(keys).toContain('any/meeting-notes')
  })

  it('has a fixture for every starter, of its kind, and none left over', () => {
    const byKind = { document: Object.keys(DOCS), sheet: Object.keys(SHEETS), deck: Object.keys(DECKS) }
    for (const kind of ['document', 'sheet', 'deck'] as const) expect(byKind[kind].sort()).toEqual(STARTERS.filter((s) => s.kind === kind).map(starterKey).sort())
  })
})

describe('the checked-in starters', () => {
  it('are one file per manifest entry, and no other file', () => {
    expect(files().sort()).toEqual(STARTERS.map(starterFile).sort())
  })

  it.each(STARTERS.map((s) => [starterFile(s), s] as const))('%s is its kind, asks its fields in order and keeps the rules', (file, s) => {
    const bytes = bytesOf(file)
    expect(kindOfEntry(file).kind).toBe(s.kind)
    expect(askedFields(scanOffice(s.form, bytes))).toEqual(s.fields)

    const parts = readZip(bytes)
    for (const p of parts) {
      // No picture, no embedded font. An empty folder's entry (pptxgenjs writes `ppt/embeddings/`) holds nothing.
      if (p.name.endsWith('/')) {
        expect(p.size, `${file} ${p.name}`).toBe(0)
        continue
      }
      expect(p.name, file).not.toMatch(/(^|\/)(media|fonts)\//)
      // A native chart keeps its numbers in a workbook of its own; nothing else is embedded.
      if (/(^|\/)embeddings\//.test(p.name)) expect(p.name, file).toMatch(/^ppt\/embeddings\/Microsoft_Excel_Worksheet\d*\.xlsx$/)
      expect(p.name, file).not.toMatch(/\.(odttf|ttf|otf|png|jpe?g|gif|emf|wmf|svg)$/i)
      if (!/\.(xml|rels)$/.test(p.name)) continue
      const xml = partText(p)
      expect(xml, `${file} ${p.name}`).not.toMatch(/<w:embed(Regular|Bold|Italic|BoldItalic)\b/)
      // No name of anyone real in any part's text.
      for (const name of DENY) expect(new RegExp(`\\b${name}\\b`, 'i').test(xml), `${file} ${p.name} names ${name}`).toBe(false)
      // Documents and sheets: colours are theme slots alone. A deck wears what slides_new's theme writes.
      if (s.form !== 'pptx' && !/theme\/theme\d+\.xml$/.test(p.name)) for (const re of LITERAL) expect(xml, `${file} ${p.name}`).not.toMatch(re)
    }
    // Every part unpacks.
    for (const p of parts) expect(() => partBytes(p)).not.toThrow()
  })

  it.each(STARTERS.filter((s) => s.form === 'docx').map((s) => [starterFile(s), s] as const))('%s reads back in our document reader with its headings', (file, s) => {
    const { blocks } = readDocx(bytesOf(file))
    const text = (b: (typeof blocks)[number]): string => (Array.isArray(b.content) ? b.content.map((x) => (x.type === 'text' ? x.text : '')).join('') : '')
    const headings = (bs: typeof blocks): string[] => bs.filter((b) => b.type === 'heading').map(text)
    expect(headings(blocks)).toEqual(headings(DOCS[starterKey(s)]!().blocks).map((h) => h.replace(/\*\*/g, '')))
    // A table's head rows read back as the fixture set them: no row the writer marked "not a head" counts as one.
    const heads = (bs: typeof blocks): number[] => bs.filter((b) => b.type === 'table').map((b) => (b.content as { headerRows?: number }).headerRows ?? 0)
    expect(heads(blocks)).toEqual(heads(DOCS[starterKey(s)]!().blocks))
  })

  it.each(STARTERS.filter((s) => s.form === 'xlsx').map((s) => [starterFile(s), s] as const))('%s reads back in our sheet reader', (file, s) => {
    const { workbook } = importXlsx(bytesOf(file))
    const sheets = Object.values(workbook.sheets ?? {})
    expect(sheets.map((x) => x.name)).toEqual(SHEETS[starterKey(s)]!().map((x) => x.name))
    const first = sheets[0]!.cellData?.[0]?.[0]
    expect(typeof first?.v === 'string' && first.v.length > 0).toBe(true)
    // Every formula carries its result, so a reader with no calculator (a CSV export, a preview) shows the totals.
    type Cell = { f?: string; v?: unknown }
    for (const sheet of sheets)
      for (const row of Object.values(sheet.cellData ?? {}) as Record<string, Cell>[])
        for (const cell of Object.values(row ?? {})) if (cell?.f) expect(cell.v, `${file} ${cell.f}`).not.toBeUndefined()
  })

  it.each(STARTERS.filter((s) => s.form !== 'pptx').map((s) => [starterFile(s), s] as const))('%s fills every field, its own and the three filled without asking', (file, s) => {
    const values = fieldValues(Object.fromEntries([...s.fields, 'Date', 'Name', 'Job'].map((f) => [f, `Dummy ${f}`])))
    const filled = fillOffice(s.form as 'docx' | 'xlsx', bytesOf(file), values, { today: '2026-11-23' })
    expect(scanOffice(s.form, filled.bytes)).toEqual([])
  })
})

const partOf = (file: string, name: string): string => partText(readZip(bytesOf(file)).find((p) => p.name === name)!)
const docxFiles = STARTERS.filter((s) => s.form === 'docx').map(starterFile)
const xlsxFiles = STARTERS.filter((s) => s.form === 'xlsx').map(starterFile)
const BODY = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\/>|<w:p>[\s\S]*?<\/w:p>/g
const isList = (p: string): boolean => p.includes('<w:pStyle w:val="ListParagraph"/>')

describe('the starter documents on paper', () => {
  it.each(docxFiles)('%s: every paragraph in a cell, an empty one too, has no space after it', (file) => {
    const xml = partOf(file, 'word/document.xml')
    for (const cell of xml.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []) {
      expect(cell, file).not.toContain('<w:p/>')
      for (const p of cell.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? []) expect(p, file).toMatch(/<w:pPr>[\s\S]*<w:spacing w:after="0"\/>[\s\S]*<\/w:pPr>/)
    }
  })

  it.each(docxFiles)('%s: no list or table is cut from what leads into it, nor split', (file) => {
    const parts = partOf(file, 'word/document.xml').match(BODY) ?? []
    parts.forEach((part, i) => {
      const next = parts[i + 1] ?? ''
      if (part.startsWith('<w:tbl>')) {
        const rows = part.match(/<w:tr>[\s\S]*?<\/w:tr>/g) ?? []
        rows.forEach((row, r) => {
          expect(row, file).toContain('<w:cantSplit/>')
          // Every row but the last keeps with the next, so the table moves whole.
          if (r < rows.length - 1) for (const p of row.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? []) expect(p, file).toContain('<w:keepNext/>')
        })
      } else if (isList(part) && isList(next)) expect(part, `${file}: a list item`).toContain('<w:keepNext/>')
      else if (!isList(part) && (next.startsWith('<w:tbl>') || isList(next))) {
        // A heading keeps with the next by its style; any other line that leads into a list or a table does so itself.
        if (!/<w:pStyle w:val="Heading\d"\/>/.test(part)) expect(part, `${file}: a lead line`).toContain('<w:keepNext/>')
      }
    })
    expect(partOf(file, 'word/styles.xml')).toMatch(/w:styleId="Heading2">[\s\S]*?<w:keepNext\/>/)
  })

  it('Game report says Away as its field does, and leaves the game date for the day played', () => {
    const xml = partOf('ref/Game report.docx', 'word/document.xml')
    expect(xml).not.toContain('Visitor')
    expect(xml).toContain('Date played')
    expect(xml).toContain('Submitted by {{Name}} on {{Date}}.')
  })
})

describe('the starter sheets', () => {
  it.each(xlsxFiles)('%s: the page header prints from page two on, the footer on every page', (file) => {
    for (const p of readZip(bytesOf(file)).filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x.name))) {
      const hf = /<headerFooter\b[^>]*>[\s\S]*?<\/headerFooter>/.exec(partText(p))![0]
      expect(hf).not.toContain('<firstHeader>')
      if (hf.includes('<oddHeader>')) {
        expect(hf).toContain('differentFirst="1"')
        expect(/<firstFooter>([\s\S]*?)<\/firstFooter>/.exec(hf)?.[1]).toBe(/<oddFooter>([\s\S]*?)<\/oddFooter>/.exec(hf)?.[1])
      }
    }
  })

  it.each(xlsxFiles)('%s: no formula reads an entered zero as nothing entered', (file) => {
    for (const f of partOf(file, 'xl/worksheets/sheet1.xml').match(/<f>[^<]*<\/f>/g) ?? []) expect(f, file).not.toMatch(/\b[A-Z]{1,2}\$?\d+=0\b/)
  })

  it('the checklist and the shot list count a Yes only on a row that holds a task, and pick lists sit on task rows only', () => {
    const tasks = (file: string, column: string): Set<number> => {
      const xml = partOf(file, 'xl/worksheets/sheet1.xml')
      return new Set([...xml.matchAll(new RegExp(`<c r="${column}(\\d+)"[^>]*t="s"`, 'g'))].map((m) => +m[1]!))
    }
    const checklist = partOf('cosmic/Release checklist.xlsx', 'xl/worksheets/sheet1.xml')
    expect(checklist).toContain('<f>COUNTIFS(B6:B40,"&lt;&gt;",E6:E40,"Yes")&amp;" of "&amp;COUNTA(B6:B40)&amp;" steps done"</f>')
    // The Done list covers the step rows and no phase row (a phase's name is in column A, its B empty).
    const steps = tasks('cosmic/Release checklist.xlsx', 'B')
    const sqref = /<dataValidation [^>]*sqref="([^"]+)"/.exec(checklist)![1]!
    const listed = sqref.split(' ').flatMap((r) => {
      const [, a, b] = /^E(\d+):E(\d+)$/.exec(r)!
      return Array.from({ length: +b! - +a! + 1 }, (_, i) => +a! + i)
    })
    expect(listed.every((r) => steps.has(r))).toBe(true)
    expect(listed.length).toBe(16)
    const shots = partOf('hypixel/Shot list.xlsx', 'xl/worksheets/sheet1.xml')
    expect(shots).toContain('<f>COUNTIFS(C7:C26,"&lt;&gt;",H7:H26,"Yes")&amp;" of "&amp;COUNTA(C7:C26)&amp;" shots done"</f>')
  })

  it('the invoice has a sender to write, and one terms value drives the due date', () => {
    const sheet = partOf('unify/Invoice.xlsx', 'xl/worksheets/sheet1.xml')
    const strings = partOf('unify/Invoice.xlsx', 'xl/sharedStrings.xml')
    expect(strings).toContain('Email or phone')
    expect(sheet).toContain('<f>IF(ISNUMBER(D9),D9+N(D11),"")</f>')
    expect(sheet).toMatch(/<c r="D11" s="\d+"><v>30<\/v><\/c>/)
    // The sender's address is whole, as Bill to's is: street, then city, state and ZIP.
    expect(strings.indexOf('<t>City, state, ZIP</t>')).toBeGreaterThan(-1)
    expect(sheet).toMatch(/<c r="A6" s="\d+" t="s">/)
    // A line's amount waits for both its quantity and its rate.
    expect(sheet).toContain('<f>IF(AND(ISNUMBER(B15),ISNUMBER(C15)),B15*C15,"")</f>')
    expect(sheet).toContain('<f>SUM(D15:D22)</f>')
    // A short row parts the Payment heading's rule from the note, which sits in the middle of its box.
    expect(sheet).toContain('<row r="29" ht="6" customHeight="1"></row>')
    expect(partOf('unify/Invoice.xlsx', 'xl/styles.xml')).toContain('<alignment horizontal="left" vertical="center" wrapText="1" indent="1"/>')
    // The payment note names no number of days: the terms cell is the one place it lives.
    const note = /<t>(Pay by bank transfer[^<]*)<\/t>/.exec(strings)![1]!
    expect(note).not.toMatch(/\d/)
  })
})

describe('the starters, round two of the council', () => {
  it.each(docxFiles)('%s: the page header and footer print from page two on, with nothing our reader cannot keep', (file) => {
    const doc = partOf(file, 'word/document.xml')
    expect(doc).toMatch(/<w:(header|footer)Reference w:type="default"/)
    expect(doc).toContain('<w:titlePg/>')
    // No header or footer of the first page's own: Word leaves that page's blank, and the app's reader counts one as lost.
    expect(doc).not.toMatch(/<w:(header|footer)Reference w:type="(first|even)"/)
    expect(readDocx(bytesOf(file)).sidecar.dropped).toEqual({})
  })

  it.each(docxFiles)('%s: a quoted word wears typographic quotes', (file) => {
    const words = [...partOf(file, 'word/document.xml').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(' ')
    expect(words).not.toMatch(/["']|&quot;|&apos;/)
  })

  it('the Release note leaves its release date for him and dates its draft', () => {
    const xml = partOf('cosmic/Release note.docx', 'word/document.xml')
    expect(xml).toContain('Date of the rollout')
    expect(xml).toMatch(/Prepared<\/w:t>[\s\S]*?\{\{Date\}\} by \{\{Name\}\}/)
  })

  it('the Trip plan starts its lists to work through on a page of their own', () => {
    const xml = partOf('life/Trip plan.docx', 'word/document.xml')
    expect(xml).toMatch(/<w:pStyle w:val="Heading2"\/><w:pageBreakBefore\/><\/w:pPr><w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t[^>]*>Before we leave<\/w:t>/)
    expect(xml).not.toContain('<w:br w:type="page"/>')
  })

  it('a budget totals the differences of the rows that have an actual, and leaves the balance until both sides have one', () => {
    const travel = partOf('purdue/Travel budget.xlsx', 'xl/worksheets/sheet1.xml')
    expect(travel).toContain('<f>IF(COUNT(F10:F16)=0,"",SUM(G10:G16))</f>')
    const monthly = partOf('life/Monthly budget.xlsx', 'xl/worksheets/sheet1.xml')
    expect(monthly).toContain('<f>IF(COUNT(C5:C6)=0,"",SUM(D5:D6))</f>')
    expect(monthly).toContain('<f>IF(COUNT(C10:C22)=0,"",SUM(D10:D22))</f>')
    expect(monthly).toContain('<f>IF(AND(COUNT(C5:C6)&gt;0,COUNT(C10:C22)&gt;0),C7-C23,"")</f>')
  })
})
