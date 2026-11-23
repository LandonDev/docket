import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { ICellData, IWorkbookData } from '@univerjs/core'
import { importXlsx, type ImportReport } from 'work-kit/sheet/xlsx'
import type { SheetCellDiff, SheetMutationJson, SheetReach } from '@shared/contract-work-sheets'
import { rangeCells, READ_MAX_CELLS, type A1Range } from './a1'
import { readThemeXml } from 'work-kit/format/theme'
import { independent } from './patch/depends'
import { patchFormat, type FormatReport } from './patch/format'
import { dependsInput } from './patch/package'
import { patchXlsx, workbookMap, type EditSpec, type Report } from './patch/patch'
import { formatEditsOf } from './formats'
import { diffWorkbooks } from './diff'
import { graft } from './graft'
import { writeCsv } from './writer'
import type { StructuralOp } from './structural'
import { ironcalc } from './patch/recalc'
import { readText, readZip } from './patch/zip'

/**
 * The heavy work on an opened package (docs/agents/work-sheets.md "Packages"):
 * reading it, reading a range, saving edits through the patch writer with
 * IronCalc, comparing two copies. Pure functions over files: the sheet worker
 * (worker.ts, a utility process) runs them, so a 100,000-row file never
 * blocks main and a panic in IronCalc's native code ends only that process.
 * A test runs them in its own process.
 */

/** One sheet of a package: Univer's id for it (from the file's sheetId) and its tab name. */
export interface PackageSheet {
  id: string
  name: string
}

export interface Inspected {
  sheets: PackageSheet[]
  date1904: boolean
  reach: SheetReach | null
  /** why it cannot be edited here; the file still shows */
  readOnly?: string
}

/** One cell as a read answers it. */
export interface ReadCell {
  at: string
  v?: string | number | boolean
  f?: string
}

export interface SaveAnswer {
  report: Pick<Report, 'edits' | 'partsChanged' | 'warnings'> & {
    recalc: { ok: boolean; error?: string; pathA: number; pathB: number; fullCalcOnLoad: boolean }
    /**
     * How the save was made: `engine` (IronCalc recalculated the dependents: the audited path), `independent` (no
     * formula reads an edited cell, shown from the formulas' text, so no engine was loaded), `format` (formatting
     * alone), `plain` (no engine on this host). `why` is the proof's reason when it sent the save to the engine.
     */
    path: 'engine' | 'independent' | 'format' | 'plain'
    why?: string
    format?: FormatReport['styles']
  }
}

/** What the importer counts, said as a person reads it, for the things only Excel does (the sheet research §8). */
const REACH: Record<string, string> = {
  vbaProject: 'macros',
  formControls: 'form controls',
  pivotTables: 'pivot tables',
  pivotCaches: 'pivot tables',
  slicers: 'slicers',
  powerQuery: 'Power Query',
  dataConnections: 'data connections',
  externalLinks: 'links to other workbooks',
  charts: 'charts',
  chartsheets: 'charts',
  dataTables: 'what-if tables'
}

export function reachOf(report: Pick<ImportReport, 'unsupported'>): SheetReach | null {
  const parts = [...new Set(report.unsupported.map((u) => REACH[u.kind]).filter((p): p is string => !!p))]
  return parts.length ? { parts, to: 'excel' } : null
}

/** The last few imports, by path and the file's stamp: a 100,000-row file imports in about a second. */
const imported = new Map<string, { stamp: string; workbook: IWorkbookData; report: ImportReport }>()
const KEEP = 3

export function importPackage(path: string): { workbook: IWorkbookData; report: ImportReport } {
  const st = statSync(path)
  const stamp = `${st.size}:${st.mtimeMs}`
  const hit = imported.get(path)
  if (hit?.stamp === stamp) {
    imported.delete(path)
    imported.set(path, hit)
    return hit
  }
  const got = importXlsx(new Uint8Array(readFileSync(path)))
  imported.set(path, { stamp, ...got })
  while (imported.size > KEEP) imported.delete(imported.keys().next().value!)
  return got
}

