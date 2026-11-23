import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SheetCellJson, SheetMutationJson, SheetSuggestion } from '@shared/contract-work-sheets'
import { agentPrincipal, workText, type CanvasItem, type Principal, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import { sharedOf } from '../files/policy'
import type { ToolCtx, WorkTool } from '../modules'
import { parseA1 } from './a1'
import { agentFormat, FORMAT_MAX_CELLS, FormatSchema, formatWords, heldOfPackage, place, ruleClash, ruleListMutation, ruleModel, ruleMutations, RuleSchema, ruleWords, where, type FormatAsk, type Placed, type RuleAsk } from './asks'
import type { RulesHeld } from './host/wire'
import type { ChangeAsk } from './changes'
import { ensureImported } from './formatsIn'
import { ensureCsvSheet, heldOf, heldOfPath, host, sheetsOf, storeKey, type Held, type Sheets } from './held'
import type { A1Cell } from './host/wire'
import { mutationsOf } from './mutations'
import { PACKAGE_UNIT } from './packages'
import { waitsNote } from './excelWaits'

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
  held: Exclude<Held, { at: 'excel' | 'google' }>
  item: CanvasItem | null
  /** others can edit it */
  shared: boolean
}

/**
 * The sheet a call names, and whether others can open it: a LifeOS sheet's own `shared` (the
 * service reads it), what Files says of where the file lies (a Teams or OneDrive library, a cloud
 * folder, another host: `sharedOf`, the test the grid's view uses), or what the scope says of the
 * source (a guest link, a Microsoft or Google file).
 */
