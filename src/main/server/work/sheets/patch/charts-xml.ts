// A chart part written from a plan: the chart space, its groups, series and axes as Excel writes
// them, with the look of a chart made in Excel today (hairline grid, grey text, no plot border).
// A series with no colour of its own gets none here, so Excel draws the theme's accent for it,
// which is what the canvas draws. Every piece is also written alone, for a change in place.
import type { ChartColour, SeriesKind } from 'work-kit/sheet/xlsx'
import {
  checkedRef,
  refText,
  type AxisRole,
  type ChartPlan,
  type PlanAxis,
  type PlanData,
  type PlanGroup,
  type PlanRef,
  type PlanSeries,
  type PlanText
} from './charts-model'
import { A_NS, C_NS, DECL, DOC_REL } from './drawings'
import { xstring } from './rules-xml'
import { esc } from './xml'

/** What a chart is drawn with: its plan, the workbook's cells for a cache, and its date system. */
export interface Draw {
  plan: ChartPlan
  /** The values a range holds now, in reading order; undefined where they cannot be read cheaply. */
  cells(ref: PlanRef): Array<string | number | null> | undefined
  date1904: boolean
}

export const CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
export const AXIS_IDS: Record<AxisRole, string> = {
  category: '500000001',
  value: '500000002',
  secondCategory: '500000003',
  secondValue: '500000004'
}
const GROUPING = {
  clustered: 'clustered',
  stacked: 'stacked',
  percent: 'percentStacked',
  standard: 'standard'
}
const LEGEND = { right: 'r', left: 'l', top: 't', bottom: 'b', topRight: 'tr' }
const RANK: Record<SeriesKind, number> = {
  area: 0,
  column: 1,
  bar: 1,
  line: 2,
  scatter: 3,
  pie: 4,
  doughnut: 4
}

/** Text XML 1.0 can carry, escaped. */
const plain = (text: string) => esc(text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, ''))
const tone = (lumMod: number, lumOff: number) =>
  `<a:solidFill><a:schemeClr val="tx1"><a:lumMod val="${lumMod}"/><a:lumOff val="${lumOff}"/></a:schemeClr></a:solidFill>`
const GREY = tone(65000, 35000)
const HAIRLINE = `<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">${tone(15000, 85000)}<a:round/></a:ln>`
const NO_LINE = '<a:ln><a:noFill/></a:ln>'
const FONTS = '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>'
const run = (size: number) =>
  `sz="${size}" b="0" i="0" u="none" strike="noStrike" kern="1200" baseline="0"`
const body = (rot: number) =>
  `<a:bodyPr rot="${rot}" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/><a:lstStyle/>`
/** -60000000 is how Excel writes "as the chart turns it". */
const textProps = (size: number, rot = -60000000) =>
  `<c:txPr>${body(rot)}<a:p><a:pPr><a:defRPr ${run(size)}>${GREY}${FONTS}</a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`

export function fillXml(colour: ChartColour): string {
  const transforms = (colour.transforms ?? [])
    .map((t) => `<a:${t.name}${t.value === undefined ? '' : ` val="${t.value}"`}/>`)
    .join('')
  const [name, value] = 'hex' in colour ? ['srgbClr', colour.hex] : ['schemeClr', colour.scheme]
  return `<a:solidFill><a:${name} val="${value}"${transforms ? `>${transforms}</a:${name}>` : '/>'}</a:solidFill>`
}

// ---------------------------------------------------------------------------------------------
// Text: titles and names

export interface KeptText {
  /** `a:bodyPr` and `a:lstStyle` as the file has them. */
  body?: string
  /** The first paragraph's `a:pPr` and the first run's `a:rPr`, verbatim. */
  pPr?: string
  rPr?: string
}

