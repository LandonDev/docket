import type { IWorkbookData } from '@univerjs/core'
import { z } from 'zod'
import { headlessSheet } from 'work-kit/sheet/engine'
import { createTables, TABLE_STYLES, TOTAL_FUNCTIONS, type TotalFunction } from 'work-kit/sheet/tables'
import { createPages } from 'work-kit/sheet/pages/access'
import { MARGIN_PRESETS, PAPERS, type SheetPageSetup } from 'work-kit/sheet/pages'
import { SHEET_NOTES, SHEET_ROW, type SheetMutationJson, type SheetNoteControl } from '@shared/contract-work-sheets'
import { forPackage, latestRules, NOTE_STOP, RULE_MUTATIONS, ruleKinds } from '@shared/work/sheets'
import { randomUUID } from 'node:crypto'
import { colName, rangeName } from './a1'
import { place, type Placed } from './asks'
import { importPackage, savePackage } from './jobs'
import { planOf } from './structural'

/**
 * What a thread asks of a sheet that only the grid's own code can make (sheet_table, tools.ts): the
 * sheet worker loads the workbook into a headless engine, runs the kit's own handle on it (the one
 * the Table menu calls), and answers the mutations it emitted, mapped for the store as the canvas
 * maps a press (`forPackage` for an opened Excel file; the grid's own mutations, each style laid
 * whole, for a sheet the service holds). Nothing here writes: the store does, through the tool's rule.
 */

const range = z.string().min(2).max(300)
const tableName = z.string().min(1).max(255)
/** A built-in style by its short name: Light 1 to 21, Medium 1 to 28, Dark 1 to 11. */
const style = z.string().regex(/^(Light|Medium|Dark) ?\d{1,2}$/i).describe('A built-in style: "Medium 2", "Light 9", "Dark 1".')
const switches = {
  header: z.boolean().optional().describe('Whether its first row names the columns.'),
  total: z.boolean().optional().describe('A total row under it.'),
  bandedRows: z.boolean().optional(),
  bandedColumns: z.boolean().optional(),
  firstColumn: z.boolean().optional(),
  lastColumn: z.boolean().optional()
}

export const TableAskSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('make'), range: range.describe('The cells it covers, its header row first.'), name: tableName.optional(), style: style.optional(), ...switches }).strict(),
  z.object({ op: z.literal('change'), table: tableName.describe("The table's name."), name: tableName.optional().describe('Its new name.'), style: style.optional(), range: range.optional().describe('Its new range; the header stays in its row.'), ...switches }).strict(),
  z.object({ op: z.literal('total'), table: tableName, column: z.string().min(1).max(255).describe("A column's header, or its letter."), fn: z.enum(TOTAL_FUNCTIONS as [TotalFunction, ...TotalFunction[]]) }).strict(),
  z.object({ op: z.literal('convert'), table: tableName.describe('The table that goes back to a plain range; its cells and their look stay.') }).strict()
])
export type TableAsk = z.infer<typeof TableAskSchema>

const lines = (re: RegExp) => z.string().regex(re)
export const PageAskSchema = z
  .object({
    sheet: z.string().min(1).max(200).optional().describe('The tab; the first when left out.'),
    orientation: z.enum(['portrait', 'landscape']).optional(),
    paper: z.string().min(1).max(40).optional().describe('Letter, Legal, A4, A3, Tabloid and the rest of Excel\'s list.'),
    margins: z.union([z.enum(['normal', 'wide', 'narrow']), z.object({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() }).partial().strict()]).optional().describe('A preset, or sides in inches.'),
    scale: z.number().int().min(10).max(400).optional().describe('Percent.'),
    fit: z.object({ wide: z.number().int().min(0).max(32767), tall: z.number().int().min(0).max(32767) }).strict().optional().describe('Pages wide by pages tall; 0 is no limit.'),
    printArea: z.string().min(2).max(300).nullable().optional().describe('Prints this range alone; null prints the whole sheet again.'),
    breakAfterRow: z.number().int().min(1).max(1_048_575).optional().describe('A manual page break under this row.'),
    breakAfterColumn: lines(/^[A-Za-z]{1,3}$/).optional().describe('A manual page break right of this column.'),
    titleRows: lines(/^\d{1,7}(:\d{1,7})?$/).nullable().optional().describe('Rows printed atop every page, "1" or "1:2"; null for none.'),
    titleColumns: lines(/^[A-Za-z]{1,3}(:[A-Za-z]{1,3})?$/).nullable().optional().describe('Columns printed left on every page, "A" or "A:B"; null for none.')
  })
  .strict()
