/**
 * The names Excel keeps for itself, by the one list the ask and the writer both read (asks.ts
 * `nameProblem`, rules-names.ts): a workbook may not define them as its own. No imports: the main
 * process reads this without the writer.
 */
export const EXCEL_NAMES: ReadonlySet<string> = new Set([
  'true',
  'false',
  'consolidate_area',
  'auto_open',
  'auto_close',
  'extract',
  'database',
  'criteria',
  'print_area',
  'print_titles',
  'recorder',
  'data_form',
  'auto_activate',
  'auto_deactivate',
  'sheet_title',
  '_filterdatabase'
])

/** Excel's own built-in names (`_xlnm.Print_Area`, the filter's hidden name). */
export const RESERVED_NAME = /^_xlnm\./i
