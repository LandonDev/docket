// A chart as the writer reads it. The canvas hands back the kit's ChartSpec, the same shape the
// reader makes from a file; here both are folded into one plan (the groups Excel draws, each
// series in its group, every range in one form), so the spec handed in and the spec read from the
// file are compared like with like, and only a real difference is written.
import {
  isExternalRef,
  type ChartAxis,
  type ChartColour,
  type ChartGrouping,
  type ChartSpec,
  type ChartText,
  type SeriesData,
  type SeriesKind
} from 'work-kit/sheet/xlsx'
import { ObjectsRefused } from './drawings'
import { quotedSheet } from './rules-xml'
import { colName, colNum } from './xml'

export class ChartsRefused extends ObjectsRefused {
  override name = 'ChartsRefused'
}

/** A sentence may start with a chart's label. */
export const capital = (text: string) => text[0].toUpperCase() + text.slice(1)

export const MAX_CHARTS = 500
export const MAX_SERIES = 255
export const MAX_POINTS = 100_000
const MAX_ROW = 1_048_576
const MAX_COL = 16_384
const KINDS = new Set<SeriesKind>(['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'])
const SCHEME = new Set(
  'bg1 tx1 bg2 tx2 accent1 accent2 accent3 accent4 accent5 accent6 hlink folHlink dk1 lt1 dk2 lt2 phClr'.split(
    ' '
  )
)
const TRANSFORMS = new Set(
  (
    'tint shade comp inv gray alpha alphaOff alphaMod hue hueOff hueMod sat satOff satMod lum lumOff lumMod ' +
    'red redOff redMod green greenOff greenMod blue blueOff blueMod gamma invGamma'
  ).split(' ')
)

/** One rectangle of cells on one sheet, 1-based and inclusive. */
export interface Area {
  sheet: string
  r1: number
  c1: number
  r2: number
  c2: number
}

/** A range as the spec writes it, and as cells when it is a plain range of this workbook. */
export interface PlanRef {
  raw: string
  areas?: Area[]
}

export interface PlanData {
  ref?: PlanRef
  cache?: Array<string | number | null>
  format?: string
}

export interface PlanText {
  text?: string
  ref?: PlanRef
}

export interface PlanSeries {
  /** Its place in the spec's list: its `c:order`. */
  at: number
  /** `c:idx`, the series' identity: what a series handed back is matched by. */
  index?: number
  name?: PlanText
  categories?: PlanData
  values: PlanData
  colour?: ChartColour
  pointColours?: Record<number, ChartColour>
  line?: boolean
  smooth?: boolean
  marker?: boolean
}

export interface PlanGroup {
  kind: SeriesKind
  grouping: ChartGrouping
  secondAxis: boolean
  /** The group of the file's chart these series came from, when they all name one. */
  from?: number
  /** A group Excel draws some other way than its series' kind says: radar, stock, bubble, surface, ofPie, 3D. */
  other?: string
  gapWidth?: number
  overlap?: number
  holeSize?: number
  varyColours?: boolean
  series: PlanSeries[]
}

export interface PlanAxis {
  /** The axis' id in the file it was read from. */
  id?: string
  title?: PlanText
  numberFormat?: string
  formatLinked?: boolean
  min?: number
  max?: number
  reversed?: boolean
  hidden?: boolean
  logBase?: number
}

export type AxisRole = 'category' | 'value' | 'secondCategory' | 'secondValue'
export const AXIS_ROLES: readonly AxisRole[] = [
  'category',
  'value',
  'secondCategory',
  'secondValue'
]

export interface ChartPlan {
  /** What the chart is called in a refusal. */
  label: string
  groups: PlanGroup[]
  series: PlanSeries[]
  title?: PlanText
  autoTitle: boolean
  legend: ChartSpec['legend']
  axes: Partial<Record<AxisRole, PlanAxis>>
}

// ---------------------------------------------------------------------------------------------
// Ranges

const plainName = (name: string) =>
  /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(name) &&
  !/^[A-Za-z]{1,3}\d{1,7}$/.test(name) &&
  !/^(?:[Rr]\d*)?(?:[Cc]\d*)?$/.test(name) &&
  !/^(?:true|false)$/i.test(name)

function splitAreas(text: string): string[] {
  const body = /^\((.*)\)$/s.exec(text)?.[1] ?? text
  const out: string[] = []
  let quoted = false
  let from = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "'") quoted = !quoted
    else if (body[i] === ',' && !quoted) {
      out.push(body.slice(from, i))
      from = i + 1
    }
  }
  out.push(body.slice(from))
  return out.map((part) => part.trim())
}

