// The charts TempCode kept beside a workbook before it could write one into it (the rows of
// `work_sheets_charts`): each as the spec of the chart it drew, so the same writer makes it a
// real chart. It drew plain bars across: the range's first column names them, the next holds
// their values.
/** One row of `work_sheets_charts`: our old chart, plain bars over a range, drawn over a cell. */
export interface OldChartRow {
  id: string
  /** Univer's sheet id */
  sheet: string
  /** the data, A1 on that sheet: the first column names the bars, the next holds their values */
  range: string
  title: string
  /** the top-left cell it sat over */
  row: number
  col: number
}
import type { ChartSpec } from 'work-kit/sheet/xlsx'
import { colName, parseRange } from './xml'

/** EMU a CSS pixel at 96 dpi. */
const PX = 9525
const WIDTH = 380
/** The old chart's height for its bars: its padding, the title row, 22px a bar, the axis. */
const heightFor = (bars: number) => 12 + 20 + 8 + Math.max(1, bars) * 22 + 8 + 16 + 12 + 2

/**
 * An old chart row as a chart on the tab named `tab` (the row itself names Univer's sheet id).
 * Undefined where its range is not a range. Its id is `legacy:<row id>`: the writer gives back
 * the chart part it became, and the row is then done with.
 */
export function legacyChartSpec(row: OldChartRow, tab: string): ChartSpec | undefined {
  let box: ReturnType<typeof parseRange>
  try {
    box = parseRange(row.range)
  } catch {
    return undefined
  }
  const sheet = `'${tab.replace(/'/g, "''")}'`
  const column = (col: number) => `${sheet}!$${colName(col)}$${box.r1}:$${colName(col)}$${box.r2}`
  const named = box.c2 > box.c1
  const spec: ChartSpec = {
    id: 'legacy:' + row.id,
    sheet: tab,
    anchor: {
      kind: 'oneCell',
      from: { column: Math.max(0, row.col), row: Math.max(0, row.row), columnOffset: 0, rowOffset: 0 },
      width: WIDTH * PX,
      height: heightFor(box.r2 - box.r1 + 1) * PX
    },
    kind: 'bar',
    grouping: 'clustered',
    groups: [{ kind: 'bar', grouping: 'clustered' }],
    legend: null,
    // The old chart listed its first bar at the top; Excel's bars start at the bottom.
    axes: { category: { id: 'category', reversed: true } },
    series: [
      {
        kind: 'bar',
        group: 0,
        ...(named ? { categories: { ref: column(box.c1) } } : {}),
        values: { ref: column(named ? box.c1 + 1 : box.c1) }
      }
    ],
    flags: {}
  }
  if (row.title.trim()) spec.title = { text: row.title }
  return spec
}
