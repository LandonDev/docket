import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { ensurePackageTables, PackageStore } from './packages'
import { readRels, workbookMap } from './patch/patch'
import { readEntry, readText, readZip } from './patch/zip'
import { cellName } from './a1'
import { moveRefusalWords, type Refusal } from './moves'
import { mapCell, type StructuralOp } from './structural'
import { libreOffice, SOFFICE } from './testing'
import { localJobs } from './workerClient'

/**
 * Moved cells, rows and columns saved into an opened Excel file through the real path
 * (PackageStore.edit → planOf → the move check → LibreOffice → graft), each case on a dummy file
 * of corpus/moves (made by harness/make_moves.py) or the corpus, and read back: the formulas that
 * point at what moved, with the values LibreOffice calculated; the names, charts, tables, rules,
 * merges, notes and links that should follow; every plain value at the place `mapCell` says; and
 * nothing xmldiff counts lost (harness/check_moves.py, where a python with lxml is here).
 *
 * The refusals need no LibreOffice: the host refuses before it runs, and the file is left as it was.
 *
 * Runs LibreOffice: through the box's `heavy` queue. SHEET_MOVES_PROOF=<folder> also writes each
 * proven case's file before and after, with what Excel should show, for a live proof in real Excel.
 */

const CORPUS = join(__dirname, 'harness/corpus')
const office = existsSync(SOFFICE)
const PY = process.env.SHEET_HARNESS_PYTHON ?? '/tmp/editors-lab-sheets/py/bin/python'
const lxml = existsSync(PY)
const PROOF = process.env.SHEET_MOVES_PROOF
const scratch = mkdtempSync(join(tmpdir(), 'sheets-moves-'))
const proofs: { case: string; also?: Record<string, unknown> }[] = []
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  if (PROOF && proofs.length) writeFileSync(join(PROOF, 'manifest.json'), JSON.stringify({ made: new Date().toISOString(), cases: proofs }, null, 1))
})

type Cell = { f?: string; v: unknown }
/** Every cell of a package, by `Sheet!A1`: its formula and the value the file holds. */
function cellsOf(bytes: Uint8Array): Map<string, Cell> {
  const { workbook } = importXlsx(bytes)
  const out = new Map<string, Cell>()
  for (const id of workbook.sheetOrder) {
    const sheet = workbook.sheets[id]!
    for (const [r, row] of Object.entries(sheet.cellData ?? {}))
      for (const [c, raw] of Object.entries(row ?? {})) {
        const cell = raw as { v?: unknown; f?: string } | null
        if (!cell || (cell.v === undefined && !cell.f)) continue
        out.set(`${sheet.name}!${cellName(Number(r), Number(c))}`, cell.f ? { f: cell.f, v: cell.v } : { v: cell.v })
      }
  }
  return out
}
/** The style of each named cell of a sheet, as the importer reads it (`bl`: bold, `n.pattern`: the number format). */
function stylesOf(bytes: Uint8Array, name: string, cells: string[]): unknown[] {
  const { workbook } = importXlsx(bytes)
  const sheet = Object.values(workbook.sheets).find((x) => x?.name === name)!
  return cells.map((ref) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!
    const col = [...m[1]].reduce((x, ch) => x * 26 + ch.charCodeAt(0) - 64, 0) - 1
    const cell = (sheet.cellData as Record<string, Record<string, { s?: unknown } | null>> | undefined)?.[Number(m[2]) - 1]?.[col]
    const style = typeof cell?.s === 'string' ? (workbook.styles as Record<string, unknown> | undefined)?.[cell.s] : cell?.s
    return style ?? null
  })
}
const BOLD = { bl: 1, n: { pattern: '0.00' } }
const sheetXml = (bytes: Uint8Array, name: string): string => {
  const z = readZip(bytes)
  return readText(z, workbookMap(z).sheets.find((s) => s.name === name)!.part)
}
const namesOf = (bytes: Uint8Array): Record<string, string> =>
  Object.fromEntries([...workbookMap(readZip(bytes)).wbXml.matchAll(/<definedName\b[^>]*\bname="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2].replace(/&apos;/g, "'")]))
/** The ranges the workbook's chart series read: their categories and their values. */
const chartRefs = (bytes: Uint8Array): string[] => {
  const z = readZip(bytes)
  return [...new Set([...z.byName.keys()].filter((n) => /\/charts\/chart[^/]*\.xml$/.test(n)).flatMap((n) => [...readText(z, n).matchAll(/<c:(cat|val|xVal|yVal)>[\s\S]*?<c:f>([^<]*)<\/c:f>[\s\S]*?<\/c:\1>/g)].map((m) => m[2])))].sort()
}
/** Each chart series' name as the file holds it: typed text, or the cell it is read from. */
const seriesNames = (bytes: Uint8Array): string[] => {
  const z = readZip(bytes)
  return [...z.byName.keys()]
    .filter((n) => /\/charts\/chart[^/]*\.xml$/.test(n))
    .flatMap((n) => [...readText(z, n).matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map((m) => /<c:tx>([\s\S]*?)<\/c:tx>/.exec(m[0])?.[1] ?? ''))
    .map((tx) => /<c:f>([^<]*)<\/c:f>/.exec(tx)?.[1] ?? `"${/<c:v>([^<]*)<\/c:v>/.exec(tx)?.[1] ?? ''}"`)
}
/** The cells of a package that a formula fills: each formula's own cell, and every cell of an array's, a spill's or a shared group's range. */
function formulaCells(bytes: Uint8Array): Set<string> {
  const z = readZip(bytes)
  const out = new Set<string>()
  for (const tab of workbookMap(z).sheets) {
    if (tab.kind !== 'worksheet') continue
    for (const m of readText(z, tab.part).matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*>\s*<f\b([^>]*)/g)) {
      out.add(`${tab.name}!${m[1]}`)
      const ref = /\bref="([^"]+)"/.exec(m[2])?.[1]
      if (ref) for (const cell of cellsIn(ref).split(' ')) out.add(`${tab.name}!${cell}`)
    }
  }
  return out
}
const refsOf = (xml: string, tag: string, attr = 'ref'): string[] => [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*\\b${attr}="([^"]+)"`, 'g'))].map((m) => m[1]).sort()
const tablesOf = (bytes: Uint8Array, sheet: string): string[] => {
  const z = readZip(bytes)
  const part = workbookMap(z).sheets.find((s) => s.name === sheet)!.part
  return readRels(z, part).rels.filter((r) => r.type.endsWith('/table')).flatMap((r) => refsOf(readText(z, r.target), 'table'))
}
const notesOf = (bytes: Uint8Array, sheet: string): string[] => {
  const z = readZip(bytes)
  const part = workbookMap(z).sheets.find((s) => s.name === sheet)!.part
  return readRels(z, part).rels.filter((r) => r.type.endsWith('/comments')).flatMap((r) => refsOf(readText(z, r.target), 'comment'))
}
/** The cells of a list of cells and ranges (`sqref`), sorted: two lists that cover the same cells read the same, however each is cut into ranges. */
const cellsIn = (sqref: string): string =>
  sqref
    .split(' ')
    .flatMap((ref) => {
      const [a, b = a] = ref.split(':').map((x) => /^([A-Z]+)(\d+)$/.exec(x)!)
      const col = (m: RegExpExecArray): number => [...m[1]].reduce((x, ch) => x * 26 + ch.charCodeAt(0) - 64, 0) - 1
      const out: string[] = []
      for (let r = Number(a[2]); r <= Number(b[2]); r++) for (let c = col(a); c <= col(b); c++) out.push(cellName(r - 1, c))
      return out
    })
    .sort()
    .join(' ')
