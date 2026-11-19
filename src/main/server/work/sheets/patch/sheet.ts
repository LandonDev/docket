// Worksheet part surgery: replace or insert <c> elements inside <sheetData>, patch cached <v>
// values of formula cells, and nothing else. Every byte outside the spliced spans is kept.
import { translate } from './formula'
import {
  attr,
  Box,
  colName,
  esc,
  escText,
  inBox,
  parseAttrs,
  parseRange,
  parseRef,
  refName,
  rootPrefix,
  setAttrInTag,
  removeAttrInTag,
  unesc
} from './xml'

export type Cached = { t: 'n' | 'str' | 'b' | 'e'; v: string }
export type CellWrite =
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'text'; value: string }
  | { kind: 'formula'; file: string; cached?: Cached }
  /** empties the cell and keeps its style; a cell that is not there stays absent */
  | { kind: 'clear' }

export interface Edit {
  row: number
  col: number
  write: CellWrite
}

export interface SheetOpts {
  /** 'inline' writes <is><t>; otherwise a function returning the shared-string index for a text. */
  strings: 'inline' | ((text: string) => number)
}

export interface SheetReport {
  replaced: string[]
  inserted: string[]
  rowsInserted: number[]
  remastered: string[]
  expanded: string[]
  arrayCleared: string[]
  formulasRemoved: number
  formulasAdded: number
  warnings: string[]
}

interface Span {
  start: number
  end: number
  text: string
}

export const numText = (n: number) => (Object.is(n, -0) ? '0' : String(n))

/** One <c> element found in the XML. */
interface CellHit {
  start: number
  end: number
  tagEnd: number
  selfClosing: boolean
  attrs: string
  row: number
  col: number
  hasR: boolean
}

function* iterRows(xml: string, P: string, from: number, to: number) {
  const re = new RegExp(`<${P}row(?=[\\s>/])([^>]*?)(/?)>`, 'g')
  re.lastIndex = from
  let implicit = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) && m.index < to) {
    const r = /\sr\s*=\s*["'](\d+)["']/.exec(m[1])
    const row = r ? Number(r[1]) : implicit + 1
    implicit = row
    const contentStart = m.index + m[0].length
    yield {
      start: m.index,
      tag: m[0],
      attrs: m[1],
      row,
      hasR: !!r,
      selfClosing: m[2] === '/',
      contentStart,
      re
    }
  }
}

function rowEnd(xml: string, P: string, contentStart: number): number {
  const i = xml.indexOf(`</${P}row>`, contentStart)
  if (i < 0) throw new Error('unterminated <row>')
  return i
}