/** Rich text, a paragraph a line. `keep` carries a title's own properties through a change of its words. */
export function richXml(text: string, size: number, rot = 0, keep: KeptText = {}): string {
  const pPr = keep.pPr ?? `<a:pPr><a:defRPr ${run(size)}>${GREY}${FONTS}</a:defRPr></a:pPr>`
  const rPr = keep.rPr ?? `<a:rPr lang="en-US" ${run(size)}>${GREY}${FONTS}</a:rPr>`
  const lines = text.split(/\r\n|\r|\n/)
  return (
    `<c:rich>${keep.body ?? body(rot)}` +
    lines.map((line) => `<a:p>${pPr}<a:r>${rPr}<a:t>${plain(line)}</a:t></a:r></a:p>`).join('') +
    '</c:rich>'
  )
}

function linkedXml(ref: PlanRef, shown: string | undefined, draw: Draw): string {
  const value = shown ?? draw.cells(ref)?.find((v) => v !== null)
  const cache =
    value === undefined
      ? ''
      : `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xstring(String(value))}</c:v></c:pt></c:strCache>`
  return `<c:strRef><c:f>${esc(refText(checkedRef(ref, draw.plan)))}</c:f>${cache}</c:strRef>`
}

/** A title's `c:tx`: a cell's text, or words of its own. */
export function titleTx(
  title: PlanText,
  size: number,
  rot: number,
  draw: Draw,
  keep?: KeptText
): string {
  return `<c:tx>${title.ref ? linkedXml(title.ref, title.text, draw) : richXml(title.text ?? '', size, rot, keep)}</c:tx>`
}

export type TitleRole = 'chart' | 'axis' | 'upright'
const TITLE = { chart: [1400, 0], axis: [1000, 0], upright: [1000, -5400000] } as const

/** A whole `c:title`. With no text it is the title Excel words itself. */
export function titleXml(title: PlanText | undefined, role: TitleRole, draw: Draw): string {
  const [size, rot] = TITLE[role]
  const rich = title && !title.ref
  return (
    `<c:title>${title ? titleTx(title, size, rot, draw) : ''}<c:overlay val="0"/>` +
    `<c:spPr><a:noFill/>${NO_LINE}</c:spPr>${rich ? '' : textProps(size, rot)}</c:title>`
  )
}

export const legendXml = (place: NonNullable<ChartPlan['legend']>) =>
  `<c:legend><c:legendPos val="${LEGEND[place]}"/><c:overlay val="0"/><c:spPr><a:noFill/>${NO_LINE}</c:spPr>${textProps(900)}</c:legend>`

/** A series' name: a cell's, or words of its own. */
export function nameXml(name: PlanText, draw: Draw): string {
  return `<c:tx>${name.ref ? linkedXml(name.ref, name.text, draw) : `<c:v>${xstring(name.text ?? '')}</c:v>`}</c:tx>`
}

// ---------------------------------------------------------------------------------------------
// Data

const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function pointsXml(
  cache: ReadonlyArray<string | number | null>,
  numbers: boolean,
  format?: string
): string {
  let out =
    (numbers ? `<c:formatCode>${plain(format ?? 'General')}</c:formatCode>` : '') +
    `<c:ptCount val="${cache.length}"/>`
  for (const [idx, v] of cache.entries()) {
    if (v === null || v === undefined || (numbers && !numeric(v))) continue
    out += `<c:pt idx="${idx}"><c:v>${numbers ? String(v) : xstring(String(v))}</c:v></c:pt>`
  }
  return out
}

/**
 * A series' `c:cat`, `c:val`, `c:xVal` or `c:yVal`. The cache is the spec's, else the cells'
 * own values, else none: Excel fills it when it opens the file. `want` says what the points are
 * where the cache does not: values are numbers, categories text unless every one is a number.
 */
export function dataXml(tag: 'cat' | 'val' | 'xVal' | 'yVal', data: PlanData, draw: Draw): string {
  const cache = data.cache ?? (data.ref?.areas ? draw.cells(data.ref) : undefined)
  const known = cache?.filter((v) => v !== null) ?? []
  const numbers =
    tag === 'val' || tag === 'yVal' || (known.length ? known.every(numeric) : tag === 'xVal')
  if (!data.ref) {
    const name = numbers ? 'numLit' : 'strLit'
    return `<c:${tag}><c:${name}>${pointsXml(cache ?? [], numbers, data.format)}</c:${name}></c:${tag}>`
  }
  const [holder, kept] = numbers ? ['numRef', 'numCache'] : ['strRef', 'strCache']
  return (
    `<c:${tag}><c:${holder}><c:f>${esc(refText(checkedRef(data.ref, draw.plan)))}</c:f>` +
    (cache ? `<c:${kept}>${pointsXml(cache, numbers, data.format)}</c:${kept}>` : '') +
    `</c:${holder}></c:${tag}>`
  )
}

