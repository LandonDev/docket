import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { filesPaneOf, type CanvasItem } from '@shared/work'
import { sheetImportFormat } from '@shared/work/sheetFormats'
import type { ConvertJob, ConvertResult } from '../formats/jobs'
import { NEEDS_APPROVE, sharedOf } from '../files/policy'
import { previewScratch } from '../files/preview'
import { approver, at, makeRig, peer, phone, thread, window, WS, type Rig } from '../files/testkit'
import {
  dropSharedImports,
  ensureImported,
  holdsMacros,
  importAct,
  importedHeld,
  importedOf,
  importFormatOf,
  importMoved,
  IMPORT_HIS_PRESS,
  isImportCopy,
  isSharedImport,
  NO_FOLDER,
  NOT_A_COPY,
  ownImports,
  sharedImports,
  type ImportedHeld
} from './formatsIn'
import { fileKey, type Sheets } from './held'
import { SET_RANGE_VALUES } from './mutations'
import { ensurePackageTables, PackageStore, PACKAGE_UNIT } from './packages'
import { writeZip } from './patch/zip'
import { localJobs } from './workerClient'

/**
 * An .xls, an .ods and a .tsv opened as an Excel copy (SHT8), on dummy files in a dummy team
 * library and a dummy workspace folder. The converter here is a stand-in that hands back a real
 * workbook and marks what it was asked; the same paths behind the real LibreOffice are in
 * formatsIn.live.test.ts.
 */
const CORPUS = join(import.meta.dirname, 'harness/corpus')
let rig: Rig
let s: Sheets
let jobs: ConvertJob[]

/** Reads any of the formats "into" a workbook, and writes one "out" as its own bytes behind the format's name. */
async function convert(job: ConvertJob): Promise<ConvertResult> {
  jobs.push(job)
  if (job.to === 'xlsx') copyFileSync(join(CORPUS, 'formulas.xlsx'), job.output!)
  else writeFileSync(job.output!, Buffer.concat([Buffer.from(`${job.to}:`), readFileSync(job.input)]))
  return { output: job.output!, ranOn: 'env_box', warnings: [] }
}

beforeEach(async () => {
  rig = makeRig()
  jobs = []
  ensurePackageTables(rig.db)
  Object.assign(rig.ctx, { convert })
  const packages = new PackageStore(rig.db, await localJobs(), join(rig.dataDir, 'sheets', 'files'), () => null, Date.now, () => {}, null, (path) => fileKey(rig.ctx, path), {
    root: join(previewScratch(rig.dataDir), 'sheets', 'files'),
    is: (path) => sharedOf(rig.ctx, at(path)) || isSharedImport(rig.dataDir, path)
  })
  s = { ctx: rig.ctx, packages, jobs: await localJobs() } as unknown as Sheets
})
afterEach(() => rig.close())

const general = (): string => join(rig.team, 'General')
const folder = (dir: string): string[] => readdirSync(dir).sort()
const filesUnder = (root: string): string[] => (existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : [])
const dummy = (path: string, bytes = 'an old workbook'): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return path
}
const openIn = (owner: string, path: string): CanvasItem => rig.canvas.open(owner, { kind: 'sheet', source: at(path), title: path.split('/').pop()! })
const heldOf = (item: CanvasItem): ImportedHeld => {
  const path = (item.source as { path: string }).path
  return importedHeld(rig.dataDir, path, sharedOf(rig.ctx, item.source), item.id)!
}
const set = (sheet: string, row: number, col: number, cell: unknown) => ({ id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: sheet, cellValue: { [row]: { [col]: cell } } } })
/** His edit in the copy, as the grid sends it: saved into the copy by the package store. */
async function edit(held: ImportedHeld, value: unknown): Promise<void> {
  const st = await s.packages.open(held.path)
  expect(await s.packages.edit(held.path, st.rev, [set(st.inspected.sheets[0]!.id, 1, 0, { v: value })], 'owner')).toEqual({ rev: st.rev + 1 })
}
const valueIn = (bytes: Uint8Array): unknown => {
  const { workbook } = importXlsx(bytes)
  return workbook.sheets[workbook.sheetOrder[0]!]?.cellData?.[1]?.[0]?.v
}
/** What a save back wrote, behind the stand-in's mark: the copy as it was written out by the pair that recalculates. */
const written = (path: string, format: string): Uint8Array => {
  const mark = `${format}+calc:`
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, mark.length).toString()).toBe(mark)
  return new Uint8Array(bytes.subarray(mark.length))
}
const zipOf = (files: Record<string, string>): Uint8Array =>
  writeZip({ entries: [], byName: new Map(), comment: new Uint8Array() } as never, new Map(), new Set(), new Map(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)])))
