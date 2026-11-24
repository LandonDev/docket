import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SlideBuilds } from '@shared/contract-work-slides'
import { ONE_AT_A_TIME, type SlideRenderer } from './pictures'
import { hidePlan, makeSteps, playArgs, playsAsIs, showSteps, stepFile, stepJobs, stepKey, type StepDeps, type StepSlide } from './steps'

/**
 * The pictures of a slide's builds: which are made, from which copy, how, and where a show reads each. The "deck"
 * is a text file of one line a slide; a copy with a plan appends the plan, and a page is a PDF page as wide as its
 * slide's line number plus a thousand for each copy, so a test reads which slide and which copy a picture is.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-slides-steps-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const draws = (n: number): string => n.toString(16).padStart(64, '0')
const none = { shapes: [], paras: [] }
const builds = (...steps: SlideBuilds['steps']): SlideBuilds => ({ steps, changed: 0 })
/** Slide 2 builds three bullets one a press, slide 3 a shape that leaves; slides 1 and 4 have none. */
const deck: StepSlide[] = [
  { id: 256, draws: draws(1), shapes: [] },
  { id: 257, draws: draws(2), shapes: [{ id: 3 }], builds: builds({ shapes: [], paras: [{ shape: 3, from: 0, to: 2 }] }, { shapes: [], paras: [{ shape: 3, from: 1, to: 2 }] }, { shapes: [], paras: [{ shape: 3, from: 2, to: 2 }] }, none) },
  { id: 258, draws: draws(3), shapes: [{ id: 4 }, { id: 5, group: 9 }], builds: builds(none, { shapes: [9], paras: [] }) },
  { id: 259, draws: draws(4), shapes: [] }
]

async function pdfOf(widths: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const w of widths) doc.addPage([w, 100])
  return doc.save()
}
const widthOf = async (path: string): Promise<number> => (await PDFDocument.load(readFileSync(path))).getPage(0).getWidth()

function rig(over: Partial<SlideRenderer> | null = {}) {
  const calls: string[] = []
  const lines = (input: string): number[] => {
    const [body, plan] = readFileSync(input, 'utf8').split('#')
    return body.split('\n').map((n) => Number(n) + (plan ? 1000 : 0))
  }
  const renderer: SlideRenderer | null =
    over === null
      ? null
      : {
          slide: async (input, page, output) => {
            calls.push(`slide ${page}`)
            const pages = lines(input)
            writeFileSync(output, await pdfOf([pages[page - 1]]))
            return pages.length
          },
          deck: async (input, output) => {
            calls.push('deck')
            writeFileSync(output, await pdfOf(lines(input)))
          },
          ...over
        }
  const deps: StepDeps = {
    dir: join(dir, 'pages'),
    renderer,
    hideCopy: async (input, plan, output) => {
      calls.push(`copy ${JSON.stringify(plan)}`)
      writeFileSync(output, `${readFileSync(input, 'utf8')}#${JSON.stringify(plan)}`)
    },
    whole: async (input, output) => {
      calls.push('whole')
      writeFileSync(output, await pdfOf(lines(input)))
    },
    log: (line) => void calls.push(`log ${line}`),
    onMade: () => void calls.push('made')
  }
  const input = join(dir, 'deck.txt')
  writeFileSync(input, '1\n2\n3\n4')
  return { deps, calls, input }
}

