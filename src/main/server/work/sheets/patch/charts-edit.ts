// A chart part changed in place. The spec the file gave and the spec handed back are compared
// as plans; with no difference the part is not even read. Where the groups keep their kinds only
// the pieces that differ are spliced (a title's words, a legend's side, an axis' format, a series'
// name, ranges and colour, a series added or dropped), so what the spec does not hold (data labels,
// trendlines, fonts, layout) stays byte for byte. Where a kind or the set of groups changes, the
// plot area's groups and axes are written afresh and the rest of the part stays.
import type { ChartColour, ChartSpec, SeriesKind } from 'work-kit/sheet/xlsx'
import {
  AXIS_ROLES,
  capital,
  ChartsRefused,
  checkedPlan,
  checkedSeries,
  planOf,
  sameColour,
  sameData,
  sameText,
  titleKey,
  type ChartPlan,
  type PlanData,
  type PlanGroup,
  type PlanSeries,
  type PlanText
} from './charts-model'
import {
  dataXml,
  fillXml,
  legendXml,
  markerXml,
  nameXml,
  numFmtXml,
  overlapOf,
  plotXml,
  pointXml,
  seriesXml,
  strokeXml,
  titleTx,
  titleXml,
  type Draw,
  type KeptText,
  type TitleRole
} from './charts-xml'
import { A_NS, C_NS } from './drawings'
import {
  applySplices,
  children,
  documentRoot,
  elementText,
  openTag,
  valueOf,
  withBody,
  type ElementSpan,
  type Splice
} from './format-xml'
import { local } from './rules-xml'
import { parseAttrs } from './xml'

const words = (list: string) => list.split(' ')
const CHART = words(
  'title autoTitleDeleted pivotFmts view3D floor sideWall backWall plotArea legend plotVisOnly dispBlanksAs showDLblsOverMax extLst'
)
const PLOT = words(
  'layout areaChart area3DChart lineChart line3DChart stockChart radarChart scatterChart pieChart pie3DChart doughnutChart barChart bar3DChart ofPieChart surfaceChart surface3DChart bubbleChart valAx catAx dateAx serAx dTable spPr extLst'
)
const GROUP = words(
  'barDir scatterStyle grouping varyColors ser dLbls dropLines hiLowLines upDownBars gapWidth overlap serLines marker smooth firstSliceAng holeSize axId extLst'
)
const SER = words(
  'idx order tx spPr invertIfNegative pictureOptions marker explosion dPt dLbls trendline errBars cat val xVal yVal shape smooth bubbleSize bubble3D extLst'
)
const POINT = words('idx invertIfNegative marker bubble3D explosion spPr pictureOptions extLst')
const MARKER = words('symbol size spPr extLst')
const AXIS = words(
  'axId scaling delete axPos majorGridlines minorGridlines title numFmt majorTickMark minorTickMark tickLblPos spPr txPr crossAx crosses crossesAt'
)
const SCALING = words('logBase orientation max min extLst')
const TITLE = words('tx layout overlay spPr txPr extLst')
const LEGEND = words('legendPos legendEntry layout overlay spPr txPr extLst')
const SHAPE = words(
  'xfrm custGeom prstGeom noFill solidFill gradFill blipFill pattFill grpFill ln effectLst effectDag scene3d sp3d extLst'
)
const LINE = words(
  'noFill solidFill gradFill pattFill prstDash custDash round bevel miter headEnd tailEnd extLst'
)
const FILLS = new Set(words('noFill solidFill gradFill blipFill pattFill grpFill'))
const ELEMENT: Record<SeriesKind, string> = {
  column: 'barChart',
  bar: 'barChart',
  line: 'lineChart',
  area: 'areaChart',
  pie: 'pieChart',
  doughnut: 'doughnutChart',
  scatter: 'scatterChart'
}
const GROUPING = {
  clustered: 'clustered',
  stacked: 'stacked',
  percent: 'percentStacked',
  standard: 'standard'
}
const LEGEND_POS = { right: 'r', left: 'l', top: 't', bottom: 'b', topRight: 'tr' }
const NOT_OURS = 'is written in a way this editor cannot change: change it in Excel.'

/** Thrown inside a change in place where only writing the plot area afresh will do. */
class Afresh extends Error {}