async function targetOf(ctx: ToolCtx, a: { item?: string; file?: string }): Promise<Target> {
  let item: CanvasItem | null = null
  let held: Exclude<Held, { at: 'excel' | 'google' }>
  let source: CanvasItem['source']
  if (a.item) {
    item = ctx.canvas.get(a.item)
    if (!item || item.kind !== 'sheet' || item.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new Error(`This thread has no sheet ${a.item} in its canvas.`)
    const h = heldOf(item, ctx.dataDir)
    if (h.at === 'excel') throw new Error(`${item.title} lives in Excel: read and write it with office_range_read and office_range_write.`)
    if (h.at === 'google') throw new Error(`${item.title} lives in Google: read it with google_sheet_read and suggest cells with google_sheet_suggest.`)
    held = h
    source = item.source
    // (a thread's own item no window ever showed is held here: a shared workbook's copies go with the thread)
    if (held.at === 'package') (await sheetsOf(ctx)).packages.hold(held.path, item.id, ctx.sessionId)
  } else {
    if (!a.file) throw new Error('Pass `item` (a sheet open in the canvas) or `file` (an absolute path).')
    held = heldOfPath(a.file, ctx.dataDir)
    source = { at: 'file', host: ctx.host, path: a.file }
    // Read by its path, with no tab: this thread holds what is kept of it (a shared workbook's copies go with the thread).
    if (held.at === 'package') (await sheetsOf(ctx)).packages.hold(held.path, '', ctx.sessionId)
  }
  ensureCsvSheet(held, ctx.dataDir)
  // An .xls, .ods or .tsv is read and written through its Excel copy (formatsIn.ts); the file changes by his press alone.
  await ensureImported(ctx, held)
  const stored = held.at === 'service' ? (await host(ctx, 'open', { sheet: held.ref })).shared : false
  return { held, item, shared: stored || sharedOf(ctx, source) || ctx.scope.shared(source) }
}

function ownerSaid(ctx: ToolCtx, quote: string | undefined): boolean {
  if (!quote) return false
  try {
    return ctx.threads.ownerSaid(ctx.sessionId, quote)
  } catch {
    return false
  }
}

/**
 * Whether a change is written at once or waits, by the pillar's one rule: the owner asked for it in
 * so many words, or a routine runs it on a sheet nobody else reads, or it is the agent's own idea on
 * his own sheet set to write. `note` says why a claim was not taken.
 */
function ruled(ctx: ToolCtx, s: Sheets, t: Target, a: { because: 'asked' | 'routine' | 'own'; quote?: string }): { asked: boolean; routine: boolean; writes: boolean; note: string } {
  const asked = a.because === 'asked' && ownerSaid(ctx, a.quote)
  // A routine's run writes directly only where nobody else reads: on a shared sheet no grant covers it (milestone 50's hold review, finding 6).
  const routine = a.because === 'routine' && !!ctx.scope.routineRunId && !t.shared
  const writes = asked || routine || (!t.shared && s.suggestions.mode(storeKey(t.held)) === 'writes')
  const note = a.because === 'asked' && !asked ? ' The quote was not found among the owner\'s words in this thread, so this counts as your own idea.' : a.because === 'routine' && !routine ? (ctx.scope.routineRunId ? ' A routine writes to what others share only under a grant he made for it, and none does, so this counts as your own idea.' : ' This thread runs no routine, so this counts as your own idea.') : ''
  return { asked, routine, writes, note }
}

const because = {
  because: z.enum(['asked', 'routine', 'own']),
  quote: z.string().max(2000).optional().describe('With "asked": the owner\'s words, as he typed them in this thread.'),
  reason: z.string().max(300).optional().describe('One line the owner reads beside a suggestion: why this change.')
}

/** The sheet as a change is laid on it: its grids' workbook id, its tabs, the revision it stands at, and the rules it holds (asked for only when a rule is checked). */
interface Standing {
  unit: string
  sheets: { id: string; name: string }[]
  rev: number
  rules(): Promise<RulesHeld>
}
async function standing(s: Sheets, held: Target['held']): Promise<Standing> {
  if (held.at === 'package') {
    const st = await s.packages.open(held.path)
    if (st.inspected.readOnly) throw new Error(st.inspected.readOnly)
    return { unit: PACKAGE_UNIT, sheets: st.inspected.sheets, rev: st.rev, rules: async () => heldOfPackage(await s.jobs.rules(held.path)) }
  }
  if (held.csv) throw new Error('A .csv keeps cell contents only: export it as Excel first (Export, then open the .xlsx).')
  const o = await host(s.ctx, 'open', { sheet: held.ref })
  return { unit: o.unit, sheets: o.sheets, rev: o.rev, rules: async () => o.rules }
}

/**
 * A change the sheet as it stands has no place for: its tab gone, its range not on it, a rule that
 * cannot be made or that would replace what the sheet holds. Said as it is asked; at an accept it
 * turns that one change `orphaned`. Any other failure (the sheet worker, a read of the file) is a
 * passing fault and leaves the change waiting.
 */
export class Unplaced extends Error {}
const placed = <T>(make: () => T): T => {
  try {
    return make()
  } catch (err) {
    throw new Unplaced(errorText(err))
  }
}

/**
 * Where a change lies and the words for it; throws what the agent reads when the ask cannot be laid: a rule that
 * cannot be made, or one that would replace what the sheet already holds, is refused as it is asked, not as he takes it.
 */
async function read(ask: ChangeAsk, now: Standing): Promise<{ at: Placed | null; words: string }> {
  const { sheets } = now
  if (ask.kind === 'format') {
    const at = placed(() => place(ask.range, sheets))
    const cells = (at.range.endRow - at.range.startRow + 1) * (at.range.endColumn - at.range.startColumn + 1)
    if (cells > FORMAT_MAX_CELLS) throw new Unplaced(`A format is laid on at most ${FORMAT_MAX_CELLS.toLocaleString('en')} cells: ask for a smaller range.`)
    return { at, words: formatWords(ask.format, where(at, sheets)) }
  }
  const rule = ask.rule
  const at = rule.kind === 'name' || (rule.kind === 'filter' && rule.range === null) ? null : placed(() => place(rule.range as string, sheets))
  const model = placed(() => ruleModel(rule, at, sheets))
  if (model.list !== 'conditional') {
    const clash = ruleClash(model, await now.rules(), sheets)
    if (clash) throw new Unplaced(clash)
  }
  // The filter taken off names its tab where the workbook has more than one.
  const off = model.list === 'filter' && !model.filter && sheets.length > 1 ? (sheets.find((x) => x.id === model.sheet)?.name ?? '') : ''
  return { at, words: ruleWords(rule, at ? where(at, sheets) : off) }
}

/**
 * Lays a format or a rule on a sheet as an ordinary edit by `by`: the row's own mutations for a
 * format (the sheet worker makes them, compose.ts), the grid's own for a rule on a sheet the
 * service holds, the whole list a rule leaves for an opened Excel file. `rev` is the revision the
 * change was made for: the store moves it through what landed since, and answers false where it
 * cannot (rows, columns or sheets changed in between). A change the sheet as it stands has no
 * place for (its tab gone, its name taken since) throws `Unplaced`, before anything is written.
 */
export async function layChange(s: Sheets, held: Target['held'], ask: ChangeAsk, by: Principal, label: string, rev?: number): Promise<boolean> {
  const now = await standing(s, held)
  const mutations = await mutationsFor(s, held, ask, now)
  const base = rev ?? now.rev
  if (held.at === 'package') {
    const got = await s.packages.edit(held.path, base, mutations, by, { label })
    return !('conflict' in got)
  }
  const got = await host(s.ctx, 'apply', { sheet: held.ref, baseRev: base, mutations, by })
  return !('conflict' in got)
}

async function mutationsFor(s: Sheets, held: Target['held'], ask: ChangeAsk, now: Standing): Promise<SheetMutationJson[]> {
  const { at } = await read(ask, now)
  let mutations: SheetMutationJson[]
  if (ask.kind === 'format') {
    const format = agentFormat(ask.format)
    mutations = await s.jobs.compose({
      unit: now.unit,
      sheets: now.sheets,
      sheet: at!.sheet,
      range: at!.range,
      ...(Object.keys(format).length ? { format } : {}),
      ...(ask.format.width !== undefined ? { width: ask.format.width } : {}),
      ...(ask.format.height !== undefined ? { height: ask.format.height } : {}),
      ...(held.at === 'package' ? { path: held.path } : {})
    })
  } else {
    const model = ruleModel(ask.rule, at, now.sheets)
    mutations = held.at === 'package' ? [ruleListMutation(model, await s.jobs.rules(held.path))] : ruleMutations(now.unit, model)
  }
  return mutations
}

/** Keeps a format or a rule for the owner to take or drop: on this host alone (changes.ts). */
async function propose(s: Sheets, t: Target, ask: ChangeAsk, by: Principal, reason: string | undefined): Promise<string> {
  const now = await standing(s, t.held)
  const { at, words } = await read(ask, now)
  // Made once now and thrown away, so one that cannot be made (a format that changes nothing) is refused as it is asked.
  await mutationsFor(s, t.held, ask, now)
  s.changes.add(storeKey(t.held), { id: randomUUID(), changeSet: randomUUID(), by, ...(reason ? { reason } : {}), sheet: at?.sheet ?? now.sheets[0]!.id, range: at ? at.range : null, words, ask, rev: now.rev })
  return words
}

/** One format or rule under the write rule: written at once, or kept as a suggestion in words. */
async function change(ctx: ToolCtx, a: { item?: string; file?: string; because: 'asked' | 'routine' | 'own'; quote?: string; reason?: string }, ask: ChangeAsk): Promise<WorkToolResult> {
  try {
    const t = await targetOf(ctx, a)
    const s = await sheetsOf(ctx)
    const { asked, routine, writes, note } = ruled(ctx, s, t, a)
    const by = agentPrincipal(ctx.host, ctx.sessionId)
    if (!writes) {
      const words = await propose(s, t, ask, by, a.reason)
      await announceItem(s, t.item)
      return workText(`Suggested: ${words}. ${t.shared ? 'Others share this sheet, so' : 'The sheet is set to suggest, so'} the owner takes or drops it; nothing in the sheet changed.${note}`)
    }
    const { words } = await read(ask, await standing(s, t.held))
    if (!(await layChange(s, t.held, ask, by, words))) throw new Error('The sheet changed as this was written: read it again and try once more.')
    // His own sheet, on the agent's own idea: the bar says what was done. History takes it back, not the line (no cell's contents changed, and the grid's own Undo does not hold an agent's change).
    if (!asked && !routine) s.suggestions.setWritten(storeKey(t.held), { id: randomUUID(), text: words, at: Date.now(), undo: false })
    await announceItem(s, t.item)
    return workText(`${words}.${note}`)
  } catch (err) {
    return fail(errorText(err))
  }
}

const shown = (c: { at: string; v?: unknown; f?: string }): string => (c.f !== undefined ? `${c.at} ${c.f}${c.v !== undefined ? ` = ${JSON.stringify(c.v)}` : ''}` : c.v !== undefined ? `${c.at} ${JSON.stringify(c.v)}` : '')
/** A cell as `sheet_read` says it: its value or formula, then its note's words. */
const show = (c: { at: string; v?: unknown; f?: string; note?: string }): string => {
  const cell = shown(c)
  return c.note === undefined ? cell : `${cell || c.at} note ${JSON.stringify(c.note)}`
}

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
      'Reads cells of a sheet: each cell\'s value, its formula when it has one, and its note\'s words when it has one. `range` is A1 (B4:D9, or \'Q1 Budget\'!A1:F40 for another tab; at most 10,000 cells a call). ' +
      'Pass `item` for a sheet open in the canvas, or `file` for an .xlsx, .xlsm or .tcsheet path. For an Excel file it also says what only Excel changes there (pivot tables, charts, macros).',
    input: z.object({ ...target, range: z.string().min(2).max(300) }),
    readOnly: true,
    run: async (args, ctx) => {
      const a = args as { item?: string; file?: string; range: string }
      try {
        const t = await targetOf(ctx, a)
        const s = await sheetsOf(ctx)
        const got = t.held.at === 'package' ? await s.packages.read(t.held.path, a.range) : await host(ctx, 'range', { sheet: t.held.ref, range: a.range })
        const lines = got.cells.map((row) => row.map(show).filter(Boolean).join('  |  ')).filter(Boolean)
        // What the sheet tools do not reach in this file, so the thread does not claim a change it could not make.
        const waits = t.held.at === 'package' ? waitsNote((await s.packages.open(t.held.path)).inspected.reach?.parts) : ''
        return workText(`${got.sheet}\n${lines.length ? lines.join('\n') : '(every cell in that range is empty)'}${waits ? `\n\n${waits}` : ''}`)
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
      `At most ${WRITE_MAX} cells a call; null empties a cell.`,
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
        const { asked, routine, writes, note } = ruled(ctx, s, t, a)
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
    name: 'sheet_format',
    description:
      'Formats a range of a sheet: bold, colours, a number format, borders, alignment, a named cell style, column widths and row heights. `range` is A1. ' +
      'Say why, as for `sheet_write`: on a sheet others share, or one set to suggest, your own idea waits in words for the owner and nothing changes.',
    input: z.object({ ...target, range: z.string().min(2).max(300), format: FormatSchema, ...because }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item?: string; file?: string; range: string; format: FormatAsk; because: 'asked' | 'routine' | 'own'; quote?: string; reason?: string }
      return change(ctx, a, { kind: 'format', range: a.range, format: a.format })
    }
  },
  {
    name: 'sheet_rule',
    description:
      'Adds one rule to a sheet: a `highlight` (conditional format), a colour `scale`, a data `bar`, a `list` or a `check` of what a cell may hold, a `custom` validation, a `name` for a range, or the `filter`. ' +
      'Say why, as for `sheet_write`: on a sheet others share your own idea waits in words for the owner.',
    input: z.object({ ...target, rule: RuleSchema, ...because }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item?: string; file?: string; rule: RuleAsk; because: 'asked' | 'routine' | 'own'; quote?: string; reason?: string }
      return change(ctx, a, { kind: 'rule', rule: a.rule })
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
