import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasItem } from '@shared/work'
import { copyWhole, ItemFileError, readRange } from '../pdf/file'
import { deckDir, pictureSalt, RENDER_FILTER, scratch, sharedJob, slideRenderer, type Ctx } from './view'

/**
 * A kept copy of the deck drawn to look at before Restore (docs/agents/work-slides.md "Versions"): the whole copy as
 * one PDF, made once a copy and what draws it, read by range. A version is named by its file's name and nothing else,
 * never a path, as a restore names it; the picture is kept under the deck's `versions/` folder, a few at a time.
 */

/** A kept copy's name as `keepHistory` makes it: its time, four of a UUID, `.first` for the deck before TempCode. */
export const VERSION_NAME = /^[0-9]{15}-[0-9a-f]{4}(\.first)?\.pptx$/
const GONE = 'That version is no longer kept.'
/** The pictures of versions kept at once: the ones he looks at in a sitting. */
const KEEP = 6

/** The picture of a kept copy, drawn the first time it is asked for: its bytes from `offset`, its size and its rev. */
export async function versionRead(ctx: Ctx, item: CanvasItem, version: string, offset: number, length: number, signal?: AbortSignal): Promise<{ data: string; size: number; rev: string }> {
  if (!VERSION_NAME.test(version)) throw new ItemFileError(GONE, 'stale')
  const kept = join(await deckDir(ctx, item, 'history'), version)
  if (!existsSync(kept)) throw new ItemFileError(GONE, 'stale')
  const rev = createHash('sha256').update(`${pictureSalt()}\n${version}\n${statSync(kept).size}`).digest('hex').slice(0, 16)
  const dir = await deckDir(ctx, item, 'versions')
  const pdf = join(dir, `${rev}.pdf`)
  if (!existsSync(pdf)) {
    await (drawing.get(pdf) ?? drawn(pdf, draw(ctx, item, kept, pdf, signal)))
    prune(dir)
  }
  const now = new Date()
  utimesSync(pdf, now, now)
  return { ...readRange(pdf, offset, length), rev }
}

/** One draw a picture, however many ask while it is made. */
const drawing = new Map<string, Promise<void>>()
function drawn(pdf: string, work: Promise<void>): Promise<void> {
  drawing.set(pdf, work)
  return work.finally(() => drawing.delete(pdf))
}

/** Draws the copy from a scratch copy of it, with the LibreOffice kept running where the host has one, else a job. */
async function draw(ctx: Ctx, item: CanvasItem, kept: string, pdf: string, signal?: AbortSignal): Promise<void> {
  const input = await scratch(ctx, item, 'version')
  const tmp = `${pdf}.${randomUUID().slice(0, 8)}.tmp`
  try {
    copyWhole(kept, input)
    const renderer = slideRenderer()
    let done = false
    if (renderer && renderer.here?.() !== false) {
      try {
        await renderer.deck(input, tmp, signal)
        done = true
      } catch (err) {
        if (signal?.aborted) throw err
      }
    }
    if (!done) await ctx.convert({ from: 'pptx', to: 'pdf', input, output: tmp, options: { filter: RENDER_FILTER }, ...sharedJob(ctx, item), ...(signal ? { signal } : {}) })
    renameSync(tmp, pdf)
  } finally {
    rmSync(input, { force: true })
    rmSync(tmp, { force: true })
  }
}

/** The newest `KEEP` pictures stay; the rest are drawn again if he looks again. */
function prune(dir: string): void {
  const pdfs = readdirSync(dir)
    .filter((f) => f.endsWith('.pdf'))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const { f } of pdfs.slice(KEEP)) rmSync(join(dir, f), { force: true })
}
