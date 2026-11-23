import type { ICellData, IStyleData, IWorkbookData, IWorksheetData } from '@univerjs/core'
import { toFileFormula } from './patch/formula'
import { patchRules, RulesRefused, type DefinedName, type RulesEdit, type SheetFilter } from './patch/rules'
import { PagesRefused, patchPages, type PagesEdit } from './patch/pages'
import { patchTables, TablesRefused, type TablesEdit } from './patch/tables'
import { fileReferences, fold } from './patch/tables-model'
import { readZip, writeZip } from './patch/zip'
import { colName, esc, escText } from './patch/xml'
import { excelColour, TEMPCODE_THEME, themeXml, type OfficeTheme } from 'work-kit/format/theme'
import { colourOfStyle } from 'work-kit/sheet/colour'
import { tableModel } from 'work-kit/sheet/tables'

/**
 * The model writer (architecture §9.1): a sheet made here (a LifeOS sheet, a
 * `.tcsheet`) written out as a new .xlsx, or one of its sheets as .csv. It
 * covers what our grid makes: values, formulas with their last values,
 * fonts, fills, borders, number formats, alignment and wrap, merges, column
 * widths and row heights, frozen panes, hidden sheets. A colour picked from
 * the theme is written as that theme colour with its tint, beside the theme
 * itself (the file's own where the sheet came from one, else TempCode's), so
 * changing the theme in Excel recolours it. The workbook's rules (conditional
 * formats, validations, names, a filter) are then written into that file by
 * the patch writer, the one an opened Excel file is saved with, so both hold
 * a rule the same way. An opened package is never written by this: it stays
 * its own truth.
 */

const enc = new TextEncoder()
export const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml'

/** Univer's CellValueType */
const T_STRING = 1
const T_BOOLEAN = 3
const T_FORCE_STRING = 4

interface Pools {
  fonts: string[]
  fills: string[]
  borders: string[]
  numFmts: Map<string, number>
  xfs: string[]
  /** the workbook's default font: what a cell that names no face or size is written in */
  font: { family: string; size: number }
}

const rgb = (c: { rgb?: string | null } | null | undefined | unknown): string | null => {
  const v = (c as { rgb?: string | null } | null | undefined)?.rgb?.replace('#', '')
  if (!v) return null
  if (/^[0-9a-f]{6}$/i.test(v)) return `FF${v.toUpperCase()}`
  if (/^[0-9a-f]{3}$/i.test(v))
    return `FF${[...v]
      .map((x) => x + x)
      .join('')
      .toUpperCase()}`
  return null
}
/**
 * A `<color>`-like element's attributes: `theme` and `tint` for a colour that carries its theme
 * slot (work-kit's colour.ts), else `rgb`; null for no colour.
 */
const colorAttrs = (c: unknown): string | null => {
  const colour = colourOfStyle(c as { rgb?: string | null; th?: number } | null | undefined)
  if (colour && 'theme' in colour) {
    const x = excelColour(colour) as { theme: number; tint?: number }
    return `theme="${x.theme}"${x.tint ? ` tint="${x.tint}"` : ''}`
  }
  const v = rgb(c)
  return v ? `rgb="${v}"` : null
}
const at = (pool: string[], xml: string): number => {
  const i = pool.indexOf(xml)
  return i >= 0 ? i : pool.push(xml) - 1
}
const BORDER_STYLE: Record<number, string> = {
  1: 'thin',
  2: 'hair',
  3: 'dotted',
  4: 'dashed',
  5: 'dashDot',
  6: 'dashDotDot',
  7: 'double',
  8: 'medium',
  9: 'mediumDashed',
  10: 'mediumDashDot',
  11: 'mediumDashDotDot',
  12: 'slantDashDot',
  13: 'thick'
}

