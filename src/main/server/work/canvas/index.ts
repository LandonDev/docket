import { handled, mailPaneOf, NOT_HANDLED, type CanvasItem } from '@shared/work'
import { ensureFetched, isFetched, keepFetched, readFetched } from './fetch'
import { WORK_MODULES, type WorkModule } from '../modules'
import { canvasMentions, searchMentions } from './mentions'
import { ensureMovedTable, retryMoved } from './move'
import { canvasStoreOf, ensureCanvasTables, fencedItem } from './store'
import { canvasTools } from './tools'

/**
 * The canvas pillar's server module (docs/agents/work-canvas.md "The
 * store"): `work_canvas_items`, the `work.canvas.*` methods (`mentions` asks every pillar's `@` kinds), the two
 * tools, and what a deleted thread leaves. It reaches the store the part
 * made (canvas/ctx.ts) through `ctx.db`.
 */
export const canvas: WorkModule = {
  id: 'canvas',
  ensure(db) {
    ensureCanvasTables(db)
    ensureMovedTable(db)
  },
  // A move LifeOS could not be told of while it was down is told once Work is on, and again until it answers.
  start: (ctx) => retryMoved(ctx),
  async handle(req, ctx, by) {
    const store = canvasStoreOf(ctx.db)
    // A remote key sees only the paths it could name itself (ctx.reaches); the rest are cut to file names.
    const shown = (item: CanvasItem): CanvasItem => fencedItem(item, (path) => ctx.reaches(by, path))
    switch (req.method) {
      case 'work.canvas.list':
        return handled({ items: store.list(req.params.sessionId).map(shown) })
      case 'work.canvas.open': {
        const { sessionId, ...open } = req.params
        return handled(shown(store.open(sessionId, open)))
      }
      case 'work.canvas.close':
        store.close(req.params.itemId)
        return handled(null)
      case 'work.canvas.reorder':
        return handled({ items: store.reorder(req.params.sessionId, req.params.order).map(shown) })
      case 'work.canvas.fetch':
      case 'work.canvas.keep':
      case 'work.canvas.read': {
        const item = store.get(req.params.itemId)
        if (!item) throw new Error(`no canvas item ${req.params.itemId}`)
        if (!isFetched(item.source)) throw new Error(`${item.title} is read where it is: there is nothing to fetch.`)
        if (req.method === 'work.canvas.fetch') return handled(await ensureFetched(ctx, item))
        if (req.method === 'work.canvas.keep') return handled(await keepFetched(ctx, item))
        return handled(readFetched(ctx.dataDir, item, req.params.offset, req.params.length))
      }
      case 'work.canvas.mentions': {
        const { sessionId, draft, text, kinds } = req.params
        // The thread's scope is the fence: a thread with no reach (an unlinked code thread) is offered nothing.
        const reach = ctx.mentionReach(sessionId, draft)
        return handled(reach ? await searchMentions(ctx, reach, text, { modules: WORK_MODULES, kinds }) : { hits: [], failed: [] })
      }
    }
    return NOT_HANDLED
  },
  tools: () => canvasTools,
  mentions: canvasMentions,
  sessionsRemoved(ids, ctx) {
    canvasStoreOf(ctx.db).removeSessions(ids)
    const gone = ctx.db.prepare(`DELETE FROM work_canvas_moved WHERE session_id = ?`)
    for (const id of ids) gone.run(id)
  },
  // A deleted workspace's threads are removed too, and `sessionsRemoved` clears their items; its Mail pane goes here.
  workspaceRemoved(workspaceId, ctx) {
    canvasStoreOf(ctx.db).removeSessions([mailPaneOf(workspaceId)])
  }
}
