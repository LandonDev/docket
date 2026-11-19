import { z } from 'zod'
import { CanvasSourceSchema, type CanvasSource } from './work/canvas'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The formats pillar's wire (docs/agents/work-formats.md). Its methods are
 * `work.formats.<verb>` and its pushes `work.formats`; src/shared/work/wire.ts has
 * the helpers and the rules. Milestone 15 wrote the toolchain's two methods;
 * milestone 21 added import, export and print after them.
 */
export const FormatsRequestSchemas = [
  /** → ToolsReport */
  request('work.formats.tools', z.object({}).optional()),
  /**
   * A job another host forwards: the input travels in the request as base64
   * and the output comes back the same way (→ { data, ranOn, warnings }).
   * It runs here or fails; it is never forwarded on.
   */
  request(
    'work.formats.convert',
    z.object({
      from: z.string().regex(/^[a-z0-9]{1,10}$/),
      to: z.string().regex(/^[a-z0-9]{1,10}$/),
      /** the input's file name, for its extension and the output's name */
      name: z.string().min(1).max(255),
      data: z.string().max(90 * 1024 * 1024),
      options: z.record(z.string(), z.unknown()).optional()
    })
  ),
  /**
   * A file in as a document (→ ImportAnswer): a file on this host the canvas
   * opened, a dropped file's bytes, or HTML the window already read into
   * blocks. The document is a `.tcdoc` beside the original, which is kept;
   * with `sessionId` it opens in that thread's canvas, in place of `itemId`.
   */
  request(
    'work.formats.import',
    z.object({
      sessionId: z.string().min(1).max(80).optional(),
      itemId: z.string().min(1).max(80).optional(),
      from: z.discriminatedUnion('at', [
        z.object({ at: z.literal('source'), source: CanvasSourceSchema }),
        z.object({ at: z.literal('bytes'), name: z.string().min(1).max(255), data: z.string().max(90 * 1024 * 1024) }),
        z.object({ at: z.literal('blocks'), name: z.string().min(1).max(255), blocks: z.array(z.unknown()).max(50_000) })
      ])
    })
  ),
  /** A document out as a file (→ ExportAnswer): Word with its comments and pending changes, OpenDocument, RTF or markdown. */
  request('work.formats.export', z.object({ source: CanvasSourceSchema, format: z.enum(['docx', 'odt', 'rtf', 'md']) })),
  /** A page the window wrote (`work-kit/formats/html`'s print page) printed to PDF on this host (→ ExportAnswer). */
  request(
    'work.formats.print',
    z.object({ name: z.string().min(1).max(255), html: z.string().max(60 * 1024 * 1024), paper: z.enum(['A4', 'Letter']).optional() })
  )
] as const

/** What `work.formats.import` answers: the document it made, and what the file held that the document could not. */
export interface ImportAnswer {
  source: CanvasSource
  title: string
  /** the canvas item it opened in, with `sessionId` */
  itemId?: string
  /** one line each, a person's words */
  warnings: string[]
  /** the file carried other people's comments or tracked changes */
  outsiders: boolean
}

/** What `work.formats.export` and `work.formats.print` answer: the file, as base64, and what it could not carry. */
export interface ExportAnswer {
  name: string
  data: string
  warnings: string[]
}

/** The formats a document is exported to, in the order the Export dialog lists them. */
export const EXPORT_FORMATS = ['docx', 'pdf', 'md', 'html', 'odt', 'rtf'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** The files a document is imported from, by extension. */
export const IMPORT_EXTENSIONS = ['docx', 'odt', 'rtf', 'doc', 'md', 'markdown', 'html', 'htm', 'pdf'] as const
/** What `work.formats.tools` answers: this host's tools, the pairs it converts itself, and its queue. */
export interface ToolsReport {
  host: string
  platform: string
  tools: { name: string; pillar: string; version: string; licence: string; ok: boolean; bytes?: number; error?: string }[]
  converts: { from: string; to: string }[]
  queue: { cap: { jobs: number; threads: number }; running: number; queued: number }
}

export type FormatsPush = never
export const FORMATS_CAPS = {
  'work.formats.tools': 'read',
  'work.formats.convert': 'operate',
  'work.formats.import': 'operate',
  'work.formats.export': 'read',
  'work.formats.print': 'operate'
} satisfies CapsOf<typeof FormatsRequestSchemas>
/** A forwarded job is between two linked hosts, never carried on a relayed lane. */
export const FORMATS_RELAY = { 'work.formats.convert': 'never' } satisfies RelayOf<typeof FormatsRequestSchemas>
