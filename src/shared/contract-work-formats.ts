import { z } from 'zod'
import { CanvasSourceSchema, type CanvasSource } from './work/canvas'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The formats pillar's wire (docs/agents/work-formats.md). Its methods are
 * `work.formats.<verb>` and its pushes `work.formats`; src/shared/work/wire.ts has
 * the helpers and the rules. Milestone 15 wrote the toolchain's two methods;
 * milestone 21 added import, export and print after them.
 */
/**
 * A format's name on the wire: its extension, or its extension and who
 * draws it after a plus (`pdf+word` is a PDF as Word itself draws it,
 * `xlsx+ops` a workbook with structural edits applied).
 */
export const FORMAT_NAME = /^[a-z0-9]{1,10}(\+[a-z0-9]{1,12})?$/

/** Whether a converter can run now: `asleep` runs only for his own press on that host, `not open` is an app he has shut, `none` is not there. */
export type Readiness = 'ready' | 'asleep' | 'not open' | 'none'

/** The most one `work.formats.previewRead` answers: a render is read by range, a frame at a time. */
export const PREVIEW_READ_MAX = 4 * 1024 * 1024

/** The formats a document's Preview draws as pages on the host: the PDF itself, and the file as LibreOffice draws it. */
export const PREVIEW_FORMATS = ['pdf', 'docx', 'odt', 'rtf'] as const
export type PreviewFormatId = (typeof PREVIEW_FORMATS)[number]

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
      from: z.string().regex(FORMAT_NAME),
      to: z.string().regex(FORMAT_NAME),
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
  ),
  /**
   * A document drawn as the file a format makes of it (→ PreviewAnswer),
   * for the Preview frame (docs/agents/work-editors.md "Preview"). `pdf` is
   * the window's print page printed here, and its bytes are the file;
   * `docx`, `odt` and `rtf` are the exported file, converted on this host and
   * drawn by LibreOffice (the file itself is `work.formats.export`'s, which
   * needs no renderer). The render is kept on this host by the hash of what
   * it was made from, under the item it is for, and read by range.
   */
  request(
    'work.formats.preview',
    z.object({
      source: CanvasSourceSchema,
      /** the canvas item it is drawn for: its renders are kept under it and go when it goes */
      itemId: z.string().min(1).max(80).optional(),
      format: z.enum(PREVIEW_FORMATS),
      /** `pdf` alone: the window's print page, as `work.formats.print` takes it */
      html: z.string().max(60 * 1024 * 1024).optional(),
      paper: z.enum(['A4', 'Letter']).optional(),
      by: z.literal('word').optional()
    }).refine((p) => !p.by || p.format === 'docx', 'Word only draws the Word preview')
  ),
  /** Is Word in reach of a press on this document? (→ PreviewOfficeAnswer) */
  request('work.formats.previewOffice', z.object({ source: CanvasSourceSchema, itemId: z.string().min(1).max(80).optional() })),
  /**
   * Bytes of one render's picture, a PDF (→ { data } as base64), at most
   * PREVIEW_READ_MAX a call. `rev` names the render; one that is gone (the
   * document was drawn again) is refused, never answered from another.
   */
  request(
    'work.formats.previewRead',
    z.object({
      source: CanvasSourceSchema,
      itemId: z.string().min(1).max(80).optional(),
      rev: z.string().regex(/^[a-f0-9]{32}$/),
      offset: z.number().int().min(0),
      length: z.number().int().min(1).max(PREVIEW_READ_MAX)
    })
  )
] as const

/** What `work.formats.preview` answers: one finished render, named by `rev`. */
export interface PreviewAnswer {
  rev: string
  /** the picture's size in bytes: a PDF */
  size: number
  pages: number
  drawnBy: 'tempcode' | 'libreoffice' | 'word'
  /** the name the file goes out under: "Run of show.docx" */
  name: string
  /** what the file could not carry, one line each, a person's words */
  warnings: string[]
  /** an agent's suggestions left out of the file until he accepts them, counted as the canvas counts them (Word, OpenDocument, Rich Text) */
  heldSuggestions?: number
}

export interface PreviewOfficeAnswer {
  app: 'word'
  state: Readiness
}

/** A Word check can lose reach between the readiness check and the press. */
export type PreviewResult = PreviewAnswer | { notInReach: Exclude<Readiness, 'ready'> }

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
  /** an agent's suggestions left out of the file until he accepts them (Word, OpenDocument, Rich Text) */
  heldSuggestions?: number
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
  /** `state` is absent for a pair that is simply ready; a pair that is not on the host at all is not listed */
  converts: { from: string; to: string; state?: Exclude<Readiness, 'ready' | 'none'> }[]
  queue: { cap: { jobs: number; threads: number }; running: number; queued: number }
}

export type FormatsPush = never
export const FORMATS_CAPS = {
  'work.formats.tools': 'read',
  'work.formats.convert': 'operate',
  'work.formats.import': 'operate',
  'work.formats.export': 'read',
  'work.formats.print': 'operate',
  'work.formats.preview': 'operate',
  'work.formats.previewRead': 'read',
  'work.formats.previewOffice': 'read'
} satisfies CapsOf<typeof FormatsRequestSchemas>
/** A forwarded job is between two linked hosts, never carried on a relayed lane. */
export const FORMATS_RELAY = { 'work.formats.convert': 'never' } satisfies RelayOf<typeof FormatsRequestSchemas>
