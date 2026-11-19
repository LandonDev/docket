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
import { allocateIds, HOST_ID_GAP, SLIDES_CONVERTERS, slideOfOp, type DeckInfo } from './deck'
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
