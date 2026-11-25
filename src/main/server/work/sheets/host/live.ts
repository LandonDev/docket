import { MOVES_AS_IS, moveThrough as move } from 'work-kit/sheet/collab'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { SET_RANGE_VALUES } from '../mutations'
import { WORKBOOK_MUTATIONS } from './rules'
// (by its path: the Work service reaches this file, and its bundle resolves no alias for a value)
import { guestSize, INDEX_KEY, SIZE_MAX, STRUCTURAL_MAX } from '../../../../../shared/work/sheetGuest'

export { INDEX_KEY, MOVES_AS_IS, SIZE_MAX, STRUCTURAL_MAX }

/**
 * The rules of the live sheet route (architecture §7, docs/agents/work-sheets.md
 * "Live editing"): clients send `{baseRev, ops}`; the service orders them,
 * moves an edit that missed rows or columns inserted or deleted before it,
 * and checks a guest's ops against what a guest may do.
 */

const COL_WIDTH = 'sheet.mutation.set-worksheet-col-width'
const ROW_HEIGHT = 'sheet.mutation.set-worksheet-row-height'
export const ADD_MERGE = 'sheet.mutation.add-worksheet-merge'
export const REMOVE_MERGE = 'sheet.mutation.remove-worksheet-merge'
const IS_AUTO_HEIGHT = 'sheet.mutation.set-worksheet-row-is-auto-height'
const AUTO_HEIGHT = 'sheet.mutation.set-worksheet-row-auto-height'
const SET_NUMFMT = 'sheet.mutation.set.numfmt'
/** The grid's note mutations (work-kit's `NOTE_MUTATIONS`): an editor's to send, never a guest's. */
const NOTE_IDS: ReadonlySet<string> = new Set(['sheet.mutation.update-note', 'sheet.mutation.remove-note', 'sheet.mutation.update-note-position'])
const REMOVE_NUMFMT = 'sheet.mutation.remove.numfmt'

/**
 * What a guest with edit rights may send: cell values and formats, inserting or deleting rows and
 * columns, and what the format row sends beside a cell's style: a merge made or parted, a column's
 * width, a row's height. Nothing else: no rule, no name, no filter, no sheet added or removed.
 */
export const GUEST_OPS = new Set([
  SET_RANGE_VALUES,
  SET_NUMFMT,
  REMOVE_NUMFMT,
  'sheet.mutation.insert-row',
  'sheet.mutation.remove-rows',
  'sheet.mutation.insert-col',
  'sheet.mutation.remove-col',
  AUTO_HEIGHT,
  IS_AUTO_HEIGHT,
  ADD_MERGE,
  REMOVE_MERGE,
  COL_WIDTH,
  ROW_HEIGHT
])

/** The most ranges one merge or size change names. */
export const FORMAT_RANGES_MAX = 1000
/** The most rows one fitted-height list names. */
export const AUTO_ROWS_MAX = 10_000
/** Excel's own limits: the characters a cell holds, and a formula's length. */
export const CELL_TEXT_MAX = 32_767
export const FORMULA_MAX = 8_192
/** The most one send of a guest's may weigh, as JSON. One press of the page is a few thousand bytes; a paste of a few thousand styled cells is under a megabyte. */
export const GUEST_SEND_MAX = 2 * 1024 * 1024
const ROWS = 1_048_576
const COLUMNS = 16_384

const box = (r: unknown): boolean => {
  const b = r as { startRow?: unknown; endRow?: unknown; startColumn?: unknown; endColumn?: unknown } | null
  return !!b && typeof b === 'object' && int(b.startRow) && int(b.endRow) && int(b.startColumn) && int(b.endColumn) && b.startRow <= b.endRow && b.startColumn <= b.endColumn && b.endRow < ROWS && b.endColumn < COLUMNS
}
const boxes = (ranges: unknown): boolean => Array.isArray(ranges) && ranges.length > 0 && ranges.length <= FORMAT_RANGES_MAX && ranges.every(box)
const size = guestSize
/** One size for every range, or one a row or column by its index (how an undo gives each its own back; null gives the default back). */
const sizes = (v: unknown, most: number): boolean => {
  if (size(v)) return true
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const entries = Object.entries(v)
  return entries.length > 0 && entries.length <= most && entries.every(([k, n]) => /^\d{1,7}$/.test(k) && Number(k) < most && (n === null || size(n)))
}

