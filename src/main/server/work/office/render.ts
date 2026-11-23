import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Readiness } from '@shared/contract-work-formats'
import { NoConverterError, NotReadyError, pressed, type Converter } from '../formats/jobs'
import { OfficeError, type OfficeCarrier, type RenderApp, type RenderAsk, type RenderDone } from './carrier'

/**
 * Office as a renderer (docs/agents/work-office.md "Office as a renderer"): five converters the office pillar
 * registers with the conversion runner (`WorkModule.convert`), named as the structural pairs are. Word, Excel
 * and PowerPoint themselves draw a copy of the file, made in the job's own folder: never the file he has open.
 *
 * Where: his Mac (the apps he has open, by JXA), a Windows PC of his (the same, by tc-office.exe), or the box's
 * Windows VM (tc-office.exe behind the guest's door, which may start an app there hidden). A pair is offered by a
 * carrier only once its own live proof passed there (`RENDER_PROVEN`); until then that carrier answers `none`.
 * The VM is never woken for a render nobody pressed for: asleep, it answers `asleep`, and only a job carrying
 * his press (`pressed`, formats/jobs.ts) wakes it.
 */

export interface RenderPair {
  from: string
  to: string
  app: RenderApp
  out: RenderAsk['to']
}

export const RENDER_PAIRS: readonly RenderPair[] = [
  { from: 'docx', to: 'pdf+word', app: 'word', out: 'pdf' },
  { from: 'xlsx', to: 'pdf+excel', app: 'excel', out: 'pdf' },
  { from: 'pptx', to: 'pdf+powerpoint', app: 'powerpoint', out: 'pdf' },
  { from: 'pptx', to: 'png+powerpoint', app: 'powerpoint', out: 'png' },
  { from: 'pptx', to: 'mp4+powerpoint', app: 'powerpoint', out: 'mp4' }
]

export const pairName = (p: Pick<RenderPair, 'from' | 'to'>): string => `${p.from}→${p.to}`

/** Who renders on a host: his Mac, a Windows PC of his, or the box's Windows VM. */
export type RenderPlace = 'mac' | 'windows' | 'vm'

/**
 * The pairs each carrier offers: only those whose live proof passed on that carrier (the landing note,
 * .temp-code/plans/landed/SLD2.md, has each proof). A recording of COM proves nothing about the Mac, and a VM's
 * proof is not a Windows PC's. Add a pair here only with its proof.
 */
export const RENDER_PROVEN: Record<RenderPlace, ReadonlySet<string>> = {
  mac: new Set<string>(),
  windows: new Set<string>(),
  // proven 2026-11-23 in the standing VM (Microsoft 365 Apps, 16.0): the landing note's numbers
  vm: new Set<string>(['docx→pdf+word', 'xlsx→pdf+excel', 'pptx→pdf+powerpoint', 'pptx→png+powerpoint', 'pptx→mp4+powerpoint'])
}