const later = (path: string, ms = 5000): void => utimesSync(path, new Date(), new Date(Date.now() + ms))

describe('which files open as a copy, and where the copy lies', () => {
  it('an .xls, an .ods and a .tsv do, by their ending in any case; an .xlsx and a .csv do not', () => {
    expect(['a.xls', 'b.ODS', 'c.Tsv', 'd.xlsx', 'e.csv', 'f.xlsb', 'xls'].map((name) => importFormatOf(`/x/${name}`))).toEqual(['xls', 'ods', 'tsv', undefined, undefined, undefined, undefined])
    expect(sheetImportFormat('Old ledger.XLS')).toBe('xls')
    expect(importedHeld(rig.dataDir, '/x/d.xlsx', false)).toBeNull()
  })

  it('his own file\'s copy is among the app\'s files, one folder a path, whoever asks', () => {
    const path = join(rig.folder, 'Ledger.xls')
    const held = importedHeld(rig.dataDir, path, false)!
    expect(held).toMatchObject({ at: 'package', from: { path, format: 'xls' } })
    expect(held.path.startsWith(ownImports(rig.dataDir))).toBe(true)
    expect(importedHeld(rig.dataDir, path, false, 'item1')!.path).toBe(held.path)
    expect(importedHeld(rig.dataDir, join(rig.folder, 'Other.xls'), false)!.path).not.toBe(held.path)
    expect(isImportCopy(rig.dataDir, held.path)).toBe(true)
    expect(isSharedImport(rig.dataDir, held.path)).toBe(false)
  })

  it('a copy of a file others can open is under Files\' preview scratch, one folder a tab, and needs its tab', () => {
    const path = join(general(), 'Ledger.ods')
    const a = importedHeld(rig.dataDir, path, true, 'item1')!
    const b = importedHeld(rig.dataDir, path, true, 'item2')!
    expect(a.path.startsWith(join(previewScratch(rig.dataDir), 'sheets', 'imports', 'item1'))).toBe(true)
    expect(b.path).not.toBe(a.path)
    expect(isSharedImport(rig.dataDir, a.path)).toBe(true)
    expect(() => importedHeld(rig.dataDir, path, true)).toThrow('Ledger.ods is in a folder others can open, so its copy lasts only as long as its tab')
    expect(() => importedHeld(rig.dataDir, path, true, '../up')).toThrow('lasts only as long as its tab')
  })
})

