import type { IWorkbookData } from '@univerjs/core'
import { putTable } from 'work-kit/sheet/tables'
import type { SheetMutationJson } from '@shared/contract-work-sheets'

/**
 * A workbook's rules as the host's engine keeps them (work-kit's `headlessSheet` with `rules`):
 * conditional formats, validations, filters and defined names, each a resource of the snapshot.
 * `ruleMutations` turns one workbook's rules into another's, for a restore: cells are restored
 * by their diff, rules by these.
 */

export const RULE_RESOURCES = {
  conditionalFormats: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN',
  validations: 'SHEET_DATA_VALIDATION_PLUGIN',
  filters: 'SHEET_FILTER_PLUGIN',
  definedNames: 'SHEET_DEFINED_NAME_PLUGIN',
  tables: 'SHEET_TABLE_PLUGIN'
} as const

/** The defined-name mutations: workbook-level, no `subUnitId`. */
export const WORKBOOK_MUTATIONS: ReadonlySet<string> = new Set(['formula.mutation.set-defined-name', 'formula.mutation.remove-defined-name'])

type ById<T> = Record<string, T>
interface CfRule {
  cfId: string
}
interface DvRule {
  uid: string
}
interface AutoFilter {
  ref: object
  filterColumns?: Array<{ colId: number }>
}
interface DefinedName {
  id: string
}
/** A sheet's tables as Univer's table plugin keeps them. */
interface TableList {
  tables?: Table[]
}
interface Table {
  id: string
  name: string
  range: object
  options?: object
  meta?: object
  columns?: Array<{ displayName?: string }>
}

