import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { ICellData, IWorkbookData } from '@univerjs/core'
import { importXlsx, type ImportReport } from 'work-kit/sheet/xlsx'
import type { SheetCellDiff, SheetMutationJson, SheetReach } from '@shared/contract-work-sheets'
import { RULES_SET, type ObjectIds, type ObjectListKind, type RulesSetParams } from '@shared/work/sheets'
import { cellName, rangeCells, READ_MAX_CELLS, type A1Range } from './a1'
import { readThemeXml } from 'work-kit/format/theme'
import { defaultPageSetup, type SheetPageSetup } from 'work-kit/sheet/pages'
import { independent } from './patch/depends'
import { patchFormat, type FormatReport } from './patch/format'
import { dependsInput } from './patch/package'
import { patchXlsx, workbookMap, type EditSpec, type Report } from './patch/patch'
import { patchRules, readRules, type DefinedNames, type RulesEdit, type SheetFilter } from './patch/rules'
import { patchPages, type PagesEdit } from './patch/pages'
import { patchTables, readTables, type TablesEdit } from './patch/tables'
import { patchText, type TextEdit } from './patch/text'
import { patchNotes, type NotesEdit } from './patch/notes'
import { SHEET_NOTE, SHEET_TEXT, type SheetNoteParams, type SheetTextParams } from './mutations'
import { NOTES_RESOURCE, sheetNotes } from './host/rules'
import { patchCharts, type ChartsEdit } from './patch/charts'
import { patchPictures, readPictures, type PictureModel, type PicturesEdit } from './patch/pictures'
import { formatEditsOf } from './formats'
import { diffWorkbooks } from './diff'
import { waitsOf } from './excelWaits'
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
  /** its note's words, when it has a note (a thread's stand-in is none) */
  note?: string
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
    /** the charts and pictures the save wrote that the file now names otherwise: the canvas takes these ids */
    ids?: ObjectIds
  }
}

