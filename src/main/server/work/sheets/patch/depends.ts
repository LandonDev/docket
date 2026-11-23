import { BUILTIN_FUNCTIONS } from './functions'
import { lambdaParams, tokenize, type Ref, type RefEnd } from './formula'
import { toWrite, type EditSpec } from './patch'
import { parseAttrs, attr, parseRange, parseRef, rootPrefix, unesc, type Box } from './xml'

/**
 * Whether nothing in a workbook can depend on a set of cells: the proof that lets a typed value
 * be saved without loading the engine (the editors plan, decision 3). It reads every formula's
 * text, and answers "independent" only when each one can be shown not to read an edited cell.
 * Anything it cannot read for sure answers a reason, and the save takes the audited path:
 *
 *  - an edit that writes a formula (its value must be computed);
 *  - a formula that names a cell by a function (INDIRECT, OFFSET, GETPIVOTDATA, EVALUATE, CALL,
 *    CELL with no reference; SUMIF, AVERAGEIF and LOOKUP are read at the size they really take
 *    where their ranges are plain references, and refused where they are not), calls a
 *    function that is not one of Excel's own (a LAMBDA name is read through; an add-in's or a
 *    macro's may read anything), spans sheets (`Q1:Q3!A1`), builds a range with `:` from anything
 *    but two plain references, is a what-if table, or uses a name or a table this proof cannot
 *    place;
 *  - a defined name with a relative reference (it reads a different cell from each cell that
 *    uses it);
 *  - a workbook with macros or a macro sheet, whose own functions may read anything;
 *  - a cleared cell where a spill is blocked, and an edit anywhere in an array's range, its
 *    first cell included (overwriting that one empties the rest).
 *
 * It is a reader of text: no engine, no model.
 */

const MAX_ROW = 1048576
const MAX_COL = 16384
/** Functions whose result depends on cells their text does not name. */
// PY keeps its references in a string; CALL and REGISTER.ID run code outside the workbook.
const REACH = new Set(['INDIRECT', 'OFFSET', 'GETPIVOTDATA', 'EVALUATE', 'RTD', 'CUBEVALUE', 'CUBEMEMBER', 'CUBESET', 'CUBERANKEDMEMBER', 'CUBEKPIMEMBER', 'CUBEMEMBERPROPERTY', 'CUBESETCOUNT', 'PY', 'CALL', 'REGISTER.ID'])
/** Functions whose last range takes its size from an earlier one: SUMIF(range, criteria, sum_range), LOOKUP(value, vector, result). The index of the range that gives the size, and of the one that takes it. */
const SIZED: Record<string, readonly [number, number]> = { SUMIF: [0, 2], AVERAGEIF: [0, 2], LOOKUP: [1, 2] }
const PREFIX = /^(?:_xlfn\.|_xlws\.|_xlpm\.)+/i

export type Independence = { independent: true; formulas: number } | { independent: false; why: string }

export interface DependsInput {
  /** each worksheet: its tab name, its place among the workbook's sheets (a sheet's own name says it by that), and its XML */
  sheets: readonly { name: string; index?: number; xml(): string }[]
  /** the workbook part's XML, for its defined names */
  workbookXml: string
  /** each table: the sheet it is on, its name and its range */
  tables: readonly { sheet: string; name: string; ref: string }[]
  /** the package carries a VBA project */
  macros: boolean
}

const same = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0

/** The box a reference end covers along one axis pair, grown by `dr`/`dc` where it is relative (a shared formula's followers). */
function boxOf(a: RefEnd, b: RefEnd | undefined, dr: number, dc: number): Box {
  const row = (e: RefEnd): [number, number] => (e.kind === 'col' ? [1, MAX_ROW] : e.rowAbs ? [e.row!, e.row!] : [Math.max(1, e.row! - dr), Math.min(MAX_ROW, e.row! + dr)])
  const col = (e: RefEnd): [number, number] => (e.kind === 'row' ? [1, MAX_COL] : e.colAbs ? [e.col!, e.col!] : [Math.max(1, e.col! - dc), Math.min(MAX_COL, e.col! + dc)])
  const [r1, r2] = row(a)
  const [c1, c2] = col(a)
  if (!b) return { r1, r2, c1, c2 }
  const [r3, r4] = row(b)
  const [c3, c4] = col(b)
  return { r1: Math.min(r1, r3), r2: Math.max(r2, r4), c1: Math.min(c1, c3), c2: Math.max(c2, c4) }
}

