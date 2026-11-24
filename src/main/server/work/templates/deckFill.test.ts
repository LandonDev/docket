import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SlideOp } from '@shared/contract-work-slides'
import { fieldValues } from '@shared/work/templates'
import { LIBREOFFICE_CONVERTERS } from '../formats'
import { convertersOf, JobRunner, type ConvertJob, type ConvertResult } from '../formats/jobs'
import { SLIDES_CONVERTERS } from '../slides/deck'
import { accounts, deckOps, fillDeck, type DeckRead } from './deckFill'
import { deckCellRuns, scanOffice } from './ooxml'
import { makeZip, partText, readZip } from './zip'

/*
 * A deck's fill: the edits it asks of the slides pillar, with a converter
 * that stands in, and one real run through python-pptx behind
 * TEMP_CODE_WORK_TOOLS_DATA (deck.test.ts says where that is on the box).
 */

const VALUES = fieldValues({ Client: 'Acme & Co', Job: 'Dummy Esports', Date: 'November 23, 2026', Name: 'Sam Dummy' })

const DECK: DeckRead = {
  slides: [
    {
      id: 256,
      shapes: [
        { id: 2, text: 'Pitch for {{Client}}' },
        { id: 3, text: '{{Job}} · {{Date}}\nSecond line\n{{Budget}} stays' },
        { id: 4, text: 'No field' },
        { id: 5, text: '' }
      ]
    },
    {
      id: 300,
      shapes: [
        { id: 2, text: 'Only {{Budget}}' },
        { id: 7, text: '', cells: [['Item', '{{client}}'], ['{{Budget}}', 'By {{Name}}']] }
      ]
    }
  ]
}

describe('deckOps', () => {
  it('asks one text op for each shape read without its runs, every paragraph of the shape in it, and leaves a cell read without its runs', () => {
    expect(deckOps(DECK, VALUES)).toEqual<SlideOp[]>([
      { op: 'text', slide: 256, shape: 2, paragraphs: ['Pitch for Acme & Co'] },
      { op: 'text', slide: 256, shape: 3, paragraphs: ['Dummy Esports · November 23, 2026', 'Second line', '{{Budget}} stays'] }
    ])
  })

  it("fills a table's cell run by run, by its row and column, so a link later in the cell keeps its run", () => {
    const cellRuns = [[[{ runs: [{ text: 'Item' }] }], [{ runs: [{ text: '{{client}}' }] }, { runs: [{ text: 'Read the report' }] }]]]
    const deck: DeckRead = { slides: [{ id: 300, shapes: [{ id: 7, text: '', cells: [['Item', '{{client}}\nRead the report']], cellRuns }] }] }
    expect(deckOps(deck, VALUES)).toEqual<SlideOp[]>([
      {
        op: 'runs',
        slide: 300,
        shape: 7,
        row: 0,
        col: 1,
        paragraphs: [
          { from: 0, runs: [{ text: 'Acme & Co', from: [0, 0] }] },
          { from: 1, runs: [{ text: 'Read the report', from: [1, 0] }] }
        ]
      }
    ])
  })

  it('leaves an edit the slides pillar would refuse, and sends the rest of the batch', () => {
    const long = 'x'.repeat(19_990)
    const deck: DeckRead = {
      slides: [
        {
          id: 1,
          shapes: [
            { id: 1, text: `${long}{{Client}}`, paragraphs: [{ runs: [{ text: `${long}{{Client}}` }] }] },
            { id: 2, text: 'Pitch for {{Client}}', paragraphs: [{ runs: [{ text: 'Pitch for {{Client}}' }] }] }
          ]
        }
      ]
    }
    expect(deckOps(deck, VALUES).map((op) => op.op === 'runs' && op.shape)).toEqual([2])
  })

  it('asks nothing of a deck whose fields have no value', () => {
    expect(deckOps(DECK, fieldValues({ Other: 'x' }))).toEqual([])
  })

  it('keeps a value in its paragraph', () => {
    expect(deckOps({ slides: [{ id: 1, shapes: [{ id: 1, text: 'A {{X}} B\nnext' }] }] }, fieldValues({ X: 'one\ntwo\r\n three' }))).toEqual([{ op: 'text', slide: 1, shape: 1, paragraphs: ['A one two three B', 'next'] }])
  })

  it('names every run of a shape read with its runs by where it was read, so each keeps its look and link; only a field\'s runs change', () => {
    // A field over two runs in the first paragraph, a link alone in the second, a line break, a field beside a link.
    const shape = {
      id: 9,
      text: 'Pitch for {{Client}}\nRead the report\nBy {{Name}}\n{{Job}}',
      paragraphs: [{ runs: [{ text: 'Pitch for {{Cli' }, { text: 'ent}}' }] }, { runs: [{ text: 'Read the report' }] }, { runs: [{ text: 'By {{Name}}' }, { text: '\n' }, { text: '{{Job}}' }, { text: ' (link)' }] }]
    }
    expect(deckOps({ slides: [{ id: 1, shapes: [shape] }] }, VALUES)).toEqual<SlideOp[]>([
      {
        op: 'runs',
        slide: 1,
        shape: 9,
        paragraphs: [
          { from: 0, runs: [{ text: 'Pitch for Acme & Co', from: [0, 0] }, { text: '', from: [0, 1] }] },
          { from: 1, runs: [{ text: 'Read the report', from: [1, 0] }] },
          { from: 2, runs: [{ text: 'By Sam Dummy', from: [2, 0] }, { text: '\n', from: [2, 1] }, { text: 'Dummy Esports', from: [2, 2] }, { text: ' (link)', from: [2, 3] }] }
        ]
      }
    ])
  })

  it('fills no field across a line break in a shape, and leaves a shape read at the run cap', () => {
    const across = { id: 1, text: '{{Cli\nent}}', paragraphs: [{ runs: [{ text: '{{Cli' }, { text: '\n' }, { text: 'ent}}' }] }] }
    const capped = { id: 2, text: '{{Client}}', paragraphs: [{ runs: [{ text: '{{Client}}' }, ...Array.from({ length: 399 }, () => ({ text: 'x' }))] }] }
    expect(deckOps({ slides: [{ id: 1, shapes: [across, capped] }] }, VALUES)).toEqual([])
  })

  it('leaves a shape whose text was read at the cap, since its end may be cut', () => {
    expect(deckOps({ slides: [{ id: 1, shapes: [{ id: 1, text: `{{X}}${'a'.repeat(20_000)}` }] }] }, fieldValues({ X: 'x' }))).toEqual([])
  })
})

