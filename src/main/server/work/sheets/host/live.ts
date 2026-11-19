import type { ICellData } from '@univerjs/core'
import { formulaLexer, rebase, type SuggestionCell } from 'work-kit/sheet/suggest'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { SET_RANGE_VALUES, STRUCTURAL } from '../mutations'

/**
 * The rules of the live sheet route (architecture §7, docs/agents/work-sheets.md
 * "Live editing"): clients send `{baseRev, ops}`; the service orders them,
 * moves an edit that missed rows or columns inserted or deleted before it,
 * and checks a guest's ops against what a guest may do.
 */

/** What a guest with edit rights may send: cell values and formats, and inserting or deleting rows and columns. */
export const GUEST_OPS = new Set([
  SET_RANGE_VALUES,
  'sheet.mutation.set.numfmt',
  'sheet.mutation.remove.numfmt',
  'sheet.mutation.insert-row',
  'sheet.mutation.remove-rows',
  'sheet.mutation.insert-col',
  'sheet.mutation.remove-col',
  'sheet.mutation.set-worksheet-row-auto-height',
  'sheet.mutation.set-worksheet-row-is-auto-height'
])

/** The most rows or columns one insert or delete may span. */
export const STRUCTURAL_MAX = 1000

const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2_000_000

/** Why a client's ops are refused, or null. A guest is held to `GUEST_OPS`; nobody but an editor writes. */
export function refusal(mutations: readonly SheetMutationJson[], role: string, guest: boolean): string | null {
  if (role !== 'edit') return 'this link can view, not edit'
  if (!Array.isArray(mutations) || !mutations.length || mutations.length > 500) return 'ops is 1 to 500 mutations'
  for (const m of mutations) {
    if (!m || typeof m.id !== 'string' || typeof m.params !== 'object' || m.params === null) return 'a mutation is an id and its params'
    if (typeof (m.params as { subUnitId?: unknown }).subUnitId !== 'string') return 'a mutation names its sheet'
    if (guest && !GUEST_OPS.has(m.id)) return `a guest cannot ${m.id.replace(/^sheet\.mutation\./, '').replace(/-/g, ' ')}`
    if (m.id.includes('.insert-') || m.id.includes('.remove-')) {
      const r = (m.params as { range?: { startRow?: unknown; endRow?: unknown; startColumn?: unknown; endColumn?: unknown } }).range
      if (!r || !int(r.startRow) || !int(r.endRow) || !int(r.startColumn) || !int(r.endColumn) || r.endRow < r.startRow || r.endColumn < r.startColumn) return 'a row or column change names its range'
      const rows = m.id.includes('row') ? r.endRow - r.startRow + 1 : 0
      const cols = m.id.includes('col') ? r.endColumn - r.startColumn + 1 : 0
      if (rows > STRUCTURAL_MAX || cols > STRUCTURAL_MAX) return `insert or delete at most ${STRUCTURAL_MAX} rows or columns at once`
    }
  }
  return null
}

/** A guest's cells as values, formulas and formats only: no rich text, no custom data. */
export function guestCells(mutations: readonly SheetMutationJson[]): SheetMutationJson[] {
  return mutations.map((m) => {
    if (m.id !== SET_RANGE_VALUES) return m
    const p = m.params as { cellValue?: Matrix }
    const cellValue: Matrix = {}
    for (const [r, cols] of Object.entries(p.cellValue ?? {})) {
      const row: Record<string, ICellData | null> = (cellValue[r] = {})
      for (const [c, cell] of Object.entries(cols ?? {})) {
        if (cell === null) row[c] = null
        else {
          const kept: ICellData = {}
          for (const k of ['v', 'f', 's', 't'] as const) if (k in cell) (kept as Record<string, unknown>)[k] = cell[k]
          row[c] = kept
        }
      }
    }
    return { id: m.id, params: { ...p, cellValue } }
  })
}

type Matrix = Record<string, Record<string, ICellData | null>>

/**
 * An edit made on an older revision, moved through the ops it missed: its cells follow rows and
 * columns inserted or deleted before them (a cell whose row went is dropped), with their formulas
 * moved too. Null when it cannot be moved (it is itself structural, or a format over a moved range):
 * the client reloads and makes it again.
 */
export function moveThrough(mutations: readonly SheetMutationJson[], missed: readonly SheetMutationJson[]): SheetMutationJson[] | null {
  if (!missed.some((m) => STRUCTURAL.has(m.id))) return [...mutations]
  if (mutations.some((m) => m.id !== SET_RANGE_VALUES)) return null
  const lexer = formulaLexer()
  return mutations.map((m) => {
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
