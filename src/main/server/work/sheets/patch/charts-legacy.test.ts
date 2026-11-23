import { expect, test } from 'vitest'
import { patchCharts } from './charts'
import { legacyChartSpec } from './charts-legacy'
import { budget, CHART, chartsOf, edit, MONTHS, proof, RENT } from './charts-testkit'

const row = { id: 'c1', sheet: 'univer-sheet-id', range: 'A2:B7', title: 'Rent by month', row: 9, col: 3 }

test('an old chart row becomes the bar chart it drew, placed where it sat', () => {
  const spec = legacyChartSpec(row, 'Data')!
  expect(spec).toMatchObject({ id: 'legacy:c1', sheet: 'Data', kind: 'bar', title: { text: 'Rent by month' }, legend: null })
  expect(spec.anchor).toEqual({ kind: 'oneCell', from: { column: 3, row: 9, columnOffset: 0, rowOffset: 0 }, width: 380 * 9525, height: 210 * 9525 })
  const { bytes, report } = patchCharts(budget(), [edit([spec])])
  expect(report.ids).toEqual({ 'legacy:c1': CHART(1) })
  const [read] = chartsOf(bytes)
  expect(read).toMatchObject({ kind: 'bar', grouping: 'clustered', title: { text: 'Rent by month' }, legend: null, anchor: spec.anchor })
  expect(read.series).toMatchObject([{ kind: 'bar', categories: { ref: 'Data!$A$2:$A$7', cache: MONTHS }, values: { ref: 'Data!$B$2:$B$7', cache: RENT } }])
  // First bar at the top, as the old chart drew it.
  expect(read.axes.category).toMatchObject({ reversed: true })
  proof('legacy-bars', 'An old TempCode chart row written as the bar chart it drew', bytes)
  // The chart it became, handed back with the part's id: nothing to write, so the step may run again.
  expect(patchCharts(bytes, [edit([{ ...spec, id: CHART(1) }])]).bytes === bytes).toBe(true)
})

test('one column is values with no names; no title is no title; a tab’s odd name is quoted; a range that is none gives nothing', () => {
  const bare = legacyChartSpec({ ...row, range: 'B2:B7', title: ' ', row: -1 }, "It's")!
  expect(bare.title).toBeUndefined()
  expect(bare.series[0]).toEqual({ kind: 'bar', group: 0, values: { ref: "'It''s'!$B$2:$B$7" } })
  expect(bare.anchor).toMatchObject({ from: { row: 0 } })
  expect(legacyChartSpec({ ...row, range: 'nonsense' }, 'Data')).toBeUndefined()
})
