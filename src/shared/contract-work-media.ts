import type { CapsOf, RelayOf } from './work/wire'

/**
 * The media pillar's wire (docs/agents/work-media.md). Its methods are
 * `work.media.<verb>` and its pushes `work.media`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const MediaRequestSchemas = [] as const
export type MediaPush = never
export const MEDIA_CAPS = {} satisfies CapsOf<typeof MediaRequestSchemas>
export const MEDIA_RELAY = {} satisfies RelayOf<typeof MediaRequestSchemas>
