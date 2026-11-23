import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { filesPaneOf, type CanvasItem } from '@shared/work'
import { LIBREOFFICE_CONVERTERS } from '../formats/index'
import type { ConvertJob, ConvertResult } from '../formats/jobs'
import { runTool, type Toolchain } from '../formats/tools'
import { sharedOf } from '../files/policy'
import { previewScratch } from '../files/preview'
import { at, makeRig, window, WS, type Rig } from '../files/testkit'
import { ensureImported, importAct, importedHeld, isSharedImport, type ImportedHeld } from './formatsIn'
import { SHEET_BACK_CONVERTERS } from './formatsInBack'
import { fileKey, type Sheets } from './held'
import { SET_RANGE_VALUES } from './mutations'
import { ensurePackageTables, PackageStore, PACKAGE_UNIT } from './packages'
import { readText, readZip } from './patch/zip'
import { SHEET_PREVIEW_CONVERTERS } from './preview'
import { SOFFICE } from './testing'
import { localJobs } from './workerClient'

/**
 * The other formats in, behind the real LibreOffice (skipped where it is absent; run through
 * `heavy` on the box): the corpus's dummy .xls, .ods and .tsv (harness/corpus/formats-in, made
 * from formulas.xlsx) each open as a workbook our grid reads, take an edit through the package
 * store, and go back as the format they were with the edit in them and every formula worked out
 * again, read back by LibreOffice. The store here has no calc engine, as a host without IronCalc
 * has none, so the sums in the saved file are right only because the save-back pair recalculates.
 */
const FIXTURES = join(import.meta.dirname, 'harness/corpus/formats-in')
const CONVERTERS = [...LIBREOFFICE_CONVERTERS, ...SHEET_PREVIEW_CONVERTERS, ...SHEET_BACK_CONVERTERS]
const there = existsSync(SOFFICE)
let rig: Rig
let s: Sheets

/** The runner's part, in this process: the converter for the pair, with LibreOffice as the box installs it. */
async function convert(job: ConvertJob): Promise<ConvertResult> {
  const c = CONVERTERS.find((x) => x.from === job.from && x.to === job.to)
  if (!c) throw new Error(`no converter from ${job.from} to ${job.to}`)
  const tmp = mkdtempSync(join(rig.base, 'job-'))
  try {
    await c.run({ ...job, output: job.output! }, { tools: { bin: () => SOFFICE, dataDir: rig.dataDir } as unknown as Toolchain, threads: 1, slot: 0, tmp, signal: new AbortController().signal, run: (cmd, args, o) => runTool(cmd, args, o) })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return { output: job.output!, ranOn: 'env_box', warnings: [] }
}

beforeEach(async () => {
  rig = makeRig()
  ensurePackageTables(rig.db)
  Object.assign(rig.ctx, { convert })
  const packages = new PackageStore(rig.db, await localJobs(), join(rig.dataDir, 'sheets', 'files'), () => null, Date.now, () => {}, null, (path) => fileKey(rig.ctx, path), {
    root: join(previewScratch(rig.dataDir), 'sheets', 'files'),
    is: (path) => sharedOf(rig.ctx, at(path)) || isSharedImport(rig.dataDir, path)
  })
  s = { ctx: rig.ctx, packages, jobs: await localJobs() } as unknown as Sheets
})
afterEach(() => rig.close())

type Cells = Record<number, Record<number, { v?: unknown; f?: string }>>
const book = (path: string): Record<string, Cells> => {
  const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
  return Object.fromEntries(workbook.sheetOrder.map((id) => [workbook.sheets[id]!.name, (workbook.sheets[id]!.cellData ?? {}) as Cells]))
}
const openIn = (owner: string, path: string): { item: CanvasItem; held: ImportedHeld } => {
  const item = rig.canvas.open(owner, { kind: 'sheet', source: at(path), title: path.split('/').pop()! })
  return { item, held: importedHeld(rig.dataDir, path, sharedOf(rig.ctx, item.source), item.id)! }
}
/** His edit to a cell of the copy's sheet `name`, as the grid sends it. */
async function edit(held: ImportedHeld, name: string, row: number, col: number, v: unknown): Promise<void> {
  const st = await s.packages.open(held.path)
  const sheet = st.inspected.sheets.find((x) => x.name === name)!.id
  expect(await s.packages.edit(held.path, st.rev, [{ id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: sheet, cellValue: { [row]: { [col]: { v } } } } }], 'owner')).toEqual({ rev: st.rev + 1 })
}
/** A file of one of the formats read by LibreOffice afresh, as another program would read it. */
async function reread(path: string, from: string): Promise<Record<string, Cells>> {
  const out = join(mkdtempSync(join(rig.base, 'reread-')), 'out.xlsx')
  await convert({ from, to: 'xlsx', input: path, output: out })
  return book(out)
}

