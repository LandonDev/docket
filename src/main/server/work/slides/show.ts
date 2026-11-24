import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ShowDeck, ShowSlide } from '@shared/contract-work-slides'
import type { CanvasItem } from '@shared/work'
import { copyWhole, ItemFileError, pushFor } from '../pdf/file'
import { transitionChanged } from './builds'
import { makeMedia, mediaFile, showMedia } from './media'
import { makeSteps, showSteps, stepJobs } from './steps'
import { SlidesStore } from './store'
import { type Built, type Ctx, type Deck, deckDir, deckKey, deckOf, drawAhead, handKey, hashFile, nameOf, RENDER_FILTER, renderOf, scratch, serial, sharedJob, slideRenderer } from './view'

/**
 * A show as the host serves it (docs/agents/work-slides.md "The show"): the file's own slides in its order, each
 * with its builds' pictures, its transition and its media. The pictures and the media are made in the background
 * after the deck is opened and again after every change to it, off the deck's queue, so a write never waits on
 * them; a show reads what is ready and is told (`work.slides.ready`) when more is.
 */

/** What a show draws from: the file as it is, in its own order, whatever suggestions wait. */
export async function showOf(ctx: Ctx, item: CanvasItem, signal?: AbortSignal): Promise<ShowDeck> {
  await drawAhead(ctx, item, signal)
  return serial(ctx, item, async () => {
    const deck = await deckOf(ctx, item, signal)
    const { path, hash, file } = deck
    const pages = await deckDir(ctx, item, 'pages')
    const media = await deckDir(ctx, item, 'media')
    prepareShow(ctx, item, deck)
    // A step picture not kept yet is still being made while this revision's job runs; once it has ended, it failed.
    const job = running.get(showKey(ctx, item))
    const making = job?.hash === hash && !job.done
    let changed = 0
    const slides = file.info.slides.map((s, i): ShowSlide => {
      changed += (s.builds?.changed ?? 0) + transitionChanged(s.transition)
      const steps = file.pdf ? showSteps(pages, s, making) : undefined
      const played = showMedia(media, s)
      return {
        id: s.id,
        number: i + 1,
        page: i + 1,
        title: s.title,
        notes: s.notes,
        hidden: s.hidden,
        ...(steps ? { steps } : {}),
        ...(s.transition ? { transition: s.transition } : {}),
        ...(played ? { media: played } : {})
      }
    })
    // What `work.slides.build` serves of this deck from now on: these steps, never another page kept beside them.
    told.set(showKey(ctx, item), new Set(slides.flatMap((s) => (s.steps ?? []).flatMap((step) => (step.pic ? [step.pic.rev] : [])))))
    return {
      itemId: item.id,
      name: nameOf(item, path),
      rev: hash.slice(0, 16),
      render: renderOf(file),
      slides,
      ...(file.renderError ? { renderError: file.renderError } : {}),
      ...(changed ? { changed } : {})
    }
  })
}

/** A file of the deck's named by the first 16 characters of its key (a step's picture, a playable media file). */
async function byRev(ctx: Ctx, item: CanvasItem, folder: 'pages' | 'media', rev: string, ext: string): Promise<string> {
  const dir = await deckDir(ctx, item, folder)
  const name = readdirSync(dir).find((f) => f.startsWith(rev) && f.endsWith(ext) && f.length === 64 + ext.length)
  if (!name) throw new ItemFileError('That picture or clip is not ready, or is gone.', 'missing')
  return join(dir, name)
}
/**
 * The step pictures each deck's show was last told of (`showOf`), by `showKey`. The pages folder also keeps the
 * proposed deck's slides, which only his press may see: a step is read only by a rev the file's own show named.
 */
const told = new Map<string, Set<string>>()
/**
 * One show's job and pictures by the folder they fill (`deckFolder`): the deck's for a file of his own, every seat on
 * it sharing them; each tab's own on a file others can open, whose pictures lie in the item's own folder.
 */
const showKey = (ctx: Ctx, item: CanvasItem): string => handKey(ctx, item)
export async function stepPath(ctx: Ctx, item: CanvasItem, rev: string): Promise<string> {
  if (!told.get(showKey(ctx, item))?.has(rev)) throw new ItemFileError('That picture or clip is not ready, or is gone.', 'missing')
  return byRev(ctx, item, 'pages', rev, '.pdf')
}
export const mediaPath = (ctx: Ctx, item: CanvasItem, rev: string): Promise<string> => byRev(ctx, item, 'media', rev, '.play')

// ── made in the background ───────────────────────────────────────────

/**
 * The background job of each deck, for one revision of its file: a newer revision stops the older's. It stays once
 * done, so a revision is made once while the app runs; one that failed is tried again at its next change.
 */
