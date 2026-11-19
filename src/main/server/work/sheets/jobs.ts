import { readFileSync, statSync } from 'node:fs'
import type { ICellData, IWorkbookData } from '@univerjs/core'
import { importXlsx, type ImportReport } from 'work-kit/sheet/xlsx'
import type { SheetCellDiff, SheetReach } from '@shared/contract-work-sheets'
import { rangeCells, READ_MAX_CELLS, type A1Range } from './a1'
import { patchXlsx, type EditSpec, type Report } from './patch/patch'
import { diffWorkbooks } from './diff'
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
  report: Pick<Report, 'edits' | 'partsChanged' | 'warnings'> & { recalc: { ok: boolean; error?: string; pathA: number; pathB: number; fullCalcOnLoad: boolean } }
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

/**
 * Saves `edits` into the package at `input`, written to a new file the caller moves into place.
 * A 1904 file gets its date-formatted numbers back in its own system (the importer moved them by
 * 1,462 days). IronCalc recalculates the dependents when `ironcalcDir` is given and the file is
 * one it can load.
 */
export async function savePackage(input: string, edits: EditSpec[], ironcalcDir: string | null): Promise<{ bytes: Uint8Array } & SaveAnswer> {
  const bytes = new Uint8Array(readFileSync(input))
  const { workbook, report: imported } = importPackage(input)
  if (imported.date1904) {
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
  const engine = ironcalcDir && loadable(bytes) ? ironcalcDir : null
  const { bytes: out, report } = await patchXlsx(bytes, edits, engine ? { inputPath: input, recalc: (path, e, keys) => ironcalc(engine, path, e, keys) } : {})
  return {
    bytes: out,
    report: {
      edits: report.edits,
      partsChanged: report.partsChanged,
      warnings: report.warnings,
      recalc: { ok: report.recalc.ok, error: report.recalc.error, pathA: report.recalc.pathA.length, pathB: report.recalc.pathB.length, fullCalcOnLoad: report.recalc.fullCalcOnLoad }
    }
  }
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

export function comparePackages(from: string, to: string, max: number): { cells: SheetCellDiff[]; truncated: boolean } {
  return diffWorkbooks(importXlsx(new Uint8Array(readFileSync(from))).workbook, importXlsx(new Uint8Array(readFileSync(to))).workbook, max)
}
