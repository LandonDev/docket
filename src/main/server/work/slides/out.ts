import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import type { DeckFacts, DeckOut, DeckOutAsk, DeckReach } from '@shared/contract-work-slides'
import type { CanvasItem } from '@shared/work'
import { pressOf, runnerOf } from '../formats/jobs'
import { printToPdf } from '../formats/print'
import type { Caller } from '../modules'
import { ItemFileError } from '../pdf/file'
import type { DeckInfo } from './deck'
import { PAPER_SIZES, paperHtml, sheetsOf, type PaperSetup } from './handouts'
import type { PendingOp } from './store'
import { mp4Seconds, readJoined, videoSeconds, type PicsOptions } from './video'
import { deckDir, drawAhead, nameOf, othersOpen, RENDER_FILTER, serial, sharedJob, withDeck, type Ctx } from './view'
import { pressesFor } from '../files/policy'

/**
 * A deck as each format of Preview holds it (docs/agents/work-slides.md "Preview and export"): the file itself,
 * a PDF of slides, notes pages or handouts, pictures, a video of the slides, an OpenDocument copy; and PowerPoint's
 * own PDF or video on his press. Each is made from a copy of the file taken on the deck's queue, so a save
 * meanwhile never mixes two revisions, and the making runs off the queue, so an edit never waits on a video.
 *
 * What is made is kept in the deck's `out` folder by a rev that names the file's revision and everything he
 * picked: asked again, it is answered at once; read by range at that rev. The folder is the deck's own
 * (`deckDir`): for a file others can open, the item's, which goes with the item, and every job of such a deck is
 * marked shared, so it is converted on this host and nowhere else.
 */

/** Bumped when a format's making changes: every kept file is then made again. */
const OUT_V = '1'
/** How many made files a deck keeps, newest first. */
const KEPT = 6
/** The width the slides are drawn at for notes pages and handouts: about 240 dots an inch across a notes page. */
const PAPER_PICTURE = 1600
const THUMB = 320
const POSTER = 640
/** The crossfade between two slides of a video, in seconds (decision 8). */
export const FADE = 0.5
const FPS = 30

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const NO_PICTURE = 'There is no picture of the slides to make this from.'

/** An ask with its defaults filled and only what its format uses: equal asks name one file. */
export function planOf(ask: DeckOutAsk): DeckOutAsk {
  const hidden = ask.hidden ?? false
  switch (ask.format) {
    case 'pptx':
      return { format: 'pptx', ...(ask.office ? { office: true } : {}) }
    case 'odp':
      return { format: 'odp' }
    case 'pdf':
    case 'print': {
      const layout = ask.layout ?? 'slides'
      return { format: ask.format, layout, hidden, ...(layout === 'slides' ? {} : { page: ask.page ?? DEFAULT_PAGE }) }
    }
    case 'pics':
      return { format: 'pics', hidden, picture: ask.picture ?? { type: 'png', width: 1920 } }
    case 'video':
      return { format: 'video', hidden, video: { seconds: ask.video?.seconds ?? 5, height: ask.video?.height ?? 1080, by: ask.video?.by ?? 'tempcode' } }
  }
}

export const DEFAULT_PAGE: NonNullable<DeckOutAsk['page']> = { paper: 'Letter', orientation: 'portrait', margins: { top: 36, right: 36, bottom: 36, left: 36 }, header: false, footer: true }

export const outRev = (renderKey: string, plan: DeckOutAsk): string => sha(`${OUT_V}\n${renderKey}\n${JSON.stringify(plan)}`).slice(0, 32)

/** What the deck holds that a format may drop. */
export function factsOf(info: DeckInfo, pending: readonly PendingOp[]): DeckFacts {
  const media = info.slides.flatMap((s) => s.shapes.filter((sh) => sh.kind === 'media'))
  return {
    slides: info.slides.length,
    hidden: info.slides.filter((s) => s.hidden).length,
    notes: info.slides.filter((s) => s.notes.trim()).length,
    animated: info.slides.filter((s) => s.builds && (s.builds.steps.length > 1 || s.builds.changed > 0 || s.builds.whole)).length,
    transitions: info.slides.filter((s) => s.transition && s.transition.kind !== 'none' && s.transition.kind !== 'cut').length,
    videos: media.filter((m) => m.media !== 'audio').length,
    sounds: media.filter((m) => m.media === 'audio').length,
    pending: new Set(pending.map((p) => p.slide)).size
  }
}

