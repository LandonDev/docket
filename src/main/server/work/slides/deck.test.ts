import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SlideOp } from '@shared/contract-work-slides'
import { LIBREOFFICE_CONVERTERS } from '../formats'
import { convertersOf, JobRunner } from '../formats/jobs'
import { DECK_PY } from './deckScript'
import { allocateIds, DECK_ITSELF, HOST_ID_GAP, joinStep, SLIDES_CONVERTERS, slideOfOp, splitStep, type DeckInfo } from './deck'
import { TWELVE } from './fixtures/twelve'
import { writeNewDeck } from './newDeck'

/**
 * The deck tool (deck.ts, deckScript.ts): the pure helpers always; the
 * Python run behind TEMP_CODE_WORK_TOOLS_DATA, a userData whose toolchain
 * has python-pptx (`TEMP_CODE_WORK_TOOLS_DATA=/srv/agents/temp-code-data`
 * on the box).
 */

const info = (ids: number[]): DeckInfo => ({ width: 1, height: 1, layouts: [], sections: [], slides: ids.map((id) => ({ id, hidden: false, layout: '', title: '', notes: '', hash: '', shapes: [] })) })

describe('allocateIds', () => {
  it('gives each add without an id its own, well above every id in the deck and above every id already given', () => {
    const ops: SlideOp[] = [
      { op: 'add', after: 0, layout: 'A' },
      { op: 'add', after: 0, layout: 'A', id: 900 },
      { op: 'text', slide: 300, shape: 1, paragraphs: ['x'] },
      { op: 'add', after: 0, layout: 'A' }
    ]
    const out = allocateIds(ops, info([256, 300]))
    // Each is the gap above everything before it: the given 900 counts too.
    expect(out.map((o) => (o.op === 'add' ? o.id : null))).toEqual([900 + HOST_ID_GAP + 1, 900, null, 900 + 2 * (HOST_ID_GAP + 1)])
    expect(out[2]).toBe(ops[2])
    // An id given before, above the gap, is counted.
    expect(allocateIds([{ op: 'add', after: 0, layout: 'A', id: 50_000 }, { op: 'add', after: 0, layout: 'A' }], info([256]))[1]).toMatchObject({ id: 50_000 + HOST_ID_GAP + 1 })
  })

  it("never takes the id PowerPoint gives the owner's next slide", () => {
    // PowerPoint gives a new slide the highest id plus one.
    const [add] = allocateIds([{ op: 'add', after: 0, layout: 'A' }], info([256, 257]))
    expect((add as { id: number }).id).toBe(257 + HOST_ID_GAP + 1)
    expect((add as { id: number }).id).not.toBe(258)
  })

  it("measures the gap against waiting adds too: once one is accepted, his next PowerPoint slide takes no waiting add's id", () => {
    // One call gives two adds; the owner accepts the first, so the file's highest id is now that add's.
    const [a, b] = allocateIds([{ op: 'add', after: 0, layout: 'A' }, { op: 'add', after: 0, layout: 'A' }], info([256, 257])) as Array<{ id: number }>
    const powerPointNext = a.id + 1
    expect(b.id).not.toBe(powerPointNext)
    expect(b.id - a.id).toBe(HOST_ID_GAP + 1)
    // A later call, with that add waiting and a file at 300, starts above the waiting id.
    const later = allocateIds([{ op: 'add', after: 0, layout: 'A', id: b.id }, { op: 'add', after: 0, layout: 'A' }], info([256, 300]))[1] as { id: number }
    expect(later.id).toBe(b.id + HOST_ID_GAP + 1)
  })

  it('starts above 255 in a deck with low ids, and stays under 2^31 near the ceiling', () => {
    expect(allocateIds([{ op: 'add', after: 0, layout: 'A' }], info([]))[0]).toMatchObject({ id: 255 + HOST_ID_GAP + 1 })
    expect(allocateIds([{ op: 'add', after: 0, layout: 'A' }], info([2_147_483_000]))[0]).toMatchObject({ id: 2_147_483_001 })
  })
})

describe('slideOfOp', () => {
  it("is the op's slide, or an add's own id", () => {
    expect(slideOfOp({ op: 'notes', slide: 270, text: '' })).toBe(270)
    expect(slideOfOp({ op: 'move', slide: 271, after: 0 })).toBe(271)
    expect(slideOfOp({ op: 'add', after: 270, layout: 'A', id: 400 })).toBe(400)
    expect(slideOfOp({ op: 'add', after: 270, layout: 'A' })).toBe(0)
  })

  it('is the copy for a duplicate, the slide a new section starts at, and no slide for an edit of the deck itself', () => {
    expect(slideOfOp({ op: 'duplicate', slide: 270, id: 500 })).toBe(500)
    expect(slideOfOp({ op: 'duplicate', slide: 270 })).toBe(0)
    expect(slideOfOp({ op: 'section', act: 'add', at: 272, name: 'S' })).toBe(272)
    expect(slideOfOp({ op: 'section', act: 'rename', section: 1, name: 'S' })).toBe(DECK_ITSELF)
    expect(slideOfOp({ op: 'theme', major: 'Georgia' })).toBe(DECK_ITSELF)
    expect(slideOfOp({ op: 'geometry', slide: 270, shape: 3, rot: 10 })).toBe(270)
    // A copy is given its id as a new slide is.
    const [copy] = allocateIds([{ op: 'duplicate', slide: 256 }], info([256, 257]))
    expect((copy as { id: number }).id).toBe(257 + HOST_ID_GAP + 1)
  })
})

const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA

/** Every entry name of a zip, as its central directory lists them, repeats included (JSZip keeps one of each). */
export function zipNames(bytes: Buffer): string[] {
  let end = bytes.length - 22
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--
  const count = bytes.readUInt16LE(end + 10)
  let at = bytes.readUInt32LE(end + 16)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    const n = bytes.readUInt16LE(at + 28)
    names.push(bytes.subarray(at + 46, at + 46 + n).toString('utf8'))
    at += 46 + n + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
  }
  return names
}
const FIXTURE = join(__dirname, 'fixtures', '04-groups.pptx')


