import type { SheetCellJson, SheetMutationJson } from '@shared/contract-work-sheets'
import { cellName } from './a1'
import type { EditSpec } from './patch/patch'

/**
 * Univer's mutations as cell writes for an opened package, and cell writes
 * as the mutation a grid applies. The patch writer replaces cell contents;
 * a format, a row insert and the like are not cell contents.
 */

export const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'
/** Mutations the grid works out again from content (row heights fitted to text): nothing to save. */
const DERIVED = new Set(['sheet.mutation.set-worksheet-row-auto-height', 'sheet.mutation.set-worksheet-row-is-auto-height'])
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
 * sheet id into the tab's name. Refuses (NotSaved) what is not cell content.
 */
export function editsOf(mutations: readonly SheetMutationJson[], sheetName: (id: string) => string | undefined): EditSpec[] {
  const out = new Map<string, EditSpec>()
  for (const m of mutations) {
    if (DERIVED.has(m.id)) continue
    if (STRUCTURAL.has(m.id)) throw new NotSaved('Inserting, deleting or moving rows and columns is not saved into an opened Excel file yet. Do it in Excel.')
    if (m.id !== SET_RANGE_VALUES) throw new NotSaved('Only cell contents are saved into an opened Excel file: formatting and sheet changes are not, yet.')
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
        if (cell.si && !cell.f) throw new NotSaved('A fill is not saved into an opened Excel file yet: type the formula in each cell.')
        if ('v' in cell) {
          const v = cell.v
          out.set(key, { sheet, cell: at, value: v === undefined || v === null || v === '' ? null : v })
          continue
        }
        if (cell.p !== undefined) throw new NotSaved('Rich text is not saved into an opened Excel file yet.')
        // Only a style: formatting.
        throw new NotSaved('Only cell contents are saved into an opened Excel file: formatting is not, yet.')
      }
    }
  }
  return [...out.values()]
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