export type PageAsk = z.infer<typeof PageAskSchema>

export const NoteAskSchema = z
  .object({
    at: z.string().min(2).max(300).describe("One cell: B4, or 'Q1 Budget'!B4."),
    text: z.string().min(1).max(32_767).nullable().describe('The note\'s words; null removes it.')
  })
  .strict()
export type NoteAsk = z.infer<typeof NoteAskSchema>

/** What the worker is asked: the sheet as it stands (an opened package's path, or the service's snapshot) and the ask. */
export interface ActAsk {
  store: 'package' | 'service'
  /** a package's path */
  path?: string
  /** a service-held sheet's workbook, as Univer's JSON */
  snapshot?: string
  table?: TableAsk
  page?: PageAsk
  note?: NoteAsk
}

/** What the ask makes, or `refused`: the words for a change the sheet has no place for (a worker's error crosses as text alone). */
export type ActAnswer = ActMade | { refused: string }
export interface ActMade {
  mutations: SheetMutationJson[]
  /** the sheet and cells it is about, for the words and the marks */
  sheet: string
  /** null where it is about the sheet as a whole (its page set-up) */
  range: Placed['range'] | null
  words: string
}

/** A change the sheet has no place for, in his words: the tool says it and keeps nothing. */
export class ActRefused extends Error {}
const refuse = (words: string): never => {
  throw new ActRefused(words)
}

const styleId = (short: string): string => {
  const m = /^(Light|Medium|Dark) ?(\d{1,2})$/i.exec(short)!
  const id = `TableStyle${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()}${Number(m[2])}`
  if (!TABLE_STYLES.includes(id)) refuse(`There is no table style ${short}: Light 1 to 21, Medium 1 to 28, Dark 1 to 11.`)
  return id
}
/** "TableStyleMedium2" → "Medium 2" */
const styleWord = (id: string | null | undefined): string => (id ? id.replace(/^TableStyle(\w+?)(\d+)$/, '$1 $2') : 'no style')

const SWITCH_WORDS: Record<string, [string, string]> = {
  header: ['header row', 'no header row'],
  total: ['total row', 'no total row'],
  bandedRows: ['banded rows', 'no banded rows'],
  bandedColumns: ['banded columns', 'no banded columns'],
  firstColumn: ['first column bold', 'first column plain'],
  lastColumn: ['last column bold', 'last column plain']
}

/** The table's change as the kit's `set` takes it, and its words. */
function changeOf(a: { name?: string; style?: string; header?: boolean; total?: boolean; bandedRows?: boolean; bandedColumns?: boolean; firstColumn?: boolean; lastColumn?: boolean }): { change: Record<string, unknown>; words: string[] } {
  const change: Record<string, unknown> = {}
  const words: string[] = []
  if (a.name !== undefined) change.name = a.name
  if (a.style !== undefined) {
    change.style = styleId(a.style)
    words.push(styleWord(change.style as string))
  }
  for (const key of Object.keys(SWITCH_WORDS)) {
    const v = (a as Record<string, boolean | undefined>)[key]
    if (v === undefined) continue
    change[key] = v
    words.push(SWITCH_WORDS[key]![v ? 0 : 1])
  }
  return { change, words }
}

const workbookOf = (ask: ActAsk): IWorkbookData => {
  if (ask.store === 'package') return structuredClone(importPackage(ask.path!).workbook)
  return JSON.parse(ask.snapshot!) as IWorkbookData
}

/** Runs a table's or a page's ask on the workbook in a headless engine with the grid's own handles. */
export async function runAct(ask: ActAsk): Promise<ActAnswer> {
  try {
    return await made(ask)
  } catch (err) {
    if (err instanceof ActRefused) return { refused: err.message }
    throw err
  }
}