function cellsIn(xml: string, P: string, from: number, to: number, rowNum: number): CellHit[] {
  const out: CellHit[] = []
  const re = new RegExp(`<${P}c(?=[\\s>/])([^>]*?)(/?)>`, 'g')
  re.lastIndex = from
  let implicit = 0
  let m: RegExpExecArray | null
  const close = `</${P}c>`
  while ((m = re.exec(xml)) && m.index < to) {
    const r = /\sr\s*=\s*["']\$?([A-Za-z]{1,3})\$?(\d+)["']/.exec(m[1])
    const col = r ? parseRef(r[1] + r[2]).col : implicit + 1
    implicit = col
    const tagEnd = m.index + m[0].length
    let end = tagEnd
    if (m[2] !== '/') {
      end = xml.indexOf(close, tagEnd)
      if (end < 0 || end > to) throw new Error('unterminated <c>')
      end += close.length
    }
    out.push({
      start: m.index,
      end,
      tagEnd,
      selfClosing: m[2] === '/',
      attrs: m[1],
      row: rowNum,
      col,
      hasR: !!r
    })
    re.lastIndex = end
  }
  return out
}

export function sheetDataSpan(
  xml: string,
  P: string
): { open: number; start: number; end: number; selfClosing: boolean } {
  const m = new RegExp(`<${P}sheetData(?=[\\s>/])[^>]*?(/?)>`).exec(xml)
  if (!m) throw new Error('no <sheetData>')
  if (m[1] === '/')
    return {
      open: m.index,
      start: m.index + m[0].length,
      end: m.index + m[0].length,
      selfClosing: true
    }
  const end = xml.indexOf(`</${P}sheetData>`, m.index)
  return { open: m.index, start: m.index + m[0].length, end, selfClosing: false }
}

/** Array-formula ranges in the sheet (legacy CSE and dynamic-array spills). */
export function arrayRanges(
  xml: string,
  P: string
): { master: string; box: Box; dynamic: boolean }[] {
  const out: { master: string; box: Box; dynamic: boolean }[] = []
  const re = new RegExp(`<${P}f(?=[\\s>/])[^>]*?\\bt\\s*=\\s*["']array["'][^>]*>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const ref = /\bref\s*=\s*["']([^"']+)["']/.exec(m[0])
    const cStart = xml.lastIndexOf(`<${P}c`, m.index)
    const ctag = xml.slice(cStart, xml.indexOf('>', cStart) + 1)
    const r = /\sr\s*=\s*["']([^"']+)["']/.exec(ctag)
    if (!ref || !r) continue
    out.push({ master: r[1], box: parseRange(ref[1]), dynamic: /\scm\s*=/.test(ctag) })
  }
  return out
}

/** Column default styles from <cols>, which sits before <sheetData>: parsed once per patch. */
function colStyles(head: string, P: string): (col: number) => string | undefined {
  const spans: { min: number; max: number; style?: string }[] = []
  const re = new RegExp(`<${P}col(?=[\\s>/])([^>]*?)/?>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(head))) {
    const a = parseAttrs(m[1])
    spans.push({
      min: Number(attr(a, 'min')),
      max: Number(attr(a, 'max')),
      style: attr(a, 'style')
    })
  }
  return (col) => spans.find((x) => x.min <= col && col <= x.max)?.style
}

/** Attributes of the old cell that survive an overwrite: r, s and anything in an extension namespace. */
function keptAttrs(attrs: string): string {
  return parseAttrs(attrs)
    .filter((a) => a.name === 'r' || a.name === 's' || a.name.includes(':'))
    .map((a) => ` ${a.name}=${a.quote}${a.value}${a.quote}`)
    .join('')
}

function cellXml(P: string, base: string, w: CellWrite, opts: SheetOpts): string {
  switch (w.kind) {
    case 'clear':
      return `<${P}c${base}/>`
    case 'number':
      return `<${P}c${base}><${P}v>${numText(w.value)}</${P}v></${P}c>`
    case 'bool':
      return `<${P}c${base} t="b"><${P}v>${w.value ? 1 : 0}</${P}v></${P}c>`
    case 'text': {
      if (opts.strings === 'inline') {
        const sp = /^\s|\s$|\n/.test(w.value) ? ' xml:space="preserve"' : ''
        return `<${P}c${base} t="inlineStr"><${P}is><${P}t${sp}>${escText(w.value)}</${P}t></${P}is></${P}c>`
      }
      return `<${P}c${base} t="s"><${P}v>${opts.strings(w.value)}</${P}v></${P}c>`
    }
    case 'formula': {
      const t = w.cached && w.cached.t !== 'n' ? ` t="${w.cached.t}"` : ''
      const v = w.cached
        ? `<${P}v>${w.cached.t === 'str' ? escText(w.cached.v) : esc(w.cached.v)}</${P}v>`
        : ''
      return `<${P}c${base}${t}><${P}f>${esc(w.file)}</${P}f>${v}</${P}c>`
    }
  }
}

function splice(xml: string, spans: Span[]): string {
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  const parts: string[] = []
  let last = 0
  for (const s of spans) {
    if (s.start < last) throw new Error(`overlapping patches at ${s.start}`)
    parts.push(xml.slice(last, s.start), s.text)
    last = s.end
  }
  parts.push(xml.slice(last))
  return parts.join('')
}