/**
 * A part as spans and splices. What is written goes in under the part's own prefixes. Reading
 * asks nothing of the part; the first change needs a classic chart part with the chart and the
 * drawing namespaces bound on its root, and is refused anywhere else (a chartEx part, Strict
 * Open XML).
 */
class Doc {
  readonly root: ElementSpan
  private readonly c: string = 'c:'
  private readonly a: string = 'a:'
  private readonly fault: boolean
  private readonly splices: Array<Splice & { rank?: number }> = []
  private readonly kidsOf = new Map<number, ElementSpan[]>()
  private readonly filled = new Map<
    number,
    { el: ElementSpan; text: Array<{ rank: number; text: string }> }
  >()

  constructor(
    readonly xml: string,
    private readonly label: string
  ) {
    const root = documentRoot(xml)
    if (!root) throw new ChartsRefused(`${capital(label)} ${NOT_OURS}`)
    this.root = root
    const bound = new Map(
      parseAttrs(openTag(xml, root))
        .filter((attr) => attr.name === 'xmlns' || attr.name.startsWith('xmlns:'))
        .map((attr) => [attr.value, attr.name === 'xmlns' ? '' : attr.name.slice(6) + ':'])
    )
    const c = bound.get(C_NS)
    const a = bound.get(A_NS)
    this.fault = c === undefined || !a || root.name !== c + 'chartSpace'
    if (c !== undefined) this.c = c
    if (a) this.a = a
  }

  kids(el: ElementSpan): ElementSpan[] {
    let list = this.kidsOf.get(el.start)
    if (!list) this.kidsOf.set(el.start, (list = [...children(this.xml, el)]))
    return list
  }

  all(el: ElementSpan | undefined, name: string): ElementSpan[] {
    return el ? this.kids(el).filter((kid) => local(kid.name) === name) : []
  }

  one(el: ElementSpan | undefined, name: string): ElementSpan | undefined {
    return el && this.kids(el).find((kid) => local(kid.name) === name)
  }

  val(el: ElementSpan | undefined): string | undefined {
    return el && valueOf(openTag(this.xml, el), 'val')
  }

  /** DrawingML's boolean: present with no `val` is true. */
  on(el: ElementSpan | undefined): boolean | undefined {
    const value = this.val(el)
    return el ? value === undefined || value === '1' || value === 'true' : undefined
  }

  text(el: ElementSpan): string {
    return elementText(this.xml, el)
  }

  private splice(start: number, end: number, text: string, rank?: number): void {
    if (this.fault) throw new ChartsRefused(`${capital(this.label)} ${NOT_OURS}`)
    this.splices.push({ start, end, text, rank })
  }

  private fit(text: string): string {
    if (this.c === 'c:' && this.a === 'a:') return text
    return text.replace(/<(\/?)c:/g, `<$1${this.c}`).replace(/<(\/?)a:/g, `<$1${this.a}`)
  }

  replace(el: ElementSpan, text: string): void {
    const fitted = this.fit(text)
    if (fitted !== this.text(el)) this.splice(el.start, el.end, fitted)
  }

  remove(el: ElementSpan | undefined): void {
    if (el) this.splice(el.start, el.end, '')
  }

  /** A new child at its place in the parent's schema order, after any of its own name. */
  insert(parent: ElementSpan, text: string, name: string, order: readonly string[]): void {
    const rank = order.indexOf(name)
    if (parent.openEnd === parent.end) {
      const entry = this.filled.get(parent.start) ?? { el: parent, text: [] }
      entry.text.push({ rank, text: this.fit(text) })
      this.filled.set(parent.start, entry)
      return
    }
    const at =
      this.kids(parent).find((kid) => order.indexOf(local(kid.name)) > rank)?.start ?? parent.close
    this.splice(at, at, this.fit(text), rank)
  }

  /** Sets the child `name` to `text`, adds it where the parent has none, or with null removes it. */
  put(parent: ElementSpan, name: string, text: string | null, order: readonly string[]): void {
    const old = this.one(parent, name)
    if (text === null) this.remove(old)
    else if (old) this.replace(old, text)
    else this.insert(parent, text, name, order)
  }

