import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import type { NewDeck } from '@shared/contract-work-slides'
import { convertersOf, JobRunner } from '../formats/jobs'
import { SLIDES_CONVERTERS, type DeckInfo } from './deck'
import { NEW_DECK_LAYOUTS, writeNewDeck } from './newDeck'

const DECK: NewDeck = {
  title: 'Showcase',
  theme: { dark: true, accent: 'ff7a00' },
  slides: [
    { layout: 'title', title: 'Spring showcase', subtitle: 'Run of show' },
    { layout: 'bullets', title: 'Doors', bullets: ['Open at six', { text: 'Staff at five', level: 1 }], notes: 'Mention parking' },
    { layout: 'table', title: 'Budget', table: [['Item', 'Cost'], ['Stage']] },
    { layout: 'chart', title: 'Viewers', chart: { type: 'line', categories: ['Mon', 'Tue'], series: [{ name: 'Stream', values: [1200, 6200] }] } },
    { layout: 'section', title: 'After' }
  ]
}

const text = (zip: JSZip, name: string): Promise<string> => zip.file(name)!.async('string')

describe('writeNewDeck', () => {
  it('writes one slide per entry, each from a named layout with real title and body placeholders', async () => {
    const zip = await JSZip.loadAsync(await writeNewDeck(DECK))
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    expect(slides).toHaveLength(5)
    const layouts = await Promise.all(Object.keys(zip.files).filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n)).map((n) => text(zip, n)))
    const names = layouts.map((x) => /<p:cSld name="([^"]*)"/.exec(x)?.[1])
    expect(names).toEqual(expect.arrayContaining(Object.values(NEW_DECK_LAYOUTS)))
    const bullets = layouts.find((x) => x.includes(`name="${NEW_DECK_LAYOUTS.bullets}"`))!
    expect(bullets).toMatch(/<p:ph[^>]*\stype="title"/)
    expect(bullets).toMatch(/<p:ph[^>]*\stype="body"/)
    const two = await text(zip, 'ppt/slides/slide2.xml')
    expect(two).toMatch(/<p:ph[^>]*\stype="title"/)
    expect(two).toMatch(/<p:ph[^>]*\stype="body"/)
    // The size is on the text itself, not only on the layout.
    expect(two).toMatch(/<a:rPr[^>]* sz="3000"/)
    expect(two).toMatch(/<a:rPr[^>]* sz="2000"/)
    expect(two).toContain('lvl="1"')
    expect(await text(zip, 'ppt/slides/slide1.xml')).toMatch(/<a:rPr[^>]* sz="4400"/)
  })

  it('writes a native chart with its workbook, a table, the notes and the theme', async () => {
    const zip = await JSZip.loadAsync(await writeNewDeck(DECK))
    const files = Object.keys(zip.files)
    expect(files.some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true)
    expect(files.some((n) => /^ppt\/embeddings\/.*\.xlsx$/.test(n))).toBe(true)
    const chart = await text(zip, files.find((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))!)
    expect(chart).toContain('<c:lineChart>')
    expect(chart).toContain('FF7A00')
    // A short row is padded to the head's width.
    const table = await text(zip, 'ppt/slides/slide3.xml')
    expect(table).toContain('<a:tbl>')
    expect(table.match(/<a:tc[ >]/g)).toHaveLength(4)
    const notes = await Promise.all(files.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).map((n) => text(zip, n)))
    expect(notes.some((x) => x.includes('Mention parking'))).toBe(true)
    // A dark ground on every layout, the accent's bar on it.
    const layout = await text(zip, files.find((n) => /^ppt\/slideLayouts\/slideLayout2\.xml$/.test(n))!)
    expect(layout).toContain('16181D')
    expect(layout).toContain('FF7A00')
  })

  it('refuses a deck the schema refuses', async () => {
    await expect(writeNewDeck({ title: '', slides: [] } as unknown as NewDeck)).rejects.toThrow()
  })
})

const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA
describe.skipIf(!DATA)('a new deck through the pptx → deckinfo converter', () => {
  it('reads back as its slides, by layout, with the table, the chart and the notes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-slides-new-'))
    try {
      const input = join(dir, 'new.pptx')
      writeFileSync(input, await writeNewDeck(DECK))
      const runner = new JobRunner({ host: 'env_test', dataDir: DATA!, converters: convertersOf([{ id: 'slides', ensure() {}, convert: SLIDES_CONVERTERS }]), log: () => {} })
      const done = await runner.convert({ from: 'pptx', to: 'deckinfo', input, output: join(dir, 'info.json') })
      const d = JSON.parse(readFileSync(done.output, 'utf8')) as DeckInfo
      expect(d.slides.map((s) => [s.layout, s.title])).toEqual(DECK.slides.map((s) => [NEW_DECK_LAYOUTS[s.layout], s.title]))
      expect(d.slides[0].shapes.find((s) => s.placeholder === 'body')?.text).toBe('Run of show')
      expect(d.slides[1]).toMatchObject({ notes: 'Mention parking' })
      expect(d.slides[1].shapes.find((s) => s.placeholder === 'body')?.text).toBe('Open at six\nStaff at five')
      expect(d.slides[2].shapes.find((s) => s.kind === 'table')?.cells).toEqual([['Item', 'Cost'], ['Stage', '']])
      expect(d.slides[3].shapes.find((s) => s.kind === 'chart')?.chart).toEqual({ categories: ['Mon', 'Tue'], series: [{ name: 'Stream', values: [1200, 6200] }] })
      expect(d.layouts).toEqual(expect.arrayContaining(Object.values(NEW_DECK_LAYOUTS)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
