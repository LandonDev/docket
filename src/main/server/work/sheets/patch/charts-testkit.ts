// What the chart writer's tests share: a small budget workbook, specs as the canvas would hand
// them, the check that a chart part's elements stand in the schema's order, and what a proof
// workbook should hold when Excel opens it.
import type {
  ChartColour,
  ChartGrouping,
  ChartSeries,
  ChartSpec,
  ObjectAnchor,
  SeriesData,
  SeriesKind
} from 'work-kit/sheet/xlsx'
import { expect } from 'vitest'
import { patchCharts, readCharts, type ChartsEdit, type ChartsReport } from './charts'
import { fixture, held, keep, parsed, withParts, xml, type Expected } from './drawings-testkit'
import { patchSheet, type Edit } from './sheet'

export const SHEET = 'xl/worksheets/sheet1.xml'
export const SHEET_RELS = 'xl/worksheets/_rels/sheet1.xml.rels'
export const DRAWING = 'xl/drawings/drawing1.xml'
export const DRAWING_RELS = 'xl/drawings/_rels/drawing1.xml.rels'
export const CT = '[Content_Types].xml'
export const CHART = (n: number) => `xl/charts/chart${n}.xml`

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']
export const RENT = [1200, 1200, 1250, 1250, 1250, 1300]
export const FOOD = [310, 295.5, 342, 301, 288.25, 330]
export const TRAVEL = [80, 0, 420, 65, 0, 150]
export const SHARE = [0.25, 0.2, 0.3, 0.1, 0.05, 0.1]
export const X = [1, 2.5, 4, 5.5, 7, 9]
export const Y = [3, 4.5, 4, 7.25, 8, 11]

/** A budget on "Data": Month, Rent, Food, Travel, Share in A1:E7, and X, Y in G1:H7. */
export function budget(): Uint8Array {
  const base = fixture('patch/base.xlsx')
  const edits: Edit[] = []
  const column = (col: number, head: string, values: ReadonlyArray<string | number>) => {
    edits.push({ row: 1, col, write: { kind: 'text', value: head } })
    for (const [k, value] of values.entries())
      edits.push({ row: k + 2, col, write: typeof value === 'number' ? { kind: 'number', value } : { kind: 'text', value } })
  }
  column(1, 'Month', MONTHS)
  column(2, 'Rent', RENT)
  column(3, 'Food', FOOD)
  column(4, 'Travel', TRAVEL)
  column(5, 'Share', SHARE)
  column(7, 'X', X)
  column(8, 'Y', Y)
  return withParts(base, { [SHEET]: patchSheet(xml(base, SHEET), edits, { strings: 'inline' }).xml })
}

const cell = (column: number, row: number) => ({ column, row, columnOffset: 0, rowOffset: 0 })
/** A chart's place: `rows` rows from the given cell, eight columns wide. */
export const place = (column = 9, row = 1, rows = 15): Extract<ObjectAnchor, { kind: 'twoCell' }> => ({
  kind: 'twoCell',
  from: cell(column, row),
  to: cell(column + 8, row + rows),
  behaviour: 'twoCell'
})

const COLUMN = { Rent: 'B', Food: 'C', Travel: 'D', Share: 'E', Y: 'H' } as const
export type Column = keyof typeof COLUMN

/** A series of the budget as the canvas would make it: a name cell, the months, a column of values. */
export function series(kind: SeriesKind, of: Column, extra: Partial<ChartSeries> = {}): ChartSeries {
  const letter = COLUMN[of]
  return {
    kind,
    group: 0,
    name: { ref: `Data!$${letter}$1` },
    categories: { ref: kind === 'scatter' ? 'Data!$G$2:$G$7' : 'Data!$A$2:$A$7' },
    values: { ref: `Data!$${letter}$2:$${letter}$7` },
    ...extra
  }
}

/** A new chart on "Data" as the canvas would hand it over: no caches, no ids of the file's. */
export function chart(
  kind: ChartSpec['kind'],
  list: ChartSeries[],
  extra: Partial<ChartSpec> = {},
  grouping?: ChartGrouping
): ChartSpec {
  const kinds = [...new Set(list.map((s) => `${s.kind}|${s.secondAxis === true}`))]
  const group = (key: string) => {
    const [of, second] = key.split('|') as [SeriesKind, string]
    const standard = of === 'column' || of === 'bar' ? 'clustered' : 'standard'
    return { kind: of, grouping: grouping ?? standard, ...(second === 'true' ? { secondAxis: true } : {}) }
  }
  return {
    id: 'new-' + kind,
    sheet: 'Data',
    anchor: place(),
    kind,
    grouping: grouping ?? (kind === 'column' || kind === 'bar' ? 'clustered' : 'standard'),
    groups: kinds.map(group),
    legend: 'right',
    axes: {},
    series: list.map((s) => ({ ...s, group: kinds.indexOf(`${s.kind}|${s.secondAxis === true}`) })),
    flags: {},
    ...extra
  }
}

