import { z } from 'zod'
import { CANVAS_KINDS, CanvasKindSchema, CanvasSourceSchema, workText, type CanvasItem, type CanvasKind, type CanvasSource, type WorkToolResult } from '@shared/work'
import type { WorkTool } from '../modules'
import { canvasStoreOf } from './store'

/** The canvas tools: a thread opens and closes items in its own pane only, which for a subagent is its root thread's (`CanvasStore.paneOf`). */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const lines = (items: CanvasItem[]): string => (items.length ? items.map((i) => `${i.id}  ${i.kind}  ${i.title}`).join('\n') : '(no items open)')
const answer = (head: string, items: CanvasItem[], extra: Record<string, unknown>): WorkToolResult => ({
  ...workText(`${head}\nOpen items:\n${lines(items)}`),
  structuredContent: { ...extra, items }
})
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const canvasTools: WorkTool[] = [
  {
    name: 'canvas_open',
    description:
      `Opens an item in this thread's canvas pane, the tabs beside the chat that the person sees (a subagent's items show beside its root thread). A kind is one of ${CANVAS_KINDS.join(', ')}. ` +
      '`source` says where the item\'s truth lives: `{ "at": "file", "host": "<host>", "path": "/abs/path.pdf" }` for a file on this host, or `{ "at": "thread" }` for something this thread makes. ' +
      'Pass `item` to open one of this thread\'s items again; otherwise pass `kind`, `title` and `source`.',
    input: z.object({
      kind: CanvasKindSchema.optional(),
      title: z.string().min(1).max(200).optional(),
      source: CanvasSourceSchema.optional(),
      item: z.string().optional()
    }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { kind?: CanvasKind; title?: string; source?: CanvasSource; item?: string }
      if (!a.item && !(a.kind && a.title && a.source)) return fail('Pass `item` to open an item again, or all of `kind`, `title` and `source` to open a new one.')
      const store = canvasStoreOf(ctx.db)
      const pane = store.paneOf(ctx.sessionId)
      try {
        const item = store.open(pane, a.item ? { itemId: a.item } : { kind: a.kind, title: a.title, source: a.source })
        return answer(`Opened ${item.title} (${item.id}).`, store.list(pane), { item })
      } catch (err) {
        return fail(message(err))
      }
    }
  },
  {
    name: 'canvas_close',
    description: "Closes one of this thread's canvas items: it leaves the tab row, and `canvas_open` with its id opens it again.",
    input: z.object({ item: z.string() }),
    readOnly: false,
    run: async (args, ctx) => {
      const { item: id } = args as { item: string }
      const store = canvasStoreOf(ctx.db)
      const pane = store.paneOf(ctx.sessionId)
      const item = store.get(id)
      if (!item || item.sessionId !== pane) return fail(`This thread has no canvas item ${id}.`)
      try {
        store.close(id)
      } catch (err) {
        return fail(message(err))
      }
      return answer(`Closed ${item.title} (${item.id}).`, store.list(pane), {})
    }
  }
]