type Grid = ReturnType<typeof headlessSheet>
interface Env {
  grid: Grid
  sheets: { id: string; name: string }[]
  tables: ReturnType<typeof createTables>
  pages: ReturnType<typeof createPages>
  /** a range as he reads it: with its tab where the workbook has more than one */
  on(sheet: string, box: Placed['range']): string
  place(text: string): Placed
  /** the sheet a change is made on, set in hand as the grid's own press would find it */
  hold(sheet: string): void
}
interface Step {
  sheet: string
  range: Placed['range'] | null
  words: string
}

async function made(ask: ActAsk): Promise<ActMade> {
  const workbook = workbookOf(ask)
  const sheets = workbook.sheetOrder.map((id) => ({ id, name: workbook.sheets[id]?.name ?? id }))
  const grid = headlessSheet('univer', workbook, { rules: true, pages: true, notes: true })
  try {
    const emitted: SheetMutationJson[] = []
    grid.api.addEvent(grid.api.Event.CommandExecuted, (event) => {
      if (event.type === 2 && !event.options?.fromCollab && !event.options?.onlyLocal && (event.id in RULE_MUTATIONS || event.id.startsWith('sheet.mutation.') || event.id.startsWith('tempcode.sheet.mutation.'))) emitted.push({ id: event.id, params: structuredClone(event.params ?? {}) as object })
    })
    const env: Env = {
      grid,
      sheets,
      tables: createTables(grid.api, () => false),
      pages: createPages(grid.api, () => false),
      on: (sheet, box) => rangeName(box, sheets.length > 1 ? sheets.find((s) => s.id === sheet)?.name : undefined),
      place: (text) => {
        try {
          return place(text, sheets)
        } catch (err) {
          return refuse(err instanceof Error ? err.message : String(err))
        }
      },
      hold: (sheet) => void grid.workbook.setActiveSheet(grid.workbook.getSheetBySheetId(sheet)!)
    }
    // What a note's pop-over takes there (SHEET_NOTES): an Excel file rewords a note it has; a sheet the service holds makes and removes them too.
    const step = ask.table ? tableStep(env, ask.table) : ask.page ? pageStep(env, ask.page) : ask.note ? noteStep(env, ask.note, workbook, ask.store === 'package' ? SHEET_NOTES.package : SHEET_NOTES.tcsheet) : refuse('Nothing was asked.')
    // Univer applies part of a change a tick after its command, as the canvas sees it.
    await new Promise((done) => setTimeout(done, 0))
    if (!emitted.length) refuse('That changes nothing.')
    const styles = grid.workbook.getWorkbook().getStyles()
    const styleOf = (id: string): Record<string, unknown> | null => (styles.get(id) as Record<string, unknown> | undefined) ?? null
    let mutations: SheetMutationJson[]
    if (ask.store === 'package') {
      const out: SheetMutationJson[] = []
      for (const m of emitted) {
        const got = forPackage(m, () => null, { formats: true, kinds: ruleKinds(SHEET_ROW.package), rules: (kind, at) => (kind === 'tables' ? env.tables.models(at) : kind === 'pages' ? env.pages.get(at) : undefined), style: styleOf, notes: SHEET_NOTES.package })
        if ('stop' in got) refuse(got.stop)
        else out.push(...got.keep)
      }
      mutations = latestRules(out)
      await triedOn(ask.path!, mutations, sheets)
    } else {
      // The service's engine has its own style ids: a cell's style goes as the style itself.
      mutations = emitted.map((m) => (m.id === 'sheet.mutation.set-range-values' ? { id: m.id, params: withStyles(m.params as { cellValue?: Record<string, Record<string, Record<string, unknown> | null>> }, styleOf) } : m))
    }
    return { mutations, ...step }
  } finally {
    grid.dispose()
  }
}

/**
 * The store's own save of these mutations, made in memory and thrown away: what a writer refuses
 * (a table the file cannot hold, a set-up Excel would not take) is said as it is asked, before
 * anything is kept or written, and no other fault is taken for one.
 */
async function triedOn(path: string, mutations: SheetMutationJson[], sheets: { id: string; name: string }[]): Promise<void> {
  try {
    for (const step of planOf(mutations, new Map(sheets.map((s) => [s.id, s.name])))) if (step.kind === 'cells') await savePackage(path, step.edits, null, step.formats)
  } catch (err) {
    if (err instanceof Error && (/Refused$/.test(err.constructor.name) || err.constructor.name === 'NotSaved')) refuse(err.message)
    throw err
  }
}

