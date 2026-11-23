import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { BboxSchema, pdfCiteHref, PdfProvenanceSchema, type Bbox, type PdfField, type PdfProvenance } from '@shared/contract-work-pdf'
import { agentPrincipal, workText, type CanvasItem, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ToolCtx, WorkTool } from '../modules'
import { extractMarkdown, type PdfExtract } from './extract'
import { hasMagic, paneItem } from './file'
import { labelFields } from './form'
import { announce, exportCopy, fieldsOfFile, snapshot } from './view'
import { PdfStore, type FieldFill, type FieldPlace } from './store'

/**
 * The tools a Work thread reads and fills a PDF with
 * (docs/agents/work-pdf.md "The tools"). Reading goes through the box's
 * extract job (`ctx.convert`), so a host without the Python tools forwards
 * it to one that has them. Nothing here signs, and nothing here sends.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
/** What one answer may carry back to the model. */
const ANSWER_MAX = 60_000

const target = {
  item: z.string().optional().describe('The id of a PDF item in this thread\'s canvas (from `canvas_open`).'),
  file: z.string().optional().describe('An absolute path to a PDF on this host, when it is not open in the canvas.')
}

/** The file a tool acts on: an item of the thread's pane, or a path. */
async function fileOf(ctx: ToolCtx, a: { item?: string; file?: string }): Promise<{ path: string; item: CanvasItem | null }> {
  if (a.item) {
    const item = paneItem(ctx, ctx.sessionId, a.item, 'pdf')
    // A thread reads the file as it is now: a new version is copied, and the one before it stays for a load in flight.
    return { path: (await snapshot(ctx, item, { refresh: true })).stamp.path, item }
  }
  if (!a.file) throw new Error('Pass `item` (a PDF open in the canvas) or `file` (an absolute path).')
  if (!isAbsolute(a.file) || !existsSync(a.file)) throw new Error(`There is no file at ${a.file}.`)
  if (!hasMagic(a.file, 'pdf')) throw new Error(`${a.file} is not a PDF.`)
  return { path: a.file, item: null }
}

async function extract(ctx: ToolCtx, path: string, pages: string | undefined, tables = true): Promise<PdfExtract> {
  const done = await ctx.convert({ from: 'pdf', to: 'extract', input: path, options: { ...(pages ? { pages } : {}), ...(tables ? {} : { tables: false }) }, signal: ctx.signal })
  return JSON.parse(readFileSync(done.output, 'utf8')) as PdfExtract
}

/** A label read off the page is the paragraph beside the field: its first sentence or so is enough. */
export const labelOf = (text: string): string => (text.length > 120 ? `${text.slice(0, 119).trimEnd()}…` : text)

const describeField = (f: PdfField): string => {
  const shown = f.state === 'proposed' ? `proposed ${JSON.stringify(f.proposed)}` : f.value === null || f.value === '' ? 'empty' : JSON.stringify(f.value)
  const where = `p. ${f.page} [${f.bbox.map((n) => n.toFixed(3)).join(', ')}]`
  return `${f.key}  ${f.type}  ${JSON.stringify(f.label)}  ${where}  ${shown}${f.state === 'needs-owner' ? '  (the owner\'s)' : ''}${f.options ? `  options: ${f.options.join(' | ')}` : ''}`
}

const FillSchema = z.object({
  key: z.string().max(500).optional().describe('The field\'s name, from `pdf_fields`. Leave out to place a new box with `place`.'),
  place: z
    .object({
      page: z.number().int().positive(),
      bbox: BboxSchema.describe('x0, y0, x1, y1 as shares of the page from its top left, as `pdf_extract` gives them.'),
      label: z.string().min(1).max(200),
      type: z.enum(['text', 'checkbox', 'signature', 'date']).default('text')
    })
    .optional()
    .describe('A box on a page that has no field there: a flat form\'s line, the signature line, the date beside it.'),
  value: z.union([z.string().max(20_000), z.boolean()]).optional().describe('Text, or true or false for a checkbox. Never for a signature or its date.'),
  source: PdfProvenanceSchema.optional().describe('Where the value came from: `label` is what the person reads ("Purdue profile", "Run of show.docx, p. 2"), `quote` the words it was read from.')
})