/**
 * Why a guest's merge, size change or number format is refused, or null: its ranges lie on the grid and its sizes
 * are sizes. Whether they lie on the sheet is the host's to say (guest.ts `guestMisfit`): only the engine knows it.
 */
function formatShape(m: SheetMutationJson): string | null {
  const p = m.params as { ranges?: unknown; colWidth?: unknown; rowHeight?: unknown; values?: unknown; rowsAutoHeightInfo?: unknown }
  if (m.id === SET_NUMFMT) {
    const values = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? Object.values(p.values) : null
    return values && values.length <= FORMAT_RANGES_MAX && values.every((v) => boxes((v as { ranges?: unknown } | null)?.ranges)) ? null : `a number format names at most ${FORMAT_RANGES_MAX} ranges on the grid`
  }
  if (m.id === AUTO_HEIGHT) {
    const list = p.rowsAutoHeightInfo
    return Array.isArray(list) && list.length <= AUTO_ROWS_MAX && list.every((r) => !!r && int((r as { row?: unknown }).row) && (r as { row: number }).row < ROWS) ? null : `at most ${AUTO_ROWS_MAX.toLocaleString('en')} rows are sized at once`
  }
  if (m.id !== ADD_MERGE && m.id !== REMOVE_MERGE && m.id !== COL_WIDTH && m.id !== ROW_HEIGHT && m.id !== IS_AUTO_HEIGHT && m.id !== REMOVE_NUMFMT) return null
  if (!boxes(p.ranges)) return `a merge, a size change or a number format names at most ${FORMAT_RANGES_MAX} ranges on the grid`
  if (m.id === COL_WIDTH && !sizes(p.colWidth, COLUMNS)) return `a column is at most ${SIZE_MAX} wide`
  if (m.id === ROW_HEIGHT && !sizes(p.rowHeight, ROWS)) return `a row is at most ${SIZE_MAX} tall`
  return null
}

/** Rows and columns inserted or deleted: each names its range. */
const ROWS_AND_COLUMNS = new Set(['sheet.mutation.insert-row', 'sheet.mutation.remove-rows', 'sheet.mutation.insert-col', 'sheet.mutation.remove-col'])


const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2_000_000
const text = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/**
 * Why a client's ops are refused, or null. A guest is held to `GUEST_OPS`, and its merges, sizes and
 * number formats to ranges on the grid and sizes that are sizes; nobody but an editor writes. A mutation names its sheet, except a defined name's, which is the workbook's: an editor
 * may send one (an id, a name, a formula, and a sheet id when it is local); a guest may not.
 */
/**
 * Why a set of cells is refused, or null. Nobody sends a formula longer than Excel takes (the engine
 * overflows on one of forty thousand characters). A guest's cells are named by a row and a column
 * that are indexes, and hold a value, a formula, a style and a type of the sizes a sheet holds.
 */