  /** The part with every change made, or undefined where there was none. */
  render(): string | undefined {
    for (const { el, text } of this.filled.values()) {
      const body = text.sort((x, y) => x.rank - y.rank).map((piece) => piece.text)
      this.splice(el.start, el.end, withBody(openTag(this.xml, el), el.name, body.join('')))
    }
    if (!this.splices.length) return undefined
    // Children added at one place stand in the schema's order, whatever order they were asked for in.
    const inOrder = (x: Splice & { rank?: number }, y: Splice & { rank?: number }) =>
      x.start - y.start || x.end - y.end || (x.rank ?? 0) - (y.rank ?? 0)
    try {
      return applySplices(this.xml, this.splices.sort(inOrder))
    } catch {
      throw new ChartsRefused(`${capital(this.label)} ${NOT_OURS}`)
    }
  }
}

export interface EditContext {
  tabs: readonly string[]
  cells: Draw['cells']
  date1904: boolean
}

/** Each series handed back and the series of the file it is: by `c:idx`, or with none given by place. */
function matched(old: ChartPlan, next: ChartPlan): Map<PlanSeries, PlanSeries> {
  const out = new Map<PlanSeries, PlanSeries>()
  if (!next.series.some((s) => s.index !== undefined)) {
    for (const [at, s] of next.series.entries()) if (old.series[at]) out.set(s, old.series[at])
    return out
  }
  const byIndex = new Map<number, PlanSeries>()
  for (const s of old.series)
    if (s.index !== undefined && !byIndex.has(s.index)) byIndex.set(s.index, s)
  const taken = new Set<PlanSeries>()
  for (const s of next.series) {
    const was = s.index === undefined ? undefined : byIndex.get(s.index)
    if (!was || taken.has(was)) continue
    taken.add(was)
    out.set(s, was)
  }
  // A series handed in with no identity is the next of the file's that nothing claimed: so a
  // series the canvas made, saved, and still holds as it made it is that series, not a new one.
  const spare = old.series.filter((s) => !taken.has(s))
  for (const s of next.series) if (s.index === undefined && spare.length) out.set(s, spare.shift()!)
  return out
}

/** Each group handed back and the file's group it still is; undefined where the groups themselves changed. */
function sameGroups(old: ChartPlan, next: ChartPlan, was: Map<PlanSeries, PlanSeries>) {
  const pairs = new Map<PlanGroup, PlanGroup>()
  for (const group of next.groups) {
    const source = old.groups.find(
      (g) =>
        g.from !== undefined &&
        g.from === group.from &&
        g.kind === group.kind &&
        g.other === group.other &&
        g.secondAxis === group.secondAxis
    )
    if (!source) return undefined
    for (const s of group.series) {
      const before = was.get(s)
      if (before && !source.series.includes(before)) return undefined
    }
    pairs.set(group, source)
  }
  return pairs.size === old.groups.length ? pairs : undefined
}

const softly = <T>(next: T | undefined, old: T | undefined) => next !== undefined && next !== old

interface Located {
  chart?: ElementSpan
  plot?: ElementSpan
  groups: ElementSpan[]
  axes: ElementSpan[]
  /** The file's series in the reader's order: by `c:order`, then as written. */
  series: ElementSpan[]
  /** Every `c:idx` a series holds. */
  used: Set<number>
}

function locate(doc: Doc): Located {
  const chart = doc.one(doc.root, 'chart')
  const plot = doc.one(chart, 'plotArea')
  const inside = plot ? doc.kids(plot) : []
  const groups = inside.filter((el) => local(el.name).endsWith('Chart'))
  const axes = inside.filter((el) => /^(cat|val|date|ser)Ax$/.test(local(el.name)))
  const whole = (el: ElementSpan | undefined) => {
    const value = doc.val(el)
    return value !== undefined && /^\s*\d{1,15}\s*$/.test(value) ? Number(value) : undefined
  }
  const series = groups
    .flatMap((group) => doc.all(group, 'ser'))
    .map((el, at) => ({ el, at, order: whole(doc.one(el, 'order')) ?? Infinity }))
    .sort((x, y) => x.order - y.order || x.at - y.at)
    .map(({ el }) => el)
  const used = new Set(series.flatMap((el) => whole(doc.one(el, 'idx')) ?? []))
  return { chart, plot, groups, axes, series, used }
}

interface Work {
  doc: Doc
  at: Located
  old: ChartPlan
  next: ChartPlan
  was: Map<PlanSeries, PlanSeries>
  draw: Draw
}