function resource<T>(wb: IWorkbookData, name: string): ById<T> {
  const data = wb.resources?.find((r) => r.name === name)?.data
  if (!data) return {}
  try {
    return (JSON.parse(data) ?? {}) as ById<T>
  } catch {
    return {}
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The mutations that turn `from`'s rules into `to`'s, for the sheets `from` still has. A sheet whose
 * list differs has its list replaced whole: each rule of `from` removed, each of `to` added, so the
 * order (a conditional format's priority) comes out as `to` has it. A sheet's tables are replaced
 * the same way: each of `from` deleted, each of `to` added by its own id, name, range, options and
 * column names (a table's own filter criteria are not carried: the table plugin takes them only
 * through its filter mutation, which a restore does not replay).
 */
export function ruleMutations(unitId: string, from: IWorkbookData, to: IWorkbookData): SheetMutationJson[] {
  const out: SheetMutationJson[] = []
  const sheets = Object.keys(from.sheets ?? {})

  const cfFrom = resource<CfRule[]>(from, RULE_RESOURCES.conditionalFormats)
  const cfTo = resource<CfRule[]>(to, RULE_RESOURCES.conditionalFormats)
  for (const subUnitId of sheets) {
    const a = cfFrom[subUnitId] ?? []
    const b = cfTo[subUnitId] ?? []
    if (same(a, b)) continue
    for (const rule of a) out.push({ id: 'sheet.mutation.delete-conditional-rule', params: { unitId, subUnitId, cfId: rule.cfId } })
    // A rule added goes on top of the list: add the last first.
    for (const rule of [...b].reverse()) out.push({ id: 'sheet.mutation.add-conditional-rule', params: { unitId, subUnitId, rule } })
  }

  const dvFrom = resource<DvRule[]>(from, RULE_RESOURCES.validations)
  const dvTo = resource<DvRule[]>(to, RULE_RESOURCES.validations)
  for (const subUnitId of sheets) {
    const a = dvFrom[subUnitId] ?? []
    const b = dvTo[subUnitId] ?? []
    if (same(a, b)) continue
    for (const rule of a) out.push({ id: 'data-validation.mutation.removeRule', params: { unitId, subUnitId, ruleId: rule.uid } })
    for (const rule of b) out.push({ id: 'data-validation.mutation.addRule', params: { unitId, subUnitId, rule } })
  }

  const fFrom = resource<AutoFilter>(from, RULE_RESOURCES.filters)
  const fTo = resource<AutoFilter>(to, RULE_RESOURCES.filters)
  for (const subUnitId of sheets) {
    const a = fFrom[subUnitId]
    const b = fTo[subUnitId]
    if (same(a, b)) continue
    if (a) out.push({ id: 'sheet.mutation.remove-filter', params: { unitId, subUnitId } })
    if (b) {
      out.push({ id: 'sheet.mutation.set-filter-range', params: { unitId, subUnitId, range: b.ref } })
      for (const column of b.filterColumns ?? []) out.push({ id: 'sheet.mutation.set-filter-criteria', params: { unitId, subUnitId, col: column.colId, criteria: column } })
    }
  }

  const tFrom = resource<TableList>(from, RULE_RESOURCES.tables)
  const tTo = resource<TableList>(to, RULE_RESOURCES.tables)
  for (const subUnitId of sheets) {
    const a = tFrom[subUnitId]?.tables ?? []
    const b = tTo[subUnitId]?.tables ?? []
    if (same(a, b)) continue
    for (const table of a) out.push({ id: 'sheet.mutation.delete-table', params: { unitId, subUnitId, tableId: table.id } })
    // (the kit's `putTable`: the table with its columns' own ids, its filters, its calculated columns and its sort; an add-table with a header alone makes new column ids, and a total row's functions are kept by column id)
    for (const table of b) for (const m of putTable(unitId, subUnitId, table as never)) out.push({ id: m.id, params: m.params })
  }

  const nFrom = resource<DefinedName>(from, RULE_RESOURCES.definedNames)
  const nTo = resource<DefinedName>(to, RULE_RESOURCES.definedNames)
  for (const [id, name] of Object.entries(nFrom)) {
    if (!same(name, nTo[id])) out.push({ id: 'formula.mutation.remove-defined-name', params: { unitId, ...name } })
  }
  for (const [id, name] of Object.entries(nTo)) {
    if (!same(name, nFrom[id])) out.push({ id: 'formula.mutation.set-defined-name', params: { unitId, ...name } })
  }
  return out
}

/** Univer's note resource: by sheet id, row and column, each note whole (work-kit's README "Notes and comments"). */
export const NOTES_RESOURCE = 'SHEET_NOTE_PLUGIN'
interface KeptNote {
  id: string
  row: number
  col: number
  note: string
}

/**
 * The mutations that turn `from`'s notes into `to`'s, for a restore, on the sheets `from` still has:
 * a note `to` lacks at its cell is removed, and one it has differently is put whole (its id, words,
 * author and box), as the grid's own note mutations do. A thread's stand-in note is a note like any
 * other here; the thread's words are never changed, so nothing restores them.
 */
export function noteMutations(unitId: string, from: IWorkbookData, to: IWorkbookData): SheetMutationJson[] {
  const out: SheetMutationJson[] = []
  const a = resource<Record<string, Record<string, KeptNote>>>(from, NOTES_RESOURCE)
  const b = resource<Record<string, Record<string, KeptNote>>>(to, NOTES_RESOURCE)
  const cells = (sheet: Record<string, Record<string, KeptNote>> | undefined): Map<string, KeptNote> => {
    const m = new Map<string, KeptNote>()
    for (const [row, cols] of Object.entries(sheet ?? {})) for (const [col, note] of Object.entries(cols ?? {})) if (note) m.set(`${row}:${col}`, note)
    return m
  }
  for (const sheetId of Object.keys(from.sheets ?? {})) {
    const was = cells(a[sheetId])
    const then = cells(b[sheetId])
    for (const [at, note] of was) {
      const back = then.get(at)
      if (!back || back.id !== note.id) out.push({ id: 'sheet.mutation.remove-note', params: { unitId, sheetId, noteId: note.id, row: note.row, col: note.col } })
    }
    for (const [at, note] of then) {
      if (same(note, was.get(at))) continue
      out.push({ id: 'sheet.mutation.update-note', params: { unitId, sheetId, row: note.row, col: note.col, note } })
    }
  }
  return out
}

/** One sheet's notes from the note resource's JSON, by `row:col`, as an agent reads them: a thread's stand-in is not a note. */
export function sheetNotes(json: string | undefined, sheetId: string): Map<string, string> {
  const out = new Map<string, string>()
  let all: Record<string, Record<string, Record<string, { note?: unknown; thread?: unknown } | null>>> = {}
  try {
    all = JSON.parse(json || '{}') ?? {}
  } catch {
    return out
  }
  for (const [row, cols] of Object.entries(all[sheetId] ?? {}))
    for (const [col, note] of Object.entries(cols ?? {})) if (note && typeof note.note === 'string' && !note.thread) out.set(`${row}:${col}`, note.note)
  return out
}