/** Read a cell's formula element and cached value (inner = text between start tag and </c>). */
function parseInner(inner: string, P: string) {
  const f = new RegExp(`<${P}f(?=[\\s>/])([^>]*?)(?:/>|>([\\s\\S]*?)</${P}f>)`).exec(inner)
  const v = new RegExp(`<${P}v(?:\\s[^>]*)?>([\\s\\S]*?)</${P}v>|<${P}v\\s*/>`).exec(inner)
  return { f, v }
}

/**
 * Apply cell writes to one worksheet part. Returns the new XML; the caller re-zips it.
 */
export function patchSheet(
  xml: string,
  edits: Edit[],
  opts: SheetOpts
): { xml: string; report: SheetReport } {
  const P = rootPrefix(xml, 'worksheet')
  const report: SheetReport = {
    replaced: [],
    inserted: [],
    rowsInserted: [],
    remastered: [],
    expanded: [],
    arrayCleared: [],
    formulasRemoved: 0,
    formulasAdded: 0,
    warnings: []
  }
  if (!edits.length) return { xml, report }
  const sd = sheetDataSpan(xml, P)
  const styleOfCol = colStyles(xml.slice(0, sd.open), P)
  const spans: Span[] = []
  const byRow = new Map<number, Edit[]>()
  for (const e of edits) {
    const l = byRow.get(e.row) ?? []
    l.push(e)
    byRow.set(e.row, l)
  }
  for (const l of byRow.values()) l.sort((a, b) => a.col - b.col)
  const arrays = xml.includes('t="array"') || xml.includes("t='array'") ? arrayRanges(xml, P) : []
  const editKeys = new Set(edits.map((e) => `${e.row},${e.col}`))
  const clearCells = new Set<string>() // array cells to blank because their master is overwritten
  for (const e of edits) {
    for (const a of arrays) {
      if (!inBox(a.box, e.row, e.col)) continue
      const m = parseRef(a.master)
      const single = a.box.r1 === a.box.r2 && a.box.c1 === a.box.c2
      if (m.row === e.row && m.col === e.col) {
        if (!single) {
          report.arrayCleared.push(`${a.master}:${refName(a.box.r2, a.box.c2)}`)
          for (let r = a.box.r1; r <= a.box.r2; r++)
            for (let c = a.box.c1; c <= a.box.c2; c++)
              if (!(r === m.row && c === m.col) && !editKeys.has(`${r},${c}`))
                clearCells.add(`${r},${c}`)
        }
      } else if (!a.dynamic) {
        throw new Error(
          `${refName(e.row, e.col)} is part of the array formula at ${a.master}; Excel refuses to change part of an array`
        )
      } else if (!edits.some((x) => x.row === m.row && x.col === m.col)) {
        report.warnings.push(
          `${refName(e.row, e.col)} is in the spill range of ${a.master}: Excel will show #SPILL! there`
        )
      }
    }
  }
  const rowsTouched = new Set<number>([
    ...byRow.keys(),
    ...[...clearCells].map((k) => Number(k.split(',')[0]))
  ])
  const sharedMasters: { si: string; text: string; row: number; col: number }[] = []
  const insertBefore = new Map<number, number>() // target row → offset of first row past it
  const seenRows = new Set<number>()
  let maxRowSeen = 0
  let anyImplicit = false
  const newCells: { row: number; col: number }[] = []

  const touchedSorted = [...rowsTouched].sort((a, b) => a - b)
  let ti = 0
  for (const row of iterRows(xml, P, sd.start, sd.end)) {
    if (!row.hasR) anyImplicit = true
    if (row.row < maxRowSeen) throw new Error(`rows out of order at ${row.row}`)
    maxRowSeen = row.row
    while (ti < touchedSorted.length && touchedSorted[ti] <= row.row) {
      if (touchedSorted[ti] < row.row) insertBefore.set(touchedSorted[ti], row.start)
      ti++
    }
    if (!rowsTouched.has(row.row)) continue
    seenRows.add(row.row)
    const rEdits = byRow.get(row.row) ?? []
    const ce = row.selfClosing ? row.contentStart : rowEnd(xml, P, row.contentStart)
    const cells = row.selfClosing ? [] : cellsIn(xml, P, row.contentStart, ce, row.row)
    row.re.lastIndex = ce
    const rowAttrs = parseAttrs(row.attrs)
    const rowStyle =
      attr(rowAttrs, 'customFormat') === '1' || attr(rowAttrs, 'customFormat') === 'true'
        ? attr(rowAttrs, 's')
        : undefined
    const inserts: { at: number; text: string }[] = []
    let maxCol = 0
    for (const e of rEdits) {
      const hit = cells.find((c) => c.col === e.col)
      if (hit) {
        const inner = hit.selfClosing ? '' : xml.slice(hit.tagEnd, hit.end - `</${P}c>`.length)
        const { f } = parseInner(inner, P)
        if (f) {
          report.formulasRemoved += e.write.kind === 'formula' ? 0 : 1
          const fa = parseAttrs(f[1])
          if (attr(fa, 't') === 'shared' && attr(fa, 'ref') && f[2])
            sharedMasters.push({ si: attr(fa, 'si')!, text: unesc(f[2]), row: e.row, col: e.col })
        } else if (e.write.kind === 'formula') report.formulasAdded++
        let base = keptAttrs(hit.attrs)
        if (!hit.hasR) base = base.replace(/\sr=["'][^"']*["']/, '')
        spans.push({ start: hit.start, end: hit.end, text: cellXml(P, base, e.write, opts) })
        report.replaced.push(refName(e.row, e.col))
      } else {
        if (e.write.kind === 'clear') continue
        if (cells.some((c) => !c.hasR))
          throw new Error(
            `row ${row.row} has cells without r=; inserting a cell would renumber them`
          )
        if (e.write.kind === 'formula') report.formulasAdded++
        const style = rowStyle ?? styleOfCol(e.col)
        const base = ` r="${refName(e.row, e.col)}"${style && style !== '0' ? ` s="${style}"` : ''}`
        const next = cells.find((c) => c.col > e.col)
        inserts.push({ at: next ? next.start : ce, text: cellXml(P, base, e.write, opts) })
        report.inserted.push(refName(e.row, e.col))
        newCells.push({ row: e.row, col: e.col })
        maxCol = Math.max(maxCol, e.col)
      }
    }
    for (const c of cells) {
      if (!clearCells.has(`${c.row},${c.col}`)) continue
      const base = keptAttrs(c.attrs)
      spans.push({ start: c.start, end: c.end, text: `<${P}c${base}/>` })
    }
    // group inserts at the same offset, keeping column order
    const grouped = new Map<number, string>()
    for (const i of inserts) grouped.set(i.at, (grouped.get(i.at) ?? '') + i.text)
    // spans="a:b" is an optimisation hint; widen it when a cell lands outside
    let tag = row.tag
    const sp = attr(rowAttrs, 'spans')
    if (sp && maxCol) {
      const [lo0, hi0] = sp.split(':').map(Number)
      const lo = Math.min(lo0, ...(inserts.length ? rEdits.map((e) => e.col) : [lo0])),
        hi = Math.max(hi0, maxCol)
      if (lo !== lo0 || hi !== hi0) tag = setAttrInTag(tag, 'spans', `${lo}:${hi}`)
    }
    if (row.selfClosing && grouped.size) {
      // <row r="5"/> → <row r="5">…</row>
      spans.push({
        start: row.start,
        end: row.contentStart,
        text: tag.replace(/\s*\/>$/, '>') + [...grouped.values()].join('') + `</${P}row>`
      })
    } else {
      if (tag !== row.tag) spans.push({ start: row.start, end: row.contentStart, text: tag })
      for (const [at, text] of grouped) spans.push({ start: at, end: at, text })
    }
  }
  // rows that do not exist yet
  const missing = [...byRow.keys()]
    .filter((r) => !seenRows.has(r) && byRow.get(r)!.some((e) => e.write.kind !== 'clear'))
    .sort((a, b) => a - b)
  if (missing.length && anyImplicit)
    throw new Error('sheet has rows without r=; inserting a row would renumber them')
  const newRows = new Map<number, string>()
  for (const r of missing) {
    const at = insertBefore.get(r) ?? sd.end
    const cells = byRow
      .get(r)!
      .filter((e) => e.write.kind !== 'clear')
      .map((e) => {
        if (e.write.kind === 'formula') report.formulasAdded++
        const style = styleOfCol(e.col)
        newCells.push({ row: r, col: e.col })
        report.inserted.push(refName(r, e.col))
        return cellXml(
          P,
          ` r="${refName(r, e.col)}"${style && style !== '0' ? ` s="${style}"` : ''}`,
          e.write,
          opts
        )
      })
      .join('')
    newRows.set(at, (newRows.get(at) ?? '') + `<${P}row r="${r}">${cells}</${P}row>`)
    report.rowsInserted.push(r)
  }
  for (const [at, text] of newRows) {
    if (sd.selfClosing) continue
    spans.push({ start: at, end: at, text })
  }
  if (sd.selfClosing && newRows.size) {
    const tag = xml.slice(sd.open, sd.start).replace(/\s*\/>$/, '>')
    spans.push({
      start: sd.open,
      end: sd.start,
      text: tag + [...newRows.values()].join('') + `</${P}sheetData>`
    })
  }

  // shared-formula masters being overwritten: hand the formula to the remaining cells of the group
  for (const sm of sharedMasters) remaster(xml, P, sd, sm, editKeys, spans, report)

  // <dimension ref> covers the used range
  if (newCells.length) {
    const dm = new RegExp(`<${P}dimension(?=[\\s>/])[^>]*?/?>`).exec(xml)
    if (dm) {
      const ref = /\bref\s*=\s*["']([^"']+)["']/.exec(dm[0])
      if (ref) {
        const b = parseRange(ref[1])
        const nb = { ...b }
        for (const c of newCells) {
          nb.r1 = Math.min(nb.r1, c.row)
          nb.r2 = Math.max(nb.r2, c.row)
          nb.c1 = Math.min(nb.c1, c.col)
          nb.c2 = Math.max(nb.c2, c.col)
        }
        const empty = ref[1] === 'A1' && maxRowSeen === 0
        const box = empty
          ? newCells.reduce(
              (acc, c) => ({
                r1: Math.min(acc.r1, c.row),
                c1: Math.min(acc.c1, c.col),
                r2: Math.max(acc.r2, c.row),
                c2: Math.max(acc.c2, c.col)
              }),
              { r1: 1e9, c1: 1e9, r2: 0, c2: 0 }
            )
          : nb
        const text =
          box.r1 === box.r2 && box.c1 === box.c2
            ? refName(box.r1, box.c1)
            : `${refName(box.r1, box.c1)}:${refName(box.r2, box.c2)}`
        if (text !== ref[1])
          spans.push({
            start: dm.index,
            end: dm.index + dm[0].length,
            text: setAttrInTag(dm[0], 'ref', text)
          })
      }
    }
  }
  return { xml: splice(xml, spans), report }
}

