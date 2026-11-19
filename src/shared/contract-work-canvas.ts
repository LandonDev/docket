import { z } from 'zod'
import { CanvasKindSchema, CanvasSourceSchema, CHIP_KINDS, type CanvasItem } from './work/canvas'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The canvas pillar's wire (docs/agents/work-canvas.md): a thread's items
 * in its pane. Its methods are `work.canvas.<verb>` and its push
 * `work.canvas`; src/shared/work/wire.ts has the helpers and the rules.
 */
export const CanvasRequestSchemas = [
  /** → { items: CanvasItem[] }: the thread's open items, in tab order */
  request('work.canvas.list', z.object({ sessionId: z.string() })),
  /** → CanvasItem: opens an item in the thread's pane, last in the tab row (one already open keeps its place and is only shown). With `itemId`: reopens that item of the thread (closed or open). Without: `kind`, `source` and `title` are required; an open or closed item of the thread with the same kind and source is reopened instead of making a second one (never for `{ at: 'thread' }`, where each open makes a new item). */
  request(
    'work.canvas.open',
    z.object({
      sessionId: z.string(),
      itemId: z.string().optional(),
      kind: CanvasKindSchema.optional(),
      source: CanvasSourceSchema.optional(),
      title: z.string().min(1).max(200).optional()
    })
  ),
  /** → null: the item leaves the tab row; its row stays (`state: 'closed'`) and so do its files */
  request('work.canvas.close', z.object({ itemId: z.string() })),
  /** → { items: CanvasItem[] }: the tab order; `order` lists item ids, first tab first. Open items it leaves out keep their order after the listed ones; ids that are not open items of the thread are ignored. */
  request('work.canvas.reorder', z.object({ sessionId: z.string(), order: z.array(z.string()).max(200) })),
  /**
   * → MentionAnswer (src/shared/work/mentions.ts): what the composer's `@` offers for `text`, found only in what
   * the thread's scope may read. A thread not made yet (a draft) names where it will be: its project or
   * workspace, and `work` for a Work Chat. `kinds` narrows to those kinds.
   */
  request(
    'work.canvas.mentions',
    z.object({
      sessionId: z.string(),
      draft: z.object({ projectId: z.string().nullable().optional(), workspaceId: z.string().nullable().optional(), work: z.boolean().optional() }).optional(),
      text: z.string().max(200),
      kinds: z.array(z.enum(CHIP_KINDS)).max(CHIP_KINDS.length).optional()
    })
  )
] as const

/** A thread's open items changed: the whole list, in tab order. `opened`: the item an open just made or reopened, for the pane to select. */
export type CanvasPush = { push: 'work.canvas'; sessionId: string; items: CanvasItem[]; opened?: string }

export const CANVAS_CAPS = {
  'work.canvas.list': 'read',
  'work.canvas.open': 'operate',
  'work.canvas.close': 'operate',
  'work.canvas.reorder': 'operate',
  // It reads his mail, tasks and agenda as a LifeOS JWT would, so it needs what `work.lifeos.jwt` needs.
  'work.canvas.mentions': 'approve'
} satisfies CapsOf<typeof CanvasRequestSchemas>
// Carried to a far host only while its screen is unlocked, as the JWT that reads the same things is.
export const CANVAS_RELAY = { 'work.canvas.mentions': 'screen' } satisfies RelayOf<typeof CanvasRequestSchemas>