// ---------------------------------------------------------------------------------------------
// Series

const stroked = (kind: SeriesKind) => kind === 'line' || kind === 'scatter'
const joined = (kind: SeriesKind, s: PlanSeries) => s.line ?? kind === 'line'
const marked = (kind: SeriesKind, s: PlanSeries) =>
  s.marker ?? (kind === 'scatter' || s.line === false)

/** The line of a line or scatter series: its width, and its colour unless Excel is to pick it. */
export function strokeXml(
  kind: SeriesKind,
  shown: boolean,
  colour: ChartColour | undefined
): string {
  const fill = !shown ? '<a:noFill/>' : colour ? fillXml(colour) : ''
  return `<a:ln w="${kind === 'line' ? 28575 : 19050}" cap="rnd">${fill}<a:round/></a:ln>`
}

/** A series' `c:spPr`; nothing where Excel is to pick the fill itself. */
export function shapeXml(kind: SeriesKind, s: PlanSeries): string {
  if (stroked(kind)) return `<c:spPr>${strokeXml(kind, joined(kind, s), s.colour)}</c:spPr>`
  return s.colour ? `<c:spPr>${fillXml(s.colour)}</c:spPr>` : ''
}

export function markerXml(shown: boolean, colour: ChartColour | undefined): string {
  if (!shown) return '<c:marker><c:symbol val="none"/></c:marker>'
  const paint = colour
    ? `<c:spPr>${fillXml(colour)}<a:ln w="9525">${fillXml(colour)}</a:ln></c:spPr>`
    : ''
  return `<c:marker><c:symbol val="circle"/><c:size val="5"/>${paint}</c:marker>`
}

/** One point's own colour: a slice of a pie, one bar, one marker. */
export function pointXml(kind: SeriesKind, idx: number, colour: ChartColour): string {
  const paint =
    kind === 'scatter'
      ? markerXml(true, colour) + '<c:bubble3D val="0"/>'
      : `<c:bubble3D val="0"/><c:spPr>${kind === 'line' ? strokeXml(kind, true, colour) : fillXml(colour)}</c:spPr>`
  const bar = kind === 'column' || kind === 'bar'
  return `<c:dPt><c:idx val="${idx}"/>${bar ? '<c:invertIfNegative val="0"/>' : ''}${paint}</c:dPt>`
}

/** A whole `c:ser` for a group of `kind`, under the identity `idx`. */
export function seriesXml(kind: SeriesKind, s: PlanSeries, idx: number, draw: Draw): string {
  const scatter = kind === 'scatter'
  const points = Object.entries(s.pointColours ?? {})
    .map(([point, colour]) => [Number(point), colour] as const)
    .sort(([a], [b]) => a - b)
  return (
    `<c:ser><c:idx val="${idx}"/><c:order val="${s.at}"/>` +
    (s.name ? nameXml(s.name, draw) : '') +
    shapeXml(kind, s) +
    (kind === 'column' || kind === 'bar' ? '<c:invertIfNegative val="0"/>' : '') +
    (stroked(kind) ? markerXml(marked(kind, s), s.colour) : '') +
    points.map(([point, colour]) => pointXml(kind, point, colour)).join('') +
    (s.categories ? dataXml(scatter ? 'xVal' : 'cat', s.categories, draw) : '') +
    dataXml(scatter ? 'yVal' : 'val', s.values, draw) +
    (stroked(kind) ? `<c:smooth val="${s.smooth ? 1 : 0}"/>` : '') +
    '</c:ser>'
  )
}

