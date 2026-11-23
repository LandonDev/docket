import { readRels, workbookMap } from './patch'
import type { IRange } from '@univerjs/core'
import { StyleTable } from './format-styles'
import { FormatSheet } from './format-sheet'
import { FormatRefused } from './format-xml'
import { readEntry, readZip, writeZip } from './zip'

export { FormatRefused } from './format-xml'

/** A colour as a spreadsheet <color> keeps it. */
export type XColor =
  | { rgb: string /* #RRGGBB, RRGGBB or AARRGGBB */ }
  | { theme: number; tint?: number }
  | { auto: true }

export type BorderStyle =
  | 'none'
  | 'thin'
  | 'medium'
  | 'thick'
  | 'hair'
  | 'dotted'
  | 'dashed'
  | 'double'
  | 'mediumDashed'
  | 'dashDot'
  | 'mediumDashDot'
  | 'dashDotDot'
  | 'mediumDashDotDot'
  | 'slantDashDot'

type Edge = { style: BorderStyle; color?: XColor }

/** Omitted fields preserve existing formatting. Null clears a field where the type allows it. */
export interface CellFormat {
  font?: {
    /** null: the workbook's default font's family (font 0), with its charset and theme scheme */
    name?: string | null
    /** null: the workbook's default font's size */
    size?: number | null
    bold?: boolean
    italic?: boolean
    underline?: boolean | 'double'
    strike?: boolean
    vertAlign?: 'baseline' | 'subscript' | 'superscript' | null
    color?: XColor | null
  }
  fill?: XColor | null
  border?: Partial<Record<'left' | 'right' | 'top' | 'bottom', Edge | null>> & {
    /** OOXML has one line style and colour shared by both directions. */
    diagonal?: (Partial<Edge> & { up?: boolean; down?: boolean }) | null
  }
  numFmt?: string
  align?: {
    horizontal?:
      | 'left'
      | 'center'
      | 'right'
      | 'justify'
      | 'general'
      | 'fill'
      | 'centerContinuous'
      | 'distributed'
      | null
    vertical?: 'top' | 'center' | 'bottom' | 'justify' | 'distributed' | null
    wrap?: boolean
    indent?: number
    shrink?: boolean
    /** Signed degrees (-90 to 90), or stacked text. Null clears rotation. */
    rotation?: number | 'vertical' | null
  }
  /** Excel built-in cell style id, such as 0 (Normal), 16 (Heading 1) or 26 (Good). */
  namedStyle?: number
  /**
   * With `namedStyle`: the cell is only named as wearing the style (its xf's `xfId`); the look is
   * the other fields of this format, not the style record's. The grid sends a named style so,
   * since what it drew is the look the file must hold.
   */
  namedOnly?: true
  /** Resets all formatting to cell xf 0 and takes precedence over other fields. */
  clear?: true
}

/** A1 or zero-based inclusive grid coordinates, including Univer's rangeType for whole axes. */
export type FormatRange =
  string | Pick<IRange, 'startRow' | 'endRow' | 'startColumn' | 'endColumn' | 'rangeType'>
type CellRanges =
  { range: FormatRange; ranges?: FormatRange[] } | { range?: FormatRange; ranges: FormatRange[] }

export type FormatEdit =
  | ({ kind: 'cells'; sheet: string; format: CellFormat } & CellRanges)
  // Size edits use zero-based inclusive endpoints and Excel character/point units.
  | { kind: 'colWidth'; sheet: string; from: number; to: number; width: number | null }
  | { kind: 'rowHeight'; sheet: string; from: number; to: number; height: number | null }
  | { kind: 'merge'; sheet: string; range: FormatRange }
  | { kind: 'unmerge'; sheet: string; range: FormatRange }

/** Smallest width at Excel's 1/256-character precision that reads back as the given rounded pixels. */
export function columnWidthFromPx(pixels: number): number {
  // Invert work-kit's columnWidthPx for a 7 px digit in the default font.
  return Math.max(0, Math.ceil((Math.round(pixels) * 256) / 7 - Math.trunc(128 / 7))) / 256
}

export interface FormatReport {
  partsChanged: string[]
  styles: {
    fonts: number
    fills: number
    borders: number
    numFmts: number
    xfs: number
    reused: number
  }
  warnings: string[]
}

/** Apply edits in order, then replace only the package parts whose XML changed. */
export function patchFormat(
  bytes: Uint8Array,
  edits: FormatEdit[]
): { bytes: Uint8Array; report: FormatReport } {
  const report: FormatReport = {
    partsChanged: [],
    styles: { fonts: 0, fills: 0, borders: 0, numFmts: 0, xfs: 0, reused: 0 },
    warnings: []
  }
  if (!edits.length) return { bytes, report }
  const zip = readZip(bytes)
  const { sheets, wbRels } = workbookMap(zip)
  const stylesPart = wbRels.rels.find(
    (rel) => !rel.external && rel.type.endsWith('/styles')
  )?.target
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  const read = (part: string) => decoder.decode(readEntry(zip, part))
  const sheetsByName = new Map(sheets.map((sheet) => [sheet.name, sheet]))
  const parts = new Map<string, { before: string; after: string }>()
  let styles: StyleTable | undefined
  const getStyles = () => {
    if (!stylesPart || !zip.byName.has(stylesPart))
      throw new FormatRefused('This workbook has no styles part to edit.')
    return (styles ??= new StyleTable(read(stylesPart), report.styles))
  }
  const editsByPart = new Map<string, FormatEdit[]>()
  for (const edit of edits) {
    const sheet = sheetsByName.get(edit.sheet)
    if (sheet?.kind !== 'worksheet') throw new FormatRefused(`No worksheet named “${edit.sheet}”.`)
    const group = editsByPart.get(sheet.part)
    if (group) group.push(edit)
    else editsByPart.set(sheet.part, [edit])
  }
  const styleCache = new Map<string, Map<number, number>>()
  const resolveStyle = (format: CellFormat) => {
    if (format.clear) return () => 0
    const key = JSON.stringify(format, (_, value: unknown) =>
      typeof value === 'number' && !Number.isFinite(value) ? String(value) : value
    )
    let cache = styleCache.get(key)
    if (!cache) styleCache.set(key, (cache = new Map()))
    const stylesByIndex = cache
    return (old: number) => {
      const hit = stylesByIndex.get(old)
      if (hit !== undefined) return hit
      const index = getStyles().style(old, format)
      stylesByIndex.set(old, index)
      return index
    }
  }
  for (const [part, group] of editsByPart) {
    const before = read(part)
    const after = new FormatSheet(before, () => {
      const tables = readRels(zip, part).rels.filter(
        (rel) => !rel.external && rel.type.endsWith('/table') && zip.byName.has(rel.target)
      )
      return new Map(tables.map((rel) => [rel.id, () => read(rel.target)]))
    }).apply(group, resolveStyle)
    parts.set(part, { before, after })
  }
  if (styles && stylesPart) parts.set(stylesPart, { before: styles.xml, after: styles.render() })
  const encoder = new TextEncoder()
  const replace = new Map<string, Uint8Array>()
  for (const [name, { before, after }] of parts) {
    if (before === after) continue
    replace.set(name, encoder.encode(after))
    report.partsChanged.push(name)
  }
  return { bytes: replace.size ? writeZip(zip, replace, new Set(), new Map()) : bytes, report }
}
