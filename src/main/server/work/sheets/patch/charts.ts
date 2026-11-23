// Charts written into an Excel file as real parts. An edit is the complete chart list of one
// tab, each chart the kit's ChartSpec as the canvas hands it back: a chart the tab has is moved,
// sized or changed in place, one it does not have is written as a new chart part with its anchor,
// relationship and content type, and one the list leaves out goes with its parts. A chart the
// list hands back as it was read costs nothing: no part of it is rewritten.
import { readObjects, type ChartSpec } from 'work-kit/sheet/xlsx'
import { cellReader } from './charts-cache'
import { editChart, type EditContext } from './charts-edit'
import { capital, ChartsRefused, checkedPlan, MAX_CHARTS, planOf } from './charts-model'
import { CHART_TYPE, chartXml } from './charts-xml'
import {
  A_NS,
  anchorMoved,
  C_NS,
  DOC_REL,
  ObjectsRefused,
  PackageEdit,
  Rels,
  SheetDrawing,
  type AnchorSlot,
  type PackageReport
} from './drawings'
import { workbookMap } from './patch'
import { RulesRefused } from './rules-xml'
import { readZip } from './zip'

export { ChartsRefused } from './charts-model'

export interface ChartsEdit {
  kind: 'charts'
  /** The tab's name: a worksheet, or a chart sheet for a change to its one chart. */
  sheet: string
  /** The complete chart list for this tab. */
  charts: readonly ChartSpec[]
}

export interface ChartsReport extends PackageReport {
  /** Each id handed in and the id the file now has for that chart: its part's name. */
  ids: Record<string, string>
}

export interface ReadChartsResult {
  sheets: Record<string, { charts: ChartSpec[] }>
  /** What the reader left out or cut short, in plain words. */
  warnings: string[]
}

const drawable = (kind: string) => kind === 'worksheet' || kind === 'chartsheet'
/** What a chart's own relationships may point at for it to be removed with them. */
const OWN_PARTS = /\/(chartStyle|chartColorStyle|themeOverride|image)$/

/** Every tab's charts, as the kit's reader reads them: the list an edit hands back. */
export function readCharts(bytes: Uint8Array, sheet?: string): ReadChartsResult {
  const tabs = workbookMap(readZip(bytes)).sheets.filter(
    (tab) => drawable(tab.kind) && (sheet === undefined || tab.name === sheet)
  )
  if (sheet !== undefined && !tabs.length) throw new ChartsRefused(`No sheet named “${sheet}”.`)
  const read = readObjects(bytes)
  const sheets: ReadChartsResult['sheets'] = Object.create(null)
  for (const tab of tabs)
    sheets[tab.name] = { charts: read.charts.filter((chart) => chart.sheet === tab.name) }
  return { sheets, warnings: read.warnings }
}

const frameXml = (p: string, shape: { id: number; name: string }, rid: string) =>
  `<${p}graphicFrame xmlns:a="${A_NS}" macro=""><${p}nvGraphicFramePr><${p}cNvPr id="${shape.id}" name="${shape.name}"/>` +
  `<${p}cNvGraphicFramePr/></${p}nvGraphicFramePr><${p}xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></${p}xfrm>` +
  `<a:graphic><a:graphicData uri="${C_NS}"><c:chart xmlns:c="${C_NS}" xmlns:r="${DOC_REL}" r:id="${rid}"/></a:graphicData></a:graphic>` +
  `</${p}graphicFrame>`

/** Removes a chart's anchor and relationship, and its part with the parts it alone holds. */
function removeChart(edit: PackageEdit, drawing: SheetDrawing, slot: AnchorSlot, label: string) {
  const { rid, target } = slot.refs[0]
  const rels = drawing.links()
  drawing.remove(slot)
  rels.drop(rid)
  if (!target || edit.referenced(target, new Set([rels.path]))) return
  const own = new Rels(edit, target)
  for (const rel of own.list) {
    if (rel.external || !edit.has(rel.target)) continue
    if (!OWN_PARTS.test(rel.type))
      throw new ChartsRefused(`${label} keeps other parts of the file with it: remove it in Excel.`)
    if (!edit.referenced(rel.target, new Set([own.path]))) edit.remove(rel.target)
  }
  if (edit.has(own.path)) edit.remove(own.path)
  edit.remove(target)
}

/** Change only the package parts required to write the supplied chart lists. */
export function patchCharts(
  bytes: Uint8Array,
  edits: readonly ChartsEdit[]
): { bytes: Uint8Array; report: ChartsReport } {
  try {
    return patch(bytes, edits)
  } catch (err) {
    // One class for every refusal of this writer, whichever layer under it said no.
    if (
      (err instanceof ObjectsRefused || err instanceof RulesRefused) &&
      !(err instanceof ChartsRefused)
    )
      throw new ChartsRefused(err.message)
    throw err
  }
}