const touches = (box: Box, cells: readonly { row: number; col: number }[]): boolean => cells.some((c) => c.row >= box.r1 && c.row <= box.r2 && c.col >= box.c1 && c.col <= box.c2)

interface Name {
  name: string
  /** the tab it belongs to, when it is a sheet's own */
  sheet?: string
  text: string
}

/** The workbook's defined names, with the tab each sheet-local one belongs to. */
function namesOf(workbookXml: string, tabs: ReadonlyMap<number, string>): Name[] {
  const out: Name[] = []
  const re = /<(?:[\w.-]+:)?definedName(?=[\s>])([^>]*)>([^<]*)<\/(?:[\w.-]+:)?definedName>/g
  for (let m = re.exec(workbookXml); m; m = re.exec(workbookXml)) {
    const attrs = parseAttrs(m[1])
    const name = attr(attrs, 'name')
    if (!name) continue
    const local = attr(attrs, 'localSheetId')
    // A name of a sheet that is no worksheet (a chart's) stays that sheet's own: its tag matches no tab, never the workbook.
    const tab = local === undefined ? undefined : (tabs.get(Number(local)) ?? `\u0000${local}`)
    out.push({ name, ...(tab !== undefined ? { sheet: tab } : {}), text: unesc(m[2]) })
  }
  return out
}

/**
 * Whether a formula's text, standing on `sheet`, can be shown not to read any of `edits` (by
 * tab): null when it cannot read them, else why it might. `dr`/`dc` grow each relative reference
 * (a shared formula's master speaks for every follower within its range).
 */
