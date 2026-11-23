import type { ImportReport } from 'work-kit/sheet/xlsx'

/**
 * What waits in Excel (docs/agents/work-sheets.md "The switch"): the things a workbook holds that only Excel
 * does, counted from the importer's report and said as a person reads them ("2 pivot tables", "a chart",
 * "macros"). `reachOf` (jobs.ts) answers these as `SheetReach.parts`; the canvas says them on the kind's bar
 * beside the switch ("2 pivot tables and macros open in Excel"), and `sheet_read` says them to an agent, so a
 * thread knows what it cannot change before it says it has.
 *
 * A kind the grid learns to show leaves this list in the commit that teaches it (charts, at SHT5).
 */

interface Waits {
  /** the importer's kinds for it, the truest count first: the first one the file has any of is the count */
  kinds: readonly string[]
  /** one of them, and `n` of them */
  one: string
  many: (n: string) => string
}

/** In the order the line says them: what he is most likely to have opened the file for comes first. */
const WAITS: readonly Waits[] = [
  // A cache with no table left on any sheet is still a pivot Excel alone can refresh.
  { kinds: ['pivotTables', 'pivotCaches'], one: 'a pivot table', many: (n) => `${n} pivot tables` },
  // A chart on a sheet is drawn and changed on the grid; one on a chart sheet of its own is not.
  { kinds: ['chartsheets'], one: 'a chart sheet', many: (n) => `${n} chart sheets` },
  // One project holds any number of macros: the importer sees the project, so no count is said.
  { kinds: ['vbaProject'], one: 'macros', many: () => 'macros' },
  { kinds: ['slicers'], one: 'a slicer', many: (n) => `${n} slicers` },
  { kinds: ['formControls'], one: 'a form control', many: (n) => `${n} form controls` },
  // Counted as parts of the file, not as queries: named, not numbered.
  { kinds: ['powerQuery'], one: 'Power Query', many: () => 'Power Query' },
  { kinds: ['dataConnections'], one: 'a data connection', many: (n) => `${n} data connections` },
  { kinds: ['externalLinks'], one: 'a link to another workbook', many: (n) => `links to ${n} other workbooks` },
  { kinds: ['dataTables'], one: 'a what-if table', many: (n) => `${n} what-if tables` }
]

/** The phrases for what this workbook holds that only Excel does, counted; empty when our grid reaches all of it. */
export function waitsOf(report: Pick<ImportReport, 'unsupported'>): string[] {
  const counts = new Map<string, number>()
  // A kind found on several sheets is listed once a sheet: the workbook's count is their sum.
  for (const u of report.unsupported) counts.set(u.kind, (counts.get(u.kind) ?? 0) + u.count)
  const out: string[] = []
  for (const w of WAITS) {
    const n = w.kinds.map((k) => counts.get(k) ?? 0).find((count) => count > 0)
    if (n) out.push(n === 1 ? w.one : w.many(n.toLocaleString('en-US')))
  }
  return out
}

const listed = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/**
 * The line `sheet_read` adds for an opened Excel file that holds any of the above: what the sheet tools do not
 * reach, so an agent says so and does not claim a change it could not make. Empty when there is nothing.
 */
export const waitsNote = (parts: readonly string[] | undefined): string =>
  parts?.length ? `This workbook also holds ${listed(parts)}: only Excel changes ${parts.length === 1 && !parts[0]!.endsWith('s') ? 'that' : 'those'}, and the owner opens the file there with the switch beside the sheet.` : ''