/** The `c:idx` of each series: its own where it has one no other holds, else the lowest free. */
export function identities(plan: ChartPlan): Map<PlanSeries, number> {
  const out = new Map<PlanSeries, number>()
  const used = new Set<number>()
  for (const s of plan.series)
    if (s.index !== undefined && !used.has(s.index)) {
      used.add(s.index)
      out.set(s, s.index)
    }
  let next = 0
  for (const s of plan.series) {
    if (out.has(s)) continue
    while (used.has(next)) next++
    used.add(next)
    out.set(s, next)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Groups and axes

const stacks = (group: PlanGroup) => group.grouping === 'stacked' || group.grouping === 'percent'

/** Bars that stack sit one on another: an overlap of 100, whatever the group had as clustered bars. */
export const overlapOf = (group: PlanGroup) => (stacks(group) ? 100 : (group.overlap ?? -27))

function groupXml(
  group: PlanGroup,
  axes: string,
  idx: Map<PlanSeries, number>,
  draw: Draw
): string {
  const { kind } = group
  const round = kind === 'pie' || kind === 'doughnut'
  const vary = `<c:varyColors val="${(group.varyColours ?? round) ? 1 : 0}"/>`
  const series = group.series.map((s) => seriesXml(kind, s, idx.get(s) ?? s.at, draw)).join('')
  const grouping = `<c:grouping val="${GROUPING[group.grouping]}"/>`
  if (kind === 'column' || kind === 'bar')
    return (
      `<c:barChart><c:barDir val="${kind === 'bar' ? 'bar' : 'col'}"/>${grouping}${vary}${series}` +
      `<c:gapWidth val="${group.gapWidth ?? (stacks(group) ? 150 : 219)}"/><c:overlap val="${overlapOf(group)}"/>${axes}</c:barChart>`
    )
  if (kind === 'line')
    return `<c:lineChart>${grouping}${vary}${series}<c:marker val="1"/>${axes}</c:lineChart>`
  if (kind === 'area') return `<c:areaChart>${grouping}${vary}${series}${axes}</c:areaChart>`
  if (kind === 'scatter')
    return `<c:scatterChart><c:scatterStyle val="lineMarker"/>${vary}${series}${axes}</c:scatterChart>`
  const turn = '<c:firstSliceAng val="0"/>'
  return kind === 'pie'
    ? `<c:pieChart>${vary}${series}${turn}</c:pieChart>`
    : `<c:doughnutChart>${vary}${series}${turn}<c:holeSize val="${group.holeSize ?? 75}"/></c:doughnutChart>`
}

export const numFmtXml = (axis: PlanAxis | undefined, fallback?: string) =>
  axis?.numberFormat !== undefined
    ? `<c:numFmt formatCode="${plain(axis.numberFormat)}" sourceLinked="${axis.formatLinked ? 1 : 0}"/>`
    : fallback
      ? `<c:numFmt formatCode="${fallback}" sourceLinked="0"/>`
      : '<c:numFmt formatCode="General" sourceLinked="1"/>'

interface AxisShape {
  type: 'catAx' | 'valAx'
  id: string
  cross: string
  side: 'b' | 'l' | 'r' | 't'
  grid: boolean
  line: boolean
  far: boolean
  between?: 'between' | 'midCat'
  hidden?: boolean
  format?: string
}

function axisXml(axis: PlanAxis | undefined, shape: AxisShape, draw: Draw): string {
  const value = shape.type === 'valAx'
  const upright = shape.side === 'l' || shape.side === 'r'
  const scaling =
    (value && axis?.logBase !== undefined ? `<c:logBase val="${axis.logBase}"/>` : '') +
    `<c:orientation val="${axis?.reversed ? 'maxMin' : 'minMax'}"/>` +
    (value && axis?.max !== undefined ? `<c:max val="${axis.max}"/>` : '') +
    (value && axis?.min !== undefined ? `<c:min val="${axis.min}"/>` : '')
  return (
    `<c:${shape.type}><c:axId val="${shape.id}"/><c:scaling>${scaling}</c:scaling>` +
    `<c:delete val="${(axis?.hidden ?? shape.hidden) ? 1 : 0}"/><c:axPos val="${shape.side}"/>` +
    (shape.grid ? `<c:majorGridlines><c:spPr>${HAIRLINE}</c:spPr></c:majorGridlines>` : '') +
    (axis?.title ? titleXml(axis.title, upright ? 'upright' : 'axis', draw) : '') +
    numFmtXml(axis, shape.format) +
    '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    `<c:spPr><a:noFill/>${shape.line ? HAIRLINE : NO_LINE}</c:spPr>${textProps(900)}` +
    `<c:crossAx val="${shape.cross}"/><c:crosses val="${shape.far ? 'max' : 'autoZero'}"/>` +
    (value
      ? `<c:crossBetween val="${shape.between}"/>`
      : '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/>') +
    `</c:${shape.type}>`
  )
}

/** The plot area's groups and axes: what a new chart holds, and what a change of kind writes afresh. */
export function plotXml(plan: ChartPlan, draw: Draw): string {
  const idx = identities(plan)
  const kinds = new Set(plan.groups.map((group) => group.kind))
  const round = kinds.has('pie') || kinds.has('doughnut')
  const scatter = kinds.has('scatter')
  const bar = kinds.has('bar')
  const ids = (second: boolean) =>
    round
      ? ''
      : `<c:axId val="${AXIS_IDS[second ? 'secondCategory' : 'category']}"/><c:axId val="${AXIS_IDS[second ? 'secondValue' : 'value']}"/>`
  const groups = plan.groups
    .map((group, at) => ({ group, at }))
    .sort(
      (a, b) =>
        RANK[a.group.kind] - RANK[b.group.kind] ||
        Number(a.group.secondAxis) - Number(b.group.secondAxis) ||
        a.at - b.at
    )
    .map(({ group }) => groupXml(group, ids(group.secondAxis), idx, draw))
    .join('')
  if (round) return groups
  const second = plan.groups.some((group) => group.secondAxis)
  const between = (far: boolean) =>
    scatter || plan.groups.filter((g) => g.secondAxis === far).every((g) => g.kind === 'area')
      ? 'midCat'
      : 'between'
  const percent = (far: boolean) =>
    plan.groups.some((g) => g.secondAxis === far && g.grouping === 'percent') ? '0%' : undefined
  const pair = (far: boolean): string => {
    const category = AXIS_IDS[far ? 'secondCategory' : 'category']
    const value = AXIS_IDS[far ? 'secondValue' : 'value']
    return (
      axisXml(
        plan.axes[far ? 'secondCategory' : 'category'],
        {
          type: scatter ? 'valAx' : 'catAx',
          id: category,
          cross: value,
          side: bar ? 'l' : 'b',
          grid: scatter && !far,
          line: true,
          far: false,
          between: 'midCat',
          hidden: far
        },
        draw
      ) +
      axisXml(
        plan.axes[far ? 'secondValue' : 'value'],
        {
          type: 'valAx',
          id: value,
          cross: category,
          side: bar ? (far ? 't' : 'b') : far ? 'r' : 'l',
          grid: !far,
          line: false,
          far,
          between: between(far),
          format: percent(far)
        },
        draw
      )
    )
  }
  return groups + pair(false) + (second ? pair(true) : '')
}

/** A whole chart part. */
export function chartXml(plan: ChartPlan, draw: Draw): string {
  const title =
    plan.title || plan.autoTitle
      ? titleXml(plan.title, 'chart', draw) + '<c:autoTitleDeleted val="0"/>'
      : '<c:autoTitleDeleted val="1"/>'
  return (
    DECL +
    `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${DOC_REL}">` +
    `<c:date1904 val="${draw.date1904 ? 1 : 0}"/><c:roundedCorners val="0"/>` +
    `<c:chart>${title}<c:plotArea><c:layout/>${plotXml(plan, draw)}<c:spPr><a:noFill/>${NO_LINE}</c:spPr></c:plotArea>` +
    (plan.legend ? legendXml(plan.legend) : '') +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
    `<c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill>${HAIRLINE}</c:spPr>` +
    '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>' +
    '<c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings>' +
    '</c:chartSpace>'
  )
}
