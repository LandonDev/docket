import type { CapsOf, RelayOf } from './work/wire'

/**
 * The canvas pillar's wire (docs/agents/work-canvas.md). Its methods are
 * `work.canvas.<verb>` and its pushes `work.canvas`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const CanvasRequestSchemas = [] as const
export type CanvasPush = never
export const CANVAS_CAPS = {} satisfies CapsOf<typeof CanvasRequestSchemas>
export const CANVAS_RELAY = {} satisfies RelayOf<typeof CanvasRequestSchemas>