describe.skipIf(!there)('the corpus\'s .xls, .ods and .tsv, opened as a copy and saved back (real LibreOffice)', () => {
  for (const format of ['xls', 'ods'] as const) {
    it(`an .${format} opens as a workbook with its sheets, values and formulas; an edit goes back into the .${format}`, async () => {
      const path = join(rig.folder, `Ledger.${format}`)
      copyFileSync(join(FIXTURES, `ledger.${format}`), path)
      const { item, held } = openIn('t1', path)
      await ensureImported(rig.ctx, held)
      const opened = book(held.path)
      expect(Object.keys(opened)).toEqual(['Data', 'Calc', 'Dynamic', 'Q1', 'Q2', 'Q3'])
      expect(opened.Data![0]![0]!.v).toBe('Amount')
      expect(opened.Data![1]![0]!.v).toBe(1)
      expect(opened.Data![1]![1]!.v).toBe('North')
      expect(opened.Calc![1]![1]!.f).toBe('=SUM(Data!A2:A21)')
      expect(opened.Calc![1]![1]!.v).toBe(990)
      // the grid's own reader takes the copy: the package store opens it
      expect((await s.packages.open(held.path)).inspected.sheets.map((x) => x.name)).toContain('Data')

      await edit(held, 'Data', 1, 0, 4242)
      const before = readdirSync(rig.folder).sort()
      const done = await importAct(s, window, item, held, 'back')
      expect(done.path).toBe(path)
      expect(readdirSync(rig.folder).sort()).toEqual(before)
      // the file is still the format it was
      const head = readFileSync(path).subarray(0, 4)
      if (format === 'xls') expect([...head]).toEqual([0xd0, 0xcf, 0x11, 0xe0])
      else expect(readText(readZip(new Uint8Array(readFileSync(path))), 'mimetype')).toBe('application/vnd.oasis.opendocument.spreadsheet')
      const back = await reread(path, format)
      expect(back.Data![1]![0]!.v).toBe(4242)
      expect(back.Data![2]![0]!.v).toBe(38)
      expect(back.Calc![1]![1]!.f).toBe('=SUM(Data!A2:A21)')
      // LibreOffice worked the sum again with the edit in it
      expect(back.Calc![1]![1]!.v).toBe(990 - 1 + 4242)
    })
  }

  it('a .tsv needs no LibreOffice: the corpus\'s opens with its quoted comma whole and goes back with one field changed', async () => {
    const path = join(rig.folder, 'Ledger.tsv')
    copyFileSync(join(FIXTURES, 'ledger.tsv'), path)
    const was = readFileSync(path, 'utf8')
    const { item, held } = openIn('t1', path)
    await ensureImported(rig.ctx, held)
    const opened = Object.values(book(held.path))[0]!
    expect([opened[0]![0]!.v, opened[1]![1]!.v, opened[1]![2]!.v, opened[2]![0]!.v]).toEqual(['Item', 3, 1.5, 'Pear, green'])
    const name = (await s.packages.open(held.path)).inspected.sheets[0]!.name
    await edit(held, name, 1, 1, 5)
    await importAct(s, window, item, held, 'back')
    expect(readFileSync(path, 'utf8')).toBe(was.replace('Apple\t3\t1.50', 'Apple\t5\t1.50'))
  })

  it('an .ods in a team library: converted here, edited in its tab\'s copy, saved back through Files\' door with nothing written beside it', async () => {
    const dir = join(rig.team, 'General')
    const path = join(dir, 'Ledger.ods')
    copyFileSync(join(FIXTURES, 'ledger.ods'), path)
    const before = readdirSync(dir).sort()
    const { item, held } = openIn(filesPaneOf(WS), path)
    expect(isSharedImport(rig.dataDir, held.path)).toBe(true)
    await ensureImported(rig.ctx, held)
    await edit(held, 'Data', 1, 1, 'Northwest')
    await importAct(s, window, item, held, 'back')
    expect(readdirSync(dir).sort()).toEqual(before)
    expect((await reread(path, 'ods')).Data![1]![1]!.v).toBe('Northwest')
    // nothing of the file among what the app keeps for good (LibreOffice's own profile under work-tools holds its settings, not the file)
    const kept = readdirSync(rig.dataDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).filter((f) => !f.startsWith(previewScratch(rig.dataDir)) && !f.startsWith(join(rig.dataDir, 'work-tools')))
    expect(kept).toEqual([])
  })

  it('Save as Excel from an .xls writes an .xlsx the grid reads, beside the .xls, which stays as it was', async () => {
    const path = join(rig.folder, 'Ledger.xls')
    copyFileSync(join(FIXTURES, 'ledger.xls'), path)
    const was = readFileSync(path)
    const { item, held } = openIn('t1', path)
    await ensureImported(rig.ctx, held)
    await edit(held, 'Data', 1, 0, 7)
    const done = await importAct(s, window, item, held, 'xlsx')
    expect(done.path).toBe(join(rig.folder, 'Ledger.xlsx'))
    expect(book(done.path!).Data![1]![0]!.v).toBe(7)
    expect(readFileSync(path).equals(was)).toBe(true)
  })
})
