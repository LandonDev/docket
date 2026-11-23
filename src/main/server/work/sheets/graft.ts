import { readRels, relsPath, workbookMap } from './patch/patch'
import { readEntry, readText, readZip, writeZip, type Zip } from './patch/zip'
import { colName, colNum, type Box } from './patch/xml'
import { mapCell, mapRange, type StructuralOp } from './structural'

/**
 * Puts back into LibreOffice's package what LibreOffice drops when it writes
 * an opened file again (measured on the research corpus, M27.md):
 *
 * - the macro project, byte for byte (LibreOffice writes its own copy);
 * - workbook parts it does not know (dynamic-array and in-cell picture
 *   metadata, rich values) with the cell marks (`cm`, `vm`) that point into
 *   them, each mark moved with its cell;
 * - chartsheets (LibreOffice turns one into a worksheet holding the chart):
 *   the original chartsheet, its drawing and chart come back in its place,
 *   with the chart's ranges moved by the rows and columns inserted or deleted.
 *
 * - a chart series' typed name (`<c:tx><c:v>`): after a move LibreOffice
 *   writes a reference to a moved cell in its place, and the legend then
 *   shows that cell's value; after an insert it writes the text as a formula
 *   (`"Block"`). Either way the typed name comes back, on its own chart alone
 *   (`typedSeriesNames`, `withTypedNames`): a series named from a cell never
 *   takes another chart's typed name.
 *
 * And takes out one thing LibreOffice leaves behind: after a block is moved, a
 * conditional format that covered part of the block still names some of the
 * cells the block left (`offVacated`). Excel leaves no format on a cell that
 * was cut.
 *
 * Every other part is LibreOffice's.
 */

const enc = new TextEncoder()
const KEEP_TYPES = /\/(sheetMetadata|rd[A-Za-z]+|richValue[A-Za-z]*|richStyles)$/

export interface Grafted {
  bytes: Uint8Array
  /** what was put back, one line each */
  notes: string[]
}

/** The parts reachable from `part` through its relationships, `part` included, that are in the zip. */
function closure(z: Zip, part: string, seen = new Set<string>()): Set<string> {
  if (seen.has(part) || !z.byName.has(part)) return seen
  seen.add(part)
  const rels = relsPath(part)
  if (z.byName.has(rels)) {
    seen.add(rels)
    for (const r of readRels(z, part).rels) if (!r.external) closure(z, r.target, seen)
  }
  return seen
}

function contentTypeOf(types: string, part: string): string | null {
  const m = new RegExp(
    `<Override[^>]*PartName="/${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*ContentType="([^"]+)"`
  ).exec(types)
  const m2 =
    m ??
    new RegExp(
      `<Override[^>]*ContentType="([^"]+)"[^>]*PartName="/${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`
    ).exec(types)
  return m2?.[1] ?? null
}

