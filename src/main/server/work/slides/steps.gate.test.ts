import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StepHides } from '@shared/contract-work-slides'
import { LIBREOFFICE_CONVERTERS } from '../formats'
import { convertersOf, JobRunner } from '../formats/jobs'
import { Toolchain } from '../formats/tools'
import { nothingHidden, withBuilds } from './builds'
import { SLIDES_CONVERTERS, type DeckInfo, type SlideInfo } from './deck'
import { createResident } from './resident'
import { makeSteps, playsAsIs, STEPS_CONVERTERS, stepFile } from './steps'

/**
 * The gate of the show's steps, picture by picture (docs/agents/work-slides.md "Builds"), behind
 * TEMP_CODE_WORK_TOOLS_DATA (a userData whose toolchain has LibreOffice, python-pptx, PyMuPDF and ffmpeg;
 * /srv/agents/temp-code-data on the box). On the lab's feature deck and the two build decks (`fixtures/steps-make.py`)
 * every step picture is made the way the app makes it, and each step differs from the one before only inside the
 * boxes of what that step shows or takes away; a paragraph made clear moves no other line of its box. The last
 * step of a slide with no exits is the slide's own picture, and a copy made with nothing hidden draws the same
 * picture as the file, pixel for pixel.
 */

const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA
const FIXTURES = join(import.meta.dirname, 'fixtures')
const FILTER = 'impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'
/** Pixels at 1920 wide a shape's drawing may reach past its box: a theme's shadow reached 10. */
const MARGIN = 12

/** PyMuPDF and numpy: each pair's pages at 1920 wide, the pixels that differ, those outside the boxes, and the rows they span. */
const COMPARE_PY = String.raw`
import json, sys
import numpy as np, pymupdf
# its warnings (a video's Screen annotation) would go to stdout with the answer
pymupdf.TOOLS.mupdf_display_errors(False)
jobs = json.loads(open(sys.argv[1]).read())
cache = {}
def pix(path, page):
    key = (path, page)
    if key not in cache:
        with pymupdf.open(path) as doc:
            p = doc[page - 1]
            z = 1920 / p.rect.width
            m = p.get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False)
            # A 959.98 pt page at 1920 wide ends in a partial column and row, which two exports draw unlike: left out.
            cache[key] = np.frombuffer(m.samples, np.uint8).reshape(m.height, m.width, 3)[:-1, :-1]
    return cache[key]
out = []
for j in jobs:
    a, b = pix(*j['a']), pix(*j['b'])
    if a.shape != b.shape:
        out.append({'diff': -1, 'outside': -1, 'rows': None}); continue
    d = (a != b).any(axis=2)
    h, w = d.shape
    inside = np.zeros_like(d)
    for x0, y0, x1, y1 in j['boxes']:
        m = j['margin']
        inside[max(0, int(y0 * h) - m):min(h, int(y1 * h) + m + 1), max(0, int(x0 * w) - m):min(w, int(x1 * w) + m + 1)] = True
    ys = np.nonzero(d.any(axis=1))[0]
    out.append({'diff': int(d.sum()), 'outside': int((d & ~inside).sum()), 'rows': [int(ys.min()), int(ys.max())] if len(ys) else None})
print('RESULT ' + json.dumps(out))
`

type Box = [number, number, number, number]
/** The boxes a set of shapes is drawn in: each shape's quad's box; a group's, its shapes'. */
function boxesOf(slide: SlideInfo, ids: Iterable<number>): Box[] {
  const want = new Set(ids)
  return slide.shapes.flatMap((s): Box[] => {
    if (!(want.has(s.id) || (s.group !== undefined && want.has(s.group))) || !s.quad) return []
    const xs = s.quad.map((p) => p[0])
    const ys = s.quad.map((p) => p[1])
    return [[Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]]
  })
}
/** What differs between two steps: the shapes and paragraph runs one hides and the other does not. */
function changedBetween(a: StepHides, b: StepHides): { shapes: Set<number>; paras: Set<number> } {
  const shapes = new Set([...a.shapes, ...b.shapes].filter((id) => a.shapes.includes(id) !== b.shapes.includes(id)))
  const key = (h: StepHides): Set<string> => new Set(h.paras.flatMap((p) => Array.from({ length: p.to - p.from + 1 }, (_, k) => `${p.shape}:${p.from + k}`)))
  const [ka, kb] = [key(a), key(b)]
  const paras = new Set([...ka, ...kb].filter((k) => ka.has(k) !== kb.has(k)).map((k) => Number(k.split(':')[0])))
  return { shapes, paras }
}