const SHORT: Record<RenderApp, string> = { word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint' }
const WHERE: Record<RenderPlace, string> = { mac: 'this Mac', windows: 'this PC', vm: 'the Windows VM' }

/** Each refusal in the words a person reads; the landing note lists them for the documents and sheets builds. */
export const RENDER_WORDS = {
  notOpen: (app: RenderApp, place: RenderPlace) => `${SHORT[app]} is not open on ${WHERE[place]}.`,
  asleep: () => 'Windows is asleep, and only his own press wakes it.',
  busy: (app: RenderApp) => `${SHORT[app]} is busy with a dialog: try again once it is closed.`,
  none: (app: RenderApp) => `No ${SHORT[app]} is in reach.`
}

/** The switches each pair takes; anything else is ignored, and a wrong value is refused in words. */
const PngOptions = z.object({
  slide: z.number({ error: 'slide is a slide number, from 1' }).int('slide is a whole number').min(1, 'slide is from 1').max(100_000).default(1),
  width: z.number({ error: 'width is a number of pixels' }).int('width is a whole number').min(16, 'width is at least 16 pixels').max(8192, 'width is at most 8192 pixels').default(1920)
})
const Mp4Options = z.object({
  secondsPerSlide: z.number({ error: 'secondsPerSlide is a number of seconds' }).int('secondsPerSlide is a whole number').min(1, 'secondsPerSlide is at least 1').max(600, 'secondsPerSlide is at most 600').default(5),
  height: z.union([z.literal(480), z.literal(720), z.literal(1080), z.literal(2160)], { error: 'height is 480, 720, 1080 or 2160' }).default(720)
})

export function renderOptions(pair: RenderPair, options: Record<string, unknown> | undefined): Pick<RenderAsk, 'slide' | 'width' | 'seconds' | 'height'> {
  if (pair.out === 'pdf') return {}
  const parsed = (pair.out === 'png' ? PngOptions : Mp4Options).safeParse(options ?? {})
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '))
  const d = parsed.data as { slide?: number; width?: number; secondsPerSlide?: number; height?: number }
  return pair.out === 'png' ? { slide: d.slide, width: d.width } : { seconds: d.secondsPerSlide, height: d.height }
}

/** What the converters need of the host: where Office is, its carrier, and the VM's state. */
export interface RenderDeps {
  /** which carrier renders on this host now; null where none can (Work off, a Linux host with no VM) */
  place(): RenderPlace | null
  carrier(place: RenderPlace): OfficeCarrier | null
  /** the VM's state as its keeper says it, and Office in it as last read (never wakes it) */
  vm?: {
    state(): { state: string; cannot: string | null } | null
    office(): { installed: boolean; licensed: boolean | null } | null
    /** wakes it and makes the helper ready: only for a job he pressed for */
    wake(): Promise<void>
  }
  proven?: Record<RenderPlace, ReadonlySet<string>>
  log?: (line: string) => void
}

/** The VM's state as a render sees it: awake, asleep (a press wakes it), or not there to render. */
function vmReadiness(deps: RenderDeps): Readiness {
  const s = deps.vm?.state()
  if (!s || s.cannot || s.state === 'none' || s.state === 'setting-up') return 'none'
  const office = deps.vm?.office()
  // An Office never read, not there, or with no licence (it opens files to view only) renders nothing.
  if (!office?.installed || office.licensed === false) return 'none'
  return s.state === 'awake' ? 'ready' : 'asleep'
}

/** Whether a pair can render here now, as DOC1.1's `ready` asks it. Never wakes anything, never starts an app. */
export async function renderReadiness(pair: RenderPair, deps: RenderDeps): Promise<Readiness> {
  const place = deps.place()
  if (!place || !(deps.proven ?? RENDER_PROVEN)[place].has(pairName(pair))) return 'none'
  if (place === 'vm') return vmReadiness(deps)
  const carrier = deps.carrier(place)
  if (!carrier?.render) return 'none'
  const app = (await carrier.apps()).find((a) => a.app === pair.app)
  if (!app?.installed) return 'none'
  // His own Mac or PC: only an app he has open, never one started unseen.
  return app.running ? 'ready' : 'not open'
}

/** A carrier's refusal as the runner's kinds, in a person's words: shut is `not open`, missing is `none`, a dialog is busy. */
function refusal(err: unknown, pair: RenderPair, place: RenderPlace): unknown {
  if (!(err instanceof OfficeError)) return err
  if (err.code === 'not-running') return new NotReadyError('not open', RENDER_WORDS.notOpen(pair.app, place))
  if (err.code === 'not-installed') return new NoConverterError(`${RENDER_WORDS.none(pair.app)} ${err.message}`)
  if (err.code === 'busy' || /did not answer .* within/.test(err.message)) return new OfficeError(RENDER_WORDS.busy(pair.app), 'busy')
  return err
}

/** One pair's converter: ready by its carrier's state, run on a copy in the job's own folder. */
export function renderConverter(pair: RenderPair, deps: RenderDeps): Converter {
  return {
    from: pair.from,
    to: pair.to,
    ready: () => renderReadiness(pair, deps),
    async run(job, run) {
      const place = deps.place()
      if (!place || !(deps.proven ?? RENDER_PROVEN)[place].has(pairName(pair))) throw new NoConverterError(RENDER_WORDS.none(pair.app))
      const options = renderOptions(pair, job.options)
      if (place === 'vm') {
        const state = vmReadiness(deps)
        if (state === 'none') throw new NoConverterError(RENDER_WORDS.none(pair.app))
        // Asleep: only his own press wakes it. A press is this host's own object (formats/jobs.ts), never a JSON flag.
        if (state === 'asleep') {
          if (!pressed(job)) throw new NotReadyError('asleep', RENDER_WORDS.asleep())
          await deps.vm!.wake()
        }
      }
      const carrier = deps.carrier(place)
      if (!carrier?.render) throw new NoConverterError(RENDER_WORDS.none(pair.app))
      // A copy in the job's own folder: the app opens this, read only, never the file he has open.
      const input = join(run.tmp, `input.${pair.from}`)
      copyFileSync(job.input, input)
      let done: RenderDone
      try {
        done = await carrier.render({ app: pair.app, to: pair.out, input, output: job.output, start: place === 'vm', signal: run.signal, ...options })
      } catch (err) {
        throw refusal(err, pair, place)
      }
      deps.log?.(`office rendered ${pairName(pair)} on ${WHERE[place]}: ${JSON.stringify(done)}`)
      return {}
    }
  }
}

/** The five converters, for the office module's `convert`. */
export const officeConverters = (deps: RenderDeps): Converter[] => RENDER_PAIRS.map((p) => renderConverter(p, deps))