describe('the copy is made once, and again only when it holds nothing of his', () => {
  it('converts the file into an .xlsx the first time, and not again while the file stands', async () => {
    const path = dummy(join(rig.folder, 'Ledger.xls'))
    const held = importedHeld(rig.dataDir, path, false)!
    await ensureImported(rig.ctx, held)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ from: 'xls', to: 'xlsx', input: path })
    expect(jobs[0]!.shared).toBeUndefined()
    expect(valueIn(new Uint8Array(readFileSync(held.path)))).toBeDefined()
    await ensureImported(rig.ctx, held)
    await ensureImported(rig.ctx, held)
    expect(jobs).toHaveLength(1)
    expect(importedOf(held)).toEqual({ format: 'xls', name: 'Ledger.xls' })
    // nothing beside his file
    expect(folder(rig.folder)).not.toContain('Ledger.xlsx')
  })

  it('two asks at once make one copy', async () => {
    const held = importedHeld(rig.dataDir, dummy(join(rig.folder, 'Ledger.ods')), false)!
    await Promise.all([ensureImported(rig.ctx, held), ensureImported(rig.ctx, held), ensureImported(rig.ctx, held)])
    expect(jobs).toHaveLength(1)
  })

  it('a file touched or synced again with the same bytes is the same file; one that changed is read again', async () => {
    const path = dummy(join(rig.folder, 'Ledger.xls'))
    const held = importedHeld(rig.dataDir, path, false)!
    await ensureImported(rig.ctx, held)
    later(path)
    await ensureImported(rig.ctx, held)
    expect(jobs).toHaveLength(1)
    expect(importedOf(held)!.stale).toBeUndefined()
    writeFileSync(path, 'a newer workbook from Excel')
    later(path, 9000)
    await ensureImported(rig.ctx, held)
    expect(jobs).toHaveLength(2)
    expect(importedOf(held)!.stale).toBeUndefined()
  })

  it('a copy he edited is never made again under him: it is kept, and says the file changed', async () => {
    const path = dummy(join(rig.folder, 'Ledger.xls'))
    const held = importedHeld(rig.dataDir, path, false)!
    await ensureImported(rig.ctx, held)
    await edit(held, 'his edit')
    writeFileSync(path, 'a newer workbook from Excel')
    later(path)
    await ensureImported(rig.ctx, held)
    await ensureImported(rig.ctx, held)
    expect(jobs).toHaveLength(1)
    expect(valueIn(new Uint8Array(readFileSync(held.path)))).toBe('his edit')
    expect(importedOf(held)).toEqual({ format: 'xls', name: 'Ledger.xls', stale: true })
  })

  it('a file that is gone still shows the copy made of it; with no copy it is said', async () => {
    const path = dummy(join(rig.folder, 'Ledger.xls'))
    const held = importedHeld(rig.dataDir, path, false)!
    await ensureImported(rig.ctx, held)
    renameSync(path, join(rig.folder, 'elsewhere.bin'))
    await ensureImported(rig.ctx, held)
    expect(existsSync(held.path)).toBe(true)
    await expect(ensureImported(rig.ctx, importedHeld(rig.dataDir, join(rig.folder, 'Never.xls'), false)!)).rejects.toThrow('There is no file at')
  })

  it('what the converter hands back must be a workbook', async () => {
    Object.assign(rig.ctx, { convert: async (job: ConvertJob) => (writeFileSync(job.output!, 'not a zip'), { output: job.output!, ranOn: 'env_box', warnings: [] }) })
    const held = importedHeld(rig.dataDir, dummy(join(rig.folder, 'Broken.xls')), false)!
    await expect(ensureImported(rig.ctx, held)).rejects.toThrow('Broken.xls could not be read as a workbook.')
    expect(filesUnder(ownImports(rig.dataDir))).toEqual([])
  })

  it('anything that is not a copy is left alone', async () => {
    await ensureImported(rig.ctx, { at: 'package', path: join(rig.folder, 'Budget.xlsx') })
    await ensureImported(rig.ctx, { at: 'service' })
    expect(jobs).toEqual([])
    expect(importedOf({ at: 'package', path: join(rig.folder, 'Budget.xlsx') })).toBeUndefined()
  })
})

describe('a file others can open, as a copy', () => {
  it('is converted on this host alone, into its tab\'s folder; nothing lands beside it or among what the app keeps', async () => {
    const path = dummy(join(general(), 'Ledger.ods'))
    const item = openIn(filesPaneOf(WS), path)
    expect(sharedOf(rig.ctx, item.source)).toBe(true)
    const before = folder(general())
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    expect(jobs[0]).toMatchObject({ from: 'ods', to: 'xlsx', shared: true })
    expect(folder(general())).toEqual(before)
    expect(filesUnder(ownImports(rig.dataDir))).toEqual([])
    expect(filesUnder(join(sharedImports(rig.dataDir), item.id)).length).toBeGreaterThan(0)
    // every file made of it is under Files' preview scratch
    await edit(held, 'in the tab')
    await s.packages.idle()
    const made = filesUnder(rig.dataDir).filter((f) => !f.startsWith(previewScratch(rig.dataDir)))
    expect(made).toEqual([])
    expect(folder(general())).toEqual(before)
  })

  it('goes with its tab: the copy and its folder are removed', async () => {
    const item = openIn(filesPaneOf(WS), dummy(join(general(), 'Ledger.xls')))
    await ensureImported(rig.ctx, heldOf(item))
    dropSharedImports(rig.dataDir, item.id)
    expect(existsSync(join(sharedImports(rig.dataDir), item.id))).toBe(false)
    dropSharedImports(rig.dataDir, '../imports')
    expect(existsSync(sharedImports(rig.dataDir))).toBe(true)
  })

  it('a copy made among the app\'s files before the file counted as shared is not left there', async () => {
    const path = dummy(join(general(), 'Ledger.xls'))
    const own = importedHeld(rig.dataDir, path, false)!
    await ensureImported(rig.ctx, own)
    expect(existsSync(own.path)).toBe(true)
    await ensureImported(rig.ctx, importedHeld(rig.dataDir, path, true, 'item1')!)
    expect(existsSync(dirname(own.path))).toBe(false)
  })
})