/** Where a sheet's conditional formats or validations apply, each as its cells. */
const areas = (xml: string, tag: string): string[] => refsOf(xml, tag, 'sqref').map(cellsIn).sort()
const areasOf = (sqrefs: string[]): string[] => sqrefs.map(cellsIn).sort()

const R = (r1: number, c1: number, r2: number, c2: number) => ({ startRow: r1, startColumn: c1, endRow: r2, endColumn: c2, rangeType: 0 })
type Ids = (name: string) => string
const block = (sheet: string, r1: number, c1: number, r2: number, c2: number, to: string, row: number, col: number) => (id: Ids): SheetMutationJson => ({
  id: 'sheet.mutation.move-range',
  params: { unitId: 'workbook', fromRange: R(r1, c1, r2, c2), toRange: R(row, col, row + r2 - r1, col + c2 - c1), from: { subUnitId: id(sheet), value: {} }, to: { subUnitId: id(to), value: {} } }
})
const rows = (sheet: string, at: number, count: number, to: number) => (id: Ids): SheetMutationJson => ({
  id: 'sheet.mutation.move-rows',
  params: { unitId: 'workbook', subUnitId: id(sheet), sourceRange: R(at, 0, at + count - 1, 25), targetRange: R(to, 0, to + count - 1, 25) }
})
const cols = (sheet: string, at: number, count: number, to: number) => (id: Ids): SheetMutationJson => ({
  id: 'sheet.mutation.move-columns',
  params: { unitId: 'workbook', subUnitId: id(sheet), sourceRange: R(0, at, 99, at + count - 1), targetRange: R(0, to, 99, to + count - 1) }
})

async function storeIn(dir: string): Promise<PackageStore> {
  const db = new DatabaseSync(':memory:')
  ensurePackageTables(db)
  return new PackageStore(db, await localJobs(), join(dir, 'copies'), () => null, Date.now, () => {}, libreOffice)
}

