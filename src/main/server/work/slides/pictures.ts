import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'

/**
 * A deck's picture, kept slide by slide (docs/agents/work-slides.md "A
 * picture that keeps up"). Every slide's one-page PDF is kept under the
 * hash of everything it is drawn from (`SlideInfo.draws`) and of what
 * draws it (`salt`: the deck script, the filter and the toolchain as it is
 * installed), so after an edit only the slides whose hash moved are drawn
 * again, and a new LibreOffice draws them all again, one at a time, by the
 * LibreOffice kept running (resident.ts); the deck's PDF, which every
 * client and the phone read by page number, is those pages put together.
 * One slide exported alone is the same picture as that page of a whole
 * export, pixel for pixel (resident.test.ts holds it), so a deck drawn
 * either way reads the same.
 */

/** What draws: the LibreOffice kept running. Either call may fail; the caller then draws the old way. */
export interface SlideRenderer {
  /** A one-page PDF of page `page` (from 1; hidden slides are pages too) of the deck at `input`. Answers how many slides it found in the deck. */
  slide(input: string, page: number, output: string, signal?: AbortSignal): Promise<number>
  /** The whole deck as one PDF, hidden slides in. */
  deck(input: string, output: string, signal?: AbortSignal): Promise<void>
  /** False where it cannot run now (no LibreOffice on this host, Windows): the deck is drawn the old way and nothing is logged. */
  here?(): boolean
}

export interface PictureDeps {
  /** where one-page PDFs are kept, each named by `pageName(salt, draws)` */
  dir: string
  /** what draws: a change of it (a new deck script, filter or LibreOffice) makes every page again */
  salt: string
  /** null where no LibreOffice is kept running (no toolchain here, Windows): every render is a whole export */
  renderer: SlideRenderer | null
  /** the toolchain's own whole-deck export (a LibreOffice started for the job), the way a deck was always drawn */
  whole(input: string, output: string, signal?: AbortSignal): Promise<void>
  log?: (line: string) => void
}

/** Up to this many slides are drawn one at a time; past it one whole export is quicker (a slide alone still opens the whole file). */
export const ONE_AT_A_TIME = 4
/**
 * The longest deck the LibreOffice kept running draws. It opens the whole file for each job and a job has ten
 * seconds (resident.ts JOB_MS): 200 slides open in under two on a loaded box, so past this a deck goes straight to
 * the toolchain's own export, which has minutes.
 */
export const RESIDENT_MOST = 400

/** A kept page's name: one for a slide's parts as one engine draws them. Its first sixteen characters are the picture's `rev`. */
export const pageName = (salt: string, draws: string): string => createHash('sha256').update(`${salt}\n${draws}`).digest('hex')
const pageFile = (deps: Pick<PictureDeps, 'dir' | 'salt'>, draws: string): string => join(deps.dir, `${pageName(deps.salt, draws)}.pdf`)

/** One-page PDFs from a deck's PDF: page i (from 0) to `outs[i]`, where given. Each is written beside its place and moved onto it. */
export async function splitPdf(pdf: string, outs: ReadonlyArray<string | null>): Promise<void> {
  const src = await PDFDocument.load(readFileSync(pdf), { updateMetadata: false })
  if (src.getPageCount() !== outs.length) throw new Error(`the picture has ${src.getPageCount()} pages for ${outs.length} slides`)
  for (const [i, out] of outs.entries()) {
    if (!out) continue
    // No dates or producer of its own: the same page split twice is the same bytes, so a `rev` never names two files.
    const one = await PDFDocument.create({ updateMetadata: false })
    const [page] = await one.copyPages(src, [i])
    one.addPage(page)
    const tmp = `${out}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, await one.save({ useObjectStreams: true }))
    renameSync(tmp, out)
  }
}

/** One PDF from one-page PDFs, in order. */
export async function stitchPdf(pages: readonly string[], out: string): Promise<void> {
  const whole = await PDFDocument.create({ updateMetadata: false })
  // A slide drawn twice in a deck (two slides of the same picture) is read once.
  const read = new Map<string, PDFDocument>()
  for (const path of pages) {
    let src = read.get(path)
    if (!src) read.set(path, (src = await PDFDocument.load(readFileSync(path), { updateMetadata: false })))
    const [page] = await whole.copyPages(src, [0])
    whole.addPage(page)
  }
  const tmp = `${out}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, await whole.save({ useObjectStreams: true }))
  renameSync(tmp, out)
}

export type PictureWay = 'kept' | 'slides' | 'whole'

/**
 * Makes the PDF of the deck at `input` at `out`, page n its slide n. `slides` is the deck's outline in order
 * (`draws` per slide). Slides whose picture is kept are not drawn again; up to four missing are drawn one at a
 * time by the resident; more, or any failure of it, is one whole export, whose pages are then kept one by one.
 */
