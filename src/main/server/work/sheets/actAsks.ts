import { z } from 'zod'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import type { Placed } from './asks'

/**
 * What a thread asks of a sheet that the grid's own handles make (sheet_table, sheet_page,
 * sheet_note, sheet_chart), as plain shapes a model fills, and what the sheet worker answers
 * (acts.ts). Nothing here loads Univer: main reads these, and only the worker runs the engine.
 */

/** What a total row's cell computes (the kit's `TOTAL_FUNCTIONS`; actAsks.test.ts holds the two the same). */
export const TOTAL_FUNCTIONS = ['none', 'sum', 'average', 'count', 'min', 'max'] as const

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
  z.object({ op: z.literal('total'), table: tableName, column: z.string().min(1).max(255).describe("A column's header, or its letter."), fn: z.enum(TOTAL_FUNCTIONS) }).strict(),
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

/** The kinds a chart is made in here: the grid's own "chart from a block" makes a column chart, and these are its first three turns. */
export const CHART_KINDS = ['column', 'bar', 'line', 'pie'] as const
export type ChartKindAsked = (typeof CHART_KINDS)[number]
const chartRef = z.string().min(1).max(255).describe('Its name ("Chart 1") or its title.')
export const ChartAskSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('make'),
      range: range.describe('The data with its header row and its label column.'),
      kind: z.enum(CHART_KINDS).optional().describe('column when left out'),
      title: z.string().min(1).max(255).optional(),
      at: z.string().min(2).max(30).optional().describe('The cell its top left corner sits on; right of the data when left out.')
    })
    .strict(),
  z.object({ op: z.literal('change'), chart: chartRef, kind: z.enum(CHART_KINDS).optional(), range: range.optional(), title: z.string().min(1).max(255).nullable().optional().describe('null takes the title away.') }).strict(),
  z.object({ op: z.literal('remove'), chart: chartRef }).strict()
])
export type ChartAsk = z.infer<typeof ChartAskSchema>

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
  chart?: ChartAsk
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

