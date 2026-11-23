import type { OfficeTheme } from 'work-kit/format/theme'
import { CELL_STYLES, namedStyle } from 'work-kit/sheet/format'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { columnWidthFromPx, type BorderStyle, type CellFormat, type FormatEdit, type XColor } from './patch/format'

/**
 * Univer's formatting mutations as the patch writer's format edits (patch/format.ts), for an
 * opened package: a cell's style, a column's width, a row's height he set, a merge made or
 * parted. The sheet worker runs it as it saves (jobs.ts): it reads work-kit's named styles, which
 * load Univer's core, and main loads none of that.
 *
 * The grid sends a style as the keys that changed, a key set to null where it was cleared and
 * `s: null` for no formatting at all (work-kit `sheet/grid/format.ts`). Each maps to the one
 * field of `CellFormat` that says the same thing to the file, so a press changes that and
 * nothing else of the cell's xf.
 */

export const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'
export const COL_WIDTH = 'sheet.mutation.set-worksheet-col-width'
export const ROW_HEIGHT = 'sheet.mutation.set-worksheet-row-height'
export const ADD_MERGE = 'sheet.mutation.add-worksheet-merge'
export const REMOVE_MERGE = 'sheet.mutation.remove-worksheet-merge'
/** A row told to fit what it holds, or to stop fitting (a double-click on its border). */
export const AUTO_HEIGHT = 'sheet.mutation.set-worksheet-row-is-auto-height'
/** The mutations a package saves as formatting. */
export const FORMAT_IDS = new Set([COL_WIDTH, ROW_HEIGHT, ADD_MERGE, REMOVE_MERGE, AUTO_HEIGHT])

type Style = Record<string, unknown>
interface Range {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
  rangeType?: number
}

/** The order a spreadsheet counts a theme's slots (work-kit `sheet/colour.ts`); the tag's low four bits are the index. */
const SLOTS = 12
/** A Univer colour as the file keeps it: the theme slot and tint its tag names, else its hex. */
export function colourOf(colour: unknown): XColor | null {
  if (!colour || typeof colour !== 'object') return null
  const { rgb, th } = colour as { rgb?: unknown; th?: unknown }
  if (typeof th === 'number' && th >= 16 && (th & 15) < SLOTS) {
    const tint = ((th >> 4) - 1) / 10000 - 1
    return tint ? { theme: th & 15, tint } : { theme: th & 15 }
  }
  if (typeof rgb !== 'string') return null
  const hex = /^#?([0-9a-f]{6})$/i.exec(rgb.trim())
  if (hex) return { rgb: hex[1].toUpperCase() }
  // Univer also takes `rgb(r, g, b)`; a colour it cannot name is no colour to write.
  const parts = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(rgb.trim())
  return parts ? { rgb: parts.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase() } : null
}