/** The pages a format of slides prints: every slide's, or the shown ones'. */
export const pagesOf = (info: DeckInfo, hidden: boolean): number[] => info.slides.flatMap((s, i) => (hidden || !s.hidden ? [i + 1] : []))

/** A file's stem as he saves it: the deck's name with no extension. */
const stemOf = (name: string): string => name.replace(/\.(pptx|ppt|odp|key)$/i, '') || 'Slides'

/** The paper a set-up names, turned as it says. */
export function paperOf(page: NonNullable<DeckOutAsk['page']>): PaperSetup {
  const size = PAPER_SIZES[page.paper]
  const [width, height] = page.orientation === 'landscape' ? [size.height, size.width] : [size.width, size.height]
  return { width, height, margins: page.margins, header: page.header, footer: page.footer }
}

// ── kept files ───────────────────────────────────────────────────────

const EXTS = ['pptx', 'pdf', 'zip', 'mp4', 'odp', 'json']

function keptOut(dir: string, rev: string): DeckOut | null {
  try {
    const out = JSON.parse(readFileSync(join(dir, `${rev}.json`), 'utf8')) as DeckOut
    for (const r of [out.file.rev, out.pdf?.rev]) if (r && !readdirSync(dir).some((f) => f.startsWith(r) && !f.endsWith('.json'))) return null
    return out
  } catch {
    return null
  }
}

/** Keeps the newest `KEPT` answers and the files they name; anything else in the folder that is not being made goes. */
function prune(dir: string): void {
  const answers = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  const keep = new Set<string>()
  for (const { f } of answers.slice(0, KEPT)) {
    keep.add(f)
    try {
      const out = JSON.parse(readFileSync(join(dir, f), 'utf8')) as DeckOut
      for (const r of [out.file.rev, out.pdf?.rev]) if (r) for (const g of readdirSync(dir)) if (g.startsWith(r)) keep.add(g)
    } catch {
      keep.delete(f)
    }
  }
  for (const f of readdirSync(dir)) if (!f.startsWith('.') && !keep.has(f)) rmSync(join(dir, f), { force: true })
}

/** A made file, moved into the folder under its rev. */
function land(dir: string, from: string, rev: string, ext: string): { rev: string; size: number } {
  const to = join(dir, `${rev}.${ext}`)
  renameSync(from, to)
  return { rev, size: statSync(to).size }
}

/** The bytes of a kept file, by its rev (`work.slides.previewRead`). */
export async function outPath(ctx: Ctx, item: CanvasItem, rev: string): Promise<string> {
  const dir = await deckDir(ctx, item, 'out')
  const name = readdirSync(dir).find((f) => f.startsWith(`${rev}.`) && EXTS.includes(f.slice(rev.length + 1)) && !f.endsWith('.json'))
  if (!name) throw new ItemFileError('That file is gone: draw it again.', 'missing')
  return join(dir, name)
}

// ── making ───────────────────────────────────────────────────────────

/** One making a deck folder and rev: a second ask meanwhile waits for the same file. */
const making = new Map<string, Promise<DeckOut>>()

interface Snapshot {
  info: DeckInfo
  name: string
  facts: DeckFacts
  /** a copy of the file as it was hashed, and of its picture */
  pptx: string
  pdf: string | null
}

/**
 * The deck as `plan`'s format holds it: kept, or made now. On a deck others can open, a caller that is not his press
 * is not told how many slides waiting suggestions change (`pending`): what waits there is his press's to see.
 */
export async function deckOut(ctx: Ctx, item: CanvasItem, by: Caller, ask: DeckOutAsk, signal?: AbortSignal): Promise<DeckOut> {
  const out = await deckOutFor(ctx, item, by, ask, signal)
  return !pressesFor(by) && othersOpen(ctx, item) ? { ...out, facts: { ...out.facts, pending: 0 } } : out
}

