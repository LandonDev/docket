import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { sharedOf } from '../files/policy'
import type { FilePreviewer } from '../files/hooks'
import { copyWhole, hasMagic } from '../pdf/file'
import { isTeamsSnapshot } from './formatsIn'
import { SlidesStore } from './store'
import { fileKey, filePathOf, RENDER_FILTER, renderPath, slideRenderer, type Ctx } from './view'

/**
 * A deck's slide as a picture for Files (`registerFilePreviewer`): slide
 * `page` of a .pptx on this host as a PNG, `width` pixels wide, with how
 * many slides the deck has, so Files' preview can page through it. Where a tab
 * is open on the file its kept picture is used and nothing is drawn; else
 * the slide is drawn once into a scratch folder that goes when the picture
 * is read, so a file others can open keeps nothing past the ask, and its
 * copies are drawn on this host alone.
 */
export function deckPreviewer(ctx: Ctx): FilePreviewer {
  return async (source, { page, width, signal }) => {
    const path = filePathOf(source)
    if (!path || !/\.pptx$/i.test(path) || !existsSync(path) || !hasMagic(path, 'zip')) return null
    const store = new SlidesStore(ctx.db)
    const key = fileKey(path)
    const mark = source.at === 'microsoft' || sharedOf(ctx, source) || isTeamsSnapshot(ctx.dataDir, source) || store.sharedDeck(key) ? { shared: true as const } : {}
    const dir = join(ctx.dataDir, 'work-slides', '.cache', 'preview', randomUUID())
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      const open = store
        .seats(key)
        .map((seat) => ctx.canvas.get(seat.itemId))
        .find((item) => item?.state === 'open')
      let pdf = join(dir, 'deck.pdf')
      let at = page
      // How many slides the deck has, for the preview's pager, where what drew the slide says.
      let pages: number | null = null
      if (open) pdf = (await renderPath(ctx, open, 'file', signal)).path
      else {
        const copy = join(dir, 'deck.pptx')
        copyWhole(path, copy)
        const renderer = slideRenderer()
        if (renderer && renderer.here?.() !== false) {
          try {
            pages = await renderer.slide(copy, page, pdf, signal)
            at = 1
          } catch (err) {
            if (signal?.aborted) throw err
            rmSync(pdf, { force: true })
          }
        }
        if (!existsSync(pdf)) await ctx.convert({ from: 'pptx', to: 'pdf', input: copy, output: pdf, options: { filter: RENDER_FILTER }, ...mark, ...(signal ? { signal } : {}) })
      }
      const png = join(dir, 'page.png')
      await ctx.convert({ from: 'pdf', to: 'png', input: pdf, output: png, options: { page: at, width: Math.max(64, Math.min(2400, Math.round(width))) }, ...mark, ...(signal ? { signal } : {}) })
      // A whole export is the deck page for page; a picture that will not read as a PDF says nothing of the count.
      if (at === page) pages = await PDFDocument.load(readFileSync(pdf), { updateMetadata: false }).then((doc) => doc.getPageCount(), () => null)
      const drawn = new Uint8Array(readFileSync(png))
      return pages ? { png: drawn, pages } : drawn
    } catch (err) {
      if (signal?.aborted) throw err
      return null
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
