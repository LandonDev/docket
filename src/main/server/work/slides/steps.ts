import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ShowStep, SlideBuilds, StepHides } from '@shared/contract-work-slides'
import type { Converter, ConvertRun } from '../formats/jobs'
import { tailOf } from '../formats/tools'
import { nothingHidden } from './builds'
import { ONE_AT_A_TIME, RESIDENT_MOST, splitPdf, type SlideRenderer } from './pictures'
import { STEPS_PY } from './stepsScript'

/**
 * The pictures of a slide's builds (docs/agents/work-slides.md "Builds"): one a step, each drawn from a copy of
 * the deck in which what the step has not shown yet (or has taken away) is not seen: a shape taken out, a
 * paragraph's words and bullet made clear in their place (stepsScript.ts). They are kept with the slide's own
 * pictures, by a key of the slide's `draws`, the step and what it hides, so an edit to the slide (its timing
 * included) makes them again and an edit elsewhere does not. A step that hides nothing is the slide's own picture.
 */

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
/** Part of every step's key: a new step script makes the pictures again. */
let stepsV: string | null = null
const STEPS_V = (): string => (stepsV ??= sha(STEPS_PY).slice(0, 16))

export const stepKey = (draws: string, step: number, hides: StepHides): string => sha(`step:${STEPS_V()}:${draws}:${step}:${JSON.stringify(hides)}`)
const pageFile = (dir: string, key: string): string => join(dir, `${key}.pdf`)

/** What the steps need of a slide of the outline. */
export interface StepSlide {
  id: number
  draws?: string
  builds?: SlideBuilds
  shapes: ReadonlyArray<{ id: number; group?: number }>
}

/** The step copies a deck needs, one a step number: the slides with a picture still to make at that step, and their pages (from 1). */
export interface StepJob {
  step: number
  slides: Array<{ id: number; page: number; key: string; hides: StepHides }>
}

/** Every step picture not yet kept (`has`), by step number: one copy of the deck draws a step of every slide at once. */
export function stepJobs(slides: readonly StepSlide[], has: (key: string) => boolean): StepJob[] {
  const jobs = new Map<number, StepJob>()
  slides.forEach((s, i) => {
    if (!s.draws || !s.builds || s.builds.whole) return
    s.builds.steps.forEach((hides, step) => {
      if (nothingHidden(hides)) return
      const key = stepKey(s.draws!, step, hides)
      if (has(key)) return
      const job = jobs.get(step) ?? { step, slides: [] }
      job.slides.push({ id: s.id, page: i + 1, key, hides })
      jobs.set(step, job)
    })
  })
  return [...jobs.values()].sort((a, b) => a.step - b.step)
}

/** The step tool's plan for one copy: by slide id, its shapes to take out and its paragraphs to make clear. */
export type HidePlan = Record<string, { shapes: number[]; paras: Array<[number, number[]]> }>
export const hidePlan = (job: StepJob): HidePlan =>
  Object.fromEntries(
    job.slides.map((s) => [String(s.id), { shapes: s.hides.shapes, paras: s.hides.paras.map((p) => [p.shape, Array.from({ length: p.to - p.from + 1 }, (_, k) => p.from + k)] as [number, number[]]) }])
  )

export interface StepDeps {
  /** the deck's kept one-page pictures (pictures.ts): a step's goes beside its slide's */
  dir: string
  renderer: SlideRenderer | null
  /** writes a copy of the deck at `input` with the plan's things unseen (the `pptx → pptxsteps` converter) */
  hideCopy(input: string, plan: HidePlan, output: string, signal?: AbortSignal): Promise<void>
  /** the toolchain's own whole-deck export */
  whole(input: string, output: string, signal?: AbortSignal): Promise<void>
  log?: (line: string) => void
  /** told after each step number's pictures are kept */
  onMade?: () => void
}

/**
 * Makes every step picture the deck at `input` still lacks: for each step number a copy with that step's things
 * unseen, then its pages, one at a time by the LibreOffice kept running when there are few, else one export of the
 * copy split into pages. Answers how many pictures were made. Throws only when aborted; a step that fails is left
 * out (logged) and shown as the slide's own picture.
 */