describe.skipIf(!DATA)("the show's steps, picture by picture", () => {
  let dir: string
  let runner: JobRunner
  let resident: ReturnType<typeof createResident>
  let py: string
  const measured: string[] = []
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-steps-gate-'))
    const installed = join(DATA!, 'work-tools')
    const linked = join(dir, 'work-tools')
    mkdirSync(linked)
    for (const entry of readdirSync(installed)) {
      if (entry !== 'jobs' && entry !== 'run') symlinkSync(join(installed, entry), join(linked, entry))
    }
    const tools = new Toolchain(dir)
    py = tools.bin('pdf-tools')!
    resident = createResident({ soffice: () => tools.bin('libreoffice'), folder: join(dir, 'resident'), log: () => {} })
    runner = new JobRunner({ host: 'env_test', dataDir: dir, converters: convertersOf([{ id: 'slides', ensure() {}, convert: [...LIBREOFFICE_CONVERTERS, ...SLIDES_CONVERTERS, ...STEPS_CONVERTERS] }]), log: () => {} })
  })
  afterAll(async () => {
    console.log(`[steps gate]\n${measured.join('\n')}`)
    await resident?.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const outline = async (deck: string): Promise<DeckInfo> => {
    const out = join(dir, `${Math.random().toString(36).slice(2)}.json`)
    await runner.convert({ from: 'pptx', to: 'deckinfo', input: deck, output: out })
    return withBuilds(JSON.parse(readFileSync(out, 'utf8')) as DeckInfo)
  }
  const compare = (jobs: Array<{ a: [string, number]; b: [string, number]; boxes: Box[]; margin: number }>): Array<{ diff: number; outside: number; rows: [number, number] | null }> => {
    const file = join(dir, `jobs-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(file, JSON.stringify(jobs))
    const r = spawnSync(py, ['-I', '-c', COMPARE_PY, file], { encoding: 'utf8', maxBuffer: 1 << 24 })
    expect(r.status, r.stderr).toBe(0)
    return JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('RESULT '))!.slice(7))
  }

  it.each(['steps-kinds', 'steps-talk'])('reads %s as its committed outline says, so the unit tests read what the tool reads', async (name) => {
    const info = await outline(join(FIXTURES, `${name}.pptx`))
    const kept = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Array<{ id: number; timing?: unknown; shapes: unknown[] }>
    expect(info.slides.map((s) => ({ id: s.id, timing: s.timing, shapes: s.shapes.map((sh) => ({ id: sh.id, kind: sh.kind, ...(sh.group !== undefined ? { group: sh.group } : {}), text: sh.text })) }))).toEqual(
      kept.map((s) => ({ id: s.id, timing: s.timing, shapes: s.shapes }))
    )
  }, 120_000)

  it.each(['12-feature-probes', 'steps-kinds', 'steps-talk'])('draws each step of %s changed only inside the boxes of what it shows or takes away', async (name) => {
    const deck = join(dir, `${name}.pptx`)
    copyFileSync(join(FIXTURES, `${name}.pptx`), deck)
    const info = await outline(deck)
    const plain = join(dir, `${name}.pdf`)
    await resident.deck(deck, plain)
    const pages = join(dir, `${name}-pages`)
    mkdirSync(pages)
    const started = performance.now()
    const made = await makeSteps(
      {
        dir: pages,
        renderer: { slide: async (i, p, o, s) => (await resident.slide(i, p, o, s)).slides, deck: async (i, o, s) => void (await resident.deck(i, o, s)) },
        hideCopy: async (input, plan, output) => void (await runner.convert({ from: 'pptx', to: 'pptxsteps', input, output, options: { plan } })),
        whole: async (input, output) => void (await runner.convert({ from: 'pptx', to: 'pdf', input, output, options: { filter: FILTER } })),
        log: (line) => console.warn(line)
      },
      deck,
      info.slides
    )
    const ms = Math.round(performance.now() - started)
    const stepped = info.slides.map((s, i) => ({ s, page: i + 1 })).filter(({ s }) => s.builds && !s.builds.whole && s.builds.steps.length > 1)
    const whole = info.slides.filter((s) => s.builds?.whole).map((s) => `${s.title} (${s.builds!.whole})`)
    const picOf = (s: SlideInfo, page: number, k: number): [string, number] => (nothingHidden(s.builds!.steps[k]) ? [plain, page] : [stepFile(pages, s, k)!.path, 1])

    // Every step that hides something has its picture.
    for (const { s } of stepped) s.builds!.steps.forEach((h, k) => nothingHidden(h) || expect(stepFile(pages, s, k), `${s.title} step ${k + 1}`).not.toBeNull())

    const jobs: Array<{ a: [string, number]; b: [string, number]; boxes: Box[]; margin: number; slide: SlideInfo; what: ReturnType<typeof changedBetween>; label: string }> = []
    for (const { s, page } of stepped) {
      const steps = s.builds!.steps
      for (let k = 1; k < steps.length; k++) {
        const what = changedBetween(steps[k - 1], steps[k])
        jobs.push({ a: picOf(s, page, k - 1), b: picOf(s, page, k), boxes: boxesOf(s, [...what.shapes, ...what.paras]), margin: MARGIN, slide: s, what, label: `${s.title}: step ${k} to ${k + 1}` })
      }
      // The last step against the file's own picture: only what it still hides differs (nothing, with no exits).
      const last = steps[steps.length - 1]
      jobs.push({ a: picOf(s, page, steps.length - 1), b: [plain, page], boxes: boxesOf(s, [...last.shapes, ...last.paras.map((p) => p.shape)]), margin: MARGIN, slide: s, what: changedBetween(last, { shapes: [], paras: [] }), label: `${s.title}: last step to the file` })
    }
    const rows = compare(jobs.map(({ a, b, boxes, margin }) => ({ a, b, boxes, margin })))
    const failed: string[] = []
    const bands = new Map<string, Array<[number, number]>>()
    rows.forEach((r, i) => {
      const j = jobs[i]
      const changes = j.what.shapes.size + j.what.paras.size
      if (r.outside !== 0) failed.push(`${j.label}: ${r.outside} px outside`)
      if (changes > 0 && r.diff <= 0) failed.push(`${j.label}: nothing changed`)
      if (changes === 0 && r.diff !== 0) failed.push(`${j.label}: ${r.diff} px changed where nothing should`)
      // A paragraph made clear moves no other line: the rows one step changes in a shape are no other step's.
      if (j.what.shapes.size === 0 && j.what.paras.size === 1 && r.rows && !j.label.endsWith('to the file')) {
        const key = `${j.slide.id}:${[...j.what.paras][0]}`
        for (const [y0, y1] of bands.get(key) ?? []) if (r.rows[0] <= y1 && y0 <= r.rows[1]) failed.push(`${j.label}: rows ${r.rows.join('–')} were changed by another step too`)
        bands.set(key, [...(bands.get(key) ?? []), r.rows])
      }
    })
    measured.push(
      `${name}: ${stepped.length} slides in steps, ${made} pictures made in ${ms} ms, ${jobs.length} pairs, largest difference ${Math.max(0, ...rows.map((r) => r.diff))} px, outside the boxes ${rows.reduce((n, r) => n + Math.max(0, r.outside), 0)} px; shown whole: ${whole.join('; ') || 'none'}`
    )
    expect(failed).toEqual([])
    expect(stepped.length).toBeGreaterThan(0)

    // A copy made with nothing hidden draws every page as the file does.
    const same = join(dir, `${name}-same.pptx`)
    await runner.convert({ from: 'pptx', to: 'pptxsteps', input: deck, output: same, options: { plan: Object.fromEntries(stepped.map(({ s }) => [String(s.id), { shapes: [], paras: [] }])) } })
    const samePdf = join(dir, `${name}-same.pdf`)
    await resident.deck(same, samePdf)
    const neutral = compare(info.slides.map((_, i) => ({ a: [plain, i + 1] as [string, number], b: [samePdf, i + 1] as [string, number], boxes: [], margin: 0 })))
    expect(neutral.map((r) => r.diff)).toEqual(info.slides.map(() => 0))
  }, 600_000)

  it.each(['steps-kinds', 'steps-talk'])('draws nothing of a paragraph made clear in %s, its bullet included', async (name) => {
    const deck = join(dir, `${name}-clear.pptx`)
    copyFileSync(join(FIXTURES, `${name}.pptx`), deck)
    const info = await outline(deck)
    // A text shape all of whose paragraphs a slide's first step hides: made clear, it draws as if it were not there.
    // (PowerPoint shows nothing there; LibreOffice drew the bullets of paragraphs whose colour alone was clear.)
    const cases = info.slides.flatMap((s, i) => {
      const first = s.builds && !s.builds.whole ? s.builds.steps[0] : undefined
      const all = (first?.paras ?? []).filter((p) => p.from === 0 && p.to === (s.shapes.find((sh) => sh.id === p.shape)?.paragraphs?.length ?? 0) - 1)
      return all.length ? [{ id: s.id, title: s.title, page: i + 1, shapes: all.map((p) => ({ id: p.shape, count: p.to + 1 })) }] : []
    })
    expect(cases.length).toBeGreaterThan(0)
    const drawn = async (tag: string, plan: Record<string, { shapes: number[]; paras: Array<[number, number[]]> }>): Promise<string> => {
      const copy = join(dir, `${name}-${tag}.pptx`)
      await runner.convert({ from: 'pptx', to: 'pptxsteps', input: deck, output: copy, options: { plan } })
      const pdf = join(dir, `${name}-${tag}.pdf`)
      await resident.deck(copy, pdf)
      return pdf
    }
    const clear = await drawn('clear', Object.fromEntries(cases.map((c) => [String(c.id), { shapes: [], paras: c.shapes.map((sh) => [sh.id, Array.from({ length: sh.count }, (_, k) => k)] as [number, number[]]) }])))
    const gone = await drawn('gone', Object.fromEntries(cases.map((c) => [String(c.id), { shapes: c.shapes.map((sh) => sh.id), paras: [] }])))
    const rows = compare(cases.map((c) => ({ a: [clear, c.page] as [string, number], b: [gone, c.page] as [string, number], boxes: [], margin: 0 })))
    measured.push(`${name}: ${cases.length} slides whose text is made clear whole, drawn against the same slides with the shape taken out: ${rows.map((r) => r.diff).join(', ')} px apart`)
    expect(rows.map((r, i) => `${cases[i].title}: ${r.diff} px`)).toEqual(cases.map((c) => `${c.title}: 0 px`))
  }, 600_000)

  it('takes a video and a sound out of the deck as they are, and makes an .mp4 of a video the app cannot play', async () => {
    const deck = join(FIXTURES, '12-feature-probes.pptx')
    const info = await outline(deck)
    const media = info.slides.flatMap((s) => s.shapes.filter((sh) => sh.kind === 'media').map((sh) => ({ slide: s.id, shape: sh.id, kind: sh.media })))
    expect(media.map((m) => m.kind)).toEqual(['video', 'audio'])
    const ffprobe = new Toolchain(DATA!).bin('ffmpeg', 'ffprobe')!
    const probe = (path: string) => JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=format_name:stream=codec_type,codec_name,pix_fmt', '-of', 'json', path], { encoding: 'utf8' }).stdout)
    for (const m of media) {
      const src = join(dir, `media-${m.shape}.bin`)
      const play = join(dir, `media-${m.shape}.play`)
      await runner.convert({ from: 'pptx', to: 'slidemedia', input: deck, output: src, options: { slide: m.slide, shape: m.shape } })
      await runner.convert({ from: 'slidemedia', to: 'playable', input: src, output: play })
      // the package's MP4 and WAV play as they are: the same bytes
      expect(readFileSync(play).equals(readFileSync(src))).toBe(true)
      expect(playsAsIs(probe(play))).toBe(true)
    }
    // A WMV, as an old deck holds one: made an .mp4 of H.264 and AAC.
    const ffmpeg = new Toolchain(DATA!).bin('ffmpeg')!
    const wmv = join(dir, 'old.wmv')
    expect(spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'wmv2', '-c:a', 'wmav2', wmv]).status).toBe(0)
    expect(playsAsIs(probe(wmv))).toBe(false)
    const out = join(dir, 'old.play')
    await runner.convert({ from: 'slidemedia', to: 'playable', input: wmv, output: out })
    const made = probe(out)
    expect(playsAsIs(made)).toBe(true)
    expect(made.streams.map((s: { codec_name: string }) => s.codec_name).sort()).toEqual(['aac', 'h264'])
  }, 300_000)
})
