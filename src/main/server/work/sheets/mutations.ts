import type { ICellData } from '@univerjs/core'
import { runsOf, type Run } from 'work-kit/sheet/xlsx'
import type { SheetCellJson, SheetMutationJson } from '@shared/contract-work-sheets'
// (by its path: the Work service reaches this file, and its bundle resolves no alias for a value)
import { NOTE_STOP, RULES_SET, sheetStopWords, type RulesSetParams } from '../../../../shared/work/sheets'
import { cellName } from './a1'
import type { EditSpec } from './patch/patch'

/**
 * Univer's mutations as cell writes for an opened package, and cell writes
 * as the mutation a grid applies. A cell's contents go to the patch writer
 * as `EditSpec`s; its style, a column's width, a row's height and a merge go
 * as the mutations they are, for the sheet worker to turn into format edits
 * (formats.ts); rows and columns inserted or deleted go to LibreOffice
 * (structural.ts).
 */

export const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'
/** Mutations the grid works out again from content (row heights fitted to text): nothing to save. */
const DERIVED = new Set(['sheet.mutation.set-worksheet-row-auto-height'])
export const STRUCTURAL = new Set([
  'sheet.mutation.insert-row',
  'sheet.mutation.remove-rows',
  'sheet.mutation.insert-col',
  'sheet.mutation.remove-col',
  'sheet.mutation.move-rows',
  'sheet.mutation.move-columns',
  'sheet.mutation.move-range',
  'sheet.mutation.reorder-range'
])

/** The mutations a package saves as formatting (formats.ts maps them). */
export const FORMATTING = new Set([
  'sheet.mutation.set-worksheet-col-width',
  'sheet.mutation.set-worksheet-row-height',
  // a row told to fit what it holds: its own height leaves the file
  'sheet.mutation.set-worksheet-row-is-auto-height',
  'sheet.mutation.add-worksheet-merge',
  'sheet.mutation.remove-worksheet-merge',
  // a rule's whole list as its change left it (the canvas sends it in place of the rule's own mutation): rules.ts lays it
  RULES_SET
])

/** What an opened Excel file cannot keep yet, in the words he reads when he tries it: the canvas stops these as he makes them and says the same (`sheetStopWords`, the contract). */
export const UNSAVED = {
  moved: sheetStopWords('moved'),
  rich: sheetStopWords('rich'),
  fill: sheetStopWords('fill'),
  other: sheetStopWords('other')
} as const

/**
 * What a package is sent beside a cell's own writes, as `formatsOf` carries a style: a rich cell's
 * runs (`patchText`), and a note's new words (`patchNotes`). Each names its tab in `subUnitId`.
 */
export const SHEET_TEXT = 'tempcode.sheet.text'
export const SHEET_NOTE = 'tempcode.sheet.note'
export interface SheetTextParams {
  subUnitId: string
  cells: { row: number; column: number; runs: Run[] | null }[]
}
export interface SheetNoteParams {
  subUnitId: string
  row: number
  column: number
  text: string
}
/** The grid's note mutations (work-kit's `NOTE_MUTATIONS`): a note made or reworded, removed, moved with its cell. */
export const NOTE_UPDATE = 'sheet.mutation.update-note'
export const NOTE_REMOVE = 'sheet.mutation.remove-note'
export const NOTE_MOVE = 'sheet.mutation.update-note-position'

const rich = (cell: { p?: unknown } | null | undefined): boolean => !!cell && cell.p !== undefined && cell.p !== null
/** A rich cell's runs as the file takes them; its own style is the one the mutation carries (the canvas sends a style itself, never its id). */
const runsOfCell = (cell: { p?: unknown; s?: unknown }): Run[] | null => runsOf(cell as Pick<ICellData, 'p' | 's'>, () => null)
/** A rich cell's words with no style: what a formula that reads it sees. */
export const flatText = (cell: { p?: unknown; s?: unknown }): string => (runsOfCell(cell) ?? []).map((r) => r.text).join('')

