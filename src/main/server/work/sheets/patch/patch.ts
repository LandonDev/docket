// The patch writer, from the sheet research's lab (reports/nJLC5WoplSWf, lab/adapters/patch, its README says
// what it does and cannot do). Ported for milestone 27: the engine is passed in, a cell can be cleared.
// The patch writer: open the original package, change only the cells asked for (plus the cached
// values of their dependents), and write every other part back byte for byte.
import { readEntry, readZip, readText, writeZip, type Zip } from './zip'
import {
  patchSheet,
  patchValues,
  scanCached,
  type Cached,
  type CellWrite,
  type Edit,
  type SheetReport
} from './sheet'
import { sameCached, UNSUPPORTED, type EngineEdit, type EngineResult } from './recalc'
import { functionsIn, SPILLING, toFileFormula } from './formula'
import { cellReferences } from './tables'
import {
  attr,
  esc,
  escText,
  parseAttrs,
  parseRange,
  parseRef,
  refName,
  rootPrefix,
  setAttrInTag,
  inBox,
  unesc
} from './xml'

/** One cell to write: `value` (a number, text, true or false; null clears the cell) or `formula`. */
export interface EditSpec {
  sheet: string
  cell: string
  value?: string | number | boolean | null
  formula?: string
}

/** The engine that recalculates dependents: IronCalc in the sheet worker (recalc.ts), or none. */
export type Recalc = (
  inputPath: string,
  edits: EngineEdit[],
  auditKeys: string[]
) => EngineResult | Promise<EngineResult>

export interface Options {
  strings?: 'inline' | 'shared'
  /** absent: no engine, and every dependent is left to the application that opens the file (path b) */
  recalc?: Recalc
  /**
   * The caller has shown that no formula reads an edited cell (depends.ts): with no engine given, the file is then
   * written as it stands, with no word to Excel to calculate everything again on load.
   */
  independent?: boolean
  audit?: boolean // compare the engine with every stored formula value, not only the dependents
  level?: number // deflate level for the parts that change
  /** the engine loads from a path: the package's bytes on disk, as `bytes` holds them */
  inputPath?: string
}

export interface CellPath {
  cell: string
  path: 'a' | 'b'
  reason?: string
  value?: string
}

export interface Report {
  edits: number
  partsChanged: string[]
  partsRemoved: string[]
  partsAdded: string[]
  sheets: Record<string, SheetReport>
  recalc: {
    engine: string
    ok: boolean
    error?: string
    pathA: CellPath[]
    pathB: CellPath[]
    audit?: { formulas: number; agree: number; disagree: number; examples: string[] }
    fullCalcOnLoad: boolean
    calcChainRemoved: boolean
    why: string[]
  }
  warnings: string[]
  timings: Record<string, number>
}

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}
export const relsPath = (part: string) => {
  const i = part.lastIndexOf('/')
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`
}

interface Rel {
  id: string
  type: string
  target: string
  external: boolean
  span: [number, number]
}
export function readRels(z: Zip, part: string, text?: string): { text: string; rels: Rel[] } {
  const p = relsPath(part)
  if (!z.byName.has(p) && text === undefined) return { text: '', rels: [] }
  const t = text ?? readText(z, p)
  const rels: Rel[] = []
  const re = /<(?:[\w.-]+:)?Relationship(?=[\s>/])([^>]*?)\/?>(?:<\/(?:[\w.-]+:)?Relationship>)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    const a = parseAttrs(m[1])
    const external = attr(a, 'TargetMode') === 'External'
    const target = attr(a, 'Target')!
    rels.push({
      id: attr(a, 'Id')!,
      type: attr(a, 'Type')!,
      target: external ? target : resolve(part, target),
      external,
      span: [m.index, m.index + m[0].length]
    })
  }
  return { text: t, rels }
}

export function workbookMap(z: Zip) {
  const root = readRels(z, '', readText(z, '_rels/.rels')).rels.find((r) =>
    r.type.endsWith('/officeDocument')
  )
  if (!root) throw new Error('no officeDocument relationship')
  const wbPart = root.target
  const wbXml = readText(z, wbPart)
  const wbRels = readRels(z, wbPart)
  const P = rootPrefix(wbXml, 'workbook')
  const sheets: { name: string; part: string; kind: string; index: number }[] = []
  const re = new RegExp(`<${P}sheet(?=[\\s>/])([^>]*?)/?>`, 'g')
  let m: RegExpExecArray | null
  // the r:id prefix is whatever the workbook bound to the relationships namespace
  const nsPrefix =
    new RegExp(`xmlns:([\\w.-]+)\\s*=\\s*["']${REL_NS.replace(/[./]/g, '\\$&')}["']`).exec(
      wbXml
    )?.[1] ?? 'r'
  let i = 0
  while ((m = re.exec(wbXml))) {
    const a = parseAttrs(m[1])
    const rel = wbRels.rels.find((r) => r.id === attr(a, `${nsPrefix}:id`))
    if (rel)
      sheets.push({
        name: unesc(attr(a, 'name')!),
        part: rel.target,
        kind: rel.type.split('/').pop()!,
        index: i
      })
    i++
  }
  return { wbPart, wbXml, wbRels, sheets, P }
}