export async function makeSteps(deps: StepDeps, input: string, slides: readonly StepSlide[], signal?: AbortSignal): Promise<number> {
  mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
  const renderer = deps.renderer && slides.length <= RESIDENT_MOST && deps.renderer.here?.() !== false ? deps.renderer : null
  let made = 0
  for (const job of stepJobs(slides, (key) => existsSync(pageFile(deps.dir, key)))) {
    signal?.throwIfAborted()
    const tag = randomUUID().slice(0, 8)
    const copy = join(deps.dir, `.step-${job.step}-${tag}.pptx`)
    const pdf = join(deps.dir, `.step-${job.step}-${tag}.pdf`)
    try {
      await deps.hideCopy(input, hidePlan(job), copy, signal)
      let one = renderer !== null && job.slides.length <= ONE_AT_A_TIME
      if (one) {
        try {
          for (const s of job.slides) {
            const tmp = `${pageFile(deps.dir, s.key)}.${tag}.tmp`
            try {
              await renderer!.slide(copy, s.page, tmp, signal)
              renameSync(tmp, pageFile(deps.dir, s.key))
            } finally {
              rmSync(tmp, { force: true })
            }
          }
        } catch (err) {
          if (signal?.aborted) throw err
          deps.log?.(`slides: a step drawn alone failed, drawing the whole copy: ${errText(err)}`)
          one = false
        }
      }
      if (!one) {
        let drawn = false
        if (renderer) {
          try {
            await renderer.deck(copy, pdf, signal)
            drawn = true
          } catch (err) {
            if (signal?.aborted) throw err
          }
        }
        if (!drawn) await deps.whole(copy, pdf, signal)
        const outs: Array<string | null> = slides.map(() => null)
        for (const s of job.slides) outs[s.page - 1] = pageFile(deps.dir, s.key)
        await splitPdf(pdf, outs)
      }
      made += job.slides.length
      deps.onMade?.()
    } catch (err) {
      if (signal?.aborted) throw err
      deps.log?.(`slides: the pictures of step ${job.step + 1} were not made: ${errText(err)}`)
    } finally {
      rmSync(copy, { force: true })
      rmSync(pdf, { force: true })
    }
  }
  return made
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Every shape a step leaves unseen, a hidden group's own shapes with it (so a video in it is not played over its place). */
function hiddenShapes(hides: StepHides, shapes: StepSlide['shapes']): number[] {
  const out = new Set(hides.shapes)
  for (const s of shapes) if (s.group !== undefined && out.has(s.group)) out.add(s.id)
  return [...out].sort((a, b) => a - b)
}

/** A slide's steps as a show reads them, each with its picture where one is kept; undefined for a slide of one press that hides nothing. */
export function showSteps(dir: string, s: StepSlide): ShowStep[] | undefined {
  const steps = s.builds && !s.builds.whole ? s.builds.steps : null
  if (!steps || (steps.length === 1 && nothingHidden(steps[0]))) return undefined
  return steps.map((hides, step) => {
    if (nothingHidden(hides) || !s.draws) return { hides: [] }
    const key = stepKey(s.draws, step, hides)
    try {
      return { hides: hiddenShapes(hides, s.shapes), pic: { rev: key.slice(0, 16), size: statSync(pageFile(dir, key)).size } }
    } catch {
      return { hides: hiddenShapes(hides, s.shapes) }
    }
  })
}

/** Where a step's picture is read from: its own, or the slide's when the step hides nothing. Null while it is not made. */
export function stepFile(dir: string, s: StepSlide, step: number): { path: string; rev: string } | null {
  const steps = s.builds && !s.builds.whole ? s.builds.steps : null
  const hides = steps?.[step]
  if (!s.draws || (!hides && step !== 0)) return null
  const key = !hides || nothingHidden(hides) ? s.draws : stepKey(s.draws, step, hides)
  const path = pageFile(dir, key)
  return existsSync(path) ? { path, rev: key.slice(0, 16) } : null
}

// ── the converters ───────────────────────────────────────────────────

const TIMEOUT_MS = 5 * 60_000
const slideId = z.number().int().positive()
// Options may come from another host's key: anything else is refused.
const HideOptions = z.object({
  plan: z.record(z.string().regex(/^\d+$/), z.object({ shapes: z.array(z.number().int().nonnegative()).max(2000), paras: z.array(z.tuple([z.number().int().nonnegative(), z.array(z.number().int().min(0)).max(5000)])).max(2000) }))
})
const MediaOptions = z.object({ slide: slideId, shape: z.number().int().nonnegative() })

async function runSteps(run: ConvertRun, args: string[]): Promise<void> {
  const py = run.tools.bin('python-pptx')
  if (!py) throw new Error('python-pptx is not installed here')
  const script = join(run.tmp, 'steps.py')
  writeFileSync(script, STEPS_PY)
  const r = await run.run(py, ['-I', script, ...args], { timeoutMs: TIMEOUT_MS, cwd: run.tmp })
  if (r.code !== 0) throw new Error(tailOf(r.out) || `the step tool stopped (exit ${r.code})`)
}

/** Containers and codecs the app's Chromium plays as they are (ffprobe's names). */
const PLAYS_CONTAINER = /^(mov,mp4,m4a,3gp,3g2,mj2|matroska,webm|ogg|mp3|wav|flac|aac)$/
const PLAYS_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora'])
const PLAYS_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8', 'pcm_alaw', 'pcm_mulaw'])

interface Probe {
  format?: { format_name?: string }
  streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string; disposition?: { attached_pic?: number } }>
}
/** Whether the app plays a file as it is, by what ffprobe found in it. A cover picture in a sound file is no video. */
export function playsAsIs(p: Probe): boolean {
  if (!PLAYS_CONTAINER.test(p.format?.format_name ?? '')) return false
  const streams = (p.streams ?? []).filter((s) => !s.disposition?.attached_pic)
  return streams.every((s) =>
    s.codec_type === 'video' ? PLAYS_VIDEO.has(s.codec_name ?? '') && (s.codec_name !== 'h264' || /^yuvj?420p$/.test(s.pix_fmt ?? '')) : s.codec_type === 'audio' ? PLAYS_AUDIO.has(s.codec_name ?? '') : true
  )
}

