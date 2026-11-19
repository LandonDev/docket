import { z } from 'zod'
import type { Bbox } from './pdfCite'
import type { Principal } from './work/ids'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The pdf pillar's wire (docs/agents/work-pdf.md): a PDF in the canvas pane.
 * Its methods are `work.pdf.<verb>` and its push `work.pdf`;
 * src/shared/work/wire.ts has the helpers and the rules.
 *
 * The file a PDF item points at is never rewritten by anything here. What
 * an agent proposes for a form's fields, what the owner accepts or types,
 * his highlights and where his signature goes are rows in this host's
 * database, drawn over the page; `work.pdf.export` writes them into a copy.
 */

export type { Bbox } from './pdfCite'
const share = z.number().min(0).max(1)
export const BboxSchema = z.tuple([share, share, share, share])

/** Where a field's value came from: what a person reads first, then where to check it. */
export interface PdfProvenance {
  /** `manual`: someone typed it. */
  kind: 'file' | 'mail' | 'page' | 'thread' | 'manual'
  /** What a person reads: "Purdue profile", "Run of show.docx, p. 2". */
  label: string
  /** The source's own id: a path, a mail's id, a URL. */
  id?: string
  /** The words the value was read from. */
  quote?: string
  page?: number
  bbox?: Bbox
  /** 0 to 1; 1 when a person typed it. */
  confidence?: number
}
export const PdfProvenanceSchema = z.object({
  kind: z.enum(['file', 'mail', 'page', 'thread', 'manual']),
  label: z.string().min(1).max(200),
  id: z.string().max(2000).optional(),
  quote: z.string().max(2000).optional(),
  page: z.number().int().positive().optional(),
  bbox: BboxSchema.optional(),
  confidence: z.number().min(0).max(1).optional()
})

export const PDF_FIELD_TYPES = ['text', 'checkbox', 'choice', 'signature', 'date'] as const
export type PdfFieldType = (typeof PDF_FIELD_TYPES)[number]
export type PdfFieldValue = string | boolean | null
export const PdfFieldValueSchema = z.union([z.string().max(20_000), z.boolean(), z.null()])

/**
 * One field of a form. `acroform`: a field of the file, `key` its full
 * name. `overlay`: a box an agent or the owner placed on a page that has no
 * field there (a flat form's line, a signature line), `key` our own id.
 * `signature` is where the owner's drawn signature goes and `date` the day
 * he signed: only his press fills them.
 */
export interface PdfField {
  key: string
  label: string
  type: PdfFieldType
  /** from 1 */
  page: number
  bbox: Bbox
  origin: 'acroform' | 'overlay'
  /** What the copy that leaves will carry: the file's own value, or the one he accepted or typed. */
  value: PdfFieldValue
  /** An agent's value waiting for him; present only while `state` is `proposed`. */
  proposed?: PdfFieldValue
  /** `empty`: nothing in it. `proposed`: an agent's value waits. `accepted`: he took or typed the value. `needs-owner`: only he can fill it (a signature, its date). */
  state: 'empty' | 'proposed' | 'accepted' | 'needs-owner'
  /** Newest first; the first entry is the shown value's. */
  provenance: PdfProvenance[]
  by?: Principal
  /** A choice field's options. */
  options?: string[]
}

/** A highlight: the words under it and where they are. Written into an exported copy as a real annotation named `tc:<threadId>:<id>`. */
export interface PdfMark {
  id: string
  page: number
  /** one box per line of the selection */
  quads: Bbox[]
  text: string
  note?: string
  by: Principal
  at: number
}

/** A drawn signature: strokes in the pad's own units, each a run of points. */
export interface PdfSignature {
  width: number
  height: number
  strokes: Array<Array<[number, number]>>
}
export const PdfSignatureSchema = z.object({
  width: z.number().positive().max(4000),
  height: z.number().positive().max(4000),
  strokes: z
    .array(z.array(z.tuple([z.number(), z.number()])).min(1).max(4000))
    .min(1)
    .max(200)
})

export type PdfMode = 'suggests' | 'writes'

/** What the agent last wrote directly (the mode was "Agent writes"), for the bar's settled line and its Undo. */
export interface PdfWritten {
  id: string
  /** "Filled 5 fields" */
  text: string
  at: number
}

