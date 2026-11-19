import { z } from 'zod'
import type { Principal } from './work/ids'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The sheets pillar's wire (docs/agents/work-sheets.md): a sheet in the
 * canvas pane. Its methods are `work.sheets.<verb>` and its push
 * `work.sheets`; src/shared/work/wire.ts has the helpers and the rules.
 *
 * Three stores hold a sheet. An opened `.xlsx` or `.xlsm` stays the truth:
 * the canvas reads its bytes, and an edit is saved by patching the package
 * (the patch writer), so every part it does not touch keeps its bytes. A
 * LifeOS sheet and a `.tcsheet` file are a Univer snapshot and an op log.
 * In all three an edit is a list of Univer mutations, numbered by `rev`.
 */

/** A cell as Univer holds it (`ICellData`): value, formula, style id or style, type. */
export interface SheetCellJson {
  v?: string | number | boolean | null
  f?: string
  si?: string
  s?: string | Record<string, unknown> | null
  t?: number
}

/** One Univer mutation, as the grid reports it and applies it. */
export interface SheetMutationJson {
  id: string
  params: unknown
}
const MutationSchema = z.object({ id: z.string().min(1).max(200), params: z.unknown() })

/** Where a sheet lives: an opened Excel package, a `.tcsheet` file, a LifeOS sheet, or a sheet read from a .csv (saved back with export). */
export type SheetStoreKind = 'package' | 'tcsheet' | 'lifeos' | 'csv'

/** `pending`: waits for the owner. `conflict`: the cell no longer holds what the agent saw. `orphaned`: its row, column or sheet is gone. */
export type SheetSuggestionState = 'pending' | 'conflict' | 'orphaned' | 'accepted' | 'rejected'

/** One cell an agent proposed, where it is on the sheet now. */
export interface SheetSuggestion {
  id: string
  /** one per agent turn: a run of neighbouring cells in it steps as one change */
  changeSet: string
  by: Principal
  /** Univer's sheet id */
  sheet: string
  row: number
  col: number
  /** what the agent saw there */
  base: SheetCellJson | null
  /** what it would leave; null clears the cell */
  proposed: SheetCellJson | null
  state: SheetSuggestionState
  /** the agent's reason, said once for its change set */
  reason?: string
}

/**
 * What our grid cannot reach in this file (docs/agents/work-sheets.md "The
 * switch"): each a short phrase a person reads ("a pivot table", "macros").
 * The canvas offers the switch while this is not empty.
 */
export interface SheetReach {
  /** the phrases, at most a handful */
  parts: string[]
  /** where the switch goes: desktop Excel for a Microsoft file or any he opens in Excel; the full editor on the box otherwise */
  to: 'excel' | 'full'
}

/** What the agent last wrote directly, for the bar's written line and its Undo. */
export interface SheetWritten {
  id: string
  /** "Wrote 12 cells in Budget" */
  text: string
  at: number
}

/**
 * One of our own charts, drawn over a range (architecture §9.1): plain bars
 * on the neutral. A file's own charts stay in its package untouched.
 */
export interface SheetChart {
  id: string
  /** Univer's sheet id */
  sheet: string
  /** the data, A1 on that sheet: the first column names the bars, the next holds their values */
  range: string
  title: string
  /** the top-left cell it sits over */
  row: number
  col: number
}
const ChartSchema = z.object({
  id: z.string().min(1).max(100),
  sheet: z.string().min(1).max(200),
  range: z.string().min(1).max(100),
  title: z.string().max(200),
  row: z.number().int().min(0),
  col: z.number().int().min(0)
})

/** Everything the canvas needs beside the workbook itself. */
export interface SheetView {
  itemId: string
  sessionId: string
  /** the file's or the sheet's name */
  name: string
  store: SheetStoreKind
  /** the op the workbook as loaded stands at; `work.sheets.since` brings later ones */
  rev: number
  /** others can edit it (a shared LifeOS sheet): an agent's own idea waits as a suggestion */
  shared: boolean
  /** what an agent does to it on its own idea when it is not shared */
  mode: 'suggests' | 'writes'
  /** open suggestions (pending, conflict, orphaned), in sheet order */
  suggestions: SheetSuggestion[]
  written?: SheetWritten
  /** what our grid cannot reach, when there is something */
  reach?: SheetReach
  /** why it opens read only here (.xlsb, Strict OOXML, a password), when it does */
  readOnly?: string
  /** a package whose dates count from 1904: the grid shows them moved into Univer's 1900 system */
  date1904?: boolean
  /** the last save of a package failed: said once over the grid, with Retry */
  saveError?: string
  /** the file is not where the item says */
  missing?: boolean
  charts: SheetChart[]
}

/** One revision in a sheet's history. */
export interface SheetRevision {
  rev: number
  at: number
  by: Principal | 'file'
  /** "12 cells", "Inserted a row", "Restored to 14:02" */
  label: string
}

/** One cell that differs between two revisions. */
export interface SheetCellDiff {
  sheet: string
  sheetName: string
  row: number
  col: number
  before: SheetCellJson | null
  after: SheetCellJson | null
}