export const edit = (charts: ChartSpec[], sheet = 'Data'): ChartsEdit => ({ kind: 'charts', sheet, charts })
export const chartsOf = (bytes: Uint8Array, sheet = 'Data') => readCharts(bytes, sheet).sheets[sheet].charts

/** Runs a patch and holds it to the parts it should change, add and remove. */
export function patched(input: Uint8Array, edits: ChartsEdit[], expected: Expected) {
  const out = patchCharts(input, edits)
  held(input, out.bytes, out.report, expected)
  for (const part of [...(expected.changed ?? []), ...(expected.added ?? [])])
    if (/^xl\/charts\/chart\d+\.xml$/.test(part)) ordered(xml(out.bytes, part))
  return out as { bytes: Uint8Array; report: ChartsReport }
}

// The schema's sequences, for the elements this writer writes or splices into.
const SEQUENCE: Record<string, string> = {
  chartSpace: 'date1904 lang roundedCorners AlternateContent style clrMapOvr pivotSource protection chart spPr txPr externalData printSettings userShapes extLst',
  chart: 'title autoTitleDeleted pivotFmts view3D floor sideWall backWall plotArea legend plotVisOnly dispBlanksAs showDLblsOverMax extLst',
  barChart: 'barDir grouping varyColors ser dLbls gapWidth overlap serLines axId extLst',
  lineChart: 'grouping varyColors ser dLbls dropLines hiLowLines upDownBars marker smooth axId extLst',
  areaChart: 'grouping varyColors ser dLbls dropLines axId extLst',
  pieChart: 'varyColors ser dLbls firstSliceAng extLst',
  doughnutChart: 'varyColors ser dLbls firstSliceAng holeSize extLst',
  scatterChart: 'scatterStyle varyColors ser dLbls axId extLst',
  'barChart>ser': 'idx order tx spPr invertIfNegative pictureOptions dPt dLbls trendline errBars cat val shape extLst',
  'lineChart>ser': 'idx order tx spPr marker dPt dLbls trendline errBars cat val smooth extLst',
  'areaChart>ser': 'idx order tx spPr pictureOptions dPt dLbls trendline errBars cat val extLst',
  'pieChart>ser': 'idx order tx spPr explosion dPt dLbls cat val extLst',
  'doughnutChart>ser': 'idx order tx spPr explosion dPt dLbls cat val extLst',
  'scatterChart>ser': 'idx order tx spPr marker dPt dLbls trendline errBars xVal yVal smooth extLst',
  catAx: 'axId scaling delete axPos majorGridlines minorGridlines title numFmt majorTickMark minorTickMark tickLblPos spPr txPr crossAx crosses crossesAt auto lblAlgn lblOffset tickLblSkip tickMarkSkip noMultiLvlLbl extLst',
  valAx: 'axId scaling delete axPos majorGridlines minorGridlines title numFmt majorTickMark minorTickMark tickLblPos spPr txPr crossAx crosses crossesAt crossBetween majorUnit minorUnit dispUnits extLst',
  scaling: 'logBase orientation max min extLst',
  title: 'tx layout overlay spPr txPr extLst',
  legend: 'legendPos legendEntry layout overlay spPr txPr extLst',
  dPt: 'idx invertIfNegative marker bubble3D explosion spPr pictureOptions extLst',
  marker: 'symbol size spPr extLst',
  numRef: 'f numCache extLst',
  strRef: 'f strCache extLst',
  numCache: 'formatCode ptCount pt extLst',
  strCache: 'ptCount pt extLst',
  spPr: 'xfrm custGeom prstGeom noFill solidFill gradFill blipFill pattFill grpFill ln effectLst effectDag scene3d sp3d extLst',
  ln: 'noFill solidFill gradFill pattFill prstDash custDash round bevel miter headEnd tailEnd extLst'
}
const AXES = new Set(['catAx', 'valAx', 'dateAx', 'serAx'])

