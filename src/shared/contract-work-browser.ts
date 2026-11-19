import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The browser pillar's wire (docs/agents/work-browser.md). Its methods are
 * `work.browser.<verb>` and its pushes `work.browser`; src/shared/work/wire.ts has
 * the helpers and the rules.
 *
 * The live browser is computer use on a Mac, shown full size in the canvas.
 * What this pillar keeps per thread is who drives (the agent, or the owner
 * once he took over), what a page needs of him, the site, and where each
 * value the agent put on the page came from. The picture itself is the
 * Computer section's live stream (`computer.preview.*`), and a submit waits
 * as the computer hold's live item (`computer.act`, milestone 10).
 */

export const BROWSER_DRIVERS = ['agent', 'owner'] as const
export type BrowserDriver = (typeof BROWSER_DRIVERS)[number]

/** Where the agent says one value on the page came from, by the field's name as the page labels it. */
export const PortalSourceSchema = z.object({ field: z.string().min(1).max(200), source: z.string().min(1).max(300) })
export type PortalSource = z.infer<typeof PortalSourceSchema>

/** One thread's browser, keyed by the thread whose pane shows it (a subagent's acts show in its root's). */
export interface BrowserState {
  sessionId: string
  driver: BrowserDriver
  /** what a page needs of him, in a few words ("Arbiter wants you to sign in"); null: nothing */
  needs: string | null
  /** the site, as the agent opened it */
  site: { url: string; name: string } | null
  sources: PortalSource[]
  /** when `driver` or `needs` last changed */
  since: number
}

export const BrowserRequestSchemas = [
  /** → BrowserState: a thread that never opened its browser reads as the agent driving, with nothing else */
  request('work.browser.state', z.object({ sessionId: z.string() })),
  /** → BrowserState: take over (`owner`) or hand back (`agent`). A person's alone; handing back wakes the thread. */
  request('work.browser.drive', z.object({ sessionId: z.string(), driver: z.enum(BROWSER_DRIVERS) })),
  /**
   * → BrowserVideo: whether the box's browser runs headed for live video (video/settings.ts
   * `work.browser.video`), set with `on`. It holds from the browser's next start.
   */
  request('work.browser.video', z.object({ on: z.boolean().optional() }))
] as const
/** `tools`: the engine and its display are installed on this host; without them the browser stays headless whatever `on` says. */
export interface BrowserVideo {
  on: boolean
  tools: boolean
}
export type BrowserPush = { push: 'work.browser'; state: BrowserState }
export const BROWSER_CAPS = {
  'work.browser.state': 'read',
  'work.browser.drive': 'operate',
  // reads and sets a host setting: an admin's
  'work.browser.video': 'admin'
} satisfies CapsOf<typeof BrowserRequestSchemas>
export const BROWSER_RELAY = {} satisfies RelayOf<typeof BrowserRequestSchemas>