let n = 0
/** A fixture moved through the real path: its bytes before and after, and the ops the store saved. */
async function moved(file: string, move: (id: Ids) => SheetMutationJson) {
  const dir = join(scratch, `${++n}`)
  mkdirSync(dir)
  const path = join(dir, file.split('/').pop()!)
  copyFileSync(join(CORPUS, file), path)
  const before = new Uint8Array(readFileSync(path))
  const s = await storeIn(dir)
  const sheets = (await s.open(path)).inspected.sheets
  const id: Ids = (name) => sheets.find((x) => x.name === name)!.id
  const got = await s.edit(path, 0, [move(id)], 'owner')
  const after = new Uint8Array(readFileSync(path))
  const ops = 'moved' in got && got.moved ? got.moved.ops : []
  return { before, after, ops, label: s.history(path)[0]?.label, path }
}

/**
 * Every plain value of the file before is where `mapCell` says, and no other plain value is in the file after. A cell a
 * formula fills is not a plain value, though its file holds one for it (an array's, a spill's and a shared group's
 * other cells: the cases assert those by formula and value).
 */
function plainValuesFollow(before: Uint8Array, after: Uint8Array, ops: readonly StructuralOp[], only?: string): void {
  const on = (key: string): boolean => !only || key.startsWith(`${only}!`)
  const [fb, fa] = [formulaCells(before), formulaCells(after)]
  const b = new Map([...cellsOf(before)].filter(([k]) => on(k) && !fb.has(k)))
  const a = new Map([...cellsOf(after)].filter(([k]) => on(k) && !fa.has(k)))
  const want = new Map<string, unknown>()
  for (const [key, cell] of b) {
    if (cell.f) continue
    const [sheet, ref] = key.split('!')
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!
    const col = [...m[1]].reduce((x, ch) => x * 26 + ch.charCodeAt(0) - 64, 0) - 1
    const to = mapCell(ops, sheet, Number(m[2]) - 1, col)
    if (to) want.set(`${to.sheet}!${cellName(to.row, to.col)}`, cell.v)
  }
  const got = new Map([...a].filter(([, c]) => !c.f).map(([k, c]) => [k, c.v]))
  expect(Object.fromEntries(got)).toEqual(Object.fromEntries(want))
}

function nothingLost(before: Uint8Array, after: Uint8Array): void {
  if (!lxml) return
  const dir = mkdtempSync(join(scratch, 'x-'))
  writeFileSync(join(dir, 'a.xlsx'), before)
  writeFileSync(join(dir, 'b.xlsx'), after)
  const out = execFileSync(PY, ['-I', join(CORPUS, '..', 'check_moves.py'), join(dir, 'a.xlsx'), join(dir, 'b.xlsx')], { encoding: 'utf8' })
  expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({ lost: [] })
}

/** The cells a case asserts: `Sheet!A1` → [formula or null, the value LibreOffice calculated]. */
type Expect = Record<string, [string | null, unknown]>
function cellsAre(after: Uint8Array, want: Expect): void {
  const a = cellsOf(after)
  const got: Expect = {}
  for (const key of Object.keys(want)) {
    const c = a.get(key)
    got[key] = c ? [c.f ?? null, c.v] : [null, undefined]
  }
  expect(got).toEqual(want)
}

function proof(name: string, said: string, before: Uint8Array, after: Uint8Array, cells: Expect, file: string): void {
  if (!PROOF) return
  mkdirSync(PROOF, { recursive: true })
  const ext = file.endsWith('.xlsm') ? 'xlsm' : 'xlsx'
  writeFileSync(join(PROOF, `${name}.before.${ext}`), before)
  writeFileSync(join(PROOF, `${name}.after.${ext}`), after)
  proofs.push({ case: name, move: said, before: `${name}.before.${ext}`, after: `${name}.after.${ext}`, excel: Object.entries(cells).map(([cell, [formula, value]]) => ({ cell, formula, value })) } as (typeof proofs)[number])
}
/** What else a proven case's file should show in Excel (names, chart ranges, where a rule applies), for the manifest. */
function shows(name: string, facts: Record<string, unknown>): void {
  const entry = proofs.find((p) => p.case === name)
  if (entry) entry.also = { ...entry.also, ...facts }
}

/** One proven case: moved, every plain value followed, nothing counted lost, the asserted cells, and the proof files. */
async function proven(name: string, file: string, said: string, move: (id: Ids) => SheetMutationJson, cells: Expect, only?: string) {
  const got = await moved(file, move)
  expect(got.ops.length).toBe(1)
  plainValuesFollow(got.before, got.after, got.ops, only)
  nothingLost(got.before, got.after)
  cellsAre(got.after, cells)
  proof(name, said, got.before, got.after, cells, file)
  return got
}

