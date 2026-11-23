import type { ICellData, IWorkbookData } from '@univerjs/core'
import type { SheetPreviewFormat } from '@shared/contract-work-sheets'
import { toFileFormula } from './patch/formula'
import { readRels, workbookMap } from './patch/patch'
import { readRules } from './patch/rules'
import { readText, readZip, type Zip } from './patch/zip'

/**
 * What a workbook holds that a format may not keep, counted from the workbook
 * in hand (docs/agents/work-sheets.md "Preview and export"), and the lines
 * Preview's "In this format" says for each format. Pure: a package is read
 * from its bytes, a sheet the service holds from its snapshot.
 */

export interface SheetFacts {
  name: string
  /** a chartsheet: a tab that is one chart */
  chart: boolean
  formulas: number
  /** any cell with a style of its own, or a merge */
  styled: boolean
  /** the last used row and column, 1-based; 0 on an empty sheet */
  rows: number
  cols: number
  /** of its formulas, those that call a function newer than Excel 2007 (`_xlfn.` in the file) */
  newFunctions: number
  /** its own conditional formats and validations */
  rules: number
  /** charts and pictures drawn on it (by its drawing's links) */
  charts: number
  pictures: number
  /** fit to pages wide by tall (0: as many as it takes), when the sheet prints fitted */
  fit?: { wide: number; tall: number }
}

export interface BookFacts {
  sheets: SheetFacts[]
  conditional: { total: number; scales: number; bars: number; icons: number }
  validations: number
  tables: number
  names: number
  /** charts drawn on sheets and chartsheets, in the file */
  charts: number
  /** charts of the newer kinds (waterfall, funnel, treemap and the rest) LibreOffice does not draw */
  newCharts: number
  pictures: number
  notes: number
  filters: number
  /** charts made here and kept beside the file (work_sheets_charts), not in it */
  ours: number
}

const EMPTY: Omit<BookFacts, 'sheets'> = { conditional: { total: 0, scales: 0, bars: 0, icons: 0 }, validations: 0, tables: 0, names: 0, charts: 0, newCharts: 0, pictures: 0, notes: 0, filters: 0, ours: 0 }

/** A1 column letters as a number: A is 1. */
const colNumber = (letters: string): number => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)

const count = (text: string, re: RegExp): number => {
  let n = 0
  re.lastIndex = 0
  while (re.exec(text)) n++
  return n
}