/** A piece of the file's chart that a change needs: refused where the part does not have it. */
function need<T>(work: Work, el: T | undefined): T {
  if (el === undefined) throw new ChartsRefused(`${capital(work.next.label)} ${NOT_OURS}`)
  return el
}

/**
 * The chart part as the spec handed back leaves it, or undefined where the spec the file gave
 * and the spec handed back do not differ in anything written.
 */
export function editChart(
  xml: string,
  source: ChartSpec,
  spec: ChartSpec,
  context: EditContext
): string | undefined {
  const old = planOf(source, context.tabs)
  const next = planOf(spec, context.tabs)
  const draw: Draw = { plan: next, cells: context.cells, date1904: context.date1904 }
  const was = matched(old, next)
  const pairs = sameGroups(old, next, was)
  const open = (): Work => {
    const doc = new Doc(xml, next.label)
    const work = { doc, at: locate(doc), old, next, was, draw }
    captioned(work)
    return work
  }
  if (pairs) {
    const work = open()
    try {
      rescaled(work)
      for (const [group, before] of pairs) regroup(work, group, before)
      return work.doc.render()
    } catch (err) {
      // A piece that cannot be placed: start again and write the plot area whole.
      if (!(err instanceof Afresh)) throw err
    }
  }
  if (source.flags?.pivot || source.flags?.threeD || source.kind === 'other') {
    const what = source.flags?.pivot
      ? 'a pivot chart'
      : source.flags?.threeD
        ? 'a 3D chart'
        : 'a kind this editor does not draw'
    throw new ChartsRefused(
      `${capital(next.label)} is ${what}: change its kind and its series in Excel.`
    )
  }
  checkedPlan(next)
  const work = open()
  const { doc, at } = work
  const targets = [...at.groups, ...at.axes].sort((x, y) => x.start - y.start)
  const plot = plotXml(next, draw)
  if (!targets.length) doc.insert(need(work, at.plot), plot, 'areaChart', PLOT)
  for (const [k, el] of targets.entries()) k ? doc.remove(el) : doc.replace(el, plot)
  return doc.render()
}

/** The chart's title and legend, as the plan has them. */
function captioned(work: Work) {
  const { doc, at, old, next, draw } = work
  if (
    titleKey(next.title, next.autoTitle) !== titleKey(old.title, old.autoTitle) ||
    next.series.length !== old.series.length
  )
    titled(doc, need(work, at.chart), next, draw)
  if (next.legend === old.legend) return
  const chart = need(work, at.chart)
  const legend = doc.one(chart, 'legend')
  if (next.legend === null) doc.remove(legend)
  else if (legend)
    doc.put(legend, 'legendPos', `<c:legendPos val="${LEGEND_POS[next.legend]}"/>`, LEGEND)
  else doc.insert(chart, legendXml(next.legend), 'legend', CHART)
}

/** Each axis the file has and the spec still names: its title, format, bounds, direction and hiding. */
function rescaled(work: Work) {
  const { doc, at, old, next, draw } = work
  for (const role of AXIS_ROLES) {
    const axis = next.axes[role]
    const before = old.axes[role]
    if (!axis || !before) continue
    const format =
      axis.numberFormat !== undefined &&
      (axis.numberFormat !== before.numberFormat ||
        softly(axis.formatLinked, before.formatLinked ?? false))
    const turned = softly(axis.reversed, before.reversed ?? false)
    const hidden = softly(axis.hidden, before.hidden ?? false)
    const title = !sameText(axis.title, before.title)
    const bounds = (['min', 'max', 'logBase'] as const).filter((name) =>
      softly(axis[name], before[name])
    )
    if (!format && !turned && !hidden && !title && !bounds.length) continue
    const el = at.axes.find((candidate) => doc.val(doc.one(candidate, 'axId')) === before.id)
    if (!el) throw new Afresh()
    if (title) {
      const side = doc.val(doc.one(el, 'axPos'))
      entitle(doc, el, axis.title, side === 'l' || side === 'r' ? 'upright' : 'axis', AXIS, draw)
    }
    if (format) doc.put(el, 'numFmt', numFmtXml(axis), AXIS)
    if (hidden) doc.put(el, 'delete', `<c:delete val="${axis.hidden ? 1 : 0}"/>`, AXIS)
    if (!turned && !bounds.length) continue
    const scaling = doc.one(el, 'scaling')
    if (!scaling) throw new Afresh()
    if (turned)
      doc.put(
        scaling,
        'orientation',
        `<c:orientation val="${axis.reversed ? 'maxMin' : 'minMax'}"/>`,
        SCALING
      )
    for (const name of bounds) doc.put(scaling, name, `<c:${name} val="${axis[name]}"/>`, SCALING)
  }
}

