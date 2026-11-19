import { readRels, relsPath, workbookMap } from './patch/patch'
import { readEntry, readText, readZip, writeZip, type Zip } from './patch/zip'
import { colName, colNum } from './patch/xml'
import { mapCell, type StructuralOp } from './structural'

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

/** A sheet-qualified range in a chart's formula, moved through the ops (a range that loses all its rows keeps its text). */
export function moveChartRef(formula: string, ops: readonly StructuralOp[]): string {
  return formula.replace(
    /((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/g,
    (all, qual: string, c1: string, r1: string, c2?: string, r2?: string) => {
      let sheet = qual.slice(0, -1)
      if (sheet.startsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'")
      const a = mapCell(ops, sheet, Number(r1) - 1, colNum(c1) - 1)
      const b = c2 && r2 ? mapCell(ops, sheet, Number(r2) - 1, colNum(c2) - 1) : a
      if (!a || !b) return all
      const q = /^[A-Za-z_][\w.]*$/.test(a.sheet) ? a.sheet : `'${a.sheet.replace(/'/g, "''")}'`
      const cell = (x: { row: number; col: number }) => `$${colName(x.col + 1)}$${x.row + 1}`
      return c2 ? `${q}!${cell(a)}:${cell(b)}` : `${q}!${cell(a)}`
    }
  )
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