// (a case is one to five LibreOffice runs, each some seconds on a busy box)
describe.skipIf(!office)('moves saved through LibreOffice', { timeout: 600_000 }, () => {
  // refs.xlsx: Data!A1:B3 holds 1 2 / 3 4 / =D10*2 =A1+B2; D1, D2, D4, D6 and Calc!A1:A2 point at it; the names Block
  // (A1:B3) and Single (A1); a chart reads A1:A3 and B1:B3. Beside it A4:A6 (10 20 30), read whole by D3, by the name
  // Part and by Calc!A3.
  it('a block dragged on its sheet: every formula, name and chart that points at it follows; a range beside it stays', async () => {
    const got = await proven('block', 'moves/refs.xlsx', 'Data!A1:B3 dragged to F5', block('Data', 0, 0, 2, 1, 'Data', 4, 5), {
      'Data!D1': ['=F5', 1],
      'Data!D2': ['=SUM(F5:G7)', 25],
      'Data!D3': ['=SUM(A4:A6)', 60],
      'Data!D4': ['=SUM(Block)', 25],
      'Data!D5': ['=SUM(Part)', 60],
      'Data!D6': ['=Single*1', 1],
      'Data!F7': ['=D10*2', 10],
      'Data!G7': ['=F5+G6', 5],
      'Calc!A1': ['=Data!F5', 1],
      'Calc!A2': ['=SUM(Data!F5:G7)', 25],
      'Calc!A3': ['=SUM(Data!A4:A6)', 60]
    })
    expect(got.label).toBe('Moved cells')
    expect(namesOf(got.after)).toEqual({ Block: 'Data!$F$5:$G$7', Part: 'Data!$A$4:$A$6', Single: 'Data!$F$5' })
    expect(chartRefs(got.after)).toEqual(['Data!$F$5:$F$7', 'Data!$G$5:$G$7'])
    // the series' name was typed, not read from a cell: LibreOffice wrote a reference for it, and graft put the text back
    expect(seriesNames(got.before)).toEqual(['"Block"'])
    expect(seriesNames(got.after)).toEqual(['"Block"'])
    shows('block', { names: namesOf(got.after), chart: chartRefs(got.after), seriesName: 'Block (typed text)' })
  })

  it('a block cut on one sheet and pasted on another', async () => {
    const got = await proven('block-to-sheet', 'moves/refs.xlsx', 'Data!A1:B3 cut and pasted at Calc!E5', block('Data', 0, 0, 2, 1, 'Calc', 4, 4), {
      'Data!D1': ['=Calc!E5', 1],
      'Data!D2': ['=SUM(Calc!E5:F7)', 25],
      'Data!D3': ['=SUM(A4:A6)', 60],
      'Calc!A1': ['=Calc!E5', 1],
      'Calc!A2': ['=SUM(Calc!E5:F7)', 25],
      'Calc!E7': ['=Data!D10*2', 10],
      'Calc!F7': ['=E5+F6', 5]
    })
    expect(namesOf(got.after)).toEqual({ Block: 'Calc!$E$5:$F$7', Part: 'Data!$A$4:$A$6', Single: 'Calc!$E$5' })
    expect(chartRefs(got.after)).toEqual(['Calc!$E$5:$E$7', 'Calc!$F$5:$F$7'])
    expect(seriesNames(got.after)).toEqual(['"Block"'])
    shows('block-to-sheet', { names: namesOf(got.after), chart: chartRefs(got.after), seriesName: 'Block (typed text)' })
  })

  it('a block dropped over part of itself', async () => {
    await proven('block-over-itself', 'moves/refs.xlsx', 'Data!A1:B3 dragged to B2', block('Data', 0, 0, 2, 1, 'Data', 1, 1), {
      'Data!D1': ['=B2', 1],
      'Data!D2': ['=SUM(B2:C4)', 25],
      'Data!B4': ['=D10*2', 10],
      'Data!C4': ['=B2+C3', 5]
    })
  })

  it('a cell from the middle of a range a formula reads, dropped on data nothing reads: the range stays, as in Excel, and what stood there is gone', async () => {
    // A5 is neither end of A4:A6; H2 holds 7 and nothing reads it
    await proven('block-onto-data', 'moves/refs.xlsx', 'Data!A5 dragged onto H2 (which holds 7)', block('Data', 4, 0, 4, 0, 'Data', 1, 7), {
      'Data!H2': [null, 20],
      'Data!A5': [null, undefined],
      'Data!D3': ['=SUM(A4:A6)', 40],
      'Data!D5': ['=SUM(Part)', 40],
      'Data!D7': ['=H1', 'old'],
      'Calc!A3': ['=SUM(Data!A4:A6)', 40]
    })
  })

  it('rows dragged down: the rows between close up, and what points at the moved rows follows them', async () => {
    const got = await proven('rows-down', 'moves/refs.xlsx', 'Data rows 1:3 dragged to before row 9', rows('Data', 0, 3, 8), {
      'Data!D6': ['=A6', 1],
      'Data!D7': ['=SUM(A6:B8)', 25],
      'Data!D8': ['=SUM(A1:A3)', 60],
      'Data!A8': ['=D10*2', 10],
      'Data!B8': ['=A6+B7', 5],
      'Data!D4': ['=H6', 'old'],
      'Calc!A1': ['=Data!A6', 1],
      'Calc!A3': ['=SUM(Data!A1:A3)', 60]
    })
    expect(got.label).toBe('Moved 3 rows')
    expect(namesOf(got.after)).toEqual({ Block: 'Data!$A$6:$B$8', Part: 'Data!$A$1:$A$3', Single: 'Data!$A$6' })
    shows('rows-down', { names: namesOf(got.after) })
  })

  it('rows dragged up: a range the rows hold whole goes with them', async () => {
    await proven('rows-up', 'moves/refs.xlsx', 'Data rows 4:6 dragged to before row 1', rows('Data', 3, 3, 0), {
      'Data!D4': ['=A4', 1],
      'Data!D5': ['=SUM(A4:B6)', 25],
      'Data!D6': ['=SUM(A1:A3)', 60],
      'Data!D2': ['=SUM(Part)', 60],
      'Calc!A2': ['=SUM(Data!A4:B6)', 25],
      'Calc!A3': ['=SUM(Data!A1:A3)', 60]
    })
  })

  it('the last row of a range dragged to a place inside it: the range covers the same rows as before', async () => {
    const got = await proven('rows-within-range', 'moves/refs.xlsx', 'Data row 6 dragged to before row 5', rows('Data', 5, 1, 4), {
      'Data!A5': [null, 30],
      'Data!A6': [null, 20],
      'Data!D3': ['=SUM(A4:A6)', 60],
      'Data!D5': ['=Single*1', 1],
      'Data!D6': ['=SUM(Part)', 60],
      'Calc!A3': ['=SUM(Data!A4:A6)', 60]
    })
    expect(namesOf(got.after)).toMatchObject({ Part: 'Data!$A$4:$A$6' })
    shows('rows-within-range', { names: namesOf(got.after) })
  })

  it('columns dragged right', async () => {
    const got = await proven('columns', 'moves/refs.xlsx', 'Data columns A:B dragged to before column F', cols('Data', 0, 2, 5), {
      'Data!B1': ['=D1', 1],
      'Data!B2': ['=SUM(D1:E3)', 25],
      'Data!B3': ['=SUM(D4:D6)', 60],
      'Data!D3': ['=B10*2', 10],
      'Calc!A3': ['=SUM(Data!D4:D6)', 60]
    })
    expect(got.label).toBe('Moved 2 columns')
    expect(chartRefs(got.after)).toEqual(['Data!$D$1:$D$3', 'Data!$E$1:$E$3'])
    expect(seriesNames(got.after)).toEqual(['"Block"'])
    shows('columns', { chart: chartRefs(got.after), seriesName: 'Block (typed text)' })
  })

  // rules.xlsx: Data!A1:C3 (1..9) with a bold row 1, conditional formats on A1:B3 and C1:C10, validations on A1:B3 and
  // C2:C10, a link in A2, a note on B1; merges F1:G1 and I2:J2; two conditional formats that overlap on R21:R23.
  it("a block takes its formats, conditional formats, validations, link and note with it; a rule over part of it splits, and none stays on the cells it left", async () => {
    const got = await proven('block-rules', 'moves/rules.xlsx', 'Data!A1:C3 dragged to J15', block('Data', 0, 0, 2, 2, 'Data', 14, 9), {})
    const xml = sheetXml(got.after, 'Data')
    expect(areas(xml, 'conditionalFormatting')).toEqual(areasOf(RULES_AFTER_BLOCK.conditional))
    expect(areas(xml, 'dataValidation')).toEqual(areasOf(RULES_AFTER_BLOCK.validation))
    expect(refsOf(xml, 'hyperlink')).toEqual(['J16'])
    expect(notesOf(got.after, 'Data')).toEqual(['K15'])
    // the block's first row was bold with two decimals, and is where it landed; its second row was not
    expect(stylesOf(got.after, 'Data', ['J15', 'K15', 'L15'])).toEqual([BOLD, BOLD, BOLD].map((x) => expect.objectContaining(x)))
    expect(stylesOf(got.after, 'Data', ['K16'])).toEqual([expect.not.objectContaining({ bl: 1 })])
    shows('block-rules', { conditionalFormats: RULES_AFTER_BLOCK.conditional, validations: RULES_AFTER_BLOCK.validation, link: 'J16', note: 'K15', bold: 'J15:L15' })
  })

  it('a block dropped partly on cells that have rules of their own: those cells take the block’s rules and lose their own', async () => {
    const got = await proven('block-onto-rules', 'moves/rules.xlsx', 'Data!A1:C3 dragged to N6 (N5:P7 has a conditional format and a validation)', block('Data', 0, 0, 2, 2, 'Data', 5, 13), {})
    const xml = sheetXml(got.after, 'Data')
    expect(areas(xml, 'conditionalFormatting')).toEqual(areasOf(RULES_AFTER_ONTO.conditional))
    expect(areas(xml, 'dataValidation')).toEqual(areasOf(RULES_AFTER_ONTO.validation))
    shows('block-onto-rules', { conditionalFormats: RULES_AFTER_ONTO.conditional, validations: RULES_AFTER_ONTO.validation })
  })

  it('rows take their rules, merges, link and note with them', async () => {
    const got = await proven('rows-rules', 'moves/rules.xlsx', 'Data rows 1:3 dragged to before row 13', rows('Data', 0, 3, 12), {})
    const xml = sheetXml(got.after, 'Data')
    expect(refsOf(xml, 'mergeCell')).toEqual(['F10:G10', 'I11:J11'])
    expect(areas(xml, 'conditionalFormatting')).toEqual(areasOf(RULES_AFTER_ROWS.conditional))
    expect(areas(xml, 'dataValidation')).toEqual(areasOf(RULES_AFTER_ROWS.validation))
    expect(refsOf(xml, 'hyperlink')).toEqual(['A11'])
    expect(notesOf(got.after, 'Data')).toEqual(['B10'])
    expect(stylesOf(got.after, 'Data', ['A10', 'B10', 'C10'])).toEqual([BOLD, BOLD, BOLD].map((x) => expect.objectContaining(x)))
    shows('rows-rules', { merges: ['F10:G10', 'I11:J11'], conditionalFormats: RULES_AFTER_ROWS.conditional, validations: RULES_AFTER_ROWS.validation, link: 'A11', note: 'B10' })
  })

  it('a block with a merge wholly inside it', async () => {
    const got = await proven('block-merge', 'moves/rules.xlsx', 'Data!F1:G3 dragged to J20', block('Data', 0, 5, 2, 6, 'Data', 19, 9), {})
    expect(refsOf(sheetXml(got.after, 'Data'), 'mergeCell')).toEqual(['I2:J2', 'J20:K20'])
    shows('block-merge', { merges: ['I2:J2', 'J20:K20'] })
  })

  // tables.xlsx: the table Sales on A1:B4, D1 =SUM(Sales[Amount]), F1:F3 with D2 =SUM(F1:F3), A6:A8 below.
  it('a whole table dragged: it stays a table, and its structured reference still reads it', async () => {
    const got = await proven('table-whole', 'moves/tables.xlsx', 'Data!A1:B4 (the table Sales) dragged to H1', block('Data', 0, 0, 3, 1, 'Data', 0, 7), {
      'Data!D1': ['=SUM(Sales[Amount])', 6]
    })
    expect(tablesOf(got.after, 'Data')).toEqual(['H1:I4'])
    shows('table-whole', { table: 'Sales on H1:I4' })
  })

  it('rows moved from below a table to above it shift it whole; rows holding the whole table move it', async () => {
    const across = await proven('table-rows-across', 'moves/tables.xlsx', 'Data row 7 dragged to before row 1', rows('Data', 6, 1, 0), {
      'Data!D2': ['=SUM(Sales[Amount])', 6],
      'Data!D3': ['=SUM(F2:F4)', 600]
    })
    expect(tablesOf(across.after, 'Data')).toEqual(['A2:B5'])
    shows('table-rows-across', { table: 'Sales on A2:B5' })
    const whole = await proven('table-rows-whole', 'moves/tables.xlsx', 'Data rows 1:4 dragged to before row 10', rows('Data', 0, 4, 9), {
      'Data!D6': ['=SUM(Sales[Amount])', 6]
    })
    expect(tablesOf(whole.after, 'Data')).toEqual(['A6:B9'])
    shows('table-rows-whole', { table: 'Sales on A6:B9' })
  })

  it('a block beside a table', async () => {
    await proven('table-beside', 'moves/tables.xlsx', 'Data!F1:F3 dragged to J1', block('Data', 0, 5, 2, 5, 'Data', 0, 9), {
      'Data!D1': ['=SUM(Sales[Amount])', 6],
      'Data!D2': ['=SUM(J1:J3)', 600]
    })
  })

  // arrays.xlsx: A1:A3 = 1 2 3, {=A1:A3*2} on C1:C3, =SEQUENCE(3) spilling E1:E3, a shared formula group G1:G3 (=A1*10),
  // I1 =SUM(C1:C3), I2 =SUM(G1:G3).
  it('a whole array formula, a whole spill, a shared formula group whole or in part, and an array’s input', async () => {
    await proven('array-whole', 'moves/arrays.xlsx', 'Data!C1:C3 (an array formula) dragged to J1', block('Data', 0, 2, 2, 2, 'Data', 0, 9), {
      'Data!J1': ['=A1:A3*2', 2],
      'Data!I1': ['=SUM(J1:J3)', 12]
    })
    const spill = await proven('spill-whole', 'moves/arrays.xlsx', 'Data!E1:E3 (a spill) dragged to J5', block('Data', 0, 4, 2, 4, 'Data', 4, 9), {
      'Data!J5': ['=SEQUENCE(3)', 1],
      'Data!J6': [null, 2],
      'Data!J7': [null, 3]
    })
    // the dynamic-array mark went with its cell, and the metadata it points into is in the file
    expect(sheetXml(spill.after, 'Data')).toMatch(/<c r="J5"[^>]*\bcm="1"/)
    expect(readZip(spill.after).byName.has('xl/metadata.xml')).toBe(true)
    await proven('shared-whole', 'moves/arrays.xlsx', 'Data!G1:G3 (a shared formula group) dragged to J10', block('Data', 0, 6, 2, 6, 'Data', 9, 9), {
      'Data!J10': ['=A1*10', 10],
      'Data!J12': ['=A3*10', 30],
      'Data!I2': ['=SUM(J10:J12)', 60]
    })
    await proven('shared-part', 'moves/arrays.xlsx', 'Data!G2 (one of a shared formula group) dragged to J10', block('Data', 1, 6, 1, 6, 'Data', 9, 9), {
      'Data!G1': ['=A1*10', 10],
      'Data!G3': ['=A3*10', 30],
      'Data!J10': ['=A2*10', 20],
      'Data!I2': ['=SUM(G1:G3)', 40]
    })
    await proven('array-input', 'moves/arrays.xlsx', "Data!A1:A3 (an array formula's input) dragged to L10", block('Data', 0, 0, 2, 0, 'Data', 9, 11), {
      'Data!C1': ['=L10:L12*2', 2],
      'Data!G1': ['=L10*10', 10],
      'Data!I1': ['=SUM(C1:C3)', 12]
    })
  })

  it("rows moved among the filter's own rows: the filter and the frozen pane stay", async () => {
    const got = await proven('filter-rows', 'moves/layout.xlsx', 'Data rows 3:4 dragged to before row 9', rows('Data', 2, 2, 8), {
      'Data!A7': [null, 'item2'],
      'Data!E1': ['=SUM(B2:B10)', 45]
    })
    const xml = sheetXml(got.after, 'Data')
    expect(refsOf(xml, 'autoFilter')).toEqual(['A1:C10'])
    expect(xml).toMatch(/<pane\b[^>]*\bySplit="2"/)
    shows('filter-rows', { filter: 'A1:C10', frozen: 'the first two rows' })
  })

  it('a block beside a pivot table and its source', async () => {
    // (only Data's cells: LibreOffice lays the pivot tables out again on any save, a move or not; check_structural.py's noise)
    await proven('beside-pivot', 'pivot.xlsx', 'Data!G1:G3 dragged to K1', block('Data', 0, 6, 2, 6, 'Data', 0, 10), {}, 'Data')
  })

  it("a chartsheet's chart follows rows moved under it", async () => {
    const got = await proven('chartsheet', 'charts.xlsx', 'Data rows 1:9 dragged to before row 13', rows('Data', 0, 9, 12), {})
    // (the worksheet's own charts are LibreOffice's to move; the chartsheet's is put back by graft.ts, its ranges moved by `mapRange`)
    const z = readZip(got.after)
    const sheetChart = [...z.byName.keys()].find((name) => /^xl\/chartsheets\/sheet\d+\.xml$/.test(name))!
    const drawing = readRels(z, sheetChart).rels[0]!.target
    const chart = readRels(z, drawing).rels.find((r) => r.type.endsWith('/chart'))!.target
    // two series: each one's name cell, its categories and its values
    expect([...readText(z, chart).matchAll(/<c:f>([^<]*)<\/c:f>/g)].map((m) => m[1])).toEqual(['Data!$B$4', 'Data!$A$5:$A$12', 'Data!$B$5:$B$12', 'Data!$C$4', 'Data!$A$5:$A$12', 'Data!$C$5:$C$12'])
  })

  // names.xlsx: two charts over A2:A5 and B2:B5; one series is named "Budget" (typed), the other from Data!H1.
  it('a row inserted on another sheet: a series named from a cell keeps its cell, though another chart over the same ranges has a typed name', async () => {
    const insert = (id: Ids): SheetMutationJson => ({ id: 'sheet.mutation.insert-row', params: { unitId: 'workbook', subUnitId: id('Other'), range: R(0, 0, 0, 25) } })
    const got = await proven('series-names', 'moves/names.xlsx', 'a row inserted above row 1 of Other', insert, { 'Other!A2': [null, 1] })
    expect(seriesNames(got.before).sort()).toEqual(['"Budget"', 'Data!$H$1'])
    const names = seriesNames(got.after)
    expect(names.filter((n) => n === 'Data!$H$1')).toHaveLength(1)
    // (LibreOffice writes the typed name as a formula that is the text itself; graft leaves it, since it cannot tell the two charts apart)
    expect(names.filter((n) => n.includes('Budget'))).toHaveLength(1)
    shows('series-names', { seriesNames: 'one chart: Budget; the other: the text in Data!H1 ("From a cell")' })
  })

  it("keeps a macro workbook's project byte for byte through a move", async () => {
    const got = await proven('macro', 'macro.xlsm', 'Main!A3:B3 dragged to D5', (id) => block(MACRO_SHEET, 2, 0, 2, 1, MACRO_SHEET, 4, 3)(id), {
      'Main!E5': ['=D5*2', 42]
    })
    const vba = (b: Uint8Array) => Buffer.from(readEntry(readZip(b), 'xl/vbaProject.bin'))
    expect(vba(got.after).equals(vba(got.before))).toBe(true)
  })
})

