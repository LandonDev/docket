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

/** Why a client's ops are refused, or null. A guest is held to `GUEST_OPS`; nobody but an editor writes. */
export function refusal(mutations: readonly SheetMutationJson[], role: string, guest: boolean): string | null {
  if (role !== 'edit') return 'this link can view, not edit'
  if (!Array.isArray(mutations) || !mutations.length || mutations.length > 500) return 'ops is 1 to 500 mutations'
  for (const m of mutations) {
    if (!m || typeof m.id !== 'string' || typeof m.params !== 'object' || m.params === null) return 'a mutation is an id and its params'
    if (guest && !GUEST_OPS.has(m.id)) return `a guest cannot ${m.id.replace(/^sheet\.mutation\./, '').replace(/-/g, ' ')}`
  }
  return null
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