/** ffmpeg's line for an .mp4 the app plays: H.264 and AAC, or AAC alone for a sound. */
export function playArgs(input: string, output: string, video: boolean, threads: number): string[] {
  const head = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-threads', String(threads), '-i', input, '-map_metadata', '-1']
  const sound = ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k', '-ac', '2']
  if (!video) return [...head, '-vn', ...sound, '-movflags', '+faststart', '-f', 'mp4', output]
  return [...head, '-map', '0:v:0', ...sound, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', output]
}

export const STEPS_CONVERTERS: Converter[] = [
  {
    from: 'pptx',
    to: 'pptxsteps',
    needs: 'python-pptx',
    async run(job, run) {
      const parsed = HideOptions.safeParse(job.options ?? {})
      if (!parsed.success) throw new Error('the plan is not a list of steps')
      const plan = join(run.tmp, 'plan.json')
      writeFileSync(plan, JSON.stringify(parsed.data.plan))
      const out = join(run.tmp, 'out.pptx')
      await runSteps(run, ['hide', job.input, plan, out])
      copyFileSync(out, job.output)
      return {}
    }
  },
  {
    from: 'pptx',
    to: 'slidemedia',
    needs: 'python-pptx',
    async run(job, run) {
      const parsed = MediaOptions.safeParse(job.options ?? {})
      if (!parsed.success) throw new Error('name a slide and a shape')
      const out = join(run.tmp, 'media.bin')
      await runSteps(run, ['media', job.input, String(parsed.data.slide), String(parsed.data.shape), out])
      copyFileSync(out, job.output)
      return {}
    }
  },
  {
    // A video or a sound as the app can play it: the file itself when it can, else an .mp4 made once by ffmpeg.
    from: 'slidemedia',
    to: 'playable',
    needs: 'ffmpeg',
    threads: 2,
    async run(job, run) {
      const ffprobe = run.tools.bin('ffmpeg', 'ffprobe')
      const ffmpeg = run.tools.bin('ffmpeg')
      if (!ffprobe || !ffmpeg) throw new Error('ffmpeg is not installed here')
      const probed = await run.run(ffprobe, ['-v', 'error', '-show_entries', 'format=format_name:stream=codec_type,codec_name,pix_fmt:stream_disposition=attached_pic', '-of', 'json', job.input], { timeoutMs: 60_000 })
      if (probed.code !== 0) throw new Error(`ffprobe could not read it: ${tailOf(probed.out)}`)
      let probe: Probe
      try {
        probe = JSON.parse(probed.out.slice(probed.out.indexOf('{'))) as Probe
      } catch {
        throw new Error('ffprobe gave no answer')
      }
      if (playsAsIs(probe)) {
        copyFileSync(job.input, job.output)
        return {}
      }
      const video = (probe.streams ?? []).some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
      const out = join(run.tmp, 'out.mp4')
      const r = await run.run(ffmpeg, playArgs(job.input, out, video, run.threads), { timeoutMs: 60 * 60_000, gentle: true })
      if (r.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg could not make it playable: ${tailOf(r.out)}`)
      copyFileSync(out, job.output)
      return {}
    }
  }
]