function tableStep(env: Env, a: TableAsk): Step {
  const { tables, sheets, on } = env
  const find = (name: string) => {
    for (const s of sheets) {
      const t = tables.list(s.id).find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (t) return t
    }
    return refuse(`There is no table named ${name}${tablesNamed(sheets.flatMap((s) => tables.list(s.id).map((t) => t.name)))}.`)
  }
  if (a.op === 'make') {
    const at = env.place(a.range)
    if (at.range.endRow === at.range.startRow) refuse('A table needs a header row and at least one row under it.')
    env.hold(at.sheet)
    const problem = tables.refusal(at.range, at.sheet)
    if (problem) refuse(`${problem}: ${on(at.sheet, at.range)} cannot become a table.`)
    if (a.name !== undefined) {
      const bad = tables.nameProblem(a.name)
      if (bad) refuse(`${bad}: “${a.name}” cannot name a table.`)
    }
    const { change, words: said } = changeOf(a)
    const id = tables.add(at.range, { ...(a.header !== undefined ? { header: a.header } : {}), sheet: at.sheet }) ?? refuse(`${on(at.sheet, at.range)} could not become a table.`)
    if (Object.keys(change).length) {
      const bad = tables.problem(id, change)
      if (bad) refuse(bad)
      if (!tables.set(id, change)) refuse('That table could not be set as asked.')
    }
    const made = tables.list(at.sheet).find((t) => t.id === id)!
    return { sheet: at.sheet, range: made.range, words: [`Table ${made.name} on ${on(at.sheet, made.range)}`, ...(a.style === undefined ? [styleWord(made.style)] : []), ...said.filter((w) => w !== 'header row')].join(', ') }
  }
  const t = find(a.table)
  const sheet = t.sheet
  env.hold(sheet)
  const now = () => tables.list(sheet).find((x) => x.id === t.id)?.range ?? t.range
  if (a.op === 'change') {
    const { change, words: said } = changeOf(a)
    if (a.range !== undefined) {
      const at = env.place(a.range)
      if (at.sheet !== sheet) refuse(`Table ${t.name} is on another sheet: a table's new range is on its own.`)
      change.range = at.range
      said.push(`over ${on(sheet, at.range)}`)
    }
    if (a.name !== undefined && a.name !== t.name) said.unshift(`renamed ${a.name}`)
    if (!Object.keys(change).length) refuse('Say what changes: a name, a style, a range or a switch.')
    const bad = tables.problem(t.id, change)
    if (bad) refuse(bad)
    if (!tables.set(t.id, change)) refuse(`Table ${t.name} could not be changed as asked.`)
    return { sheet, range: now(), words: `Table ${t.name}: ${said.join(', ')}` }
  }
  if (a.op === 'total') {
    const want = a.column.trim()
    const k = t.columns.findIndex((c) => c.name.toLowerCase() === want.toLowerCase())
    const letter = /^[A-Z]{1,3}$/i.test(want) ? [...want.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : -1
    const column = k >= 0 ? t.range.startColumn + k : letter >= t.range.startColumn && letter <= t.range.endColumn ? letter : refuse(`Table ${t.name} has no column ${want}: ${t.columns.map((c) => c.name).join(', ')}.`)
    if (!t.flags.total) {
      const bad = tables.problem(t.id, { total: true })
      if (bad) refuse(bad)
      if (!tables.set(t.id, { total: true })) refuse(`Table ${t.name} could not take a total row.`)
    }
    if (!tables.totals(t.id, column, a.fn)) refuse(`The total of ${want} could not be set.`)
    const name = t.columns[column - t.range.startColumn]?.name ?? colName(column)
    const fn = { sum: 'sum', average: 'average', count: 'count', min: 'least', max: 'most', none: '' }[a.fn]
    return { sheet, range: now(), words: a.fn === 'none' ? `Table ${t.name}: no total under ${name}` : `Table ${t.name}: the ${fn} of ${name} in its total row` }
  }
  if (!tables.remove(t.id)) refuse(`Table ${t.name} could not be converted.`)
  return { sheet, range: t.range, words: `Table ${t.name} back to a plain range` }
}

/** Univer's note resource (work-kit's README "Notes and comments"): by sheet id, row and column. */
const NOTES = 'SHEET_NOTE_PLUGIN'
type KeptNote = { id: string; row: number; col: number; note: string; thread?: string } & Record<string, unknown>
const quoted = (text: string): string => `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`

/** A note's ask as the grid's own note mutations (the ones `handle.comments` makes), applied to the engine. */
function noteStep(env: Env, a: NoteAsk, workbook: IWorkbookData, controls: readonly SheetNoteControl[]): Step {
  const at = env.place(a.at)
  const { sheet, range } = at
  if (range.startRow !== range.endRow || range.startColumn !== range.endColumn) refuse(`${a.at} is not one cell: a note is on one cell.`)
  const cell = env.on(sheet, range)
  let kept: Record<string, Record<string, Record<string, KeptNote | null>>> = {}
  try {
    kept = JSON.parse(workbook.resources?.find((r) => r.name === NOTES)?.data || '{}') ?? {}
  } catch {
    kept = {}
  }
  const was = kept[sheet]?.[range.startRow]?.[range.startColumn] ?? null
  if (was?.thread) refuse(`The comment at ${cell} is a thread. Reply to it in Excel.`)
  const unitId = env.grid.workbook.getId()
  const where = { unitId, sheetId: sheet, row: range.startRow, col: range.startColumn }
  let words: string
  if (a.text === null) {
    if (!was) refuse(`${cell} has no note.`)
    if (!controls.includes('remove')) refuse(NOTE_STOP.remove)
    env.grid.api.syncExecuteCommand('sheet.mutation.remove-note', { ...where, noteId: was!.id })
    words = `The note on ${cell} removed`
  } else if (was) {
    if (!controls.includes('edit')) refuse(NOTE_STOP.add)
    if (was.note === a.text) refuse(`The note on ${cell} says that already.`)
    env.grid.api.syncExecuteCommand('sheet.mutation.update-note', { ...where, note: { ...was, note: a.text } })
    words = `The note on ${cell} reworded: ${quoted(a.text)}`
  } else {
    if (!controls.includes('add')) refuse(NOTE_STOP.add)
    env.grid.api.syncExecuteCommand('sheet.mutation.update-note', { ...where, note: { id: randomUUID().slice(0, 6), row: range.startRow, col: range.startColumn, width: 160, height: 72, note: a.text, show: false } })
    words = `A note on ${cell}: ${quoted(a.text)}`
  }
  return { sheet, range, words }
}

const letterOf = (text: string): number => [...text.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
const span = (text: string, of: (part: string) => number): { start: number; end: number } => {
  const [a, b] = text.split(':')
  const start = of(a!)
  const end = b === undefined ? start : of(b)
  return { start: Math.min(start, end), end: Math.max(start, end) }
}
const inches = (n: number): string => `${Math.round(n * 100) / 100}″`

/** A page set-up's ask through the grid's own page handle (the Page Setup dialog's and the Page breaks view's). */
function pageStep(env: Env, a: PageAsk): Step {
  const { pages, sheets } = env
  const tab = a.sheet === undefined ? sheets[0] : sheets.find((s) => s.name.toLowerCase() === a.sheet!.toLowerCase())
  if (!tab) return refuse(`There is no sheet named ${a.sheet}. Sheets: ${sheets.map((s) => s.name).join(', ')}.`)
  env.hold(tab.id)
  const was = pages.get(tab.id)
  const patch: Partial<SheetPageSetup> = {}
  const words: string[] = []
  if (a.orientation) {
    patch.orientation = a.orientation
    words.push(a.orientation)
  }
  if (a.paper !== undefined) {
    const paper = Object.values(PAPERS).find((p) => p.name.toLowerCase() === a.paper!.trim().toLowerCase())
    if (!paper) refuse(`There is no paper named ${a.paper}: Letter, Legal, A4, A3, A5, Tabloid and the rest of Excel's list.`)
    patch.paper = paper!
    words.push(paper!.name)
  }
  if (a.margins !== undefined) {
    if (typeof a.margins === 'string') {
      patch.margins = MARGIN_PRESETS[a.margins]
      words.push(`${a.margins} margins`)
    } else {
      for (const v of Object.values(a.margins)) if (!(v >= 0 && v <= 10)) refuse(`A margin is 0 to 10 inches, not ${v}.`)
      patch.margins = { ...was.margins, ...a.margins }
      words.push(`margins ${Object.entries(a.margins).map(([side, v]) => `${side} ${inches(v)}`).join(', ')}`)
    }
  }
  if (a.scale !== undefined && a.fit !== undefined) refuse('A page is scaled by a percent or fitted to pages, not both.')
  if (a.scale !== undefined) {
    patch.scaling = { kind: 'scale', percent: a.scale }
    words.push(`${a.scale}%`)
  }
  if (a.fit !== undefined) {
    patch.scaling = { kind: 'fit', wide: a.fit.wide, tall: a.fit.tall }
    const part = (n: number, way: string) => (n ? `${n} ${n === 1 ? 'page' : 'pages'} ${way}` : '')
    words.push(`fit to ${[part(a.fit.wide, 'wide'), part(a.fit.tall, 'tall')].filter(Boolean).join(' by ') || 'any size'}`)
  }
  if (a.titleRows !== undefined) {
    patch.repeatRows = a.titleRows === null ? null : span(a.titleRows, (r) => Number(r) - 1)
    words.push(a.titleRows === null ? 'no title rows' : `rows ${a.titleRows} on every page`)
  }
  if (a.titleColumns !== undefined) {
    patch.repeatColumns = a.titleColumns === null ? null : span(a.titleColumns.toUpperCase(), letterOf)
    words.push(a.titleColumns === null ? 'no title columns' : `columns ${a.titleColumns.toUpperCase()} on every page`)
  }
  if (Object.keys(patch).length && !pages.set(tab.id, patch)) refuse('Excel would not take that page set-up.')
  let range: Placed['range'] | null = null
  if (a.printArea !== undefined) {
    if (a.printArea === null) {
      if (!pages.setPrintArea(null, tab.id)) refuse(`${tab.name} has no print area to take off.`)
      words.push('the whole sheet prints')
    } else {
      const at = env.place(a.printArea.includes('!') ? a.printArea : `'${tab.name.replace(/'/g, "''")}'!${a.printArea}`)
      if (at.sheet !== tab.id) refuse(`A print area is on its own sheet: name ${tab.name}, or give the range's tab as \`sheet\`.`)
      if (!pages.setPrintArea(at.range, tab.id)) refuse(`${env.on(tab.id, at.range)} could not be made the print area.`)
      range = at.range
      words.push(`print area ${rangeName(at.range)}`)
    }
  }
  if (a.breakAfterRow !== undefined) {
    if (!pages.addBreak('row', a.breakAfterRow - 1, tab.id)) refuse(`A break under row ${a.breakAfterRow} is there already, or the page is fitted to a size, where Excel leaves out manual breaks.`)
    words.push(`a page break under row ${a.breakAfterRow}`)
  }
  if (a.breakAfterColumn !== undefined) {
    const col = a.breakAfterColumn.toUpperCase()
    if (!pages.addBreak('column', letterOf(col), tab.id)) refuse(`A break right of column ${col} is there already, or the page is fitted to a size, where Excel leaves out manual breaks.`)
    words.push(`a page break right of column ${col}`)
  }
  if (!words.length) refuse('Say what changes: orientation, paper, margins, scale or fit, the print area, a break or title rows.')
  return { sheet: tab.id, range, words: `${sheets.length > 1 ? `${tab.name}'s page` : 'Page'}: ${words.join(', ')}` }
}

const tablesNamed = (names: string[]): string => (names.length ? `: this workbook has ${names.join(', ')}` : ': this workbook has none')

function withStyles<P extends { cellValue?: Record<string, Record<string, Record<string, unknown> | null>> }>(params: P, styleOf: (id: string) => Record<string, unknown> | null): P {
  const cellValue: Record<string, Record<string, Record<string, unknown> | null>> = {}
  for (const [r, cols] of Object.entries(params.cellValue ?? {}))
    for (const [c, cell] of Object.entries(cols ?? {})) (cellValue[r] ??= {})[c] = cell && typeof cell.s === 'string' ? { ...cell, s: styleOf(cell.s) } : cell
  return { ...params, cellValue }
}