/** Univer's border lines by their numbers, as the file names them. */
const LINE: Record<number, BorderStyle> = {
  0: 'none',
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
const EDGES = { t: 'top', b: 'bottom', l: 'left', r: 'right' } as const
const H = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify', 5: 'justify', 6: 'distributed' } as const
const V = { 1: 'top', 2: 'center', 3: 'bottom' } as const

const on = (v: unknown): boolean => v === 1 || v === true
const decoration = (v: unknown): boolean => !!v && typeof v === 'object' && on((v as { s?: unknown }).s)

function edgeOf(edge: unknown): { style: BorderStyle; color?: XColor } | null {
  if (!edge || typeof edge !== 'object') return null
  const { s, cl } = edge as { s?: unknown; cl?: unknown }
  const style = typeof s === 'number' ? LINE[s] : undefined
  if (!style || style === 'none') return null
  const color = colourOf(cl)
  return color ? { style, color } : { style }
}

/** A value with its keys in one order and nothing empty in it, as text: two style changes that say the same compare equal. */
function canon(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${key}:${canon((value as Style)[key])}`)
    .join(',')}}`
}

/** The named styles as the style changes the row lays for them under a theme, by that change's text. */
const namedByTheme = new WeakMap<OfficeTheme, Map<string, number>>()
function namedOf(style: Style, theme: OfficeTheme): number | undefined {
  let table = namedByTheme.get(theme)
  if (!table) {
    table = new Map(CELL_STYLES.map((named) => [canon(namedStyle(named, theme)), named.builtinId]))
    namedByTheme.set(theme, table)
  }
  return table.get(canon(style))
}

/**
 * A style change as the patch writer's format: the keys present, each as its field. `null` (the
 * grid's "no formatting") is a clear. A change that is exactly one the row lays for a named style
 * also names it (`namedStyle`, Excel's `builtinId`), so Excel shows the cell as wearing that
 * style; Normal is a clear. Answers null for a change with nothing a file keeps.
 */
export function formatOf(style: Style | null, theme?: OfficeTheme): CellFormat | null {
  if (style === null) return { clear: true }
  const named = theme ? namedOf(style, theme) : undefined
  if (named === 0) return { clear: true }
  const out: CellFormat = named === undefined ? {} : { namedStyle: named, namedOnly: true }
  const font: NonNullable<CellFormat['font']> = {}
  // A family or a size cleared goes back to the workbook's own default font.
  if ('ff' in style) font.name = typeof style.ff === 'string' && style.ff ? style.ff : null
  if ('fs' in style) font.size = typeof style.fs === 'number' && style.fs > 0 ? style.fs : null
  if ('bl' in style) font.bold = on(style.bl)
  if ('it' in style) font.italic = on(style.it)
  if ('ul' in style) font.underline = decoration(style.ul)
  if ('st' in style) font.strike = decoration(style.st)
  if ('va' in style) font.vertAlign = style.va === 2 ? 'subscript' : style.va === 3 ? 'superscript' : null
  if ('cl' in style) font.color = colourOf(style.cl)
  if (Object.keys(font).length) out.font = font
  if ('bg' in style) out.fill = colourOf(style.bg)
  if ('bd' in style) {
    const bd = style.bd
    if (!bd || typeof bd !== 'object') out.border = { top: null, bottom: null, left: null, right: null, diagonal: null }
    else {
      const border: NonNullable<CellFormat['border']> = {}
      for (const [key, name] of Object.entries(EDGES)) if (key in bd) border[name] = edgeOf((bd as Style)[key])
      const up = (bd as Style).bl_tr
      const down = (bd as Style).tl_br
      if ('bl_tr' in bd || 'tl_br' in bd) {
        const line = edgeOf(up) ?? edgeOf(down)
        border.diagonal = line ? { ...line, up: !!edgeOf(up), down: !!edgeOf(down) } : null
      }
      if (Object.keys(border).length) out.border = border
    }
  }
  const align: NonNullable<CellFormat['align']> = {}
  if ('ht' in style) align.horizontal = H[style.ht as keyof typeof H] ?? null
  if ('vt' in style) align.vertical = V[style.vt as keyof typeof V] ?? null
  if ('tb' in style) align.wrap = style.tb === 3
  if ('tr' in style) {
    const tr = style.tr as { a?: unknown; v?: unknown } | null
    align.rotation = !tr ? null : on(tr.v) ? 'vertical' : typeof tr.a === 'number' && tr.a ? Math.max(-90, Math.min(90, tr.a > 90 ? tr.a - 360 : tr.a)) : null
  }
  if (Object.keys(align).length) out.align = align
  if ('n' in style) {
    const pattern = (style.n as { pattern?: unknown } | null)?.pattern
    out.numFmt = typeof pattern === 'string' && pattern ? pattern : 'General'
  }
  return Object.keys(out).length ? out : null
}

/** Cells as the fewest rectangles that cover exactly them: runs along each row, joined down while they line up. */
export function rectsOf(cells: readonly (readonly [number, number])[]): Range[] {
  const byRow = new Map<number, number[]>()
  for (const [row, column] of cells) {
    const list = byRow.get(row)
    if (list) list.push(column)
    else byRow.set(row, [column])
  }
  const out: Range[] = []
  /** the rectangles the row above ended with, by `from:to` */
  let open = new Map<string, Range>()
  let last = -2
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const columns = byRow.get(row)!.sort((a, b) => a - b)
    const next = new Map<string, Range>()
    for (let i = 0; i < columns.length; ) {
      let j = i
      while (j + 1 < columns.length && columns[j + 1] <= columns[j] + 1) j++
      const key = `${columns[i]}:${columns[j]}`
      const above = row === last + 1 ? open.get(key) : undefined
      if (above) {
        above.endRow = row
        next.set(key, above)
      } else {
        const made: Range = { startRow: row, endRow: row, startColumn: columns[i], endColumn: columns[j] }
        out.push(made)
        next.set(key, made)
      }
      i = j + 1
    }
    open = next
    last = row
  }
  return out
}

/** One set-range-values mutation's style changes, cells with the same change gathered into rectangles. */
/** A style the grid named by its id reached the host: it cannot be told what that id meant. */
export class FormatUnknown extends Error {
  constructor() {
    super('That formatting could not be read: copy the cells again.')
  }
}

