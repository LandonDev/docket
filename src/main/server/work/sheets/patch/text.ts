// Rich text in a cell: the cell becomes a string cell whose shared string item holds one run for each
// change of style. Only the parts that must change are written; every other part keeps its bytes.
import { posix } from 'node:path'
import { independent } from './depends'
import {
  applySplices,
  children,
  documentRoot,
  isOn,
  openTag,
  valueOf,
  withBody,
  type ElementSpan
} from './format-xml'
import { dependsInput } from './package'
import { readRels, relsPath, workbookMap, type EditSpec } from './patch'
import { RulePart, SHEET_ORDER, STYLE_ORDER, inner, local, tag, xunescape } from './rules-xml'
import { arrayRanges, patchSheet, type Edit } from './sheet'
import { fullCalculation } from './tables-cells'
import { CONTENT_TYPES } from './tables-package'
import {
  checkedRuns,
  flat,
  literalKey,
  MAX_CELLS,
  readItem,
  readProps,
  renderItem,
  rich,
  runProps,
  shownKey,
  TextRefused,
  toRuns,
  type FileRun,
  type Props,
  type Run
} from './text-runs'
import { inBox, parseAttrs, parseRange, parseRef, refName, setAttrInTag, type Box } from './xml'
import { readEntry, readZip, writeZip, type Zip } from './zip'

export { TextRefused, type Run, type RunColour, type RunFont } from './text-runs'

export interface TextEdit {
  kind: 'text'
  /** the tab's name */
  sheet: string
  /** Rows and columns count from 0, as the grid's do. `runs: null` (or no text in them): a rich cell goes back to plain text. */
  cells: readonly { row: number; column: number; runs: readonly Run[] | null }[]
}
export interface TextOptions {
  /** deflate level for the parts that change */
  level?: number
}
export interface TextReport {
  partsChanged: string[]
  partsAdded: string[]
  partsRemoved: string[]
  /** A formula may read a cell whose words changed: Excel is asked to calculate again when it opens the file. */
  fullCalcOnLoad: boolean
}
export interface RichCell {
  sheet: string
  row: number
  column: number
  runs: Run[]
}

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const SST_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'

/** A fault in the file itself is told in words too, with what went wrong kept as the cause. */
function reading<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    if (err instanceof TextRefused) throw err
    throw new TextRefused('This file’s text could not be read. Change the text in Excel.', {
      cause: err
    })
  }
}

function openBook(bytes: Uint8Array) {
  const zip = readZip(bytes)
  const book = workbookMap(zip)
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  const texts = new Map<string, string>()
  const read = (part: string): string => {
    let text = texts.get(part)
    if (text === undefined) texts.set(part, (text = decoder.decode(readEntry(zip, part))))
    return text
  }
  const rel = (type: string) =>
    book.wbRels.rels.find((r) => !r.external && r.type.endsWith('/' + type))
  return { zip, book, read, rel }
}

/** The shared string table: an item read when a cell names it, an equal one found, a new one added at the end. */
class Strings {
  private root: ElementSpan
  readonly prefix: string
  private items: ElementSpan[]
  private read = new Map<number, ReturnType<typeof readItem>>()
  private keys?: Map<string, number>
  private added: string[] = []

  constructor(private xml: string) {
    const root = documentRoot(xml)
    if (!root || local(root.name) !== 'sst') throw new Error('no sst root')
    this.root = root
    this.prefix = root.name.slice(0, -3)
    this.items = [...children(xml, root)].filter((el) => local(el.name) === 'si')
  }

  get size() {
    return this.items.length
  }

  item(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return undefined
    let item = this.read.get(index)
    if (!item) this.read.set(index, (item = readItem(this.xml, this.items[index])))
    return item
  }