describe("a deck's table cells, read in its own XML", () => {
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const cell = (body: string) => `<a:tc><a:txBody><a:bodyPr/>${body}</a:txBody></a:tc>`
  const deck = makeZip({
    'ppt/presentation.xml': `<p:presentation ${P}><p:sldIdLst><p:sldId id="300" r:id="rId9"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId9" Type="slide" Target="slides/slide4.xml"/></Relationships>',
    'ppt/slides/slide4.xml': `<p:sld ${P}><p:cSld><p:spTree><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Table"/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl><a:tr h="1">${cell('<a:p><a:r><a:t>Item</a:t></a:r></a:p>')}${cell('<a:p><a:pPr/><a:r><a:rPr lang="en-US"/><a:t>{{Cli</a:t></a:r><a:r><a:t>ent}}</a:t></a:r></a:p><a:p><a:r><a:rPr><a:hlinkClick r:id="rId2"/></a:rPr><a:t>Read &amp; see</a:t></a:r><a:br/><a:fld id="{1}" type="slidenum"><a:t>4</a:t></a:fld></a:p><a:p/>')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`
  })

  it('are each paragraph\'s runs, links and fields among them, keyed by the slide and shape ids the read gives', () => {
    expect(deckCellRuns(deck).get('300/7')).toEqual([
      [
        [{ runs: [{ text: 'Item' }] }],
        [{ runs: [{ text: '{{Cli' }, { text: 'ent}}' }] }, { runs: [{ text: 'Read & see' }, { text: '\n' }, { text: '4' }] }, { runs: [] }]
      ]
    ])
  })

  it('reads a text tag in every form XML allows, so no run reads empty beside a field', () => {
    const spaced = makeZip({
      'ppt/presentation.xml': `<p:presentation ${P}><p:sldIdLst><p:sldId r:id='rId9' id='300'/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Target="slides/slide4.xml" Id = "rId9" Type="slide"/></Relationships>',
      'ppt/slides/slide4.xml': `<p:sld ${P}><p:graphicFrame><p:cNvPr name="Table" id = "7"/><a:tbl><a:tr>${cell('<a:p><a:r><a:t>{{Client}}</a:t></a:r><a:r><a:t >Keep this</a:t ></a:r><a:r><a:t xml:space="preserve"> and this</a:t></a:r><a:r><a:t/></a:r></a:p>')}</a:tr></a:tbl></p:graphicFrame></p:sld>`
    })
    const runs = deckCellRuns(spaced).get('300/7')
    expect(runs).toEqual([[[{ runs: [{ text: '{{Client}}' }, { text: 'Keep this' }, { text: ' and this' }, { text: '' }] }]]])
    const deck: DeckRead = { slides: [{ id: 300, shapes: [{ id: 7, text: '', cells: [['{{Client}}Keep this and this']], cellRuns: runs! }] }] }
    expect(deckOps(deck, VALUES)).toEqual<SlideOp[]>([
      { op: 'runs', slide: 300, shape: 7, row: 0, col: 0, paragraphs: [{ from: 0, runs: [{ text: 'Acme & Co', from: [0, 0] }, { text: 'Keep this', from: [0, 1] }, { text: ' and this', from: [0, 2] }, { text: '', from: [0, 3] }] }] }
    ])
  })

  it('leaves a cell whose runs do not account for the text the read gave', () => {
    const deck: DeckRead = { slides: [{ id: 300, shapes: [{ id: 7, text: '', cells: [['{{Client}}Keep this']], cellRuns: [[[{ runs: [{ text: '{{Client}}' }, { text: '' }] }]]] }] }] }
    expect(deckOps(deck, VALUES)).toEqual([])
    expect(accounts([{ runs: [{ text: 'a' }, { text: '\n' }, { text: 'b' }] }, { runs: [{ text: 'c' }] }], 'a\vb\nc')).toBe(true)
  })

  it('are none for bytes that are no deck', () => {
    expect(deckCellRuns(new Uint8Array([1, 2, 3])).size).toBe(0)
  })
})

describe('fillDeck with a converter that stands in', () => {
  let dir: string
  let jobs: ConvertJob[]
  beforeAll(() => void (dir = mkdtempSync(join(tmpdir(), 'tc-tpl-deck-'))))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const ctx = (deck: DeckRead, warnings: string[] = []) => ({
    convert: async (job: ConvertJob): Promise<ConvertResult> => {
      jobs.push(job)
      if (job.to === 'deckinfo') writeFileSync(job.output!, JSON.stringify(deck))
      else writeFileSync(job.output!, 'edited')
      return { output: job.output!, ranOn: 'env_test', warnings: job.to === 'pptxedit' ? warnings : [] }
    }
  })

  it('reads the deck, then sends its edits once, not strict, and leaves only the output behind', async () => {
    jobs = []
    const output = join(dir, 'a.pptx')
    const said = await fillDeck(ctx(DECK, ['note: edit 1: a link was taken out', 'edit 3: slide 300 has no shape 7']), '/in.pptx', output, VALUES)
    expect(said).toEqual({ filled: true, warnings: ['edit 3: slide 300 has no shape 7'] })
    expect(jobs.map((j) => `${j.from}→${j.to}`)).toEqual(['pptx→deckinfo', 'pptx→pptxedit'])
    expect(jobs[1]!.options).toEqual({ ops: deckOps(DECK, VALUES), strict: false })
    expect(readdirSync(dir)).toEqual(['a.pptx'])
  })

  it('writes nothing for a deck with no field the values reach', async () => {
    jobs = []
    const output = join(dir, 'b.pptx')
    expect(await fillDeck(ctx(DECK), '/in.pptx', output, fieldValues({ Other: 'x' }))).toEqual({ filled: false, warnings: [] })
    expect(jobs).toHaveLength(1)
    expect(existsSync(output)).toBe(false)
  })

  it('sends more than five hundred edits in steps, each on the last one\'s output', async () => {
    jobs = []
    const big: DeckRead = { slides: [{ id: 1, shapes: Array.from({ length: 501 }, (_, i) => ({ id: i + 1, text: '{{Client}}' })) }] }
    const output = join(dir, 'c.pptx')
    await fillDeck(ctx(big), '/in.pptx', output, VALUES)
    const edits = jobs.filter((j) => j.to === 'pptxedit')
    expect(edits.map((j) => (j.options!.ops as SlideOp[]).length)).toEqual([500, 1])
    expect(edits[1]!.input).toBe(edits[0]!.output)
    expect(edits[1]!.output).toBe(output)
    expect(readdirSync(dir).sort()).toEqual(['a.pptx', 'c.pptx'])
  })

  it('removes what it read when the read fails', async () => {
    const output = join(dir, 'd.pptx')
    const failing = { convert: async (): Promise<ConvertResult> => Promise.reject(new Error('python-pptx is not installed here')) }
    await expect(fillDeck(failing, '/in.pptx', output, VALUES)).rejects.toThrow('python-pptx')
    expect(readdirSync(dir).sort()).toEqual(['a.pptx', 'c.pptx'])
  })
})

const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA

describe.skipIf(!DATA)('fillDeck on python-pptx', () => {
  let dir: string
  let runner: JobRunner
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-tpl-deck-real-'))
    runner = new JobRunner({ host: 'env_test', dataDir: DATA!, converters: convertersOf([{ id: 'slides', ensure() {}, convert: [...SLIDES_CONVERTERS, ...LIBREOFFICE_CONVERTERS] }]), log: () => {} })
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('fills a field PowerPoint split over three runs and leaves the one with no value', async () => {
    const input = join(dir, 'split.pptx')
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'split.pptx'), input)
    const output = join(dir, 'filled.pptx')
    const said = await fillDeck({ convert: (job) => runner.convert(job) }, input, output, VALUES)
    expect(said).toEqual({ filled: true, warnings: [] })
    const bytes = new Uint8Array(readFileSync(output))
    expect(scanOffice('pptx', bytes)).toEqual(['Budget'])
    const read = join(dir, 'filled.json')
    await runner.convert({ from: 'pptx', to: 'deckinfo', input: output, output: read })
    const deck = JSON.parse(readFileSync(read, 'utf8')) as DeckRead
    const texts = deck.slides.flatMap((s) => s.shapes.map((x) => x.text)).filter(Boolean)
    expect(texts).toEqual(expect.arrayContaining(['Pitch for Acme & Co', 'Dummy Esports · November 23, 2026', 'Why Acme & Co', 'Presented by Sam Dummy\nNo field here\nLeft alone: {{Budget}}']))
  })

  it('keeps every link of a shape it fills, the one beside a field and the one in a paragraph with none', async () => {
    // fixtures/link.pptx, made once with python-pptx: "Pitch for {{Client}}", a linked "Read the report", then "{{Client}} site: " and a linked "link".
    const input = join(dir, 'link.pptx')
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'link.pptx'), input)
    const output = join(dir, 'link-filled.pptx')
    expect(await fillDeck({ convert: (job) => runner.convert(job) }, input, output, VALUES)).toEqual({ filled: true, warnings: [] })
    const slide = partText(readZip(new Uint8Array(readFileSync(output))).find((p) => p.name === 'ppt/slides/slide1.xml')!)
    expect(slide.match(/<a:hlinkClick\b/g)).toHaveLength(2)
    const texts = [...slide.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1])
    expect(texts).toEqual(['Pitch for Acme &amp; Co', 'Read the report', 'Acme &amp; Co site: ', 'link'])
  })

  it("keeps a table cell's link when it fills the field beside it", async () => {
    // fixtures/cell-link.pptx, made once with python-pptx: a 2×2 table; one cell "{{Client}}" then a linked "Read the report", one "{{Name}}".
    const input = join(dir, 'cell-link.pptx')
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cell-link.pptx'), input)
    const output = join(dir, 'cell-link-filled.pptx')
    expect(await fillDeck({ convert: (job) => runner.convert(job) }, input, output, VALUES)).toEqual({ filled: true, warnings: [] })
    const slide = partText(readZip(new Uint8Array(readFileSync(output))).find((p) => p.name === 'ppt/slides/slide1.xml')!)
    expect(slide.match(/<a:hlinkClick\b/g)).toHaveLength(1)
    expect([...slide.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1])).toEqual(['Client', 'Acme &amp; Co', 'Read the report', 'Lead', 'Sam Dummy'])
  })
})

