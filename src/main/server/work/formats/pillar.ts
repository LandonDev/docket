import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkModule } from '../modules'
import { registerFilePreviewer } from '../files/hooks'
import { documentFilePreviewer } from './filePreview'
import { exportDoc, printPage } from './exporter'
import { importFile, type ImportParams } from './importer'
import { pdfToMarkdown } from './pdfIn'
import { dropPreviews, previewDoc, previewOffice, readPreview, sweepPreviews } from './preview'

/**
 * The formats pillar's own parts: milestone 21's file (import and export),
 * merged into the module by index.ts, which milestone 15 owns. Its `convert`
 * list comes after the toolchain's LibreOffice converters, so a pair both
 * name runs the toolchain's (`convertersOf` keeps the first); its `handle`
 * hears every `work.formats.*` method the toolchain does not answer.
 * docs/agents/work-formats.md "Import and export" is the account; its
 * "Preview renders" says what a thread's and an item's delete take with them.
 */
export const formatsPillar: Pick<WorkModule, 'handle' | 'tools' | 'convert' | 'start' | 'preamble' | 'sessionsRemoved' | 'itemsRemoved' | 'workspaceRemoved'> & {
  ensure?: WorkModule['ensure']
} = {
  convert: [pdfToMarkdown],
  async handle(req, ctx, by) {
    if (req.method === 'work.formats.import') return handled(await importFile(ctx, by, req.params as ImportParams))
    if (req.method === 'work.formats.export') return handled(await exportDoc(ctx, by, req.params as Parameters<typeof exportDoc>[2]))
    if (req.method === 'work.formats.print') return handled(await printPage(ctx, req.params as Parameters<typeof printPage>[1]))
    if (req.method === 'work.formats.preview') return handled(await previewDoc(ctx, by, req.params as Parameters<typeof previewDoc>[2]))
    if (req.method === 'work.formats.previewOffice') return handled(await previewOffice(ctx, by, req.params as Parameters<typeof previewOffice>[2]))
    if (req.method === 'work.formats.previewRead') return handled(await readPreview(ctx, by, req.params as Parameters<typeof readPreview>[2]))
    return NOT_HANDLED
  },
  sessionsRemoved(ids, ctx) {
    dropPreviews(ctx.dataDir, { owners: ids })
  },
  itemsRemoved(items, ctx) {
    dropPreviews(ctx.dataDir, { items })
  },
  start(ctx) {
    // Renders of no item: swept at start and hourly after.
    const offPreview = registerFilePreviewer('document', documentFilePreviewer(ctx))
    sweepPreviews(ctx.dataDir)
    const timer = setInterval(() => sweepPreviews(ctx.dataDir), 60 * 60_000)
    timer.unref()
    return () => {
      offPreview()
      clearInterval(timer)
    }
  }
}
