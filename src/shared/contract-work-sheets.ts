import { z } from 'zod'
import type { Principal } from './work/ids'
import { SHEET_IMPORT_ACTS, type SheetImported } from './work/sheetFormats'
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

/**
 * A control of the sheet's format row (work-kit's `SheetControl`).
 */
export type SheetFormatControl = 'undo' | 'style' | 'font' | 'size' | 'bold' | 'italic' | 'underline' | 'colour' | 'fill' | 'align' | 'vertical' | 'wrap' | 'merge' | 'borders' | 'number'
/** The Data menu's rows: a sort, the filter, and the rules its side sheet lists. */
export type SheetDataControl = 'sort' | 'filter' | 'validation' | 'conditional' | 'names' | 'table'
/** Insert's rows and what they make (the kit's `ObjectControl`): a chart, a picture, and changing either on the grid. */
export type SheetObjectControl = 'chart' | 'picture' | 'objects'
/** The page's controls (the kit's `PageControl`): Page set-up, the Page breaks view, the print area, a break at the cell in hand. */
export type SheetPageControl = 'page' | 'pageBreaks' | 'printArea' | 'breakHere'
export type SheetRowControl = SheetFormatControl | SheetDataControl | SheetObjectControl | SheetPageControl

const KEPT_WHOLE: readonly SheetRowControl[] = ['undo', 'style', 'font', 'size', 'bold', 'italic', 'underline', 'colour', 'fill', 'align', 'vertical', 'wrap', 'merge', 'borders', 'number']
/** The Data menu's rows: held for each store by `sheets/rulesMatrix.test.ts`, `host/rules.test.ts` and `writer.test.ts`. */
const DATA_KEPT: readonly SheetDataControl[] = ['sort', 'filter', 'validation', 'conditional', 'names', 'table']
/** The page's controls: held for each store by `sheets/pagesMatrix.test.ts` (an opened Excel file, a sheet the service holds, its export). */
const PAGE_KEPT: readonly SheetPageControl[] = ['page', 'pageBreaks', 'printArea', 'breakHere']

/**
 * The format row's controls by where a sheet lives, which the host puts in the view (`row`). A
 * control is listed only where its change survives: the grid emits a mutation, the service's own
 * engine replays it, a cold load shows it and the Excel export holds it
 * (`sheets/rowMatrix.test.ts` holds every cell of this table). A store with none draws no row at
 * all. For an opened Excel file the same holds through the patch writer: the press is saved into
 * the file and read back from it. The Data menu's rows are listed by the same rule: a sort, the
 * filter, the rules its side sheet lists (validations, conditional formats, names), and a table
 * (`sheets/tablesMatrix.test.ts`). A sheet read from a .csv keeps cell contents only, so it has
 * none; a workbook Excel or Google holds is a `package` in the view with no `row`. The host says
 * it, not the canvas, so a canvas a release ahead of its host draws no control that host could
 * lose.
 */
export const SHEET_ROW: Record<SheetStoreKind, readonly SheetRowControl[]> = {
  lifeos: [...KEPT_WHOLE, ...DATA_KEPT, ...PAGE_KEPT],
  tcsheet: [...KEPT_WHOLE, ...DATA_KEPT, ...PAGE_KEPT],
  package: [...KEPT_WHOLE, ...DATA_KEPT, ...PAGE_KEPT],
  csv: []
}

/** What a note's pop-over offers (the kit's `NoteControl`): its words changed, a note made, a note removed. */
export type SheetNoteControl = 'edit' | 'add' | 'remove'

/**
 * What a sheet's notes take by where it lives, which the host puts in the view (`notes`) as it does
 * `row`, and for the same reason. An opened Excel file rewords a note it has (patch/notes.ts) and
 * makes or removes none: a new note needs Excel's drawing part. A sheet the service holds keeps all
 * three in its engine's snapshot (host/notes.test.ts). A .csv keeps no note; a workbook Excel or
 * Google holds is a `package` with no `notes`, and none is offered where the view is read only.
 */
export const SHEET_NOTES: Record<SheetStoreKind, readonly SheetNoteControl[]> = {
  lifeos: ['edit', 'add', 'remove'],
  tcsheet: ['edit', 'add', 'remove'],
  package: ['edit'],
  csv: []
}

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
 * A format or a rule an agent proposed. It has no cell value to show in the grid, so it is said in
 * words ("Bold, yellow fill on B2:B9") and steps with the cell suggestions; taking it lays it as
 * the owner's own edit. `orphaned`: rows, columns or sheets changed since, so its range may no
 * longer be where the agent saw it, and it can only be dropped.
 */
