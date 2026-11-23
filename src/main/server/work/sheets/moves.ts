import { MOVE_WHY, sheetStopWords, type MoveRefusal } from '../../../../shared/work/sheets'
import { typedNamesAtRisk } from './graft'
import { independent } from './patch/depends'
import { tokenize, type RefEnd } from './patch/formula'
import { dependsInput } from './patch/package'
import { readRels, workbookMap } from './patch/patch'
import { arrayRanges } from './patch/sheet'
import { colName, colNum, parseRange, rootPrefix, unesc, type Box } from './patch/xml'
import { readText, type Zip } from './patch/zip'
import type { StructuralOp } from './structural'

/**
 * What a move may not touch in an opened Excel file, judged on the file before LibreOffice runs
 * (docs/agents/work-sheets.md "Structural edits"). Each rule here came from running the move
 * through LibreOffice on a dummy file and reading the result back: where the file did not come out
 * as Excel would leave it, the move is Excel's, said in the canvas's words (`MOVE_WHY`).
 *
 * - A table, a merged cell, an array formula or a spill is moved only whole: LibreOffice leaves a
 *   table with holes, splits a merge, and does not move part of an array at all.
 * - A pivot table's cells and its source are left alone (LibreOffice lays a pivot out again).
 * - The sheet's filter: rows are moved only among its rows below the header or wholly outside it,
 *   columns only outside it, and a block not at all where it meets the filter (LibreOffice shrank
 *   the filter or moved its header out).
 * - A block lands only where nothing reads: Excel turns a reference to the cells a block lands on
 *   into #REF!, LibreOffice points it at what landed there.
 * - A protected sheet is Excel's to change.
 * - A conditional format that shares cells with another is moved only in part, never whole:
 *   LibreOffice makes a format whose whole range moved again (after every other, or as part of one
 *   that holds the same rule), so the order in which Excel tries the two on the cells they share
 *   could change. A format moved in part keeps its place.
 * - A range something reads (a formula, a name, a chart, a rule's formula) is moved whole, or from
 *   its middle, never by a corner alone: Excel moves a range's end with its corner cell, LibreOffice
 *   leaves the range where it was, and a total would lose what moved without a word. Rows or
 *   columns that hold a range's end may still move to a place inside that range: it then covers
 *   the same lines as before.
 * - Rows or columns are not moved where the sheet's last ones are in use: there is no room to
 *   make the move in.
 * - A chart series named by typed text whose cells move: LibreOffice writes a moved cell where the
 *   name was, and graft.ts puts the text back only where it can tell the chart from every other
 *   (`typedSeriesNames`). Where it cannot (two charts over the same ranges, named differently), the
 *   move is Excel's.
 */

/** What a sheet holds that a move must not cut through, zero-based and inclusive. */
export interface SheetFacts {
  protected: boolean
  tables: Box[]
  merges: Box[]
  arrays: { box: Box; dynamic: boolean }[]
  filter: Box | null
  /** each pivot table's cells, its page fields above them included */
  pivots: Box[]
  /** where each conditional format applies (the sheet's own list and Excel 2010's extended one) */
  conditional: Box[][]
  /** how many rows and columns the sheet uses, counted from its first: what it says of itself (`dimension`), else its last row */
  used: { rows: number; cols: number }
}

/**
 * A reference something makes to cells of a sheet, zero-based, as it is written. Where it has more
 * than one user (a shared formula's cells, the cells a rule applies to), `at` is the user it is
 * written for and the others lie `i1..i2` rows and `j1..j2` columns from that one; a coordinate
 * with no `$` then follows its user.
 */
export interface Read {
  sheet: string
  r1: number
  c1: number
  r2: number
  c2: number
  relR1: boolean
  relC1: boolean
  relR2: boolean
  relC2: boolean
  /** a whole column: it has no row ends */
  allRows: boolean
  /** a whole row */
  allCols: boolean
  at: { sheet: string; row: number; col: number } | null
  i1: number
  i2: number
  j1: number
  j2: number
}

