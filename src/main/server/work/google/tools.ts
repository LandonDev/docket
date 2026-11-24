import { z } from 'zod'
import { agentPrincipal, workText, type CanvasItem, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { SheetCell } from 'work-kit/sheet/source'
import type { ToolCtx, WorkTool } from '../modules'
import { parseA1, READ_MAX_CELLS, rangeCells, cellName } from '../sheets/a1'
import { GOOGLE_MIME } from './client'
import { checkEdits, readDoc, type GoogleSource } from './docs'
import { googleOf } from './google'
import { gridOf, googleSheetRefOf, suggest } from './grid'
import type { GoogleEdit } from './held'
import { checkDeckEdits, deckText, readDeck } from './slides'

/**
 * The agents' Google tools (docs/agents/work-google.md "The tools"). A
 * thread reaches a Google file only through an item of its own canvas, one
 * he opened from the Picker. Every change an agent makes waits on his host,
 * seen by nobody else, until he approves it (the owner's ruling of
 * 2026-11-23): a Sheet's cells as suggestions in the grid he accepts as one
 * write, a Doc's or a deck's words as a held `google.edit` his press makes in
 * the file. Nothing of it goes to Google before: no Google suggestion, no
 * comment, no copy. Letting someone into a file waits for his press too.
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

/** An agent's change, held on this host for his press: nothing of it is in Google until then. */
function held(ctx: ToolCtx, edit: GoogleEdit): WorkToolResult {
  const item = ctx.held.create({ kind: 'google.edit', sessionId: ctx.sessionId, account: edit.account, payload: edit })
  return workText(`Held for the owner: "${item.summary}". Nothing went to Google and nobody else sees it; it is written only when he approves it.`)
}

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
      "Suggests changes in a Google Doc: each edit replaces the words in `find` (quoted exactly, standing once in the Doc) with `replace` (empty to remove them). Nothing goes to Google: they wait for the owner, seen by nobody else, and are written into the Doc as plain edits only when he approves them. Read the Doc first.",
    input: { item: Item, edits: z.array(z.object({ find: z.string().min(1).max(5_000), replace: z.string().max(20_000) })).min(1).max(50) },
    readOnly: false,
    async run(a, ctx) {
      const item = itemOf(ctx, a.item, GOOGLE_MIME.doc, 'Doc')
      const { revisionId, within, tabs } = await checkEdits(googleOf(ctx), item.source, a.edits)
      return held(ctx, { app: 'doc', account: item.source.account, fileId: item.source.fileId, name: item.title, edits: a.edits.map((e, i) => ({ ...e, within: within[i], tab: tabs[i] })), revisionId })
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
      "Revises a Google Slides deck: each edit either replaces words everywhere (`find`, `replace`) or sets one shape's words (`shape` id from google_slides_read, `text`). Nothing goes to Google: the edits wait for the owner, seen by nobody else, and are made in the deck only when he approves them.",
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
      const got = await checkDeckEdits(googleOf(ctx), item.source.account, item.source.fileId, a.edits)
      return held(ctx, { app: 'slides', account: item.source.account, fileId: item.source.fileId, name: item.title, edits: got.held, revisionId: got.revisionId })
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
    description: 'Takes someone back out of a Google file: the way back of a share the owner allowed this thread.',
    input: { account: z.string().max(320), fileId: z.string().max(200), permissionId: z.string().max(200) },
    readOnly: false,
    async run(a, ctx) {
      // Only a share his press let through for this thread's tree: never anyone else's access.
      const row = ctx.db.prepare('SELECT session_id FROM work_google_shares WHERE account = ? AND file_id = ? AND permission_id = ?').get(a.account.toLowerCase(), a.fileId, a.permissionId) as
        | { session_id: string | null }
        | undefined
      if (!row?.session_id || ctx.canvas.paneOf(row.session_id) !== ctx.canvas.paneOf(ctx.sessionId)) return fail('That share was not made for this thread.')
      await googleOf(ctx).api(a.account).unshare(a.fileId, a.permissionId)
      ctx.db.prepare('DELETE FROM work_google_shares WHERE account = ? AND file_id = ? AND permission_id = ?').run(a.account.toLowerCase(), a.fileId, a.permissionId)
      return workText('They no longer have access.')
    }
  })
]