/** What our grid cannot reach in a package: the things only Excel does, counted from the importer's report (excelWaits.ts). */
export function reachOf(report: Pick<ImportReport, 'unsupported'>): SheetReach | null {
  const parts = waitsOf(report)
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
  const notes = sheetNotes(workbook.resources?.find((x) => x.name === NOTES_RESOURCE)?.data, sheet.id)
  const cells: ReadCell[][] = []
  for (let r = range.startRow; r <= range.endRow; r++) {
    const row: ReadCell[] = []
    for (let c = range.startColumn; c <= range.endColumn; c++) {
      const out = cellOut(`${colName(c)}${r + 1}`, data[r]?.[c])
      const note = notes.get(`${r}:${c}`)
      row.push(note !== undefined ? { ...out, note } : out)
    }
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

/** The rule lists among a save's formatting mutations (`RULES_SET`, each named by its tab), as the rules writer takes them. */
export function rulesEditsOf(formats: readonly SheetMutationJson[]): RulesEdit[] {
  const out: RulesEdit[] = []
  for (const m of formats) {
    if (m.id !== RULES_SET) continue
    const p = m.params as RulesSetParams
    if (p.kind === 'tables' || p.kind === 'pages' || p.kind === 'charts' || p.kind === 'pictures') continue
    if (p.kind === 'names') out.push({ kind: 'names', names: (p.list ?? []) as DefinedNames })
    else if (!p.subUnitId) throw new Error('A rule names its sheet.')
    else if (p.kind === 'filter') out.push({ kind: 'filter', sheet: p.subUnitId, filter: (p.list ?? null) as SheetFilter | null })
    else out.push({ kind: p.kind, sheet: p.subUnitId, rules: (Array.isArray(p.list) ? p.list : []) as never })
  }
  return out
}

/** The page set-ups among a save's formatting mutations (`RULES_SET` of kind `pages`, each named by its tab), as the page writer takes them: the last on a tab stands. */
export function pagesEditsOf(formats: readonly SheetMutationJson[]): PagesEdit[] {
  const last = new Map<string, PagesEdit>()
  for (const m of formats) {
    if (m.id !== RULES_SET) continue
    const p = m.params as RulesSetParams
    if (p.kind !== 'pages') continue
    if (!p.subUnitId) throw new Error('A page set-up names its sheet.')
    // A sheet with none of its own prints by Excel's defaults.
    last.set(p.subUnitId, { sheet: p.subUnitId, setup: (p.list ?? defaultPageSetup()) as SheetPageSetup })
  }
  return [...last.values()]
}

/** The table lists among a save's formatting mutations (`RULES_SET` of kind `tables`, each named by its tab), as the table writer takes them. */
export function tablesEditsOf(formats: readonly SheetMutationJson[]): TablesEdit[] {
  const out: TablesEdit[] = []
  for (const m of formats) {
    if (m.id !== RULES_SET) continue
    const p = m.params as RulesSetParams
    if (p.kind !== 'tables') continue
    if (!p.subUnitId) throw new Error('A table names its sheet.')
    out.push({ kind: 'tables', sheet: p.subUnitId, tables: (Array.isArray(p.list) ? p.list : []) as never })
  }
  return out
}

/** The rich cells among a save's formatting mutations (`SHEET_TEXT`, each named by its tab), as the text writer takes them; the last word on a cell wins. */
export function textEditsOf(formats: readonly SheetMutationJson[]): TextEdit[] {
  const bySheet = new Map<string, Map<string, TextEdit['cells'][number]>>()
  for (const m of formats) {
    if (m.id !== SHEET_TEXT) continue
    const p = m.params as SheetTextParams
    const cells = bySheet.get(p.subUnitId) ?? new Map()
    for (const c of p.cells) cells.set(`${c.row}:${c.column}`, c)
    bySheet.set(p.subUnitId, cells)
  }
  return [...bySheet].map(([sheet, cells]) => ({ kind: 'text', sheet, cells: [...cells.values()] }))
}

/** A note's new words among a save's formatting mutations (`SHEET_NOTE`), as the notes writer takes them. */
export function notesEditsOf(formats: readonly SheetMutationJson[]): NotesEdit[] {
  const bySheet = new Map<string, NotesEdit['notes']>()
  for (const m of formats) {
    if (m.id !== SHEET_NOTE) continue
    const p = m.params as SheetNoteParams
    bySheet.set(p.subUnitId, [...(bySheet.get(p.subUnitId) ?? []), { row: p.row, column: p.column, text: p.text }])
  }
  return [...bySheet].map(([sheet, notes]) => ({ kind: 'notes', sheet, notes }))
}

/**
 * A rich cell's words go through the patch writer only where they changed: a cell restyled keeps its
 * words, and a table's header may take a style but no write (the patch writer refuses one).
 */
function changedWords(input: string, edits: EditSpec[], text: readonly TextEdit[]): EditSpec[] {
  const rich = new Set(text.flatMap((t) => t.cells.map((c) => `${t.sheet}\u0000${cellName(c.row, c.column)}`)))
  if (!edits.some((e) => rich.has(`${e.sheet}\u0000${e.cell}`))) return edits
  const { workbook } = importPackage(input)
  return edits.filter((e) => {
    if (!rich.has(`${e.sheet}\u0000${e.cell}`) || e.formula !== undefined) return true
    const m = /^([A-Z]+)(\d+)$/.exec(e.cell)
    const id = workbook.sheetOrder.find((s) => workbook.sheets[s]?.name === e.sheet)
    if (!m || !id) return true
    const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
    const was = workbook.sheets[id]?.cellData?.[Number(m[2]) - 1]?.[col]
    return !!was?.f || String(was?.v ?? '') !== String(e.value ?? '')
  })
}

/** A tab's lists of one object kind among a save's formatting mutations, by its tab's name: the last a tab was sent, as the writers take one list a tab. */
function objectLists(formats: readonly SheetMutationJson[], kind: ObjectListKind): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>()
  for (const m of formats) {
    const p = m.params as RulesSetParams
    if (m.id !== RULES_SET || p.kind !== kind) continue
    if (!p.subUnitId) throw new Error('A chart or picture list names its sheet.')
    out.delete(p.subUnitId)
    out.set(p.subUnitId, Array.isArray(p.list) ? p.list : [])
  }
  return out
}

/** The chart lists among a save's formatting mutations (`RULES_SET` of kind `charts`, each named by its tab's name), as the chart writer takes them. */
export function chartsEditsOf(formats: readonly SheetMutationJson[]): ChartsEdit[] {
  return [...objectLists(formats, 'charts')].map(([sheet, list]) => ({ kind: 'charts', sheet, charts: list as ChartsEdit['charts'] }))
}

/** The picture lists likewise: a picture made on the grid carries its bytes as base64 (`data`), handed to the writer as bytes. */
export function picturesEditsOf(formats: readonly SheetMutationJson[]): PicturesEdit[] {
  return [...objectLists(formats, 'pictures')].map(([sheet, list]) => ({
    kind: 'pictures',
    sheet,
    pictures: (list as (PictureModel & { data?: unknown })[]).map(({ data, ...picture }) => (typeof data === 'string' ? { ...picture, bytes: new Uint8Array(Buffer.from(data, 'base64')) } : picture))
  }))
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
 * 1,462 days). `formats` are the grid's formatting mutations, each named by its tab (mutations.ts);
 * a rule's whole list among them is laid by the rules writer (`patch/rules.ts`), a rich cell's runs by
 * the text writer (`patch/text.ts`) and a note's words by the notes writer (`patch/notes.ts`), both
 * after the cells' words, so a cell whose words changed is not marked twice.
 */
export async function savePackage(input: string, edits: EditSpec[], ironcalcDir: string | null, formats: readonly SheetMutationJson[] = []): Promise<{ bytes: Uint8Array } & SaveAnswer> {
  let bytes: Uint8Array = new Uint8Array(readFileSync(input))
  const zip = readZip(bytes)
  const text = textEditsOf(formats)
  if (text.length && edits.length) edits = changedWords(input, edits, text)
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
  const lists = rulesEditsOf(formats)
  if (lists.length) {
    // A rule never changes a cell's contents: the lists are laid part by part, no model and no engine.
    const done = patchRules(bytes, lists)
    bytes = done.bytes
    report.partsChanged = [...new Set([...report.partsChanged, ...done.report.partsChanged])]
    // A name's meaning or the rows a filter hides can change what a formula answers (a name it reads, SUBTOTAL over
    // the filter): no engine here knows, so Excel is asked to calculate again on load.
    if (!report.recalc.fullCalcOnLoad && lists.some((l) => l.kind === 'names' || l.kind === 'filter')) {
      const again = await patchXlsx(bytes, [], {})
      bytes = again.bytes
      report.partsChanged = [...new Set([...report.partsChanged, ...again.report.partsChanged])]
      report.recalc.fullCalcOnLoad = again.report.recalc.fullCalcOnLoad
    }
  }
  const tables = tablesEditsOf(formats)
  if (tables.length) {
    // A table is a part of its own with its relationship and content type; the writer fills a header it had to
    // name, a total row and a calculated column, and asks Excel to calculate again where it wrote a formula.
    const done = patchTables(bytes, tables)
    bytes = done.bytes
    report.partsChanged = [...new Set([...report.partsChanged, ...done.report.partsChanged, ...done.report.partsAdded, ...done.report.partsRemoved])]
  }
  const pages = pagesEditsOf(formats)
  if (pages.length) {
    // Paper, margins, scale or fit, breaks, the print area and titles: the worksheet's own part and, for an area or titles, the workbook's names.
    const done = patchPages(bytes, pages)
    bytes = done.bytes
    report.partsChanged = [...new Set([...report.partsChanged, ...done.report.partsChanged])]
  }
  if (text.length) {
    // After the words: a cell whose words changed already holds them, and is not marked to calculate again twice.
    const done = patchText(bytes, text)
    bytes = done.bytes
    report.partsChanged = [...new Set([...report.partsChanged, ...done.report.partsChanged, ...done.report.partsAdded, ...done.report.partsRemoved])]
    report.recalc.fullCalcOnLoad ||= done.report.fullCalcOnLoad
  }
  const notes = notesEditsOf(formats)
  if (notes.length) {
    const done = patchNotes(bytes, notes)
    bytes = done.bytes
    report.partsChanged = [...new Set([...report.partsChanged, ...done.report.partsChanged])]
  }
  // After the cells and the tables, so a new chart's cache holds what the cells now hold. A refusal (ObjectsRefused) is
  // thrown before anything is written, in words for the person.
  const ids: ObjectIds = {}
  const charts = chartsEditsOf(formats)
  if (charts.length) {
    const done = patchCharts(bytes, charts)
    bytes = done.bytes
    report.partsChanged = [...new Set([...report.partsChanged, ...done.report.partsChanged, ...done.report.partsAdded, ...done.report.partsRemoved])]
    for (const [from, to] of Object.entries(done.report.ids)) if (from !== to) ids[from] = { id: to }
  }
  const pictures = picturesEditsOf(formats)
  if (pictures.length) {
    const done = patchPictures(bytes, pictures)
    bytes = done.bytes
    report.partsChanged = [...new Set([...report.partsChanged, ...done.report.partsChanged, ...done.report.partsAdded, ...done.report.partsRemoved])]
    const sent = new Map(pictures.flatMap((edit) => edit.pictures.map((p) => [p.id, p.part] as const)))
    const changed = Object.entries(done.report.ids).filter(([from, to]) => from !== to || sent.get(from)?.startsWith('media:'))
    if (changed.length) {
      // A picture's id and part in the file as written: a picture made on the grid had a part of its own ('media:…').
      const parts = new Map(Object.values(readPictures(bytes).sheets).flatMap((tab) => tab.pictures.map((p) => [p.id, p.part] as const)))
      for (const [from, to] of changed) {
        const part = parts.get(to)
        ids[from] = part ? { id: to, part } : { id: to }
      }
    }
  }
  if (Object.keys(ids).length) report.ids = ids
  if (formats.length) {
    const made = formatEditsOf(formats.filter((m) => m.id !== RULES_SET && m.id !== SHEET_TEXT && m.id !== SHEET_NOTE), (tab) => tab, themeOf(zip))
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

/** The rules a package holds, by sheet id, as the importer models them (Univer's own models): the sheets and kinds that have any. */
export interface PackageRules {
  conditional: Record<string, unknown[]>
  validation: Record<string, unknown[]>
  names: unknown[]
  filter: Record<string, unknown>
  tables: Record<string, unknown[]>
}

/** Read from the rule parts alone (patch/rules-reader.ts): no cell is parsed, so a large workbook answers in a fraction of an import. */
export function packageRules(path: string): PackageRules {
  const got = readRules(new Uint8Array(readFileSync(path)))
  const out: PackageRules = { conditional: {}, validation: {}, names: Object.values(got.names), filter: {}, tables: {} }
  for (const tab of Object.values(readTables(new Uint8Array(readFileSync(path))).sheets)) if (tab.tables.length) out.tables[tab.id] = tab.tables
  for (const tab of Object.values(got.sheets)) {
    if (tab.conditional.length) out.conditional[tab.id] = tab.conditional
    if (tab.validation.length) out.validation[tab.id] = tab.validation
    if (tab.filter) out.filter[tab.id] = tab.filter
  }
  return out
}

/** One sheet of a package as CSV (writer.ts). */
/**
 * One sheet's shown values as CSV. A formula whose value is not worked out has no true value to write: none is in the
 * file (typed where no engine ran), or the file asks Excel to calculate everything again on load (a value in it may
 * be from before an edit). Refused, never written as an empty or an old field.
 */
export function packageCsv(path: string, sheet?: string): string {
  const { workbook } = importPackage(path)
  const cell = unworkedIn(workbook, () => new Uint8Array(readFileSync(path)), sheet)
  if (cell) throw new Error(notWorkedOut(cell))
  return writeCsv(workbook, sheet)
}

/** Why a sheet is not written out as text, in his words. */
export const notWorkedOut = (cell: string): string => `The formula in ${cell} has no value worked out yet, so the sheet cannot be written as text.`

/**
 * The first formula of a sheet (the first sheet when none is named) whose value is not worked out, as A1, or null: no
 * value is kept beside it, or the file asks to be calculated again on load, so none it keeps can be trusted.
 */
export function unworkedIn(workbook: IWorkbookData, bytes: () => Uint8Array, sheet?: string): string | null {
  const id = sheet === undefined ? workbook.sheetOrder[0] : workbook.sheetOrder.find((s) => workbook.sheets[s]?.name === sheet)
  const cells = ((id && workbook.sheets[id]?.cellData) || {}) as Record<string, Record<string, ICellData | null | undefined>>
  let later: boolean | undefined
  for (const [r, cols] of Object.entries(cells))
    for (const [c, cell] of Object.entries(cols ?? {})) {
      if (!cell?.f && !cell?.si) continue
      later ??= CALC_ON_LOAD.test(workbookMap(readZip(bytes())).wbXml)
      if (later || cell.v === undefined || cell.v === null) return cellName(Number(r), Number(c))
    }
  return null
}
const CALC_ON_LOAD = /<(?:[\w.-]+:)?calcPr(?=[\s>/])[^>]*\bfullCalcOnLoad\s*=\s*["'](?:1|true)["']/

export function comparePackages(from: string, to: string, max: number): { cells: SheetCellDiff[]; truncated: boolean } {
  return diffWorkbooks(importXlsx(new Uint8Array(readFileSync(from))).workbook, importXlsx(new Uint8Array(readFileSync(to))).workbook, max)
}