export async function deckPicture(deps: PictureDeps, input: string, slides: ReadonlyArray<{ draws?: string }>, out: string, signal?: AbortSignal): Promise<{ way: PictureWay; drawn: number }> {
  mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
  const renderer = deps.renderer && slides.length <= RESIDENT_MOST && deps.renderer.here?.() !== false ? deps.renderer : null
  const keys = slides.map((s) => s.draws)
  const known = keys.every((k): k is string => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k))
  const files = known ? (keys as string[]).map((k) => pageFile(deps, k)) : []
  let missing = known ? files.map((f, i) => (existsSync(f) ? -1 : i)).filter((i) => i >= 0) : []
  const touch = (): void => {
    const now = new Date()
    for (const f of new Set(files)) {
      try {
        utimesSync(f, now, now)
      } catch {
        /* gone: drawn again when asked */
      }
    }
  }
  /** Puts the kept pages together. A page that will not read (cut short, empty) is dropped, so it is drawn again and never fails the deck for good. */
  const stitch = async (): Promise<boolean> => {
    try {
      await stitchPdf(files, out)
      touch()
      return true
    } catch (err) {
      if (signal?.aborted) throw err
      for (const f of new Set(files)) {
        try {
          if ((await PDFDocument.load(readFileSync(f), { updateMetadata: false })).getPageCount() !== 1) throw new Error('not one page')
        } catch {
          rmSync(f, { force: true })
        }
      }
      missing = files.map((f, i) => (existsSync(f) ? -1 : i)).filter((i) => i >= 0)
      deps.log?.(`slides: the kept pages could not be put together, drawing again: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
  if (known && slides.length > 0 && missing.length === 0 && (await stitch())) return { way: 'kept', drawn: 0 }
  if (known && renderer && missing.length > 0 && missing.length <= ONE_AT_A_TIME) {
    try {
      // The same picture twice in one deck is drawn once.
      const todo = missing.filter((i) => files.indexOf(files[i]) === i)
      for (const i of todo) {
        const tmp = `${files[i]}.${randomUUID().slice(0, 8)}.tmp`
        try {
          const found = await renderer.slide(input, i + 1, tmp, signal)
          // The outline and LibreOffice must agree on the slides, or page n is another slide: the whole export decides.
          if (found !== slides.length) throw new Error(`LibreOffice found ${found} slides where the outline has ${slides.length}`)
          renameSync(tmp, files[i])
        } finally {
          rmSync(tmp, { force: true })
        }
      }
      if (await stitch()) return { way: 'slides', drawn: todo.length }
    } catch (err) {
      if (signal?.aborted) throw err
      deps.log?.(`slides: a slide drawn alone failed, drawing the whole deck: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const tmp = `${out}.${randomUUID().slice(0, 8)}.tmp`
  try {
    let drawn = false
    if (renderer) {
      try {
        await renderer.deck(input, tmp, signal)
        drawn = true
      } catch (err) {
        if (signal?.aborted) throw err
        deps.log?.(`slides: the LibreOffice kept running failed, starting one for the job: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!drawn) await deps.whole(input, tmp, signal)
    renameSync(tmp, out)
  } finally {
    rmSync(tmp, { force: true })
  }
  // Each page is kept for the next edit; a deck whose outline has no hashes (an older script) keeps none.
  if (known) {
    try {
      await splitPdf(out, files.map((f, i) => (missing.includes(i) && files.indexOf(f) === i ? f : null)))
      touch()
    } catch (err) {
      deps.log?.(`slides: the deck's pages were not kept one by one: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { way: 'whole', drawn: slides.length }
}

/** What a job cut short may leave beside the pages (a `.tmp`, the resident's `.part-`): swept once it is this old. */
const STRAY_MS = 10 * 60_000

/** Keeps the newest `keep` one-page pictures of a folder and drops the rest, and anything else there that a job cut short left. */
export function prunePages(dir: string, keep: number): void {
  let all: string[]
  try {
    all = readdirSync(dir)
  } catch {
    return
  }
  const aged = (f: string): { f: string; at: number } => {
    try {
      return { f, at: statSync(join(dir, f)).mtimeMs }
    } catch {
      return { f, at: 0 }
    }
  }
  const pages = all.filter((f) => /^[0-9a-f]{64}\.pdf$/.test(f)).map(aged).sort((a, b) => b.at - a.at)
  for (const { f } of pages.slice(keep)) rmSync(join(dir, f), { force: true })
  const now = Date.now()
  for (const { f, at } of all.filter((f) => !/^[0-9a-f]{64}\.pdf$/.test(f)).map(aged)) if (now - at > STRAY_MS) rmSync(join(dir, f), { recursive: true, force: true })
}