function areaOf(text: string, own: string, sheets: ReadonlyMap<string, string>): Area | undefined {
  const m = /^(?:('(?:[^']|'')+'|[^'!]+)!)?([^!]+)$/.exec(text)
  if (!m) return undefined
  const named =
    m[1] === undefined ? own : m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1]
  const sheet = sheets.get(named.toLowerCase())
  if (sheet === undefined) return undefined
  const body = m[2]
  const cells = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/.exec(body)
  const columns = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/.exec(body)
  const rows = /^\$?(\d{1,7}):\$?(\d{1,7})$/.exec(body)
  let a: [number, number], b: [number, number]
  if (cells) {
    a = [Number(cells[2]), colNum(cells[1])]
    b = cells[3] ? [Number(cells[4]), colNum(cells[3])] : a
  } else if (columns) {
    a = [1, colNum(columns[1])]
    b = [MAX_ROW, colNum(columns[2])]
  } else if (rows) {
    a = [Number(rows[1]), 1]
    b = [Number(rows[2]), MAX_COL]
  } else return undefined
  const area = {
    sheet,
    r1: Math.min(a[0], b[0]),
    c1: Math.min(a[1], b[1]),
    r2: Math.max(a[0], b[0]),
    c2: Math.max(a[1], b[1])
  }
  return area.r1 >= 1 && area.c1 >= 1 && area.r2 <= MAX_ROW && area.c2 <= MAX_COL ? area : undefined
}

function refOf(
  raw: string | undefined,
  own: string,
  sheets: ReadonlyMap<string, string>
): PlanRef | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim().replace(/^=/, '').trim()
  if (!text) return undefined
  const ref: PlanRef = { raw: text }
  if (isExternalRef(text) || text.length > 8192) return ref
  const areas = splitAreas(text).map((part) => areaOf(part, own, sheets))
  if (areas.length <= 64 && areas.every((area) => area !== undefined)) ref.areas = areas
  return ref
}

/** A range as Excel writes it in a chart: absolute, the sheet named, quoted where it must be. */
export function refText(ref: PlanRef): string {
  if (!ref.areas) return ref.raw
  const parts = ref.areas.map((a) => {
    const sheet = plainName(a.sheet) ? a.sheet : quotedSheet(a.sheet)
    if (a.r1 === 1 && a.r2 === MAX_ROW) return `${sheet}!$${colName(a.c1)}:$${colName(a.c2)}`
    if (a.c1 === 1 && a.c2 === MAX_COL) return `${sheet}!$${a.r1}:$${a.r2}`
    const from = `$${colName(a.c1)}$${a.r1}`
    return a.r1 === a.r2 && a.c1 === a.c2
      ? `${sheet}!${from}`
      : `${sheet}!${from}:$${colName(a.c2)}$${a.r2}`
  })
  return parts.length > 1 ? `(${parts.join(',')})` : parts[0]
}

