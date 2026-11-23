import type { ICellData } from '@univerjs/core'
import { formulaLexer, rebase, type SuggestionCell } from 'work-kit/sheet/suggest'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { SET_RANGE_VALUES, STRUCTURAL } from '../mutations'
import { WORKBOOK_MUTATIONS } from './rules'

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

/** The most ranges one merge or size change names, and the widest column and tallest row a guest may set (px). */
export const FORMAT_RANGES_MAX = 1000
export const SIZE_MAX = 2000
/** The most rows one fitted-height list names. */
export const AUTO_ROWS_MAX = 10_000
/** A row or column key as a grid writes one: a whole number with no sign, no fraction and no leading zero. */
export const INDEX_KEY = /^(0|[1-9]\d{0,6})$/
/** Excel's own limits: the characters a cell holds, and a formula's length. */
export const CELL_TEXT_MAX = 32_767
export const FORMULA_MAX = 8_192
/** The most one send of a guest's may weigh, as JSON. One press of the page is a few thousand bytes; a paste of a few thousand styled cells is under a megabyte. */
export const GUEST_SEND_MAX = 2 * 1024 * 1024
/** The longest string a guest's style may hold (a number format's code is at most 255 characters in Excel). */
const STYLE_TEXT_MAX = 255
/** The largest number a guest's style may hold: a theme colour's tag (work-kit `themeTag`) is the largest the grid writes, under 400,000. */
const STYLE_NUMBER_MAX = 1_000_000
const ROWS = 1_048_576
const COLUMNS = 16_384

const box = (r: unknown): boolean => {
  const b = r as { startRow?: unknown; endRow?: unknown; startColumn?: unknown; endColumn?: unknown } | null
  return !!b && typeof b === 'object' && int(b.startRow) && int(b.endRow) && int(b.startColumn) && int(b.endColumn) && b.startRow <= b.endRow && b.startColumn <= b.endColumn && b.endRow < ROWS && b.endColumn < COLUMNS
}
const boxes = (ranges: unknown): boolean => Array.isArray(ranges) && ranges.length > 0 && ranges.length <= FORMAT_RANGES_MAX && ranges.every(box)
const size = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= SIZE_MAX
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

/** The most rows or columns one insert or delete may span. */
export const STRUCTURAL_MAX = 1000

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
    if (typeof (m.params as { subUnitId?: unknown }).subUnitId !== 'string') return 'a mutation names its sheet'
    if (guest && !GUEST_OPS.has(m.id)) return `a guest cannot ${m.id.replace(/^sheet\.mutation\./, '').replace(/-/g, ' ')}`
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

const NEVER_A_KEY = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * A guest's style as the grid's own: short keys, numbers, flags and short strings, a few levels
 * deep. Univer drops a key it does not know but keeps any value whole, so a string of a hundred
 * thousand characters in a colour would stay in the workbook's styles for good.
 */
function guestStyle(style: unknown, depth = 0): unknown {
  if (style === null) return null
  if (typeof style === 'string') return style.length <= 64 ? style : undefined
  if (typeof style !== 'object' || Array.isArray(style) || depth > 4) return undefined
  const out: Record<string, unknown> = {}
  let kept = 0
  for (const [k, v] of Object.entries(style)) {
    if (!/^[A-Za-z_]{1,12}$/.test(k) || NEVER_A_KEY.has(k) || kept >= 24) continue
    let value: unknown
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Math.abs(v) <= STYLE_NUMBER_MAX)) value = v
    else if (typeof v === 'string') value = v.length <= STYLE_TEXT_MAX ? v : undefined
    else value = guestStyle(v, depth + 1)
    if (value === undefined) continue
    out[k] = value
    kept++
  }
  return out
}

/** A formula without the prefixes Excel's files give newer functions and a lambda's own names (`_xlfn.`, `_xlws.`, `_xlpm.`, `_xludf.`): the engine reads the plain names, and throws on the prefixed ones. Text in quotes is left as it is. */
export const plainFormula = (f: string): string =>
  f.includes('_xl')
    ? f
        .split('"')
        .map((part, i) => (i % 2 ? part : part.replace(/_xl(?:fn|ws|pm|udf)\./gi, '')))
        .join('"')
    : f

/** What an inserted row or column may carry beside its place: its height or its width, nothing else (not hidden, no other key). */
function sizesOnly(info: unknown, key: 'h' | 'w'): Record<string, Record<string, number>> | undefined {
  if (!info || typeof info !== 'object') return undefined
  const out: Record<string, Record<string, number>> = {}
  let kept = 0
  for (const [k, v] of Object.entries(info)) {
    const n = (v as Record<string, unknown> | null)?.[key]
    if (!INDEX_KEY.test(k) || kept >= STRUCTURAL_MAX || !size(n)) continue
    out[k] = { [key]: n as number }
    kept++
  }
  return kept ? out : undefined
}

