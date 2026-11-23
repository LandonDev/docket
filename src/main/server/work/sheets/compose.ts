import { readFileSync } from 'node:fs'
import { readThemeXml, TEMPCODE_THEME, type OfficeTheme } from 'work-kit/format/theme'
import { headlessSheet } from 'work-kit/sheet/engine'
import { applyFormat, type SheetFormat } from 'work-kit/sheet/format'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { FORMAT_MAX_CELLS } from './asks'
import { workbookMap } from './patch/patch'
import { readText, readZip } from './patch/zip'

/**
 * A format an agent asks for, as the mutations the row's own press would make (sheet_format,
 * tools.ts). The sheet worker runs it: work-kit's `applyFormat`, the one the row calls, on a blank
 * workbook that has the real one's id and sheets and nothing else. A format reads no cell's
 * contents (a border knows its range's edges, a named style its parts), so what it emits there is
 * what it would emit on the real sheet, and neither store's workbook has to be loaded to make it.
 * The steps that do read the cells are left out of `AgentFormat`: one more decimal (the pattern is
 * given whole) and a merge (it can empty cells).
 */

/** What an agent may set on a range: `SheetFormat` less what reads the cells. */
export type AgentFormat = Omit<SheetFormat, 'decimals' | 'merge'>

export interface ComposeAsk {
  /** the workbook's id in its grid */
  unit: string
  sheets: { id: string; name: string }[]
  /** the sheet's id */
  sheet: string
  range: { startRow: number; endRow: number; startColumn: number; endColumn: number }
  format?: AgentFormat
  /** the range's columns, each this wide (px) */
  width?: number
  /** the range's rows, each this tall (px) */
  height?: number
  /** an opened package: its own theme tells a named style's colours */
  path?: string
}

function themeOf(path: string | undefined): OfficeTheme {
  if (!path) return TEMPCODE_THEME
  try {
    const zip = readZip(new Uint8Array(readFileSync(path)))
    const rel = workbookMap(zip).wbRels.rels.find((r) => !r.external && r.type.endsWith('/theme'))
    return readThemeXml(rel && zip.byName.has(rel.target) ? readText(zip, rel.target) : undefined)
  } catch {
    return TEMPCODE_THEME
  }
}

export function formatMutations(ask: ComposeAsk): SheetMutationJson[] {
  const { range } = ask
  const cells = (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1)
  if (!(cells > 0)) throw new Error('That is not a range.')
  if (cells > FORMAT_MAX_CELLS) throw new Error(`A format is laid on at most ${FORMAT_MAX_CELLS.toLocaleString('en')} cells: ask for a smaller range.`)
  if (!ask.sheets.some((s) => s.id === ask.sheet)) throw new Error('That sheet is not in the workbook.')
  const grid = headlessSheet('univer', {
    id: ask.unit,
    sheetOrder: ask.sheets.map((s) => s.id),
    sheets: Object.fromEntries(ask.sheets.map((s) => [s.id, { id: s.id, name: s.name, rowCount: Math.max(1000, range.endRow + 2), columnCount: Math.max(26, range.endColumn + 2), cellData: {} }]))
  })
  try {
    const out: SheetMutationJson[] = []
    grid.api.addEvent(grid.api.Event.CommandExecuted, (event) => {
      if (event.type === 2 && !event.options?.fromCollab && !event.options?.onlyLocal && event.id.startsWith('sheet.mutation.')) out.push({ id: event.id, params: event.params })
    })
    if (ask.format && Object.keys(ask.format).length && !applyFormat(grid.api, ask.format as SheetFormat, themeOf(ask.path), { sheet: ask.sheet, ranges: [{ ...range }] })) throw new Error('That format could not be laid on that range.')
    const sheet = grid.workbook.getSheetBySheetId(ask.sheet)
    if (ask.width !== undefined) sheet?.setColumnWidths(range.startColumn, range.endColumn - range.startColumn + 1, ask.width)
    if (ask.height !== undefined) sheet?.setRowHeights(range.startRow, range.endRow - range.startRow + 1, ask.height)
    if (out.length === 0) throw new Error('That format changes nothing.')
    return out
  } finally {
    grid.dispose()
  }
}