export interface MoveFacts {
  zip: Zip
  sheets: Map<string, SheetFacts>
  /** pivot caches' source ranges, by sheet */
  pivotSources: { sheet: string; box: Box }[]
  /** what reads cells, read once when a check first asks (`readsOf`) */
  reads?: { formulas: Read[]; rules: Read[]; named: Read[] }
}

const zero = (b: Box): Box => ({ r1: b.r1 - 1, c1: b.c1 - 1, r2: b.r2 - 1, c2: b.c2 - 1 })
const box = (ref: string): Box | null => {
  try {
    return zero(parseRange(ref.replace(/\$/g, '')))
  } catch {
    return null
  }
}
const tags = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>`, 'g'))].map((m) => m[0])
const attrOf = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
/** A list of cells and ranges as boxes (`sqref`). */
const boxes = (sqref: string): Box[] =>
  sqref
    .trim()
    .split(/\s+/)
    .map((r) => box(r))
    .filter((b): b is Box => !!b)
/**
 * Where each conditional format of a sheet applies: `sqref` on the element, or `<xm:sqref>` inside an
 * extended one. An extended entry that is only the second half of rules the sheet's own list holds (a
 * data bar's: each of its rules is named there by `<x14:id>`) is that same format, not another.
 */
export const conditionalOf = (xml: string): Box[][] => {
  const linked = new Set([...xml.matchAll(/<(?:[\w.-]+:)?id>([^<]+)<\/(?:[\w.-]+:)?id>/g)].map((m) => m[1]))
  return [...xml.matchAll(/<((?:[\w.-]+:)?conditionalFormatting)\b([^>]*)>([\s\S]*?)<\/\1>/g)]
    .filter((m) => {
      if (attrOf(m[2], 'sqref') !== undefined) return true
      const ids = [...m[3].matchAll(/<(?:[\w.-]+:)?cfRule\b[^>]*\sid="([^"]+)"/g)].map((r) => r[1])
      return !(ids.length > 0 && ids.every((id) => linked.has(id)))
    })
    .map((m) => boxes(attrOf(m[2], 'sqref') ?? /<(?:[\w.-]+:)?sqref>([^<]*)</.exec(m[3])?.[1] ?? ''))
    .filter((list) => list.length > 0)
}
const refsOf = (xml: string, tag: string): Box[] =>
  tags(xml, tag)
    .map((t) => attrOf(t, 'ref'))
    .map((r) => (r ? box(r) : null))
    .filter((b): b is Box => !!b)

const MAX_ROWS = 1_048_576
const MAX_COLS = 16_384

/** The rows and columns a sheet uses, from its `dimension`; a sheet that has none says its last row, and no columns. */
function usedOf(xml: string): { rows: number; cols: number } {
  const dim = tags(xml, 'dimension')[0]
  const b = dim ? box(attrOf(dim, 'ref') ?? '') : null
  if (b) return { rows: b.r2 + 1, cols: b.c2 + 1 }
  const rows = [...xml.matchAll(/<(?:[\w.-]+:)?row\b[^>]*\sr="(\d+)"/g)]
  return { rows: rows.length ? Number(rows[rows.length - 1][1]) : 0, cols: 0 }
}

type Users = Pick<Read, 'at' | 'i1' | 'i2' | 'j1' | 'j2'>
const ALONE: Users = { at: null, i1: 0, i2: 0, j1: 0, j2: 0 }

/** The references a formula's text makes, standing on `sheet`: plain ones and whole rows and columns. Another workbook's, and a span of tabs, are not placed. */
export function readsIn(text: string, sheet: string, users: Users = ALONE): Read[] {
  const out: Read[] = []
  for (const t of tokenize(text)) {
    const ref = t.kind === 'ref' ? t.ref : undefined
    if (!ref || ref.external || ref.sheet?.includes(':')) continue
    const a: RefEnd = ref.a
    const b: RefEnd = ref.b ?? ref.a
    if (a.kind !== b.kind) continue
    const allRows = a.kind === 'col'
    const allCols = a.kind === 'row'
    out.push({
      sheet: ref.sheet ?? sheet,
      r1: allRows ? 0 : a.row! - 1,
      r2: allRows ? MAX_ROWS - 1 : b.row! - 1,
      c1: allCols ? 0 : a.col! - 1,
      c2: allCols ? MAX_COLS - 1 : b.col! - 1,
      relR1: !allRows && !a.rowAbs,
      relR2: !allRows && !b.rowAbs,
      relC1: !allCols && !a.colAbs,
      relC2: !allCols && !b.colAbs,
      allRows,
      allCols,
      ...users
    })
  }
  return out
}

/** Every formula in a worksheet's cells as the references it makes; a shared formula's first cell speaks for the cells it fills. */
function formulaReads(xml: string, sheet: string): Read[] {
  const P = rootPrefix(xml, 'worksheet')
  const out: Read[] = []
  const re = new RegExp(`<${P}c\\s[^>]*?\\br="([A-Z]+)(\\d+)"[^>]*>\\s*<${P}f((?:\\s[^>]*?)?)>([^<]+)</${P}f>`, 'g')
  for (const m of xml.matchAll(re)) {
    const at = { sheet, row: Number(m[2]) - 1, col: colNum(m[1]) - 1 }
    const fills = /\bt="shared"/.test(m[3]) ? box(attrOf(m[3], 'ref') ?? '') : null
    const users: Users = fills ? { at, i1: fills.r1 - at.row, i2: fills.r2 - at.row, j1: fills.c1 - at.col, j2: fills.c2 - at.col } : ALONE
    out.push(...readsIn(unesc(m[4]), sheet, users))
  }
  return out
}

/**
 * The references in a worksheet's rules: a conditional format's formulas and a validation's, the
 * extended ones (`x14`) too. A reference with no `$` is written for the first cell the rule applies
 * to and follows each of the others.
 */
export function ruleReads(xml: string, sheet: string): Read[] {
  const out: Read[] = []
  for (const m of xml.matchAll(/<((?:[\w.-]+:)?(?:conditionalFormatting|dataValidation))\b((?:[^>/]|\/(?!>))*)>([\s\S]*?)<\/\1>/g)) {
    const list = boxes(unesc(attrOf(m[2], 'sqref') ?? /<(?:[\w.-]+:)?sqref>([^<]*)</.exec(m[3])?.[1] ?? ''))
    if (!list.length) continue
    const first = list[0]
    const users: Users = {
      at: { sheet, row: first.r1, col: first.c1 },
      i1: Math.min(...list.map((b) => b.r1)) - first.r1,
      i2: Math.max(...list.map((b) => b.r2)) - first.r1,
      j1: Math.min(...list.map((b) => b.c1)) - first.c1,
      j2: Math.max(...list.map((b) => b.c2)) - first.c1
    }
    for (const f of m[3].matchAll(/<(?:[\w.-]+:)?(?:formula[12]?|f)>([^<]+)</g)) out.push(...readsIn(unesc(f[1]), sheet, users))
    // a colour scale's or a data bar's end given as a formula is an attribute of its `cfvo`
    for (const tag of tags(m[3], 'cfvo')) out.push(...readsIn(unesc(attrOf(tag, 'val') ?? ''), sheet, users))
  }
  return out
}

/** Everything that reads cells: every cell's formula, every rule's, and the ranges of the names and the charts. */
function readsOf(facts: MoveFacts): NonNullable<MoveFacts['reads']> {
  if (facts.reads) return facts.reads
  const book = workbookMap(facts.zip)
  const formulas: Read[] = []
  const rules: Read[] = []
  for (const tab of book.sheets) {
    if (tab.kind !== 'worksheet' || !facts.zip.byName.has(tab.part)) continue
    const xml = readText(facts.zip, tab.part)
    formulas.push(...formulaReads(xml, tab.name))
    rules.push(...ruleReads(xml, tab.name))
  }
  const texts = [
    ...tags(book.wbXml, 'definedName').map((t) => book.wbXml.slice(book.wbXml.indexOf(t) + t.length).split('<')[0]),
    ...[...facts.zip.byName.keys()].filter((n) => /\/charts\/chart[^/]*\.xml$/.test(n)).flatMap((n) => [...readText(facts.zip, n).matchAll(/<c:f>([^<]*)<\/c:f>/g)].map((m) => m[1]))
  ]
  const named = texts.flatMap((text) => sheetRefs(text)).map((r): Read => ({ sheet: r.sheet, ...r.box, relR1: false, relC1: false, relR2: false, relC2: false, allRows: false, allCols: false, ...ALONE }))
  return (facts.reads = { formulas, rules, named })
}

const sameSheet = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase()
const between = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi
/** The lines a read covers along one axis for the user `d` lines from its first. */
const spanAt = (v1: number, rel1: boolean, v2: number, rel2: boolean, d: number): [number, number] => {
  const a = rel1 ? v1 + d : v1
  const z = rel2 ? v2 + d : v2
  return a <= z ? [a, z] : [z, a]
}
/** Each user's lines along one axis: one span where no coordinate follows its user. */
function* spans(read: Read, rows: boolean): Generator<[number, number]> {
  const [v1, rel1, v2, rel2] = rows ? [read.r1, read.relR1, read.r2, read.relR2] : [read.c1, read.relC1, read.c2, read.relC2]
  const follows = rel1 || rel2
  const [d1, d2] = follows ? (rows ? [read.i1, read.i2] : [read.j1, read.j2]) : [0, 0]
  for (let d = d1; d <= d2; d++) yield spanAt(v1, rel1, v2, rel2, d)
}

/** Whether a block holds a corner of what a read covers, for any of its users, without holding all of it. */
export function cornerOnly(read: Read, src: Box): boolean {
  if (read.allRows || read.allCols) return false
  const count = (rows: boolean, lo: number, hi: number): [number, number] => {
    let any = 0
    let all = 0
    for (const [a, z] of spans(read, rows)) {
      const first = between(a, lo, hi)
      const last = between(z, lo, hi)
      if (first || last) any++
      if (first && last) all++
    }
    return [any, all]
  }
  const [anyRow, allRow] = count(true, src.r1, src.r2)
  if (!anyRow) return false
  const [anyCol, allCol] = count(false, src.c1, src.c2)
  return anyCol > 0 && (anyRow > allRow || anyCol > allCol)
}

/**
 * Whether rows or columns moved hold an end of what a read covers without holding all of it, and
 * would leave it: lines that stay inside the range (they lie in it, and go before a line of it
 * that is not its first) are covered by it afterwards as before.
 */
export function endOnly(read: Read, rows: boolean, at: number, count: number, to: number): boolean {
  if (rows ? read.allRows : read.allCols) return false
  const last = at + count - 1
  for (const [a, z] of spans(read, rows)) {
    if (!between(a, at, last) && !between(z, at, last)) continue
    if (a >= at && z <= last) continue
    if (a <= at && last <= z && to > a && to <= z) continue
    return true
  }
  return false
}

/** Reads what the move check needs from a package's parts: no cell values. */
export function moveFacts(zip: Zip): MoveFacts {
  const book = workbookMap(zip)
  const sheets = new Map<string, SheetFacts>()
  for (const tab of book.sheets) {
    if (tab.kind !== 'worksheet' || !zip.byName.has(tab.part)) continue
    const xml = readText(zip, tab.part)
    const rels = readRels(zip, tab.part).rels.filter((r) => !r.external)
    const parts = (type: string): string[] => rels.filter((r) => r.type.endsWith(`/${type}`) && zip.byName.has(r.target)).map((r) => readText(zip, r.target))
    const pivots = parts('pivotTable').flatMap((t) => {
      const loc = tags(t, 'location')[0]
      const at = loc ? box(attrOf(loc, 'ref') ?? '') : null
      if (!loc || !at) return []
      // page fields sit above the table, with a blank row between
      const pages = Number(attrOf(loc, 'rowPageCount') ?? 0)
      return [{ ...at, r1: Math.max(0, at.r1 - (pages ? pages + 1 : 0)) }]
    })
    sheets.set(tab.name, {
      protected: tags(xml, 'sheetProtection').some((t) => /^(1|true)$/.test(attrOf(t, 'sheet') ?? '')),
      tables: parts('table').flatMap((t) => refsOf(t, 'table').slice(0, 1)),
      merges: refsOf(xml, 'mergeCell'),
      arrays: arrayRanges(xml, rootPrefix(xml, 'worksheet')).map((a) => ({ box: zero(a.box), dynamic: a.dynamic })),
      filter: refsOf(xml, 'autoFilter')[0] ?? null,
      pivots,
      conditional: conditionalOf(xml),
      used: usedOf(xml)
    })
  }
  const pivotSources: MoveFacts['pivotSources'] = []
  for (const name of zip.byName.keys()) {
    if (!/pivotCacheDefinition\d*\.xml$/.test(name)) continue
    const src = tags(readText(zip, name), 'worksheetSource')[0] ?? ''
    const ref = attrOf(src, 'ref')
    const sheet = attrOf(src, 'sheet')
    const b = ref ? box(ref) : null
    if (b && sheet) pivotSources.push({ sheet, box: b })
  }
  return { zip, sheets, pivotSources }
}

const meets = (a: Box, b: Box): boolean => a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2
const inside = (a: Box, b: Box): boolean => a.r1 >= b.r1 && a.r2 <= b.r2 && a.c1 >= b.c1 && a.c2 <= b.c2

/** Why a move cannot be saved into the file, or null. */
export function moveRefusal(facts: MoveFacts, op: StructuralOp): Refusal | null {
  if (op.op === 'moveRange') return blockRefusal(facts, op)
  if (op.op === 'moveRows' || op.op === 'moveCols') return linesRefusal(facts, op)
  return null
}

function blockRefusal(facts: MoveFacts, op: Extract<StructuralOp, { op: 'moveRange' }>): Refusal | null {
  const from = facts.sheets.get(op.sheet)
  const to = facts.sheets.get(op.to)
  if (!from || !to) return null
  if (from.protected || to.protected) return 'protected'
  const src: Box = { r1: op.r1, c1: op.c1, r2: op.r2, c2: op.c2 }
  const dest: Box = { r1: op.row, c1: op.col, r2: op.row + op.r2 - op.r1, c2: op.col + op.c2 - op.c1 }
  const same = op.sheet === op.to
  /** a thing of `sheet` the move cuts: part of it in the block, or any of it where the block lands (what moves with the block aside) */
  const cut = (sheet: SheetFacts, b: Box): boolean => {
    const whole = sheet === from && inside(b, src)
    return (sheet === from && meets(b, src) && !whole) || (sheet === to && meets(b, dest) && !(same && whole))
  }
  const touched = (sheet: SheetFacts, b: Box): boolean => (sheet === from && meets(b, src)) || (sheet === to && meets(b, dest))
  for (const sheet of same ? [from] : [from, to]) {
    const why = thingsRefusal(sheet, (b) => cut(sheet, b), (b) => touched(sheet, b))
    if (why) return why
    if (sheet.filter && touched(sheet, sheet.filter)) return 'filter'
  }
  if (rulesPart(from, (b) => inside(b, src))) return 'rule'
  if (facts.pivotSources.some((p) => (p.sheet === op.sheet && meets(p.box, src)) || (p.sheet === op.to && meets(p.box, dest)))) return 'pivot'
  const reads = readsOf(facts)
  if ([reads.formulas, reads.rules, reads.named].some((list) => list.some((r) => sameSheet(r.sheet, op.sheet) && cornerOnly(r, src)))) return 'part'
  if (legendRefusal(facts, op, (b) => meets(b, src))) return 'chart'
  return landsRefusal(facts, op.to, dest, same ? src : null)
}

function linesRefusal(facts: MoveFacts, op: Extract<StructuralOp, { op: 'moveRows' | 'moveCols' }>): Refusal | null {
  const sheet = facts.sheets.get(op.sheet)
  if (!sheet) return null
  if (sheet.protected) return 'protected'
  const rows = op.op === 'moveRows'
  // the move is made in room opened beside the lines in use: with the sheet's last ones in use there is none
  if ((rows ? sheet.used.rows : sheet.used.cols) + op.count > (rows ? MAX_ROWS : MAX_COLS)) return 'full'
  const span = (b: Box): [number, number] => (rows ? [b.r1, b.r2] : [b.c1, b.c2])
  const edges = [op.at, op.at + op.count, op.to]
  // an edge of the move strictly inside a thing splits it, or grows it
  const cut = (b: Box): boolean => {
    const [a, z] = span(b)
    return edges.some((e) => e > a && e <= z)
  }
  const lo = Math.min(op.at, op.to)
  const hi = Math.max(op.at + op.count, op.to) - 1
  const touched = (b: Box): boolean => {
    const [a, z] = span(b)
    return a <= hi && z >= lo
  }
  const why = thingsRefusal(sheet, cut, touched)
  if (why) return why
  if (facts.pivotSources.some((p) => p.sheet === op.sheet && touched(p.box))) return 'pivot'
  const f = sheet.filter
  if (f) {
    const [a, z] = span(f)
    const last = op.at + op.count - 1
    // rows among its rows below the header; anything wholly outside it
    const among = rows && op.at > a && last <= z && op.to > a && op.to <= z + 1
    const outside = (last < a || op.at > z) && (op.to <= a || op.to > z)
    if (!among && !outside) return 'filter'
  }
  const first = op.at
  const last = op.at + op.count - 1
  if (
    rulesPart(sheet, (b) => {
      const [a, z] = span(b)
      return a >= first && z <= last
    })
  )
    return 'rule'
  const reads = readsOf(facts)
  if ([reads.formulas, reads.rules, reads.named].some((list) => list.some((r) => sameSheet(r.sheet, op.sheet) && endOnly(r, rows, op.at, op.count, op.to)))) return 'part'
  if (
    legendRefusal(facts, op, (b) => {
      const [a, z] = span(b)
      return a <= last && z >= first
    })
  )
    return 'chart'
  return null
}

/** Whether the move takes cells that a chart series with a typed name reads, where graft could not put that name back. */
function legendRefusal(facts: MoveFacts, op: StructuralOp & { sheet: string }, moved: (b: Box) => boolean): boolean {
  const charts = [...facts.zip.byName.keys()].filter((n) => /\/charts\/chart[^/]*\.xml$/.test(n)).map((n) => readText(facts.zip, n))
  if (!charts.some((xml) => /<c:tx>\s*<c:v>/.test(xml))) return false
  return typedNamesAtRisk(charts, [op]).some((ranges) => ranges.some((f) => sheetRefs(f).some((r) => sameSheet(r.sheet, op.sheet) && moved(r.box))))
}

/** Whether a conditional format that shares a cell with another would move whole (`moved`: a box lies wholly in what moves). */
function rulesPart(sheet: SheetFacts, moved: (b: Box) => boolean): boolean {
  return sheet.conditional.some((x, i) => x.every(moved) && sheet.conditional.some((y, j) => j !== i && x.some((a) => y.some((b) => meets(a, b)))))
}

/** Tables, merges, arrays, spills and pivots, the same for a block and for lines. */
function thingsRefusal(sheet: SheetFacts, cut: (b: Box) => boolean, touched: (b: Box) => boolean): Refusal | null {
  if (sheet.tables.some(cut)) return 'table'
  if (sheet.merges.some(cut)) return 'merge'
  if (sheet.arrays.some((a) => !a.dynamic && cut(a.box))) return 'array'
  if (sheet.arrays.some((a) => a.dynamic && cut(a.box))) return 'spill'
  if (sheet.pivots.some(touched)) return 'pivot'
  return null
}

const MAX_LANDING = 20_000

/**
 * Whether anything reads the cells a block lands on (those of the block itself aside): a formula
 * (by the dependency proof, patch/depends.ts: what it cannot show answers yes), a defined name, a
 * chart's range, or a rule's formula. Excel turns such a reference into #REF!; LibreOffice points
 * it at what landed. A block of more cells than this check will count is refused for its size.
 */
function landsRefusal(facts: MoveFacts, sheet: string, dest: Box, src: Box | null): Refusal | null {
  const cells: { sheet: string; cell: string; value: number }[] = []
  for (let r = dest.r1; r <= dest.r2; r++)
    for (let c = dest.c1; c <= dest.c2; c++) {
      if (src && r >= src.r1 && r <= src.r2 && c >= src.c1 && c <= src.c2) continue
      cells.push({ sheet, cell: `${colName(c + 1)}${r + 1}`, value: 0 })
      if (cells.length > MAX_LANDING) return 'large'
    }
  if (!cells.length) return null
  // (a macro may read any cell, before a move as after it: that is not this check's question)
  if (!independent({ ...dependsInput(new Uint8Array(), facts.zip), macros: false }, cells).independent) return 'lands'
  const open = (b: Box): boolean => meets(b, dest) && !(src && inside(b, src))
  const reads = readsOf(facts)
  if (reads.named.some((r) => sameSheet(r.sheet, sheet) && open(r))) return 'lands'
  if (reads.rules.some((r) => sameSheet(r.sheet, sheet) && ruleLands(r, sheet, dest, open))) return 'lands'
  return null
}

const MAX_USERS = 200_000

/**
 * Whether a rule's reference reads a cell a block lands on, for a user that outlives the landing:
 * a cell the block lands on takes the block's rules and loses its own, so what its own rule read
 * goes with it (a rule that reads the very cell it is on never stands in a block's way).
 */
function ruleLands(read: Read, sheet: string, dest: Box, open: (b: Box) => boolean): boolean {
  const boxAt = (i: number, j: number): Box => {
    const [r1, r2] = spanAt(read.r1, read.relR1, read.r2, read.relR2, i)
    const [c1, c2] = spanAt(read.c1, read.relC1, read.c2, read.relC2, j)
    return { r1, c1, r2, c2 }
  }
  const users = (read.i2 - read.i1 + 1) * (read.j2 - read.j1 + 1)
  // too many users to follow each: every cell any of them reads
  if (!read.at || users > MAX_USERS) {
    const [a, z] = [boxAt(read.i1, read.j1), boxAt(read.i2, read.j2)]
    return open({ r1: Math.min(a.r1, z.r1), c1: Math.min(a.c1, z.c1), r2: Math.max(a.r2, z.r2), c2: Math.max(a.c2, z.c2) })
  }
  const mine = sameSheet(read.at.sheet, sheet)
  for (let i = read.i1; i <= read.i2; i++)
    for (let j = read.j1; j <= read.j2; j++) {
      if (!open(boxAt(i, j))) continue
      const row = read.at.row + i
      const col = read.at.col + j
      if (mine && between(row, dest.r1, dest.r2) && between(col, dest.c1, dest.c2)) continue
      return true
    }
  return false
}

/** The sheet-qualified ranges in a name's or a chart's formula. */
function sheetRefs(text: string): { sheet: string; box: Box }[] {
  const out: { sheet: string; box: Box }[] = []
  const re = /(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/g
  for (const m of text.replace(/&apos;/g, "'").matchAll(re)) {
    const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]
    const a = { row: Number(m[4]) - 1, col: colNum(m[3]) - 1 }
    const b = m[5] ? { row: Number(m[6]) - 1, col: colNum(m[5]) - 1 } : a
    out.push({ sheet, box: { r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) } })
  }
  return out
}

/**
 * Reasons the shared words (`MOVE_WHY`, src/shared/work/sheets.ts) do not hold yet, said after the same
 * "Move this in Excel". A reason moved there is said from there: this table is then spare.
 */
const HOST_WHY = {
  part: 'a formula reads part of it',
  full: 'the sheet is full',
  large: 'it is too large',
  chart: "a chart's legend would change"
} as const
/** Why a move is refused: the reasons the canvas and the host say in the same words, and the host's newest. */
export type Refusal = MoveRefusal | keyof typeof HOST_WHY

/** The words a refused move is said in: the canvas's own. */
export const moveRefusalWords = (why: Refusal): string =>
  why in MOVE_WHY ? sheetStopWords('moved', false, why as MoveRefusal) : `${sheetStopWords('moved')}: ${HOST_WHY[why as keyof typeof HOST_WHY]}`