describe.skipIf(!DATA)('the deck tool on python-pptx', () => {
  let dir: string
  let runner: JobRunner
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-slides-deck-'))
    runner = new JobRunner({ host: 'env_test', dataDir: DATA!, converters: convertersOf([{ id: 'slides', ensure() {}, convert: [...SLIDES_CONVERTERS, ...LIBREOFFICE_CONVERTERS] }]), log: () => {} })
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  let n = 0
  const file = (bytes: Uint8Array | Buffer): string => {
    const p = join(dir, `in-${++n}.pptx`)
    writeFileSync(p, bytes)
    return p
  }
  const inspect = async (input: string): Promise<DeckInfo> => {
    const done = await runner.convert({ from: 'pptx', to: 'deckinfo', input, output: join(dir, `info-${++n}.json`) })
    return JSON.parse(readFileSync(done.output, 'utf8')) as DeckInfo
  }
  const apply = async (input: string, ops: SlideOp[], strict = false): Promise<{ output: string; warnings: string[] }> => {
    const done = await runner.convert({ from: 'pptx', to: 'pptxedit', input, output: join(dir, `out-${++n}.pptx`), options: { ops, strict } })
    return { output: done.output, warnings: done.warnings }
  }
  const entries = async (path: string): Promise<Map<string, string>> => {
    const zip = await JSZip.loadAsync(readFileSync(path))
    const out = new Map<string, string>()
    for (const [name, f] of Object.entries(zip.files)) if (!f.dir) out.set(name, createHash('sha256').update(await f.async('uint8array')).digest('hex'))
    return out
  }
  const shape = (d: DeckInfo, slide: number, id: number) => d.slides.find((s) => s.id === slide)!.shapes.find((x) => x.id === id)!

  describe('the outline of the feature deck (fixtures/12-feature-probes.pptx)', () => {
    let d: DeckInfo
    beforeAll(async () => {
      d = await inspect(join(__dirname, 'fixtures', '12-feature-probes.pptx'))
    })
    const on = (slide: number, id: number) => d.slides[slide - 1].shapes.find((x) => x.id === id)!

    it("places each shape where LibreOffice draws it, within 2 px at 1920: plain, scaled in a group, rotated, and rotated and flipped in a group", () => {
      const measured = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'feature-pixels.json'), 'utf8')) as { shapes: Array<{ slide: number; shape: number; name: string; width: number; height: number; box: number[] }> }
      expect(measured.shapes).toHaveLength(8)
      const off = measured.shapes.map((m) => {
        const b = on(m.slide, m.shape).bbox!
        const ours = [b[0] * m.width, b[1] * m.height, b[2] * m.width, b[3] * m.height]
        return { name: m.name, px: Math.max(...ours.map((v, i) => Math.abs(v - m.box[i]))) }
      })
      // Before the whole transform was carried, the two turned shapes were 85 and 89 px out.
      expect(off.filter((o) => o.px > 2)).toEqual([])
      expect(off.find((o) => o.name === 'rotated box')!.px).toBeLessThan(2)
    })

    it('gives a turned shape its four corners, its angle and whether it is mirrored, and a group child its group', () => {
      const turned = on(3, 10)
      expect(turned).toMatchObject({ rot: 25, kind: 'other', shape: 'rect' })
      expect(turned.flip).toBeFalsy()
      // The corners are its own box's, turned: the top edge runs 25 degrees clockwise and keeps the box's width over height.
      const [tl, tr, , bl] = turned.quad!
      const w = Math.hypot((tr[0] - tl[0]) * d.width, (tr[1] - tl[1]) * d.height)
      const h = Math.hypot((bl[0] - tl[0]) * d.width, (bl[1] - tl[1]) * d.height)
      expect(w / h).toBeCloseTo(3.2 / 1.1, 2)
      expect(on(3, 8)).toMatchObject({ group: 7, flip: true, rot: -149 })
      expect(on(3, 5)).toMatchObject({ group: 4 })
      expect(on(3, 5).rot).toBe(0)
      expect(on(3, 3).group).toBeUndefined()
    })

    it('names what each shape is: text, a drawn shape, a picture, a table, a chart, a video and a sound', () => {
      expect(d.slides[3].shapes.map((x) => x.kind)).toEqual(['text', 'picture', 'table', 'other'])
      expect(d.slides[4].shapes.map((x) => x.kind)).toEqual(['text', 'chart', 'chart', 'chart', 'other'])
      expect(d.slides[5].shapes.map((x) => [x.kind, x.media])).toEqual([['text', undefined], ['media', 'video'], ['media', 'audio']])
      expect(d.slides[0].shapes.map((x) => [x.kind, x.placeholder])).toEqual([['text', 'title'], ['text', 'body'], ['other', undefined]])
    })

    it('reads a text shape as runs in the look they are drawn in: the theme’s fonts and the master’s sizes where the run says nothing', () => {
      // A title is centred by its master's title style.
      expect(on(1, 2).paragraphs).toEqual([{ level: 0, align: 'center', list: 'none', runs: [{ text: 'Theme and layout inheritance', size: 44, font: 'Cambria', color: '000000' }] }])
      expect(on(1, 3).paragraphs![0]).toMatchObject({ list: 'bullet', runs: [{ size: 32, font: 'Calibri' }] })
      expect(on(1, 3).frame).toMatchObject({ anchor: 'top', fit: 'none', wrap: true })
      // The run's own size, and the frame that shrinks its text.
      expect(on(2, 3).paragraphs![0].runs[0]).toMatchObject({ size: 30 })
      expect(on(2, 3).frame).toMatchObject({ fit: 'shrink', insets: [91440, 45720, 91440, 45720] })
    })

    it('reads each slide’s layout and transition, and the deck’s size, layouts and theme', () => {
      expect(d.slides.map((x) => x.transition?.kind ?? null)).toEqual([null, null, null, null, null, null, 'fade', 'push', null, null])
      expect(d.slides[7].transition).toEqual({ kind: 'push', dir: 'l', ms: 1000 })
      expect(d.slides[8].hidden).toBe(true)
      expect([d.width, d.height]).toEqual([12192000, 6858000])
      expect(d.theme).toMatchObject({ major: 'Cambria', minor: 'Calibri', colors: { dk1: '000000', lt1: 'FFFFFF', accent2: 'D34B36' } })
      expect(Object.keys(d.theme!.colors)).toHaveLength(12)
      expect(d.layoutInfo!.find((l) => l.name === 'Title and Content')).toEqual({ name: 'Title and Content', master: 0, holds: [{ kind: 'title', idx: 0 }, { kind: 'body', idx: 1 }, { kind: 'date', idx: 10 }, { kind: 'footer', idx: 11 }, { kind: 'number', idx: 12 }] })
    })
  })

  it('gives each kind of shape the box its pixels were measured against (fixtures/kinds.pptx, the box test)', async () => {
    const d = await inspect(join(__dirname, 'fixtures', 'kinds.pptx'))
    const measured = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'kinds-pixels.json'), 'utf8')) as { width: number; height: number; shapes: Array<{ shape: number; name: string; kind: string; rot: number; box: [number, number] }> }
    for (const m of measured.shapes) {
      const sh = d.slides[0].shapes.find((x) => x.id === m.shape)!
      const [tl, tr, , bl] = sh.quad!
      const w = Math.hypot((tr[0] - tl[0]) * measured.width, (tr[1] - tl[1]) * measured.height)
      const h = Math.hypot((bl[0] - tl[0]) * measured.width, (bl[1] - tl[1]) * measured.height)
      expect([m.name, sh.kind, Math.round(w * 10) / 10, Math.round(h * 10) / 10, sh.rot ?? 0]).toEqual([m.name, m.kind, m.box[0], m.box[1], m.rot])
    }
    expect(d.slides[0].shapes.find((x) => x.kind === 'connector')!.shape).toBeUndefined()
    expect(d.slides[0].shapes.filter((x) => x.kind === 'other').map((x) => x.shape)).toEqual(['ellipse', 'rightArrow', 'roundRect', 'ellipse', 'triangle'])
  })

  it('gives each slide one hash of what its picture is drawn from: an edit moves its own slide\'s alone, notes move none, a theme or the deck\'s own settings move them all', async () => {
    const input = file(readFileSync(FIXTURE))
    const draws = async (path: string): Promise<Array<string | undefined>> => (await inspect(path)).slides.map((s) => s.draws)
    const before = await draws(input)
    expect(before.every((d) => /^[0-9a-f]{64}$/.test(d ?? ''))).toBe(true)
    const worded = await apply(input, [{ op: 'text', slide: 268, shape: 133, paragraphs: ['Changed'] }], true)
    expect((await draws(worded.output)).map((d, i) => d === before[i])).toEqual([false, true])
    const noted = await apply(input, [{ op: 'notes', slide: 268, text: 'Say this' }], true)
    expect(await draws(noted.output)).toEqual(before)
    // A part every slide reaches (the theme), and the presentation's own settings: every picture is drawn again.
    const rewrite = async (name: string, change: (xml: string) => string): Promise<string> => {
      const zip = await JSZip.loadAsync(readFileSync(input))
      const xml = await zip.file(name)!.async('string')
      const next = change(xml)
      expect(next).not.toBe(xml)
      zip.file(name, next)
      return file(await zip.generateAsync({ type: 'nodebuffer' }))
    }
    const theme = Object.keys((await JSZip.loadAsync(readFileSync(input))).files).find((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n))!
    const themed = await rewrite(theme, (xml) => xml.replace(/<a:srgbClr val="[0-9A-Fa-f]{6}"/, '<a:srgbClr val="123456"'))
    expect((await draws(themed)).some((d, i) => d !== before[i])).toBe(true)
    const numbered = await rewrite('ppt/presentation.xml', (xml) => xml.replace('<p:presentation ', '<p:presentation firstSlideNum="5" '))
    expect((await draws(numbered)).map((d, i) => d === before[i])).toEqual([false, false])
    // The list of slides is not a setting: a slide taken out leaves the other's picture as it was.
    const fewer = await apply(input, [{ op: 'remove', slide: 267 }], true)
    expect(await draws(fewer.output)).toEqual([before[0]])
  })

  it('inspects a 12-slide pptxgenjs deck: its slides, layouts, table and chart', async () => {
    const d = await inspect(file(await writeNewDeck({ title: 'Showcase', slides: TWELVE })))
    expect(d.slides).toHaveLength(12)
    expect(d.layouts).toEqual(expect.arrayContaining(['Title', 'Title and Content', 'Table', 'Chart', 'Section Header']))
    expect(d.slides.map((s) => s.title)).toEqual(TWELVE.map((s) => s.title))
    expect(d.slides[2]).toMatchObject({ layout: 'Title and Content', notes: 'Say 1' })
    const table = d.slides[9].shapes.find((s) => s.kind === 'table')
    expect(table?.cells).toEqual([['Item', 'Cost'], ['Stage', '$4,000'], ['Sound', '$2,500']])
    const chart = d.slides[10].shapes.find((s) => s.kind === 'chart')
    expect(chart?.chart).toEqual({ categories: ['Mon', 'Tue', 'Wed'], series: [{ name: 'Stream', values: [1200, 3400, 6200] }] })
    for (const s of d.slides) for (const x of s.shapes) if (x.bbox) expect(x.bbox.every((v) => v >= 0 && v <= 1)).toBe(true)
  })

  it('on a PowerPoint-saved deck, one text edit leaves every other part byte-identical and keeps the run\'s look', async () => {
    const input = file(readFileSync(FIXTURE))
    const before = await inspect(input)
    expect(before.slides.map((s) => s.id)).toEqual([268, 267])
    const { output, warnings } = await apply(input, [{ op: 'text', slide: 268, shape: 133, paragraphs: ['IT, rebuilt', 'Second line', 'A third'] }], true)
    expect(warnings).toEqual([])
    const [a, b] = [await entries(input), await entries(output)]
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort())
    const changed = [...a.keys()].filter((k) => a.get(k) !== b.get(k))
    // The done-when line: untouched slides are byte-identical in the saved file.
    expect(changed).toEqual(['ppt/slides/slide1.xml'])
    for (const k of a.keys()) if (/slideLayout|slideMaster|theme|media|slide2\.xml/.test(k)) expect(b.get(k)).toBe(a.get(k))
    // Its order is the input's, [Content_Types].xml first.
    expect(Object.keys((await JSZip.loadAsync(readFileSync(output))).files)).toEqual(Object.keys((await JSZip.loadAsync(readFileSync(input))).files))
    const after = await inspect(output)
    expect(after.slides[1].hash).toBe(before.slides[1].hash)
    expect(shape(after, 268, 133).text).toBe('IT, rebuilt\nSecond line\nA third')
    // The run's look: the first run's rPr is on every new run, the third paragraph copied the last one's.
    const xml = async (p: string) => (await JSZip.loadAsync(readFileSync(p))).file('ppt/slides/slide1.xml')!.async('string')
    const sp = (x: string) => x.slice(x.indexOf('<p:cNvPr id="133"'), x.indexOf('</p:sp>', x.indexOf('<p:cNvPr id="133"')))
    const rprs = (x: string) => [...sp(x).matchAll(/<a:rPr[^>]*\/?>/g)].map((m) => m[0])
    const old = rprs(await xml(input))
    const now = rprs(await xml(output))
    expect(now.length).toBeGreaterThanOrEqual(3)
    expect(now[0]).toBe(old[0])
  })

  describe('his own edits: runs, a look, and the packs that take them back', () => {
    const slideXml = async (p: string, n = 1): Promise<string> => (await JSZip.loadAsync(readFileSync(p))).file(`ppt/slides/slide${n}.xml`)!.async('string')
    const spOf = (x: string, id: number): string => x.slice(x.indexOf(`<p:cNvPr id="${id}"`), x.indexOf('</p:sp>', x.indexOf(`<p:cNvPr id="${id}"`)))
    const changedParts = async (a: string, b: string): Promise<string[]> => {
      const [x, y] = [await entries(a), await entries(b)]
      expect([...y.keys()].sort()).toEqual([...x.keys()].sort())
      return [...x.keys()].filter((k) => x.get(k) !== y.get(k))
    }
    const runsOf = (d: DeckInfo, slide: number, id: number) => shape(d, slide, id).paragraphs!.map((p) => p.runs.map((r) => [r.text, r.size, !!r.bold, !!r.italic, !!r.underline, r.font, r.color]))

    it('runs: each run keeps the look of the run it came from, with what he set on top; one part changes', async () => {
      const input = file(readFileSync(FIXTURE))
      const before = await inspect(input)
      // Shape 133: "IT Transformation " / "IT2B", " - ", "IT to Business" (bold, plain, bold; Calibri 28).
      expect(runsOf(before, 268, 133)[1].map((r) => [r[0], r[2]])).toEqual([['IT2B', true], [' - ', false], ['IT to Business', true]])
      const { output, warnings } = await apply(
        input,
        [
          {
            op: 'runs',
            slide: 268,
            shape: 133,
            paragraphs: [
              { from: 0, runs: [{ text: 'IT, rebuilt ', from: [0, 0] }] },
              // The plain run's words retyped and made italic at 20 pt; a new run from nowhere; the last run as it was.
              { from: 1, runs: [{ text: 'IT2B', from: [1, 0] }, { text: ' to ', from: [1, 1], italic: true, size: 20 }, { text: 'new ', color: 'C00000', font: 'Arial' }, { text: 'IT to Business', from: [1, 2] }] },
              // A third paragraph split from the second, in a list.
              { from: 1, list: 'bullet', align: 'left', level: 1, runs: [{ text: 'Under it', from: [1, 1], bold: true, underline: true }] }
            ]
          }
        ],
        true
      )
      expect(warnings).toEqual([])
      expect(await changedParts(input, output)).toEqual(['ppt/slides/slide1.xml'])
      const after = await inspect(output)
      expect(after.slides[1].hash).toBe(before.slides[1].hash)
      const runs = runsOf(after, 268, 133)
      expect(runs[0]).toEqual([['IT, rebuilt ', 28, true, false, false, 'Calibri', '000000']])
      expect(runs[1]).toEqual([
        ['IT2B', 28, true, false, false, 'Calibri', '000000'],
        [' to ', 20, false, true, false, 'Calibri', '000000'],
        // From nowhere: the paragraph's first look (bold Calibri 28), with his colour and font on top.
        ['new ', 28, true, false, false, 'Arial', 'C00000'],
        ['IT to Business', 28, true, false, false, 'Calibri', '000000']
      ])
      expect(runs[2]).toEqual([['Under it', 28, true, false, true, 'Calibri', '000000']])
      expect(shape(after, 268, 133).paragraphs!.map((p) => [p.level, p.align, p.list])).toEqual([[0, 'center', 'none'], [0, 'center', 'none'], [1, 'left', 'bullet']])
      // The first run's own properties are the file's, untouched: only its words moved.
      const [was, now] = [spOf(await slideXml(input), 133), spOf(await slideXml(output), 133)]
      expect(now.match(/<a:rPr[^>]*>/)![0]).toBe(was.match(/<a:rPr[^>]*>/)![0])
      // A run's properties keep the order the schema wants: the fill before the typefaces.
      const made = now.slice(now.indexOf('new </a:t>') - 400, now.indexOf('new </a:t>'))
      expect(made.lastIndexOf('<a:solidFill>')).toBeLessThan(made.lastIndexOf('<a:latin typeface="Arial"'))
      expect(made.lastIndexOf('<a:latin typeface="Arial"')).toBeLessThan(made.lastIndexOf('<a:cs typeface="Arial"'))
    })

    it('runs: a line break in a run stays a break, an empty paragraph keeps a look, and a drawn shape with no words takes his', async () => {
      const input = file(readFileSync(FIXTURE))
      const { output } = await apply(input, [{ op: 'runs', slide: 268, shape: 138, paragraphs: [{ from: 0, runs: [{ text: 'One\nTwo', from: [0, 0] }] }, { from: 1, runs: [{ text: '', from: [1, 0], size: 40 }] }] }], true)
      const after = await inspect(output)
      expect(shape(after, 268, 138).paragraphs!.map((p) => p.runs.map((r) => r.text))).toEqual([['One', '\n', 'Two'], []])
      expect(spOf(await slideXml(output), 138)).toMatch(/<a:endParaRPr[^>]*sz="4000"/)
      // A drawn shape with no words takes his: it has a text body, as every shape PowerPoint draws does.
      const drawn = await apply(input, [{ op: 'runs', slide: 268, shape: 134, paragraphs: [{ runs: [{ text: 'x' }] }] }], true)
      expect(shape(await inspect(drawn.output), 268, 134)).toMatchObject({ kind: 'text', text: 'x' })
    })

    it('format: a look on a whole shape, on a range that cuts runs in two, and across paragraphs', async () => {
      const input = file(readFileSync(FIXTURE))
      const whole = await apply(input, [{ op: 'format', slide: 268, shape: 133, set: { italic: true, color: '0070C0', align: 'right' } }], true)
      expect(await changedParts(input, whole.output)).toEqual(['ppt/slides/slide1.xml'])
      const a = await inspect(whole.output)
      expect(runsOf(a, 268, 133).flat().every((r) => r[3] === true && r[6] === '0070C0')).toBe(true)
      expect(shape(a, 268, 133).paragraphs!.every((p) => p.align === 'right')).toBe(true)
      // The words and every other look are as they were.
      expect(runsOf(a, 268, 133)[1].map((r) => [r[0], r[1], r[2]])).toEqual([['IT2B', 28, true], [' - ', 28, false], ['IT to Business', 28, true]])

      // "IT Transformation " is 18 characters: characters 3 to 9 of it ("Transf"), cut out of one run.
      const cut = await apply(input, [{ op: 'format', slide: 268, shape: 133, range: { from: [0, 3], to: [0, 9] }, set: { underline: true, size: 12 } }], true)
      const b = await inspect(cut.output)
      expect(runsOf(b, 268, 133)[0].map((r) => [r[0], r[1], r[4]])).toEqual([['IT ', 28, false], ['Transf', 12, true], ['ormation ', 28, false]])
      expect(runsOf(b, 268, 133)[1].every((r) => r[4] === false)).toBe(true)

      // From the middle of the first paragraph to the middle of the second run of the second.
      const across = await apply(input, [{ op: 'format', slide: 268, shape: 133, range: { from: [0, 16], to: [1, 5] }, set: { bold: false } }], true)
      const c = await inspect(across.output)
      expect(runsOf(c, 268, 133).map((p) => p.map((r) => [r[0], r[2]]))).toEqual([
        [['IT Transformatio', true], ['n ', false]],
        [['IT2B', false], [' ', false], ['- ', false], ['IT to Business', true]]
      ])
      // A paragraph past the end is a sentence, and nothing is written under strict.
      await expect(apply(input, [{ op: 'format', slide: 268, shape: 133, range: { from: [7, 0], to: [7, 2] }, set: { bold: true } }], true)).rejects.toThrow('there is no paragraph 8')
    })

    it('format: a table takes a look in every cell, or in one', async () => {
      const input = file(await writeNewDeck({ title: 'T', slides: TWELVE }))
      const before = await inspect(input)
      const slide = before.slides[9]
      const table = slide.shapes.find((x) => x.kind === 'table')!
      const all = await apply(input, [{ op: 'format', slide: slide.id, shape: table.id, set: { bold: true } }], true)
      const one = await apply(input, [{ op: 'format', slide: slide.id, shape: table.id, row: 1, col: 1, set: { color: 'FF0000' } }], true)
      const xml = async (p: string): Promise<string> => slideXml(p, 10)
      expect((await xml(all.output)).match(/ b="1"/g)!.length).toBeGreaterThanOrEqual(6)
      // One cell: its run and the paragraph's end mark, so words typed after it match.
      expect((await xml(one.output)).match(/<a:srgbClr val="FF0000"\/>/g)).toHaveLength(2)
      // The words are as they were.
      expect((await inspect(one.output)).slides[9].shapes.find((x) => x.kind === 'table')!.cells).toEqual(table.cells)
      const bad = await apply(input, [{ op: 'runs', slide: slide.id, shape: table.id, paragraphs: [{ runs: [{ text: 'x' }] }] }])
      expect(bad.warnings.join(' ')).toContain('name a cell of the table')
      const cell = await apply(input, [{ op: 'runs', slide: slide.id, shape: table.id, row: 2, col: 0, paragraphs: [{ from: 0, runs: [{ text: 'Lights', from: [0, 0] }] }] }], true)
      expect((await inspect(cell.output)).slides[9].shapes.find((x) => x.kind === 'table')!.cells![2][0]).toBe('Lights')
    })

    it('an edit comes with the pack that takes it back, part for part, and taking it back comes with the pack that puts it in again', async () => {
      const input = file(readFileSync(FIXTURE))
      const split = (container: string): { deck: string; pack: string } => {
        const [deck, pack] = [join(dir, `deck-${++n}.pptx`), join(dir, `pack-${++n}.pack`)]
        splitStep(container, [deck, pack])
        return { deck, pack }
      }
      const edited = split((await runner.convert({ from: 'pptx', to: 'pptxstep', input, output: join(dir, `step-${++n}.bin`), options: { ops: [{ op: 'format', slide: 268, shape: 133, set: { bold: false } }, { op: 'add', after: 268, layout: (await inspect(input)).layouts[0] }] } })).output)
      const changed = await entries(edited.deck)
      const original = await entries(input)
      expect([...changed.keys()].length).toBeGreaterThan([...original.keys()].length)
      // Taken back: the same parts as the file, byte for byte, in the file's own order; the slide the edit added is gone.
      const joined = join(dir, `in-${++n}.bin`)
      joinStep([edited.deck, edited.pack], joined)
      const undone = split((await runner.convert({ from: 'pptxstep', to: 'pptxstep', input: joined, output: join(dir, `step-${++n}.bin`) })).output)
      expect(await entries(undone.deck)).toEqual(original)
      expect(zipNames(readFileSync(undone.deck))).toEqual(zipNames(readFileSync(input)))
      // Put in again: the edited deck's parts, byte for byte.
      joinStep([undone.deck, undone.pack], joined)
      const redone = split((await runner.convert({ from: 'pptxstep', to: 'pptxstep', input: joined, output: join(dir, `step-${++n}.bin`) })).output)
      expect(await entries(redone.deck)).toEqual(changed)
      expect((await inspect(redone.deck)).slides).toHaveLength(3)
      // The same run read the edited deck's outline: it is the third file, and says what a fresh read would.
      const info = join(dir, `info-${++n}.json`)
      const again = join(dir, `again-${++n}.pptx`)
      splitStep((await runner.convert({ from: 'pptx', to: 'pptxstep', input, output: join(dir, `step-${++n}.bin`), options: { ops: [{ op: 'notes', slide: 268, text: 'Said' }] } })).output, [again, join(dir, `p-${++n}.pack`), info])
      expect(JSON.parse(readFileSync(info, 'utf8'))).toEqual(await inspect(again))
      // The pack holds the parts the edit changed and no more: far smaller than the deck.
      expect(readFileSync(edited.pack).length).toBeLessThan(readFileSync(input).length / 4)
      // An edit of his that does not go in whole is refused, and so is a pack against a deck that lacks the parts it leaves alone (the host checks the file's hash first).
      await expect(runner.convert({ from: 'pptx', to: 'pptxstep', input, output: join(dir, `step-${++n}.bin`), options: { ops: [{ op: 'notes', slide: 999, text: 'x' }] } })).rejects.toThrow('there is no slide 999')
      joinStep([file(await writeNewDeck({ title: 'Another', slides: TWELVE.slice(0, 2) })), edited.pack], joined)
      await expect(runner.convert({ from: 'pptxstep', to: 'pptxstep', input: joined, output: join(dir, `step-${++n}.bin`) })).rejects.toThrow('the deck has changed since that edit')
    })
  })

  describe('his own edits: shapes, slides and the deck', () => {
    const FEATURE = join(__dirname, 'fixtures', '12-feature-probes.pptx')
    /** The parts an edit changed, added and took away, by name. */
    const partsDiff = async (a: string, b: string): Promise<{ changed: string[]; added: string[]; gone: string[] }> => {
      const [x, y] = [await entries(a), await entries(b)]
      return { changed: [...x.keys()].filter((k) => y.has(k) && x.get(k) !== y.get(k)).sort(), added: [...y.keys()].filter((k) => !x.has(k)).sort(), gone: [...x.keys()].filter((k) => !y.has(k)).sort() }
    }
    const slidePart = async (path: string, id: number): Promise<string> => {
      const zip = await JSZip.loadAsync(readFileSync(path))
      const pres = await zip.file('ppt/presentation.xml')!.async('string')
      const rid = new RegExp(`<p:sldId[^>]*id="${id}"[^>]*r:id="([^"]+)"`).exec(pres)![1]
      const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
      return `ppt/${new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)!.slice(1).find(Boolean)}`
    }
    const xmlOf = async (path: string, name: string): Promise<string> => (await JSZip.loadAsync(readFileSync(path))).file(name)!.async('string')
    const attach = (name: string, bytes: Buffer): string => {
      const p = join(dir, name)
      writeFileSync(p, bytes)
      return p
    }
    /** Edits that bring files, as the host sends them: the deck and its files as one input. */
    const applyWith = async (input: string, ops: SlideOp[], files: Array<[string, string]>, strict = true): Promise<{ output: string; warnings: string[] }> => {
      const joined = join(dir, `plus-${++n}.bin`)
      joinStep([input, ...files.map((f) => f[1])], joined)
      const done = await runner.convert({ from: 'pptxplus', to: 'pptxedit', input: joined, output: join(dir, `out-${++n}.pptx`), options: { ops, strict, files: files.map((f) => f[0]) } })
      return { output: done.output, warnings: done.warnings }
    }
    // A 2 by 1 red PNG.
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DAwMDAAAAHBQEBxk1nMAAAAABJRU5ErkJggg==', 'base64')

    it('geometry: a shape moved, resized and turned changes its slide alone, and reads back where it was put', async () => {
      const input = file(readFileSync(FEATURE))
      const part = await slidePart(input, 258)
      const { output } = await apply(input, [{ op: 'geometry', slide: 258, shape: 3, box: [1000000, 2000000, 1500000, 800000], rot: 30, flipH: true }], true)
      expect(await partsDiff(input, output)).toEqual({ changed: [part], added: [], gone: [] })
      const after = await inspect(output)
      expect(shape(after, 258, 3).own).toEqual({ box: [1000000, 2000000, 1500000, 800000], rot: 30, flipH: true, flipV: false })
      // A shape in a plain group is placed in the group's own numbers, and lands where the slide says.
      const before = await inspect(input)
      const was = shape(before, 258, 5).own!
      const moved = await apply(input, [{ op: 'geometry', slide: 258, shape: 5, box: [was.box[0] + 300000, was.box[1] - 200000, was.box[2], was.box[3]] }], true)
      const now = shape(await inspect(moved.output), 258, 5).own!
      expect(now.box.map((v, i) => Math.abs(v - [was.box[0] + 300000, was.box[1] - 200000, was.box[2], was.box[3]][i]) <= 2)).toEqual([true, true, true, true])
      // One in a turned group has no numbers of the slide's: said so, and nothing is written.
      expect(shape(before, 258, 8).own).toBeUndefined()
      await expect(apply(input, [{ op: 'geometry', slide: 258, shape: 8, box: [0, 0, 100000, 100000] }], true)).rejects.toThrow('in a group that is turned or flipped; move it in PowerPoint')
      await expect(apply(input, [{ op: 'geometry', slide: 259, shape: 4, rot: 10 }], true)).rejects.toThrow('cannot be turned or mirrored')
      // A turn of nothing leaves no turn in the file.
      const back = await apply(output, [{ op: 'geometry', slide: 258, shape: 3, rot: 0, flipH: false }], true)
      expect(shape(await inspect(back.output), 258, 3).own).toMatchObject({ rot: 0, flipH: false })
    })

    it('order, fill and line: one part each, and the outline says the colour, the weight and the dash', async () => {
      const input = file(readFileSync(FEATURE))
      const part = await slidePart(input, 258)
      const ids = (d: DeckInfo): number[] => d.slides.find((x) => x.id === 258)!.shapes.filter((x) => x.group === undefined).map((x) => x.id)
      const before = ids(await inspect(input))
      const front = await apply(input, [{ op: 'order', slide: 258, shape: before[0], to: 'front' }], true)
      expect(await partsDiff(input, front.output)).toEqual({ changed: [part], added: [], gone: [] })
      expect(ids(await inspect(front.output))).toEqual([...before.slice(1), before[0]])
      const back = await apply(input, [{ op: 'order', slide: 258, shape: before.at(-1)!, to: 'back' }], true)
      expect(ids(await inspect(back.output))).toEqual([before.at(-1)!, ...before.slice(0, -1)])
      // One step back passes the one shape (here a group) right under it, and no more.
      const all = (d: DeckInfo): number[] => [...new Set(d.slides.find((x) => x.id === 258)!.shapes.map((x) => x.group ?? x.id))]
      const stepped = await apply(input, [{ op: 'order', slide: 258, shape: before.at(-1)!, to: 'backward' }], true)
      const was = all(await inspect(input))
      expect(all(await inspect(stepped.output))).toEqual([...was.slice(0, -2), was.at(-1)!, was.at(-2)!])
      const painted = await apply(
        input,
        [
          { op: 'fill', slide: 258, shape: 3, color: 'FFAA00' },
          { op: 'line', slide: 258, shape: 3, color: { slot: 'accent2' }, width: 2.5, dash: 'dash' },
          { op: 'fill', slide: 258, shape: 10, color: null },
          { op: 'line', slide: 258, shape: 10, color: null }
        ],
        true
      )
      expect(await partsDiff(input, painted.output)).toEqual({ changed: [part], added: [], gone: [] })
      const after = await inspect(painted.output)
      expect(shape(after, 258, 3)).toMatchObject({ fill: 'FFAA00', line: { width: 2.5, dash: 'dash' } })
      expect(shape(after, 258, 3).line!.color).toMatch(/^[0-9A-F]{6}$/)
      expect(shape(after, 258, 10)).toMatchObject({ fill: 'none', line: { color: 'none' } })
      // The fill sits where the schema wants it: after the outline's geometry, before the line.
      const sp = await xmlOf(painted.output, part)
      expect(sp.indexOf('<a:srgbClr val="FFAA00"/>')).toBeLessThan(sp.indexOf('<a:schemeClr val="accent2"/>'))
      await expect(apply(input, [{ op: 'fill', slide: 259, shape: 4, color: 'FF0000' }], true)).rejects.toThrow('takes no fill')
    })

    it('insert: a text box and a shape change the slide alone; a picture adds its media and one relationship; a table none; a chart its part and its workbook; a video its media, a poster and its timing', async () => {
      const input = file(readFileSync(FEATURE))
      const part = await slidePart(input, 265)
      const rels = part.replace('slides/', 'slides/_rels/') + '.rels'
      const plain = await apply(
        input,
        [
          { op: 'insert', slide: 265, what: 'text', box: [500000, 1500000, 3000000, 600000], text: 'Typed here', id: 900 },
          { op: 'insert', slide: 265, what: 'shape', preset: 'ellipse', box: [4000000, 1500000, 1000000, 1000000] },
          { op: 'insert', slide: 265, what: 'table', rows: 2, cols: 3, box: [500000, 3000000, 4000000, 800000] },
          { op: 'format', slide: 265, shape: 900, set: { bold: true } }
        ],
        true
      )
      expect(await partsDiff(input, plain.output)).toEqual({ changed: [part], added: [], gone: [] })
      const made = (await inspect(plain.output)).slides.find((x) => x.id === 265)!.shapes
      expect(made.slice(-3).map((x) => [x.kind, x.shape, x.own?.box])).toEqual([
        ['text', 'rect', [500000, 1500000, 3000000, 600000]],
        ['other', 'ellipse', [4000000, 1500000, 1000000, 1000000]],
        ['table', undefined, [500000, 3000000, 4000000, 800000]]
      ])
      expect(made.find((x) => x.id === 900)).toMatchObject({ text: 'Typed here', paragraphs: [{ runs: [{ text: 'Typed here', bold: true }] }] })
      await expect(apply(input, [{ op: 'insert', slide: 265, what: 'text', box: [0, 0, 100, 100], id: 2 }], true)).rejects.toThrow('already has a shape 2')
      await expect(apply(input, [{ op: 'insert', slide: 265, what: 'shape', preset: 'noSuchShape', box: [0, 0, 100, 100] }], true)).rejects.toThrow('is not a shape PowerPoint has')

      // A picture: its media part, the slide's relationship to it, and nothing else. (The deck already holds a PNG.)
      const pictured = await applyWith(input, [{ op: 'insert', slide: 265, what: 'picture', file: 'f0.png', box: [500000, 1500000, 2000000, 1000000] }], [['f0.png', attach('red.png', PNG)]])
      const pic = await partsDiff(input, pictured.output)
      expect(pic.changed).toEqual([rels, part].sort())
      expect(pic.added).toHaveLength(1)
      expect(pic.added[0]).toMatch(/^ppt\/media\/image\d+\.png$/)
      expect(pic.gone).toEqual([])
      expect((await inspect(pictured.output)).slides.find((x) => x.id === 265)!.shapes.at(-1)).toMatchObject({ kind: 'picture', own: { box: [500000, 1500000, 2000000, 1000000] } })
      // A file that is not one, and a picture that did not come with the edit: a sentence, nothing written.
      await expect(applyWith(input, [{ op: 'insert', slide: 265, what: 'picture', file: 'f0.png', box: [0, 0, 100, 100] }], [['f0.png', attach('not.png', Buffer.from('hello'))]])).rejects.toThrow('is not a picture a deck can hold')
      await expect(apply(input, [{ op: 'insert', slide: 265, what: 'picture', file: '/etc/passwd', box: [0, 0, 100, 100] }], true)).rejects.toThrow('did not come with the edit')

      // A chart: its own part with its workbook, the slide's relationship, and its content types.
      const charted = await apply(input, [{ op: 'insert', slide: 265, what: 'chart', box: [500000, 1500000, 4000000, 3000000], chart: { type: 'line', categories: ['Mon', 'Tue'], series: [{ name: 'Seen', values: [1, 2] }] } }], true)
      const ch = await partsDiff(input, charted.output)
      expect(ch.changed).toEqual(['[Content_Types].xml', rels, part].sort())
      expect(ch.added.map((k) => k.replace(/\d+/g, 'N')).sort()).toEqual(['ppt/charts/_rels/chartN.xml.rels', 'ppt/charts/chartN.xml', 'ppt/embeddings/Microsoft_Excel_SheetN.xlsx'])
      expect((await inspect(charted.output)).slides.find((x) => x.id === 265)!.shapes.at(-1)).toMatchObject({ kind: 'chart', chart: { categories: ['Mon', 'Tue'], series: [{ name: 'Seen', values: [1, 2] }] } })
    })

    it('insert: a video brings its media, a poster and its timing node', async () => {
      const input = file(readFileSync(FEATURE))
      const part = await slidePart(input, 265)
      const media = join(dir, 'clip.mp4')
      // The deck's own clip, taken out of it: a real MP4.
      const zip = await JSZip.loadAsync(readFileSync(FEATURE))
      const clip = Object.keys(zip.files).find((k) => /^ppt\/media\/.*\.mp4$/i.test(k))!
      writeFileSync(media, await zip.file(clip)!.async('nodebuffer'))
      const { output } = await applyWith(input, [{ op: 'insert', slide: 265, what: 'video', file: 'f0.mp4', box: [500000, 1500000, 3200000, 1800000], id: 77 }], [['f0.mp4', media]])
      const d = await partsDiff(input, output)
      expect(d.changed).toContain(part)
      expect(d.gone).toEqual([])
      expect((await inspect(output)).slides.find((x) => x.id === 265)!.shapes.at(-1)).toMatchObject({ id: 77, kind: 'media', media: 'video' })
      const xml = await xmlOf(output, part)
      expect(xml).toContain('<p:timing>')
      expect(xml).toMatch(/<p:spTgt spid="77"\/>/)
      await expect(applyWith(input, [{ op: 'insert', slide: 265, what: 'video', file: 'f0.txt', box: [0, 0, 100, 100] }], [['f0.txt', attach('x.txt', Buffer.from('x'))]])).rejects.toThrow('is not a video a deck can hold')
    })

    it('delete: a shape goes with what only it used and with its effects; what another shape still uses stays', async () => {
      const input = file(readFileSync(FEATURE))
      // A picture: its media part is not needed again, and nothing else of the deck moves.
      const pic = await apply(input, [{ op: 'delete', slide: 259, shape: 3 }], true)
      const d = await partsDiff(input, pic.output)
      const part = await slidePart(input, 259)
      expect(d.changed.filter((k) => k !== '[Content_Types].xml').sort()).toEqual([part.replace('slides/', 'slides/_rels/') + '.rels', part].sort())
      expect(d.added).toEqual([])
      expect((await inspect(pic.output)).slides.find((x) => x.id === 259)!.shapes.map((x) => x.id)).toEqual([2, 4, 5])
      // A chart goes with its part and its workbook.
      const chart = await apply(input, [{ op: 'delete', slide: 260, shape: 3 }], true)
      expect((await partsDiff(input, chart.output)).gone.some((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k))).toBe(true)
      // A shape with effects: every effect on it leaves the slide's timing, and no timing names a shape that is gone.
      const info = await inspect(input)
      for (const slide of info.slides) {
        const xml = await xmlOf(input, await slidePart(input, slide.id))
        const played = [...xml.matchAll(/<p:spTgt spid="(\d+)"/g)].map((m) => Number(m[1]))
        if (!played.length) continue
        const target = played[0]
        const { output } = await apply(input, [{ op: 'delete', slide: slide.id, shape: target }], true)
        const after = await xmlOf(output, await slidePart(output, slide.id))
        expect(after).not.toContain(`<p:spTgt spid="${target}"`)
        expect(after).not.toMatch(/<p:childTnLst\/>/)
        const left = new Set((await inspect(output)).slides.find((x) => x.id === slide.id)!.shapes.map((x) => x.id))
        for (const m of after.matchAll(/<p:spTgt spid="(\d+)"/g)) expect(left.has(Number(m[1]))).toBe(true)
      }
    })

    it('grid: a row and a column put in and taken out; the table grows and shrinks by them; merged cells are PowerPoint\'s', async () => {
      const input = file(await writeNewDeck({ title: 'T', slides: TWELVE }))
      const before = await inspect(input)
      const slide = before.slides[9]
      const table = slide.shapes.find((x) => x.kind === 'table')!
      const part = await slidePart(input, slide.id)
      const { output } = await apply(
        input,
        [
          { op: 'grid', slide: slide.id, shape: table.id, what: 'row', act: 'insert', at: 1 },
          { op: 'grid', slide: slide.id, shape: table.id, what: 'col', act: 'insert', at: 2 },
          { op: 'cell', slide: slide.id, shape: table.id, row: 1, col: 2, text: 'New' }
        ],
        true
      )
      // (python-pptx tidies the content types of a deck pptxgenjs wrote; the parts are what the edit may change.)
      expect((await partsDiff(input, output)).changed.filter((k) => k !== '[Content_Types].xml')).toEqual([part])
      const grown = (await inspect(output)).slides[9].shapes.find((x) => x.kind === 'table')!
      expect(grown.cells).toEqual([['Item', 'Cost', ''], ['', '', 'New'], ['Stage', '$4,000', ''], ['Sound', '$2,500', '']])
      expect(grown.own!.box[3]).toBeGreaterThan(table.own!.box[3])
      expect(grown.own!.box[2]).toBeGreaterThan(table.own!.box[2])
      const shrunk = await apply(output, [{ op: 'grid', slide: slide.id, shape: table.id, what: 'row', act: 'delete', at: 1 }, { op: 'grid', slide: slide.id, shape: table.id, what: 'col', act: 'delete', at: 2 }], true)
      const back = (await inspect(shrunk.output)).slides[9].shapes.find((x) => x.kind === 'table')!
      expect(back.cells).toEqual(table.cells)
      expect(back.own!.box).toEqual(table.own!.box)
      await expect(apply(input, [{ op: 'grid', slide: slide.id, shape: table.id, what: 'row', act: 'delete', at: 9 }], true)).rejects.toThrow('there is no row 10')
      await expect(apply(input, [{ op: 'grid', slide: slide.id, shape: 2, what: 'row', act: 'insert', at: 0 }], true)).rejects.toThrow('is not a table')
    })

    it('hide and layout change one part each; a layout with no place for what the slide holds is PowerPoint\'s', async () => {
      const input = file(await writeNewDeck({ title: 'T', slides: TWELVE }))
      const before = await inspect(input)
      const third = before.slides[2]
      const part = await slidePart(input, third.id)
      const hidden = await apply(input, [{ op: 'hide', slide: third.id, hidden: true }], true)
      expect((await partsDiff(input, hidden.output)).changed.filter((k) => k !== '[Content_Types].xml')).toEqual([part])
      expect((await inspect(hidden.output)).slides[2].hidden).toBe(true)
      expect((await inspect((await apply(hidden.output, [{ op: 'hide', slide: third.id, hidden: false }], true)).output)).slides[2].hidden).toBe(false)
      // A layout whose placeholders match: the slide's relationship to its layout moves, and nothing else.
      const fits = before.layoutInfo!.filter((l) => l.name !== third.layout && before.layoutInfo!.find((x) => x.name === third.layout)!.holds.every((h) => l.holds.some((o) => o.idx === h.idx && o.kind === h.kind)))
      const other = before.layoutInfo!.find((l) => l.name !== third.layout && !fits.includes(l))
      if (fits.length) {
        const swapped = await apply(input, [{ op: 'layout', slide: third.id, layout: fits[0].name }], true)
        expect((await partsDiff(input, swapped.output)).changed.filter((k) => k !== '[Content_Types].xml')).toEqual([part.replace('slides/', 'slides/_rels/') + '.rels'])
        expect((await inspect(swapped.output)).slides[2].layout).toBe(fits[0].name)
      }
      if (other) await expect(apply(input, [{ op: 'layout', slide: third.id, layout: other.name }], true)).rejects.toThrow('change this layout in PowerPoint')
      await expect(apply(input, [{ op: 'layout', slide: third.id, layout: 'No such layout' }], true)).rejects.toThrow('the deck has no layout named')
    })

    it('duplicate: a copy right after its slide, with its own chart and workbook; the slide copied keeps its bytes', async () => {
      const input = file(readFileSync(FEATURE))
      const before = await inspect(input)
      const { output } = await apply(input, [{ op: 'duplicate', slide: 260, id: 9000 }, { op: 'notes', slide: 256, text: 'Kept' }, { op: 'duplicate', slide: 256, id: 9001 }], true)
      const after = await inspect(output)
      expect(after.slides.map((x) => x.id)).toEqual([256, 9001, 257, 258, 259, 260, 9000, 261, 262, 263, 264, 265])
      const [was, copy] = [before.slides.find((x) => x.id === 260)!, after.slides.find((x) => x.id === 9000)!]
      expect(copy.shapes.map((x) => [x.id, x.kind, x.text, x.own])).toEqual(was.shapes.map((x) => [x.id, x.kind, x.text, x.own]))
      expect(copy.shapes.filter((x) => x.kind === 'chart').map((x) => x.chart)).toEqual(was.shapes.filter((x) => x.kind === 'chart').map((x) => x.chart))
      expect(after.slides.find((x) => x.id === 9001)!.notes).toBe('Kept')
      const d = await partsDiff(input, output)
      // The copied slide's own part, and every chart the deck had, are byte for byte as they were.
      expect(d.changed.filter((k) => /charts\/chart|embeddings/.test(k))).toEqual([])
      expect(d.changed).not.toContain(await slidePart(input, 260))
      const charts = was.shapes.filter((x) => x.kind === 'chart').length
      expect(d.added.filter((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k))).toHaveLength(charts)
      expect(d.added.filter((k) => /^ppt\/embeddings\//.test(k))).toHaveLength(charts)
      expect(d.gone).toEqual([])
      // An edit of the copy's chart leaves the first slide's as it was.
      const edited = await apply(output, [{ op: 'chart', slide: 9000, shape: copy.shapes.find((x) => x.kind === 'chart')!.id, categories: ['x'], series: [{ name: 's', values: [9] }] }], true)
      const both = await inspect(edited.output)
      expect(both.slides.find((x) => x.id === 260)!.shapes.find((x) => x.kind === 'chart')!.chart).toEqual(was.shapes.find((x) => x.kind === 'chart')!.chart)
      expect(both.slides.find((x) => x.id === 9000)!.shapes.find((x) => x.kind === 'chart')!.chart).toEqual({ categories: ['x'], series: [{ name: 's', values: [9] }] })
    })

    it('section and theme change the presentation and the theme alone', async () => {
      const input = file(readFileSync(FEATURE))
      const before = await inspect(input)
      expect(before.sections.map((x) => x.name)).toEqual(['Visual tests', 'Playback tests'])
      // The last one taken away: its slides join the one before. The only one taken away: the deck has none.
      const none = await apply(input, [{ op: 'section', act: 'remove', section: 1 }, { op: 'section', act: 'remove', section: 0 }], true)
      expect(await partsDiff(input, none.output)).toEqual({ changed: ['ppt/presentation.xml'], added: [], gone: [] })
      expect((await inspect(none.output)).sections).toEqual([])
      // Into a deck with none: the slides before the new section become the default one, as PowerPoint does it.
      const sectioned = await apply(none.output, [{ op: 'section', act: 'add', at: 258, name: 'Shapes' }, { op: 'section', act: 'add', at: 262, name: 'Motion' }, { op: 'section', act: 'rename', section: 0, name: 'Opening' }], true)
      expect(await partsDiff(none.output, sectioned.output)).toEqual({ changed: ['ppt/presentation.xml'], added: [], gone: [] })
      expect((await inspect(sectioned.output)).sections).toEqual([
        { name: 'Opening', slideIds: [256, 257] },
        { name: 'Shapes', slideIds: [258, 259, 260, 261] },
        { name: 'Motion', slideIds: [262, 263, 264, 265] }
      ])
      // The first one taken away: its slides join the next.
      const merged = await apply(sectioned.output, [{ op: 'section', act: 'remove', section: 0 }], true)
      expect((await inspect(merged.output)).sections).toEqual([
        { name: 'Shapes', slideIds: [256, 257, 258, 259, 260, 261] },
        { name: 'Motion', slideIds: [262, 263, 264, 265] }
      ])
      await expect(apply(sectioned.output, [{ op: 'section', act: 'add', at: 258, name: 'Again' }], true)).rejects.toThrow('a section already starts at slide 258')
      await expect(apply(sectioned.output, [{ op: 'section', act: 'rename', section: 7, name: 'x' }], true)).rejects.toThrow('there is no section 8')

      const themed = await apply(input, [{ op: 'theme', colors: { accent1: '112233', dk2: '445566' }, major: 'Georgia', minor: 'Verdana' }], true)
      const d = await partsDiff(input, themed.output)
      expect(d.changed.every((k) => /^ppt\/theme\/theme\d+\.xml$/.test(k))).toBe(true)
      expect(d.changed.length).toBeGreaterThan(0)
      expect([d.added, d.gone]).toEqual([[], []])
      expect((await inspect(themed.output)).theme).toMatchObject({ colors: { accent1: '112233', dk2: '445566' }, major: 'Georgia', minor: 'Verdana' })
    })

    it('a look in a theme colour is the theme\'s own, lighter or darker by Office\'s maths', async () => {
      const input = file(readFileSync(FIXTURE))
      const { output } = await apply(input, [{ op: 'format', slide: 268, shape: 133, set: { color: { slot: 'accent1', tint: 0.4 } } }, { op: 'fill', slide: 268, shape: 134, color: { slot: 'accent2', tint: -0.25 } }], true)
      const xml = await xmlOf(output, 'ppt/slides/slide1.xml')
      expect(xml).toContain('<a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>')
      expect(xml).toContain('<a:schemeClr val="accent2"><a:lumMod val="75000"/></a:schemeClr>')
    })

    it('LibreOffice opens a deck that holds one of each', { timeout: 180_000 }, async () => {
      const input = file(readFileSync(FEATURE))
      const { output } = await applyWith(
        input,
        [
          { op: 'geometry', slide: 258, shape: 3, box: [1000000, 2000000, 1500000, 800000], rot: 30 },
          { op: 'order', slide: 258, shape: 3, to: 'front' },
          { op: 'insert', slide: 265, what: 'text', box: [500000, 1500000, 3000000, 600000], text: 'Typed here' },
          { op: 'insert', slide: 265, what: 'shape', preset: 'rightArrow', box: [4000000, 1500000, 1500000, 800000] },
          { op: 'insert', slide: 265, what: 'picture', file: 'f0.png', box: [500000, 2500000, 2000000, 1000000] },
          { op: 'insert', slide: 265, what: 'table', rows: 2, cols: 2, box: [3000000, 2500000, 3000000, 800000] },
          { op: 'insert', slide: 265, what: 'chart', box: [500000, 3700000, 4000000, 2500000], chart: { type: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] } },
          { op: 'fill', slide: 258, shape: 3, color: 'FFAA00' },
          { op: 'line', slide: 258, shape: 3, color: '333333', width: 3, dash: 'dot' },
          { op: 'delete', slide: 259, shape: 3 },
          { op: 'hide', slide: 257, hidden: true },
          { op: 'duplicate', slide: 260, id: 9000 },
          { op: 'section', act: 'add', at: 258, name: 'Shapes' },
          { op: 'theme', colors: { accent1: '112233' }, major: 'Georgia' }
        ],
        [['f0.png', attach('red2.png', PNG)]]
      )
      const pdf = await runner.convert({ from: 'pptx', to: 'pdf', input: output, output: join(dir, `one-of-each-${++n}.pdf`), options: { filter: 'impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}' } })
      expect(readFileSync(pdf.output).toString('latin1').match(/\/Type\s*\/Page[^s]/g)).toHaveLength(11)
      writeFileSync('/tmp/sld5/one-of-each.pptx', readFileSync(output))
    })
  })

  it('adds a slide with its id, words it in the same list, moves, removes and sets notes; the other slides keep their bytes', async () => {
    const input = file(readFileSync(FIXTURE))
    const before = await inspect(input)
    const ops = allocateIds(
      [
        { op: 'add', after: 268, layout: 'Title, Content', title: 'New one', body: ['a', 'b'], notes: 'hi' },
        { op: 'move', slide: 267, after: 0 },
        { op: 'notes', slide: 268, text: 'Speak slowly\nThen stop' }
      ],
      before
    )
    const id = (ops[0] as { id: number }).id
    expect(id).toBe(10269)
    const { output, warnings } = await apply(input, [...ops, { op: 'text', slide: id, shape: (await titleId(input, ops)) ?? 2, paragraphs: ['Renamed'] }], true)
    expect(warnings).toEqual([])
    const d = await inspect(output)
    expect(d.slides.map((s) => s.id)).toEqual([267, 268, id])
    expect(d.slides[2]).toMatchObject({ title: 'Renamed', notes: 'hi', layout: 'Title, Content' })
    expect(d.slides[2].shapes.map((s) => s.text)).toContain('a\nb')
    expect(d.slides[1].notes).toBe('Speak slowly\nThen stop')
    // 267 moved and is untouched: its part keeps its bytes, though the save named it again.
    expect(d.slides[0].hash).toBe(before.slides[1].hash)
    const gone = await apply(output, [{ op: 'remove', slide: 268 }], true)
    const left = await inspect(gone.output)
    expect(left.slides.map((s) => s.id)).toEqual([267, id])
    expect(left.slides[0].hash).toBe(before.slides[1].hash)
    expect(left.slides[1].hash).toBe(d.slides[2].hash)
    expect([...(await entries(gone.output)).keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))).toHaveLength(2)
  })

  /** The shape id of the title placeholder an add made, by a dry run without the text op. */
  async function titleId(input: string, ops: SlideOp[]): Promise<number | undefined> {
    const dry = await apply(input, ops, true)
    const add = ops[0] as { id: number }
    return (await inspect(dry.output)).slides.find((s) => s.id === add.id)?.shapes.find((s) => s.placeholder === 'title')?.id
  }

  it("edits a table's cell and a chart's data, and leaves the other slides' parts alone", async () => {
    const input = file(await writeNewDeck({ title: 'Data', slides: TWELVE }))
    const before = await inspect(input)
    const tableSlide = before.slides[9]
    const chartSlide = before.slides[10]
    const table = tableSlide.shapes.find((s) => s.kind === 'table')!
    const chart = chartSlide.shapes.find((s) => s.kind === 'chart')!
    const { output, warnings } = await apply(
      input,
      [
        { op: 'cell', slide: tableSlide.id, shape: table.id, row: 1, col: 1, text: '$4,400' },
        { op: 'chart', slide: chartSlide.id, shape: chart.name, categories: ['Mon', 'Tue', 'Wed', 'Thu'], series: [{ name: 'Stream', values: [1200, 3400, 6200, null] }] }
      ],
      true
    )
    expect(warnings).toEqual([])
    const after = await inspect(output)
    expect(shape(after, tableSlide.id, table.id).cells?.[1]).toEqual(['Stage', '$4,400'])
    expect(shape(after, chartSlide.id, chart.id).chart).toEqual({ categories: ['Mon', 'Tue', 'Wed', 'Thu'], series: [{ name: 'Stream', values: [1200, 3400, 6200, null] }] })
    after.slides.forEach((s, i) => {
      if (i !== 9) expect(s.hash, `slide ${i + 1}`).toBe(before.slides[i].hash)
    })
  })

  it('keeps sections in step on add, move and remove', async () => {
    const p = new PptxGenJS()
    p.addSection({ title: 'One' })
    p.addSection({ title: 'Two' })
    for (const [i, s] of ['One', 'One', 'Two', 'Two'].entries()) p.addSlide({ sectionTitle: s }).addText(`S${i + 1}`, { x: 1, y: 1, w: 5, h: 1 })
    const input = file((await p.write({ outputType: 'uint8array' })) as Uint8Array)
    const before = await inspect(input)
    expect(before.sections).toEqual([
      { name: 'One', slideIds: [256, 257] },
      { name: 'Two', slideIds: [258, 259] }
    ])
    const { output } = await apply(input, [{ op: 'add', after: 257, layout: before.layouts[0], id: 400 }, { op: 'move', slide: 256, after: 259 }, { op: 'remove', slide: 258 }, { op: 'add', after: 0, layout: before.layouts[0], id: 401 }], true)
    const d = await inspect(output)
    expect(d.slides.map((s) => s.id)).toEqual([401, 257, 400, 259, 256])
    expect(d.sections).toEqual([
      { name: 'One', slideIds: [401, 257, 400] },
      { name: 'Two', slideIds: [259, 256] }
    ])
  })

  it('says why each edit it cannot make fails, and under strict keeps nothing', async () => {
    const input = file(readFileSync(FIXTURE))
    const bad: SlideOp[] = [
      { op: 'text', slide: 267, shape: 'Nope', paragraphs: ['x'] },
      { op: 'text', slide: 999, shape: 1, paragraphs: ['x'] },
      { op: 'add', after: 0, layout: 'Nope', id: 300 },
      { op: 'add', after: 0, layout: 'Title Slide', id: 267 },
      { op: 'cell', slide: 267, shape: 160, row: 0, col: 0, text: 'x' },
      { op: 'chart', slide: 267, shape: 160, categories: ['a'], series: [{ name: 's', values: [1] }] },
      { op: 'move', slide: 267, after: 267 },
      { op: 'move', slide: 267, after: 5000 },
      { op: 'remove', slide: 999 },
      { op: 'add', after: 0, layout: 'Title Slide', id: 3_000_000_000 }
    ]
    const { warnings } = await apply(input, bad)
    expect(warnings).toEqual([
      'edit 1: slide 267 has no shape named Nope',
      'edit 2: there is no slide 999',
      `edit 3: the deck has no layout named Nope; its layouts are ${(await inspect(input)).layouts.join(', ')}`,
      'edit 4: the deck already has a slide 267',
      'edit 5: shape TextShape 1 on slide 267 is not a table',
      'edit 6: shape TextShape 1 on slide 267 is not a chart',
      'edit 7: slide 267 cannot go after itself',
      'edit 8: there is no slide 5000 to put slide 267 after',
      'edit 9: there is no slide 999',
      'edit 10: a slide id is from 256 to 2147483647, not 3000000000'
    ])
    const out = join(dir, 'strict.pptx')
    await expect(runner.convert({ from: 'pptx', to: 'pptxedit', input, output: out, options: { ops: bad.slice(0, 1), strict: true } })).rejects.toThrow('edit 1: slide 267 has no shape named Nope')
    expect(() => readFileSync(out)).toThrow()
    await expect(runner.convert({ from: 'pptx', to: 'pptxedit', input, output: out, options: { ops: [{ op: 'paint' }] } })).rejects.toThrow('the edits are not a list of slide edits')
  })

  /** Four slides; the first's words jump to the third (a slide-to-slide link, a relationship from slide 1 to slide 3's part). */
  async function linkedDeck(): Promise<string> {
    const p = new PptxGenJS()
    for (let i = 1; i <= 4; i++) p.addSlide().addText(i === 1 ? [{ text: 'Go to three', options: { hyperlink: { slide: 3 } } }] : `S${i}`, { x: 1, y: 1, w: 5, h: 1 })
    const path = file((await p.write({ outputType: 'uint8array' })) as Uint8Array)
    const one = await (await JSZip.loadAsync(readFileSync(path))).file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
    expect(one).toMatch(/Target="[^"]*slide3\.xml"/)
    return path
  }
  const pdfPages = async (input: string): Promise<number> => {
    const done = await runner.convert({ from: 'pptx', to: 'pdf', input, output: join(dir, `r-${++n}.pdf`) })
    return readFileSync(done.output, 'latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0
  }
  const repeats = (path: string): string[] => {
    const names = zipNames(readFileSync(path))
    return names.filter((x, i) => names.indexOf(x) !== i)
  }

  it('removes a slide another slide links to, and no later edit writes a part name twice; LibreOffice opens every result', { timeout: 120_000 }, async () => {
    const input = await linkedDeck()
    // In one list: remove the linked slide, then add.
    const one = await apply(input, [{ op: 'remove', slide: 258 }, { op: 'add', after: 0, layout: (await inspect(input)).layouts[0], id: 400 }], true)
    expect(repeats(one.output)).toEqual([])
    expect((await inspect(one.output)).slides.map((s) => s.id)).toEqual([400, 256, 257, 259])
    expect(await pdfPages(one.output)).toBe(4)
    // Across two writes: the remove alone, then a notes edit and an add.
    const removed = await apply(input, [{ op: 'remove', slide: 258 }], true)
    expect(zipNames(readFileSync(removed.output)).filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x))).toHaveLength(3)
    const slide1 = await (await JSZip.loadAsync(readFileSync(removed.output))).file('ppt/slides/slide1.xml')!.async('string')
    expect(slide1).not.toContain('hlinksldjump')
    const later = await apply(removed.output, [{ op: 'notes', slide: 256, text: 'Speak' }, { op: 'add', after: 257, layout: (await inspect(input)).layouts[0], id: 401 }], true)
    expect(repeats(later.output)).toEqual([])
    const d = await inspect(later.output)
    expect(d.slides.map((s) => s.id)).toEqual([256, 257, 401, 259])
    expect(d.slides[0].notes).toBe('Speak')
    expect(await pdfPages(later.output)).toBe(4)
  })

  it('names the slide whose link a remove took out, in a note that is no failure', async () => {
    const input = await linkedDeck()
    const { warnings, output } = await apply(input, [{ op: 'remove', slide: 258 }], true)
    expect(warnings).toEqual(['note: edit 1: slide 256 linked to slide 258; that link was taken out'])
    expect((await inspect(output)).slides.map((s) => s.id)).toEqual([256, 257, 259])
  })

  it('refuses to remove a slide something other than a link refers to, and changes nothing', async () => {
    const zip = await JSZip.loadAsync(readFileSync(await linkedDeck()))
    const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
    const rid = /Id="(rId\d+)"[^>]*Target="[^"]*slide3\.xml"/.exec(rels)?.[1] ?? /Target="[^"]*slide3\.xml"[^>]*Id="(rId\d+)"/.exec(rels)![1]
    const one = await zip.file('ppt/slides/slide1.xml')!.async('string')
    // Not a link: a custData entry that names the same relationship.
    zip.file('ppt/slides/slide1.xml', one.replace('</p:cSld>', `<p:custDataLst><p:custData r:id="${rid}"/></p:custDataLst></p:cSld>`))
    const input = file(await zip.generateAsync({ type: 'uint8array' }))
    const { warnings, output } = await apply(input, [{ op: 'remove', slide: 258 }])
    expect(warnings).toEqual(['edit 1: slide 256 refers to slide 258 in its custData, which is not a link; nothing was removed'])
    const after = await JSZip.loadAsync(readFileSync(output))
    expect(await after.file('ppt/slides/slide1.xml')!.async('string')).toContain(`<p:custData r:id="${rid}"/>`)
    expect((await inspect(output)).slides.map((s) => s.id)).toEqual([256, 257, 258, 259])
  })

  it("removes a slide from every custom show that names it, leaving no r:id the presentation's rels lack", async () => {
    const zip = await JSZip.loadAsync(readFileSync(await linkedDeck()))
    const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
    const rid = (target: string): string => new RegExp(`Id="(rId\\d+)"[^>]*Target="slides/${target}"`).exec(rels)?.[1] ?? new RegExp(`Target="slides/${target}"[^>]*Id="(rId\\d+)"`).exec(rels)![1]
    const show = `<p:custShowLst><p:custShow name="Short" id="0"><p:sldLst><p:sld r:id="${rid('slide2.xml')}"/><p:sld r:id="${rid('slide4.xml')}"/></p:sldLst></p:custShow></p:custShowLst>`
    const pres = await zip.file('ppt/presentation.xml')!.async('string')
    zip.file('ppt/presentation.xml', pres.includes('<p:defaultTextStyle') ? pres.replace('<p:defaultTextStyle', `${show}<p:defaultTextStyle`) : pres.replace('</p:presentation>', `${show}</p:presentation>`))
    const input = file(await zip.generateAsync({ type: 'uint8array' }))
    const { output } = await apply(input, [{ op: 'remove', slide: 257 }], true)
    const out = await JSZip.loadAsync(readFileSync(output))
    const after = await out.file('ppt/presentation.xml')!.async('string')
    const ids = new Set([...(await out.file('ppt/_rels/presentation.xml.rels')!.async('string')).matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]))
    const named = [...after.slice(after.indexOf('<p:custShowLst')).matchAll(/<p:sld r:id="(rId\d+)"/g)].map((m) => m[1])
    expect(named).toHaveLength(1)
    for (const id of named) expect(ids.has(id)).toBe(true)
    expect(await pdfPages(output)).toBe(3)
  })

  it('finish refuses, with a sentence, to write a zip in which a name repeats', () => {
    const py = runner.tools.bin('python-pptx')!
    const script = join(dir, 'deck_lib.py')
    writeFileSync(script, DECK_PY.replace("if __name__ == '__main__':", 'if False:'))
    const twice = join(dir, 'twice.pptx')
    // A zip with ppt/slides/slide1.xml twice, as python-pptx wrote one after a rename collided.
    const code = [
      'import sys, zipfile, warnings',
      'warnings.simplefilter("ignore")',
      `sys.path.insert(0, ${JSON.stringify(dir)})`,
      'import deck_lib',
      `src, twice, dst = ${JSON.stringify(FIXTURE)}, ${JSON.stringify(twice)}, ${JSON.stringify(join(dir, 'never.pptx'))}`,
      'z = zipfile.ZipFile(src); out = zipfile.ZipFile(twice, "w")',
      'for n in z.namelist(): out.writestr(n, z.read(n))',
      'out.writestr("ppt/slides/slide1.xml", z.read("ppt/slides/slide1.xml")); out.close()',
      'try:',
      '    deck_lib.finish(src, twice, dst); print("WROTE")',
      'except deck_lib.Fail as e:',
      '    print("FAIL", e)',
      'import os; print("EXISTS" if os.path.exists(dst) else "ABSENT")'
    ].join('\n')
    const r = spawnSync(py, ['-c', code], { encoding: 'utf8' })
    expect(r.stdout.trim().split('\n')).toEqual(['FAIL the edits would write the deck with two parts named ppt/slides/slide1.xml, so nothing was written', 'ABSENT'])
  })

  it('refuses a file that is not a deck with a sentence', async () => {
    const junk = join(dir, 'junk.pptx')
    copyFileSync(__filename, junk)
    await expect(inspect(junk)).rejects.toThrow(/^the deck could not be read or written/)
  })
})