/** The cellXfs index for a Univer style; 0 for none. */
function xfOf(style: IStyleData | null | undefined, pools: Pools): number {
  if (!style || !Object.keys(style).length) return 0
  const font = `<font>${style.bl ? '<b/>' : ''}${style.it ? '<i/>' : ''}${style.st?.s ? '<strike/>' : ''}${style.ul?.s ? '<u/>' : ''}<sz val="${style.fs ?? pools.font.size}"/>${colorAttrs(style.cl) ? `<color ${colorAttrs(style.cl)}/>` : ''}<name val="${esc(style.ff ?? pools.font.family)}"/></font>`
  const bg = colorAttrs(style.bg)
  const fill = bg
    ? `<fill><patternFill patternType="solid"><fgColor ${bg}/><bgColor indexed="64"/></patternFill></fill>`
    : null
  const side = (name: string, b?: { s?: number; cl?: { rgb?: string | null } } | null) =>
    b?.s
      ? `<${name} style="${BORDER_STYLE[b.s] ?? 'thin'}">${colorAttrs(b.cl) ? `<color ${colorAttrs(b.cl)}/>` : '<color auto="1"/>'}</${name}>`
      : `<${name}/>`
  const bd = style.bd as { l?: never; r?: never; t?: never; b?: never } | undefined
  const border = bd
    ? `<border>${side('left', bd.l)}${side('right', bd.r)}${side('top', bd.t)}${side('bottom', bd.b)}<diagonal/></border>`
    : null
  const pattern = style.n?.pattern
  let numFmt = 0
  if (pattern) {
    numFmt = pools.numFmts.get(pattern) ?? 164 + pools.numFmts.size
    pools.numFmts.set(pattern, numFmt)
  }
  const h = ({ 1: 'left', 2: 'center', 3: 'right', 4: 'justify' } as Record<number, string>)[
    style.ht ?? 0
  ]
  const v = ({ 1: 'top', 2: 'center', 3: 'bottom' } as Record<number, string>)[style.vt ?? 0]
  const wrap = style.tb === 3
  const align =
    h || v || wrap
      ? `<alignment${h ? ` horizontal="${h}"` : ''}${v ? ` vertical="${v}"` : ''}${wrap ? ' wrapText="1"' : ''}/>`
      : ''
  const fontId = at(pools.fonts, font)
  const fillId = fill ? at(pools.fills, fill) : 0
  const borderId = border ? at(pools.borders, border) : 0
  const xf = `<xf numFmtId="${numFmt}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmt ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${align ? ` applyAlignment="1">${align}</xf>` : '/>'}`
  return at(pools.xfs, xf)
}

function cellXml(ref: string, cell: ICellData, s: number, words: (formula: string) => string = (f) => f): string {
  const sAttr = s ? ` s="${s}"` : ''
  const v = cell.v
  if (cell.f) {
    const f = `<f>${esc(words(toFileFormula(cell.f)))}</f>`
    if (typeof v === 'number') return `<c r="${ref}"${sAttr}>${f}<v>${v}</v></c>`
    if (typeof v === 'boolean') return `<c r="${ref}"${sAttr} t="b">${f}<v>${v ? 1 : 0}</v></c>`
    if (typeof v === 'string' && v !== '')
      return `<c r="${ref}"${sAttr} t="str">${f}<v>${escText(v)}</v></c>`
    return `<c r="${ref}"${sAttr}>${f}</c>`
  }
  if (v === undefined || v === null || v === '') return s ? `<c r="${ref}"${sAttr}/>` : ''
  if (typeof v === 'boolean' || (cell.t === T_BOOLEAN && (v === 1 || v === 0)))
    return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`
  if (typeof v === 'number' && cell.t !== T_STRING && cell.t !== T_FORCE_STRING)
    return `<c r="${ref}"${sAttr}><v>${v}</v></c>`
  const text = String(v)
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t${/^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : ''}>${escText(text)}</t></is></c>`
}

const styleOf = (wb: IWorkbookData, s: ICellData['s']): IStyleData | null =>
  typeof s === 'string' ? (wb.styles?.[s] ?? null) : (s ?? null)
const sorted = (o: object): number[] =>
  Object.keys(o)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b)

/**
 * A cell's formula in the words Excel keeps in a file where it names a table (`[@Qty]` by the table the cell sits
 * in, a bare table name as `Costs[]`: patch/tables-model.ts `fileReferences`; Excel reads the typed words as #REF!
 * and #NAME?). A workbook with no table gets its formulas as they came.
 */
