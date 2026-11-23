/**
 * The sheet formats that open as a converted Excel copy (docs/agents/work-sheets.md "Other formats in"):
 * an Excel 97-2003 workbook, an OpenDocument spreadsheet and a tab-separated file. The host reads
 * each with LibreOffice into an .xlsx it keeps for him, he edits that copy, and by his press it is
 * written back as the format it was, or out as an .xlsx. This file holds what both ends say of them
 * and takes nothing in, so the canvas's chunk can read it.
 */

export const SHEET_IMPORT_FORMATS = ['xls', 'ods', 'tsv'] as const
export type SheetImportFormat = (typeof SHEET_IMPORT_FORMATS)[number]

/** The format a file name's ending says, when it is one of these. */
export function sheetImportFormat(name: string): SheetImportFormat | undefined {
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  return SHEET_IMPORT_FORMATS.find((format) => format === ext)
}

/**
 * What a copy written back as the format leaves behind, as the end of "Saving back as .xls drops …":
 * the format's own limits, said before he presses. What this workbook loses is counted at the press.
 */
export const SHEET_IMPORT_DROPS: Record<SheetImportFormat, string> = {
  xls: 'tables and newer functions',
  ods: 'newer chart kinds',
  tsv: 'formulas, formatting and other sheets'
}

/** What `SheetView.imported` says of a sheet that is a copy of another format. */
export interface SheetImported {
  format: SheetImportFormat
  /** the file it was read from, by its name: "Budget.xls" */
  name: string
  /** the file changed since the copy was made, and the copy holds edits of his, so it was kept */
  stale?: true
  /** why the copy cannot be written back as the format it was, as the start of a sentence ("This file holds macros, which an Excel copy does not keep"); absent, it can */
  noBack?: string
}

/** What he asks of a copy: write it back as the format it was, write it out as an .xlsx, or drop it and read the file again. */
export const SHEET_IMPORT_ACTS = ['back', 'xlsx', 'again'] as const
export type SheetImportAct = (typeof SHEET_IMPORT_ACTS)[number]

/** What `work.sheets.imported` answers: the file written, the item that now shows it, and what the format left behind. */
export interface SheetImportDone {
  path?: string
  itemId?: string
  drops?: string[]
}
