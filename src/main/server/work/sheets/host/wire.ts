import type { SheetCellDiff, SheetMutationJson, SheetRevision, SheetSuggestion } from '@shared/contract-work-sheets'

/**
 * What main asks the Work service's sheet host (host/), over the service's
 * socket at `/internal/sheet/<op>` (routes/internalSheet.ts). Types only: the
 * service imports nothing of main's and main nothing of the service's.
 */

/** A sheet the service holds: a LifeOS sheet by id, or a `.tcsheet` on this host by path. */
export type SheetRef = { lifeos: string } | { tcsheet: string }

/** A cell as agents write it: A1, then a value or a formula. A value of null clears the cell. */
export interface A1Cell {
  at: string
  v?: string | number | boolean | null
  f?: string
}

/** The rules a sheet holds, as far as a new one is checked against them: each name with its scope, each sheet's filter and validated ranges. */
export interface RulesHeld {
  names: { name: string; scope?: string }[]
  filters: Record<string, RuleBox>
  validations: Record<string, RuleBox[]>
}
export interface RuleBox {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

export type Which = { ids: string[] } | { changeSet: string } | 'all'

export type HostAsk =
  | { op: 'open'; sheet: SheetRef }
  | { op: 'snapshot'; sheet: SheetRef; rev: number; offset: number; length: number }
  | { op: 'since'; sheet: SheetRef; rev: number }
  | { op: 'apply'; sheet: SheetRef; baseRev: number; mutations: SheetMutationJson[]; by: string }
  | { op: 'range'; sheet: SheetRef; range: string }
  | { op: 'cells'; sheet: SheetRef; cells: A1Cell[]; by: string; label: string; suggest: boolean; reason?: string }
  | { op: 'review'; sheet: SheetRef; which: Which; verdict: 'accept' | 'reject' }
  | { op: 'history'; sheet: SheetRef }
  | { op: 'compare'; sheet: SheetRef; from: number; to: number; max: number }
  | { op: 'restore'; sheet: SheetRef; rev: number; by: string }
  | { op: 'create'; title: string; at: { tcsheet: string } | { lifeos: { sector: string; projectId?: string } } }

interface Answers {
  /** `unit` is the workbook's id in every grid of it and `sheets` its tabs in order: what a mutation made elsewhere names */
  open: { title: string; rev: number; shared: boolean; suggestions: SheetSuggestion[]; missing?: boolean; unit: string; sheets: { id: string; name: string }[]; rules: RulesHeld }
  /** a frame of the workbook as Univer's JSON at `rev`, base64 */
  snapshot: { rev: number; data: string; size: number }
  since: { rev: number; ops: { rev: number; by: string; mutations: SheetMutationJson[] }[] } | { rev: number; reload: true }
  apply: { rev: number } | { conflict: true; rev: number }
  range: { sheet: string; cells: { at: string; v?: string | number | boolean; f?: string; note?: string }[][] }
  /** `rev` when written, `changeSetId` when suggested */
  cells: { rev?: number; changeSetId?: string; count: number }
  review: { rev?: number; decided: number }
  history: { revisions: SheetRevision[] }
  compare: { cells: SheetCellDiff[]; truncated: boolean }
  restore: { rev: number }
  create: { sheet: SheetRef }
}
export type HostAnswer<A extends HostAsk['op']> = Answers[A]