function tableWords(wb: IWorkbookData, sheetId: string): (row: number, col: number, formula: string) => string {
  let all: Record<string, { tables?: { name: string; range: { startRow: number; endRow: number; startColumn: number; endColumn: number } }[] } | null> = {}
  try {
    all = JSON.parse(wb.resources?.find((r) => r.name === 'SHEET_TABLE_PLUGIN')?.data ?? '{}') ?? {}
  } catch {
    all = {}
  }
  const tables = new Set<string>()
  for (const held of Object.values(all)) for (const table of held?.tables ?? []) if (typeof table?.name === 'string') tables.add(fold(table.name))
  if (!tables.size) return (_row, _col, formula) => formula
  const here = all[sheetId]?.tables ?? []
  return (row, col, formula) => {
    const own = here.find((t) => row >= t.range.startRow && row <= t.range.endRow && col >= t.range.startColumn && col <= t.range.endColumn)
    return fileReferences(formula, { own: own?.name ?? '', tables })
  }
}

function sheetXml(wb: IWorkbookData, sh: IWorksheetData, pools: Pools): string {
  const rows: string[] = []
  const said = tableWords(wb, sh.id)
  let maxR = 0
  let maxC = 0
  const data = sh.cellData ?? {}
  const rowData = (sh.rowData ?? {}) as Record<number, { h?: number; hd?: number } | undefined>
  for (const r of [
    ...new Set([...sorted(data), ...sorted(rowData).filter((r) => rowData[r]?.h || rowData[r]?.hd)])
  ].sort((a, b) => a - b)) {
    const cells: string[] = []
    const line = (data[r] ?? {}) as Record<number, ICellData | null | undefined>
    for (const c of sorted(line)) {
      const cell = line[c]
      if (!cell) continue
      const xml = cellXml(`${colName(c + 1)}${r + 1}`, cell, xfOf(styleOf(wb, cell.s), pools), (f) => said(r, c, f))
      if (!xml) continue
      cells.push(xml)
      maxR = Math.max(maxR, r)
      maxC = Math.max(maxC, c)
    }
    const info = rowData[r]
    const ht = info?.h ? ` ht="${Math.round(info.h * 0.75 * 100) / 100}" customHeight="1"` : ''
    const hidden = info?.hd ? ' hidden="1"' : ''
    if (cells.length || ht || hidden)
      rows.push(`<row r="${r + 1}"${ht}${hidden}>${cells.join('')}</row>`)
  }
  const colData = (sh.columnData ?? {}) as Record<number, { w?: number; hd?: number } | undefined>
  const cols = sorted(colData)
    .filter((c) => colData[c]?.w || colData[c]?.hd)
    .map(
      (c) =>
        `<col min="${c + 1}" max="${c + 1}" width="${Math.max(0, Math.round((((colData[c]!.w ?? 64) - 5) / 7) * 100) / 100)}" customWidth="1"${colData[c]!.hd ? ' hidden="1"' : ''}/>`
    )
  const fz = sh.freeze as
    { xSplit?: number; ySplit?: number; startRow?: number; startColumn?: number } | undefined
  const frozen = fz && ((fz.xSplit ?? 0) > 0 || (fz.ySplit ?? 0) > 0)
  const pane = frozen
    ? `<pane${fz!.xSplit ? ` xSplit="${fz!.xSplit}"` : ''}${fz!.ySplit ? ` ySplit="${fz!.ySplit}"` : ''} topLeftCell="${colName((fz!.startColumn ?? fz!.xSplit ?? 0) + 1)}${(fz!.startRow ?? fz!.ySplit ?? 0) + 1}" activePane="${fz!.xSplit && fz!.ySplit ? 'bottomRight' : fz!.ySplit ? 'bottomLeft' : 'topRight'}" state="frozen"/>`
    : ''
  const merges = (sh.mergeData ?? []).map(
    (m) =>
      `<mergeCell ref="${colName(m.startColumn + 1)}${m.startRow + 1}:${colName(m.endColumn + 1)}${m.endRow + 1}"/>`
  )
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${R}">` +
    `<dimension ref="A1${maxR || maxC ? `:${colName(maxC + 1)}${maxR + 1}` : ''}"/>` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (cols.length ? `<cols>${cols.join('')}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '') +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
  )
}

/** A sheet name as Excel takes it: no []:*?/\, 31 characters, unique. */
function excelName(name: string, taken: Set<string>): string {
  let base =
    name
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || 'Sheet'
  let out = base
  for (let i = 2; taken.has(out.toLowerCase()); i++)
    out = `${base.slice(0, 31 - String(i).length - 1)} ${i}`
  taken.add(out.toLowerCase())
  base = out
  return base
}

/**
 * The workbook's theme and default font as its snapshot carries them (the importer's `custom`). A sheet made here names
 * neither: it wears TempCode's theme, and its default is Calibri at the size the grid draws a plain cell in (work-kit's
 * `SHEET_FONT_SIZE`, 13px), so Excel shows its text at the size the screen did.
 */
const MADE_HERE = { family: 'Calibri', size: 9.75 }
function lookOf(wb: IWorkbookData): { theme: OfficeTheme; font: { family: string; size: number } } {
  const custom = (wb.custom ?? {}) as { theme?: OfficeTheme; defaults?: { family?: unknown; size?: unknown } }
  const theme = custom.theme && typeof custom.theme === 'object' && custom.theme.colours && custom.theme.fonts ? custom.theme : TEMPCODE_THEME
  const d = custom.defaults
  return { theme, font: { family: typeof d?.family === 'string' && d.family ? d.family : MADE_HERE.family, size: typeof d?.size === 'number' && d.size > 0 ? d.size : MADE_HERE.size } }
}

/** The workbook as a new .xlsx. */
export function writeXlsx(wb: IWorkbookData): Uint8Array {
  return writeXlsxWhole(wb).bytes
}

/** The resources the grid's plugins keep a workbook's rules under (work-kit's importer writes the same). */
const RES = {
  names: 'SHEET_DEFINED_NAME_PLUGIN',
  conditional: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN',
  validation: 'SHEET_DATA_VALIDATION_PLUGIN',
  filter: 'SHEET_FILTER_PLUGIN'
} as const

/**
 * The workbook's rules as the patch writer takes them: each sheet's conditional formats and
 * validations, the names, a sheet's filter. `nameOf` gives the tab's name in the file being
 * written. A resource that does not parse, or a sheet that is gone, gives nothing.
 */
export function rulesOf(wb: IWorkbookData, nameOf: (sheetId: string) => string | undefined): RulesEdit[] {
  const read = (name: string): Record<string, unknown> => {
    const data = wb.resources?.find((r) => r.name === name)?.data
    if (!data) return {}
    try {
      const value = JSON.parse(data) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  const out: RulesEdit[] = []
  const names = Object.values(read(RES.names)) as DefinedName[]
  if (names.length) out.push({ kind: 'names', names })
  for (const kind of ['conditional', 'validation'] as const)
    for (const [id, rules] of Object.entries(read(RES[kind]))) {
      const sheet = nameOf(id)
      if (sheet && Array.isArray(rules) && rules.length) out.push({ kind, sheet, rules } as RulesEdit)
    }
  for (const [id, filter] of Object.entries(read(RES.filter))) {
    const sheet = nameOf(id)
    if (sheet && filter && typeof filter === 'object' && (filter as SheetFilter).ref) out.push({ kind: 'filter', sheet, filter: filter as SheetFilter })
  }
  return out
}

/** What a rule the file could not take is called, for the line that says it was left out. */
const RULE_WORDS = { names: 'names', conditional: 'conditional formats', validation: 'validations', filter: 'the filter' } as const

/**
 * The workbook as a new .xlsx, and what it could not hold. A rule the patch writer refuses (an
 * icon set of his own icons, a name Excel would not take) leaves its whole list out of the file
 * rather than failing the export: `left` names each, for whoever shows the export.
 */
export function writeXlsxWhole(wb: IWorkbookData): { bytes: Uint8Array; left: { what: string; sheet?: string; why: string }[] } {
  const base = writeCells(wb)
  const edits = rulesOf(wb, (id) => base.names.get(id))
  const left: { what: string; sheet?: string; why: string }[] = []
  let bytes = base.bytes
  const opts = { sheetIds: base.ids }
  if (edits.length) bytes = laidRules(bytes, edits, opts, left)
  // Each sheet's tables as real table parts (patch/tables.ts): a sheet whose tables the writer refuses keeps its cells and loses the tables, said.
  for (const edit of tablesOf(wb, (id) => base.names.get(id)))
    try {
      bytes = patchTables(bytes, [edit], opts).bytes
    } catch (err) {
      if (!(err instanceof TablesRefused)) throw err
      left.push({ what: 'tables', sheet: edit.sheet, why: err.message })
    }
  // Each sheet's page set-up (patch/pages.ts): paper, margins, breaks, the print area. One the writer refuses is left out, said.
  for (const edit of pagesOf(wb, (id) => base.names.get(id)))
    try {
      bytes = patchPages(bytes, [edit]).bytes
    } catch (err) {
      if (!(err instanceof PagesRefused)) throw err
      left.push({ what: 'page set-up', sheet: edit.sheet, why: err.message })
    }
  return { bytes, left }
}

/** Each sheet's page set-up as the grid's pages plugin keeps it in the snapshot (`TEMPCODE_SHEET_PAGES`, by sheet id), named by its tab. */
export function pagesOf(wb: IWorkbookData, nameOf: (sheetId: string) => string | undefined): PagesEdit[] {
  const data = wb.resources?.find((r) => r.name === 'TEMPCODE_SHEET_PAGES')?.data
  if (!data) return []
  let all: Record<string, unknown>
  try {
    all = (JSON.parse(data) ?? {}) as typeof all
  } catch {
    return []
  }
  const out: PagesEdit[] = []
  for (const [id, setup] of Object.entries(all)) {
    const sheet = nameOf(id)
    if (sheet && setup && typeof setup === 'object') out.push({ sheet, setup: setup as PagesEdit['setup'] })
  }
  return out
}

function laidRules(bytes: Uint8Array, edits: RulesEdit[], opts: { sheetIds: string[] }, left: { what: string; sheet?: string; why: string }[]): Uint8Array {
  try {
    return patchRules(bytes, edits, opts).bytes
  } catch (err) {
    if (!(err instanceof RulesRefused)) throw err
  }
  // One list was refused: lay each by itself, so the others are kept.
  for (const edit of edits)
    try {
      bytes = patchRules(bytes, [edit], opts).bytes
    } catch (err) {
      if (!(err instanceof RulesRefused)) throw err
      left.push({ what: RULE_WORDS[edit.kind], ...('sheet' in edit ? { sheet: edit.sheet } : {}), why: err.message })
    }
  return bytes
}

/** A workbook's tables (Univer's table plugin's resource), each sheet's list named by its tab, as the table writer takes them. */
export function tablesOf(wb: IWorkbookData, nameOf: (sheetId: string) => string | undefined): TablesEdit[] {
  const data = wb.resources?.find((r) => r.name === 'SHEET_TABLE_PLUGIN')?.data
  if (!data) return []
  let all: Record<string, { tables?: unknown[] } | null>
  try {
    all = (JSON.parse(data) ?? {}) as typeof all
  } catch {
    return []
  }
  const out: TablesEdit[] = []
  for (const [id, held] of Object.entries(all)) {
    const sheet = nameOf(id)
    // The grid keeps Excel's switches and each column's total under `meta.excel`; the writer reads them on the table itself (the kit's `tableModel`).
    if (sheet && Array.isArray(held?.tables) && held.tables.length) out.push({ kind: 'tables', sheet, tables: held.tables.map((table) => tableModel(table as never)) as never })
  }
  return out
}

/** The cells, styles and shape of the workbook as a new .xlsx; `names` is each sheet's tab name in it and `ids` the sheets' ids in the file's order. */
function writeCells(wb: IWorkbookData): { bytes: Uint8Array; names: Map<string, string>; ids: string[] } {
  const look = lookOf(wb)
  const pools: Pools = {
    font: look.font,
    fonts: [`<font><sz val="${look.font.size}"/><name val="${esc(look.font.family)}"/></font>`],
    fills: [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>'
    ],
    borders: ['<border><left/><right/><top/><bottom/><diagonal/></border>'],
    numFmts: new Map(),
    xfs: ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']
  }
  const files = new Map<string, Uint8Array>()
  const taken = new Set<string>()
  const ids = wb.sheetOrder.filter((id) => !!wb.sheets[id])
  const sheets = ids.map((id) => wb.sheets[id] as IWorksheetData)
  const names = new Map<string, string>()
  const entries = sheets.map((sh, i) => {
    files.set(`xl/worksheets/sheet${i + 1}.xml`, enc.encode(sheetXml(wb, sh, pools)))
    const name = excelName(sh.name ?? `Sheet${i + 1}`, taken)
    names.set(ids[i]!, name)
    return `<sheet name="${esc(name)}" sheetId="${i + 1}"${sh.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`
  })
  const numFmts = [...pools.numFmts].map(
    ([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`
  )
  files.set(
    'xl/styles.xml',
    enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS}">` +
        (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` : '') +
        `<fonts count="${pools.fonts.length}">${pools.fonts.join('')}</fonts><fills count="${pools.fills.length}">${pools.fills.join('')}</fills><borders count="${pools.borders.length}">${pools.borders.join('')}</borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${pools.xfs.length}">${pools.xfs.join('')}</cellXfs>` +
        `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
    )
  )
  files.set(
    'xl/workbook.xml',
    enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets>${entries.join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`
    )
  )
  files.set(
    'xl/_rels/workbook.xml.rels',
    enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="${R}/theme" Target="theme/theme1.xml"/></Relationships>`
    )
  )
  files.set(
    '_rels/.rels',
    enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    )
  )
  files.set(
    '[Content_Types].xml',
    enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}.worksheet+xml"/>`
          )
          .join('') +
        `</Types>`
    )
  )
  // [Content_Types].xml first, as Office writes it.
  const order = [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/theme/theme1.xml',
    'xl/styles.xml',
    ...sheets.map((_, i) => `xl/worksheets/sheet${i + 1}.xml`)
  ]
  files.set('xl/theme/theme1.xml', enc.encode(themeXml(look.theme)))
  const bytes = writeZip(
    readZip(EMPTY_ZIP),
    new Map(),
    new Set(),
    new Map(order.map((n) => [n, files.get(n)!]))
  )
  return { bytes, names, ids }
}

