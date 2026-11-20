import { z } from 'zod'
import { PillarIdSchema, type HostId, type PillarId } from './ids'

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
  /**
   * A mail's attachment in LifeOS's file store: the host fetches its bytes into the item's own
   * folder, inside the pane's sector (work-mail.md "Attachments"). Never a copy in his folder.
   */
  | { at: 'mail'; threadId: string; messageId: string; partId: string; name: string; contentType?: string; size?: number }

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
  z.object({ at: z.literal('thread') }),
  z.object({
    at: z.literal('mail'),
    threadId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(200),
    partId: z.string().min(1).max(200),
    name: z.string().min(1).max(500),
    contentType: z.string().max(200).optional(),
    size: z.number().int().nonnegative().optional()
  })
])

/**
 * The pane of a workspace's Mail view: an owner of canvas items as a thread is, so an attachment
 * opens beside the mail with no thread made for it. Its key fits a canvas folder's name.
 */
export const MAIL_PANE_PREFIX = 'mailpane_'
export const mailPaneOf = (workspaceId: string): string => `${MAIL_PANE_PREFIX}${workspaceId}`
/** The workspace a Mail view's pane belongs to; null for a thread. */
export const mailPaneWorkspace = (owner: string): string | null => (owner.startsWith(MAIL_PANE_PREFIX) && owner.length > MAIL_PANE_PREFIX.length ? owner.slice(MAIL_PANE_PREFIX.length) : null)

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

/**
 * What a chip can be: a task, a mail, an event or a selection (milestone 25,
 * Ask), and every kind the composer's `@` offers (F-mentions: a project, a
 * person, a LifeOS document, a canvas item, a held act, a routine, a
 * project's card). The phone decodes a kind it does not know.
 */
export const CHIP_KINDS = ['task', 'mail', 'event', 'selection', 'project', 'person', 'doc', 'item', 'held', 'routine', 'card'] as const
export type ChipKind = (typeof CHIP_KINDS)[number]
/** The LifeOS rows a chip may name directly (a LifeOS document is a `CanvasSource`). */
export const CHIP_LIFEOS_TABLES = ['tasks', 'mailThreads', 'events', 'projects', 'people'] as const

/** What a message or a new thread is about: a task, a mail, an event, a selection in an item, or anything `@` offers. */
export interface ContextChip {
  kind: ChipKind
  label: string
  ref:
    | { at: 'lifeos'; table: (typeof CHIP_LIFEOS_TABLES)[number]; id: string }
    | CanvasSource
    /** a canvas item by its id (a thread-made item's source names none) */
    | { at: 'item'; id: string }
    /** a pillar's own row: a held act (`outbox`), a routine (`routines`) */
    | { at: 'work'; pillar: PillarId; id: string }
  /** a selection's text */
  quote?: string
  /** a few words of what the thing says, for the model beside the reference */
  excerpt?: string
}
export const CHIP_EXCERPT_MAX = 600
/** Each kind in a sentence: "About this held act: …", "Remove the held act". */
export const CHIP_NOUN: Record<ChipKind, string> = {
  task: 'task',
  mail: 'mail',
  event: 'event',
  selection: 'selection',
  project: 'project',
  person: 'person',
  doc: 'document',
  item: 'item',
  held: 'held act',
  routine: 'routine',
  card: 'card'
}
export const ContextChipSchema = z.object({
  kind: z.enum(CHIP_KINDS),
  label: z.string().max(500),
  ref: z.union([
    z.object({ at: z.literal('lifeos'), table: z.enum(CHIP_LIFEOS_TABLES), id: z.string() }),
    CanvasSourceSchema,
    z.object({ at: z.literal('item'), id: z.string() }),
    z.object({ at: z.literal('work'), pillar: PillarIdSchema, id: z.string() })
  ]),
  quote: z.string().max(20_000).optional(),
  excerpt: z.string().max(CHIP_EXCERPT_MAX).optional()
})
