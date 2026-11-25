import { IUniverInstanceService } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { headlessSheet } from 'work-kit/sheet/engine'
import { blankWorkbook } from './host/backends'

/**
 * Undo on a live sheet takes back one's own change only (docs/agents/work-sheets.md "Live editing"). Every grid lays
 * what others wrote as the sheet's own (`fromCollab`, the session's `lay`, the handle's `apply`), which Univer's undo
 * stack never holds; an undo is the grid's own command, so it goes out as one more edit through the session.
 */
describe('undo on a live sheet', () => {
  it("takes back this grid's own edit and never one laid from elsewhere; the undo goes out as a new edit", async () => {
    const grid = headlessSheet('work', blankWorkbook('book', 'Plan'))
    const sheet = grid.workbook.getActiveSheet()
    const unitId = grid.workbook.getId()
    const subUnitId = sheet.getSheetId()
    // Undo acts on the unit in focus, as the grid on a page has it.
    grid.univer.__getInjector().get(IUniverInstanceService).focusUnit(unitId)
    const out: { id: string; params: unknown }[] = []
    grid.api.addEvent(grid.api.Event.CommandExecuted, (event) => {
      if (event.type === 2 && !event.options?.fromCollab && !event.options?.onlyLocal && event.id.startsWith('sheet.mutation.')) out.push({ id: event.id, params: event.params })
    })
    // His own edit, made through the grid's command as a press makes it.
    await grid.api.executeCommand('sheet.command.set-range-values', { unitId, subUnitId, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }, value: { v: 'mine' } })
    expect(out).toHaveLength(1)
    // Someone else's op, laid as the session lays it.
    grid.api.syncExecuteCommand('sheet.mutation.set-range-values', { unitId, subUnitId, cellValue: { 0: { 1: { v: 'theirs', t: 1 } }, 1: { 0: { v: 'below', t: 1 } } } }, { fromCollab: true })
    expect(out).toHaveLength(1)
    const value = (row: number, col: number) => sheet.getSheet().getCellRaw(row, col)?.v ?? null
    expect([value(0, 0), value(0, 1), value(1, 0)]).toEqual(['mine', 'theirs', 'below'])

    await grid.api.executeCommand('univer.command.undo')
    // His own cell is taken back; theirs stand.
    expect([value(0, 0), value(0, 1), value(1, 0)]).toEqual([null, 'theirs', 'below'])
    // The undo went out as a new edit of his, on his own cell alone.
    expect(out).toHaveLength(2)
    expect(out[1]!.id).toBe('sheet.mutation.set-range-values')
    expect(Object.keys((out[1]!.params as { cellValue: Record<string, Record<string, unknown>> }).cellValue)).toEqual(['0'])
    expect(Object.keys((out[1]!.params as { cellValue: Record<string, Record<string, unknown>> }).cellValue[0]!)).toEqual(['0'])
    // A second undo has nothing of his left to take back, and leaves theirs alone.
    await grid.api.executeCommand('univer.command.undo')
    expect([value(0, 1), value(1, 0)]).toEqual(['theirs', 'below'])
    expect(out).toHaveLength(2)
    grid.dispose()
  })
})
