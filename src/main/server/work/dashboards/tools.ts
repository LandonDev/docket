import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DASH_AGGS, DASH_BLOCKS_MAX, DASH_FORMATS, type DashFigure, type DashSheet } from '@shared/contract-work-dashboards'
import { agentPrincipal, workText, type CanvasItem, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ToolCtx, WorkTool } from '../modules'
import { announce, DashError, dashItem, dashRow, DashStore, refresh, sheetInfo, type DashRow, type StoredBlock } from './dash'

/**
 * The tools a Work thread builds and refreshes a dashboard with
 * (docs/agents/work-dashboards.md "The tools"). A block an agent adds waits
 * for the owner's Accept; a refresh, which a routine runs, reads the same
 * blocks again and needs nobody.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const item = z.string().describe("The id of a dashboard in this thread's canvas (from `dashboard_create` or `canvas_open`).")
const sheet = z
  .string()
  .min(1)
  .max(1000)
  .describe("The sheet to read: a sheet's id in this thread's canvas, `lifeos:<sheet id>`, or a .tcsheet file's absolute path.")
const range = z.string().min(2).max(300).describe("A1, with the tab when it is not the first: 'Invoices'!E2:E48")
const counts = z.string().min(1).max(200).describe('What the number counts, in words the owner reads: "Amount, summed where Status is not Paid".')
const format = z.enum(DASH_FORMATS).default('number')

const Figure = z.union([
  z.object({ label: z.string().min(1).max(60), sub: z.string().max(80).optional(), format, sheet, range, agg: z.enum(DASH_AGGS).default('cell'), counts }),
  z.object({
    label: z.string().min(1).max(60),
    sub: z.string().max(80).optional(),
    format: z.enum(DASH_FORMATS).default('text'),
    service: z.string().min(1).max(60).describe('Where the number came from when it is not a sheet: "Stripe".'),
    counts,
    value: z.string().max(60)
  })
])
const Block = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('heading'), text: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal('figures'), figures: z.array(Figure).min(1).max(3) }),
  z.object({ kind: z.literal('chart'), title: z.string().min(1).max(120), sheet, labels: range, values: range, counts, format }),
  z.object({ kind: z.literal('table'), title: z.string().min(1).max(120), sheet, range, counts })
])

function paneDash(ctx: ToolCtx, id: string): CanvasItem {
  const it = dashItem(ctx, id)
  if (it.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new DashError(`This thread has no dashboard ${id}.`)
  return it
}

/** The sheet an agent names, as the sheet kind opens it, with its name. */
async function sheetOf(ctx: ToolCtx, name: string): Promise<{ sheet: DashSheet; title: string }> {
  let s: DashSheet
  if (name.startsWith('lifeos:')) s = { at: 'lifeos', table: 'sheets', id: name.slice('lifeos:'.length) }
  else if (isAbsolute(name)) s = { at: 'file', host: ctx.host, path: name }
  else {
    const it = ctx.canvas.get(name)
    if (!it || it.kind !== 'sheet' || it.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new DashError(`This thread has no sheet ${name} in its canvas.`)
    if (it.source.at === 'lifeos' && it.source.table === 'sheets') s = { at: 'lifeos', table: 'sheets', id: it.source.id }
    else if (it.source.at === 'file') s = { at: 'file', host: it.source.host, path: it.source.path }
    else throw new DashError(`${it.title} is not a sheet a dashboard can read.`)
  }
  return { sheet: s, title: (await sheetInfo(ctx, s)).title }
}

async function blockOf(ctx: ToolCtx, b: z.infer<typeof Block>, proposed: StoredBlock['proposed']): Promise<StoredBlock> {
  const id = randomUUID().slice(0, 8)
  if (b.kind === 'heading' || b.kind === 'text') return { id, kind: b.kind, text: b.text, proposed }
  if (b.kind === 'figures') {
    const figures: DashFigure[] = []
    for (const f of b.figures) {
      const fid = randomUUID().slice(0, 8)
      if ('service' in f) figures.push({ id: fid, label: f.label, sub: f.sub, format: f.format, from: { service: f.service, counts: f.counts }, value: f.value })
      else {
        const { sheet, title } = await sheetOf(ctx, f.sheet)
        figures.push({ id: fid, label: f.label, sub: f.sub, format: f.format, from: { sheet, sheetTitle: title, range: f.range, counts: f.counts, agg: f.agg }, value: null })
      }
    }
    return { id, kind: 'figures', figures, proposed }
  }
  const { sheet, title } = await sheetOf(ctx, b.sheet)
  if (b.kind === 'chart') return { id, kind: 'chart', title: b.title, from: { sheet, sheetTitle: title, range: b.values, labels: b.labels, counts: b.counts }, format: b.format, bars: [], proposed }
  return { id, kind: 'table', title: b.title, from: { sheet, sheetTitle: title, range: b.range, counts: b.counts }, head: [], rows: [], numeric: [], proposed }
}

/** The page as an agent reads it: each block's id, what it shows, and what waits for the owner. */
export function outline(row: DashRow): string {
  const lines = [`${row.title} (dashboard ${row.itemId})${row.asOf ? `, as of ${new Date(row.asOf).toISOString()}` : ', not read yet'}`]
  if (row.failed) lines.push(`The last read failed: ${row.failed}`)
  for (const b of row.blocks) {
    const wait = b.proposed ? '  (waiting for his Accept)' : ''
    if (b.kind === 'heading') lines.push(`\n## ${b.text}  [${b.id}]${wait}`)
    else if (b.kind === 'text') lines.push(`${b.text}  [${b.id}]${wait}`)
    else if (b.kind === 'figures') lines.push(...b.figures.map((f) => `- ${f.label}: ${f.value ?? '(no value)'}${f.sub ? ` (${f.sub})` : ''}  [${b.id}/${f.id}]${wait}`))
    else if (b.kind === 'chart') lines.push(`${b.title}: ${b.bars.map((x) => `${x.label} ${x.value}`).join(', ')}  [${b.id}]${wait}`)
    else lines.push(`${b.title}: ${b.rows.length} row(s) under ${b.head.join(' | ')}  [${b.id}]${wait}`)
  }
  return lines.join('\n')
}

export const dashboardsTools: WorkTool[] = [
  {
    name: 'dashboard_create',
    description: 'Makes an empty dashboard and opens it in the canvas. Add its blocks with `dashboard_add`.',
    input: z.object({ title: z.string().min(1).max(200) }),
    readOnly: false,
    run: async (args, ctx) => {
      try {
        const title = (args as { title: string }).title
        const it = ctx.canvas.open(ctx.canvas.paneOf(ctx.sessionId), 'dashboard', { at: 'thread' }, title)
        new DashStore(ctx.db).create(it.id, it.sessionId, title)
        return { ...workText(`Made ${title} (dashboard ${it.id}).`), structuredContent: { item: it.id } }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'dashboard_read',
    description: 'Reads a dashboard: each block with its id and what it shows, and when it was last read.',
    input: z.object({ item }),
    readOnly: true,
    run: async (args, ctx) => {
      try {
        return workText(outline(dashRow(ctx, paneDash(ctx, (args as { item: string }).item))))
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'dashboard_add',
    description:
      'Proposes a block for a dashboard: a heading, a line of text, up to three figures, one plain chart (one series), or a flat table. Every number comes from a sheet\'s range (or, for a figure, a service you name), with what it counts in words. ' +
      'The block waits for the owner to Accept it, even on his own dashboard; the page is read again as it is added.',
    input: z.object({ item, block: Block, after: z.string().optional().describe('The id of the block it follows; absent: at the end.'), reason: z.string().max(300).optional() }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; block: z.infer<typeof Block>; after?: string; reason?: string }
      try {
        const it = paneDash(ctx, a.item)
        const row = dashRow(ctx, it)
        if (row.blocks.length >= DASH_BLOCKS_MAX) return fail(`A dashboard holds at most ${DASH_BLOCKS_MAX} blocks.`)
        const block = await blockOf(ctx, a.block, { by: agentPrincipal(ctx.host, ctx.sessionId), reason: a.reason, at: Date.now() })
        const at = a.after ? row.blocks.findIndex((b) => b.id === a.after) + 1 : row.blocks.length
        const blocks = [...row.blocks.slice(0, at || row.blocks.length), block, ...row.blocks.slice(at || row.blocks.length)]
        const next = await refresh(ctx, it, blocks, 'list')
        await announce(ctx, next)
        if (next.failed) return fail(`The block was added, but the page could not be read: ${next.failed}`)
        return workText(`Proposed; it waits for his Accept.\n\n${outline(next)}`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'dashboard_refresh',
    description:
      "Reads every block of a dashboard again, now. A routine that keeps a dashboard current calls this. Give `values` for figures that come from a service (by the figure's id from dashboard_read); figures from sheets are read from their ranges.",
    input: z.object({ item, values: z.array(z.object({ figure: z.string(), value: z.string().max(60) })).max(60).optional() }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; values?: { figure: string; value: string }[] }
      try {
        const it = paneDash(ctx, a.item)
        const row = dashRow(ctx, it)
        const given = new Map((a.values ?? []).map((v) => [v.figure, v.value]))
        const blocks = row.blocks.map((b) =>
          b.kind === 'figures' ? { ...b, figures: b.figures.map((f) => ('service' in f.from && given.has(f.id) ? { ...f, value: given.get(f.id)! } : f)) } : b
        )
        const next = await refresh(ctx, it, blocks)
        await announce(ctx, next)
        return next.failed ? fail(`The page could not be read: ${next.failed}`) : workText(outline(next))
      } catch (err) {
        return fail(errorText(err))
      }
    }
  }
]