function cellsShape(cellValue: unknown, guest: boolean): string | null {
  if (cellValue === undefined || cellValue === null) return null
  if (typeof cellValue !== 'object' || Array.isArray(cellValue)) return guest ? 'cells are named by row and column' : null
  for (const [r, cols] of Object.entries(cellValue as Record<string, unknown>)) {
    if (guest && !INDEX_KEY.test(r)) return 'a cell is named by its row and column'
    if (cols === null || typeof cols !== 'object') {
      if (guest && cols !== null) return 'a cell is named by its row and column'
      continue
    }
    for (const [c, cell] of Object.entries(cols as Record<string, unknown>)) {
      if (guest && !INDEX_KEY.test(c)) return 'a cell is named by its row and column'
      if (cell === null || typeof cell !== 'object') {
        if (guest && cell !== null) return 'a cell is a value, a formula and a format'
        continue
      }
      const { v, f, t, s } = cell as { v?: unknown; f?: unknown; t?: unknown; s?: unknown }
      if (typeof f === 'string' && f.length > FORMULA_MAX) return `a formula is at most ${FORMULA_MAX.toLocaleString('en')} characters`
      if (!guest) continue
      if (f !== undefined && f !== null && typeof f !== 'string') return 'a cell is a value, a formula and a format'
      if (typeof v === 'string' ? v.length > CELL_TEXT_MAX : !(v === undefined || v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) return `a cell holds at most ${CELL_TEXT_MAX.toLocaleString('en')} characters`
      if (t !== undefined && t !== null && !(typeof t === 'number' && Number.isInteger(t) && t >= 0 && t <= 9)) return 'a cell is a value, a formula and a format'
      if (s !== undefined && s !== null && typeof s !== 'string' && (typeof s !== 'object' || Array.isArray(s))) return 'a cell is a value, a formula and a format'
    }
  }
  return null
}

export function refusal(mutations: readonly SheetMutationJson[], role: string, guest: boolean): string | null {
  if (role !== 'edit') return 'this link can view, not edit'
  if (!Array.isArray(mutations) || !mutations.length || mutations.length > 500) return 'ops is 1 to 500 mutations'
  if (guest && JSON.stringify(mutations).length > GUEST_SEND_MAX) return 'a guest sends at most 2 MiB at once'
  for (const m of mutations) {
    if (!m || typeof m.id !== 'string' || typeof m.params !== 'object' || m.params === null) return 'a mutation is an id and its params'
    if (m.id === SET_RANGE_VALUES) {
      const cells = cellsShape((m.params as { cellValue?: unknown }).cellValue, guest)
      if (cells) return cells
    }
    if (WORKBOOK_MUTATIONS.has(m.id)) {
      if (guest) return 'a guest cannot change the workbook\'s names'
      const p = m.params as { id?: unknown; name?: unknown; formulaOrRefString?: unknown; localSheetId?: unknown }
      if (!text(p.id, 200) || !text(p.name, 255) || typeof p.formulaOrRefString !== 'string' || p.formulaOrRefString.length > 8192) return 'a defined name is an id, a name and a formula'
      if (p.localSheetId !== undefined && !text(p.localSheetId, 200)) return 'a defined name\'s sheet is a sheet id'
      continue
    }
    if (NOTE_IDS.has(m.id)) {
      // A note's mutation names its sheet as `sheetId`. Not in `GUEST_OPS`: a guest reads notes and changes none.
      if (guest) return 'a guest cannot change a note'
      const p = m.params as { sheetId?: unknown; row?: unknown; col?: unknown; newPosition?: { row?: unknown; col?: unknown } }
      const at = m.id === 'sheet.mutation.update-note-position' ? p.newPosition : p
      if (!text(p.sheetId, 200) || !int(at?.row) || !int(at?.col)) return 'a note names its sheet, row and column'
      continue
    }
    // What a guest may not send is said as that first: a tab added names no sheet yet, and "a mutation names its sheet" says nothing to a guest.
    if (guest && !GUEST_OPS.has(m.id)) return `a guest cannot ${m.id.replace(/^sheet\.mutation\./, '').replace(/-/g, ' ')}`
    if (typeof (m.params as { subUnitId?: unknown }).subUnitId !== 'string') return 'a mutation names its sheet'
    if (guest) {
      const shape = formatShape(m)
      if (shape) return shape
    }
    // (by name: a merge parted, a filter or a sheet removed are not rows or columns)
    if (ROWS_AND_COLUMNS.has(m.id)) {
      const r = (m.params as { range?: { startRow?: unknown; endRow?: unknown; startColumn?: unknown; endColumn?: unknown } }).range
      if (!r || !int(r.startRow) || !int(r.endRow) || !int(r.startColumn) || !int(r.endColumn) || r.endRow < r.startRow || r.endColumn < r.startColumn) return 'a row or column change names its range'
      const rows = m.id.includes('row') ? r.endRow - r.startRow + 1 : 0
      const cols = m.id.includes('col') ? r.endColumn - r.startColumn + 1 : 0
      if (rows > STRUCTURAL_MAX || cols > STRUCTURAL_MAX) return `insert or delete at most ${STRUCTURAL_MAX} rows or columns at once`
    }
  }
  return null
}

export { guestCells, plainFormula } from '../../../../../shared/work/sheetGuest'

/**
 * An edit made on an older revision, moved through the ops it missed (work-kit/sheet/collab, the move the page's
 * session runs too): cells, formats, sizes and merges follow rows and columns inserted or deleted before them (a
 * cell whose row went is dropped, a formula's references move), two row or column changes are shifted by index, and
 * a rule named only by its id passes as it is (`MOVES_AS_IS`). Null when it cannot be moved (a rule with a range or
 * a formula, a sheet op, a row change that cuts a merge made beside it): the client takes the sheet as it stands and
 * says so. An empty answer is not a refusal: nothing of the edit is left to commit.
 */
export function moveThrough(mutations: readonly SheetMutationJson[], missed: readonly SheetMutationJson[]): SheetMutationJson[] | null {
  return move(mutations as readonly { id: string; params: Record<string, unknown> }[], missed as readonly { id: string; params: Record<string, unknown> }[], 'after') as SheetMutationJson[] | null
}