function patch(
  bytes: Uint8Array,
  edits: readonly ChartsEdit[]
): { bytes: Uint8Array; report: ChartsReport } {
  const ids: ChartsReport['ids'] = Object.create(null)
  if (!edits.length)
    return { bytes, report: { partsChanged: [], partsAdded: [], partsRemoved: [], ids } }
  const edit = new PackageEdit(bytes)
  const read = readObjects(bytes)
  const context: EditContext = {
    tabs: edit.tabs.map((tab) => tab.name),
    cells: cellReader(edit),
    date1904: /<(?:[\w.-]+:)?workbookPr\b[^>]*\sdate1904\s*=\s*["'](?:1|true)["']/.test(
      edit.book.wbXml
    )
  }
  const drawn = new Map<string, number>()
  const partOf = (id: string) => id.replace(/#\d+$/, '')
  for (const chart of read.charts)
    drawn.set(partOf(chart.id), (drawn.get(partOf(chart.id)) ?? 0) + 1)
  const edited = new Set<string>()
  let total = read.charts.length

  for (const { sheet, charts } of edits) {
    const tab = edit.tab(sheet)
    if (!tab || !drawable(tab.kind)) throw new ChartsRefused(`No sheet named “${sheet}”.`)
    if (edited.has(sheet)) throw new ChartsRefused(`Give one complete chart list for “${sheet}”.`)
    edited.add(sheet)
    const chartsheet = tab.kind === 'chartsheet'
    const existing = new Map(
      read.charts.filter((chart) => chart.sheet === sheet).map((chart) => [chart.id, chart])
    )
    const listed = new Set<string>()
    for (const spec of charts) {
      if (typeof spec?.id !== 'string' || !spec.id || listed.has(spec.id))
        throw new ChartsRefused(
          `The chart list for “${sheet}” repeats a chart or holds one with no id.`
        )
      listed.add(spec.id)
    }
    let drawing: SheetDrawing | undefined
    // The sheet is read, and its lock checked, only once something of its charts changes.
    const open = () => {
      if (!drawing) {
        drawing = new SheetDrawing(edit, tab)
        drawing.guard()
      }
      return drawing
    }
    const label = (chart: ChartSpec) => planOf(chart, context.tabs).label
    const slotOf = (old: ChartSpec) => {
      const slot = open().slotOf('chart', old.id, old.anchor, old.frame)
      if (!slot)
        throw new ChartsRefused(
          `${capital(label(old))} is part of a group, or sits in a drawing this editor cannot change: move, size or remove it in Excel.`
        )
      return slot
    }

    for (const spec of charts) {
      const old = existing.get(spec.id)
      if (!old) continue
      ids[spec.id] = old.id
      if (anchorMoved(spec.anchor, old.anchor)) {
        if (chartsheet)
          throw new ChartsRefused(
            `The chart of “${sheet}” fills its chart sheet: it has no place to move to.`
          )
        open().move(slotOf(old), spec.anchor)
      }
      const part = partOf(old.id)
      const xml = editChart(edit.text(part), old, spec, context)
      if (xml === undefined) continue
      if ((drawn.get(part) ?? 0) > 1)
        throw new ChartsRefused(
          `${capital(label(old))} is drawn in more than one place: change it in Excel.`
        )
      open()
      edit.set(part, xml)
    }
    for (const [id, old] of existing) {
      if (listed.has(id)) continue
      if (chartsheet)
        throw new ChartsRefused(`“${sheet}” is a chart sheet: remove the sheet itself in Excel.`)
      removeChart(edit, open(), slotOf(old), capital(label(old)))
      total--
    }
    for (const spec of charts) {
      if (existing.has(spec.id)) continue
      if (chartsheet)
        throw new ChartsRefused(
          `“${sheet}” is a chart sheet and holds one chart: add the chart to a worksheet.`
        )
      if (spec.kind === 'other' || spec.flags?.pivot)
        throw new ChartsRefused(
          `This editor cannot make a ${spec.flags?.pivot ? 'pivot' : (spec.otherKind ?? 'new')} chart: make it in Excel.`
        )
      const plan = checkedPlan(planOf(spec, context.tabs))
      if (spec.frame)
        throw new ChartsRefused(`${capital(plan.label)} cannot be made inside a group.`)
      if (++total > MAX_CHARTS)
        throw new ChartsRefused(`Save at most ${MAX_CHARTS} charts per workbook.`)
      const target = open()
      const part = edit.free('xl/charts/chart', '.xml')
      const rid = target.links().add('chart', part)
      target.add(spec.anchor, frameXml(target.prefix, target.shape('Chart'), rid))
      edit.add(part, chartXml(plan, { plan, cells: context.cells, date1904: context.date1904 }), {
        override: CHART_TYPE
      })
      ids[spec.id] = part
    }
    drawing?.flush()
  }
  const out = edit.finish()
  return { bytes: out.bytes, report: { ...out.report, ids } }
}
