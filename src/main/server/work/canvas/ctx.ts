import { notBuilt } from '@shared/work'
import type { CtxPart } from '../ctx'

/**
 * `ctx.canvas`: a thread's canvas items (`work_canvas_items`). A stub:
 * milestone 9 builds the store, its methods, push and agent tools.
 */
export const canvasPart: CtxPart<'canvas'> = () => ({
  canvas: {
    open: notBuilt('ctx.canvas.open', 9),
    close: notBuilt('ctx.canvas.close', 9),
    forSession: notBuilt('ctx.canvas.forSession', 9)
  }
})