export function inspect(path: string): Inspected {
  try {
    const { workbook, report } = importPackage(path)
    const sheets = workbook.sheetOrder.map((id) => ({ id, name: workbook.sheets[id]?.name ?? id }))
    return { sheets, date1904: report.date1904, reach: reachOf(report) }
  } catch (err) {
    // A file the importer refuses (Strict OOXML, a password, a binary .xlsb, a hostile zip) is not ours to edit.
    return { sheets: [], date1904: false, reach: { parts: [], to: 'excel' }, readOnly: `This file cannot be opened here: ${err instanceof Error ? err.message : String(err)}` }
  }
}

const cellOut = (at: string, c: ICellData | null | undefined): ReadCell => {
  const out: ReadCell = { at }
  if (c?.f) out.f = c.f
  if (c?.v !== undefined && c.v !== null) out.v = c.v as string | number | boolean
  return out
}

/** The sheet a range names, by tab name, else the first. */
export function sheetOf(workbook: IWorkbookData, name: string | undefined): { id: string; name: string } {
  const id = name === undefined ? workbook.sheetOrder[0] : workbook.sheetOrder.find((s) => workbook.sheets[s]?.name === name)
  if (!id) throw new Error(name === undefined ? 'The workbook has no sheets.' : `There is no sheet named ${name}. Sheets: ${workbook.sheetOrder.map((s) => workbook.sheets[s]?.name).join(', ')}.`)
  return { id, name: workbook.sheets[id]?.name ?? id }
}

export function readWorkbookRange(workbook: IWorkbookData, range: A1Range, colName: (col: number) => string): { sheet: string; cells: ReadCell[][] } {
  if (rangeCells(range) > READ_MAX_CELLS) throw new Error(`A read is at most ${READ_MAX_CELLS.toLocaleString('en')} cells: ask for a smaller range.`)
  const sheet = sheetOf(workbook, range.sheet)
  const data = workbook.sheets[sheet.id]?.cellData ?? {}
  const cells: ReadCell[][] = []
  for (let r = range.startRow; r <= range.endRow; r++) {
    const row: ReadCell[] = []
    for (let c = range.startColumn; c <= range.endColumn; c++) row.push(cellOut(`${colName(c)}${r + 1}`, data[r]?.[c]))
    cells.push(row)
  }
  return { sheet: sheet.name, cells }
}

/** A date format, read the way Excel reads a pattern: d, m, y or h outside quotes and brackets. */
const isDatePattern = (pattern: string | undefined): boolean => !!pattern && /[dmyh]/i.test(pattern.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''))

/** The file's own theme, read from its part alone: a named cell style is told by it (formats.ts). */
function themeOf(z: ReturnType<typeof readZip>) {
  try {
    const rel = workbookMap(z).wbRels.rels.find((r) => !r.external && r.type.endsWith('/theme'))
    return readThemeXml(rel && z.byName.has(rel.target) ? readText(z, rel.target) : undefined)
  } catch {
    return readThemeXml(undefined)
  }
}