export const pdfTools: WorkTool[] = [
  {
    name: 'pdf_extract',
    description:
      'Reads a PDF: its text in reading order and its tables, page by page, with where each passage is. ' +
      'Pass `item` for a PDF open in the canvas, or `file` for a path. `pages` is a list like "1-3,7" (40 pages at most a call; ask again for more). ' +
      'After each passage of a canvas item comes a code like `#pdf:…`: write `[p. 6, clause 7.2](#pdf:…)` in your reply and the person can click it to see the place. ' +
      'A page with no text layer is a scan: look at it with `pdf_page_image`.',
    input: z.object({ ...target, pages: z.string().max(200).optional(), format: z.enum(['markdown', 'json']).default('markdown') }),
    readOnly: true,
    run: async (args, ctx) => {
      const a = args as { item?: string; file?: string; pages?: string; format: 'markdown' | 'json' }
      try {
        const { path, item } = await fileOf(ctx, a)
        const x = await extract(ctx, path, a.pages)
        const cite = item ? (page: number, bbox: Bbox): string => pdfCiteHref({ itemId: item.id, page, bbox }) : undefined
        const body = a.format === 'json' ? JSON.stringify(x) : extractMarkdown(x, cite)
        const cut = body.length > ANSWER_MAX
        const head = `${x.pages} ${x.pages === 1 ? 'page' : 'pages'}${x.warnings.length ? `\n${x.warnings.join('\n')}` : ''}`
        return workText(`${head}\n\n${cut ? `${body.slice(0, ANSWER_MAX)}\n\n(Cut here: ask for fewer pages at a time.)` : body}`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'pdf_page_image',
    description: 'A picture of one page of a PDF, or of a region of it: for a scan with no text layer, a diagram, or a region the person selected. `region` is x0, y0, x1, y1 as shares of the page from its top left.',
    input: z.object({ ...target, page: z.number().int().positive(), region: BboxSchema.optional() }),
    readOnly: true,
    run: async (args, ctx) => {
      const a = args as { item?: string; file?: string; page: number; region?: Bbox }
      try {
        const { path } = await fileOf(ctx, a)
        const done = await ctx.convert({ from: 'pdf', to: 'png', input: path, options: { page: a.page, ...(a.region ? { crop: a.region } : {}) }, signal: ctx.signal })
        return { content: [{ type: 'image', data: readFileSync(done.output).toString('base64'), mimeType: 'image/png' }] }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'pdf_fields',
    description: 'Lists the fields of a PDF form open in the canvas: each field\'s name, kind, label, page and box, and what is in it. A form with no fields (a flat or scanned form) lists none: place boxes with `pdf_fill`.',
    input: z.object({ item: z.string() }),
    readOnly: true,
    run: async (args, ctx) => {
      const { item: id } = args as { item: string }
      try {
        const item = paneItem(ctx, ctx.sessionId, id, 'pdf')
        const { stamp, form } = await fieldsOfFile(ctx, item)
        const store = new PdfStore(ctx.db)
        const kept = store.keep(item)
        let note = ''
        // A form with no tooltips (the IRS's have none) is labelled from the words printed beside each field.
        if (form.fields.some((f) => !f.label) && !store.labels(kept.id, stamp.rev)) {
          try {
            const pages = [...new Set(form.fields.map((f) => f.page))].sort((x, y) => x - y).slice(0, 40)
            // Without tables: a form's ruled boxes read as tables, and the words printed in them are the labels.
            const x = await extract(ctx, stamp.path, pages.join(','), false)
            const labelled = labelFields(form.fields, x.blocks)
            store.setLabels(kept.id, kept.sessionId, stamp.rev, Object.fromEntries(labelled.flatMap((f) => (f.label ? [[f.key, labelOf(f.label)]] : []))))
          } catch (err) {
            note = `\n(The labels could not be read off the page: ${errorText(err)}. Read the page with pdf_extract and match each field by its box.)`
          }
        }
        const fields = store.fields(kept.id, form.fields, store.labels(kept.id, stamp.rev))
        if (form.xfaOnly) return fail('This form is XFA only: it has no fields that can be filled here. It opens in Adobe Reader.')
        if (fields.length === 0) return workText('This PDF has no form fields. To fill a flat form, place boxes on its lines with `pdf_fill` (`place`).')
        return { ...workText(`name  kind  label  place  value\n${fields.map(describeField).join('\n')}${note}`), structuredContent: { fields } }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'pdf_fill',
    description:
      'Puts values in a PDF form open in the canvas. Each value is a suggestion the person accepts or rejects from the bar (or lands at once when the item says "Agent writes"), and each needs `source`: where the value came from. ' +
      'Name a field by `key` (from `pdf_fields`), or place a new box with `place` on a page that has no field there. ' +
      'You never sign and never date a signature: place `type: "signature"` and `type: "date"` boxes where they go, with no value, and the person presses Sign.',
    input: z.object({ item: z.string(), fields: z.array(FillSchema).min(1).max(500) }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; fields: Array<z.infer<typeof FillSchema>> }
      try {
        const item = paneItem(ctx, ctx.sessionId, a.item, 'pdf')
        const { form } = await fieldsOfFile(ctx, item)
        if (form.xfaOnly) return fail('This form is XFA only: it has no fields that can be filled here.')
        const store = new PdfStore(ctx.db)
        const kept = store.keep(item)
        const by = agentPrincipal(ctx.host, ctx.sessionId)
        const places: FieldPlace[] = []
        const fills: FieldFill[] = []
        const refused: string[] = []
        a.fields.forEach((f, i) => {
          const n = `field ${i + 1}`
          if (!f.key && !f.place) return void refused.push(`${n}: name a field by key, or place a box`)
          const key = f.key ?? `box:${randomUUID().slice(0, 8)}`
          const owners = f.place?.type === 'signature' || f.place?.type === 'date'
          if (f.place) places.push({ key, type: f.place.type, label: f.place.label, page: f.place.page, bbox: f.place.bbox })
          if (f.value === undefined) {
            if (!f.place) refused.push(`${n} (${key}): no value given`)
            return
          }
          if (owners) return void refused.push(`${n}: the signature and its date are the owner's to place; leave the value out`)
          if (!f.source) return void refused.push(`${n} (${key}): say where the value came from (source)`)
          fills.push({ key, value: f.value, source: f.source as PdfProvenance })
        })
        const put = store.place(kept.id, kept.sessionId, places, by, form.fields)
        refused.push(...put.refused)
        // A value rides only into a box that was placed, or a field that is there.
        const placedNot = new Set(places.map((p) => p.key).filter((k) => !put.placed.includes(k)))
        const direct = store.mode(kept.id) === 'writes'
        const done = store.fill(kept.id, kept.sessionId, fills.filter((f) => !placedNot.has(f.key)), by, form.fields, direct)
        refused.push(...done.refused)
        await announce(ctx, item)
        const lines = [
          done.done.length ? `${direct ? 'Wrote' : 'Suggested'} ${done.done.length} ${done.done.length === 1 ? 'value' : 'values'}${direct ? '' : '; the person accepts each from the bar'}.` : '',
          put.placed.length ? `Placed ${put.placed.length} ${put.placed.length === 1 ? 'box' : 'boxes'}: ${places.filter((p) => put.placed.includes(p.key)).map((p) => `${p.key} (${p.type})`).join(', ')}.` : '',
          refused.length ? `Refused:\n${refused.join('\n')}` : ''
        ].filter(Boolean)
        const out = workText(lines.join('\n') || 'Nothing to do.')
        return done.done.length + put.placed.length === 0 ? { ...out, isError: true } : out
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'pdf_export',
    description:
      'Writes a copy of a PDF open in the canvas with the values the person accepted, the highlights, and the signature if the person signed, and answers the copy\'s path (to attach to a draft). `flatten` (the default) paints the fields into the page so the copy cannot be edited. Values that still wait for the person are not in it.',
    input: z.object({ item: z.string(), flatten: z.boolean().default(true) }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; flatten: boolean }
      try {
        const made = await exportCopy(ctx, paneItem(ctx, ctx.sessionId, a.item, 'pdf'), a.flatten)
        const lines = [`Wrote ${made.path}`, made.pending ? `${made.pending} ${made.pending === 1 ? 'value still waits' : 'values still wait'} for the person and ${made.pending === 1 ? 'is' : 'are'} not in the copy.` : '', ...made.warnings]
        return { ...workText(lines.filter(Boolean).join('\n')), structuredContent: { path: made.path, name: made.name, warnings: made.warnings, pending: made.pending } }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  }
]
