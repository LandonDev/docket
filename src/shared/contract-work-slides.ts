import type { CapsOf, RelayOf } from './work/wire'

/**
 * The slides pillar's wire (docs/agents/work-slides.md). Its methods are
 * `work.slides.<verb>` and its pushes `work.slides`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const SlidesRequestSchemas = [] as const
export type SlidesPush = never
export const SLIDES_CAPS = {} satisfies CapsOf<typeof SlidesRequestSchemas>
export const SLIDES_RELAY = {} satisfies RelayOf<typeof SlidesRequestSchemas>