function reads(
  text: string,
  sheet: string,
  cell: { row: number; col: number } | null,
  edits: ReadonlyMap<string, readonly { row: number; col: number }[]>,
  ctx: { names: readonly Name[]; tables: DependsInput['tables']; seen: Set<string> },
  dr = 0,
  dc = 0
): string | null {
  const editsOn = (tab: string): readonly { row: number; col: number }[] | undefined => {
    for (const [name, cells] of edits) if (same(name, tab)) return cells
    return undefined
  }
  const tokens = tokenize(text)
  const params = lambdaParams(tokens)
  // (kept in lower case, with no storage prefix)
  const isParam = (word: string): boolean => params.has(word.toLowerCase()) || params.has(word.replace(PREFIX, '').toLowerCase())
  /** A defined name as the cells it reads, through the names it uses; null when it reads none of the edits. */
  const through = (named: Name): string | null => {
    const key = `${named.sheet ?? ''}\u0000${named.name.toLowerCase()}`
    if (ctx.seen.has(key)) return null
    ctx.seen.add(key)
    const why = reads(named.text, named.sheet ?? sheet, null, edits, ctx)
    ctx.seen.delete(key)
    return why
  }
  /** The name a word means where it stands: one of the tab that qualifies it, else of the formula's own tab, else the workbook's. */
  const nameOf = (word: string, qualifier: string | undefined): Name | undefined =>
    qualifier !== undefined
      ? (ctx.names.find((x) => same(x.name, word) && x.sheet !== undefined && same(x.sheet, qualifier)) ?? ctx.names.find((x) => same(x.name, word) && x.sheet === undefined))
      : (ctx.names.find((x) => same(x.name, word) && x.sheet !== undefined && same(x.sheet, sheet)) ?? ctx.names.find((x) => same(x.name, word) && x.sheet === undefined))
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // A range built with `:` from anything but two plain references (A1:INDEX(…), Start:B5, Data!A1:Data!B5, A1:B2:C5) covers cells neither end names.
    if (t.kind === 'other' && t.text === ':') return 'a range with a computed end'
    if (t.kind === 'other' && t.text === '.' && tokens[i - 1]?.text === ':') return 'a range with a computed end'
    if (t.kind === 'func') {
      const raw = t.text
      const fn = raw.replace(PREFIX, '').toUpperCase()
      if (REACH.has(fn)) return `${fn} names cells its formula does not`
      // CELL with a reference reads that cell, which the formula names; with none it reads whichever cell changed last.
      if (fn === 'CELL' && argsOf(tokens, i).length < 2) return 'CELL names cells its formula does not'
      const sized = SIZED[fn]
      if (sized) {
        // The range that takes its size: read as large as the range that gives it. Anything but two plain references is not placed.
        const args = argsOf(tokens, i)
        const taker = args[sized[1]]
        if (taker) {
          const giver = args[sized[0]]
          const g = giver?.length === 1 && giver[0].kind === 'ref' ? (giver[0].ref as Ref) : null
          const k = taker.length === 1 && taker[0].kind === 'ref' ? (taker[0].ref as Ref) : null
          if (!g || !k || g.external || k.external || k.sheet?.includes(':')) return `${fn} names cells its formula does not`
          const from = boxOf(g.a, g.b, 0, 0)
          const at = boxOf(k.a, k.b, 0, 0)
          const grown = { r1: Math.max(1, at.r1 - dr), c1: Math.max(1, at.c1 - dc), r2: Math.min(MAX_ROW, Math.max(at.r2, at.r1 + (from.r2 - from.r1)) + dr), c2: Math.min(MAX_COL, Math.max(at.c2, at.c1 + (from.c2 - from.c1)) + dc) }
          const cells = editsOn(k.sheet ?? sheet)
          if (cells && touches(grown, cells)) return 'a formula reads an edited cell'
        }
      }
      // A LET or LAMBDA parameter called as a function reads what it was given, which the formula names.
      if (isParam(raw)) continue
      const named = nameOf(raw.replace(PREFIX, ''), undefined)
      if (named) {
        const why = through(named)
        if (why) return why
        continue
      }
      // Not one of Excel's own: an add-in's function, a macro's, a name this proof cannot find. It may read any cell.
      if (/^_xludf\./i.test(raw) || !BUILTIN_FUNCTIONS.has(fn)) return `${fn} is no function of Excel's own`
      continue
    }
    if (t.kind === 'ref') {
      const ref = t.ref as Ref
      if (ref.external) {
        // `[0]` is this workbook, written so in a few names and charts.
        if (ref.sheet?.startsWith('[0]')) return 'a reference written as a link to this workbook'
        continue
      }
      // A span of tabs (Q1:Q3!A1) reads every tab between: which ones is the workbook's order to say.
      if (ref.sheet?.includes(':')) return 'a reference across a span of sheets'
      // In a defined name a reference with no `$` is relative to the cell that uses the name: it reads a different cell each time.
      if (cell === null && (!ref.sheet || [ref.a, ref.b].some((e) => e && ((e.kind !== 'col' && !e.rowAbs) || (e.kind !== 'row' && !e.colAbs))))) return 'a name with a relative reference'
      const cells = editsOn(ref.sheet ?? sheet)
      if (cells && touches(boxOf(ref.a, ref.b, dr, dc), cells)) return 'a formula reads an edited cell'
      continue
    }
    if (t.kind === 'bracket') {
      // A structured reference: the table named before it, else the table the formula stands in.
      const before = tokens[i - 1]
      const table = before?.kind === 'name' && before.end === t.start ? ctx.tables.find((x) => same(x.name, before.text)) : cell ? ctx.tables.find((x) => same(x.sheet, sheet) && inside(parseRange(x.ref), cell)) : undefined
      if (!table) return 'a structured reference to a table that could not be placed'
      const cells = editsOn(table.sheet)
      if (cells && touches(parseRange(table.ref), cells)) return 'a formula reads a table an edited cell is in'
      continue
    }
    if (t.kind === 'name') {
      const word = t.text
      if (/^(TRUE|FALSE)$/i.test(word)) continue
      const table = ctx.tables.find((x) => same(x.name, word))
      if (table) {
        // A table named alone is its data; with a bracket after it, the bracket's turn decides.
        if (tokens[i + 1]?.kind === 'bracket' && tokens[i + 1].start === t.end) continue
        const cells = editsOn(table.sheet)
        if (cells && touches(parseRange(table.ref), cells)) return 'a formula reads a table an edited cell is in'
        continue
      }
      // `Data!Rate` is the name of that tab: the tokenizer keeps the qualifier as the token before.
      const before = tokens[i - 1]
      const qualifier = before?.kind === 'sheet' && before.end === t.start ? before.text.slice(0, -1).replace(/^'|'$/g, '').replace(/''/g, "'") : undefined
      // `[0]!Rate` is this workbook's own name written as a link; any other `[n]` is another workbook's.
      if (qualifier !== undefined && qualifier.startsWith('[0]')) return 'a reference written as a link to this workbook'
      if (qualifier !== undefined && /^\[/.test(qualifier)) continue
      const named = nameOf(word, qualifier)
      if (!named) {
        // A LET variable or a lambda's parameter reads what the formula gave it. Any other word is a name this proof cannot find.
        if (isParam(word)) continue
        return 'a name that could not be placed'
      }
      const why = through(named)
      if (why) return why
    }
  }
  return null
}