function styleEdits(sheet: string, cellValue: Record<string, Record<string, { s?: unknown } | null> | null> | undefined, theme: OfficeTheme | undefined): FormatEdit[] {
  const groups = new Map<string, { format: CellFormat; cells: [number, number][] }>()
  const put = (format: CellFormat, row: number, column: number): void => {
    const key = JSON.stringify(format)
    const group = groups.get(key)
    if (group) group.cells.push([row, column])
    else groups.set(key, { format, cells: [[row, column]] })
  }
  for (const [r, columns] of Object.entries(cellValue ?? {})) {
    for (const [c, cell] of Object.entries(columns ?? {})) {
      if (!cell || !('s' in cell)) continue
      // A style named by an id is the grid's own name for it, which this file's ids do not match: the canvas sends the style itself.
      if (typeof cell.s === 'string') throw new FormatUnknown()
      const format = formatOf(cell.s as Style | null, theme)
      if (format) put(format, Number(r), Number(c))
    }
  }
  const out: FormatEdit[] = []
  for (const { format, cells } of groups.values()) out.push({ kind: 'cells', sheet, ranges: rectsOf(cells), format })
  return out
}

const PT_PER_PX = 0.75

/**
 * A size mutation's sizes over `from..to`, as runs of the same size. Univer gives one number for the whole range, or
 * an object keyed by the row's or column's own index (an undo, a drag of several columns of different widths); an
 * index named with no size goes back to the sheet's default (`null`), and one not named is left as it is.
 */
function runsOf(sizes: unknown, from: number, to: number): { from: number; to: number; size: number | null }[] {
  if (typeof sizes === 'number') return sizes >= 0 ? [{ from, to, size: sizes }] : []
  if (!sizes || typeof sizes !== 'object') return []
  const out: { from: number; to: number; size: number | null }[] = []
  for (let i = from; i <= to; i++) {
    // An index the mutation does not name keeps what it has, as in the grid; one named with no size goes back to the default.
    if (!(i in (sizes as object))) continue
    const raw = (sizes as Record<number, unknown>)[i]
    const size = typeof raw === 'number' && raw >= 0 ? raw : null
    const last = out.at(-1)
    if (last && last.size === size && last.to === i - 1) last.to = i
    else out.push({ from: i, to: i, size })
  }
  return out
}

/**
 * The format edits a list of mutations makes, in order. `sheetName` turns Univer's sheet id into
 * the tab's name; `theme` is the file's own (a named style is told by it). A mutation that is not
 * formatting makes none: the caller has its own word for those (mutations.ts).
 */
export function formatEditsOf(mutations: readonly SheetMutationJson[], sheetName: (id: string) => string | undefined, theme?: OfficeTheme): FormatEdit[] {
  const out: FormatEdit[] = []
  for (const m of mutations) {
    const p = m.params as { subUnitId?: string; cellValue?: Record<string, Record<string, { s?: unknown } | null> | null>; ranges?: Range[]; colWidth?: unknown; rowHeight?: unknown }
    const sheet = typeof p.subUnitId === 'string' ? sheetName(p.subUnitId) : undefined
    if (!sheet) continue
    if (m.id === SET_RANGE_VALUES) out.push(...styleEdits(sheet, p.cellValue, theme))
    else if (m.id === COL_WIDTH) {
      for (const range of p.ranges ?? []) for (const run of runsOf(p.colWidth, range.startColumn, range.endColumn)) out.push({ kind: 'colWidth', sheet, from: run.from, to: run.to, width: run.size === null ? null : columnWidthFromPx(run.size) })
    } else if (m.id === ROW_HEIGHT) {
      for (const range of p.ranges ?? []) for (const run of runsOf(p.rowHeight, range.startRow, range.endRow)) out.push({ kind: 'rowHeight', sheet, from: run.from, to: run.to, height: run.size === null ? null : Math.round(run.size * PT_PER_PX * 100) / 100 })
    } else if (m.id === AUTO_HEIGHT) {
      // A row set to fit what it holds has no height of its own in the file: Excel fits it on open.
      const auto = (p as { autoHeightInfo?: unknown }).autoHeightInfo
      if (auto === 1 || auto === true) for (const range of p.ranges ?? []) out.push({ kind: 'rowHeight', sheet, from: range.startRow, to: range.endRow, height: null })
    } else if (m.id === ADD_MERGE) for (const range of p.ranges ?? []) out.push({ kind: 'merge', sheet, range })
    else if (m.id === REMOVE_MERGE) for (const range of p.ranges ?? []) out.push({ kind: 'unmerge', sheet, range })
  }
  return out
}

/** Whether a cell of a set-range-values mutation carries a style change. */
export const hasStyle = (cell: unknown): boolean => !!cell && typeof cell === 'object' && 's' in cell