/** Whether any formula of the package calls CELL, which can read a cell's number format. */
function readsFormats(z: ReturnType<typeof readZip>): boolean {
  try {
    const wb = workbookMap(z)
    return /CELL\s*\(/i.test(wb.wbXml) || wb.sheets.some((s) => s.kind !== 'chartsheet' && z.byName.has(s.part) && /CELL\s*\(/i.test(readText(z, s.part)))
  } catch {
    return true
  }
}

/**
 * Saves `edits` and `formats` into the package at `input`, written to a new file the caller moves
 * into place. Three ways, the lightest that is safe (the editors plan, decision 3):
 *
 *  - formatting alone never reads a cell's value: the part-local format writer, no workbook
 *    model, no engine;
 *  - typed values no formula reads (depends.ts shows it from the formulas' text) are patched in
 *    with no engine, and Excel is not asked to calculate again;
 *  - everything else takes the audited path: IronCalc recalculates the dependents when
 *    `ironcalcDir` is given and the file is one it can load.
 *
 * A 1904 file gets its date-formatted numbers back in its own system (the importer moved them by
 * 1,462 days). `formats` are the grid's formatting mutations, each named by its tab (mutations.ts).
 */
export async function savePackage(input: string, edits: EditSpec[], ironcalcDir: string | null, formats: readonly SheetMutationJson[] = []): Promise<{ bytes: Uint8Array } & SaveAnswer> {
  let bytes: Uint8Array = new Uint8Array(readFileSync(input))
  const zip = readZip(bytes)
  const report: SaveAnswer['report'] = { edits: edits.length, partsChanged: [], warnings: [], recalc: { ok: true, pathA: 0, pathB: 0, fullCalcOnLoad: false }, path: 'format' }
  if (edits.length) {
    const date1904 = /<(?:[\w.-]+:)?workbookPr(?=[\s>/])[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/.test(workbookMap(zip).wbXml)
    if (date1904) {
      const { workbook } = importPackage(input)
      const styles = workbook.styles ?? {}
      edits = edits.map((e) => {
        if (typeof e.value !== 'number') return e
        const sheet = sheetOf(workbook, e.sheet)
        const m = /^([A-Z]+)(\d+)$/.exec(e.cell)
        if (!m) return e
        const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
        const s = workbook.sheets[sheet.id]?.cellData?.[Number(m[2]) - 1]?.[col]?.s
        const style = typeof s === 'string' ? styles[s] : s
        return isDatePattern(style?.n?.pattern) ? { ...e, value: e.value - 1462 } : e
      })
    }
    const proof = independent(dependsInput(bytes, zip), edits)
    const engine = !proof.independent && ironcalcDir && loadable(bytes) ? ironcalcDir : null
    const done = await patchXlsx(bytes, edits, proof.independent ? { independent: true } : engine ? { inputPath: input, recalc: (path, e, keys) => ironcalc(engine, path, e, keys) } : {})
    bytes = done.bytes
    report.partsChanged = done.report.partsChanged
    report.warnings = done.report.warnings
    report.recalc = { ok: proof.independent || done.report.recalc.ok, error: done.report.recalc.error, pathA: done.report.recalc.pathA.length, pathB: done.report.recalc.pathB.length, fullCalcOnLoad: done.report.recalc.fullCalcOnLoad }
    report.path = proof.independent ? 'independent' : engine ? 'engine' : 'plain'
    if (!proof.independent) report.why = proof.why
  }
  if (formats.length) {
    const made = formatEditsOf(formats, (tab) => tab, themeOf(zip))
    if (made.length) {
      const done = patchFormat(bytes, made)
      bytes = done.bytes
      report.partsChanged = [...new Set([...report.partsChanged, ...done.report.partsChanged])]
      report.warnings = [...report.warnings, ...done.report.warnings]
      report.format = done.report.styles
      // CELL reads a cell's formatting (its number format, its alignment as "prefix", its column's width): where a
      // workbook calls CELL anywhere, a name included, any format edit asks Excel to calculate again on load, since
      // no engine here knows what that formula now answers.
      if (!report.recalc.fullCalcOnLoad && readsFormats(zip)) {
        const again = await patchXlsx(bytes, [], {})
        bytes = again.bytes
        report.partsChanged = [...new Set([...report.partsChanged, ...again.report.partsChanged])]
        report.recalc.fullCalcOnLoad = again.report.recalc.fullCalcOnLoad
      }
    }
  }
  return { bytes, report }
}

/**
 * Whether IronCalc 0.9.1 can load the package without panicking: it indexes `<fonts>` in
 * styles.xml unchecked (styles.rs:123). A panic would end the worker, so the save goes without it.
 */
function loadable(bytes: Uint8Array): boolean {
  try {
    const z = readZip(bytes)
    const styles = [...z.byName.keys()].find((n) => /(^|\/)styles\.xml$/.test(n))
    return !!styles && /<(?:[\w.-]+:)?fonts[\s>]/.test(readText(z, styles))
  } catch {
    return false
  }
}

/** LibreOffice's package with what it drops put back (graft.ts), written to `output`. */
export function graftPackage(original: string, written: string, output: string, ops: StructuralOp[]): string[] {
  const g = graft(new Uint8Array(readFileSync(original)), new Uint8Array(readFileSync(written)), ops)
  writeFileSync(output, g.bytes)
  return g.notes
}

/** One sheet of a package as CSV (writer.ts). */
export function packageCsv(path: string, sheet?: string): string {
  return writeCsv(importPackage(path).workbook, sheet)
}

export function comparePackages(from: string, to: string, max: number): { cells: SheetCellDiff[]; truncated: boolean } {
  return diffWorkbooks(importXlsx(new Uint8Array(readFileSync(from))).workbook, importXlsx(new Uint8Array(readFileSync(to))).workbook, max)
}
