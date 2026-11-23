import type { IWorkbookData } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { TEMPCODE_THEME } from 'work-kit/format/theme'
import { headlessSheet } from 'work-kit/sheet/engine'
import { readFormat } from 'work-kit/sheet/format'
import { FORMAT_MAX_CELLS } from './asks'
import { formatMutations, type ComposeAsk } from './compose'

/**
 * A format an agent asks for is made on a blank workbook and laid on the real one: what it
 * emits there must be what the real sheet takes, on the sheet it named, with its values kept.
 */
const SHEETS = [
  { id: 'first', name: 'Budget' },
  { id: 'second', name: 'Q1 Notes' }
]
const ask = (over: Partial<ComposeAsk>): ComposeAsk => ({ unit: 'book', sheets: SHEETS, sheet: 'second', range: { startRow: 1, endRow: 2, startColumn: 1, endColumn: 2 }, ...over })

/** The real workbook: values in B2:C3 of the second sheet. */
function real(): ReturnType<typeof headlessSheet> {
  return headlessSheet('univer', {
    id: 'book',
    sheetOrder: ['first', 'second'],
    sheets: {
      first: { id: 'first', name: 'Budget', cellData: { 1: { 1: { v: 'kept' } } } },
      second: { id: 'second', name: 'Q1 Notes', cellData: { 1: { 1: { v: 'Rent' }, 2: { v: 1200 } }, 2: { 1: { v: 'Food' }, 2: { v: 300 } } } }
    }
  } as Partial<IWorkbookData>)
}
function laid(mutations: ReturnType<typeof formatMutations>): IWorkbookData {
  const grid = real()
  try {
    for (const m of mutations) grid.api.syncExecuteCommand(m.id, m.params as object, { fromCollab: true })
    return grid.workbook.save()
  } finally {
    grid.dispose()
  }
}
const styleOf = (wb: IWorkbookData, sheet: string, row: number, col: number) => {
  const s = wb.sheets[sheet]!.cellData?.[row]?.[col]?.s
  return (typeof s === 'string' ? wb.styles?.[s] : s) ?? {}
}
const look = (wb: IWorkbookData, sheet: string, row: number, col: number) => readFormat(styleOf(wb, sheet, row, col), TEMPCODE_THEME)

describe('a format an agent asks for', () => {
  it('lands on the sheet and range it named and keeps every value', () => {
    const wb = laid(formatMutations(ask({ format: { bold: true, fill: { hex: '#FFF2CC' }, pattern: '#,##0.00', align: 'right' } })))
    for (const [r, c] of [[1, 1], [1, 2], [2, 1], [2, 2]] as const) expect(look(wb, 'second', r, c)).toMatchObject({ bold: true, fill: { hex: '#FFF2CC' }, pattern: '#,##0.00', align: 'right' })
    expect(wb.sheets.second!.cellData?.[1]?.[1]?.v).toBe('Rent')
    expect(wb.sheets.second!.cellData?.[2]?.[2]?.v).toBe(300)
    // nothing outside the range, nothing on the other sheet
    expect(look(wb, 'second', 3, 1).bold).toBe(false)
    expect(look(wb, 'first', 1, 1).bold).toBe(false)
    expect(wb.sheets.first!.cellData?.[1]?.[1]?.v).toBe('kept')
  })

  it('draws a border on the edges of the range alone', () => {
    const wb = laid(formatMutations(ask({ format: { borders: 'outside' } })))
    const bd = (r: number, c: number) => Object.entries((styleOf(wb, 'second', r, c) as { bd?: Record<string, { s?: number } | null> }).bd ?? {}).filter(([, edge]) => edge?.s).map(([k]) => k).sort().join('')
    expect(bd(1, 1)).toBe('lt')
    expect(bd(1, 2)).toBe('rt')
    expect(bd(2, 1)).toBe('bl')
    expect(bd(2, 2)).toBe('br')
  })

  it('lays a named style, and clears back to plain', () => {
    const named = laid(formatMutations(ask({ format: { style: 'heading1' } })))
    expect(look(named, 'second', 1, 1).style).toBe('heading1')
    const grid = real()
    try {
      for (const m of formatMutations(ask({ format: { bold: true, italic: true } }))) grid.api.syncExecuteCommand(m.id, m.params as object, { fromCollab: true })
      for (const m of formatMutations(ask({ format: { clear: true } }))) grid.api.syncExecuteCommand(m.id, m.params as object, { fromCollab: true })
      const wb = grid.workbook.save()
      expect(look(wb, 'second', 1, 1)).toMatchObject({ bold: false, italic: false })
      expect(wb.sheets.second!.cellData?.[1]?.[1]?.v).toBe('Rent')
    } finally {
      grid.dispose()
    }
  })

  it('sets the widths of its columns and the heights of its rows', () => {
    const wb = laid(formatMutations(ask({ width: 160, height: 40 })))
    expect(wb.sheets.second!.columnData?.[1]?.w).toBe(160)
    expect(wb.sheets.second!.columnData?.[2]?.w).toBe(160)
    expect(wb.sheets.second!.rowData?.[1]?.h).toBe(40)
    expect(wb.sheets.first!.columnData?.[1]?.w).toBeUndefined()
  })

  it('refuses what it cannot lay, in words', () => {
    expect(() => formatMutations(ask({ sheet: 'gone', format: { bold: true } }))).toThrow('That sheet is not in the workbook.')
    expect(() => formatMutations(ask({ format: {} }))).toThrow('That format changes nothing.')
    const side = Math.ceil(Math.sqrt(FORMAT_MAX_CELLS)) + 1
    expect(() => formatMutations(ask({ range: { startRow: 0, endRow: side, startColumn: 0, endColumn: side }, format: { bold: true } }))).toThrow(/at most 20,000 cells/)
  })
})