/** Everything the canvas draws over the file. */
export interface PdfView {
  itemId: string
  sessionId: string
  /** the file's name */
  name: string
  size: number
  /** changes when the file's bytes do */
  rev: string
  mode: PdfMode
  fields: PdfField[]
  marks: PdfMark[]
  /** he has a drawn signature saved on this host */
  hasSignature: boolean
  /** his signature is placed on this item */
  signed: boolean
  written?: PdfWritten
  /** The form is XFA only: no field of it can be filled here. */
  xfaOnly?: boolean
  /** Why nothing of the form could be read (an encrypted file); the pages still show. */
  formError?: string
  /** The file is not where the item says: what shows is the copy kept when it was last read, as of then. */
  missing?: { asOf: number }
}

const itemId = z.string().min(1).max(100)
/** A read is one frame: at most this many bytes of the file a call. */
export const PDF_READ_MAX = 4 * 1024 * 1024

export const PdfRequestSchemas = [
  /** → PdfView */
  request('work.pdf.open', z.object({ itemId })),
  /** → { data: base64, size, rev }: bytes of the item's file, or of its last export. A file that is not a PDF is refused. */
  request(
    'work.pdf.read',
    z.object({
      itemId,
      which: z.enum(['file', 'export']).default('file'),
      /** The version the view named (`PdfView.rev`): a read of a version no longer kept is refused, so one load never mixes two. Absent: the newest kept. */
      rev: z.string().max(64).optional(),
      offset: z.number().int().min(0),
      length: z.number().int().positive().max(PDF_READ_MAX)
    })
  ),
  /** → PdfView: takes or drops an agent's values. */
  request('work.pdf.review', z.object({ itemId, keys: z.union([z.array(z.string()).max(2000), z.literal('all')]), verdict: z.enum(['accept', 'reject']) })),
  /** → PdfView: the owner's own value for a field; null empties it. */
  request('work.pdf.setField', z.object({ itemId, key: z.string().max(500), value: PdfFieldValueSchema })),
  /** → PdfView: a highlight over the words he selected */
  request(
    'work.pdf.mark',
    z.object({ itemId, page: z.number().int().positive(), quads: z.array(BboxSchema).min(1).max(200), text: z.string().max(20_000), note: z.string().max(2000).optional() })
  ),
  /** → PdfView */
  request('work.pdf.unmark', z.object({ itemId, markId: z.string() })),
  /** → PdfView: what the agent does to this item from now on */
  request('work.pdf.mode', z.object({ itemId, mode: z.enum(['suggests', 'writes']) })),
  /** → PdfView: takes back what the agent wrote directly */
  request('work.pdf.undo', z.object({ itemId, writeId: z.string() })),
  /** → { signature: PdfSignature | null }: the owner's saved drawn signature. Needs approve: a lower key learns only `PdfView.hasSignature`. */
  request('work.pdf.signature', z.object({}).optional()),
  /** → null: saves his drawn signature on this host, or with null forgets it */
  request('work.pdf.setSignature', z.object({ signature: PdfSignatureSchema.nullable() })),
  /** → PdfView: places his saved signature on the item's signature fields and today's date on its date fields, or takes both off. Never a thread's to call. */
  request('work.pdf.sign', z.object({ itemId, signed: z.boolean() })),
  /** → { name, size, rev, warnings }: writes a copy with the accepted values, the highlights as annotations and the signature drawn in; `flatten` paints the fields into the page so nothing can be edited. `work.pdf.read` with `which: 'export'` reads it. */
  request('work.pdf.export', z.object({ itemId, flatten: z.boolean().default(true) }))
] as const

/** What is drawn over an item changed. */
export type PdfPush = { push: 'work.pdf'; sessionId: string; view: PdfView }

export const PDF_CAPS = {
  'work.pdf.open': 'read',
  'work.pdf.read': 'read',
  'work.pdf.review': 'operate',
  'work.pdf.setField': 'operate',
  'work.pdf.mark': 'operate',
  'work.pdf.unmark': 'operate',
  'work.pdf.mode': 'operate',
  'work.pdf.undo': 'operate',
  'work.pdf.signature': 'approve',
  'work.pdf.setSignature': 'approve',
  'work.pdf.sign': 'approve',
  'work.pdf.export': 'operate'
} satisfies CapsOf<typeof PdfRequestSchemas>
export const PDF_RELAY = {} satisfies RelayOf<typeof PdfRequestSchemas>

// ── citations ─────────────────────────────────────────────────────────

// The citation link lives in a module with no zod (pdfCite.ts), so the
// canvas can use it without adding zod code to the first paint's chunk.
export { parsePdfCite, pdfCiteHref, type PdfCite } from './pdfCite'
