import { handled, NOT_HANDLED, type CanvasItem } from '@shared/work'
import type { WorkModule } from '../modules'
import { PDF_CONVERTERS } from './extract'
import { fenceItem, itemDir, ItemFileError, itemOf, readRange } from './file'
import type { FormRead } from './form'
import { ensurePdfTables, PdfStore } from './store'
import { pdfTools } from './tools'
import { announce, exportCopy, formOf, lastExport, signedDate, snapshot, viewOf } from './view'

/**
 * The pdf pillar's server module (docs/agents/work-pdf.md): a PDF item's
 * file by range, the form's fields with what an agent proposed and the
 * owner took, his highlights and his signature, the copy that leaves, and
 * the tools a thread reads and fills a PDF with. The item's file is never
 * written: everything of ours is rows over it until `work.pdf.export`.
 */

type Ctx = Parameters<typeof snapshot>[0]

/** A field of the file by key, when the file's form can be read. */
async function ownField(ctx: Ctx, item: CanvasItem, key: string): Promise<FormRead['fields'][number] | undefined> {
  const form = await formOf((await snapshot(ctx, item)).stamp)
  return 'error' in form ? undefined : form.fields.find((f) => f.key === key)
}

export const pdf: WorkModule = {
  id: 'pdf',
  ensure(db) {
    ensurePdfTables(db)
  },
  async handle(req, ctx, by) {
    const store = new PdfStore(ctx.db)
    // Every method that names an item: a remote key gets nothing of an item outside its fence, and writes nothing into it.
    const named = ((req as { params?: { itemId?: unknown } }).params)?.itemId
    if (req.method.startsWith('work.pdf.') && typeof named === 'string') fenceItem(ctx, by, itemOf(ctx, named, 'pdf'), req.method)
    switch (req.method) {
      case 'work.pdf.open': {
        const item = itemOf(ctx, req.params.itemId, 'pdf')
        // The one place a new copy of the file is taken: the reads that follow are of it.
        return handled(await viewOf(ctx, item, { refresh: true }))
      }
      case 'work.pdf.read': {
        const item = itemOf(ctx, req.params.itemId, 'pdf')
        if (req.params.which === 'export') {
          const copy = lastExport(await itemDir(ctx, item, 'export'))
          if (!copy) throw new ItemFileError('No copy has been made of this file yet.', 'missing')
          if (req.params.rev && req.params.rev !== copy.rev) throw new ItemFileError('A newer copy has been made since: read that one.', 'stale')
          return handled({ ...readRange(copy.path, req.params.offset, req.params.length), rev: copy.rev })
        }
        // The version the view named, never a newer one: one load reads one version.
        const { stamp } = await snapshot(ctx, item, req.params.rev ? { rev: req.params.rev } : {})
        return handled({ ...readRange(stamp.path, req.params.offset, req.params.length), rev: stamp.rev })
      }
      case 'work.pdf.review': {
        const item = itemOf(ctx, req.params.itemId, 'pdf')
        store.review(item.id, req.params.keys, req.params.verdict)
        return handled(await announce(ctx, item))
      }
      case 'work.pdf.setField': {
        const item = itemOf(ctx, req.params.itemId, 'pdf')
        store.setOwn(item.id, item.sessionId, req.params.key, req.params.value, await ownField(ctx, item, req.params.key))
        return handled(await announce(ctx, item))
      }
      case 'work.pdf.mark': {
        const item = itemOf(ctx, req.params.itemId, 'pdf')
        const { itemId: _itemId, ...mark } = req.params
        store.mark(item.id, item.sessionId, mark, 'owner')
        return handled(await announce(ctx, item))
      }
      case 'work.pdf.unmark': {
        const item = itemOf(ctx, req.params.itemId, 'pdf')
        store.unmark(item.id, req.params.markId)
        return handled(await announce(ctx, item))
      }
      case 'work.pdf.mode': {
        const item = itemOf(ctx, req.params.itemId, 'pdf')
        store.setMode(item.id, item.sessionId, req.params.mode)
        return handled(await announce(ctx, item))
      }
      case 'work.pdf.undo': {
        const item = itemOf(ctx, req.params.itemId, 'pdf')
        if (!store.undo(item.id, req.params.writeId)) throw new Error('That write can no longer be taken back.')
        return handled(await announce(ctx, item))
      }
      case 'work.pdf.signature':
        return handled({ signature: store.signature() })
      case 'work.pdf.setSignature':
        // His signature is his to draw: a thread's own call is refused whatever key it rides.
        if (by.kind === 'model') throw new Error('Only the owner saves a signature.')
        store.setSignature(req.params.signature)
        return handled(null)
      case 'work.pdf.sign': {
        if (by.kind === 'model') throw new Error('Only the owner signs.')
        const item = itemOf(ctx, req.params.itemId, 'pdf')
        if (req.params.signed && !store.signature()) throw new Error('Draw your signature first.')
        const { stamp } = await snapshot(ctx, item)
        const form = await formOf(stamp)
        store.sign(item.id, item.sessionId, req.params.signed, 'error' in form ? [] : form.fields, signedDate(), stamp.rev)
        return handled(await announce(ctx, item))
      }
      case 'work.pdf.export': {
        const item = itemOf(ctx, req.params.itemId, 'pdf')
        const made = await exportCopy(ctx, item, req.params.flatten)
        return handled({ name: made.name, size: made.size, rev: made.rev, warnings: made.warnings })
      }
    }
    return NOT_HANDLED
  },
  tools: () => pdfTools,
  convert: PDF_CONVERTERS,
  preamble: () =>
    'When you say what a PDF in the canvas says, cite the place as a link the person can click: the `pdf_extract` tool gives a code after each passage (`#pdf:…`), and `[p. 6, clause 7.2](#pdf:…)` with that code scrolls the page to it. A value you put in a form with `pdf_fill` is a suggestion the person accepts, and it must say where it came from. You never sign: place the signature field and its date with `pdf_fill`, and the person presses Sign.',
  sessionsRemoved(ids, ctx) {
    new PdfStore(ctx.db).removeSessions(ids)
  },
  itemsRemoved(items, ctx) {
    new PdfStore(ctx.db).removeItems(items.map((i) => i.id))
  },
  // Nothing: a deleted workspace's threads are removed too, and `sessionsRemoved` clears their rows.
  workspaceRemoved() {}
}