  /** The index of an item that is these runs and nothing more, added when there is none. */
  find(runs: readonly FileRun[]): number {
    if (!this.keys) {
      this.keys = new Map()
      for (let i = 0; i < this.items.length; i++) {
        const item = this.item(i)!
        if (!item.pure) continue
        const key = literalKey(item.runs)
        if (!this.keys.has(key)) this.keys.set(key, i)
      }
    }
    const key = literalKey(runs)
    let index = this.keys.get(key)
    if (index === undefined) {
      index = this.items.length + this.added.length
      this.added.push(`<${this.prefix}si>${renderItem(runs, this.prefix)}</${this.prefix}si>`)
      this.keys.set(key, index)
    }
    return index
  }

  /** `count` is how many cells name the table and `uniqueCount` how many items it has; each is kept where the file gives it. */
  render(cells: number): string {
    const { xml, root } = this
    let opening = openTag(xml, root)
    const count = valueOf(opening, 'count')
    const unique = valueOf(opening, 'uniqueCount')
    if (count !== undefined && cells)
      opening = setAttrInTag(opening, 'count', String(Math.max(0, Number(count) + cells)))
    if (unique !== undefined && this.added.length)
      opening = setAttrInTag(opening, 'uniqueCount', String(Number(unique) + this.added.length))
    const add = this.added.join('')
    if (root.openEnd === root.end)
      return applySplices(xml, [
        { start: root.start, end: root.end, text: withBody(opening, root.name, add) }
      ])
    return applySplices(xml, [
      { start: root.start, end: root.openEnd, text: opening },
      { start: root.close, end: root.close, text: add }
    ])
  }
}

/** Each cell's font by its style index, and the workbook's own text colour (its first font's), read from the styles part once. */
function cellFonts(xml: string | undefined) {
  let loaded: { xml: string; xfs: ElementSpan[]; fonts: ElementSpan[] } | null | undefined
  const fonts = new Map<number, Props | undefined>()
  const font = (id: number) => {
    if (!fonts.has(id)) {
      const el = loaded!.fonts[id]
      fonts.set(id, el && readProps(loaded!.xml, el))
    }
    return fonts.get(id)
  }
  const load = () => {
    if (loaded === undefined) {
      loaded = null
      if (xml) {
        const part = new RulePart(xml, 'styleSheet', STYLE_ORDER)
        const list = (name: string, item: string) => {
          const parent = part.first(name)
          return parent
            ? [...children(xml, parent)].filter((el) => el.name === part.prefix + item)
            : []
        }
        loaded = { xml, xfs: list('cellXfs', 'xf'), fonts: list('fonts', 'font') }
      }
    }
    return loaded
  }
  return {
    of(style: string | undefined): Props | undefined {
      const xf = load()?.xfs[Number(style ?? 0)]
      return xf && font(Number(valueOf(openTag(loaded!.xml, xf), 'fontId') ?? 0))
    },
    ink: () => (load() ? font(0)?.get('color') : undefined)
  }
}

interface Cell {
  type?: string
  style?: string
  formula: boolean
  value?: string
  inline?: ElementSpan
}

function* rowsOf(part: RulePart) {
  const data = part.first('sheetData')
  if (!data) return
  let r = 0
  for (const row of children(part.xml, data)) {
    if (row.name !== part.prefix + 'row') continue
    const opening = openTag(part.xml, row)
    r = Number(valueOf(opening, 'r') ?? r + 1)
    yield { r, row, opening }
  }
}

function* cellsOf(part: RulePart, row: ElementSpan) {
  const { xml, prefix } = part
  let c = 0
  for (const el of children(xml, row)) {
    if (el.name !== prefix + 'c') continue
    const opening = openTag(xml, el)
    const ref = valueOf(opening, 'r')
    c = ref ? parseRef(ref).col : c + 1
    const cell: Cell = { type: valueOf(opening, 't'), style: valueOf(opening, 's'), formula: false }
    for (const child of children(xml, el)) {
      if (child.name === prefix + 'f') cell.formula = true
      else if (child.name === prefix + 'v') cell.value = xunescape(inner(xml, child))
      else if (child.name === prefix + 'is') cell.inline = child
    }
    yield { c, cell }
  }
}

