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

export type Which = { ids: string[] } | { changeSet: string } | 'all'

export type HostAsk =
  | { op: 'open'; sheet: SheetRef }
  | { op: 'snapshot'; sheet: SheetRef }
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
  open: { title: string; rev: number; shared: boolean; suggestions: SheetSuggestion[]; missing?: boolean }
  /** the workbook as Univer's JSON at `rev` */
  snapshot: { rev: number; json: string }
  since: { rev: number; ops: { rev: number; by: string; mutations: SheetMutationJson[] }[] } | { rev: number; reload: true }
  apply: { rev: number } | { conflict: true; rev: number }
  range: { sheet: string; cells: { at: string; v?: string | number | boolean; f?: string }[][] }
  /** `rev` when written, `changeSetId` when suggested */
  cells: { rev?: number; changeSetId?: string; count: number }
  review: { rev?: number; decided: number }
  history: { revisions: SheetRevision[] }
  compare: { cells: SheetCellDiff[]; truncated: boolean }
  restore: { rev: number }
  create: { sheet: SheetRef }
}
export type HostAnswer<A extends HostAsk['op']> = Answers[A]