/**
 * A guest's ops cut to what a guest may send: cells as values, formulas, styles and types only (no
 * rich text, no custom data), named by indexes, a style held to the grid's own shape, a formula in
 * plain names; an inserted row or column with its size and nothing else.
 */
export function guestCells(mutations: readonly SheetMutationJson[]): SheetMutationJson[] {
  return mutations.map((m) => {
    if (m.id === 'sheet.mutation.insert-row' || m.id === 'sheet.mutation.insert-col') {
      const p = m.params as { unitId?: unknown; subUnitId?: unknown; range?: unknown; rowInfo?: unknown; colInfo?: unknown }
      const rows = m.id.endsWith('row')
      const info = rows ? sizesOnly(p.rowInfo, 'h') : sizesOnly(p.colInfo, 'w')
      return { id: m.id, params: { unitId: p.unitId, subUnitId: p.subUnitId, range: p.range, ...(info ? { [rows ? 'rowInfo' : 'colInfo']: info } : {}) } }
    }
    if (m.id !== SET_RANGE_VALUES) return m
    const p = m.params as { cellValue?: Matrix }
    const cellValue: Matrix = {}
    for (const [r, cols] of Object.entries(p.cellValue ?? {})) {
      if (!INDEX_KEY.test(r)) continue
      const row: Record<string, ICellData | null> = (cellValue[r] = {})
      for (const [c, cell] of Object.entries(cols ?? {})) {
        if (!INDEX_KEY.test(c)) continue
        if (cell === null) row[c] = null
        else {
          const kept: Record<string, unknown> = {}
          for (const k of ['v', 'f', 't'] as const) if (k in cell) kept[k] = cell[k]
          if (typeof kept.f === 'string') kept.f = plainFormula(kept.f)
          if ('s' in cell) {
            const style = guestStyle(cell.s)
            if (style !== undefined) kept.s = style
          }
          row[c] = kept as ICellData
        }
      }
    }
    return { id: m.id, params: { ...p, cellValue } }
  })
}

type Matrix = Record<string, Record<string, ICellData | null>>

/**
 * Rule mutations that name their rule by id and hold no cell, range or reference: a row or column
 * inserted or deleted cannot make them wrong, so they pass a structural op as they are. Every other
 * rule mutation holds ranges (a conditional format's, a validation's, a filter's, a sort's
 * reorder), a setting that may hold a reference (a validation's list from a range), or a formula
 * (a defined name): moved wrong it would corrupt the rule, so it answers null.
 */
export const MOVES_AS_IS: ReadonlySet<string> = new Set([
  'sheet.mutation.delete-conditional-rule',
  'sheet.mutation.move-conditional-rule',
  'data-validation.mutation.removeRule',
  'formula.mutation.remove-defined-name'
])

/**
 * An edit made on an older revision, moved through the ops it missed: its cells follow rows and
 * columns inserted or deleted before them (a cell whose row went is dropped), with their formulas
 * moved too, and a rule named only by its id passes as it is (`MOVES_AS_IS`). Null when it cannot
 * be moved (it is itself structural, a format over a moved range, or a rule with a range or a
 * formula): the client reloads and makes it again.
 */
export function moveThrough(mutations: readonly SheetMutationJson[], missed: readonly SheetMutationJson[]): SheetMutationJson[] | null {
  if (!missed.some((m) => STRUCTURAL.has(m.id))) return [...mutations]
  if (mutations.some((m) => m.id !== SET_RANGE_VALUES && !MOVES_AS_IS.has(m.id))) return null
  const lexer = formulaLexer()
  return mutations.map((m) => {
    if (m.id !== SET_RANGE_VALUES) return m
    const p = m.params as { unitId: string; subUnitId: string; cellValue?: Matrix }
    const cells: SuggestionCell[] = []
    for (const [r, cols] of Object.entries(p.cellValue ?? {}))
      for (const [c, cell] of Object.entries(cols ?? {})) cells.push({ id: `${r}:${c}`, changeSet: 'live', sheet: p.subUnitId, row: Number(r), column: Number(c), base: null, proposed: cell, state: 'pending' })
    // The base is empty and so is what "current" reads: nothing here can conflict, the cells only move.
    const moved = rebase(cells, missed, () => null, lexer, { sheetId: () => undefined })
    const cellValue: Matrix = {}
    for (const cell of moved) if (cell.state !== 'orphaned') (cellValue[cell.row] ??= {})[cell.column] = cell.proposed
    return { id: m.id, params: { ...p, cellValue } }
  })
}