const MOVES = new Set(['sheet.mutation.move-rows', 'sheet.mutation.move-columns', 'sheet.mutation.move-range'])

type CellMatrix = Record<string, Record<string, (SheetCellJson & { p?: unknown }) | null>>
interface RangeValuesParams {
  unitId: string
  subUnitId: string
  cellValue?: CellMatrix
}

/** What could not be saved into the package, said once to the person. */
export class NotSaved extends Error {}

/**
 * The cell writes a list of mutations makes, for the patch writer. `sheetName` turns Univer's
 * sheet id into the tab's name. A cell's style and the formatting mutations are not its
 * business (`formatsOf` carries them); it refuses (NotSaved) only what a package cannot keep.
 */
export function editsOf(mutations: readonly SheetMutationJson[], sheetName: (id: string) => string | undefined, opts: { rich?: boolean } = {}): EditSpec[] {
  const out = new Map<string, EditSpec>()
  for (const m of mutations) {
    if (DERIVED.has(m.id) || FORMATTING.has(m.id)) continue
    if (MOVES.has(m.id)) throw new NotSaved(UNSAVED.moved)
    if (m.id !== SET_RANGE_VALUES) throw new NotSaved(UNSAVED.other)
    const p = m.params as RangeValuesParams
    const sheet = sheetName(p.subUnitId)
    if (!sheet) throw new NotSaved('That sheet is not in the file.')
    for (const [r, cols] of Object.entries(p.cellValue ?? {})) {
      for (const [c, cell] of Object.entries(cols ?? {})) {
        const at = cellName(Number(r), Number(c))
        const key = `${sheet}\u0000${at}`
        out.delete(key)
        if (cell === null) {
          out.set(key, { sheet, cell: at, value: null })
          continue
        }
        if (typeof cell.f === 'string' && cell.f.startsWith('=')) {
          out.set(key, { sheet, cell: at, formula: cell.f })
          continue
        }
        // Before `v`: a cell edited to rich text comes as `{ v: null, p }`, and would be written empty.
        if (rich(cell)) {
          // An opened Excel file (`rich`) takes the words here, so what reads them recalculates, and the runs through `formatsOf`.
          if (!opts.rich) throw new NotSaved(UNSAVED.rich)
          // A document with no words to read is no edit he made: refused, never written as an empty cell.
          if (!runsOfCell(cell)) throw new NotSaved(UNSAVED.other)
          const text = flatText(cell)
          out.set(key, { sheet, cell: at, value: text === '' ? null : text })
          continue
        }
        if (cell.si && !cell.f) throw new NotSaved(UNSAVED.fill)
        if ('v' in cell) {
          const v = cell.v
          out.set(key, { sheet, cell: at, value: v === undefined || v === null || v === '' ? null : v })
          continue
        }
        // Only a style: the format edits carry it. A cell with neither contents nor a style (a type alone, custom data) has no saved form.
        if (!('s' in cell)) throw new NotSaved(UNSAVED.other)
      }
    }
  }
  return [...out.values()]
}

/**
 * A note's mutation as an opened Excel file takes it: a note made or reworded is its new words
 * (`SHEET_NOTE`, for `patchNotes`, which refuses a cell the file has no note at: "Add a new note
 * in Excel"); a note removed is refused; a note moved beside a row or a column needs nothing of its
 * own (LibreOffice moves it with the cells).
 */
export function notesOf(m: SheetMutationJson, sheetName: (id: string) => string | undefined): SheetMutationJson[] {
  if (m.id === NOTE_MOVE) return []
  if (m.id === NOTE_REMOVE) throw new NotSaved(NOTE_STOP.remove)
  if (m.id !== NOTE_UPDATE) throw new NotSaved(UNSAVED.other)
  const p = m.params as { sheetId?: string; row?: number; col?: number; note?: { note?: unknown } }
  const sheet = typeof p.sheetId === 'string' ? sheetName(p.sheetId) : undefined
  if (!sheet) throw new NotSaved('That sheet is not in the file.')
  if (!Number.isInteger(p.row) || !Number.isInteger(p.col) || typeof p.note?.note !== 'string') throw new NotSaved(UNSAVED.other)
  return [{ id: SHEET_NOTE, params: { subUnitId: sheet, row: p.row!, column: p.col!, text: p.note.note } satisfies SheetNoteParams }]
}

