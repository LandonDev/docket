import type { CtxPart } from '../ctx'
import { registerCanvasMove } from './move'
import { CanvasStore, setCanvasStore } from './store'

/**
 * `ctx.canvas`: a thread's canvas items (`work_canvas_items`). The part
 * makes the database's one `CanvasStore` with the host's handles (the
 * registry, the data dir, the push) and leaves it where the module finds
 * it by `ctx.db` (`canvasStoreOf`), and registers the canvas as a move
 * module. Made at boot with Work on or off: it starts nothing.
 */
export const canvasPart: CtxPart<'canvas'> = (ctx, deps) => {
  const store = new CanvasStore({
    db: deps.db,
    dataDir: deps.dataDir,
    session: (id) => deps.registry.get(id),
    push: (p) => ctx.push(p),
    log: (line) => ctx.log(line)
  })
  setCanvasStore(deps.db, store)
  // Work on or off: the rows may be from a time it was on.
  registerCanvasMove(deps.db, ctx, () => store)
  return {
    canvas: {
      open: (sessionId, kind, source, title) => store.open(sessionId, { kind, source, title }),
      close: (itemId) => store.close(itemId),
      forSession: (sessionId) => store.list(sessionId)
    }
  }
}