/** One sheet as CSV (RFC 4180, CRLF): what each cell shows as a value; a formula gives its last value. */
export function writeCsv(wb: IWorkbookData, sheetName?: string): string {
  const id =
    sheetName === undefined
      ? wb.sheetOrder[0]
      : wb.sheetOrder.find((s) => wb.sheets[s]?.name === sheetName)
  if (!id)
    throw new Error(
      sheetName === undefined
        ? 'The workbook has no sheets.'
        : `There is no sheet named ${sheetName}.`
    )
  const data = wb.sheets[id]?.cellData ?? {}
  const rows = sorted(data)
  const last = rows.length ? rows[rows.length - 1] : -1
  let width = 0
  for (const r of rows)
    for (const c of sorted(data[r] ?? {}))
      if (data[r]?.[c]?.v !== undefined && data[r]?.[c]?.v !== null) width = Math.max(width, c + 1)
  const field = (v: unknown): string => {
    if (v === undefined || v === null) return ''
    const s = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v)
    return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const out: string[] = []
  for (let r = 0; r <= last; r++) {
    const line: string[] = []
    for (let c = 0; c < width; c++) {
      const cell = data[r]?.[c]
      line.push(field(cell?.t === T_BOOLEAN && typeof cell.v === 'number' ? cell.v === 1 : cell?.v))
    }
    out.push(line.join(','))
  }
  return out.length ? `${out.join('\r\n')}\r\n` : ''
}

/** A CSV file read as a workbook of one sheet: numbers as numbers, the rest as text (RFC 4180 quoting). */
export function readCsv(text: string, id: string, name: string): IWorkbookData {
  const body = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  const cellData: Record<number, Record<number, ICellData>> = {}
  let columns = 0
  rows.forEach((cells, r) => {
    columns = Math.max(columns, cells.length)
    cells.forEach((v, c) => {
      if (v === '') return
      const n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim()) ? Number(v) : NaN
      ;(cellData[r] ??= {})[c] =
        Number.isFinite(n) && !/^0\d/.test(v.trim()) ? { v: n, t: 2 } : { v, t: T_STRING }
    })
  })
  return {
    id,
    name,
    appVersion: '1.5.2',
    locale: 'enUS' as IWorkbookData['locale'],
    styles: {},
    sheetOrder: ['sheet1'],
    sheets: {
      sheet1: {
        id: 'sheet1',
        name: name.replace(/\.csv$/i, '').slice(0, 31) || 'Sheet1',
        rowCount: Math.max(1000, rows.length + 100),
        columnCount: Math.max(26, columns + 5),
        cellData
      }
    }
  } as IWorkbookData
}
