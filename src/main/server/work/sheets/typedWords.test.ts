import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { editsOf, formatsOf, SET_RANGE_VALUES, SHEET_TEXT, typedMutations } from './mutations'
import { patchXlsx, workbookMap } from './patch/patch'
import { readText, readZip } from './patch/zip'

/**
 * Words typed into a sheet (decision 15): a plain number, a formula, TRUE or FALSE are kept as themselves, everything
 * else as text, by every writer. The grid's cell editor hands back its own document, a run a key, each in the
 * editor's font: the fault was that any document was written as words, so 42 reached Excel as the text "42".
 */
const ts = { cl: { rgb: '#151618' }, ff: 'system-ui', fs: 9.75 }
const typed = (words: string) => ({ v: null, f: null, si: null, p: { body: { dataStream: `${words}\r\n`, textRuns: [...words].map((_, i) => ({ st: i, ed: i + 1, ts })), paragraphs: [{ startIndex: words.length }] } } })
const name = (id: string): string | undefined => (id === 's1' ? 'Data' : undefined)
const set = (cellValue: unknown): SheetMutationJson[] => [{ id: SET_RANGE_VALUES, params: { unitId: 'u', subUnitId: 's1', cellValue } }]

/** One row of his typing: A 42, B 3.5, C -7, D 007, E =A1*2, F TRUE, G 3/4/2025, H '007 (Univer's own apostrophe), I 42 in a text-formatted cell, J Rent. */
const ROW = set({
  0: {
    0: typed('42'),
    1: typed('3.5'),
    2: typed('-7'),
    3: typed('007'),
    // (Univer makes a formula of "=" itself, before it looks at the runs)
    4: { v: null, f: '=A1*2', si: null, p: null },
    5: typed('TRUE'),
    6: typed('3/4/2025'),
    7: { v: '007', f: null, si: null, p: null, t: 4 },
    8: { v: '42', f: null, si: null, p: null, t: 1 },
    9: { v: 'Rent', f: null, si: null, p: null }
  }
})

describe('his typing, as each writer is handed it', () => {
  it('reaches an opened Excel file as numbers, a formula, true, and text as text', () => {
    expect(editsOf(ROW, name, { rich: true })).toEqual([
      { sheet: 'Data', cell: 'A1', value: 42 },
      { sheet: 'Data', cell: 'B1', value: 3.5 },
      { sheet: 'Data', cell: 'C1', value: -7 },
      { sheet: 'Data', cell: 'D1', value: '007', literal: true },
      { sheet: 'Data', cell: 'E1', formula: '=A1*2' },
      { sheet: 'Data', cell: 'F1', value: true },
      { sheet: 'Data', cell: 'G1', value: '3/4/2025', literal: true },
      { sheet: 'Data', cell: 'H1', value: '007', literal: true },
      { sheet: 'Data', cell: 'I1', value: '42', literal: true },
      { sheet: 'Data', cell: 'J1', value: 'Rent', literal: true }
    ])
  })

  it('carries no runs for a number typed as the editor\'s words, and keeps those of text he styled', () => {
    expect(formatsOf(set({ 0: { 0: typed('42') } }), name)).toEqual([])
    const bold = { v: null, p: { body: { dataStream: '42 kg\r\n', textRuns: [{ st: 0, ed: 2, ts: { bl: 1 } }] } } }
    expect(formatsOf(set({ 0: { 0: bold } }), name)).toEqual([{ id: SHEET_TEXT, params: { subUnitId: 'Data', cells: [{ row: 0, column: 0, runs: [{ text: '42', font: { bold: true } }, { text: ' kg' }] }] } }])
  })

  it('reaches Excel and Google (no runs kept there) with plain words typed, and styled text still refused', () => {
    // The Office and Google writers take the same specs (office/grid.ts, google/grid.ts: their tests write them).
    expect(editsOf(set({ 0: { 0: typed('42'), 1: typed('007') } }), name)).toEqual([
      { sheet: 'Data', cell: 'A1', value: 42 },
      { sheet: 'Data', cell: 'B1', value: '007', literal: true }
    ])
  })

  it('is laid in a sheet the Work service holds as the cells he meant', () => {
    const [m] = typedMutations(ROW)
    const row = (m.params as { cellValue: Record<number, Record<number, unknown>> }).cellValue[0]
    expect(row[0]).toMatchObject({ v: 42, t: 2, p: null })
    expect(row[3]).toEqual(typed('007'))
    expect(row[5]).toMatchObject({ v: 1, t: 3, p: null })
    expect(row[9]).toMatchObject({ v: 'Rent', t: 1 })
    // what is no cell write, or has no cells, passes as it came
    const width = { id: 'sheet.mutation.set-worksheet-col-width', params: { subUnitId: 's1' } }
    expect(typedMutations([width])[0]).toBe(width)
  })
})

describe('an .xlsx the patch writer saves from his typing', () => {
  it('holds a number as a number cell and "007" as a string, read back from the sheet\'s XML', async () => {
    const base = new Uint8Array(readFileSync(join(__dirname, 'harness/corpus/patch/base.xlsx')))
    const sheet = workbookMap(readZip(base)).sheets[0]!
    const edits = editsOf(ROW, (id) => (id === 's1' ? sheet.name : undefined), { rich: true }).map((e) => ({ ...e, cell: e.cell.replace('1', '40') }))
    const { bytes } = await patchXlsx(base, edits, {})
    const z = readZip(bytes)
    const xml = readText(z, sheet.part)
    const strings = [...readText(z, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''))
    const cell = (at: string): { t: string | null; v: string | null; f: string | null } => {
      const c = new RegExp(`<c r="${at}"([^>]*)>([\\s\\S]*?)</c>`).exec(xml)
      if (!c) throw new Error(`${at} was not written`)
      const t = /\st="(\w+)"/.exec(c[1]!)?.[1] ?? null
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2]!)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2]!)?.[1] ?? null
      return { t, v: t === 's' && v !== null ? strings[Number(v)]! : v, f: /<f>([\s\S]*?)<\/f>/.exec(c[2]!)?.[1] ?? null }
    }
    const number = (t: string | null) => t === null || t === 'n'
    expect(cell('A40')).toMatchObject({ v: '42' })
    expect(number(cell('A40').t)).toBe(true)
    expect(number(cell('B40').t) && cell('B40').v).toBe('3.5')
    expect(number(cell('C40').t) && cell('C40').v).toBe('-7')
    expect(cell('D40')).toMatchObject({ v: '007' })
    expect(['s', 'str', 'inlineStr']).toContain(cell('D40').t)
    expect(cell('E40').f).toBe('A1*2')
    expect(cell('F40')).toMatchObject({ t: 'b', v: '1' })
    expect(['s', 'str', 'inlineStr']).toContain(cell('G40').t)
    expect(['s', 'str', 'inlineStr']).toContain(cell('I40').t)
  })
})