/** Fails where a chart part's elements stand out of the schema's order, or a group names an axis the plot lacks. */
export function ordered(text: string): void {
  const root = parsed(text)
  type El = typeof root
  const kids = (el: El) => Array.from(el.childNodes).filter((n) => n.nodeType === 1) as El[]
  const walk = (el: El, parent: string) => {
    const name = el.localName ?? ''
    const sequence = SEQUENCE[`${parent}>${name}`] ?? SEQUENCE[name]
    const children = kids(el)
    if (sequence) {
      const order = sequence.split(' ')
      const ranks = children.map((kid) => order.indexOf(kid.localName ?? ''))
      expect(ranks, `${name}: ${children.map((kid) => kid.localName).join(' ')}`).not.toContain(-1)
      expect(ranks, `${name}: ${children.map((kid) => kid.localName).join(' ')}`).toEqual(ranks.toSorted((a, b) => a - b))
    }
    for (const kid of children) walk(kid, name)
  }
  walk(root, '')
  const plot = root.getElementsByTagName('c:plotArea')[0] ?? root.getElementsByTagName('plotArea')[0]
  const inside = plot ? kids(plot) : []
  // Groups come before axes, and every axis a group names is there once.
  const firstAxis = inside.findIndex((el) => AXES.has(el.localName ?? ''))
  const lastGroup = inside.findLastIndex((el) => (el.localName ?? '').endsWith('Chart'))
  if (firstAxis >= 0) expect(lastGroup).toBeLessThan(firstAxis)
  const value = (el: El, name: string) => kids(el).find((kid) => kid.localName === name)?.getAttribute('val')
  const axisIds = inside.filter((el) => AXES.has(el.localName ?? '')).map((el) => value(el, 'axId'))
  expect(new Set(axisIds).size).toBe(axisIds.length)
  for (const group of inside.filter((el) => (el.localName ?? '').endsWith('Chart'))) {
    const named = kids(group).filter((kid) => kid.localName === 'axId').map((kid) => kid.getAttribute('val'))
    for (const id of named) expect(axisIds).toContain(id)
    const round = group.localName === 'pieChart' || group.localName === 'doughnutChart'
    expect(named).toHaveLength(round ? 0 : 2)
    const identities = kids(group).filter((kid) => kid.localName === 'ser').map((ser) => value(ser, 'idx'))
    expect(identities.every((id) => /^\d+$/.test(id ?? ''))).toBe(true)
  }
  const series = Array.from(root.getElementsByTagName('*')).filter((el) => el.localName === 'ser')
  const all = (name: string) => series.map((ser) => value(ser as El, name))
  expect(new Set(all('idx')).size).toBe(series.length)
  expect(new Set(all('order')).size).toBe(series.length)
  for (const axis of inside.filter((el) => AXES.has(el.localName ?? ''))) expect(axisIds).toContain(value(axis, 'crossAx'))
}

const hexOf = (colour: ChartColour | undefined) =>
  colour && 'hex' in colour && !colour.transforms ? colour.hex.toUpperCase() : undefined

/**
 * What Excel should read from a workbook's charts: the proof harness compares its readings with
 * this. Only what Excel itself has a reading for is stated: a combo has no grouping of its own,
 * a scatter's text categories are 1, 2, 3 to Excel, and a kind this editor does not draw (a radar,
 * a stock chart) is named with its series' values and no more.
 */
export function expectation(bytes: Uint8Array) {
  const out: Record<string, { charts: unknown[] }> = {}
  for (const [sheet, { charts }] of Object.entries(readCharts(bytes).sheets)) {
    out[sheet] = {
      charts: charts.map((spec) => {
        const other = spec.kind === 'other'
        const stroked = (kind: SeriesKind) => !other && (kind === 'line' || kind === 'scatter')
        const numbers = (cache: SeriesData['cache']) => cache?.every((v) => v === null || typeof v === 'number')
        return {
          kind: other ? spec.otherKind : spec.kind,
          grouping: other || spec.kind === 'combo' ? undefined : spec.grouping,
          title: spec.title?.text ?? (spec.autoTitle ? undefined : null),
          legend: spec.legend,
          categoryAxisTitle: other ? undefined : spec.axes.category?.title?.text,
          valueAxisTitle: other ? undefined : spec.axes.value?.title?.text,
          valueAxisFormat: spec.axes.value?.formatLinked === false ? spec.axes.value.numberFormat : undefined,
          series: spec.series.map((s) => ({
            name: s.name?.text,
            kind: other ? undefined : s.kind,
            values: s.values.cache,
            categories: s.kind !== 'scatter' || numbers(s.categories?.cache) ? s.categories?.cache : undefined,
            secondAxis: s.secondAxis === true,
            colour: other ? undefined : hexOf(s.colour),
            ...(stroked(s.kind) ? { line: s.line, marker: s.marker, smooth: s.smooth === true } : {})
          }))
        }
      })
    }
  }
  return out
}

/** Keeps a workbook for the Excel proof when CHARTS_PROOF_DIR names a folder. */
export function proof(name: string, description: string, bytes: Uint8Array): void {
  keep('CHARTS_PROOF_DIR', name, bytes, { description, expect: expectation(bytes), charts: readCharts(bytes).sheets })
}