function changed(s: PlanSeries, before: PlanSeries): boolean {
  return (
    !sameText(s.name, before.name) ||
    !sameData(s.categories, before.categories) ||
    !sameData(s.values, before.values) ||
    !sameColour(s.colour, before.colour) ||
    pointsChanged(s, before).length > 0 ||
    softly(s.line, before.line) ||
    softly(s.smooth, before.smooth ?? false) ||
    softly(s.marker, before.marker)
  )
}

function pointsChanged(s: PlanSeries, before: PlanSeries): number[] {
  const points = new Set(
    [...Object.keys(s.pointColours ?? {}), ...Object.keys(before.pointColours ?? {})].map(Number)
  )
  return [...points]
    .filter((p) => !sameColour(s.pointColours?.[p], before.pointColours?.[p]))
    .sort((a, b) => a - b)
}

/** What a title's rich text keeps through a change of its words. */
function keptText(doc: Doc, title: ElementSpan): KeptText | undefined {
  const rich = doc.one(doc.one(title, 'tx'), 'rich')
  if (!rich) return undefined
  const paragraph = doc.one(rich, 'p')
  const run = doc.one(paragraph, 'r')
  const text = (el: ElementSpan | undefined) => (el ? doc.text(el) : undefined)
  const head = [doc.one(rich, 'bodyPr'), doc.one(rich, 'lstStyle')]
    .map((el) => text(el) ?? '')
    .join('')
  return {
    body: head || undefined,
    pPr: text(doc.one(paragraph, 'pPr')),
    rPr: text(doc.one(run, 'rPr'))
  }
}

/** Sets or removes the title of a chart or an axis; a title that stays keeps its look. */
function entitle(
  doc: Doc,
  parent: ElementSpan,
  title: PlanText | undefined,
  role: TitleRole,
  order: readonly string[],
  draw: Draw
) {
  const old = doc.one(parent, 'title')
  if (!title) return doc.remove(old)
  if (!old) return doc.insert(parent, titleXml(title, role, draw), 'title', order)
  const [size, rot] = role === 'chart' ? [1400, 0] : role === 'axis' ? [1000, 0] : [1000, -5400000]
  doc.put(old, 'tx', titleTx(title, size, rot, draw, keptText(doc, old)), TITLE)
}

/** Leaves the chart's title as the plan has it: words, a cell's, Excel's own, or none. */
function titled(doc: Doc, chart: ElementSpan, next: ChartPlan, draw: Draw) {
  const old = doc.one(chart, 'title')
  const deleted = doc.on(doc.one(chart, 'autoTitleDeleted')) === true
  const flag = (on: boolean) =>
    doc.put(chart, 'autoTitleDeleted', `<c:autoTitleDeleted val="${on ? 1 : 0}"/>`, CHART)
  if (next.title) {
    entitle(doc, chart, next.title, 'chart', CHART, draw)
    if (deleted) flag(false)
  } else if (next.autoTitle) {
    if (old) doc.remove(doc.one(old, 'tx'))
    else if (deleted || next.series.length !== 1) {
      doc.insert(chart, titleXml(undefined, 'chart', draw), 'title', CHART)
      flag(false)
    }
  } else {
    doc.remove(old)
    if (!deleted) flag(true)
  }
}

