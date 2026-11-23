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
  })

  it.each(STARTERS.filter((s) => s.form === 'xlsx').map((s) => [starterFile(s), s] as const))('%s reads back in our sheet reader', (file, s) => {
    const { workbook } = importXlsx(bytesOf(file))
    const sheets = Object.values(workbook.sheets ?? {})
    expect(sheets.map((x) => x.name)).toEqual(SHEETS[starterKey(s)]!().map((x) => x.name))
    const first = sheets[0]!.cellData?.[0]?.[0]
    expect(typeof first?.v === 'string' && first.v.length > 0).toBe(true)
  })

  it.each(STARTERS.filter((s) => s.form !== 'pptx').map((s) => [starterFile(s), s] as const))('%s fills every field, its own and the three filled without asking', (file, s) => {
    const values = fieldValues(Object.fromEntries([...s.fields, 'Date', 'Name', 'Job'].map((f) => [f, `Dummy ${f}`])))
    const filled = fillOffice(s.form as 'docx' | 'xlsx', bytesOf(file), values, { today: '2026-11-23' })
    expect(scanOffice(s.form, filled.bytes)).toEqual([])
  })
})
