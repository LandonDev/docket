// The values a chart's ranges hold now, read from the workbook's own cells, so a chart written
// here carries a cache a viewer can draw from before Excel has opened the file. Only what is
// cheap is read: a plain range of up to 100,000 cells on a sheet of ordinary size; anything else
// gets no cache, and Excel fills it when it opens the file.
import { MAX_POINTS, type Area, type PlanRef } from './charts-model'
import type { PackageEdit } from './drawings'
import { xunescape } from './rules-xml'
import { sharedText } from './tables-cells'
import { parseRef, rootPrefix } from './xml'

type Value = string | number | null
const MAX_SHEET = 32 * 1024 * 1024
const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`)
const R = attribute('r')
const T = attribute('t')

/** One area's cells in reading order, a hole where a cell is empty or holds an error. */
function areaValues(
  xml: string,
  area: Area,
  shared: (index: number) => string | undefined
): Value[] | undefined {
  if (xml.length > MAX_SHEET) return undefined
  const width = area.c2 - area.c1 + 1
  const out = new Array<Value>((area.r2 - area.r1 + 1) * width).fill(null)
  const P = rootPrefix(xml, 'worksheet')
  const start = xml.indexOf(`<${P}sheetData`)
  if (start < 0) return out
  const end = xml.indexOf(`</${P}sheetData>`, start)
  const cell = new RegExp(`<${P}c(?=[\\s>/])([^>]*?)(/?)>`, 'g')
  const value = new RegExp(`<${P}v(?:\\s[^>]*)?>([\\s\\S]*?)</${P}v>`)
  const run = new RegExp(`<${P}t(?:\\s[^>]*)?>([\\s\\S]*?)</${P}t>`, 'g')
  const close = `</${P}c>`
  cell.lastIndex = start
  let m: RegExpExecArray | null
  while ((m = cell.exec(xml)) && (end < 0 || m.index < end)) {
    if (m[2] === '/') continue
    const stop = xml.indexOf(close, cell.lastIndex)
    if (stop < 0) break
    const inner = xml.slice(cell.lastIndex, stop)
    cell.lastIndex = stop + close.length
    const name = R.exec(m[1])?.[1]
    if (!name) continue
    let at: { row: number; col: number }
    try {
      at = parseRef(name)
    } catch {
      continue
    }
    // Rows come in order: past the area's last row there is nothing more to read.
    if (at.row > area.r2) break
    if (at.row < area.r1 || at.col < area.c1 || at.col > area.c2) continue
    const type = T.exec(m[1])?.[1]
    const v = value.exec(inner)?.[1]
    let read: Value = null
    if (type === 'inlineStr') read = [...inner.matchAll(run)].map((t) => xunescape(t[1])).join('')
    else if (v === undefined || type === 'e' || type === 'd') read = null
    else if (type === 's') read = shared(Number(v)) ?? null
    else if (type === 'str') read = xunescape(v)
    else if (type === 'b') read = v.trim() === '1' ? 1 : 0
    else if (v.trim() !== '' && Number.isFinite(Number(v))) read = Number(v)
    out[(at.row - area.r1) * width + (at.col - area.c1)] = read
  }
  return out
}

/** A reader of ranges over the package as this patch leaves it; each range is read once. */
export function cellReader(edit: PackageEdit): (ref: PlanRef) => Value[] | undefined {
  const seen = new Map<string, Value[] | undefined>()
  const shared = sharedText(() => {
    const rel = edit.book.wbRels.rels.find((r) => !r.external && r.type.endsWith('/sharedStrings'))
    return rel && edit.has(rel.target) ? edit.text(rel.target) : undefined
  })
  const read = (areas: Area[]): Value[] | undefined => {
    const cells = areas.reduce((sum, a) => sum + (a.r2 - a.r1 + 1) * (a.c2 - a.c1 + 1), 0)
    if (cells > MAX_POINTS) return undefined
    const out: Value[] = []
    for (const area of areas) {
      const tab = edit.tab(area.sheet)
      if (tab?.kind !== 'worksheet' || !edit.has(tab.part)) return undefined
      let values: Value[] | undefined
      try {
        values = areaValues(edit.text(tab.part), area, shared)
      } catch {
        return undefined
      }
      if (!values) return undefined
      for (const value of values) out.push(value)
    }
    return out
  }
  return (ref) => {
    if (!ref.areas) return undefined
    const key = JSON.stringify(ref.areas)
    if (!seen.has(key)) seen.set(key, read(ref.areas))
    return seen.get(key)
  }
}
