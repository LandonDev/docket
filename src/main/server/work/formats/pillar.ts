import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkModule } from '../modules'
import { exportDoc, printPage } from './exporter'
import { importFile, type ImportParams } from './importer'
import { pdfToMarkdown } from './pdfIn'

/**
 * The formats pillar's own parts: milestone 21's file (import and export),
 * merged into the module by index.ts, which milestone 15 owns. Its `convert`
 * list comes after the toolchain's LibreOffice converters, so a pair both
 * name runs the toolchain's (`convertersOf` keeps the first); its `handle`
 * hears every `work.formats.*` method the toolchain does not answer.
 * docs/agents/work-formats.md "Import and export" is the account.
 */
export const formatsPillar: Pick<WorkModule, 'handle' | 'tools' | 'convert' | 'start' | 'preamble' | 'sessionsRemoved' | 'workspaceRemoved'> & {
  ensure?: WorkModule['ensure']
} = {
  convert: [pdfToMarkdown],
  async handle(req, ctx, by) {
    if (req.method === 'work.formats.import') return handled(await importFile(ctx, by, req.params as ImportParams))
    if (req.method === 'work.formats.export') return handled(await exportDoc(ctx, by, req.params as Parameters<typeof exportDoc>[2]))
    if (req.method === 'work.formats.print') return handled(await printPage(ctx, req.params as Parameters<typeof printPage>[1]))
    return NOT_HANDLED
  }
}