describe('Save back: the copy written as the format it was', () => {
  it('his own file takes the copy with his edit, through Files\' door: its mode kept, nothing beside it', async () => {
    const path = dummy(join(rig.folder, 'Ledger.xls'))
    chmodSync(path, 0o640)
    const item = openIn('t1', path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    await edit(held, 'saved back')
    const before = folder(rig.folder)
    const done = await importAct(s, window, item, held, 'back')
    expect(done.path).toBe(path)
    // written by the pair that works every formula out again before it stores (formatsInBack.ts)
    expect(jobs[1]).toMatchObject({ from: 'xlsx', to: 'xls+calc', input: held.path })
    expect(valueIn(written(path, 'xls'))).toBe('saved back')
    expect(folder(rig.folder)).toEqual(before)
    expect(statSync(path).mode & 0o777).toBe(0o640)
    // the scratch the file was made in is gone
    expect(dirname(jobs[1]!.output!).startsWith(tmpdir())).toBe(true)
    expect(existsSync(dirname(jobs[1]!.output!))).toBe(false)
    // the copy and the file agree again: the file's own change is not taken for someone else's
    await ensureImported(rig.ctx, held)
    expect(jobs).toHaveLength(2)
    expect(importedOf(held)!.stale).toBeUndefined()
  })

  it('says what this workbook lost to the format, counted from the copy', async () => {
    Object.assign(rig.ctx, { convert: async (job: ConvertJob) => (job.to === 'xlsx' ? copyFileSync(join(CORPUS, 'tables.xlsx'), job.output!) : writeFileSync(job.output!, 'xls'), { output: job.output!, ranOn: 'env_box', warnings: [] }) })
    const item = openIn('t1', dummy(join(rig.folder, 'Tables.xls')))
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    const done = await importAct(s, window, item, held, 'back')
    expect(done.drops?.some((line) => /becomes? (a )?plain ranges?/.test(line))).toBe(true)
  })

  it('a file others can open takes it the same way, converted here alone, with nothing written beside it', async () => {
    const path = dummy(join(general(), 'Ledger.ods'))
    const item = openIn(filesPaneOf(WS), path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    await edit(held, 'for the team')
    const before = folder(general())
    await importAct(s, window, item, held, 'back')
    expect(jobs[1]).toMatchObject({ from: 'xlsx', to: 'ods+calc', shared: true })
    expect(valueIn(written(path, 'ods'))).toBe('for the team')
    expect(folder(general())).toEqual(before)
  })

  it('never over a file that changed since the copy was made: refused in words, the file as its other writer left it', async () => {
    const path = dummy(join(general(), 'Ledger.xls'))
    const item = openIn(filesPaneOf(WS), path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    await edit(held, 'mine')
    writeFileSync(path, 'a co-author saved this')
    later(path)
    await expect(importAct(s, window, item, held, 'back')).rejects.toThrow('Ledger.xls changed since this copy was made. Save as Excel to keep your edits.')
    expect(readFileSync(path, 'utf8')).toBe('a co-author saved this')
    // his edit is still in the copy
    expect(valueIn(new Uint8Array(readFileSync(held.path)))).toBe('mine')
  })

  it('a file that is gone is not made again under its old name', async () => {
    const path = dummy(join(rig.folder, 'Ledger.xls'))
    const item = openIn('t1', path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    renameSync(path, join(rig.folder, 'moved.bin'))
    await expect(importAct(s, window, item, held, 'back')).rejects.toThrow('Ledger.xls is no longer where it was. Save as Excel to keep your edits.')
    expect(existsSync(path)).toBe(false)
  })

  it('a file with macros is never written back: the copy keeps none, so the file stays as it is', async () => {
    const vba = Buffer.concat([Buffer.alloc((1 << 20) - 7, 0x20), Buffer.from('_VBA_PROJECT', 'utf16le'), Buffer.from(' tail')])
    const path = join(rig.folder, 'Macros.xls')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, vba)
    const item = openIn('t1', path)
    const held = heldOf(item)
    // (the name lies across two reads of the file)
    expect(holdsMacros(held.from)).toBe(true)
    await ensureImported(rig.ctx, held)
    expect(importedOf(held)).toEqual({ format: 'xls', name: 'Macros.xls', noBack: 'This file holds macros, which an Excel copy does not keep' })
    await expect(importAct(s, window, item, held, 'back')).rejects.toThrow('This file holds macros, which an Excel copy does not keep. Save as Excel instead.')
    expect(readFileSync(path).equals(vba)).toBe(true)
    // an OpenDocument's macros are folders of its zip; a plain one has none
    const ods = join(rig.folder, 'Basic.ods')
    writeFileSync(ods, zipOf({ 'content.xml': '<x/>', 'Basic/Standard/Module1.xml': '<m/>' }))
    expect(holdsMacros({ path: ods, format: 'ods' })).toBe(true)
    const plain = join(rig.folder, 'Plain.ods')
    writeFileSync(plain, zipOf({ 'content.xml': '<x/>' }))
    expect(holdsMacros({ path: plain, format: 'ods' })).toBe(false)
    expect(holdsMacros({ path: dummy(join(rig.folder, 'Plain.xls')), format: 'xls' })).toBe(false)
  })
})

describe('a .tsv, read and written here with no converter', () => {
  const TEXT = 'Item\tQty\tPrice\r\nApple\t3\t1.50\r\n"Pear, green"\t007\t0.75\r\n"said ""hi"""\t\t2\r\n'
  type Cells = Record<number, Record<number, { v?: unknown }>>
  const cellsOf = (path: string): { name: string; cells: Cells } => {
    const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
    const sheet = workbook.sheets[workbook.sheetOrder[0]!]!
    return { name: sheet.name!, cells: (sheet.cellData ?? {}) as Cells }
  }
  const type = async (held: ImportedHeld, row: number, col: number, v: unknown): Promise<void> => {
    const st = await s.packages.open(held.path)
    expect(await s.packages.edit(held.path, st.rev, [set(st.inspected.sheets[0]!.id, row, col, { v })], 'owner')).toEqual({ rev: st.rev + 1 })
  }

  it('opens as one sheet named for the file: tabs split it, a quoted field is one field, numbers are numbers and 007 stays text', async () => {
    const path = dummy(join(rig.folder, 'Scores 2025.tsv'), TEXT)
    const held = importedHeld(rig.dataDir, path, false)!
    await ensureImported(rig.ctx, held)
    expect(jobs).toEqual([])
    const { name, cells } = cellsOf(held.path)
    expect(name).toBe('Scores 2025')
    expect([cells[0]![0]!.v, cells[1]![1]!.v, cells[1]![2]!.v, cells[2]![0]!.v, cells[2]![1]!.v, cells[3]![0]!.v]).toEqual(['Item', 3, 1.5, 'Pear, green', '007', 'said "hi"'])
    // the package store reads it as any workbook
    expect((await s.packages.open(held.path)).inspected.sheets).toHaveLength(1)
  })

  it('goes back as a patch of the file: the one field he changed, every other byte as it was', async () => {
    const path = dummy(join(rig.folder, 'Scores.tsv'), TEXT)
    const item = openIn('t1', path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    await type(held, 1, 1, 5)
    const done = await importAct(s, window, item, held, 'back')
    expect(done.path).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe(TEXT.replace('Apple\t3', 'Apple\t5'))
    expect(jobs).toEqual([])
    // a typed value with a tab or a quote in it is quoted; a comma needs none in a .tsv
    await type(held, 4, 0, 'a, b')
    await type(held, 4, 1, 'tab\there')
    await importAct(s, window, item, held, 'back')
    expect(readFileSync(path, 'utf8')).toBe(`${TEXT.replace('Apple\t3', 'Apple\t5')}a, b\t"tab\there"\r\n`)
  })

  it('an untouched copy goes back as the very same bytes; a file that changed since is never written over', async () => {
    const path = dummy(join(rig.folder, 'Scores.tsv'), TEXT)
    const item = openIn('t1', path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    await importAct(s, window, item, held, 'back')
    expect(readFileSync(path, 'utf8')).toBe(TEXT)
    await type(held, 1, 1, 9)
    writeFileSync(path, 'Item\tQty\nTheirs\t1\n')
    later(path)
    await expect(importAct(s, window, item, held, 'back')).rejects.toThrow('Scores.tsv changed since this copy was made. Save as Excel to keep your edits.')
    expect(readFileSync(path, 'utf8')).toBe('Item\tQty\nTheirs\t1\n')
  })

  it('a file that is not UTF-8 text is not opened as if it were', async () => {
    const path = join(rig.folder, 'Latin.tsv')
    writeFileSync(path, Buffer.from([0x6e, 0x61, 0xef, 0x76, 0x65, 0x09, 0x31, 0x0a]))
    await expect(ensureImported(rig.ctx, importedHeld(rig.dataDir, path, false)!)).rejects.toThrow('Latin.tsv is not UTF-8 text, so it cannot be opened as a sheet here.')
    expect(filesUnder(ownImports(rig.dataDir))).toEqual([])
  })
})

describe('Save as Excel: the copy written out as an .xlsx he can see', () => {
  it('beside his own file, never over one that is there, and opened beside the copy in a thread', async () => {
    const path = dummy(join(rig.folder, 'Events', 'Ledger.xls'))
    writeFileSync(join(rig.folder, 'Events', 'Ledger.xlsx'), 'already here')
    const item = openIn('t1', path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    await edit(held, 'kept')
    const done = await importAct(s, window, item, held, 'xlsx')
    expect(done.path).toBe(join(rig.folder, 'Events', 'Ledger 2.xlsx'))
    expect(readFileSync(join(rig.folder, 'Events', 'Ledger.xlsx'), 'utf8')).toBe('already here')
    expect(valueIn(new Uint8Array(readFileSync(done.path!)))).toBe('kept')
    const next = rig.canvas.get(done.itemId!)!
    expect(next).toMatchObject({ sessionId: 't1', kind: 'sheet', source: { at: 'file', path: done.path }, title: 'Ledger 2.xlsx' })
    // the first file is untouched, and its copy still stands for the thread's other item
    expect(readFileSync(path, 'utf8')).toBe('an old workbook')
    expect(existsSync(held.path)).toBe(true)
  })

  it('in a Files tab the tab becomes the .xlsx, and the copy goes', async () => {
    const path = dummy(join(rig.folder, 'Ledger.ods'))
    const item = openIn(filesPaneOf(WS), path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    const done = await importAct(s, window, item, held, 'xlsx')
    expect(done.path).toBe(join(rig.folder, 'Ledger.xlsx'))
    expect(rig.canvas.list(filesPaneOf(WS)).filter((i) => i.state === 'open').map((i) => i.title)).toContain('Ledger.xlsx')
    expect(existsSync(dirname(held.path))).toBe(false)
  })

  it('of a file others can open: in his workspace\'s own folder, never beside the file; its tab\'s copy goes', async () => {
    const path = dummy(join(general(), 'Ledger.xls'))
    const item = openIn(filesPaneOf(WS), path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    // (the view says who holds a shared workbook's copies: this tab)
    await s.packages.open(held.path)
    s.packages.hold(held.path, item.id, item.sessionId)
    await edit(held, 'taken out')
    const before = folder(general())
    const done = await importAct(s, window, item, held, 'xlsx')
    expect(done.path).toBe(join(rig.folder, 'Ledger.xlsx'))
    expect(valueIn(new Uint8Array(readFileSync(done.path!)))).toBe('taken out')
    expect(folder(general())).toEqual(before)
    await s.packages.idle()
    expect(filesUnder(join(sharedImports(rig.dataDir), item.id))).toEqual([])
    expect(filesUnder(join(previewScratch(rig.dataDir), 'sheets', 'files'))).toEqual([])
  })

  it('with no folder of his own to write into, it is refused in words and nothing is written', async () => {
    const path = dummy(join(general(), 'Ledger.xls'))
    const item = openIn('chat', path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    const before = folder(general())
    await expect(importAct(s, window, item, held, 'xlsx')).rejects.toThrow(NO_FOLDER)
    expect(folder(general())).toEqual(before)
  })
})

describe('Read again, and who may press', () => {
  it('Read again drops the copy\'s edits and reads the file as it is now', async () => {
    const path = dummy(join(rig.folder, 'Ledger.xls'))
    const item = openIn('t1', path)
    const held = heldOf(item)
    await ensureImported(rig.ctx, held)
    await edit(held, 'dropped')
    writeFileSync(path, 'a newer workbook from Excel')
    later(path)
    await ensureImported(rig.ctx, held)
    expect(importedOf(held)!.stale).toBe(true)
    expect(await importAct(s, window, item, held, 'again')).toEqual({})
    expect(jobs).toHaveLength(2)
    expect(valueIn(new Uint8Array(readFileSync(held.path)))).not.toBe('dropped')
    expect(importedOf(held)!.stale).toBeUndefined()
    // the grids load the copy again: the package store sees a file changed outside it
    expect((await s.packages.open(held.path)).rev).toBe(2)
  })

  it('only his own press: never a thread, never another host of his; a remote key changes a shared file only with approve', async () => {
    const own = openIn('t1', dummy(join(rig.folder, 'Ledger.xls')))
    const shared = openIn(filesPaneOf(WS), dummy(join(general(), 'Ledger.xls')))
    await ensureImported(rig.ctx, heldOf(own))
    await ensureImported(rig.ctx, heldOf(shared))
    for (const act of ['back', 'xlsx', 'again'] as const) {
      await expect(importAct(s, thread(), own, heldOf(own), act)).rejects.toThrow(IMPORT_HIS_PRESS)
      await expect(importAct(s, peer, own, heldOf(own), act)).rejects.toThrow(IMPORT_HIS_PRESS)
      await expect(importAct(s, phone, shared, heldOf(shared), act)).rejects.toThrow(NEEDS_APPROVE)
    }
    expect(jobs).toHaveLength(2)
    expect((await importAct(s, phone, own, heldOf(own), 'back')).path).toBe(join(rig.folder, 'Ledger.xls'))
    expect((await importAct(s, approver, shared, heldOf(shared), 'back')).path).toBe(join(general(), 'Ledger.xls'))
  })

  it('a sheet that is no copy has nothing to save back', async () => {
    const item = openIn('t1', join(rig.folder, 'Budget.xlsx'))
    await expect(importAct(s, window, item, { at: 'package', path: join(rig.folder, 'Budget.xlsx') }, 'back')).rejects.toThrow(NOT_A_COPY)
  })
})

describe('his own file renamed or moved', () => {
  it('its copy follows it with his edits, and answers where the package store\'s rows go', async () => {
    const a = dummy(join(rig.folder, 'Ledger.xls'))
    const b = join(rig.folder, 'Events', 'Ledger 2025.xls')
    const held = importedHeld(rig.dataDir, a, false)!
    await ensureImported(rig.ctx, held)
    await edit(held, 'carried')
    await s.packages.idle()
    renameSync(a, b)
    const moved = importMoved(rig.dataDir, a, b)
    const now = importedHeld(rig.dataDir, b, false)!
    expect(moved).toEqual({ from: held.path, to: now.path })
    expect(existsSync(held.path)).toBe(false)
    expect(valueIn(new Uint8Array(readFileSync(now.path)))).toBe('carried')
    // the same file under its new name: not converted again, and it still saves back
    await ensureImported(rig.ctx, now)
    expect(jobs).toHaveLength(1)
    expect(importedOf(now)).toEqual({ format: 'xls', name: 'Ledger 2025.xls' })
  })

  it('a file with no copy, or renamed to another kind, carries nothing', async () => {
    expect(importMoved(rig.dataDir, join(rig.folder, 'None.xls'), join(rig.folder, 'Other.xls'))).toBeNull()
    expect(importMoved(rig.dataDir, join(rig.folder, 'Budget.xlsx'), join(rig.folder, 'B.xlsx'))).toBeNull()
    const a = dummy(join(rig.folder, 'Ledger.xls'))
    const held = importedHeld(rig.dataDir, a, false)!
    await ensureImported(rig.ctx, held)
    expect(importMoved(rig.dataDir, a, join(rig.folder, 'Ledger.bak'))).toBeNull()
    expect(existsSync(dirname(held.path))).toBe(false)
  })
})
