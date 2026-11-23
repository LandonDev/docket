import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { runsOf } from 'work-kit/sheet/xlsx'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { readText } from '../patch/text'
import { writeXlsxWhole } from '../writer'
import { TcsheetBackend } from './backends'
import { SheetHost } from './host'
import { GUEST_OPS, refusal } from './live'
import { NOTES_RESOURCE } from './rules'
import type { SheetRef } from './wire'

/**
 * Notes and rich text on a sheet the service holds (a `.tcsheet` over a real file): the engine
 * takes the grid's own mutations (the shapes work-kit's `handle.comments` and the cell editor
 * make), a cold host shows them, a restore brings a note back, and the Excel export holds the runs
 * and says what it leaves out. A guest's route lets no note through.
 */

const scratch = mkdtempSync(join(tmpdir(), 'sheet-notes-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const hosts: SheetHost[] = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.close()
})
const U = 'workbook'
const S = 'sheet1'
let n = 0
function store(): { ref: SheetRef; host: () => SheetHost } {
  const path = join(scratch, `${++n}.tcsheet`)
  TcsheetBackend.create(path, 'Budget')
  return {
    ref: { tcsheet: path },
    host: () => {
      const h = new SheetHost(() => new TcsheetBackend(path))
      hosts.push(h)
      return h
    }
  }
}

const note = (text: string) => ({ id: 'n1', row: 1, col: 0, width: 160, height: 72, note: text, show: false, author: 'Lab' })
const update = (text: string): SheetMutationJson => ({ id: 'sheet.mutation.update-note', params: { unitId: U, sheetId: S, row: 1, col: 0, note: note(text) } })
const remove: SheetMutationJson = { id: 'sheet.mutation.remove-note', params: { unitId: U, sheetId: S, noteId: 'n1', row: 1, col: 0 } }

async function notesOf(host: SheetHost, ref: SheetRef): Promise<Record<string, Record<string, { note: string; author?: string }>>> {
  const wb = JSON.parse((await host.snapshotJson(ref)).json) as IWorkbookData
  return (JSON.parse(wb.resources?.find((r) => r.name === NOTES_RESOURCE)?.data || '{}') ?? {})[S] ?? {}
}

describe('notes on a sheet the service holds', () => {
  it('are made, reworded and removed by the grid\'s mutations, kept through a cold load, and brought back by a restore', async () => {
    const s = store()
    const host = s.host()
    let rev = (await host.open(s.ref)).rev
    for (const m of [update('First words'), update('Second words')]) rev = ((await host.apply(s.ref, rev, [m], 'owner')) as { rev: number }).rev
    expect((await notesOf(s.host(), s.ref))[1]?.[0]).toMatchObject({ note: 'Second words', author: 'Lab' })
    const worded = rev
    rev = ((await host.apply(s.ref, rev, [remove], 'owner')) as { rev: number }).rev
    expect((await notesOf(s.host(), s.ref))[1]?.[0]).toBeUndefined()
    // History names a note's change in words.
    expect((await s.host().history(s.ref)).revisions.slice(0, 2).map((r) => r.label)).toEqual(['Removed a note', 'A note'])
    // Restored to when it said "Second words": back, by its own id and author, and a cold host agrees.
    await host.restore(s.ref, worded, 'owner')
    expect((await notesOf(s.host(), s.ref))[1]?.[0]).toMatchObject({ note: 'Second words', author: 'Lab' })
    // Restored to the first words, then to before it was made.
    await host.restore(s.ref, worded - 1, 'owner')
    expect((await notesOf(s.host(), s.ref))[1]?.[0]).toMatchObject({ note: 'First words' })
    await host.restore(s.ref, worded - 2, 'owner')
    expect((await notesOf(s.host(), s.ref))[1]?.[0]).toBeUndefined()
  })

  it('a note moved with its cell follows it', async () => {
    const s = store()
    const host = s.host()
    let rev = (await host.open(s.ref)).rev
    rev = ((await host.apply(s.ref, rev, [update('Moves')], 'owner')) as { rev: number }).rev
    await host.apply(s.ref, rev, [{ id: 'sheet.mutation.update-note-position', params: { unitId: U, sheetId: S, noteId: 'n1', newPosition: { row: 4, col: 2 } } }], 'owner')
    const notes = await notesOf(s.host(), s.ref)
    expect(notes[1]?.[0]).toBeUndefined()
    expect(notes[4]?.[2]).toMatchObject({ note: 'Moves' })
  })

  it("a guest's route lets none through, and an editor's must name its sheet, row and column", () => {
    for (const id of ['sheet.mutation.update-note', 'sheet.mutation.remove-note', 'sheet.mutation.update-note-position']) expect(GUEST_OPS.has(id)).toBe(false)
    expect(refusal([update('x')], 'edit', true)).toBe('a guest cannot change a note')
    expect(refusal([remove], 'edit', true)).toBe('a guest cannot change a note')
    expect(refusal([update('x'), remove], 'edit', false)).toBeNull()
    expect(refusal([{ id: 'sheet.mutation.update-note-position', params: { unitId: U, sheetId: S, noteId: 'n1', newPosition: { row: 4, col: 2 } } }], 'edit', false)).toBeNull()
    expect(refusal([{ id: 'sheet.mutation.update-note', params: { unitId: U, row: 1, col: 0 } }], 'edit', false)).toBe('a note names its sheet, row and column')
  })
})

describe('rich text on a sheet the service holds', () => {
  const rich = {
    id: 'd',
    body: { dataStream: 'Net total\r\n', textRuns: [{ st: 0, ed: 4, ts: { ff: 'Arial', fs: 10 } }, { st: 4, ed: 9, ts: { ff: 'Arial', fs: 10, bl: 1 } }], paragraphs: [{ startIndex: 9 }], sectionBreaks: [{ startIndex: 10 }], customRanges: [] },
    documentStyle: {}
  }

  it('is kept through a cold load, and the Excel export holds its runs and says it leaves the notes out', async () => {
    const s = store()
    const host = s.host()
    const rev = (await host.open(s.ref)).rev
    await host.apply(s.ref, rev, [{ id: 'sheet.mutation.set-range-values', params: { unitId: U, subUnitId: S, cellValue: { 0: { 1: { v: null, f: null, p: rich } } } } }, update('Beside it')], 'owner')
    const wb = JSON.parse((await s.host().snapshotJson(s.ref)).json) as IWorkbookData
    const cell = wb.sheets[S]!.cellData![0]![1]!
    expect(runsOf(cell, () => null)?.map((r) => [r.text, !!r.font?.bold])).toEqual([
      ['Net ', false],
      ['total', true]
    ])
    // An agent's read: the cell's words from its document, and the note's words beside them.
    const read = await s.host().range(s.ref, 'A1:B2')
    expect(read.cells[0]![1]).toEqual({ at: 'B1', v: 'Net total' })
    expect(read.cells[1]![0]).toEqual({ at: 'A2', note: 'Beside it' })
    const made = writeXlsxWhole(wb)
    const runs = readText(made.bytes).find((c) => c.row === 0 && c.column === 1)?.runs
    expect(runs?.map((r) => r.text).join('')).toBe('Net total')
    expect(runs?.find((r) => r.text === 'total')?.font?.bold).toBe(true)
    expect(runs?.find((r) => r.text === 'Net ')?.font?.bold ?? false).toBe(false)
    expect(made.left).toEqual([{ what: 'notes', sheet: 'Sheet1', why: 'Notes are not written into an Excel file made here yet.' }])
  })
})