/** The arguments of the call whose function token is `tokens[at]`: each a list of tokens, split at the commas of its own depth. */
function argsOf(tokens: readonly ReturnType<typeof tokenize>[number][], at: number): ReturnType<typeof tokenize>[number][][] {
  const args: ReturnType<typeof tokenize>[number][][] = [[]]
  let depth = 0
  for (let j = at + 1; j < tokens.length; j++) {
    const t = tokens[j]
    if (t.kind === 'other' && t.text === '(') {
      depth++
      if (depth === 1) continue
    } else if (t.kind === 'other' && t.text === ')') {
      depth--
      if (depth === 0) break
    } else if (t.kind === 'other' && t.text === ',' && depth === 1) {
      args.push([])
      continue
    } else if (t.kind === 'other' && /^\s+$/.test(t.text)) continue
    if (depth >= 1) args[args.length - 1].push(t)
  }
  return args.length === 1 && args[0].length === 0 ? [] : args
}

const inside = (box: Box, cell: { row: number; col: number }): boolean => cell.row >= box.r1 && cell.row <= box.r2 && cell.col >= box.c1 && cell.col <= box.c2

/**
 * A formula with nothing in it that could reach another tab: plain references, numbers, operators, quoted text
 * and calls to Excel's own functions other than the reaching ones. Anything else is read token by token.
 */
const FAST = /^(?:[A-Za-z$0-9.,+\-*/^&=<>%\s():]|"[^"]*")*$/

const CALL = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g
/** Whether every function a formula's text calls is one of Excel's own that reads only what it is given. */
function plainCalls(text: string): boolean {
  for (const m of text.matchAll(CALL)) {
    const fn = m[1].replace(PREFIX, '').toUpperCase()
    if (REACH.has(fn) || !BUILTIN_FUNCTIONS.has(fn)) return false
  }
  return true
}

/** One formula of a worksheet: its cell's address, its `<f>` attributes and its text (absent on a shared formula's follower). */
interface Found {
  at: string | undefined
  attrs: string
  text: string | undefined
}

/**
 * Every `<f>` of a worksheet with the `<c>` it sits in, found by position: a regular expression
 * over a 15 MB sheet is the slow way. `<f` also begins `<formula>` (a rule's), `<filterColumn>`
 * and the like, so the next character decides.
 */