export const sameRef = (a: PlanRef | undefined, b: PlanRef | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.areas && b.areas
      ? JSON.stringify(a.areas) === JSON.stringify(b.areas)
      : a.raw === b.raw

/** A range that can be written: a plain range of this workbook's own sheets. */
export function checkedRef(ref: PlanRef, plan: ChartPlan): PlanRef {
  if (!ref.areas)
    throw new ChartsRefused(`“${ref.raw}” in ${plan.label} is not a cell range in this workbook.`)
  return ref
}

// ---------------------------------------------------------------------------------------------
// The plan

const text = (
  value: ChartText | undefined,
  own: string,
  sheets: ReadonlyMap<string, string>
): PlanText | undefined => {
  if (!value) return undefined
  const ref = refOf(value.ref, own, sheets)
  const out: PlanText = {}
  if (ref) out.ref = ref
  if (typeof value.text === 'string') out.text = value.text
  return out.ref || out.text !== undefined ? out : undefined
}

const data = (
  value: SeriesData | undefined,
  own: string,
  sheets: ReadonlyMap<string, string>
): PlanData | undefined => {
  if (!value) return undefined
  const out: PlanData = {}
  const ref = refOf(value.ref, own, sheets)
  if (ref) out.ref = ref
  if (Array.isArray(value.cache)) out.cache = value.cache
  if (typeof value.format === 'string' && value.format) out.format = value.format
  return out.ref || out.cache ? out : undefined
}

const defined = <T>(value: T | undefined, ok: (v: T) => boolean): T | undefined =>
  value !== undefined && ok(value) ? value : undefined
const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function groupingFor(kind: SeriesKind, grouping: ChartGrouping | undefined): ChartGrouping {
  if (kind === 'pie' || kind === 'doughnut' || kind === 'scatter') return 'standard'
  if (grouping === 'stacked' || grouping === 'percent') return grouping
  return kind === 'column' || kind === 'bar' ? 'clustered' : 'standard'
}

/**
 * A spec as the groups it draws. What is drawn is what is written: a series' own `kind` and
 * `secondAxis` say where it goes, its `group` says which of the spec's groups lends it grouping,
 * gap, overlap and hole. Nothing is refused here, so a spec read from any file has a plan.
 */
export function planOf(spec: ChartSpec, tabs: readonly string[]): ChartPlan {
  const sheets = new Map(tabs.map((name) => [name.toLowerCase(), name]))
  const own = spec.sheet
  const listed = Array.isArray(spec.groups) ? spec.groups : []
  const groups: PlanGroup[] = []
  const byKey = new Map<string, PlanGroup>()
  const all: PlanSeries[] = []
  for (const [at, s] of (Array.isArray(spec.series) ? spec.series : []).entries()) {
    const g = Number.isInteger(s.group) ? listed[s.group] : undefined
    const fallback = KINDS.has(spec.kind as SeriesKind) ? (spec.kind as SeriesKind) : 'column'
    const kind = KINDS.has(s.kind) ? s.kind : g && KINDS.has(g.kind) ? g.kind : fallback
    const secondAxis = (s.secondAxis ?? g?.secondAxis) === true
    const key = `${g ? s.group : ''}|${kind}|${secondAxis}`
    let group = byKey.get(key)
    if (!group) {
      group = {
        kind,
        grouping: groupingFor(kind, g?.grouping ?? spec.grouping),
        secondAxis,
        series: []
      }
      if (g) {
        group.from = s.group
        group.other = g.otherKind ?? (g.threeD ? '3D' : undefined)
        group.gapWidth = number(g.gapWidth)
        // Stacked bars sit one on another whatever the file says, and an overlap of 100 left on
        // bars that stopped stacking is not one anybody chose.
        group.overlap =
          group.grouping === 'clustered' && g.overlap !== 100 ? number(g.overlap) : undefined
        group.holeSize = number(g.holeSize)
        group.varyColours = flag(g.varyColours)
      }
      byKey.set(key, group)
      groups.push(group)
    }
    const series: PlanSeries = { at, values: data(s.values, own, sheets) ?? {} }
    series.index = defined(s.index, (n) => Number.isInteger(n) && n >= 0)
    series.name = text(s.name, own, sheets)
    series.categories = data(s.categories, own, sheets)
    series.colour = s.colour
    series.pointColours =
      s.pointColours && Object.keys(s.pointColours).length ? s.pointColours : undefined
    series.line = flag(s.line)
    series.smooth = flag(s.smooth)
    series.marker = flag(s.marker)
    group.series.push(series)
    all.push(series)
  }
  // With nothing on the first axis pair there is no second one.
  if (groups.every((group) => group.secondAxis))
    for (const group of groups) group.secondAxis = false
  const axes: ChartPlan['axes'] = {}
  for (const role of AXIS_ROLES) {
    const axis: ChartAxis | undefined = spec.axes?.[role]
    if (!axis) continue
    axes[role] = {
      id: typeof axis.id === 'string' ? axis.id : undefined,
      title: text(axis.title, own, sheets),
      numberFormat: defined(axis.numberFormat, (f) => typeof f === 'string' && f.length > 0),
      formatLinked: flag(axis.formatLinked),
      min: number(axis.min),
      max: number(axis.max),
      reversed: flag(axis.reversed),
      hidden: flag(axis.hidden),
      logBase: number(axis.logBase)
    }
  }
  const title = text(spec.title, own, sheets)
  return {
    label: title?.text ? `the chart “${title.text}”` : `a chart on “${spec.sheet}”`,
    groups,
    series: all,
    title,
    autoTitle: !title && spec.autoTitle === true,
    legend: spec.legend ?? null,
    axes
  }
}

function checkedColour(colour: ChartColour | undefined, plan: ChartPlan): void {
  if (colour === undefined) return
  const base =
    'hex' in colour
      ? /^[0-9A-Fa-f]{6}$/.test(colour.hex)
      : typeof colour.scheme === 'string' && SCHEME.has(colour.scheme)
  const transforms = colour.transforms ?? []
  const fine =
    Array.isArray(transforms) &&
    transforms.length <= 16 &&
    transforms.every(
      (t) => TRANSFORMS.has(t.name) && (t.value === undefined || Number.isInteger(t.value))
    )
  if (!base || !fine)
    throw new ChartsRefused(`A colour in ${plan.label} is not one Excel can read.`)
}

const within = (value: number | undefined, min: number, max: number) =>
  value === undefined || (value >= min && value <= max)

/** A series that can be written: values to draw, colours Excel reads, text of a length it takes. */
export function checkedSeries(series: PlanSeries, plan: ChartPlan): void {
  if (!series.values.ref && !series.values.cache?.length)
    throw new ChartsRefused(`Give every series of ${plan.label} a range of values.`)
  for (const part of [series.values, series.categories]) {
    if ((part?.cache?.length ?? 0) > MAX_POINTS)
      throw new ChartsRefused(
        `A series of ${plan.label} has more than ${MAX_POINTS.toLocaleString('en-US')} points.`
      )
  }
  if ((series.name?.text?.length ?? 0) > 255)
    throw new ChartsRefused(`A series name in ${plan.label} is longer than 255 characters.`)
  checkedColour(series.colour, plan)
  for (const [point, colour] of Object.entries(series.pointColours ?? {})) {
    if (!/^\d{1,7}$/.test(point))
      throw new ChartsRefused(`A point colour in ${plan.label} names no point.`)
    checkedColour(colour, plan)
  }
}

/** A plan Excel can draw as one chart: refused in words where it cannot. */
export function checkedPlan(plan: ChartPlan): ChartPlan {
  if (!plan.series.length) throw new ChartsRefused(`Give ${plan.label} at least one series.`)
  if (plan.series.length > MAX_SERIES)
    throw new ChartsRefused(
      `A chart holds at most ${MAX_SERIES} series; ${plan.label} has ${plan.series.length}.`
    )
  const other = plan.groups.find((group) => group.other)?.other
  if (other) throw new ChartsRefused(`This editor cannot make a ${other} chart: make it in Excel.`)
  const kinds = new Set(plan.groups.map((group) => group.kind))
  const alone = (['bar', 'pie', 'doughnut', 'scatter'] as const).find((kind) => kinds.has(kind))
  if (alone && kinds.size > 1)
    throw new ChartsRefused(
      `Excel cannot draw ${alone === 'scatter' ? 'a scatter' : alone === 'bar' ? 'bars' : `a ${alone}`} and another kind in one chart.`
    )
  if ((kinds.has('pie') || kinds.has('doughnut')) && plan.groups.length > 1)
    throw new ChartsRefused(
      `A ${kinds.has('pie') ? 'pie' : 'doughnut'} chart has one group of series.`
    )
  for (const group of plan.groups) {
    if (
      !within(group.gapWidth, 0, 500) ||
      !within(group.overlap, -100, 100) ||
      !within(group.holeSize, 1, 90)
    )
      throw new ChartsRefused(
        `A gap, an overlap or a hole in ${plan.label} is outside what Excel takes.`
      )
  }
  for (const series of plan.series) checkedSeries(series, plan)
  for (const value of [plan.title, ...AXIS_ROLES.map((role) => plan.axes[role]?.title)])
    if ((value?.text?.length ?? 0) > 4000)
      throw new ChartsRefused(`A title in ${plan.label} is longer than 4,000 characters.`)
  for (const role of AXIS_ROLES) {
    const axis = plan.axes[role]
    if (!axis) continue
    if ((axis.numberFormat?.length ?? 0) > 255)
      throw new ChartsRefused(`A number format in ${plan.label} is longer than 255 characters.`)
    if (axis.min !== undefined && axis.max !== undefined && axis.min >= axis.max)
      throw new ChartsRefused(
        `An axis of ${plan.label} has a smallest value that is not below its largest.`
      )
    if (axis.logBase !== undefined && (axis.logBase < 2 || axis.logBase > 1000))
      throw new ChartsRefused(`A logarithmic axis of ${plan.label} needs a base from 2 to 1,000.`)
  }
  if (plan.legend !== null && !['right', 'left', 'top', 'bottom', 'topRight'].includes(plan.legend))
    throw new ChartsRefused(`The legend of ${plan.label} has no such place.`)
  return plan
}

/** A title's state: none, Excel's own, a text, or a cell's. Two equal states write nothing. */
export function titleKey(title: PlanText | undefined, auto: boolean): string {
  if (title?.ref) return 'ref:' + JSON.stringify(title.ref.areas ?? title.ref.raw)
  if (title?.text !== undefined) return 'text:' + title.text
  return auto ? 'auto' : 'none'
}

export const sameColour = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Whether a series' data moved: its range, or with no range on either side its literal points. */
export function sameData(a: PlanData | undefined, b: PlanData | undefined): boolean {
  if (!a || !b) return a === b
  if (a.ref || b.ref) return sameRef(a.ref, b.ref)
  return JSON.stringify(a.cache ?? []) === JSON.stringify(b.cache ?? [])
}

export const sameText = (a: PlanText | undefined, b: PlanText | undefined): boolean =>
  titleKey(a, false) === titleKey(b, false)