describe('moves refused before anything is written, in the canvas’s words', () => {
  const cases: [string, string, (id: Ids) => SheetMutationJson, Refusal][] = [
    ['part of a table', 'moves/tables.xlsx', block('Data', 1, 0, 2, 1, 'Data', 9, 7), 'table'],
    ['a block landing on a table', 'moves/tables.xlsx', block('Data', 0, 5, 0, 5, 'Data', 2, 1), 'table'],
    ["rows taken out of a table", 'moves/tables.xlsx', rows('Data', 1, 2, 9), 'table'],
    ['a block across the edge of a merge', 'moves/rules.xlsx', block('Data', 0, 8, 2, 8, 'Data', 14, 11), 'merge'],
    ['a column of a merge', 'moves/rules.xlsx', cols('Data', 5, 1, 12), 'merge'],
    ['part of an array formula', 'moves/arrays.xlsx', block('Data', 0, 2, 1, 2, 'Data', 0, 9), 'array'],
    ["a spill's first cell alone", 'moves/arrays.xlsx', block('Data', 0, 4, 0, 4, 'Data', 4, 9), 'spill'],
    ['a row through an array formula', 'moves/arrays.xlsx', rows('Data', 0, 1, 6), 'array'],
    ["the filter's header row", 'moves/layout.xlsx', rows('Data', 0, 1, 5), 'filter'],
    ["a column of the filter", 'moves/layout.xlsx', cols('Data', 2, 1, 0), 'filter'],
    ['a block that meets the filter', 'moves/layout.xlsx', block('Data', 2, 0, 3, 2, 'Data', 14, 0), 'filter'],
    ['a protected sheet', 'moves/layout.xlsx', block('Locked', 0, 0, 1, 0, 'Locked', 5, 0), 'protected'],
    ["a pivot table's source", 'pivot.xlsx', block('Data', 1, 0, 2, 4, 'Data', 0, 10), 'pivot'],
    ['a block landing where a formula reads', 'moves/refs.xlsx', block('Data', 0, 0, 2, 1, 'Data', 0, 7), 'lands'],
    ['a block that takes one of two overlapping conditional formats whole', 'moves/rules.xlsx', block('Data', 20, 17, 22, 18, 'Data', 20, 21), 'rule'],
    ['rows that take one of two overlapping conditional formats whole', 'moves/rules.xlsx', rows('Data', 20, 3, 40), 'rule'],
    ['a block that takes an end of a range a formula reads', 'moves/refs.xlsx', block('Data', 3, 0, 4, 0, 'Data', 3, 9), 'part'],
    ['rows that take an end of a range out of it', 'moves/refs.xlsx', rows('Data', 4, 2, 0), 'part'],
    ["a block that takes an end of a validation's list", 'moves/reads.xlsx', block('Data', 2, 7, 3, 7, 'Data', 9, 11), 'part'],
    ['a block landing where a rule’s formula reads', 'moves/reads.xlsx', block('Data', 0, 11, 0, 11, 'Data', 0, 7), 'lands'],
    ['rows on a sheet whose last row is in use', 'moves/full.xlsx', rows('Data', 0, 1, 2), 'full'],
    ['a block too large to check where it lands', 'moves/refs.xlsx', block('Data', 20, 20, 220, 120, 'Data', 300, 20), 'large'],
    ['rows a chart series with a typed name reads, where another chart reads the same', 'moves/names.xlsx', rows('Data', 1, 4, 20), 'chart']
  ]
  it.each(cases)('%s', async (_name, file, move, why) => {
    const dir = join(scratch, `refused-${++n}`)
    mkdirSync(dir)
    const path = join(dir, file.split('/').pop()!)
    copyFileSync(join(CORPUS, file), path)
    const before = readFileSync(path)
    const s = await storeIn(dir)
    const sheets = (await s.open(path)).inspected.sheets
    const id: Ids = (name) => sheets.find((x) => x.name === name)!.id
    await expect(s.edit(path, 0, [move(id)], 'owner')).rejects.toThrow(moveRefusalWords(why))
    expect(readFileSync(path).equals(before)).toBe(true)
    expect((await s.open(path)).rev).toBe(0)
  })
})

const MACRO_SHEET = 'Main'
/** Where the rules apply after the block (A1:C3 to J15) and the rows (1:3 to before 13) move: what Excel leaves, and what the file must hold. */
const RULES_AFTER_BLOCK = {
  conditional: ['J15:K17', 'C4:C10 L15:L17', 'N5:P7', 'R21:S23', 'R21:R30'],
  validation: ['J15:K17', 'C4:C10 L16:L17', 'N5:P7']
}
/** After A1:C3 lands on N6:P8: of N5:P7's own rules only N5:P5 is left. */
const RULES_AFTER_ONTO = {
  conditional: ['N6:O8', 'C4:C10 P6:P8', 'N5:P5', 'R21:S23', 'R21:R30'],
  validation: ['N6:O8', 'C4:C10 P7:P8', 'N5:P5']
}
const RULES_AFTER_ROWS = {
  conditional: ['A10:B12', 'C1:C7 C10:C12', 'N2:P4', 'R21:S23', 'R21:R30'],
  validation: ['A10:B12', 'C1:C7 C11:C12', 'N2:P4']
}
