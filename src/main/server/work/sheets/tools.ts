import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SheetCellJson, SheetSuggestion } from '@shared/contract-work-sheets'
import { agentPrincipal, workText, type CanvasItem, type Principal, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ToolCtx, WorkTool } from '../modules'
import { parseA1 } from './a1'
import { heldOf, heldOfPath, host, sheetsOf, storeKey, type Held, type Sheets } from './held'
import type { A1Cell } from './host/wire'
import { mutationsOf } from './mutations'
import { PACKAGE_UNIT } from './packages'

/**
 * The tools a Work thread reads and changes a sheet with
 * (docs/agents/work-sheets.md "The tools"). Cells are A1. The rule
 * (architecture §6.7, the owner's): a change the owner asked for, or one a
 * routine was granted, is written at once; an agent's own idea on a sheet
 * others share waits as a suggestion; on his own sheet it follows the
 * sheet's mode (written, with Undo, unless he set it to suggest).
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
/** The most cells one write or suggestion carries. */
export const WRITE_MAX = 1000

const target = {
  item: z.string().optional().describe("The id of a sheet item in this thread's canvas (from `canvas_open` or `sheet_create`)."),
  file: z.string().optional().describe('An absolute path to an .xlsx, .xlsm or .tcsheet on this host, when it is not open in the canvas.')
}
const CellSchema = z.object({
  at: z.string().min(2).max(300).describe("One cell: B4, or 'Q1 Budget'!B4 for another tab."),
  v: z.union([z.string().max(32_000), z.number(), z.boolean(), z.null()]).optional().describe('A value; null empties the cell.'),
  f: z.string().max(8_000).optional().describe('A formula, with or without the leading =.')
})

interface Target {
  held: Held
  item: CanvasItem | null
  /** others can edit it */
  shared: boolean
}

/**
 * The sheet a call names, and whether others can edit it: a LifeOS sheet's own `shared` (the
 * service reads it), or what the scope says of the source (a guest link, a Microsoft or Google file).
 */
