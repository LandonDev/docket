import { FormatRefused } from './format-xml'
import { parseAttrs, setAttrInTag, unesc } from './xml'

/**
 * The tabs' order in workbook.xml (a tab dragged on the grid, `sheet.mutation.set-worksheet-order`): `<sheets>` takes the
 * new order, and what counts the sheets by place follows its sheet, so it names the same one after: a defined name's
 * `localSheetId` (a print area, a name kept to one sheet) and the window's `activeTab` and `firstSheet`. A move's index
 * counts the worksheets alone, as the grid's order does (a chartsheet has no tab there); a chartsheet keeps its place.
 * Each sheet's `sheetId` and part are untouched.
 */

export interface SheetMove {
  /** the worksheet's name */
  sheet: string
  /** its place among the worksheets, from 0 */
  to: number
}

const SHEET = (P: string) => new RegExp(`<${P}sheet(?=[\\s>/])[^>]*?(?:/>|>\\s*</${P}sheet\\s*>)`, 'g')

/** The workbook part with its sheets in their new order; the same text when nothing moved. `worksheet(i)` says whether the i-th `<sheet>` is a worksheet. */
export function reorderSheets(xml: string, P: string, moves: readonly SheetMove[], worksheet: (index: number) => boolean): string {
  const open = new RegExp(`<${P}sheets(?=[\\s>])[^>]*>`).exec(xml)
  const close = open ? xml.indexOf(`</${P}sheets>`, open.index) : -1
  if (!open || close < 0) throw new FormatRefused('The workbook lists no sheets.')
  const bodyStart = open.index + open[0].length
  const tags: { text: string; start: number; end: number; name: string }[] = []
  for (const m of xml.slice(bodyStart, close).matchAll(SHEET(P))) {
    const name = parseAttrs(m[0].replace(/^<[^\s>/]+/, '').replace(/\/?>[\s\S]*$/, '')).find((a) => a.name === 'name')?.value ?? ''
    tags.push({ text: m[0], start: bodyStart + m.index!, end: bodyStart + m.index! + m[0].length, name })
  }
  const names = tags.map((t) => unesc(t.name))
  const slots = names.map((_, i) => worksheet(i))
  let order = names.filter((_, i) => slots[i])
  for (const move of moves) {
    if (!order.includes(move.sheet)) throw new FormatRefused(`No worksheet named “${move.sheet}”.`)
    order = order.filter((n) => n !== move.sheet)
    order.splice(Math.max(0, Math.min(order.length, move.to)), 0, move.sheet)
  }
  let next = 0
  const after = names.map((name, i) => (slots[i] ? order[next++]! : name))
  if (after.every((name, i) => name === names[i])) return xml
  // Where each sheet stood, and where it stands now.
  const moved = new Map(names.map((name, i) => [i, after.indexOf(name)]))
  const byName = new Map(names.map((name, i) => [name, tags[i]!.text]))
  let out = ''
  let at = 0
  tags.forEach((tag, i) => {
    out += xml.slice(at, tag.start) + byName.get(after[i]!)!
    at = tag.end
  })
  out += xml.slice(at)
  const place = (value: string | undefined) => {
    const n = Number(value)
    return Number.isInteger(n) && moved.has(n) ? String(moved.get(n)) : value
  }
  // A name kept to one sheet, by its place.
  out = out.replace(new RegExp(`<${P}definedName(?=[\\s>])[^>]*>`, 'g'), (tag) => {
    const id = /\slocalSheetId\s*=\s*"(\d+)"/.exec(tag)?.[1]
    return id === undefined ? tag : setAttrInTag(tag, 'localSheetId', place(id)!)
  })
  // The window's tab in hand and its first tab shown.
  out = out.replace(new RegExp(`<${P}workbookView(?=[\\s>/])[^>]*>`, 'g'), (tag) => {
    let next = tag
    for (const key of ['activeTab', 'firstSheet']) {
      const value = new RegExp(`\\s${key}\\s*=\\s*"(\\d+)"`).exec(next)?.[1]
      if (value !== undefined) next = setAttrInTag(next, key, place(value)!)
    }
    return next
  })
  return out
}