/** A column's default style, which a cell that is not in the file yet will take (as `patchSheet` gives it). */
function columnStyles(part: RulePart) {
  const cols = part.first('cols')
  const spans = cols
    ? [...children(part.xml, cols)].map((el) => {
        const opening = openTag(part.xml, el)
        return {
          min: Number(valueOf(opening, 'min')),
          max: Number(valueOf(opening, 'max')),
          style: valueOf(opening, 'style')
        }
      })
    : []
  return (col: number) => spans.find((span) => span.min <= col && col <= span.max)?.style
}

/** The header rows of the sheet's tables: a header's words are its column's name. */
function tableHeaders(zip: Zip, sheetPart: string, read: (part: string) => string) {
  const boxes: Box[] = []
  for (const rel of readRels(zip, sheetPart).rels) {
    if (rel.external || !rel.type.endsWith('/table') || !zip.byName.has(rel.target)) continue
    const opening = /<(?:[\w.-]+:)?table(?=[\s>])[^>]*>/.exec(read(rel.target))?.[0] ?? ''
    const ref = valueOf(opening, 'ref')
    if (!ref || valueOf(opening, 'headerRowCount') === '0') continue
    const box = parseRange(ref)
    boxes.push({ ...box, r2: box.r1 })
  }
  return (row: number, col: number) => boxes.some((box) => inBox(box, row, col))
}

type Want = { row: number; col: number; runs: Run[] | null }

function wanted(edits: readonly TextEdit[], tabs: Map<string, unknown>) {
  const bySheet = new Map<string, Map<string, Want>>()
  let count = 0
  for (const edit of edits) {
    if (!edit || edit.kind !== 'text' || !tabs.has(edit.sheet))
      throw new TextRefused(`No worksheet named “${String(edit?.sheet).slice(0, 60)}”.`)
    if (!Array.isArray(edit.cells)) throw new TextRefused('Give the cells whose text changes.')
    if ((count += edit.cells.length) > MAX_CELLS)
      throw new TextRefused('Change the text of at most 20,000 cells at once.')
    const cells = bySheet.get(edit.sheet) ?? new Map<string, Want>()
    bySheet.set(edit.sheet, cells)
    for (const cell of edit.cells) {
      const row = cell?.row + 1
      const col = cell?.column + 1
      if (
        !Number.isInteger(row) ||
        !Number.isInteger(col) ||
        row < 1 ||
        row > 1_048_576 ||
        col < 1 ||
        col > 16_384
      )
        throw new TextRefused('That cell is outside the worksheet.')
      const runs = cell.runs === null ? null : checkedRuns(cell.runs, refName(row, col))
      // The last word on a cell wins, as it does for a typed value.
      cells.set(`${row},${col}`, { row, col, runs })
    }
  }
  return bySheet
}

