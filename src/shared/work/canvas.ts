import { z } from 'zod'
import type { HostId, PillarId } from './ids'

/**
 * The canvas pane's wire: the eleven kinds of item, what an item points at,
 * and the chip a message or a new thread is about. The pane, its registry
 * (`CANVAS`) and its store are milestone 9's; this file is what both sides
 * and every pillar's contract read.
 */

export const CANVAS_KINDS = ['mail', 'document', 'sheet', 'pdf', 'slides', 'media', 'browser', 'history', 'meeting', 'form', 'dashboard'] as const
export type CanvasKind = (typeof CANVAS_KINDS)[number]
export const CanvasKindSchema = z.enum(CANVAS_KINDS)

/** The pillar that owns each kind's body, once: kind ids and pillar ids differ. */
export const CANVAS_PILLAR: Record<CanvasKind, PillarId> = {
  mail: 'mail',
  document: 'docs',
  sheet: 'sheets',
  pdf: 'pdf',
  slides: 'slides',
  media: 'media',
  browser: 'browser',
  history: 'history',
  meeting: 'meetings',
  form: 'forms',
  dashboard: 'dashboards'
}

/** Where an item's truth lives. */
export type CanvasSource =
  | { at: 'lifeos'; table: 'docs' | 'sheets' | 'outbox' | 'calendarOps' | 'projectDocs'; id: string }
  /** A file on `host`, fenced like every path param (remote/fence.ts). */
  | { at: 'file'; host: string; path: string }
  | { at: 'google'; account: string; fileId: string; mime: string }
  /** Open in the Office app on `host`. A Teams or SharePoint file is a URL; the path fence applies to `kind: 'path'` only. */
  | {
      at: 'microsoft'
      host: HostId
      app: 'excel' | 'word' | 'powerpoint'
      name: string
      ref: { kind: 'path'; path: string } | { kind: 'url'; url: string }
    }
  | { at: 'frameio'; account: string; fileId: string }
  | { at: 'browser'; host: string; sessionId: string }
  /** Made in the thread; lives under `canvas/<sid>/<itemId>/`. */
  | { at: 'thread' }

export const CanvasSourceSchema = z.discriminatedUnion('at', [
  z.object({ at: z.literal('lifeos'), table: z.enum(['docs', 'sheets', 'outbox', 'calendarOps', 'projectDocs']), id: z.string() }),
  z.object({ at: z.literal('file'), host: z.string(), path: z.string() }),
  z.object({ at: z.literal('google'), account: z.string(), fileId: z.string(), mime: z.string() }),
  z.object({
    at: z.literal('microsoft'),
    host: z.string(),
    app: z.enum(['excel', 'word', 'powerpoint']),
    name: z.string(),
    // A URL is a web address and nothing else: a `file:` one would be a path the fence never saw.
    ref: z.discriminatedUnion('kind', [z.object({ kind: z.literal('path'), path: z.string() }), z.object({ kind: z.literal('url'), url: z.string().regex(/^https?:\/\/[^\s]+$/i, 'an http(s) URL') })])
  }),
  z.object({ at: z.literal('frameio'), account: z.string(), fileId: z.string() }),
  z.object({ at: z.literal('browser'), host: z.string(), sessionId: z.string() }),
  z.object({ at: z.literal('thread') })
])

/** The file path a source names on a host's disk, if it names one: what the path fence checks. */
export function canvasSourcePath(source: CanvasSource): string | null {
  if (source.at === 'file') return source.path
  if (source.at === 'microsoft' && source.ref.kind === 'path') return source.ref.path
  return null
}

/** One item of a thread's canvas (`work_canvas_items`, milestone 9). */
export interface CanvasItem {
  id: string
  sessionId: string
  workspaceId: string | null
  kind: CanvasKind
  title: string
  source: CanvasSource
  state: 'open' | 'closed'
  position: number
  rev: number
  createdAt: number
  updatedAt: number
}
export const CanvasItemSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  workspaceId: z.string().nullable(),
  kind: CanvasKindSchema,
  title: z.string(),
  source: CanvasSourceSchema,
  state: z.enum(['open', 'closed']),
  position: z.number().int(),
  rev: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

/** What a message or a new thread is about: a task, a mail, an event, or a selection in an item. */
export interface ContextChip {
  kind: 'task' | 'mail' | 'event' | 'selection'
  label: string
  ref: { at: 'lifeos'; table: 'tasks' | 'mailThreads' | 'events'; id: string } | CanvasSource
  /** a selection's text */
  quote?: string
}
export const ContextChipSchema = z.object({
  kind: z.enum(['task', 'mail', 'event', 'selection']),
  label: z.string().max(500),
  ref: z.union([z.object({ at: z.literal('lifeos'), table: z.enum(['tasks', 'mailThreads', 'events']), id: z.string() }), CanvasSourceSchema]),
  quote: z.string().max(20_000).optional()
})