const numeric = (s: string) =>
  s.trim() !== '' &&
  /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim()) &&
  Number.isFinite(Number(s))

export function toWrite(e: EditSpec): CellWrite {
  if (e.formula !== undefined) return { kind: 'formula', file: toFileFormula(e.formula) }
  const v = e.value
  if (typeof v === 'number') return { kind: 'number', value: v }
  if (typeof v === 'boolean') return { kind: 'bool', value: v }
  if (v === null) return { kind: 'clear' }
  if (v === undefined) throw new Error(`${e.sheet}!${e.cell}: no value`)
  if (v.startsWith('=') && v.length > 1) return { kind: 'formula', file: toFileFormula(v) }
  if (numeric(v)) return { kind: 'number', value: Number(v) }
  return { kind: 'text', value: v }
}

/** Shared-string table: reuse an identical plain entry or append one; count/uniqueCount kept honest. */
class SharedStrings {
  private index = new Map<string, number>()
  private appended: string[] = []
  private added = 0
  private total: number
  constructor(private xml: string) {
    const re = /<(?:[\w.-]+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?si>|<(?:[\w.-]+:)?si\s*\/>/g
    let m: RegExpExecArray | null,
      i = 0
    while ((m = re.exec(xml))) {
      const t =
        m[1] !== undefined
          ? /^<(?:[\w.-]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?t>$/.exec(m[1])
          : null
      if (t) {
        const s = unesc(t[1])
        if (!this.index.has(s)) this.index.set(s, i)
      }
      i++
    }
    this.total = i
  }
  get(text: string): number {
    this.added++
    const hit = this.index.get(text)
    if (hit !== undefined) return hit
    const i = this.total + this.appended.length
    this.appended.push(text)
    this.index.set(text, i)
    return i
  }
  get changed() {
    return this.added > 0
  }
  render(): string {
    const P = rootPrefix(this.xml, 'sst')
    const add = this.appended
      .map(
        (s) =>
          `<${P}si><${P}t${/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : ''}>${escText(s)}</${P}t></${P}si>`
      )
      .join('')
    let xml = this.xml
    const open = new RegExp(`<${P}sst(?=[\\s>/])[^>]*>`).exec(xml)!
    let tag = open[0]
    const a = parseAttrs(tag)
    // count = references to the table; uniqueCount = entries. Both optional; update when present.
    if (attr(a, 'count') !== undefined)
      tag = setAttrInTag(tag, 'count', String(Number(attr(a, 'count')) + this.added))
    if (attr(a, 'uniqueCount') !== undefined)
      tag = setAttrInTag(
        tag,
        'uniqueCount',
        String(Number(attr(a, 'uniqueCount')) + this.appended.length)
      )
    if (tag.endsWith('/>'))
      return (
        xml.slice(0, open.index) +
        tag.replace(/\s*\/>$/, '>') +
        add +
        `</${P}sst>` +
        xml.slice(open.index + open[0].length)
      )
    const close = xml.lastIndexOf(`</${P}sst>`)
    return (
      xml.slice(0, open.index) +
      tag +
      xml.slice(open.index + open[0].length, close) +
      add +
      xml.slice(close)
    )
  }
}

/** Is the cell locked under sheet protection? (default xf protection is locked=1) */
function lockedStyles(styles: string): (s: number) => boolean {
  const m = /<(?:[\w.-]+:)?cellXfs(?=[\s>])[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?cellXfs>/.exec(styles)
  const xfs = m
    ? (m[1].match(/<(?:[\w.-]+:)?xf(?=[\s>/])[\s\S]*?(?:\/>|<\/(?:[\w.-]+:)?xf>)/g) ?? [])
    : []
  return (s) => !/<(?:[\w.-]+:)?protection[^>]*\blocked\s*=\s*["'](0|false)["']/.test(xfs[s] ?? '')
}

export async function patchXlsx(
  bytes: Uint8Array,
  specs: EditSpec[],
  opts: Options = {}
): Promise<{ bytes: Uint8Array; report: Report }> {
  const T: Record<string, number> = {}
  let t = performance.now()
  const lap = (k: string) => {
    const n = performance.now()
    T[k] = Math.round((T[k] ?? 0) + n - t)
    t = n
  }
  const z = readZip(bytes)
  const wb = workbookMap(z)
  lap('readPackageMs')
  const report: Report = {
    edits: specs.length,
    partsChanged: [],
    partsRemoved: [],
    partsAdded: [],
    sheets: {},
    recalc: {
      engine: opts.recalc ? 'ironcalc' : 'none',
      ok: false,
      pathA: [],
      pathB: [],
      fullCalcOnLoad: false,
      calcChainRemoved: false,
      why: []
    },
    warnings: [],
    timings: T
  }
  const replace = new Map<string, Uint8Array>(),
    remove = new Set<string>()
  const enc = new TextEncoder()

  // ---- resolve edits
  const bySheet = new Map<string, { part: string; edits: Edit[] }>()
  const engineEdits: { sheet: string; row: number; col: number; write: CellWrite }[] = []
  const seen = new Map<string, number>()
  // A formula that names a table goes in as Excel keeps it in a file: [@Qty] by the table the cell sits in,
  // a bare table name as Sales[] (Excel reads the typed words as #REF! and #NAME?: SHT4-excel-tables-proof.md).
  let said: ReturnType<typeof cellReferences> | undefined
  for (const s of specs) {
    const sh = wb.sheets.find((x) => x.name === s.sheet)
    if (!sh) throw new Error(`no sheet named ${s.sheet}`)
    if (sh.kind !== 'worksheet') throw new Error(`${s.sheet} is a ${sh.kind}, not a worksheet`)
    const { row, col } = parseRef(s.cell)
    const typed = toWrite(s)
    const write =
      typed.kind === 'formula'
        ? { ...typed, file: (said ??= cellReferences(bytes))(s.sheet, row, col, typed.file) }
        : typed
    const key = `${s.sheet}\u0000${row},${col}`
    const g = bySheet.get(s.sheet) ?? { part: sh.part, edits: [] }
    if (seen.has(key))
      g.edits[seen.get(key)!] = { row, col, write } // last write wins
    else {
      seen.set(key, g.edits.length)
      g.edits.push({ row, col, write })
    }
    bySheet.set(s.sheet, g)
    engineEdits.push({ sheet: s.sheet, row, col, write })
    if (write.kind === 'formula') {
      const spills = functionsIn(write.file).filter((f) => SPILLING.has(f))
      if (spills.length)
        report.warnings.push(
          `${s.sheet}!${s.cell}: ${spills.join(', ')} can spill; the patch writes a single-cell formula without dynamic-array metadata (cm=), so Excel shows it as an implicit-intersection formula`
        )
    }
  }

  // ---- guards from other parts: table headers, protection
  const stylesRel = wb.wbRels.rels.find((r) => r.type.endsWith('/styles'))
  const locked =
    stylesRel && z.byName.has(stylesRel.target)
      ? lockedStyles(readText(z, stylesRel.target))
      : () => true
  const sheetXml = new Map<string, string>()
  for (const [name, g] of bySheet) {
    const xml = readText(z, g.part)
    sheetXml.set(name, xml)
    for (const rel of readRels(z, g.part).rels.filter((r) => r.type.endsWith('/table'))) {
      if (!z.byName.has(rel.target)) continue
      const tx = readText(z, rel.target)
      const tag = /<(?:[\w.-]+:)?table(?=[\s>])[^>]*>/.exec(tx)?.[0] ?? ''
      const ta = parseAttrs(tag)
      const box = parseRange(attr(ta, 'ref')!)
      const header = attr(ta, 'headerRowCount') !== '0'
      for (const e of g.edits)
        if (header && e.row === box.r1 && inBox(box, e.row, e.col))
          throw new Error(
            `${name}!${refName(e.row, e.col)} is a header of table ${attr(ta, 'name')}: renaming a table column also renames structured references; send it to an engine`
          )
    }
    if (/<(?:[\w.-]+:)?sheetProtection(?=[\s>/])[^>]*\bsheet\s*=\s*["'](1|true)["']/.test(xml)) {
      for (const e of g.edits) {
        const c = new RegExp(
          `<(?:[\\w.-]+:)?c\\s[^>]*\\br\\s*=\\s*["']${refName(e.row, e.col)}["'][^>]*>`
        ).exec(xml)?.[0]
        const s = Number((c && /\ss\s*=\s*["'](\d+)["']/.exec(c)?.[1]) || 0)
        if (locked(s))
          report.warnings.push(
            `${name}!${refName(e.row, e.col)} is locked on a protected sheet; Excel's UI would refuse this edit`
          )
      }
    }
  }
  lap('guardsMs')

  // ---- recalculation in a real engine, from the same bytes
  let engine: EngineResult | null = null
  const why = report.recalc.why
  const stored = new Map<string, Cached | null>() // "sheet\u0000A1" → what the file stores for each formula/array cell
  if (opts.recalc) {
    if (!opts.inputPath) throw new Error('the engine loads the package from inputPath')
    if (opts.audit ?? true) {
      for (const sh of wb.sheets.filter((s) => s.kind === 'worksheet')) {
        const xml = sheetXml.get(sh.name) ?? readText(z, sh.part)
        if (!xml.includes('<f') && !/<[\w.-]+:f[\s>]/.test(xml)) continue
        for (const [ref, v] of scanCached(xml)) stored.set(`${sh.name}\u0000${ref}`, v)
      }
      lap('auditScanMs')
    }
    try {
      engine = await opts.recalc(opts.inputPath, engineEdits, [...stored.keys()])
    } catch (err) {
      engine = {
        engine: 'ironcalc',
        ok: false,
        error: String(err instanceof Error ? err.message : err),
        changed: [],
        editValues: {},
        editErrors: [],
        auditBefore: {},
        timings: { loadMs: 0, evalMs: 0, applyMs: 0, snapshotMs: 0 }
      }
    }
    report.recalc.ok = engine.ok
    if (!engine.ok) {
      report.recalc.error = engine.error
      why.push(`engine failed: ${engine.error}`)
    }
    for (const e of engine.editErrors) why.push(`engine refused an edit: ${e}`)
    Object.assign(
      T,
      Object.fromEntries(
        Object.entries(engine.timings).map(([k, v]) => [`engine.${k}`, Math.round(v)])
      )
    )
    lap('engineMs')
  } else if (!opts.independent) why.push('no engine: recalculation left to the application that opens the file')

  // cached values for edited formula cells
  for (const [name, g] of bySheet)
    for (const e of g.edits) {
      if (e.write.kind !== 'formula') continue
      const v = engine?.ok ? engine.editValues[`${name}\u0000${e.row},${e.col}`] : undefined
      const cell = `${name}!${refName(e.row, e.col)}`
      if (v && !(v.t === 'e' && UNSUPPORTED.has(v.v))) {
        e.write.cached = v
        report.recalc.pathA.push({ cell, path: 'a', value: v.v })
      } else
        report.recalc.pathB.push({
          cell,
          path: 'b',
          reason: v ? `engine returned ${v.v}` : 'engine has no value'
        })
    }

  // ---- strings
  const sstRel = wb.wbRels.rels.find((r) => r.type.endsWith('/sharedStrings'))
  let sst: SharedStrings | null = null
  if (opts.strings === 'shared') {
    if (sstRel && z.byName.has(sstRel.target)) sst = new SharedStrings(readText(z, sstRel.target))
    else report.warnings.push('no sharedStrings part: text written as inline strings')
  }

  // ---- worksheet surgery
  let formulasRemoved = 0
  const newXml = new Map<string, string>()
  for (const [name, g] of bySheet) {
    const r = patchSheet(sheetXml.get(name)!, g.edits, {
      strings: sst ? (s) => sst!.get(s) : 'inline'
    })
    report.sheets[name] = r.report
    report.warnings.push(...r.report.warnings.map((w) => `${name}: ${w}`))
    formulasRemoved += r.report.formulasRemoved
    newXml.set(g.part, r.xml)
  }
  lap('patchCellsMs')

  // ---- dependents: path (a) where the engine computed a trustworthy value, else (b)
  if (engine?.ok) {
    const bySheetVals = new Map<string, Map<string, Cached>>()
    const afterOf = new Map<string, Cached | null>()
    const beforeOf = new Map<string, Cached | null>()
    for (const c of engine.changed) {
      const ref = refName(c.row, c.col)
      const cell = `${c.sheet}!${ref}`
      if (c.after && c.after.t === 'e' && UNSUPPORTED.has(c.after.v)) {
        report.recalc.pathB.push({ cell, path: 'b', reason: `engine returned ${c.after.v}` })
        continue
      }
      if (!c.after) {
        report.recalc.pathB.push({
          cell,
          path: 'b',
          reason: 'engine value became empty (spill shrank?)'
        })
        continue
      }
      const m = bySheetVals.get(c.sheet) ?? new Map()
      m.set(ref, c.after)
      bySheetVals.set(c.sheet, m)
      afterOf.set(cell, c.after)
      beforeOf.set(cell, c.before)
    }
    for (const [name, vals] of bySheetVals) {
      const sh = wb.sheets.find((s) => s.name === name)!
      const xml = newXml.get(sh.part) ?? readText(z, sh.part)
      const r = patchValues(xml, vals, (ref, old) =>
        sameCached(old, beforeOf.get(`${name}!${ref}`))
      )
      for (const h of r.hits) {
        const cell = `${name}!${h.ref}`
        if (h.status === 'patched')
          report.recalc.pathA.push({ cell, path: 'a', value: afterOf.get(cell)?.v })
        else
          report.recalc.pathB.push({
            cell,
            path: 'b',
            reason:
              h.status === 'stale'
                ? `engine's own value before the edit (${beforeOf.get(cell)?.v}) differs from the stored ${h.old?.v}`
                : h.status === 'missing'
                  ? 'no such cell in the file (a spill grew?)'
                  : 'stored as a constant, not a formula'
          })
      }
      if (r.hits.some((h) => h.status === 'patched')) newXml.set(sh.part, r.xml)
    }
    lap('patchValuesMs')
    // audit: can the engine reproduce what is stored? Where it cannot, its dependency picture is incomplete.
    if (opts.audit ?? true) {
      const audit = { formulas: 0, agree: 0, disagree: 0, examples: [] as string[] }
      for (const [k, v] of stored) {
        audit.formulas++
        const mine = engine.auditBefore[k]
        if (sameCached(v, mine) || (v?.t === 'e' && mine?.t === 'e')) audit.agree++
        else {
          audit.disagree++
          if (audit.examples.length < 12)
            audit.examples.push(
              `${k.replace('\u0000', '!')}: stored ${v ? v.v : '(none)'}, engine ${mine ? mine.v : '(none)'}`
            )
        }
      }
      report.recalc.audit = audit
      if (audit.disagree)
        why.push(
          `engine disagrees with ${audit.disagree} of ${audit.formulas} stored formula values; their dependence on the edit is unknown`
        )
      lap('auditMs')
    }
  }
  if (report.recalc.pathB.length) why.push(`${report.recalc.pathB.length} cells took path (b)`)

  // ---- calcChain and calcPr
  const needFull = why.length > 0
  const chainRel = wb.wbRels.rels.find((r) => r.type.endsWith('/calcChain'))
  let wbRelsText = wb.wbRels.text
  if (chainRel && (needFull || formulasRemoved > 0)) {
    remove.add(chainRel.target)
    wbRelsText = wbRelsText.slice(0, chainRel.span[0]) + wbRelsText.slice(chainRel.span[1])
    let ct = readText(z, '[Content_Types].xml')
    ct = ct.replace(
      new RegExp(
        `<(?:[\\w.-]+:)?Override(?=[\\s>])[^>]*PartName\\s*=\\s*["']/${chainRel.target.replace(/[./]/g, '\\$&')}["'][^>]*?(?:/>|></(?:[\\w.-]+:)?Override>)`
      ),
      ''
    )
    replace.set('[Content_Types].xml', enc.encode(ct))
    replace.set(relsPath(wb.wbPart), enc.encode(wbRelsText))
    report.recalc.calcChainRemoved = true
  }
  if (needFull) {
    let x = wb.wbXml
    const P = wb.P
    const cp = new RegExp(`<${P}calcPr(?=[\\s>/])[^>]*?/?>`).exec(x)
    if (cp && /\bcalcMode\s*=\s*["']manual["']/.test(cp[0]))
      report.warnings.push(
        'calcMode="manual": Excel does not honour fullCalcOnLoad in manual mode, so path (b) cells stay stale until the user recalculates'
      )
    if (cp) {
      const nt = setAttrInTag(cp[0], 'fullCalcOnLoad', '1')
      if (nt !== cp[0]) x = x.slice(0, cp.index) + nt + x.slice(cp.index + cp[0].length)
    } else {
      // CT_Workbook order: … definedNames, calcPr, oleSize, customWorkbookViews, pivotCaches, …, extLst
      const after = [
        'oleSize',
        'customWorkbookViews',
        'pivotCaches',
        'smartTagPr',
        'smartTagTypes',
        'webPublishing',
        'fileRecoveryPr',
        'webPublishObjects',
        'extLst'
      ]
        .map((n) => new RegExp(`<${P}${n}(?=[\\s>/])`).exec(x)?.index ?? -1)
        .filter((i) => i >= 0)
      const at = after.length ? Math.min(...after) : x.lastIndexOf(`</${P}workbook>`)
      x = x.slice(0, at) + `<${P}calcPr fullCalcOnLoad="1"/>` + x.slice(at)
    }
    if (x !== wb.wbXml) replace.set(wb.wbPart, enc.encode(x))
    report.recalc.fullCalcOnLoad = true
  }
  if (sst?.changed) replace.set(sstRel!.target, enc.encode(sst.render()))
  for (const [part, xml] of newXml) replace.set(part, enc.encode(xml))
  lap('packageFixupsMs')

  // drop no-op replacements so an unchanged part keeps its original compressed bytes
  for (const [name, data] of replace) {
    if (z.byName.get(name)!.size !== data.length) continue
    const orig = readEntry(z, name)
    if (orig.length === data.length && Buffer.compare(Buffer.from(orig), Buffer.from(data)) === 0)
      replace.delete(name)
  }
  const out = writeZip(z, replace, remove, new Map(), { level: opts.level })
  lap('writeZipMs')
  report.partsChanged = [...replace.keys()]
  report.partsRemoved = [...remove]
  return { bytes: out, report }
}

export { esc }
