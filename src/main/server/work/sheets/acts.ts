import { readFileSync } from 'node:fs'
import type { IWorkbookData } from '@univerjs/core'
import { z } from 'zod'
import { headlessSheet } from 'work-kit/sheet/engine'
import { createTables, TABLE_STYLES, TOTAL_FUNCTIONS, type TotalFunction } from 'work-kit/sheet/tables'
import { SHEET_ROW, type SheetMutationJson } from '@shared/contract-work-sheets'
import { forPackage, latestRules, RULE_MUTATIONS, ruleKinds } from '@shared/work/sheets'
import { colName, rangeName } from './a1'
import { place, type Placed } from './asks'
import { importPackage, tablesEditsOf } from './jobs'
import { patchTables, TablesRefused } from './patch/tables'

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

/** What the worker is asked: the sheet as it stands (an opened package's path, or the service's snapshot) and the ask. */
export interface ActAsk {
  store: 'package' | 'service'
  /** a package's path */
  path?: string
  /** a service-held sheet's workbook, as Univer's JSON */
  snapshot?: string
  table: TableAsk
}

/** What the ask makes, or `refused`: the words for a change the sheet has no place for (a worker's error crosses as text alone). */
export type ActAnswer = ActMade | { refused: string }
export interface ActMade {
  mutations: SheetMutationJson[]
  /** the sheet and cells it is about, for the words and the marks */
  sheet: string
  range: Placed['range']
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

/** Runs a table's ask on the workbook in a headless engine with the grid's own table handle. */
export async function tableAct(ask: ActAsk): Promise<ActAnswer> {
  try {
    return await made(ask)
  } catch (err) {
    if (err instanceof ActRefused) return { refused: err.message }
    throw err
  }
}

async function made(ask: ActAsk): Promise<ActMade> {
  const workbook = workbookOf(ask)
  const sheets = workbook.sheetOrder.map((id) => ({ id, name: workbook.sheets[id]?.name ?? id }))
  const grid = headlessSheet('univer', workbook, { rules: true })
  try {
    const tables = createTables(grid.api, () => false)
    const emitted: SheetMutationJson[] = []
    grid.api.addEvent(grid.api.Event.CommandExecuted, (event) => {
      if (event.type === 2 && !event.options?.fromCollab && !event.options?.onlyLocal && (event.id in RULE_MUTATIONS || event.id.startsWith('sheet.mutation.'))) emitted.push({ id: event.id, params: structuredClone(event.params ?? {}) as object })
    })
    const a = ask.table
    const on = (sheet: string, box: Placed['range']): string => rangeName(box, sheets.length > 1 ? sheets.find((s) => s.id === sheet)?.name : undefined)
    const find = (name: string) => {
      for (const s of sheets) {
        const t = tables.list(s.id).find((x) => x.name.toLowerCase() === name.toLowerCase())
        if (t) return t
      }
      return refuse(`There is no table named ${name}${tablesNamed(sheets.flatMap((s) => tables.list(s.id).map((t) => t.name)))}.`)
    }
    let sheet: string
    let box: Placed['range']
    let words: string
    if (a.op === 'make') {
      let at: Placed
      try {
        at = place(a.range, sheets)
      } catch (err) {
        return refuse(err instanceof Error ? err.message : String(err))
      }
      if (at.range.endRow === at.range.startRow) refuse('A table needs a header row and at least one row under it.')
      grid.workbook.setActiveSheet(grid.workbook.getSheetBySheetId(at.sheet)!)
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
      sheet = at.sheet
      box = made.range
      words = [`Table ${made.name} on ${on(sheet, box)}`, ...(a.style === undefined ? [styleWord(made.style)] : []), ...said.filter((w) => w !== 'header row')].join(', ')
    } else {
      const t = find(a.table)
      sheet = t.sheet
      grid.workbook.setActiveSheet(grid.workbook.getSheetBySheetId(sheet)!)
      if (a.op === 'change') {
        const { change, words: said } = changeOf(a)
        if (a.range !== undefined) {
          let at: Placed
          try {
            at = place(a.range, sheets)
          } catch (err) {
            return refuse(err instanceof Error ? err.message : String(err))
          }
          if (at.sheet !== sheet) refuse(`Table ${t.name} is on another sheet: a table's new range is on its own.`)
          change.range = at.range
          said.push(`over ${on(sheet, at.range)}`)
        }
        if (a.name !== undefined && a.name !== t.name) said.unshift(`renamed ${a.name}`)
        if (!Object.keys(change).length) refuse('Say what changes: a name, a style, a range or a switch.')
        const bad = tables.problem(t.id, change)
        if (bad) refuse(bad)
        if (!tables.set(t.id, change)) refuse(`Table ${t.name} could not be changed as asked.`)
        box = tables.list(sheet).find((x) => x.id === t.id)?.range ?? t.range
        words = `Table ${t.name}: ${said.join(', ')}`
      } else if (a.op === 'total') {
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
        box = tables.list(sheet).find((x) => x.id === t.id)?.range ?? t.range
        const name = t.columns[column - t.range.startColumn]?.name ?? colName(column)
        words = a.fn === 'none' ? `Table ${t.name}: no total under ${name}` : `Table ${t.name}: the ${a.fn === 'average' ? 'average' : a.fn === 'count' ? 'count' : a.fn === 'min' ? 'least' : a.fn === 'max' ? 'most' : 'sum'} of ${name} in its total row`
      } else {
        box = t.range
        if (!tables.remove(t.id)) refuse(`Table ${t.name} could not be converted.`)
        words = `Table ${t.name} back to a plain range`
      }
    }
    // Univer applies part of a table's change a tick after its command, as the canvas sees it.
    await new Promise((done) => setTimeout(done, 0))
    if (!emitted.length) refuse('That changes nothing.')
    const styles = grid.workbook.getWorkbook().getStyles()
    const styleOf = (id: string): Record<string, unknown> | null => (styles.get(id) as Record<string, unknown> | undefined) ?? null
    let mutations: SheetMutationJson[]
    if (ask.store === 'package') {
      const out: SheetMutationJson[] = []
      for (const m of emitted) {
        const got = forPackage(m, () => null, { formats: true, kinds: ruleKinds(SHEET_ROW.package), rules: (kind, at) => (kind === 'tables' ? tables.models(at) : undefined), style: styleOf })
        if ('stop' in got) refuse(got.stop)
        else out.push(...got.keep)
      }
      mutations = latestRules(out)
      // What the table writer would refuse is said now, before anything is kept or written.
      // (the writer names a sheet by its tab, as the store's plan does: `formatsOf`)
      const lists = tablesEditsOf(mutations.map((m) => ({ ...m, params: { ...(m.params as object), subUnitId: sheets.find((x) => x.id === (m.params as { subUnitId?: string }).subUnitId)?.name } })))
      if (lists.length)
        try {
          patchTables(new Uint8Array(readFileSync(ask.path!)), lists)
        } catch (err) {
          if (err instanceof TablesRefused) refuse(err.message)
          throw err
        }
    } else {
      // The service's engine has its own style ids: a cell's style goes as the style itself.
      mutations = emitted.map((m) => (m.id === 'sheet.mutation.set-range-values' ? { id: m.id, params: withStyles(m.params as { cellValue?: Record<string, Record<string, Record<string, unknown> | null>> }, styleOf) } : m))
    }
    return { mutations, sheet, range: box, words }
  } finally {
    grid.dispose()
  }
}

const tablesNamed = (names: string[]): string => (names.length ? `: this workbook has ${names.join(', ')}` : ': this workbook has none')

function withStyles<P extends { cellValue?: Record<string, Record<string, Record<string, unknown> | null>> }>(params: P, styleOf: (id: string) => Record<string, unknown> | null): P {
  const cellValue: Record<string, Record<string, Record<string, unknown> | null>> = {}
  for (const [r, cols] of Object.entries(params.cellValue ?? {}))
    for (const [c, cell] of Object.entries(cols ?? {})) (cellValue[r] ??= {})[c] = cell && typeof cell.s === 'string' ? { ...cell, s: styleOf(cell.s) } : cell
  return { ...params, cellValue }
}
