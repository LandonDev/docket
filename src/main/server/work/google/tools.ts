import { z } from 'zod'
import { agentPrincipal, workText, type CanvasItem, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { SheetCell } from 'work-kit/sheet/source'
import type { ToolCtx, WorkTool } from '../modules'
import { parseA1, READ_MAX_CELLS, rangeCells, cellName } from '../sheets/a1'
import { GOOGLE_MIME } from './client'
import { readDoc, suggestDoc, type GoogleSource } from './docs'
import { googleOf } from './google'
import { gridOf, googleSheetRefOf, suggest } from './grid'
import { deckText, readDeck, reviseCopy } from './slides'

/**
 * The agents' Google tools (docs/agents/work-google.md "The tools"). A
 * thread reaches a Google file only through an item of its own canvas, one
 * he opened from the Picker. Every change an agent makes reaches him as a
 * suggestion: in a Doc a Google suggestion (Google's own suggest mode), in a
 * Sheet a suggestion in the grid he accepts as one write, in a deck a
 * revised copy. Letting someone into a file waits for his press.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })

function itemOf(ctx: ToolCtx, id: string, mime: string, what: string): CanvasItem & { source: GoogleSource } {
  const item = ctx.canvas.get(id)
  if (!item || item.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new Error(`This thread has no item ${id} in its canvas.`)
  if (item.source.at !== 'google' || (mime && item.source.mime !== mime)) throw new Error(`${item.title} is not a Google ${what}.`)
  return item as CanvasItem & { source: GoogleSource }
}

const Item = z.string().max(200).describe('The canvas item: a Google file open in this thread.')

const tool = <S extends z.ZodRawShape>(t: { name: string; description: string; input: S; readOnly: boolean; run(a: z.infer<z.ZodObject<S>>, ctx: ToolCtx): Promise<WorkToolResult> }): WorkTool => ({
  name: t.name,
  description: t.description,
  input: z.object(t.input),
  readOnly: t.readOnly,
  async run(args, ctx) {
    try {
      return await t.run(args as z.infer<z.ZodObject<S>>, ctx)
    } catch (err) {
      return fail(errorText(err))
    }
  }
})

/** A cell an agent writes: a formula when it starts with `=`, else the value. */
const cellOf = (v: string | number | boolean | null): SheetCell | null => (v === null || v === '' ? null : typeof v === 'string' && v.startsWith('=') ? { f: v } : { v })

export const GOOGLE_TOOLS: WorkTool[] = [
  tool({
    name: 'google_doc_read',
    description: 'Reads a Google Doc open in the canvas as Google has it now: its words by paragraph, then its open comments and the suggestions waiting in it.',
    input: { item: Item },
    readOnly: true,
    run: async (a, ctx) => workText(await readDoc(googleOf(ctx), itemOf(ctx, a.item, GOOGLE_MIME.doc, 'Doc').source))
  }),
  tool({
    name: 'google_doc_suggest',
    description:
      "Suggests changes in a Google Doc: each edit replaces the words in `find` (quoted exactly, standing once in the Doc) with `replace` (empty to remove them). They go to Google as suggestions in his name's place for this thread; he accepts or rejects them in Google or in the canvas. Read the Doc first.",
    input: { item: Item, edits: z.array(z.object({ find: z.string().min(1).max(5_000), replace: z.string().max(20_000) })).min(1).max(50) },
    readOnly: false,
    async run(a, ctx) {
      const item = itemOf(ctx, a.item, GOOGLE_MIME.doc, 'Doc')
      const n = await suggestDoc(googleOf(ctx), item.source, a.edits)
      ctx.results.add({ sessionId: ctx.sessionId, kind: 'google.doc.suggest', summary: `Suggested ${n} ${n === 1 ? 'change' : 'changes'} in ${item.title}`, account: item.source.account, ref: { at: 'google', fileId: item.source.fileId } })
      return workText(`Suggested ${n} ${n === 1 ? 'change' : 'changes'} in ${item.title}. They wait in Google for the owner.`)
    }
  }),
  tool({
    name: 'google_sheet_read',
    description: "Reads cells of a Google Sheet open in the canvas, as Google has them now: `range` in A1 with the sheet's name ('Q1'!A1:D20). A formula cell shows its formula and its value.",
    input: { item: Item, range: z.string().max(200) },
    readOnly: true,
    async run(a, ctx) {
      const item = itemOf(ctx, a.item, GOOGLE_MIME.sheet, 'Sheet')
      const r = parseA1(a.range)
      if (!r || r.sheet === undefined) return fail(`Name the sheet and the cells: 'Sheet1'!A1:D20.`)
      if (rangeCells(r) > READ_MAX_CELLS) return fail(`Read at most ${READ_MAX_CELLS} cells at a time.`)
      const { grid, order } = gridOf(await googleOf(ctx).api(item.source.account).sheet(item.source.fileId))
      const sheet = grid.get(r.sheet)
      if (!sheet) return fail(`There is no sheet "${r.sheet}": the sheets are ${order.map((s) => `"${s}"`).join(', ')}.`)
      const rows: unknown[][] = []
      for (let y = r.startRow; y <= r.endRow; y++) {
        const row: unknown[] = []
        for (let x = r.startColumn; x <= r.endColumn; x++) {
          const c = sheet.get(cellName(y, x))
          row.push(c ? (c.f ? { f: c.f, v: c.v ?? null } : (c.v ?? null)) : null)
        }
        rows.push(row)
      }
      return workText(JSON.stringify({ range: a.range, rows }))
    }
  }),
  tool({
    name: 'google_sheet_suggest',
    description:
      "Suggests cell changes in a Google Sheet open in the canvas: `cells` maps each cell, with its sheet ('Q1'!B4), to its new value or formula (starting with `=`), null to clear it. They wait in the grid as one change set he accepts, written to Google as one update, or rejects.",
    input: {
      item: Item,
      cells: z.record(z.string().max(200), z.union([z.string().max(32_000), z.number(), z.boolean(), z.null()])),
      reason: z.string().max(500).optional().describe('One line he reads beside the change set.')
    },
    readOnly: false,
    async run(a, ctx) {
      const item = itemOf(ctx, a.item, GOOGLE_MIME.sheet, 'Sheet')
      const ref = googleSheetRefOf(item.source)!
      const cells = Object.entries(a.cells).map(([at, v]) => {
        const r = parseA1(at)
        if (!r || r.sheet === undefined || rangeCells(r) !== 1) throw new Error(`${at} is not one cell with its sheet: write 'Sheet1'!B4.`)
        return { sheet: r.sheet, row: r.startRow, col: r.startColumn, value: cellOf(v) }
      })
      if (!cells.length) return fail('Name at least one cell.')
      const got = await suggest(ctx, { ...ref, name: item.title }, agentPrincipal(ctx.host, ctx.sessionId), a.reason, cells)
      return workText(`Suggested ${got.count} ${got.count === 1 ? 'cell' : 'cells'} in ${item.title}; they wait in the grid for the owner.`)
    }
  }),
  tool({
    name: 'google_slides_read',
    description: 'Reads a Google Slides deck open in the canvas: the words of each slide, each shape with its id in brackets.',
    input: { item: Item },
    readOnly: true,
    async run(a, ctx) {
      const item = itemOf(ctx, a.item, GOOGLE_MIME.slides, 'Slides deck')
      return workText(deckText(await readDeck(googleOf(ctx), item.source.account, item.source.fileId)))
    }
  }),
  tool({
    name: 'google_slides_revise',
    description:
      "Revises a copy of a Google Slides deck, never the deck itself (Slides has no suggestions): each edit either replaces words everywhere (`find`, `replace`) or sets one shape's words (`shape` id from google_slides_read, `text`). Answers the copy's link, which the owner opens to take or leave it.",
    input: {
      item: Item,
      edits: z
        .array(z.union([z.object({ find: z.string().min(1).max(5_000), replace: z.string().max(20_000) }), z.object({ shape: z.string().max(200), text: z.string().max(20_000) })]))
        .min(1)
        .max(100)
    },
    readOnly: false,
    async run(a, ctx) {
      const item = itemOf(ctx, a.item, GOOGLE_MIME.slides, 'Slides deck')
      const copy = await reviseCopy(googleOf(ctx), item.source.account, item.source.fileId, `${item.title} (revised)`, a.edits)
      const url = copy.webViewLink ?? `https://docs.google.com/presentation/d/${copy.id}/edit`
      ctx.results.add({ sessionId: ctx.sessionId, kind: 'google.slides.copy', summary: `Revised a copy of ${item.title}`, account: item.source.account, ref: { at: 'google', fileId: copy.id, url } })
      return workText(`Made "${copy.name}" with ${a.edits.length} ${a.edits.length === 1 ? 'edit' : 'edits'}: ${url}. The deck itself is unchanged.`)
    }
  }),
  tool({
    name: 'google_share',
    description: "Asks to let someone into a Google file open in the canvas, as `reader`, `commenter` or `writer`. It waits in the Outbox for the owner's press; nothing changes in Google before it.",
    input: { item: Item, email: z.string().max(320), role: z.enum(['reader', 'commenter', 'writer']), notify: z.boolean().default(true) },
    readOnly: false,
    async run(a, ctx) {
      const item = itemOf(ctx, a.item, '', 'file')
      const held = ctx.held.create({ kind: 'share.google', sessionId: ctx.sessionId, account: item.source.account, payload: { account: item.source.account, fileId: item.source.fileId, name: item.title, email: a.email, role: a.role, notify: a.notify } })
      return workText(held.state === 'held' ? `Held for the owner: ${held.summary}` : `${held.summary}.`)
    }
  }),
  tool({
    name: 'google_unshare',
    description: 'Takes someone back out of a Google file: the way back of a share the owner allowed.',
    input: { account: z.string().max(320), fileId: z.string().max(200), permissionId: z.string().max(200) },
    readOnly: false,
    async run(a, ctx) {
      await googleOf(ctx).api(a.account).unshare(a.fileId, a.permissionId)
      return workText('They no longer have access.')
    }
  })
]