/** One group changed in place: its grouping and gaps, and each of its series. Nothing is read where nothing differs. */
function regroup(work: Work, group: PlanGroup, before: PlanGroup) {
  const { doc, at, old, next, was, draw } = work
  const bars = group.kind === 'column' || group.kind === 'bar'
  const grouping = group.grouping !== before.grouping
  const overlap =
    bars && !grouping && group.grouping === 'clustered' && softly(group.overlap, before.overlap)
  const gap = bars && softly(group.gapWidth, before.gapWidth)
  const hole = group.kind === 'doughnut' && softly(group.holeSize, before.holeSize)
  const vary = softly(group.varyColours, before.varyColours)
  const reorder =
    next.series.length !== old.series.length ||
    next.series.some((s, k) => was.get(s) !== old.series[k])
  const stays = new Set(group.series.map((s) => was.get(s)))
  const gone = before.series.filter((s) => !stays.has(s))
  if (
    !grouping &&
    !overlap &&
    !gap &&
    !hole &&
    !vary &&
    !reorder &&
    !gone.length &&
    group.series.every((s) => !changed(s, was.get(s)!))
  )
    return
  const el = at.groups[before.from ?? -1]
  if (!el) throw new Afresh()
  // A group drawn some other way (a radar, a 3D bar) keeps its own settings and its own series list.
  const native = local(el.name) === ELEMENT[group.kind]
  const added = group.series.some((s) => !was.has(s))
  if (!native && (grouping || overlap || gap || hole || added)) throw new Afresh()
  if (grouping) {
    doc.put(el, 'grouping', `<c:grouping val="${GROUPING[group.grouping]}"/>`, GROUP)
    // Bars that stop stacking no longer sit one on another.
    if (bars) doc.put(el, 'overlap', `<c:overlap val="${overlapOf(group)}"/>`, GROUP)
  }
  if (overlap) doc.put(el, 'overlap', `<c:overlap val="${group.overlap}"/>`, GROUP)
  if (gap) doc.put(el, 'gapWidth', `<c:gapWidth val="${group.gapWidth}"/>`, GROUP)
  if (hole) doc.put(el, 'holeSize', `<c:holeSize val="${group.holeSize}"/>`, GROUP)
  if (vary) doc.put(el, 'varyColors', `<c:varyColors val="${group.varyColours ? 1 : 0}"/>`, GROUP)

  const style =
    group.kind === 'scatter' ? (doc.val(doc.one(el, 'scatterStyle')) ?? 'marker') : undefined
  for (const s of gone) doc.remove(need(work, at.series[s.at]))
  for (const s of group.series) {
    const source = was.get(s)
    if (!source) {
      checkedSeries(s, next)
      // Its own identity where that is free, else the lowest that is.
      let idx = s.index ?? 0
      while (at.used.has(idx)) idx = idx === s.index ? 0 : idx + 1
      at.used.add(idx)
      doc.insert(el, seriesXml(group.kind, s, idx, draw), 'ser', GROUP)
      continue
    }
    const ser = need(work, at.series[source.at])
    if (reorder) doc.put(ser, 'order', `<c:order val="${s.at}"/>`, SER)
    if (changed(s, source)) reseries(doc, ser, group.kind, s, source, style, draw)
  }
}

/** A cache the canvas handed back unchanged beside a range it changed is stale: the cells are read instead. */
const fresh = (data: PlanData, before: PlanData | undefined): PlanData =>
  data.ref && data.cache && JSON.stringify(data.cache) === JSON.stringify(before?.cache)
    ? { ...data, cache: undefined }
    : data