/** Move a shared formula's text from an overwritten master to the rest of its group. */
function remaster(
  xml: string,
  P: string,
  sd: { start: number; end: number },
  sm: { si: string; text: string; row: number; col: number },
  editKeys: Set<string>,
  spans: Span[],
  report: SheetReport
) {
  const re = new RegExp(
    `<${P}f(?=[\\s>/])[^>]*?\\bsi\\s*=\\s*["']${sm.si}["'][^>]*?(?:/>|>[\\s\\S]*?</${P}f>)`,
    'g'
  )
  re.lastIndex = sd.start
  const children: { start: number; end: number; tag: string; row: number; col: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) && m.index < sd.end) {
    if (!/\bt\s*=\s*["']shared["']/.test(m[0])) continue
    const cStart = xml.lastIndexOf(`<${P}c`, m.index)
    const ctag = xml.slice(cStart, xml.indexOf('>', cStart))
    const r = /\sr\s*=\s*["']([^"']+)["']/.exec(ctag)
    if (!r) throw new Error('shared formula child without r=')
    const { row, col } = parseRef(r[1])
    if ((row === sm.row && col === sm.col) || editKeys.has(`${row},${col}`)) continue
    children.push({ start: m.index, end: m.index + m[0].length, tag: m[0], row, col })
  }
  if (!children.length) return
  const box = children.reduce(
    (b, c) => ({
      r1: Math.min(b.r1, c.row),
      c1: Math.min(b.c1, c.col),
      r2: Math.max(b.r2, c.row),
      c2: Math.max(b.c2, c.col)
    }),
    { r1: 1e9, c1: 1e9, r2: 0, c2: 0 }
  )
  const first = children[0]
  const fOpen = (t: string) => t.slice(0, t.indexOf('>') + 1).replace(/\s*\/>$/, '>')
  if (first.row === box.r1 && first.col === box.c1) {
    // the first remaining cell is the group's top-left: it becomes the new master
    const text = translate(sm.text, first.row - sm.row, first.col - sm.col)
    let open = fOpen(first.tag)
    open = setAttrInTag(
      open,
      'ref',
      box.r1 === box.r2 && box.c1 === box.c2
        ? refName(box.r1, box.c1)
        : `${refName(box.r1, box.c1)}:${refName(box.r2, box.c2)}`
    )
    spans.push({ start: first.start, end: first.end, text: `${open}${esc(text)}</${P}f>` })
    report.remastered.push(
      `si=${sm.si} ${refName(sm.row, sm.col)}→${refName(first.row, first.col)}`
    )
  } else {
    // no cell can be the top-left master: write every remaining cell's formula out in full
    for (const c of children) {
      const text = translate(sm.text, c.row - sm.row, c.col - sm.col)
      let open = fOpen(c.tag)
      for (const a of ['t', 'si', 'ref']) open = removeAttrInTag(open, a)
      spans.push({ start: c.start, end: c.end, text: `${open}${esc(text)}</${P}f>` })
    }
    report.expanded.push(`si=${sm.si}: ${children.length} cells`)
  }
}

// ---------------------------------------------------------------- cached values of formula cells
export interface ValueHit {
  ref: string
  old: Cached | null
  status: 'patched' | 'missing' | 'not-formula' | 'stale'
}

const cachedOf = (tAttr: string | undefined, v: string | null): Cached | null => {
  if (v === null) return null
  const t =
    tAttr === 'str' || tAttr === 'b' || tAttr === 'e'
      ? tAttr
      : tAttr === 's' || tAttr === 'inlineStr'
        ? 'str'
        : 'n'
  return { t, v: unesc(v) }
}

/**
 * Replace the cached <v> of formula cells (and of cells inside array/spill ranges).
 * `accept(old)` decides per cell whether the engine's value may replace what is stored.
 */
export function patchValues(
  xml: string,
  values: Map<string, Cached>,
  accept: (ref: string, old: Cached | null) => boolean
): { xml: string; hits: ValueHit[] } {
  const P = rootPrefix(xml, 'worksheet')
  const hits: ValueHit[] = []
  if (!values.size) return { xml, hits }
  const sd = sheetDataSpan(xml, P)
  const want = new Map<number, { col: number; ref: string; val: Cached }[]>()
  for (const [ref, val] of values) {
    const p = parseRef(ref)
    const l = want.get(p.row) ?? []
    l.push({ col: p.col, ref, val })
    want.set(p.row, l)
  }
  const arrays = xml.includes('array') ? arrayRanges(xml, P) : []
  const spans: Span[] = []
  const found = new Set<string>()
  for (const row of iterRows(xml, P, sd.start, sd.end)) {
    const w = want.get(row.row)
    if (!w || row.selfClosing) continue
    const ce = rowEnd(xml, P, row.contentStart)
    const cells = cellsIn(xml, P, row.contentStart, ce, row.row)
    row.re.lastIndex = ce
    for (const x of w) {
      const c = cells.find((k) => k.col === x.col)
      if (!c) continue
      found.add(x.ref)
      const inner = c.selfClosing ? '' : xml.slice(c.tagEnd, c.end - `</${P}c>`.length)
      const { f, v } = parseInner(inner, P)
      const inArray = arrays.some((a) => inBox(a.box, row.row, x.col))
      const tAttr = attr(parseAttrs(c.attrs), 't')
      const old = cachedOf(tAttr, v ? (v[1] ?? '') : null)
      if (!f && !inArray) {
        hits.push({ ref: x.ref, old, status: 'not-formula' })
        continue
      }
      if (!accept(x.ref, old)) {
        hits.push({ ref: x.ref, old, status: 'stale' })
        continue
      }
      const vText = `<${P}v>${x.val.t === 'str' ? escText(x.val.v) : esc(x.val.v)}</${P}v>`
      let tag = xml.slice(c.start, c.tagEnd)
      tag = x.val.t === 'n' ? removeAttrInTag(tag, 't') : setAttrInTag(tag, 't', x.val.t)
      if (c.selfClosing) {
        spans.push({
          start: c.start,
          end: c.end,
          text: tag.replace(/\s*\/>$/, '>') + vText + `</${P}c>`
        })
      } else {
        if (tag !== xml.slice(c.start, c.tagEnd))
          spans.push({ start: c.start, end: c.tagEnd, text: tag })
        if (v)
          spans.push({
            start: c.tagEnd + v.index,
            end: c.tagEnd + v.index + v[0].length,
            text: vText
          })
        else {
          // no <v> yet: it goes after </f> (CT_Cell sequence f, v, is, extLst)
          const at = f ? c.tagEnd + f.index + f[0].length : c.tagEnd
          spans.push({ start: at, end: at, text: vText })
        }
      }
      hits.push({ ref: x.ref, old, status: 'patched' })
    }
  }
  for (const ref of values.keys())
    if (!found.has(ref)) hits.push({ ref, old: null, status: 'missing' })
  return { xml: splice(xml, spans), hits }
}

/** Every formula cell's (and array cell's) stored value, for auditing an engine against the file. */
export function scanCached(xml: string): Map<string, Cached | null> {
  const P = rootPrefix(xml, 'worksheet')
  const out = new Map<string, Cached | null>()
  const sd = sheetDataSpan(xml, P)
  const arrays = xml.includes('array') ? arrayRanges(xml, P) : []
  const re = new RegExp(`<${P}c(?=[\\s>/])([^>]*?)(/?)>`, 'g')
  re.lastIndex = sd.start
  const close = `</${P}c>`,
    fOpen = `<${P}f`,
    vRe = new RegExp(`<${P}v(?:\\s[^>]*)?>([\\s\\S]*?)</${P}v>`)
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) && m.index < sd.end) {
    if (m[2] === '/') continue
    const end = xml.indexOf(close, re.lastIndex)
    const inner = xml.slice(re.lastIndex, end)
    re.lastIndex = end + close.length
    const r = /\sr\s*=\s*["']([^"']+)["']/.exec(m[1])
    if (!r) continue
    const isF = inner.includes(fOpen)
    if (!isF) {
      if (!arrays.length) continue
      const p = parseRef(r[1])
      if (!arrays.some((a) => inBox(a.box, p.row, p.col))) continue
    }
    const v = vRe.exec(inner)
    const t = /\st\s*=\s*["']([^"']+)["']/.exec(m[1])
    out.set(r[1], cachedOf(t?.[1], v ? v[1] : null))
  }
  return out
}

export { colName }
