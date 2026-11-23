import { workspaceKindOf } from '@shared/work'
import type { CtxPart } from '../ctx'
import { WORK_MODULES } from '../modules'
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
    workWorkspace: (id) => deps.registry.listWorkspaces().some((w) => w.id === id && workspaceKindOf(w) === 'work'),
    push: (p, to) => ctx.push(p, to),
    remoteReaches: (path) => {
      try {
        return ctx.reaches({ kind: 'remote', caps: [] }, path)
      } catch {
        return false
      }
    },
    log: (line) => ctx.log(line),
    // Every pillar that loaded, one after another: one's fault leaves the others told.
    itemsRemoved: (items) => {
      for (const module of WORK_MODULES) {
        try {
          module.itemsRemoved?.(items, ctx)
        } catch (err) {
          ctx.log(`${module.id} did not clear deleted items: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  })
  setCanvasStore(deps.db, store)
  // Work on or off: the rows may be from a time it was on.
  registerCanvasMove(deps.db, ctx, () => store)
  return {
    canvas: {
      open: (sessionId, kind, source, title) => store.open(sessionId, { kind, source, title }),
      close: (itemId) => store.close(itemId),
      replace: (sessionId, oldItemId, kind, source, title) => store.replace(sessionId, oldItemId, { kind, source, title }),
      remove: (itemIds) => store.remove(itemIds),
      inside: (fn) => store.inside(fn),
      onReplaced: (fn) => store.onItemReplaced(fn),
      forSession: (sessionId) => store.list(sessionId),
      forWorkspace: (workspaceId, opts) => store.forWorkspace(workspaceId, opts),
      get: (itemId) => store.get(itemId),
      paneOf: (sessionId) => store.paneOf(sessionId)
    }
  }
}