describe('the pictures of the steps', () => {
  it('plans one copy a step number, leaving out a step that hides nothing (its picture is the slide\'s own)', () => {
    const jobs = stepJobs(deck, () => false)
    expect(jobs.map((j) => [j.step, j.slides.map((s) => [s.id, s.page])])).toEqual([
      [0, [[257, 2]]],
      [1, [[257, 2], [258, 3]]],
      [2, [[257, 2]]]
    ])
    expect(hidePlan(jobs[1])).toEqual({ '257': { shapes: [], paras: [[3, [1, 2]]] }, '258': { shapes: [9], paras: [] } })
    // a picture kept is not made again; a slide shown whole has none to make
    expect(stepJobs(deck, (key) => key === stepKey(draws(2), 0, deck[1].builds!.steps[0])).map((j) => j.step)).toEqual([1, 2])
    expect(stepJobs([{ ...deck[1], builds: { ...deck[1].builds!, whole: 'a trigger' } }], () => false)).toEqual([])
  })

  it('keys a step by its slide\'s picture, the step and what it hides', () => {
    const h = deck[1].builds!.steps[0]
    expect(stepKey(draws(2), 0, h)).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set([stepKey(draws(2), 0, h), stepKey(draws(5), 0, h), stepKey(draws(2), 1, h), stepKey(draws(2), 0, none)]).size).toBe(4)
  })

  it('draws a few pages of each copy one at a time, kept beside the slides\' own pictures, and says so after each copy', async () => {
    const { deps, calls, input } = rig()
    expect(await makeSteps(deps, input, deck)).toBe(4)
    expect(calls.filter((c) => !c.startsWith('copy'))).toEqual(['slide 2', 'made', 'slide 2', 'slide 3', 'made', 'slide 2', 'made'])
    const pic = (slide: number, step: number): string => join(deps.dir, `${stepKey(draws(slide + 1), step, deck[slide].builds!.steps[step])}.pdf`)
    expect(await widthOf(pic(1, 0))).toBe(1002)
    expect(await widthOf(pic(2, 1))).toBe(1003)
    // nothing half made is left, and a second pass makes nothing
    expect(readdirSync(deps.dir).filter((f) => !/^[0-9a-f]{64}\.pdf$/.test(f))).toEqual([])
    calls.length = 0
    expect(await makeSteps(deps, input, deck)).toBe(0)
    expect(calls).toEqual([])
  })

  it('exports a copy whole when it has more pages to draw than are drawn one at a time', async () => {
    const { deps, calls, input } = rig()
    const many: StepSlide[] = Array.from({ length: ONE_AT_A_TIME + 1 }, (_, i) => ({ id: 300 + i, draws: draws(10 + i), shapes: [{ id: 3 }], builds: builds({ shapes: [3], paras: [] }, none) }))
    writeFileSync(input, many.map((_, i) => i + 1).join('\n'))
    expect(await makeSteps(deps, input, many)).toBe(ONE_AT_A_TIME + 1)
    expect(calls.filter((c) => !c.startsWith('copy'))).toEqual(['deck', 'made'])
  })

  it('falls back to the toolchain\'s export when the LibreOffice kept running fails, and leaves out a copy that cannot be made', async () => {
    const failing = rig({
      slide: async () => {
        throw new Error('no answer')
      },
      deck: async () => {
        throw new Error('no answer')
      }
    })
    expect(await makeSteps(failing.deps, failing.input, deck)).toBe(4)
    expect(failing.calls.filter((c) => c === 'whole')).toHaveLength(3)
    const broken = rig(null)
    broken.deps.dir = join(dir, 'other')
    broken.deps.hideCopy = async () => {
      throw new Error('the deck could not be read')
    }
    expect(await makeSteps(broken.deps, broken.input, deck)).toBe(0)
    expect(broken.calls.filter((c) => c.startsWith('log'))).toHaveLength(3)
  })

  it('stops when aborted', async () => {
    const { deps, input } = rig()
    const stop = new AbortController()
    stop.abort()
    await expect(makeSteps(deps, input, deck, stop.signal)).rejects.toThrow()
  })

  it('tells a show where each step is read from: its own picture once made, the slide\'s page where it hides nothing, and why one has none yet', async () => {
    const { deps, input } = rig()
    expect(showSteps(deps.dir, deck[0])).toBeUndefined()
    // Not made yet: the show holds the picture before it, never the slide whole.
    expect(showSteps(deps.dir, deck[1])).toEqual([{ hides: [], missing: 'making' }, { hides: [], missing: 'making' }, { hides: [], missing: 'making' }, { hides: [] }])
    expect(showSteps(deps.dir, deck[2])).toEqual([{ hides: [] }, { hides: [5, 9], missing: 'making' }])
    // The job ended without it: it could not be made.
    expect(showSteps(deps.dir, deck[2], false)).toEqual([{ hides: [] }, { hides: [5, 9], missing: 'failed' }])
    await makeSteps(deps, input, deck)
    const [s0, , , last] = showSteps(deps.dir, deck[1])!
    expect(s0.pic?.rev).toBe(stepKey(draws(2), 0, deck[1].builds!.steps[0]).slice(0, 16))
    expect(last).toEqual({ hides: [] })
    expect(stepFile(deps.dir, deck[1], 0)?.rev).toBe(s0.pic?.rev)
    // the last step hides nothing: the slide's own picture, once the deck's pages are kept
    expect(stepFile(deps.dir, deck[1], 3)).toBeNull()
    writeFileSync(join(deps.dir, `${draws(2)}.pdf`), await pdfOf([2]))
    expect(stepFile(deps.dir, deck[1], 3)).toEqual({ path: join(deps.dir, `${draws(2)}.pdf`), rev: draws(2).slice(0, 16) })
    expect(existsSync(join(deps.dir, `${draws(2)}.pdf`))).toBe(true)
  })
})

describe('a slide\'s video and sound, as the app plays them', () => {
  const probe = (format: string, ...streams: Array<{ codec_type: string; codec_name: string; pix_fmt?: string; attached?: boolean }>) => ({
    format: { format_name: format },
    streams: streams.map((s) => ({ ...s, ...(s.attached ? { disposition: { attached_pic: 1 } } : {}) }))
  })
  it('plays H.264 and AAC in an .mp4, VP9 in WebM, a WAV and an MP3 with its cover as they are', () => {
    expect(playsAsIs(probe('mov,mp4,m4a,3gp,3g2,mj2', { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }, { codec_type: 'audio', codec_name: 'aac' }))).toBe(true)
    expect(playsAsIs(probe('matroska,webm', { codec_type: 'video', codec_name: 'vp9' }, { codec_type: 'audio', codec_name: 'opus' }))).toBe(true)
    expect(playsAsIs(probe('wav', { codec_type: 'audio', codec_name: 'pcm_s16le' }))).toBe(true)
    expect(playsAsIs(probe('mp3', { codec_type: 'audio', codec_name: 'mp3' }, { codec_type: 'video', codec_name: 'mjpeg', attached: true }))).toBe(true)
  })
  it('makes an .mp4 of a WMV, an AVI, ProRes, H.264 in 4:2:2 and a WMA', () => {
    expect(playsAsIs(probe('asf', { codec_type: 'video', codec_name: 'wmv2' }))).toBe(false)
    expect(playsAsIs(probe('avi', { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }))).toBe(false)
    expect(playsAsIs(probe('mov,mp4,m4a,3gp,3g2,mj2', { codec_type: 'video', codec_name: 'prores' }))).toBe(false)
    expect(playsAsIs(probe('mov,mp4,m4a,3gp,3g2,mj2', { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv422p' }))).toBe(false)
    expect(playsAsIs(probe('asf', { codec_type: 'audio', codec_name: 'wmav2' }))).toBe(false)
    const video = playArgs('in.wmv', 'out.mp4', true, 2)
    expect(video).toEqual(expect.arrayContaining(['libx264', 'yuv420p', 'aac', '+faststart']))
    expect(playArgs('in.wma', 'out.mp4', false, 2)).toContain('-vn')
  })
})