const running = new Map<string, { hash: string; stop: AbortController; done: boolean }>()

/** Whether a deck still lacks a step picture or a playable media file. */
function lacks(pages: string, media: string, file: Built): boolean {
  // Step pictures need a picture of the deck; clips do not.
  if (file.pdf && stepJobs(file.info.slides, (key) => existsSync(join(pages, `${key}.pdf`))).length) return true
  return file.info.slides.some((s) => s.draws && s.shapes.some((sh) => sh.kind === 'media' && !mediaFile(media, s, sh.id)))
}

/** Tells every seat on the deck that more of its show is ready. */
function tellReady(ctx: Ctx, item: CanvasItem, hash: string): void {
  const rev = hash.slice(0, 16)
  // On a file others can open each tab's pictures are its own (a shared import's tab draws from its own snapshot too):
  // no other seat shows these.
  const seats = showKey(ctx, item) === deckKey(item) ? new SlidesStore(ctx.db).seats(deckKey(item)) : []
  const items = [item, ...seats.filter((s) => s.itemId !== item.id).flatMap((s) => ctx.canvas.get(s.itemId) ?? [])]
  for (const it of items) ctx.push({ push: 'work.slides.ready', sessionId: it.sessionId, itemId: it.id, rev }, pushFor(it))
}

/**
 * Makes the deck's step pictures and playable media in the background, from a copy of the file as it was hashed.
 * Called when the deck is opened, told again after a change, or shown; a revision already being made is left be.
 */
export function prepareShow(ctx: Ctx, item: CanvasItem, deck: Pick<Deck, 'hash' | 'file' | 'path'>): void {
  // One job a deck, or a tab for a shared import, whose pictures are its own.
  const key = showKey(ctx, item)
  const was = running.get(key)
  if (was?.hash === deck.hash) return
  const stop = new AbortController()
  const job = { hash: deck.hash, stop, done: false }
  was?.stop.abort()
  running.set(key, job)
  let worked = false
  void (async () => {
    const pages = await deckDir(ctx, item, 'pages')
    const media = await deckDir(ctx, item, 'media')
    if (!lacks(pages, media, deck.file)) return
    worked = true
    const copy = await scratch(ctx, item, 'show')
    try {
      stop.signal.throwIfAborted()
      copyWhole(deck.path, copy)
      // The file moved on since it was read: the next open makes that revision's.
      if (hashFile(copy) !== deck.hash) return
      const tell = (): void => tellReady(ctx, item, deck.hash)
      const log = (line: string): void => console.warn(line)
      const signal = stop.signal
      if (deck.file.pdf) {
        await makeSteps(
          {
            dir: pages,
            renderer: slideRenderer(),
            hideCopy: async (input, plan, output, sig) => void (await ctx.convert({ from: 'pptx', to: 'pptxsteps', input, output, options: { plan }, ...sharedJob(ctx, item), ...(sig ? { signal: sig } : {}) })),
            whole: async (input, output, sig) => void (await ctx.convert({ from: 'pptx', to: 'pdf', input, output, options: { filter: RENDER_FILTER }, ...sharedJob(ctx, item), ...(sig ? { signal: sig } : {}) })),
            log,
            onMade: tell
          },
          copy,
          deck.file.info.slides,
          signal
        )
      }
      signal.throwIfAborted()
      await makeMedia(
        {
          dir: media,
          extract: async (slide, shape, output, sig) => void (await ctx.convert({ from: 'pptx', to: 'slidemedia', input: copy, output, options: { slide, shape }, ...sharedJob(ctx, item), ...(sig ? { signal: sig } : {}) })),
          playable: async (input, output, sig) => void (await ctx.convert({ from: 'slidemedia', to: 'playable', input, output, ...sharedJob(ctx, item), ...(sig ? { signal: sig } : {}) })),
          log,
          onMade: tell
        },
        deck.file.info.slides,
        signal
      )
    } finally {
      rmSync(copy, { force: true })
    }
  })()
    .catch((err: unknown) => {
      if (!stop.signal.aborted) console.warn(`slides: the show's pictures were not made: ${err instanceof Error ? err.message : String(err)}`)
    })
    .finally(() => {
      job.done = true
      // A show still waiting on a step that was not made is told, so it says so rather than wait on it.
      if (worked && !stop.signal.aborted) tellReady(ctx, item, deck.hash)
    })
}

export function stopShow(key: string): void {
  running.get(key)?.stop.abort()
  running.delete(key)
  told.delete(key)
}

/** Stops every background job (Work turned off). */
export function stopShows(): void {
  for (const job of running.values()) job.stop.abort()
  running.clear()
  told.clear()
}
