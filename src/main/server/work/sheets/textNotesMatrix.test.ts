import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { headlessSheet } from 'work-kit/sheet/engine'
import { importXlsx, runsOf } from 'work-kit/sheet/xlsx'
import { SHEET_NOTES, SHEET_ROW, type SheetMutationJson } from '@shared/contract-work-sheets'
import { forPackage, NOTE_STOP, sheetStopWords } from '@shared/work/sheets'
import { ensurePackageTables, PackageStore } from './packages'
import { readNotes } from './patch/notes'
import { readText } from './patch/text'
import { localJobs } from './workerClient'

/**
 * Text in more than one style and a note's words, saved into an opened Excel file end to end, as
 * rulesMatrix.test.ts does it for rules: the grid's own engine applies what the grid emits; the
 * canvas maps it for the file (`forPackage`, with the grid's document reader and the view's
 * `SHEET_NOTES`); the package store saves it into a real .xlsx (the patch, text and notes writers);
 * the file's parts hold it (`readText`, `readNotes`), and so does a cold import, which is what a
 * grid opening the file again shows.
 */
const CORPUS = join(import.meta.dirname, 'harness/corpus')
const scratch = mkdtempSync(join(tmpdir(), 'sheets-text-notes-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A rich document as the cell editor commits one: `ts` whole on every run, the stream ending in `\r\n`. */
function doc(parts: { text: string; bold?: boolean; italic?: boolean }[]) {
  let at = 0
  const textRuns = parts.map((p) => {
    const run = { st: at, ed: at + p.text.length, ts: { ff: 'Calibri', fs: 11, ...(p.bold ? { bl: 1 } : {}), ...(p.italic ? { it: 1 } : {}) } }
    at += p.text.length
    return run
  })
  return { id: 'd', body: { dataStream: `${parts.map((p) => p.text).join('')}\r\n`, textRuns, paragraphs: [{ startIndex: at }], sectionBreaks: [{ startIndex: at + 1 }], customRanges: [] }, documentStyle: {} }
}

let n = 0
async function opened() {
  const path = join(scratch, `${++n}.xlsx`)
  copyFileSync(join(CORPUS, 'threaded_comments.xlsx'), path)
  const db = new DatabaseSync(':memory:')
  ensurePackageTables(db)
  const store = new PackageStore(db, await localJobs(), join(scratch, `files-${n}`), () => null)
  await store.open(path)
  const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
  const grid = headlessSheet('univer', workbook, { notes: true })
  const unitId = grid.workbook.getId()
  const sheet = workbook.sheetOrder[0]!
  /** Applies what the grid emits, maps it as the canvas does, and answers what the canvas sends (or why it stops). */
  const press = (m: SheetMutationJson): { keep: SheetMutationJson[] } | { stop: string } => {
    grid.api.syncExecuteCommand(m.id, { ...(m.params as object), unitId })
    return forPackage(m, () => null, {
      formats: SHEET_ROW.package.length > 0,
      style: (id) => (grid.workbook.getWorkbook().getStyles().get(id) as Record<string, unknown> | undefined) ?? null,
      doc: (at, row, col) => grid.workbook.getSheetBySheetId(at)?.getRange(row, col).getCellData()?.p ?? null,
      notes: SHEET_NOTES.package
    })
  }
  const save = async (mutations: SheetMutationJson[]): Promise<number> => {
    const got = await store.edit(path, (await store.open(path)).rev, mutations, 'owner')
    if ('conflict' in got) throw new Error('conflict')
    return got.rev
  }
  const bytes = () => new Uint8Array(readFileSync(path))
  const cold = () => importXlsx(bytes()).workbook
  return { path, store, grid, unitId, sheet, press, save, bytes, cold }
}

const cellValues = (unitId: string, subUnitId: string, row: number, col: number, cell: unknown): SheetMutationJson => ({
  id: 'sheet.mutation.set-range-values',
  params: { unitId, subUnitId, cellValue: { [row]: { [col]: cell } } }
})

describe('text in more than one style, in an opened Excel file', () => {
  it('a cell typed as rich text is saved as its runs, its words where formulas read them, and opens again the same', async () => {
    const t = await opened()
    // A2 "row1" typed again as "Net total" with "total" bold, as the editor commits it: no `v`.
    const got = t.press(cellValues(t.unitId, t.sheet, 1, 0, { v: null, f: null, si: null, p: doc([{ text: 'Net ' }, { text: 'total', bold: true }]) }))
    if ('stop' in got) throw new Error(got.stop)
    await t.save(got.keep)
    const runs = readText(t.bytes(), 'Review').find((c) => c.row === 1 && c.column === 0)
    expect(runs?.runs.map((r) => [r.text, !!r.font?.bold])).toEqual([
      ['Net ', false],
      ['total', true]
    ])
    // A cold import: the words in `v` (what a formula reads) and the runs in `p`.
    const cell = t.cold().sheets[t.sheet]!.cellData![1]![0]!
    expect(cell.v).toBe('Net total')
    expect(runsOf(cell, () => null)?.map((r) => [r.text, !!r.font?.bold])).toEqual([
      ['Net ', false],
      ['total', true]
    ])
    // Every other cell kept its words.
    expect(t.cold().sheets[t.sheet]!.cellData![2]![0]!.v).toBe('row2')
  })

  it('a style set over a rich cell sends its runs as the grid now holds them', async () => {
    const t = await opened()
    const typed = t.press(cellValues(t.unitId, t.sheet, 1, 0, { v: null, p: doc([{ text: 'Net ' }, { text: 'total', bold: true }]) }))
    if ('stop' in typed) throw new Error(typed.stop)
    await t.save(typed.keep)
    // Italic on the whole cell: the mutation carries the style alone; the grid writes it into every run.
    const styled = t.press(cellValues(t.unitId, t.sheet, 1, 0, { s: { it: 1 } }))
    if ('stop' in styled) throw new Error(styled.stop)
    expect((styled.keep[0]!.params as { cellValue: Record<number, Record<number, { p?: unknown }>> }).cellValue[1]![0]!.p).toBeTruthy()
    await t.save(styled.keep)
    const runs = readText(t.bytes(), 'Review').find((c) => c.row === 1 && c.column === 0)!.runs
    expect(runs.map((r) => r.text).join('')).toBe('Net total')
    // Both runs italic now, the second still bold: the file did not keep the runs as they were.
    expect(runs.every((r) => r.font?.italic)).toBe(true)
    expect(runs.find((r) => r.text === 'total')?.font?.bold).toBe(true)
    expect(t.cold().sheets[t.sheet]!.cellData![1]![0]!.v).toBe('Net total')
  })

  it('a rich cell typed back to one font is plain in the file', async () => {
    const t = await opened()
    const typed = t.press(cellValues(t.unitId, t.sheet, 1, 0, { v: null, p: doc([{ text: 'Net ' }, { text: 'total', bold: true }]) }))
    if ('stop' in typed) throw new Error(typed.stop)
    await t.save(typed.keep)
    const plain = t.press(cellValues(t.unitId, t.sheet, 1, 0, { v: 'Net total', p: null }))
    if ('stop' in plain) throw new Error(plain.stop)
    await t.save(plain.keep)
    expect(readText(t.bytes(), 'Review').filter((c) => c.row === 1 && c.column === 0)).toEqual([])
    expect(t.cold().sheets[t.sheet]!.cellData![1]![0]!.v).toBe('Net total')
  })

  it('is stopped as he makes it where the store keeps no formatting (a workbook Excel or Google holds)', () => {
    const m = cellValues('u', 's', 0, 0, { v: null, p: doc([{ text: 'a' }, { text: 'b', bold: true }]) })
    expect(forPackage(m, () => null, {})).toEqual({ stop: sheetStopWords('rich') })
    expect(forPackage(m, () => null, { google: true })).toEqual({ stop: "Style part of a cell's text in Google Sheets" })
  })
})

describe('a note, in an opened Excel file', () => {
  it("a note's new words are saved in place, its author and the threads beside it kept", async () => {
    const t = await opened()
    const kept = JSON.parse(t.cold().resources!.find((r) => r.name === 'SHEET_NOTE_PLUGIN')!.data) as Record<string, Record<number, Record<number, Record<string, unknown>>>>
    const note = kept[t.sheet]![8]![0]!
    const got = t.press({ id: 'sheet.mutation.update-note', params: { unitId: t.unitId, sheetId: t.sheet, row: 8, col: 0, note: { ...note, note: 'Checked on Monday.\nAll three agree.' } } })
    if ('stop' in got) throw new Error(got.stop)
    await t.save(got.keep)
    expect(readNotes(t.bytes(), 'Review')).toEqual([{ sheet: 'Review', row: 8, column: 0, author: 'Lab', text: 'Checked on Monday.\nAll three agree.' }])
    // A cold import: the note's words, and both threads still there.
    const again = JSON.parse(t.cold().resources!.find((r) => r.name === 'SHEET_NOTE_PLUGIN')!.data) as typeof kept
    expect(again[t.sheet]![8]![0]!.note).toBe('Checked on Monday.\nAll three agree.')
    expect(Object.values(again[t.sheet]!).flatMap((cols) => Object.values(cols)).filter((n) => n.thread)).toHaveLength(2)
    // An agent's read (`sheet_read`) gives the note's words beside the cell, and no thread's stand-in as a note.
    const read = await t.store.read(t.path, 'Review!A9:B9')
    expect(read.cells[0]![0]).toEqual({ at: 'A9', v: 'row8', note: 'Checked on Monday.\nAll three agree.' })
    expect((await t.store.read(t.path, 'Review!B2')).cells[0]![0]!.note).toBeUndefined()
  })

  it('a note removed is stopped as he makes it; a note made at a cell with none is refused by the writer, and the file keeps what it had', async () => {
    const t = await opened()
    expect(forPackage({ id: 'sheet.mutation.remove-note', params: { unitId: t.unitId, sheetId: t.sheet, noteId: 'x', row: 8, col: 0 } }, () => null, { notes: SHEET_NOTES.package })).toEqual({ stop: NOTE_STOP.remove })
    // A note moved with its row goes with the row's own change.
    expect(forPackage({ id: 'sheet.mutation.update-note-position', params: { unitId: t.unitId, sheetId: t.sheet, noteId: 'x', newPosition: { row: 9, col: 0 } } }, () => null, { notes: SHEET_NOTES.package })).toEqual({ keep: [] })
    // A store that lists no note control stops an edit too.
    expect(forPackage({ id: 'sheet.mutation.update-note', params: {} }, () => null, {})).toEqual({ stop: NOTE_STOP.add })
    const before = t.bytes()
    const made = t.press({ id: 'sheet.mutation.update-note', params: { unitId: t.unitId, sheetId: t.sheet, row: 3, col: 0, note: { id: 'new1', row: 3, col: 0, width: 160, height: 72, note: 'New', show: false } } })
    if ('stop' in made) throw new Error(made.stop)
    await expect(t.save(made.keep)).rejects.toThrow(NOTE_STOP.add)
    expect(t.bytes()).toEqual(before)
  })
})