async function deckOutFor(ctx: Ctx, item: CanvasItem, by: Caller, ask: DeckOutAsk, signal?: AbortSignal): Promise<DeckOut> {
  const plan = planOf(ask)
  await drawAhead(ctx, item, signal)
  const dir = await deckDir(ctx, item, 'out')
  const work = join(dir, `.work-${randomUUID()}`)
  try {
    const got = await serial(ctx, item, () =>
      withDeck(ctx, item, signal, async (deck): Promise<{ kept: DeckOut; rev: string } | { snap: Snapshot; rev: string }> => {
        const rev = outRev(deck.file.key, plan)
        const kept = keptOut(dir, rev)
        if (kept) return { kept, rev }
        mkdirSync(work, { recursive: true, mode: 0o700 })
        const pptx = join(work, 'deck.pptx')
        copyFileSync(deck.copy, pptx)
        let pdf: string | null = null
        if (deck.file.pdf) copyFileSync(deck.file.pdf, (pdf = join(work, 'deck.pdf')))
        return { rev, snap: { info: deck.file.info, name: nameOf(item, deck.path), facts: factsOf(deck.file.info, deck.pending), pptx, pdf } }
      })
    )
    if ('kept' in got) return got.kept
    const key = `${dir}\n${got.rev}`
    let run = making.get(key)
    if (!run) {
      run = make(ctx, item, by, plan, got.rev, got.snap, dir, work, signal).finally(() => making.delete(key))
      making.set(key, run)
    }
    return await run
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function make(ctx: Ctx, item: CanvasItem, by: Caller, plan: DeckOutAsk, rev: string, snap: Snapshot, dir: string, work: string, signal?: AbortSignal): Promise<DeckOut> {
  const job = { ...sharedJob(ctx, item), ...(signal ? { signal } : {}) }
  // His press, for PowerPoint's own picture or video: never a thread's, never another host's (formats/jobs.ts).
  const press = pressOf(by)
  const pressed = press ? { pressed: press } : {}
  const stem = stemOf(snap.name)
  const at = (name: string): string => join(work, name)
  const needPdf = (): string => {
    if (!snap.pdf) throw new ItemFileError(NO_PICTURE, 'not-here')
    return snap.pdf
  }
  const pages = pagesOf(snap.info, plan.hidden ?? false)
  if (plan.format !== 'pptx' && plan.format !== 'odp' && pages.length === 0) throw new Error('Every slide is hidden: turn on Hidden slides to include them.')
  const pics = async (options: PicsOptions, name: string): Promise<string> => {
    const output = at(name)
    await ctx.convert({ from: 'pdf', to: 'slidepics', input: needPdf(), output, options, ...job })
    return output
  }
  const dataUrls = (path: string): string[] => readJoined(path).map((b) => `data:image/jpeg;base64,${b.toString('base64')}`)
  const aspect = snap.info.width > 0 && snap.info.height > 0 ? snap.info.width / snap.info.height : 16 / 9
  let out: Omit<DeckOut, 'facts'>

  switch (plan.format) {
    case 'pptx': {
      let picture = needPdf()
      if (plan.office) {
        picture = at('powerpoint.pdf')
        await ctx.convert({ from: 'pptx', to: 'pdf+powerpoint', input: snap.pptx, output: picture, ...pressed, ...job })
      }
      const pdfPages = await pageCount(picture)
      const pdf = land(dir, picture, sha(`${rev}:pdf`).slice(0, 32), 'pdf')
      out = { file: { ...land(dir, snap.pptx, rev, 'pptx'), name: snap.name.toLowerCase().endsWith('.pptx') ? snap.name : `${stem}.pptx` }, pdf: { ...pdf, pages: pdfPages }, drawnBy: plan.office ? 'powerpoint' : 'libreoffice' }
      break
    }
    case 'odp': {
      const odp = at('deck.odp')
      const picture = at('odp.pdf')
      await ctx.convert({ from: 'pptx', to: 'odp', input: snap.pptx, output: odp, ...job })
      // Drawn from the OpenDocument file itself: what LibreOffice kept in it, not the deck's own picture.
      await ctx.convert({ from: 'odp', to: 'pdf', input: odp, output: picture, options: { filter: RENDER_FILTER }, ...job })
      const n = await pageCount(picture)
      out = { file: { ...land(dir, odp, rev, 'odp'), name: `${stem}.odp` }, pdf: { ...land(dir, picture, sha(`${rev}:pdf`).slice(0, 32), 'pdf'), pages: n }, drawnBy: 'libreoffice' }
      break
    }
    case 'pdf':
    case 'print': {
      const file = at('out.pdf')
      const layout = plan.layout ?? 'slides'
      if (layout === 'slides') await keepPages(needPdf(), pages, file)
      else {
        const paper = paperOf(plan.page ?? DEFAULT_PAGE)
        const shown = pages.map((p) => snap.info.slides[p - 1]!)
        const pictures = dataUrls(await pics({ pages, width: PAPER_PICTURE, type: 'jpeg', quality: 88, pack: 'join' }, 'paper.bin'))
        const html = paperHtml({ sheets: sheetsOf(layout, pages.length, paper, aspect), paper, pictures, notes: shown.map((s) => s.notes), title: stem })
        const printed = await printToPdf(html, { paper: plan.page?.paper === 'A4' ? 'A4' : 'Letter', dir: work })
        signal?.throwIfAborted()
        writeFileSync(file, printed.pdf)
      }
      const n = await pageCount(file)
      const made = land(dir, file, rev, 'pdf')
      out = { file: { ...made, name: `${stem}.pdf` }, pdf: { ...made, pages: n }, drawnBy: 'tempcode' }
      break
    }
    case 'pics': {
      const picture = plan.picture!
      const ext = picture.type === 'jpeg' ? 'jpg' : 'png'
      const digits = String(snap.info.slides.length).length
      const names = pages.map((p) => `Slide ${String(p).padStart(digits, '0')}.${ext}`)
      const zip = await pics({ pages, width: picture.width, height: even(picture.width / aspect), type: picture.type, pack: 'zip', names }, 'pictures.zip')
      const thumbs = dataUrls(await pics({ pages, width: THUMB, type: 'jpeg', quality: 80, pack: 'join' }, 'thumbs.bin'))
      out = { file: { ...land(dir, zip, rev, 'zip'), name: `${stem}.zip` }, thumbs: names.map((name, i) => ({ name, thumb: thumbs[i] ?? '' })), drawnBy: 'tempcode' }
      break
    }
    case 'video': {
      const v = plan.video!
      const mp4 = at('video.mp4')
      const poster = dataUrls(await pics({ pages: [pages[0]!], width: POSTER, type: 'jpeg', quality: 85, pack: 'join' }, 'poster.bin'))[0] ?? ''
      if (v.by === 'powerpoint') await ctx.convert({ from: 'pptx', to: 'mp4+powerpoint', input: snap.pptx, output: mp4, options: { secondsPerSlide: v.seconds, height: v.height }, ...pressed, ...job })
      else {
        const frames = await pics({ pages, width: even(v.height * aspect), height: v.height, type: 'png', pack: 'join' }, 'frames.bin')
        await ctx.convert({ from: 'slidepics', to: 'slidevideo', input: frames, output: mp4, options: { seconds: v.seconds, fade: FADE, fps: FPS }, ...job })
      }
      const seconds = mp4Seconds(mp4) ?? videoSeconds(pages.length, v.seconds)
      out = { file: { ...land(dir, mp4, rev, 'mp4'), name: `${stem}.mp4` }, video: { seconds, poster, height: v.height }, drawnBy: v.by === 'powerpoint' ? 'powerpoint' : 'tempcode' }
      break
    }
  }
  const answer: DeckOut = { ...out, facts: snap.facts }
  // The answer last: a file with its answer is a whole one.
  const tmp = join(work, 'answer.json')
  writeFileSync(tmp, JSON.stringify(answer))
  renameSync(tmp, join(dir, `${rev}.json`))
  prune(dir)
  return answer
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

async function pageCount(path: string): Promise<number> {
  const doc = await PDFDocument.load(readFileSync(path), { ignoreEncryption: true, updateMetadata: false })
  return doc.getPageCount()
}

/** The PDF's `pages` (from 1) as a PDF of their own: the deck's picture with its hidden slides left out. */
export async function keepPages(input: string, pages: readonly number[], output: string): Promise<void> {
  const src = await PDFDocument.load(readFileSync(input), { updateMetadata: false })
  if (pages.length === src.getPageCount() && pages.every((p, i) => p === i + 1)) return copyFileSync(input, output)
  const doc = await PDFDocument.create({ updateMetadata: false })
  for (const page of await doc.copyPages(src, pages.map((p) => p - 1))) doc.addPage(page)
  writeFileSync(output, await doc.save({ useObjectStreams: true }))
}

/** Whether PowerPoint draws this deck from this host: its PDF, and its video. */
export async function deckReach(ctx: Ctx): Promise<DeckReach> {
  const runner = runnerOf(ctx)
  if (!runner) return { pdf: 'none', video: 'none' }
  const pairs = await (await runner).pairs()
  const state = (to: string): DeckReach['pdf'] => {
    const p = pairs.find((x) => x.from === 'pptx' && x.to === to)
    return p ? (p.state ?? 'ready') : 'none'
  }
  return { pdf: state('pdf+powerpoint'), video: state('mp4+powerpoint') }
}