/** The last used cell of a sheet part: its `dimension`, else its last row and the widest cell seen. */
function extentOf(xml: string): { rows: number; cols: number } {
  const dim = /<(?:[\w.-]+:)?dimension\b[^>]*\bref\s*=\s*["']([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?["']/i.exec(xml)
  if (dim) return dim[3] ? { rows: Number(dim[4]), cols: colNumber(dim[3]) } : { rows: Number(dim[2]), cols: colNumber(dim[1]) }
  let rows = 0
  let cols = 0
  const re = /<(?:[\w.-]+:)?c\b[^>]*\br\s*=\s*["']([A-Z]+)(\d+)["']/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    rows = Math.max(rows, Number(m[2]))
    cols = Math.max(cols, colNumber(m[1]))
  }
  return { rows, cols }
}

/** Fit to pages, as the sheet's `pageSetUpPr fitToPage` and `pageSetup` say it. */
export function fitOf(xml: string): SheetFacts['fit'] {
  if (!/<(?:[\w.-]+:)?pageSetUpPr\b[^>]*\bfitToPage\s*=\s*["'](?:1|true)["']/.test(xml)) return undefined
  const setup = /<(?:[\w.-]+:)?pageSetup\b([^>]*)>/.exec(xml)?.[1] ?? ''
  const num = (name: string): number => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["'](\\d+)["']`).exec(setup)
    return m ? Number(m[1]) : 1
  }
  return { wide: num('fitToWidth'), tall: num('fitToHeight') }
}

const entries = (z: Zip, re: RegExp): string[] => z.entries.map((e) => e.name).filter((n) => re.test(n))

/** A package's facts, from its parts: nothing is imported, so a large workbook answers in the time its XML takes to scan. */
/** The formulas of a sheet part that call a newer function: each master that names `_xlfn.`, and the cells that share it. */
function newFunctionsOf(xml: string): number {
  let count = 0
  const shared = new Set<string>()
  const re = /<(?:[\w.-]+:)?f\b([^>]*?)(?:\/>|>([^<]*)<\/(?:[\w.-]+:)?f>)/g
  const followers: string[] = []
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const si = /\bt\s*=\s*["']shared["']/.test(m[1]) ? /\bsi\s*=\s*["'](\d+)["']/.exec(m[1])?.[1] : undefined
    if (m[2] && m[2].includes('_xlfn.')) {
      count++
      if (si !== undefined) shared.add(si)
    } else if (!m[2] && si !== undefined) followers.push(si)
  }
  for (const si of followers) if (shared.has(si)) count++
  return count
}

/** What a sheet's drawing holds: its charts (the newer kinds among them) and its pictures, by the drawing's links. */
function drawnOn(z: Zip, part: string): { charts: number; pictures: number } {
  let charts = 0
  let pictures = 0
  for (const rel of readRels(z, part).rels) {
    if (rel.external || !rel.type.endsWith('/drawing') || !z.byName.has(rel.target)) continue
    for (const inner of readRels(z, rel.target).rels) {
      if (inner.type.endsWith('/chart') || inner.type.endsWith('/chartEx')) charts++
      else if (inner.type.endsWith('/image')) pictures++
    }
  }
  return { charts, pictures }
}

/** A package's facts, from its parts: nothing is imported, so a large workbook answers in the time its XML takes to scan. */
export function factsOfPackage(bytes: Uint8Array): BookFacts {
  const z = readZip(bytes)
  const book = workbookMap(z)
  let rules: ReturnType<typeof readRules> | null = null
  try {
    rules = readRules(bytes)
  } catch {
    // A rule part the reader refuses: its rules are not counted, and nothing is said of them.
  }
  const sheets: SheetFacts[] = book.sheets.map((s) => {
    const chart = s.kind === 'chartsheet'
    const drawn = z.byName.has(s.part) ? drawnOn(z, s.part) : { charts: 0, pictures: 0 }
    const tab = rules?.sheets[s.name]
    const own = { rules: (tab?.conditional.length ?? 0) + (tab?.validation.length ?? 0), ...drawn }
    if (chart || !z.byName.has(s.part)) return { name: s.name, chart, formulas: 0, styled: false, rows: 0, cols: 0, newFunctions: 0, ...own }
    const xml = readText(z, s.part)
    const fit = fitOf(xml)
    return {
      name: s.name,
      chart,
      formulas: count(xml, /<(?:[\w.-]+:)?f[\s>/]/g),
      newFunctions: newFunctionsOf(xml),
      styled: /<(?:[\w.-]+:)?c\b[^>]*\bs\s*=\s*["']0*[1-9]/.test(xml) || /<(?:[\w.-]+:)?mergeCell\b/.test(xml),
      ...extentOf(xml),
      ...own,
      ...(fit ? { fit } : {})
    }
  })
  const facts: BookFacts = { ...structuredClone(EMPTY), sheets }
  if (rules) {
    for (const tab of Object.values(rules.sheets)) {
      for (const r of tab.conditional) {
        const type = (r as { rule?: { type?: string } }).rule?.type
        facts.conditional.total++
        if (type === 'colorScale') facts.conditional.scales++
        else if (type === 'dataBar') facts.conditional.bars++
        else if (type === 'iconSet') facts.conditional.icons++
      }
      facts.validations += tab.validation.length
      if (tab.filter) facts.filters++
    }
    facts.names = Object.keys(rules.names).length
  }
  facts.tables = entries(z, /^xl\/tables\/[^/]+\.xml$/i).length
  facts.charts = entries(z, /^xl\/charts\/chart\d*\.xml$/i).length
  facts.newCharts = entries(z, /^xl\/charts\/chartEx\d*\.xml$/i).length
  facts.pictures = entries(z, /^xl\/media\//i).length
  for (const part of entries(z, /^xl\/comments[^/]*\.xml$/i)) facts.notes += count(readText(z, part), /<(?:[\w.-]+:)?comment\b/g)
  return facts
}

/** A formula as the grid holds it calls a function newer than Excel 2007: the file writes it with `_xlfn.` (patch/formula.ts). */
const newer = (formula: string): boolean => {
  try {
    return toFileFormula(formula).includes('_xlfn.')
  } catch {
    return false
  }
}

/** A workbook's facts from Univer's snapshot (a LifeOS sheet, a `.tcsheet`, a sheet read from a .csv). `ours`: the charts made here. */
export function factsOfWorkbook(wb: IWorkbookData, ours = 0): BookFacts {
  const resource = (name: string): Record<string, unknown> => {
    try {
      const data = wb.resources?.find((r) => r.name === name)?.data
      const value = data ? (JSON.parse(data) as unknown) : null
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  const conditional = resource('SHEET_CONDITIONAL_FORMATTING_PLUGIN')
  const validation = resource('SHEET_DATA_VALIDATION_PLUGIN')
  const listed = (lists: Record<string, unknown>, id: string): number => (Array.isArray(lists[id]) ? (lists[id] as unknown[]).length : 0)
  const sheets: SheetFacts[] = wb.sheetOrder.map((id) => {
    const sheet = wb.sheets[id]
    const data = sheet?.cellData ?? {}
    let formulas = 0
    let newFunctions = 0
    let styled = (sheet?.mergeData?.length ?? 0) > 0
    let rows = 0
    let cols = 0
    for (const [r, row] of Object.entries(data)) {
      for (const [c, cell] of Object.entries((row ?? {}) as Record<string, ICellData | null | undefined>)) {
        if (!cell) continue
        if (cell.f || cell.si) formulas++
        if (cell.f && newer(cell.f)) newFunctions++
        if (cell.s) styled = true
        if (cell.v !== undefined && cell.v !== null && cell.v !== '') {
          rows = Math.max(rows, Number(r) + 1)
          cols = Math.max(cols, Number(c) + 1)
        }
      }
    }
    return { name: sheet?.name ?? id, chart: false, formulas, newFunctions, styled, rows, cols, rules: listed(conditional, id) + listed(validation, id), charts: 0, pictures: 0 }
  })
  const facts: BookFacts = { ...structuredClone(EMPTY), sheets, ours }
  for (const rules of Object.values(conditional))
    for (const r of Array.isArray(rules) ? rules : []) {
      const type = (r as { rule?: { type?: string } }).rule?.type
      facts.conditional.total++
      if (type === 'colorScale') facts.conditional.scales++
      else if (type === 'dataBar') facts.conditional.bars++
      else if (type === 'iconSet') facts.conditional.icons++
    }
  for (const rules of Object.values(validation)) facts.validations += Array.isArray(rules) ? rules.length : 0
  for (const tables of Object.values(resource('SHEET_TABLE_PLUGIN'))) facts.tables += Array.isArray(tables) ? tables.length : tables && typeof tables === 'object' ? Object.keys(tables).length : 0
  facts.names = Object.keys(resource('SHEET_DEFINED_NAME_PLUGIN')).length
  facts.filters = Object.values(resource('SHEET_FILTER_PLUGIN')).filter((f) => !!f && typeof f === 'object' && (f as { ref?: unknown }).ref).length
  for (const notes of Object.values(resource('SHEET_NOTE_PLUGIN')))
    if (notes && typeof notes === 'object') for (const row of Object.values(notes as Record<string, unknown>)) facts.notes += row && typeof row === 'object' ? Object.keys(row).length : 0
  return facts
}

/** Excel 97-2003's grid: 65,536 rows and 256 columns (IV). */
export const XLS_ROWS = 65_536
export const XLS_COLS = 256

const n = (value: number): string => value.toLocaleString('en-US')
/** "1 formula becomes its value", "12 formulas become their values". */
const some = (value: number, one: string, many: string): string | null => (value > 0 ? (value === 1 ? one : many.replace('{n}', n(value))) : null)
/** Names in a line: "Flights", "Flights and Hotel", "Flights, Hotel and Taxis". */
const listOf = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

export interface DropsOptions {
  /** the sheet a CSV or TSV holds; the first worksheet when absent */
  sheet?: string
  /** the workbook is an opened package (its Excel picture is the file itself) */
  package?: boolean
  /** what the model writer could not hold in the .xlsx it made, in its words ("the names") */
  left?: readonly string[]
}

/** The worksheet a one-sheet format takes: the named one, else the first that is no chart. */
export function sheetFor(facts: BookFacts, name?: string): SheetFacts | undefined {
  const tabs = facts.sheets.filter((s) => !s.chart)
  return (name !== undefined ? tabs.find((s) => s.name === name) : undefined) ?? tabs[0]
}

/**
 * What `format` drops of this workbook, one plain line each, counted from it. Only what is measured
 * is said (the editors plan, decision 8): OpenDocument keeps the rules, tables, charts and names and
 * turns a chartsheet into a sheet holding its chart; Excel 97-2003 drops colour scales, data bars and
 * icon sets, makes tables plain ranges, and cuts rows and columns past its grid; CSV and TSV keep one
 * sheet's shown values; a web page keeps the values and their look. A PDF and a print lose nothing
 * but what LibreOffice cannot draw.
 */
export function sheetDrops(format: SheetPreviewFormat | 'print', facts: BookFacts, opts: DropsOptions = {}): string[] {
  const lines: (string | null)[] = []
  const undrawn = some(facts.newCharts, '1 chart of a newer kind is not drawn', '{n} charts of newer kinds are not drawn')
  const ours = some(facts.ours, '1 chart made here stays behind', '{n} charts made here stay behind')
  if (format === 'pdf' || format === 'print') lines.push(undrawn)
  if (format === 'xlsx') {
    // The file itself keeps the newer charts; only the picture lacks them.
    if (opts.package) lines.push(some(facts.newCharts, '1 chart of a newer kind is not drawn here; the file keeps it', '{n} charts of newer kinds are not drawn here; the file keeps them'))
    else lines.push(some(facts.notes, '1 note stays behind', '{n} notes stay behind'))
    for (const what of opts.left ?? []) lines.push(`${what[0].toUpperCase()}${what.slice(1)} stay${/^the filter/.test(what) ? 's' : ''} behind`)
  }
  if (format === 'ods') {
    for (const s of facts.sheets) if (s.chart) lines.push(`${s.name} becomes a sheet holding its chart`)
    lines.push(undrawn)
  }
  if (format === 'xls') {
    lines.push(some(facts.conditional.scales, '1 colour scale stays behind', '{n} colour scales stay behind'))
    lines.push(some(facts.conditional.bars, '1 data bar stays behind', '{n} data bars stay behind'))
    lines.push(some(facts.conditional.icons, '1 icon set stays behind', '{n} icon sets stay behind'))
    lines.push(some(facts.tables, '1 table becomes a plain range', '{n} tables become plain ranges'))
    lines.push(some(facts.sheets.reduce((sum, s) => sum + s.newFunctions, 0), '1 formula uses a function Excel 97-2003 does not have', '{n} formulas use functions Excel 97-2003 does not have'))
    for (const s of facts.sheets) {
      if (s.rows > XLS_ROWS) lines.push(`${s.name} loses ${n(s.rows - XLS_ROWS)} row${s.rows - XLS_ROWS === 1 ? '' : 's'} past row ${n(XLS_ROWS)}`)
      if (s.cols > XLS_COLS) lines.push(`${s.name} loses ${n(s.cols - XLS_COLS)} column${s.cols - XLS_COLS === 1 ? '' : 's'} past column IV`)
    }
    lines.push(undrawn)
  }
  if (format === 'csv' || format === 'tsv') {
    const sheet = sheetFor(facts, opts.sheet)
    const others = facts.sheets.filter((s) => s !== sheet).map((s) => s.name)
    lines.push(others.length === 0 ? null : others.length <= 3 ? `${listOf(others)} ${others.length === 1 ? 'stays' : 'stay'} behind` : `${n(others.length)} other sheets stay behind`)
    lines.push(some(sheet?.formulas ?? 0, '1 formula becomes its value', '{n} formulas become their values'))
    if (sheet?.styled) lines.push('Formatting stays behind')
    // The sheet's own: what the other sheets hold goes with them, said once in the line above.
    lines.push(some(sheet?.rules ?? 0, '1 rule stays behind', '{n} rules stay behind'))
    lines.push(some(sheet?.charts ?? 0, '1 chart stays behind', '{n} charts stay behind'))
    lines.push(some(sheet?.pictures ?? 0, '1 picture stays behind', '{n} pictures stay behind'))
  }
  if (format === 'html') {
    lines.push(some(facts.sheets.reduce((sum, s) => sum + s.formulas, 0), '1 formula becomes its value', '{n} formulas become their values'))
    lines.push(some(facts.conditional.total, '1 conditional format stays behind', '{n} conditional formats stay behind'))
    lines.push(some(facts.validations, '1 validation stays behind', '{n} validations stay behind'))
    lines.push(some(facts.filters, 'The filter stays behind', '{n} filters stay behind'))
    lines.push(some(facts.charts + facts.newCharts, '1 chart stays behind', '{n} charts stay behind'))
    lines.push(some(facts.pictures, '1 picture stays behind', '{n} pictures stay behind'))
  }
  lines.push(ours)
  return [...new Set(lines.filter((line): line is string => !!line))]
}
