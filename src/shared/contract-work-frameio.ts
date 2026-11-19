import type { CapsOf, RelayOf } from './work/wire'

/**
 * The frameio pillar's wire (docs/agents/work-frameio.md). Its methods are
 * `work.frameio.<verb>` and its pushes `work.frameio`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const FrameioRequestSchemas = [] as const
export type FrameioPush = never
export const FRAMEIO_CAPS = {} satisfies CapsOf<typeof FrameioRequestSchemas>
export const FRAMEIO_RELAY = {} satisfies RelayOf<typeof FrameioRequestSchemas>