/** A sheet-qualified range in a chart's formula, moved through the ops as LibreOffice moves a reference (`mapRange`; a range that is gone keeps its text). */
export function moveChartRef(formula: string, ops: readonly StructuralOp[]): string {
  return formula.replace(
    /((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/g,
    (all, qual: string, c1: string, r1: string, c2?: string, r2?: string) => {
      let sheet = qual.slice(0, -1)
      if (sheet.startsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'")
      const from = { row: Number(r1) - 1, col: colNum(c1) - 1 }
      const to = c2 && r2 ? { row: Number(r2) - 1, col: colNum(c2) - 1 } : from
      const got = mapRange(ops, { sheet, r1: from.row, c1: from.col, r2: to.row, c2: to.col })
      if (!got) return all
      const q = /^[A-Za-z_][\w.]*$/.test(got.sheet) ? got.sheet : `'${got.sheet.replace(/'/g, "''")}'`
      const cell = (row: number, col: number) => `$${colName(col + 1)}$${row + 1}`
      return c2 ? `${q}!${cell(got.r1, got.c1)}:${cell(got.r2, got.c2)}` : `${q}!${cell(got.r1, got.c1)}`
    }
  )
}

const SERIES = /<c:ser>[\s\S]*?<\/c:ser>/g
const nameOfSeries = (ser: string): string | undefined => /<c:tx>[\s\S]*?<\/c:tx>/.exec(ser)?.[0]
/** The ranges a series reads (categories, values, a scatter's or a bubble's), each through `move`, as one key; '' when it reads none. */
function rangesOfSeries(ser: string, move: (formula: string) => string): string {
  const refs = ['cat', 'val', 'xVal', 'yVal', 'bubbleSize'].map((tag) => new RegExp(`<c:${tag}>[\\s\\S]*?<c:f>([^<]*)</c:f>[\\s\\S]*?</c:${tag}>`).exec(ser)?.[1] ?? '')
  if (refs.every((r) => !r)) return ''
  return refs.map((r) => move(r.replace(/&apos;/g, "'")).replace(/[$']/g, '')).join('\n')
}
/** A chart's series: the ranges each reads and its name element ('' when it has none). */
const seriesOf = (xml: string, move: (formula: string) => string): { key: string; name: string }[] =>
  [...xml.matchAll(SERIES)].map(([ser]) => ({ key: rangesOfSeries(ser, move), name: nameOfSeries(ser) ?? '' }))
/** What tells one chart from another here: the ranges its series read, all of them. */
const printOf = (series: readonly { key: string }[]): string =>
  series
    .map((s) => s.key)
    .sort()
    .join('\n\n')

/** A chart's typed series names, by the chart's print and then by the ranges a series reads. */
export type TypedNames = Map<string, Map<string, string>>

/**
 * The typed series names of the original's charts, each kept under its own chart: a chart is known
 * in LibreOffice's file by the ranges all its series read once the ops have moved them (its print),
 * and a series in it by its own ranges. A typed name is put back only where that cannot go wrong:
 * two charts with the same print that name a series differently (one typed and one read from a
 * cell, over the same data) are both left as LibreOffice wrote them, and so is a series whose
 * ranges another series of its chart reads under another name.
 */
export function typedSeriesNames(charts: readonly string[], ops: readonly StructuralOp[]): TypedNames {
  const byPrint = new Map<string, Map<string, string | null>[]>()
  for (const xml of charts) {
    const series = seriesOf(xml, (f) => moveChartRef(f, ops))
    if (!series.length) continue
    const names = new Map<string, string | null>()
    for (const s of series) names.set(s.key, names.has(s.key) && names.get(s.key) !== s.name ? null : s.name)
    const print = printOf(series)
    byPrint.set(print, [...(byPrint.get(print) ?? []), names])
  }
  const out: TypedNames = new Map()
  for (const [print, same] of byPrint) {
    const [first, ...rest] = same
    if (!rest.every((names) => [...first].every(([key, name]) => names.get(key) === name))) continue
    const typed = new Map([...first].filter((e): e is [string, string] => !!e[0] && !!e[1] && /^<c:tx>\s*<c:v>/.test(e[1])))
    if (typed.size) out.set(print, typed)
  }
  return out
}

/**
 * The typed-name series of the original's charts that `typedSeriesNames` would not put back after
 * the ops, each as the ranges it reads as the file stands (its `<c:f>` texts). A move that takes
 * cells one of them reads is not saved: LibreOffice writes a moved cell in the name's place.
 */
export function typedNamesAtRisk(charts: readonly string[], ops: readonly StructuralOp[]): string[][] {
  const typed = typedSeriesNames(charts, ops)
  const move = (f: string): string => moveChartRef(f, ops)
  const out: string[][] = []
  for (const xml of charts) {
    const names = typed.get(printOf(seriesOf(xml, move)))
    for (const [ser] of xml.matchAll(SERIES)) {
      if (!/^<c:tx>\s*<c:v>/.test(nameOfSeries(ser) ?? '')) continue
      if (names?.has(rangesOfSeries(ser, move))) continue
      out.push([...ser.replace(/<c:tx>[\s\S]*?<\/c:tx>/, '').matchAll(/<c:f>([^<]*)<\/c:f>/g)].map((m) => m[1]))
    }
  }
  return out
}

/** A chart LibreOffice wrote, with each series' typed name put back where it wrote a cell reference for one. */
export function withTypedNames(xml: string, typed: TypedNames): string {
  const names = typed.size ? typed.get(printOf(seriesOf(xml, (f) => f))) : undefined
  if (!names) return xml
  return xml.replace(SERIES, (ser) => {
    const name = nameOfSeries(ser)
    if (!name || !name.includes('<c:strRef>')) return ser
    const was = names.get(rangesOfSeries(ser, (f) => f))
    // (a function, so a `$` in a typed name is itself)
    return was ? ser.replace(name, () => was) : ser
  })
}

/** `a` without the cells of `b`: no box, or up to four. */
export function boxWithout(a: Box, b: Box): Box[] {
  if (b.r1 > a.r2 || b.r2 < a.r1 || b.c1 > a.c2 || b.c2 < a.c1) return [a]
  const out: Box[] = []
  if (b.r1 > a.r1) out.push({ r1: a.r1, c1: a.c1, r2: b.r1 - 1, c2: a.c2 })
  if (b.r2 < a.r2) out.push({ r1: b.r2 + 1, c1: a.c1, r2: a.r2, c2: a.c2 })
  const r1 = Math.max(a.r1, b.r1)
  const r2 = Math.min(a.r2, b.r2)
  if (b.c1 > a.c1) out.push({ r1, c1: a.c1, r2, c2: b.c1 - 1 })
  if (b.c2 < a.c2) out.push({ r1, c1: b.c2 + 1, r2, c2: a.c2 })
  return out
}

/** The cells a moved block left empty: the block, less where it landed when that is on its own sheet. Zero-based. */
export function vacatedBy(op: Extract<StructuralOp, { op: 'moveRange' }>): Box[] {
  const src: Box = { r1: op.r1, c1: op.c1, r2: op.r2, c2: op.c2 }
  if (op.to !== op.sheet) return [src]
  return boxWithout(src, { r1: op.row, c1: op.col, r2: op.row + op.r2 - op.r1, c2: op.col + op.c2 - op.c1 })
}

/**
 * A worksheet's XML with no conditional format on the `vacated` cells: each format's list of cells
 * and ranges (`sqref`, or `<xm:sqref>` in Excel 2010's extended list) loses them, and a format left
 * with no cell goes. Text that names none of them comes back as it was.
 */
export function offVacated(xml: string, vacated: readonly Box[]): string {
  const less = (sqref: string): string | null => {
    let changed = false
    const out: string[] = []
    for (const ref of sqref.trim().split(/\s+/)) {
      const m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(ref)
      if (!m) {
        out.push(ref)
        continue
      }
      const a = { row: Number(m[2]) - 1, col: colNum(m[1]) - 1 }
      const b = m[3] ? { row: Number(m[4]) - 1, col: colNum(m[3]) - 1 } : a
      let boxes: Box[] = [{ r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) }]
      for (const v of vacated) boxes = boxes.flatMap((x) => boxWithout(x, v))
      const said = boxes.map((x) => (x.r1 === x.r2 && x.c1 === x.c2 ? `${colName(x.c1 + 1)}${x.r1 + 1}` : `${colName(x.c1 + 1)}${x.r1 + 1}:${colName(x.c2 + 1)}${x.r2 + 1}`))
      if (said.length !== 1 || said[0] !== ref.replace(/\$/g, '')) changed = true
      out.push(...said)
    }
    return changed ? out.join(' ') : null
  }
  return xml.replace(/<((?:[\w.-]+:)?conditionalFormatting)\b([^>]*)>([\s\S]*?)<\/\1>/g, (all, tag: string, attrs: string, inner: string) => {
    const own = /\ssqref="([^"]*)"/.exec(attrs)
    if (own) {
      const got = less(own[1])
      if (got === null) return all
      return got ? `<${tag}${attrs.replace(own[0], ` sqref="${got}"`)}>${inner}</${tag}>` : ''
    }
    const child = /(<((?:[\w.-]+:)?sqref)>)([^<]*)(<\/\2>)/.exec(inner)
    if (!child) return all
    const got = less(child[3])
    if (got === null) return all
    return got ? `<${tag}${attrs}>${inner.replace(child[0], `${child[1]}${got}${child[4]}`)}</${tag}>` : ''
  })
}

export function graft(
  original: Uint8Array,
  written: Uint8Array,
  ops: readonly StructuralOp[]
): Grafted {
  const o = readZip(original)
  const w = readZip(written)
  const notes: string[] = []
  const replace = new Map<string, Uint8Array>()
  const add = new Map<string, Uint8Array>()
  const remove = new Set<string>()
  const owb = workbookMap(o)
  const wwb = workbookMap(w)
  let types = readText(w, '[Content_Types].xml')
  const otypes = readText(o, '[Content_Types].xml')
  let wbRels = wwb.wbRels.text
  const has = (name: string): boolean => (w.byName.has(name) && !remove.has(name)) || add.has(name)
  const override = (part: string): void => {
    const t = contentTypeOf(otypes, part)
    if (t && !types.includes(`PartName="/${part}"`))
      types = types.replace(
        '</Types>',
        `<Override PartName="/${part}" ContentType="${t}"/></Types>`
      )
    const ext = part.split('.').pop()!
    const def = new RegExp(`<Default[^>]*Extension="${ext}"[^>]*/>`, 'i').exec(otypes)?.[0]
    if (def && !new RegExp(`Extension="${ext}"`, 'i').test(types))
      types = types.replace('</Types>', `${def}</Types>`)
  }
  const relId = (): string => {
    let n = 1
    while (wbRels.includes(`Id="rIdTc${n}"`)) n++
    return `rIdTc${n}`
  }
  const relTarget = (part: string): string =>
    part.startsWith(`${wwb.wbPart.split('/').slice(0, -1).join('/')}/`)
      ? part.slice(wwb.wbPart.lastIndexOf('/') + 1)
      : `/${part}`

  // 1. The macro project, as it was.
  const vba = [...o.byName.keys()].find((n) => /vbaProject\.bin$/i.test(n))
  if (vba) {
    const at = [...w.byName.keys()].find((n) => /vbaProject\.bin$/i.test(n))
    if (at) {
      replace.set(at, readEntry(o, vba))
      notes.push('kept the macro project byte for byte')
    }
  }

  // 2. Workbook parts LibreOffice does not know, and the cell marks that point into them.
  let marks = false
  for (const r of owb.wbRels.rels) {
    if (!KEEP_TYPES.test(r.type) || r.external || has(r.target)) continue
    for (const part of closure(o, r.target)) {
      if (has(part)) continue
      add.set(part, readEntry(o, part))
      if (!part.endsWith('.rels')) override(part)
    }
    wbRels = wbRels.replace(
      /<\/Relationships>\s*$/,
      `<Relationship Id="${relId()}" Type="${r.type}" Target="${relTarget(r.target)}"/></Relationships>`
    )
    notes.push(`kept ${r.target}`)
    marks = true
  }
  if (marks || ops.length) {
    for (const sh of owb.sheets.filter((s) => s.kind === 'worksheet')) {
      const xml = readText(o, sh.part)
      const found = [...xml.matchAll(/<(?:[\w.-]+:)?c\s[^>]*\br="([A-Z]+)(\d+)"[^>]*>/g)]
        .map((m) => ({
          col: colNum(m[1]) - 1,
          row: Number(m[2]) - 1,
          cm: /\bcm="([^"]+)"/.exec(m[0])?.[1],
          vm: /\bvm="([^"]+)"/.exec(m[0])?.[1]
        }))
        .filter((c) => c.cm || c.vm)
      if (!found.length) continue
      const byMark = new Map<string, { cm?: string; vm?: string }>()
      for (const c of found) {
        const to = mapCell(ops, sh.name, c.row, c.col)
        if (to)
          byMark.set(`${to.sheet}\u0000${colName(to.col + 1)}${to.row + 1}`, { cm: c.cm, vm: c.vm })
      }
      for (const target of wwb.sheets) {
        const part = target.part
        let out = replace.has(part)
          ? new TextDecoder().decode(replace.get(part))
          : readText(w, part)
        const before = out
        out = out.replace(
          /<((?:[\w.-]+:)?c)(\s[^>]*?\br="([A-Z]+\d+)"[^>]*?)(\/?)>/g,
          (tag, name: string, attrs: string, ref: string, close: string) => {
            const m = byMark.get(`${target.name}\u0000${ref}`)
            if (!m) return tag
            let a = attrs
            if (m.cm && !/\bcm=/.test(a)) a += ` cm="${m.cm}"`
            if (m.vm && !/\bvm=/.test(a)) a += ` vm="${m.vm}"`
            return `<${name}${a}${close}>`
          }
        )
        if (out !== before) replace.set(part, enc.encode(out))
      }
    }
  }

  // 2b. After a block moved, no conditional format stays on the cells it left.
  const block = ops.length === 1 && ops[0].op === 'moveRange' ? ops[0] : null
  const left = block ? wwb.sheets.find((s) => s.name === block.sheet && s.kind === 'worksheet') : undefined
  if (block && left) {
    const xml = replace.has(left.part) ? new TextDecoder().decode(replace.get(left.part)) : readText(w, left.part)
    const out = offVacated(xml, vacatedBy(block))
    if (out !== xml) {
      replace.set(left.part, enc.encode(out))
      notes.push(`took the conditional formats off the cells the block left in ${left.name}`)
    }
  }

  // 3. Chartsheets, in the place LibreOffice gave them as worksheets.
  for (const cs of owb.sheets.filter((s) => s.kind === 'chartsheet')) {
    const to = mapCell(ops, cs.name, 0, 0)
    if (!to) continue
    const made = wwb.sheets.find((s) => s.name === to.sheet)
    if (!made || made.kind === 'chartsheet') continue
    const rel = wwb.wbRels.rels.find((r) => r.target === made.part)
    if (!rel) continue
    // LibreOffice's stand-in worksheet goes, with what hangs off it.
    for (const part of closure(w, made.part)) if (!part.startsWith('xl/media/')) remove.add(part)
    // The original's chartsheet, drawing and chart come back under names of our own.
    const rename = new Map<string, string>()
    for (const part of closure(o, cs.part)) {
      if (part.endsWith('.rels')) continue
      // The next free name of the same kind (`chartsheets/sheet2.xml`, `charts/chart13.xml`): readers count parts by name.
      const m = /^(.*?)(\d*)(\.[^./]+)$/.exec(part)!
      let i = 1
      while (has(`${m[1]}${i}${m[3]}`) || [...rename.values()].includes(`${m[1]}${i}${m[3]}`)) i++
      rename.set(part, `${m[1]}${i}${m[3]}`)
    }
    for (const [from, toPart] of rename) {
      let bytes = readEntry(o, from)
      if (/\/charts\/chart[^/]*\.xml$/.test(from))
        bytes = enc.encode(
          readText(o, from).replace(
            /(<c:f>)([^<]*)(<\/c:f>)/g,
            (_a, open: string, f: string, close: string) => `${open}${moveChartRef(f, ops)}${close}`
          )
        )
      add.set(toPart, bytes)
      const t = contentTypeOf(otypes, from)
      if (t)
        types = types.replace(
          '</Types>',
          `<Override PartName="/${toPart}" ContentType="${t}"/></Types>`
        )
      const rels = relsPath(from)
      if (o.byName.has(rels)) {
        const targets = new Map(readRels(o, from).rels.map((r) => [r.id, r.target]))
        const text = readText(o, rels).replace(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g, (tag) => {
          const moved = rename.get(targets.get(/\bId="([^"]+)"/.exec(tag)?.[1] ?? '') ?? '')
          return moved ? tag.replace(/Target="[^"]*"/, `Target="${relative(toPart, moved)}"`) : tag
        })
        add.set(relsPath(toPart), enc.encode(text))
      }
    }
    for (const part of remove)
      types = types.replace(
        new RegExp(
          `<Override[^>]*PartName="/${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`
        ),
        ''
      )
    const type = owb.wbRels.rels.find((r) => r.target === cs.part)!.type
    wbRels = wbRels.replace(
      new RegExp(`<Relationship\\b[^>]*\\bId="${rel.id}"[^>]*/>`),
      `<Relationship Id="${rel.id}" Type="${type}" Target="${relTarget(rename.get(cs.part)!)}"/>`
    )
    notes.push(`kept the chartsheet ${to.sheet}`)
  }

  // 4. A series' typed name, where LibreOffice wrote a cell reference for it.
  const isChart = (name: string): boolean => /\/charts\/chart[^/]*\.xml$/.test(name)
  const typed = typedSeriesNames([...o.byName.keys()].filter(isChart).map((name) => readText(o, name)), ops)
  if (typed.size) {
    let kept = 0
    for (const name of w.byName.keys()) {
      if (!isChart(name) || remove.has(name)) continue
      const xml = readText(w, name)
      const out = withTypedNames(xml, typed)
      if (out === xml) continue
      replace.set(name, enc.encode(out))
      kept++
    }
    if (kept) notes.push(`kept the typed series names of ${kept === 1 ? 'a chart' : `${kept} charts`}`)
  }

  if (wbRels !== wwb.wbRels.text) replace.set(relsPath(wwb.wbPart), enc.encode(wbRels))
  if (types !== readText(w, '[Content_Types].xml'))
    replace.set('[Content_Types].xml', enc.encode(types))
  for (const part of remove) replace.delete(part)
  if (!replace.size && !add.size && !remove.size) return { bytes: written, notes }
  return { bytes: writeZip(w, replace, remove, add), notes }
}

/** `to` as a relationship target from `from`'s folder. */
function relative(from: string, to: string): string {
  const a = from.split('/').slice(0, -1)
  const b = to.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}