const itemId = z.string().min(1).max(100)
/** A load is one frame: at most this many bytes a call. */
export const SHEET_LOAD_MAX = 4 * 1024 * 1024
/** The most mutations one edit carries. */
export const SHEET_EDIT_MAX = 500
/** The most cells a compare answers; `truncated` says there were more. */
export const SHEET_COMPARE_MAX = 5000

export const SheetsRequestSchemas = [
  /** → SheetView */
  request('work.sheets.open', z.object({ itemId })),
  /**
   * → { data: base64, size, rev, format }: the workbook's bytes as the view's `rev` stands, by range.
   * `xlsx`: the package, for `importXlsx` (work-kit/sheet/xlsx). `snapshot`: Univer's workbook as JSON text.
   * A load of a revision no longer held is refused, so one load never mixes two.
   */
  request('work.sheets.load', z.object({ itemId, rev: z.number().int().min(0), offset: z.number().int().min(0), length: z.number().int().positive().max(SHEET_LOAD_MAX) })),
  /** → { rev, ops: [{ rev, by, mutations }] } or { rev, reload: true } when the ops since are not kept: what landed after `rev`. */
  request('work.sheets.since', z.object({ itemId, rev: z.number().int().min(0) })),
  /** → { rev } or { conflict: true, rev }: the owner's edits, made on the workbook at `baseRev`. A conflict asks the canvas to catch up with `since` and send again. */
  request('work.sheets.edit', z.object({ itemId, baseRev: z.number().int().min(0), mutations: z.array(MutationSchema).min(1).max(SHEET_EDIT_MAX) })),
  /** → SheetView: takes or drops suggestions: ids, one change set, or all. */
  request(
    'work.sheets.review',
    z.object({
      itemId,
      which: z.union([z.object({ ids: z.array(z.string().max(100)).min(1).max(5000) }), z.object({ changeSet: z.string().max(100) }), z.literal('all')]),
      verdict: z.enum(['accept', 'reject'])
    })
  ),
  /** → SheetView: what an agent does on its own idea from now on (an unshared sheet only) */
  request('work.sheets.mode', z.object({ itemId, mode: z.enum(['suggests', 'writes']) })),
  /** → SheetView: takes back what the agent wrote directly */
  request('work.sheets.undo', z.object({ itemId, writeId: z.string().max(100) })),
  /** → { revisions: SheetRevision[] }, newest first */
  request('work.sheets.history', z.object({ itemId })),
  /** → { cells: SheetCellDiff[], truncated: boolean } */
  request('work.sheets.compare', z.object({ itemId, from: z.number().int().min(0), to: z.number().int().min(0) })),
  /** → SheetView: writes revision `rev`'s cells back as a new revision; nothing after it is lost */
  request('work.sheets.restore', z.object({ itemId, rev: z.number().int().min(0) })),
  /** → { itemId }: a new sheet in the thread's canvas: a LifeOS sheet when the thread's workspace is linked to a sector, else a `.tcsheet` file */
  request('work.sheets.create', z.object({ sessionId: z.string().min(1).max(100), title: z.string().min(1).max(200) })),
  /** → SheetView: adds or moves one of our charts, or with `remove` takes it off */
  request('work.sheets.chart', z.object({ itemId, chart: ChartSchema, remove: z.boolean().default(false) })),
  /** → { opened: true, url? }: opens the file in the app `SheetView.reach.to` names (desktop Excel for a package; the full editor on the box answers its page's `url`, which the canvas opens); refused where that app is not on this host */
  request('work.sheets.switch', z.object({ itemId })),
  /**
   * → { path }: the sheet written out. `xlsx`: a new package from the sheet (a LifeOS sheet, a
   * `.tcsheet`, a sheet read from a .csv), beside the .csv or among the item's own files. `csv`: one
   * sheet (`sheet`, else the first), back over the .csv it was read from, else beside the file or
   * among the item's files. An opened package is its own .xlsx.
   */
  request('work.sheets.export', z.object({ itemId, format: z.enum(['xlsx', 'csv']).default('xlsx'), sheet: z.string().max(200).optional() }))
] as const

/** Something landed on a sheet: new ops (another person, an agent) or a changed view. */
export type SheetsPush = { push: 'work.sheets'; sessionId: string; itemId: string; rev: number; view?: SheetView }

export const SHEETS_CAPS = {
  'work.sheets.open': 'read',
  'work.sheets.load': 'read',
  'work.sheets.since': 'read',
  'work.sheets.edit': 'operate',
  'work.sheets.review': 'operate',
  'work.sheets.mode': 'operate',
  'work.sheets.undo': 'operate',
  'work.sheets.history': 'read',
  'work.sheets.compare': 'read',
  'work.sheets.restore': 'operate',
  'work.sheets.create': 'operate',
  'work.sheets.chart': 'operate',
  'work.sheets.switch': 'operate',
  'work.sheets.export': 'operate'
} satisfies CapsOf<typeof SheetsRequestSchemas>
export const SHEETS_RELAY = {} satisfies RelayOf<typeof SheetsRequestSchemas>
