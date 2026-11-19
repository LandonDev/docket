import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkModule } from '../modules'
import { fenceItem, itemOf, readRange } from '../pdf/file'
import { SLIDES_CONVERTERS } from './deck'
import { ensureSlidesTables, SlidesStore } from './store'
import { slidesTools } from './tools'
import { accept, announce, reject, renderPath, StaleChangesError, undo, viewOf } from './view'

/**
 * The slides pillar's server module (docs/agents/work-slides.md): a deck
 * item's outline and its renders, an agent's revisions as edits by slide
 * id beside the file, the owner's review that writes them in, the agent's
 * direct write and its Undo, and the tools a thread reads and revises a
 * deck with. The .pptx stays the truth; an edit written into it leaves
 * every part it did not change byte for byte as it was.
 */
const SLIDES_METHODS: ReadonlySet<string> = new Set(['work.slides.open', 'work.slides.read', 'work.slides.review', 'work.slides.mode', 'work.slides.undo'])

export const slides: WorkModule = {
  id: 'slides',
  ensure(db) {
    ensureSlidesTables(db)
  },
  async handle(req, ctx, by, signal) {
    // A method the module does not answer (work.slides.list) is not built: it names no item to fence.
    if (!SLIDES_METHODS.has(req.method)) return NOT_HANDLED
    // Every method names an item. A remote key gets nothing of a deck, and changes nothing in it, unless its
    // file is under the roots the key could name itself (fenceItem, as the pdf pillar does).
    const item = itemOf(ctx, (req as { params: { itemId: string } }).params.itemId, 'slides')
    fenceItem(ctx, by, item, req.method)
    switch (req.method) {
      case 'work.slides.open':
        return handled(await viewOf(ctx, item, signal))
      case 'work.slides.read': {
        const { path, rev } = await renderPath(ctx, item, req.params.which, signal)
        return handled({ ...readRange(path, req.params.offset, req.params.length), rev })
      }
      case 'work.slides.review': {
        // An agent suggests and the owner accepts: a thread's own call settles nothing.
        if (by.kind === 'model') throw new Error('Only the owner accepts or rejects a suggestion.')
        if (req.params.verdict === 'reject') {
          await reject(ctx, item, req.params.changes)
          return handled(await announce(ctx, item, signal))
        }
        try {
          await accept(ctx, item, req.params.changes, signal)
        } catch (err) {
          // What went in is shown at once; the sentence says which change still waits and why.
          if (err instanceof StaleChangesError) await announce(ctx, item, signal)
          throw err
        }
        return handled(await announce(ctx, item, signal))
      }
      case 'work.slides.mode': {
        if (by.kind === 'model') throw new Error('Only the owner sets what an agent may do to a deck.')
        new SlidesStore(ctx.db).setMode(item.id, item.sessionId, req.params.mode)
        return handled(await announce(ctx, item, signal))
      }
      case 'work.slides.undo': {
        await undo(ctx, item, req.params.writeId)
        return handled(await announce(ctx, item, signal))
      }
    }
    return NOT_HANDLED
  },
  tools: () => slidesTools,
  convert: SLIDES_CONVERTERS,
  preamble: () =>
    'A deck in the canvas is a .pptx file. Read it with `slides_read` and look at a slide with `slides_image`. Revise it with `slides_edit`, naming slides and shapes by id: each revised slide is a suggestion the person steps through and accepts. Say `because: "asked"` with the person\'s own words as `quote` when they asked for the edit, and `because: "own"` when it is your idea. Draft a new deck with `slides_new`.',
  sessionsRemoved(ids, ctx) {
    new SlidesStore(ctx.db).removeSessions(ids)
  },
  // Nothing: a deleted workspace's threads are removed too, and `sessionsRemoved` clears their rows.
  workspaceRemoved() {}
}
