import { statSync } from 'node:fs'
import { join } from 'node:path'
import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkModule } from '../modules'
import { statePath, Toolchain } from '../formats/tools'
import { fenceItem, itemOf, readRange } from '../pdf/file'
import { createResident, type Resident } from './resident'
import { SLIDES_CONVERTERS } from './deck'
import { ensureSlidesTables, SlidesStore } from './store'
import { slidesTools } from './tools'
import { registerFileMoved } from '../files/hooks'
import { accept, announce, ChangedSinceError, fileMoved, itemsGone, reject, renderPath, seatOf, sessionsGone, setSlideEngine, setSlideRenderer, showOf, slidePath, StaleChangesError, undo, viewOf } from './view'

/**
 * The slides pillar's server module (docs/agents/work-slides.md): a deck
 * item's outline and its renders, an agent's revisions as edits by slide
 * id beside the file, the owner's review that writes them in, the agent's
 * direct write and its Undo, and the tools a thread reads and revises a
 * deck with. The .pptx stays the truth; an edit written into it leaves
 * every part it did not change byte for byte as it was.
 */
const SLIDES_METHODS: ReadonlySet<string> = new Set(['work.slides.open', 'work.slides.read', 'work.slides.slide', 'work.slides.show', 'work.slides.review', 'work.slides.mode', 'work.slides.undo'])

// A deck's rows and folder are kept by its file's path: a rename or a move through Files re-keys them in the
// rename's own savepoint. Registered when the module loads; the files pillar keeps it whenever it starts.
registerFileMoved((from, to, at) => fileMoved(from, to, at))

// One resident a host for the life of the process: Work turned off and on again takes up the same one, which
// waits for its old LibreOffice to end before it starts another on the same profile.
const residents = new Map<string, Resident>()
function residentOf(dataDir: string, tools: Toolchain, log: (line: string) => void): Resident {
  let resident = residents.get(dataDir)
  if (!resident) residents.set(dataDir, (resident = createResident({ soffice: () => tools.bin('libreoffice'), folder: join(dataDir, 'work-slides', '.cache', 'resident'), log })))
  return resident
}

export const slides: WorkModule = {
  id: 'slides',
  ensure(db) {
    ensureSlidesTables(db)
  },
  // One LibreOffice kept running while Work is on (resident.ts): an edit's slide is drawn in a fraction of a second.
  // It starts at the first deck drawn, never here, and ends when Work is turned off or after ten idle minutes.
  start(ctx) {
    const tools = new Toolchain(ctx.dataDir)
    const resident = residentOf(ctx.dataDir, tools, (line) => ctx.log(line))
    setSlideRenderer({
      here: () => resident.state().phase !== 'unsupported' && tools.bin('libreoffice') !== null,
      slide: async (input, page, output, signal) => (await resident.slide(input, page, output, signal)).slides,
      deck: async (input, output, signal) => void (await resident.deck(input, output, signal))
    })
    // The toolchain as installed: its state file is rewritten when LibreOffice or a font pack is.
    setSlideEngine(() => {
      try {
        const at = statSync(statePath(ctx.dataDir))
        return `${at.mtimeMs}:${at.size}`
      } catch {
        return ''
      }
    })
    return () => {
      setSlideRenderer(null)
      setSlideEngine(null)
      void resident.stop()
    }
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
      case 'work.slides.slide': {
        const { path, rev } = await slidePath(ctx, item, req.params.which, req.params.slide, signal)
        return handled({ ...readRange(path, req.params.offset, req.params.length), rev })
      }
      case 'work.slides.show':
        return handled(await showOf(ctx, item, signal))
      case 'work.slides.review': {
        // An agent suggests and the owner accepts: a thread's own call settles nothing.
        if (by.kind === 'model') throw new Error('Only the owner accepts or rejects a suggestion.')
        try {
          if (req.params.verdict === 'reject') await reject(ctx, item, req.params.changes, req.params.rev, signal)
          else await accept(ctx, item, req.params.changes, signal, req.params.rev)
        } catch (err) {
          // What went in is shown at once; the sentence says which change still waits and why. A press on a preview
          // the changes moved on from changes nothing, and every client is shown the changes as they are now.
          if (err instanceof StaleChangesError || err instanceof ChangedSinceError) await announce(ctx, item, signal)
          throw err
        }
        return handled(await announce(ctx, item, signal))
      }
      case 'work.slides.mode': {
        if (by.kind === 'model') throw new Error('Only the owner sets what an agent may do to a deck.')
        // The mode is this tab's own (store.ts): another seat on the same file keeps its own.
        seatOf(ctx, item)
        new SlidesStore(ctx.db).setMode(item.id, req.params.mode)
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
    sessionsGone(ctx, ids)
  },
  itemsRemoved(items, ctx) {
    itemsGone(ctx, items)
  },
  // Nothing: a deleted workspace's threads are removed too, and `sessionsRemoved` clears their rows.
  workspaceRemoved() {}
}