/** Write rich text into cells, changing only the parts that must change. */
export function patchText(
  bytes: Uint8Array,
  edits: readonly TextEdit[],
  options: TextOptions = {}
): { bytes: Uint8Array; report: TextReport } {
  const report: TextReport = {
    partsChanged: [],
    partsAdded: [],
    partsRemoved: [],
    fullCalcOnLoad: false
  }
  if (!edits.length) return { bytes, report }
  const { zip, book, read, rel } = reading(() => openBook(bytes))
  const tabs = new Map(
    book.sheets.filter((tab) => tab.kind === 'worksheet').map((tab) => [tab.name, tab])
  )
  const bySheet = wanted(edits, tabs)

  const stringsRel = rel('sharedStrings')
  let strings: Strings | undefined
  const table = () =>
    (strings ??= reading(
      () =>
        new Strings(
          stringsRel
            ? read(stringsRel.target)
            : DECL + `<sst xmlns="${namespace()}" count="0" uniqueCount="0"/>`
        )
    ))
  // A strict file names its own namespace: the new part speaks the workbook's.
  const namespace = () => {
    const opening = openTag(book.wbXml, documentRoot(book.wbXml)!)
    const name = book.P ? 'xmlns:' + book.P.slice(0, -1) : 'xmlns'
    return parseAttrs(opening).find((a) => a.name === name)?.value ?? ''
  }
  const styles = rel('styles')
  const fonts = cellFonts(styles && zip.byName.has(styles.target) ? read(styles.target) : undefined)

  const sheets = new Map<string, string>()
  const changedWords: EditSpec[] = []
  let cellsNamingTable = 0
  for (const [name, cells] of bySheet) {
    const path = tabs.get(name)!.part
    const xml = read(path)
    const {
      edits: writes,
      words,
      named
    } = reading(() => {
      const part = new RulePart(xml, 'worksheet', SHEET_ORDER)
      const rows = new Set([...cells.values()].map((cell) => cell.row))
      const last = Math.max(...rows)
      const found = new Map<string, Cell>()
      const rowStyle = new Map<number, string | undefined>()
      for (const { r, row, opening } of rowsOf(part)) {
        if (r > last) break
        if (!rows.has(r)) continue
        rowStyle.set(r, isOn(valueOf(opening, 'customFormat')) ? valueOf(opening, 's') : undefined)
        for (const { c, cell } of cellsOf(part, row))
          if (cells.has(`${r},${c}`)) found.set(`${r},${c}`, cell)
      }
      const columnStyle = columnStyles(part)
      const arrays = xml.includes('array') ? arrayRanges(xml, part.prefix) : []
      let headers: ReturnType<typeof tableHeaders> | undefined
      const out = { edits: [] as Edit[], words: [] as string[], named: 0 }
      for (const [key, { row, col, runs }] of cells) {
        const at = refName(row, col)
        const cell = found.get(key)
        const now =
          cell?.type === 's'
            ? table().item(Number(cell.value))
            : cell?.type === 'inlineStr' && cell.inline
              ? readItem(xml, cell.inline)
              : undefined
        let next: FileRun[]
        if (runs === null) {
          // Plain again: the same words in one run. A cell that is not rich is left as it is.
          if (!cell || cell.formula || !now || !rich(now.runs)) continue
          next = [{ text: flat(now.runs), props: null }]
        } else {
          if (cell?.formula || arrays.some(({ box }) => inBox(box, row, col)))
            throw new TextRefused(
              `${at} holds a formula, and a formula’s answer takes one style for the whole cell.`
            )
          const base = fonts.of(cell ? cell.style : (rowStyle.get(row) ?? columnStyle(col)))
          next = runs.map((run) => ({
            text: run.text,
            props: runProps(run.font, base, fonts.ink())
          }))
          if (now && shownKey(now.runs, base) === shownKey(next, base)) continue
          const before = now ? flat(now.runs) : cell?.type === 'str' ? cell.value : undefined
          if (before !== flat(next)) {
            headers ??= tableHeaders(zip, path, read)
            if (headers(row, col))
              throw new TextRefused(
                `${at} names a table column. Rename the column as plain text, then style it.`
              )
            out.words.push(at)
          }
        }
        const index = table().find(next)
        if (cell?.type === 's' && Number(cell.value) === index) continue
        out.edits.push({ row, col, write: { kind: 'text', value: String(index) } })
        if (cell?.type !== 's') out.named++
      }
      return out
    })
    if (!writes.length) continue
    cellsNamingTable += named
    for (const cell of words) changedWords.push({ sheet: name, cell, value: 'text' })
    try {
      sheets.set(path, patchSheet(xml, writes, { strings: Number }).xml)
    } catch (err) {
      throw new TextRefused(
        `“${name}” keeps its rows in a way this editor cannot add a cell to. Change the text in Excel.`,
        { cause: err }
      )
    }
  }
  if (!sheets.size) return { bytes, report }

  const enc = new TextEncoder()
  const replace = new Map<string, Uint8Array>()
  const add = new Map<string, Uint8Array>()
  for (const [path, xml] of sheets) replace.set(path, enc.encode(xml))
  const text = strings!.render(cellsNamingTable)
  if (stringsRel) {
    if (text !== read(stringsRel.target)) replace.set(stringsRel.target, enc.encode(text))
  } else {
    // No table yet: the workbook gains the part, its relationship and its content type.
    const types = new RulePart(read(CONTENT_TYPES), 'Types', ['Default', 'Override'])
    const taken = new Set([...zip.byName.keys()].map((part) => part.toLowerCase()))
    for (const el of types.siblings)
      taken.add(
        (valueOf(openTag(types.xml, el), 'PartName') ?? '').replace(/^\//, '').toLowerCase()
      )
    const dir = posix.dirname(book.wbPart)
    let path = posix.join(dir, 'sharedStrings.xml')
    for (let n = 1; taken.has(path.toLowerCase()); n++)
      path = posix.join(dir, `sharedStrings${n}.xml`)
    add.set(path, enc.encode(text))
    types.add(
      'Override',
      tag(types.prefix + 'Override', { PartName: '/' + path, ContentType: SST_TYPE })
    )
    replace.set(CONTENT_TYPES, enc.encode(types.render()))
    const rels = new RulePart(read(relsPath(book.wbPart)), 'Relationships', ['Relationship'])
    const ids = new Set(book.wbRels.rels.map(({ id }) => id))
    let id = 1
    while (ids.has('rId' + id)) id++
    // The workbook's own relationship says which family of types the file uses (a strict file has its own).
    const office = book.wbRels.rels.find((r) => /\/(styles|worksheet|theme)$/.test(r.type))?.type
    const family =
      office?.slice(0, office.lastIndexOf('/')) ??
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    rels.add(
      'Relationship',
      tag(rels.prefix + 'Relationship', {
        Id: 'rId' + id,
        Type: family + '/sharedStrings',
        Target: posix.relative(dir, path)
      })
    )
    replace.set(relsPath(book.wbPart), enc.encode(rels.render()))
  }
  if (
    changedWords.length &&
    !reading(() => independent(dependsInput(bytes, zip), changedWords)).independent
  ) {
    const workbook = read(book.wbPart)
    const calc = fullCalculation(workbook)
    if (calc !== workbook) replace.set(book.wbPart, enc.encode(calc))
    report.fullCalcOnLoad = true
  }
  report.partsChanged = [...replace.keys()]
  report.partsAdded = [...add.keys()]
  return { bytes: writeZip(zip, replace, new Set(), add, { level: options.level }), report }
}

/** The rich cells of the workbook, or of one tab, read from the parts alone. Rows and columns count from 0. */
export function readText(bytes: Uint8Array, sheet?: string): RichCell[] {
  return reading(() => {
    const { book, read, rel } = openBook(bytes)
    const tabs = book.sheets.filter(
      (tab) => tab.kind === 'worksheet' && (sheet === undefined || tab.name === sheet)
    )
    if (sheet !== undefined && !tabs.length) throw new TextRefused(`No worksheet named “${sheet}”.`)
    const stringsRel = rel('sharedStrings')
    const strings = stringsRel && new Strings(read(stringsRel.target))
    const shared = new Map<number, Run[] | null>()
    const sharedRuns = (index: number) => {
      let runs = shared.get(index)
      if (runs === undefined) {
        const item = strings?.item(index)
        shared.set(index, (runs = item && rich(item.runs) ? toRuns(item.runs) : null))
      }
      return runs
    }
    const out: RichCell[] = []
    for (const tab of tabs) {
      const xml = read(tab.part)
      const part = new RulePart(xml, 'worksheet', SHEET_ORDER)
      for (const { r, row } of rowsOf(part))
        for (const { c, cell } of cellsOf(part, row)) {
          let runs: Run[] | null = null
          if (cell.type === 's' && !cell.formula) runs = sharedRuns(Number(cell.value))
          else if (cell.type === 'inlineStr' && cell.inline) {
            const item = readItem(xml, cell.inline)
            if (rich(item.runs)) runs = toRuns(item.runs)
          }
          if (runs) out.push({ sheet: tab.name, row: r - 1, column: c - 1, runs })
        }
    }
    return out
  })
}
