import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { SET_RANGE_VALUES } from '../mutations'
import { ADD_MERGE, AUTO_ROWS_MAX, INDEX_KEY, REMOVE_MERGE, STRUCTURAL_MAX } from './live'

/**
 * A guest's ops held to the sheet as it stands (docs/agents/work-sheets.md "Live editing"). The
 * route checks each op's shape (live.ts `refusal`); only the engine knows the sheet, so the host
 * asks here before it applies a guest's batch. The guest's own page sends none of what this
 * refuses: it guards the service against an op made by hand, which could otherwise write millions
 * of rows or cells into the owner's sheet (a size over every row of the grid, a number format
 * over the whole grid, rows inserted without end) that no restore takes back.
 */

export interface Box {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

/** A sheet as the check reads it: its rows and columns, and its merged cells. */
export interface GuestSheet {
  rows: number
  columns: number
  merges: Box[]
}

/** The most rows or columns one size change of a guest's covers, and the most cells one number format or merge covers. */
export const GUEST_SPAN_MAX = 10_000
export const GUEST_CELLS_MAX = 200_000
const ROWS = 1_048_576
const COLUMNS = 16_384

const PAST = 'that range runs past the end of the sheet'
const index = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0
const isBox = (r: unknown): r is Box => {
  const b = r as Partial<Box> | null
  return !!b && typeof b === 'object' && index(b.startRow) && index(b.endRow) && index(b.startColumn) && index(b.endColumn) && b.startRow <= b.endRow && b.startColumn <= b.endColumn
}
const copy = (r: Box): Box => ({ startRow: r.startRow, endRow: r.endRow, startColumn: r.startColumn, endColumn: r.endColumn })
const cellsOf = (r: Box): number => (r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1)
const meets = (a: Box, b: Box): boolean => a.startRow <= b.endRow && b.startRow <= a.endRow && a.startColumn <= b.endColumn && b.startColumn <= a.endColumn

/*
 * The two below are what Univer's own insert and delete mutations do to a sheet's merges (measured
 * on the engine, host/guest.test.ts): a merge that starts at or after the place moves; one the
 * place falls inside, or that the deleted rows cut, is left as it was. The grid's own command then
 * sends the merge parted and made again in its new shape, in the same batch, and those are read
 * against the merges as these leave them.
 */

/** Merges after `count` rows (or columns) are inserted before `at`: one that starts at or below it moves. */
function inserted(merges: Box[], rows: boolean, at: number, count: number): Box[] {
  const [start, end] = rows ? (['startRow', 'endRow'] as const) : (['startColumn', 'endColumn'] as const)
  return merges.map((m) => (m[start] >= at ? { ...m, [start]: m[start] + count, [end]: m[end] + count } : m))
}

/** Merges after rows (or columns) `from`..`to` are deleted: one that starts below them moves up. */
function removed(merges: Box[], rows: boolean, from: number, to: number): Box[] {
  const [start, end] = rows ? (['startRow', 'endRow'] as const) : (['startColumn', 'endColumn'] as const)
  const count = to - from + 1
  return merges.map((m) => (m[start] > to ? { ...m, [start]: m[start] - count, [end]: m[end] - count } : m))
}

/**
 * Why a guest's batch does not fit the sheet, or null. Each op is read against the sheet as the ops
 * before it in the batch leave it: rows and columns inserted or deleted move the end of the sheet
 * and its merges, so a merge made in rows the same press added passes and one over a merge that
 * moved does not. A cell is named by a row and a column that are indexes: a key such as "-1" or
 * "1.5" would be stored where no grid draws it and no export writes it.
 */
export function guestMisfit(mutations: readonly SheetMutationJson[], sheetOf: (id: string) => GuestSheet | null): string | null {
  return guestWalk(mutations, sheetOf).why
}

/** The walk behind `guestMisfit`, with each sheet as the batch leaves it (a test holds that against the engine's own). */
export function guestWalk(mutations: readonly SheetMutationJson[], sheetOf: (id: string) => GuestSheet | null): { why: string | null; sheets: Map<string, GuestSheet> } {
  const sheets = new Map<string, GuestSheet>()
  return { why: walk(mutations, sheetOf, sheets), sheets }
}

function walk(mutations: readonly SheetMutationJson[], sheetOf: (id: string) => GuestSheet | null, sheets: Map<string, GuestSheet>): string | null {
  let grown = 0
  for (const m of mutations) {
    const p = m.params as Record<string, unknown> & { subUnitId: string }
    let s = sheets.get(p.subUnitId)
    if (!s) {
      const held = sheetOf(p.subUnitId)
      if (!held) return 'that sheet is not in the workbook'
      s = { rows: held.rows, columns: held.columns, merges: held.merges.map(copy) }
      sheets.set(p.subUnitId, s)
    }
    const inside = (r: unknown): r is Box => isBox(r) && r.endRow < s.rows && r.endColumn < s.columns
    const ranges = (list: unknown): Box[] | null => (Array.isArray(list) && list.every(inside) ? (list as Box[]) : null)
    switch (m.id) {
      case SET_RANGE_VALUES: {
        for (const [r, cols] of Object.entries((p.cellValue ?? {}) as Record<string, Record<string, unknown> | null>)) {
          if (!INDEX_KEY.test(r) || !(Number(r) < s.rows)) return PAST
          for (const c of Object.keys(cols ?? {})) if (!INDEX_KEY.test(c) || !(Number(c) < s.columns)) return PAST
        }
        break
      }
      case 'sheet.mutation.insert-row':
      case 'sheet.mutation.insert-col': {
        const rows = m.id.endsWith('row')
        const r = p.range
        if (!isBox(r)) return 'a row or column change names its range'
        const at = rows ? r.startRow : r.startColumn
        const count = rows ? r.endRow - r.startRow + 1 : r.endColumn - r.startColumn + 1
        if (at > (rows ? s.rows : s.columns)) return PAST
        grown += count
        if (grown > STRUCTURAL_MAX) return `insert at most ${STRUCTURAL_MAX} rows or columns at once`
        if (rows ? s.rows + count > ROWS : s.columns + count > COLUMNS) return `a sheet has at most ${ROWS.toLocaleString('en')} rows and ${COLUMNS.toLocaleString('en')} columns`
        if (rows) s.rows += count
        else s.columns += count
        s.merges = inserted(s.merges, rows, at, count)
        break
      }
      case 'sheet.mutation.remove-rows':
      case 'sheet.mutation.remove-col': {
        const rows = m.id.endsWith('rows')
        const r = p.range
        if (!isBox(r)) return 'a row or column change names its range'
        const [from, to] = rows ? [r.startRow, r.endRow] : [r.startColumn, r.endColumn]
        if (to >= (rows ? s.rows : s.columns)) return PAST
        if (rows) s.rows -= to - from + 1
        else s.columns -= to - from + 1
        s.merges = removed(s.merges, rows, from, to)
        break
      }
      case 'sheet.mutation.set.numfmt':
      case 'sheet.mutation.remove.numfmt': {
        const lists = m.id.endsWith('remove.numfmt') ? [p.ranges] : Object.values((p.values ?? {}) as Record<string, { ranges?: unknown } | null>).map((v) => v?.ranges)
        let cells = 0
        for (const list of lists) {
          const boxes = ranges(list)
          if (!boxes) return PAST
          for (const b of boxes) cells += cellsOf(b)
        }
        if (cells > GUEST_CELLS_MAX) return `a number format is laid on at most ${GUEST_CELLS_MAX.toLocaleString('en')} cells at once`
        break
      }
      case 'sheet.mutation.set-worksheet-row-auto-height': {
        const list = p.rowsAutoHeightInfo
        if (!Array.isArray(list) || list.length > AUTO_ROWS_MAX) return `at most ${AUTO_ROWS_MAX.toLocaleString('en')} rows are sized at once`
        for (const row of list as { row?: unknown }[]) if (!index(row?.row) || row.row >= s.rows) return PAST
        break
      }
      case 'sheet.mutation.set-worksheet-row-height':
      case 'sheet.mutation.set-worksheet-row-is-auto-height':
      case 'sheet.mutation.set-worksheet-col-width': {
        const boxes = ranges(p.ranges)
        if (!boxes) return PAST
        const rows = !m.id.endsWith('col-width')
        const span = boxes.reduce((n, b) => n + (rows ? b.endRow - b.startRow + 1 : b.endColumn - b.startColumn + 1), 0)
        if (span > GUEST_SPAN_MAX) return `at most ${GUEST_SPAN_MAX.toLocaleString('en')} rows or columns are sized at once`
        break
      }
      case ADD_MERGE:
      case REMOVE_MERGE: {
        const boxes = ranges(p.ranges)
        if (!boxes) return PAST
        for (const r of boxes) {
          if (m.id === REMOVE_MERGE) {
            const at = s.merges.findIndex((x) => x.startRow === r.startRow && x.endRow === r.endRow && x.startColumn === r.startColumn && x.endColumn === r.endColumn)
            if (at >= 0) s.merges.splice(at, 1)
          } else if (s.merges.some((x) => meets(x, r))) return 'those cells overlap a merged cell'
          else if (cellsOf(r) > GUEST_CELLS_MAX) return `a merge covers at most ${GUEST_CELLS_MAX.toLocaleString('en')} cells`
          else s.merges.push(copy(r))
        }
        break
      }
    }
  }
  return null
}
