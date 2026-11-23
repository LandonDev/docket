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
import { deckOps, fillDeck, type DeckRead } from './deckFill'
import { scanOffice } from './ooxml'

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
  it('asks one text op for each shape that holds a field with a value, every paragraph of the shape in it', () => {
    expect(deckOps(DECK, VALUES)).toEqual<SlideOp[]>([
      { op: 'text', slide: 256, shape: 2, paragraphs: ['Pitch for Acme & Co'] },
      { op: 'text', slide: 256, shape: 3, paragraphs: ['Dummy Esports · November 23, 2026', 'Second line', '{{Budget}} stays'] },
      { op: 'cell', slide: 300, shape: 7, row: 0, col: 1, text: 'Acme & Co' },
      { op: 'cell', slide: 300, shape: 7, row: 1, col: 1, text: 'By Sam Dummy' }
    ])
  })

  it('asks nothing of a deck whose fields have no value', () => {
    expect(deckOps(DECK, fieldValues({ Other: 'x' }))).toEqual([])
  })

  it('keeps a value in its paragraph', () => {
    expect(deckOps({ slides: [{ id: 1, shapes: [{ id: 1, text: 'A {{X}} B\nnext' }] }] }, fieldValues({ X: 'one\ntwo\r\n three' }))).toEqual([{ op: 'text', slide: 1, shape: 1, paragraphs: ['A one two three B', 'next'] }])
  })

  it('leaves a shape whose text was read at the cap, since its end may be cut', () => {
    expect(deckOps({ slides: [{ id: 1, shapes: [{ id: 1, text: `{{X}}${'a'.repeat(20_000)}` }] }] }, fieldValues({ X: 'x' }))).toEqual([])
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
})