function* formulasOf(xml: string): Generator<Found> {
  const P = rootPrefix(xml, 'worksheet')
  const open = `<${P}f`
  const cellOpen = `<${P}c`
  const cellClose = `</${P}c>`
  const close = `</${P}f>`
  const space = (ch: string | undefined): boolean => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'
  for (let i = xml.indexOf(open); i >= 0; i = xml.indexOf(open, i + open.length)) {
    const next = xml[i + open.length]
    if (!space(next) && next !== '>' && next !== '/') continue
    const tagEnd = xml.indexOf('>', i)
    if (tagEnd < 0) return
    // The cell the formula sits in: the nearest `<c` before it that opens a cell (not `<col`, `<cfRule`), with no cell closed between.
    let cell = xml.lastIndexOf(cellOpen, i)
    while (cell >= 0 && !space(xml[cell + cellOpen.length]) && xml[cell + cellOpen.length] !== '>') cell = cell === 0 ? -1 : xml.lastIndexOf(cellOpen, cell - 1)
    const cellEnd = cell < 0 ? -1 : xml.indexOf('>', cell)
    const closed = cell < 0 ? -1 : xml.indexOf(cellClose, cell)
    const sound = cell >= 0 && cellEnd >= 0 && cellEnd < i && (closed < 0 || closed > i)
    const at = sound ? /(?:^|\s)r\s*=\s*["']([A-Z]+\d+)["']/.exec(xml.slice(cell + cellOpen.length, cellEnd))?.[1] : undefined
    const selfClosed = xml[tagEnd - 1] === '/'
    const attrs = xml.slice(i + open.length, selfClosed ? tagEnd - 1 : tagEnd)
    if (selfClosed) {
      yield { at, attrs, text: undefined }
      continue
    }
    const end = xml.indexOf(close, tagEnd)
    if (end < 0) return
    yield { at, attrs, text: xml.slice(tagEnd + 1, end) }
  }
}

export function independent(input: DependsInput, edits: readonly EditSpec[]): Independence {
  // A value that begins with `=` is written as a formula too (patch.ts `toWrite`).
  if (edits.some((e) => toWrite(e).kind === 'formula')) return { independent: false, why: 'the edit writes a formula' }
  if (input.macros) return { independent: false, why: 'the workbook has macros' }
  const byTab = new Map<string, { row: number; col: number }[]>()
  for (const e of edits) {
    const at = parseRef(e.cell)
    const list = byTab.get(e.sheet)
    if (list) list.push(at)
    else byTab.set(e.sheet, [at])
  }
  const tabs = new Map(input.sheets.map((s, i) => [s.index ?? i, s.name]))
  const ctx = { names: namesOf(input.workbookXml, tabs), tables: input.tables, seen: new Set<string>() }
  // A name or a table that covers an edited cell is found where a formula uses it; a formula that uses none is read alone.
  const words = [...ctx.names.map((n) => n.name), ...ctx.tables.map((t) => t.name)]
  const named = words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null
  let formulas = 0
  for (const sheet of input.sheets) {
    const xml = sheet.xml()
    const cells = [...byTab].find(([name]) => same(name, sheet.name))?.[1]
    // A spill a cell blocks grows when the cell is emptied, and an array's range is the engine's to judge.
    if (cells && xml.includes('#SPILL!') && edits.some((e) => same(e.sheet, sheet.name) && (e.value === null || e.value === undefined))) return { independent: false, why: 'a spill is blocked on that sheet' }
    for (const found of formulasOf(xml)) {
      formulas++
      if (!found.at) return { independent: false, why: 'a formula cell with no address' }
      const cell = parseRef(found.at)
      const fa = found.attrs.trim() ? parseAttrs(found.attrs) : []
      const type = attr(fa, 't')
      const ref = attr(fa, 'ref')
      if (type === 'dataTable') return { independent: false, why: 'a what-if table' }
      // An array's cells are one formula's: an edit among them changes what it may fill.
      // (its first cell too: a value over that one empties the rest of the array)
      if (type === 'array' && ref && cells && cells.some((c) => inside(parseRange(ref), c)) && (ref.includes(':') || !cells.some((c) => c.row === cell.row && c.col === cell.col))) return { independent: false, why: "an edit inside an array formula's range" }
      const text = found.text
      // A shared formula's follower has no text of its own: its master, which has the range, spoke for it.
      if (text === undefined || text === '') {
        if (type === 'shared') continue
        return { independent: false, why: 'a formula with no text' }
      }
      // On a tab no edit is on, a formula that names no other tab, no table, no name and no reaching function reads none of them.
      // (a call to anything but a plain function name, a `:` between calls and a numeric entity are read in full)
      if (!cells && FAST.test(text) && plainCalls(text) && !(named && named.test(text))) continue
      let dr = 0
      let dc = 0
      if (type === 'shared' && ref) {
        const box = parseRange(ref)
        dr = box.r2 - box.r1
        dc = box.c2 - box.c1
      }
      const why = reads(unesc(text), sheet.name, cell, byTab, ctx, dr, dc)
      if (why) return { independent: false, why }
    }
  }
  return { independent: true, formulas }
}