const styled = (cell: unknown): boolean => !!cell && typeof cell === 'object' && 's' in cell

/**
 * The mutations of a list that change formatting, each named by its tab (`subUnitId` is the tab's
 * name in what this answers, so the sheet worker needs no workbook to place it): a
 * set-range-values cut down to its cells' styles, and the width, height and merge mutations whole.
 * A rule's whole list (`RULES_SET`) rides with them the same way.
 */
export function formatsOf(mutations: readonly SheetMutationJson[], sheetName: (id: string) => string | undefined): SheetMutationJson[] {
  const out: SheetMutationJson[] = []
  for (const m of mutations) {
    const p = m.params as RangeValuesParams & Record<string, unknown>
    if (m.id !== SET_RANGE_VALUES && !FORMATTING.has(m.id)) continue
    if (m.id === RULES_SET && (p as unknown as RulesSetParams).kind === 'names') {
      // the workbook's names belong to no sheet
      out.push({ id: m.id, params: { kind: 'names', list: (p as unknown as RulesSetParams).list } })
      continue
    }
    const sheet = typeof p?.subUnitId === 'string' ? sheetName(p.subUnitId) : undefined
    if (!sheet) throw new NotSaved('That sheet is not in the file.')
    if (FORMATTING.has(m.id)) {
      out.push({ id: m.id, params: { ...p, subUnitId: sheet } })
      continue
    }
    const cellValue: Record<string, Record<string, { s: unknown }>> = {}
    const text: SheetTextParams['cells'] = []
    let any = false
    for (const [r, cols] of Object.entries(p.cellValue ?? {}))
      for (const [c, cell] of Object.entries(cols ?? {})) {
        // A rich cell's runs, as the grid holds them after this change (the canvas adds them to a style set over one).
        if (rich(cell) && !(typeof cell!.f === 'string' && cell!.f.startsWith('='))) {
          const runs = runsOfCell(cell!)
          text.push({ row: Number(r), column: Number(c), runs: runs && runs.some((x) => x.text) ? runs : null })
        }
        if (!styled(cell)) continue
        ;(cellValue[r] ??= {})[c] = { s: (cell as { s: unknown }).s }
        any = true
      }
    if (any) out.push({ id: m.id, params: { subUnitId: sheet, cellValue } })
    if (text.length) out.push({ id: SHEET_TEXT, params: { subUnitId: sheet, cells: text } satisfies SheetTextParams })
  }
  return out
}

/** A cell an agent or a restore writes, by Univer sheet id and zero-based row and column. */
export interface CellWrite {
  sheet: string
  row: number
  col: number
  /** null clears the cell */
  cell: SheetCellJson | null
}

/** One set-range-values mutation per sheet: what a grid applies to show writes made elsewhere. */
export function mutationsOf(unitId: string, writes: readonly CellWrite[]): SheetMutationJson[] {
  const bySheet = new Map<string, CellMatrix>()
  for (const w of writes) {
    const m = bySheet.get(w.sheet) ?? {}
    const row = (m[w.row] ??= {})
    // A key set to null clears it: a value written over a formula takes the formula away.
    row[w.col] = w.cell === null ? null : ({ v: w.cell.v ?? null, f: w.cell.f ?? null } as unknown as SheetCellJson)
    bySheet.set(w.sheet, m)
  }
  return [...bySheet].map(([subUnitId, cellValue]) => ({ id: SET_RANGE_VALUES, params: { unitId, subUnitId, cellValue } }))
}