function reseries(
  doc: Doc,
  ser: ElementSpan,
  kind: SeriesKind,
  s: PlanSeries,
  before: PlanSeries,
  style: string | undefined,
  draw: Draw
) {
  checkedSeries(s, draw.plan)
  const scatter = kind === 'scatter'
  if (!sameText(s.name, before.name)) doc.put(ser, 'tx', s.name ? nameXml(s.name, draw) : null, SER)
  if (!sameData(s.categories, before.categories)) {
    const tag = scatter ? 'xVal' : 'cat'
    doc.put(
      ser,
      tag,
      s.categories ? dataXml(tag, fresh(s.categories, before.categories), draw) : null,
      SER
    )
  }
  if (!sameData(s.values, before.values)) {
    const tag = scatter ? 'yVal' : 'val'
    doc.put(ser, tag, dataXml(tag, fresh(s.values, before.values), draw), SER)
  }
  const stroked = kind === 'line' || scatter
  const colour = !sameColour(s.colour, before.colour)
  const line = stroked && softly(s.line, before.line)
  const marker = stroked && softly(s.marker, before.marker)
  // A scatter group drawn by its style alone has no line or marker of a series' own to set.
  if (
    (line || marker || (stroked && softly(s.smooth, before.smooth ?? false))) &&
    scatter &&
    style !== 'lineMarker' &&
    style !== 'smoothMarker'
  )
    throw new Afresh()
  if (stroked && softly(s.smooth, before.smooth ?? false))
    doc.put(ser, 'smooth', `<c:smooth val="${s.smooth ? 1 : 0}"/>`, SER)
  if (colour || line || marker) {
    if (!stroked) paint(doc, ser, s.colour, SER)
    else {
      const shown = s.line ?? before.line ?? kind === 'line'
      const marked = s.marker ?? before.marker ?? (scatter || !shown)
      stroke(doc, ser, kind, shown, s.colour, SER)
      const old = doc.one(ser, 'marker')
      const drawn = old ? doc.val(doc.one(old, 'symbol')) !== 'none' : undefined
      if (!old || drawn !== marked) {
        if (old || marked || marker) doc.put(ser, 'marker', markerXml(marked, s.colour), SER)
      } else if (colour && marked) {
        const shape = doc.one(old, 'spPr')
        if (!shape) {
          if (s.colour) doc.insert(old, `<c:spPr>${fillXml(s.colour)}</c:spPr>`, 'spPr', MARKER)
        } else {
          refill(doc, shape, s.colour, SHAPE)
          const edge = doc.one(shape, 'ln')
          if (edge && !doc.one(edge, 'noFill')) refill(doc, edge, s.colour, LINE)
        }
      }
    }
  }
  for (const point of pointsChanged(s, before)) {
    const tint = s.pointColours?.[point]
    const dPt = doc.all(ser, 'dPt').find((el) => doc.val(doc.one(el, 'idx')) === String(point))
    if (!dPt) {
      if (tint) doc.insert(ser, pointXml(kind, point, tint), 'dPt', SER)
    } else if (scatter) {
      const mark = doc.one(dPt, 'marker')
      const shape = doc.one(mark, 'spPr')
      if (shape) refill(doc, shape, tint, SHAPE)
      else if (tint) doc.put(dPt, 'marker', markerXml(true, tint), POINT)
    } else if (kind === 'line') stroke(doc, dPt, kind, true, tint, POINT)
    else paint(doc, dPt, tint, POINT)
  }
}

/** The fill of a shape or a line: set, or taken away so Excel picks it. Another kind of fill gives way to a colour. */
function refill(
  doc: Doc,
  holder: ElementSpan,
  colour: ChartColour | undefined,
  order: readonly string[]
) {
  const old = doc.kids(holder).find((kid) => FILLS.has(local(kid.name)))
  if (colour)
    old
      ? doc.replace(old, fillXml(colour))
      : doc.insert(holder, fillXml(colour), 'solidFill', order)
  else if (old && local(old.name) === 'solidFill') doc.remove(old)
}

/** The fill of a bar, an area or a slice. */
function paint(
  doc: Doc,
  parent: ElementSpan,
  colour: ChartColour | undefined,
  order: readonly string[]
) {
  const shape = doc.one(parent, 'spPr')
  if (shape) refill(doc, shape, colour, SHAPE)
  else if (colour) doc.insert(parent, `<c:spPr>${fillXml(colour)}</c:spPr>`, 'spPr', order)
}

/** The line of a line or scatter series: shown in its colour, shown as Excel picks, or hidden. */
function stroke(
  doc: Doc,
  parent: ElementSpan,
  kind: SeriesKind,
  shown: boolean,
  colour: ChartColour | undefined,
  order: readonly string[]
) {
  const shape = doc.one(parent, 'spPr')
  const line = doc.one(shape, 'ln')
  if (!shape) {
    if (colour || !shown)
      doc.insert(parent, `<c:spPr>${strokeXml(kind, shown, colour)}</c:spPr>`, 'spPr', order)
  } else if (!line) {
    if (colour || !shown) doc.insert(shape, strokeXml(kind, shown, colour), 'ln', SHAPE)
  } else if (!shown) {
    const old = doc.kids(line).find((kid) => FILLS.has(local(kid.name)))
    old ? doc.replace(old, '<a:noFill/>') : doc.insert(line, '<a:noFill/>', 'noFill', LINE)
  } else if (colour) refill(doc, line, colour, LINE)
  else {
    const old = doc.kids(line).find((kid) => FILLS.has(local(kid.name)))
    if (old && (local(old.name) === 'solidFill' || local(old.name) === 'noFill')) doc.remove(old)
  }
}
