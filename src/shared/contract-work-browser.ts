import type { CapsOf, RelayOf } from './work/wire'

/**
 * The browser pillar's wire (docs/agents/work-browser.md). Its methods are
 * `work.browser.<verb>` and its pushes `work.browser`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const BrowserRequestSchemas = [] as const
export type BrowserPush = never
export const BROWSER_CAPS = {} satisfies CapsOf<typeof BrowserRequestSchemas>
export const BROWSER_RELAY = {} satisfies RelayOf<typeof BrowserRequestSchemas>