async function targetOf(ctx: ToolCtx, a: { item?: string; file?: string }): Promise<Target> {
  let item: CanvasItem | null = null
  let held: Held
  let source: CanvasItem['source']
  if (a.item) {
    item = ctx.canvas.get(a.item)
    if (!item || item.kind !== 'sheet' || item.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new Error(`This thread has no sheet ${a.item} in its canvas.`)
    held = heldOf(item)
    source = item.source
  } else {
    if (!a.file) throw new Error('Pass `item` (a sheet open in the canvas) or `file` (an absolute path).')
    held = heldOfPath(a.file)
    source = { at: 'file', host: ctx.host, path: a.file }
  }
  const stored = held.at === 'service' ? (await host(ctx, 'open', { sheet: held.ref })).shared : false
  return { held, item, shared: stored || ctx.scope.shared(source) }
}

function ownerSaid(ctx: ToolCtx, quote: string | undefined): boolean {
  if (!quote) return false
  try {
    return ctx.threads.ownerSaid(ctx.sessionId, quote)
  } catch {
    return false
  }
}

const show = (c: { at: string; v?: unknown; f?: string }): string => (c.f !== undefined ? `${c.at} ${c.f}${c.v !== undefined ? ` = ${JSON.stringify(c.v)}` : ''}` : c.v !== undefined ? `${c.at} ${JSON.stringify(c.v)}` : '')

async function announceItem(s: Sheets, item: CanvasItem | null): Promise<void> {
  if (!item) return
  const { announce } = await import('./index')
  await announce(s, item)
}

/** Writes accepted suggestions over a package: what each proposed, as the owner's own edit. */
export async function writeAccepted(s: Sheets, path: string, decided: readonly SheetSuggestion[], by: Principal): Promise<void> {
  const state = await s.packages.open(path)
  const mutations = mutationsOf(
    PACKAGE_UNIT,
    decided.map((d) => ({ sheet: d.sheet, row: d.row, col: d.col, cell: d.proposed }))
  )
  const got = await s.packages.edit(path, state.rev, mutations, by, { label: `Accepted ${decided.length === 1 ? '1 change' : `${decided.length} changes`}` })
  if ('conflict' in got) throw new Error('The file changed while accepting: try again.')
}

/** The agent's cells as suggestions over a package: by Univer sheet id and zero-based cell, with what is there now as the base. */
async function suggestOnPackage(s: Sheets, path: string, cells: readonly A1Cell[], by: Principal, reason: string | undefined): Promise<string> {
  const st = await s.packages.open(path)
  const at = cells.map((c) => {
    const r = parseA1(c.at)
    if (!r || r.startRow !== r.endRow || r.startColumn !== r.endColumn) throw new Error(`${c.at} is not one cell.`)
    const sheet = r.sheet === undefined ? st.inspected.sheets[0] : st.inspected.sheets.find((x) => x.name === r.sheet)
    if (!sheet) throw new Error(`There is no sheet named ${r.sheet}.`)
    const proposed: SheetCellJson | null = c.f !== undefined ? { f: c.f.startsWith('=') ? c.f : `=${c.f}` } : c.v === undefined || c.v === null || c.v === '' ? null : { v: c.v }
    return { sheet: sheet.id, row: r.startRow, col: r.startColumn, proposed }
  })
  const base = await s.packages.cellsAt(path, at)
  const changeSet = randomUUID()
  s.suggestions.add(
    `file:${path}`,
    changeSet,
    by,
    reason,
    at.map((c, i) => ({ ...c, base: base[i].cell }))
  )
  return changeSet
}

export const sheetTools: WorkTool[] = [
  {
    name: 'sheet_read',
    description:
      'Reads cells of a sheet: each cell\'s value, and its formula when it has one. `range` is A1 (B4:D9, or \'Q1 Budget\'!A1:F40 for another tab; at most 10,000 cells a call). ' +
      'Pass `item` for a sheet open in the canvas, or `file` for an .xlsx, .xlsm or .tcsheet path.',
    input: z.object({ ...target, range: z.string().min(2).max(300) }),
    readOnly: true,
    run: async (args, ctx) => {
      const a = args as { item?: string; file?: string; range: string }
      try {
        const t = await targetOf(ctx, a)
        const s = await sheetsOf(ctx)
        const got = t.held.at === 'package' ? await s.packages.read(t.held.path, a.range) : await host(ctx, 'range', { sheet: t.held.ref, range: a.range })
        const lines = got.cells.map((row) => row.map(show).filter(Boolean).join('  |  ')).filter(Boolean)
        return workText(`${got.sheet}\n${lines.length ? lines.join('\n') : '(every cell in that range is empty)'}`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'sheet_write',
    description:
      'Changes cells of a sheet. Say why: `because: "asked"` with `quote`, the owner\'s own words asking for this change, writes at once; `"routine"` writes at once when this thread runs a routine; `"own"` is your own idea: ' +
      'on a sheet others share it waits as a suggestion the owner steps through, on his own sheet it is written and he can take it back. ' +
      `At most ${WRITE_MAX} cells a call. A value of null empties a cell.`,
    input: z.object({
      ...target,
      cells: z.array(CellSchema).min(1).max(WRITE_MAX),
      because: z.enum(['asked', 'routine', 'own']),
      quote: z.string().max(2000).optional().describe('With "asked": the owner\'s words, as he typed them in this thread.'),
      reason: z.string().max(300).optional().describe('One line the owner reads beside a suggestion: why this change.')
    }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item?: string; file?: string; cells: A1Cell[]; because: 'asked' | 'routine' | 'own'; quote?: string; reason?: string }
      try {
        const t = await targetOf(ctx, a)
        const s = await sheetsOf(ctx)
        const key = storeKey(t.held)
        const asked = a.because === 'asked' && ownerSaid(ctx, a.quote)
        const routine = a.because === 'routine' && !!ctx.scope.routineRunId
        const writes = asked || routine || (!t.shared && s.suggestions.mode(key) === 'writes')
        const note = a.because === 'asked' && !asked ? ' The quote was not found among the owner\'s words in this thread, so this counts as your own idea.' : a.because === 'routine' && !routine ? ' This thread runs no routine, so this counts as your own idea.' : ''
        const by = agentPrincipal(ctx.host, ctx.sessionId)
        const label = `Wrote ${a.cells.length === 1 ? a.cells[0].at : `${a.cells.length} cells`}`
        if (!writes) {
          const count = await suggest(s, t, a.cells, by, a.reason)
          await announceItem(s, t.item)
          return workText(`Suggested ${count === 1 ? '1 cell' : `${count} cells`}: ${t.shared ? 'others share this sheet, so' : 'the sheet is set to suggest, so'} the owner accepts or rejects each change.${note}`)
        }
        const writeId = randomUUID()
        if (t.held.at === 'package') await s.packages.writeCells(t.held.path, a.cells, by, label, writeId)
        else await host(ctx, 'cells', { sheet: t.held.ref, cells: a.cells, by, label, suggest: false })
        // His own sheet, on the agent's own idea: the bar says what was written, with Undo.
        if (!asked && !routine) s.suggestions.setWritten(key, { id: writeId, text: label, at: Date.now() })
        await announceItem(s, t.item)
        return workText(`${label}.${note}`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'sheet_suggest',
    description:
      'Proposes cell changes the owner accepts or rejects one cell, or one run of neighbouring cells, at a time. Nothing in the sheet changes until he accepts. ' +
      `Cells in A1, at most ${WRITE_MAX} a call; \`reason\` is one line he reads beside them.`,
    input: z.object({ ...target, cells: z.array(CellSchema).min(1).max(WRITE_MAX), reason: z.string().max(300).optional() }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item?: string; file?: string; cells: A1Cell[]; reason?: string }
      try {
        const t = await targetOf(ctx, a)
        const s = await sheetsOf(ctx)
        const count = await suggest(s, t, a.cells, agentPrincipal(ctx.host, ctx.sessionId), a.reason)
        await announceItem(s, t.item)
        return workText(`Suggested ${count === 1 ? '1 cell' : `${count} cells`}; the owner steps through them in the sheet.`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'sheet_create',
    description: 'Makes a new, empty sheet and opens it in this thread\'s canvas: a LifeOS sheet when this workspace is linked to a sector, else a .tcsheet file. Answers its item id.',
    input: z.object({ title: z.string().min(1).max(200) }),
    readOnly: false,
    run: async (args, ctx) => {
      try {
        const { createSheet } = await import('./index')
        const item = await createSheet(await sheetsOf(ctx), ctx.sessionId, (args as { title: string }).title)
        return workText(`Opened ${item.title} as item ${item.id}.`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  }
]

async function suggest(s: Sheets, t: Target, cells: readonly A1Cell[], by: Principal, reason: string | undefined): Promise<number> {
  if (t.held.at === 'package') {
    await suggestOnPackage(s, t.held.path, cells, by, reason)
    return cells.length
  }
  return (await host(s.ctx, 'cells', { sheet: t.held.ref, cells: [...cells], by, label: 'Suggested', suggest: true, ...(reason ? { reason } : {}) })).count
}