export interface SheetChange {
  id: string
  changeSet: string
  by: Principal
  kind: 'format' | 'rule'
  /** Univer's sheet id */
  sheet: string
  /** the cells it is about; null for a workbook's name */
  range: { startRow: number; endRow: number; startColumn: number; endColumn: number } | null
  words: string
  state: 'pending' | 'orphaned'
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
  /** where the switch goes: desktop Excel for a Microsoft file or any he opens in Excel; Google's own editor, in the system browser, for a Google spreadsheet; the full editor on the box otherwise */
  to: 'excel' | 'google' | 'full'
}

/** What the agent last wrote directly, for the bar's written line and its Undo. */
export interface SheetWritten {
  id: string
  /** "Wrote 12 cells in Budget" */
  text: string
  at: number
  /** false: the line offers no Undo (a format or a rule an agent wrote: History takes it back) */
  undo?: false
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
  /** formats and rules an agent proposed, oldest first; absent with none */
  changes?: SheetChange[]
  written?: SheetWritten
  /** what our grid cannot reach, when there is something */
  reach?: SheetReach
  /** why it opens read only here (.xlsb, Strict OOXML, a password), when it does */
  readOnly?: string
  /** the workbook is the Excel copy of an .xls, .ods or .tsv: edits save to the copy, and the file changes by his press (`work.sheets.imported`) */
  imported?: SheetImported
  /** a package whose dates count from 1904: the grid shows them moved into Univer's 1900 system */
  date1904?: boolean
  /** the last save of a package failed: said once over the grid, with Retry */
  saveError?: string
  /** the file is not where the item says */
  missing?: boolean
  charts: SheetChart[]
  /** the format row's controls this sheet keeps (`SHEET_ROW`); absent or empty, the canvas draws no row */
  row?: SheetRowControl[]
  /** what the notes' pop-over offers here (`SHEET_NOTES`); absent or empty, notes are read only */
  notes?: SheetNoteControl[]
  /** an opened Excel file whose host saves moved cells, rows and columns (sheets/structural.ts); absent, the canvas stops a move as he makes it */
  moves?: true
  /** Save to Google Sheets is offered: a workbook of his own that this host holds (sheets/toGoogle.ts `canSaveToGoogle`) */
  canUpload?: true
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

/**
 * Preview's formats a sheet draws on its host (docs/agents/work-sheets.md "Preview and export"): Print is
 * the PDF, so it is not one of them. `xlsx` is the workbook as Excel gets it, `ods` and `xls` the exported
 * file drawn by LibreOffice, `csv` and `tsv` one sheet's shown values, `html` the web page.
 */
export const SHEET_PREVIEW_FORMATS = ['xlsx', 'pdf', 'ods', 'xls', 'csv', 'tsv', 'html'] as const
export type SheetPreviewFormat = (typeof SHEET_PREVIEW_FORMATS)[number]
/** The most one `work.sheets.previewRead` answers: a render is read by range, a frame at a time. */
export const SHEET_PREVIEW_READ_MAX = 4 * 1024 * 1024
/** Pages a first draw holds; "Draw all" asks for every one. */
export const SHEET_PREVIEW_PAGES = 50

/** What `work.sheets.preview` answers: a render read by range (`rev`), a table of one sheet, or a web page. */
export type SheetPreviewAnswer = { drops: string[] } & (
  | {
      kind: 'paged'
      /** names the render: every `previewRead` at it is of this render */
      rev: string
      size: number
      /** the pages the PDF holds */
      pages: number
      /** set when the PDF holds only the first pages of the whole: `of` is about how many there are */
      shown?: { from: number; to: number; of: number }
      /** `excel` only for his press on "Check in Excel" (`by: 'office'`): Excel's own PDF of the whole workbook */
      drawnBy: 'libreoffice' | 'excel'
    }
  | { kind: 'table'; name: string; rows: string[][]; sheets: string[] }
  | { kind: 'html'; html: string }
)
/** What `work.sheets.previewExport` answers: the file as it stands now, kept as a render and read by range. */
export interface SheetExportAnswer {
  rev: string
  size: number
  name: string
  /** what the file could not hold, one line each */
  drops: string[]
}

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
  /** → { opened: true, url? }: opens the file in the app `SheetView.reach.to` names (desktop Excel for a package; the full editor on the box answers its page's `url`, which the canvas opens); refused where that app is not on this host. `scheme` is the theme the asking window wears: the full editor opens in it, and follows the browser's system where none is sent (the phone) */
  request('work.sheets.switch', z.object({ itemId, scheme: z.enum(['dark', 'light']).optional() })),
  /**
   * → { path, left? }: the sheet written out; `left` names what the file could not hold ("the names"). `xlsx`: a new package from the sheet (a LifeOS sheet, a
   * `.tcsheet`, a sheet read from a .csv), beside the .csv or among the item's own files. `csv`: one
   * sheet (`sheet`, else the first), back over the .csv it was read from, else beside the file or
   * among the item's files. An opened package is its own .xlsx.
   */
  request('work.sheets.export', z.object({ itemId, format: z.enum(['xlsx', 'csv']).default('xlsx'), sheet: z.string().max(200).optional() })),
  /**
   * → SheetPreviewAnswer: the workbook as `format` makes it, for the Preview frame, drawn on the host that holds
   * the file. A paged format draws `pages` (1-based, inclusive; the first 50 when absent); `sheet` picks the sheet
   * a CSV or TSV holds. Renders are kept by content hash, and a file others can open keeps its own in its item's
   * folder alone. `by: 'office'` is his press on "Check in Excel" (sheets/checkExcel.ts): Excel's own PDF of the
   * workbook, `drawnBy: 'excel'`, or `{ notInReach: 'asleep' | 'not open' | 'none' }` when Excel went out of
   * reach since `previewOffice` was asked; refused for any caller whose press is not his own.
   */
  request(
    'work.sheets.preview',
    z.object({
      itemId,
      format: z.enum(SHEET_PREVIEW_FORMATS),
      pages: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
      sheet: z.string().max(200).optional(),
      by: z.literal('office').optional()
    })
  ),
  /** → { app: 'excel', state: 'ready' | 'asleep' | 'not open' | 'none' }: whether Excel can draw this workbook from this host now. Wakes nothing and starts nothing. */
  request('work.sheets.previewOffice', z.object({ itemId })),
  /** → { data: base64 }: bytes of one render by range. A `rev` no longer kept is refused: draw it again. */
  request('work.sheets.previewRead', z.object({ itemId, rev: z.string().regex(/^[a-f0-9]{32}$/), offset: z.number().int().min(0), length: z.number().int().min(1).max(SHEET_PREVIEW_READ_MAX) })),
  /** → SheetExportAnswer: the file in `format` made now from the workbook as it stands, read with `previewRead`. */
  request('work.sheets.previewExport', z.object({ itemId, format: z.enum(SHEET_PREVIEW_FORMATS), sheet: z.string().max(200).optional() })),
  /**
   * → SheetImportDone: what he does with the Excel copy of an .xls, .ods or .tsv (`SheetView.imported`). `back`
   * writes the copy over the file as the format it was, only while the file is still the one the copy was made
   * from (`drops`: what the format left behind of this workbook); `xlsx` writes it out as an .xlsx, never over
   * anything (beside his own file, in his workspace's folder for a file others can open) and opens that
   * (`itemId`); `again` drops the copy's edits and reads the file again. His press alone: a thread's call and
   * another host's are refused, and a remote key changes a file others can open only with `approve`.
   */
  request('work.sheets.imported', z.object({ itemId, act: z.enum(SHEET_IMPORT_ACTS) }))
] as const

/**
 * Something landed on a sheet: new ops (another person, an agent) or a changed view. `stale`: the
 * view changed and is not sent, because the sheet is one others can open and what waits on it is
 * answered caller by caller: read it again with `work.sheets.open`.
 */
export type SheetsPush = { push: 'work.sheets'; sessionId: string; itemId: string; rev: number; view?: SheetView; stale?: true }

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
  'work.sheets.export': 'operate',
  'work.sheets.preview': 'operate',
  'work.sheets.previewOffice': 'read',
  'work.sheets.previewRead': 'read',
  'work.sheets.previewExport': 'read',
  'work.sheets.imported': 'operate'
} satisfies CapsOf<typeof SheetsRequestSchemas>
export const SHEETS_RELAY = {} satisfies RelayOf<typeof SheetsRequestSchemas>
