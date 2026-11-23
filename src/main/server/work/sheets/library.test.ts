import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { refKey } from '@shared/work/files'
import { doorPlace, openAs } from '../files/handle'
import { fileMakerFor, registerFileMaker } from '../files/hooks'
import { locate } from '../files/policy'
import { libraryKey } from '../files/places/teams'
import { at, HOST, makeRig, window, WS, type Rig } from '../files/testkit'
import { withFileLocks } from '../files/write'
import { fileKey } from './held'
import { SHEET_MAKER } from './index'
import { SET_RANGE_VALUES } from './mutations'
import { ensurePackageTables, PackageStore, PACKAGE_UNIT } from './packages'
import { localJobs } from './workerClient'

/**
 * An .xlsx in a Teams or OneDrive library, in the sheet editor, saved back (the owner's order of
 * 2026-11-23; the split with Files is in SEAMS.md). The sheet kind tells Files it edits an .xlsx
 * in place, so Files seats a library's .xlsx in this kind as the file it is, with no Office app
 * behind it; and every save hands the new bytes to Files' one door for replacing a file where it
 * lies, so nothing of ours is ever written beside the file.
 */
const CORPUS = join(import.meta.dirname, 'harness/corpus')
let rig: Rig
let book: string
let off: () => void
beforeEach(() => {
  rig = makeRig()
  // A dummy workbook in the rig's dummy team library.
  book = join(rig.team, 'General', 'Spring budget.xlsx')
  copyFileSync(join(CORPUS, 'formulas.xlsx'), book)
  off = () => {}
})
afterEach(() => {
  off()
  rig.close()
})

const set = (sheet: string, row: number, col: number, cell: unknown) => ({ id: SET_RANGE_VALUES, params: { unitId: PACKAGE_UNIT, subUnitId: sheet, cellValue: { [row]: { [col]: cell } } } })
const valueAt = (path: string, row: number, col: number): unknown => {
  const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
  return workbook.sheets[workbook.sheetOrder[0]!]?.cellData?.[row]?.[col]?.v
}
async function store(jobs?: Partial<Awaited<ReturnType<typeof localJobs>>>): Promise<PackageStore> {
  ensurePackageTables(rig.db)
  const real = await localJobs()
  return new PackageStore(rig.db, { ...real, ...jobs }, join(rig.dataDir, 'sheets', 'files'), () => null, Date.now, () => {}, null, (path) => fileKey(rig.ctx, path))
}

describe('an .xlsx in a library, seated by Files', () => {
  it('opens in the sheet kind as the file it is once the kind says it edits .xlsx in place; before that, with Excel behind it', () => {
    const where = locate(rig.ctx, window, WS, at(book), 'work.files.open')
    expect(where.in).toBe('library')
    expect(fileMakerFor('sheet', 'xlsx')).toBeNull()
    const before = openAs(rig.ctx, where, 'Spring budget.xlsx')
    expect(before.source.at).toBe('microsoft')
    off = registerFileMaker('sheet', SHEET_MAKER)
    expect(openAs(rig.ctx, where, 'Spring budget.xlsx')).toEqual({ kind: 'sheet', source: { at: 'file', host: HOST, path: book } })
    // a Word file beside it is not ours to seat
    const plan = locate(rig.ctx, window, WS, at(join(rig.team, 'General', 'Plan.docx')), 'work.files.open')
    expect(openAs(rig.ctx, plan, 'Plan.docx').kind).not.toBe('sheet')
  })

  it('a blank one the kind makes is a workbook Excel\'s own way: one empty sheet in Calibri 11', async () => {
    expect(SHEET_MAKER.forms).toEqual(['xlsx'])
    const path = join(rig.dataDir, 'Untitled sheet.xlsx')
    await SHEET_MAKER.blank({ form: 'xlsx', path, title: 'Untitled sheet' })
    const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
    expect(workbook.sheetOrder).toHaveLength(1)
    expect(workbook.sheets[workbook.sheetOrder[0]!]!.name).toBe('Sheet1')
    expect(Object.keys(workbook.sheets[workbook.sheetOrder[0]!]!.cellData ?? {})).toEqual([])
    expect((workbook.custom as { defaults?: unknown }).defaults).toEqual({ family: 'Calibri', size: 11 })
  })
})

describe('a save into a library\'s workbook', () => {
  const folder = (): string[] => readdirSync(join(rig.team, 'General')).sort()

  it('lands in the file through Files\' door and leaves nothing of ours beside it, while it is made or after', async () => {
    const before = folder()
    const during: string[][] = []
    const real = await localJobs()
    const s = await store({
      async save(path, output, edits, dir, formats) {
        // the new package is being made: among this host's own files, never in the library
        expect(output.startsWith(join(rig.dataDir, 'sheets', 'files'))).toBe(true)
        const got = await real.save(path, output, edits, dir, formats)
        during.push(folder())
        return got
      }
    })
    const sheet = (await s.open(book)).inspected.sheets[0]!.id
    chmodSync(book, 0o640)
    expect(await s.edit(book, 0, [set(sheet, 1, 0, { v: 4242 })], 'owner')).toEqual({ rev: 1 })
    expect(valueAt(book, 1, 0)).toBe(4242)
    // a format press is a save too
    expect(await s.edit(book, 1, [set(sheet, 1, 0, { s: { bl: 1 } })], 'owner')).toEqual({ rev: 2 })
    expect(during).toEqual([before, before])
    expect(folder()).toEqual(before)
    expect(folder().some((name) => name.endsWith('.tcsave') || name.endsWith('.tmp'))).toBe(false)
    // the file keeps its own mode
    expect(statSync(book).mode & 0o777).toBe(0o640)
    // its kept copies are this host's own
    expect(readdirSync(join(rig.dataDir, 'sheets', 'files')).length).toBeGreaterThan(0)
  })

  it('never lands over a file that changed while it was made: the edit answers a conflict and the other save stands', async () => {
    const real = await localJobs()
    const other = readFileSync(join(CORPUS, 'formats.xlsx'))
    const s = await store({
      async save(path, output, edits, dir, formats) {
        const got = await real.save(path, output, edits, dir, formats)
        // a co-author's save syncs down while ours is made
        writeFileSync(book, other)
        utimesSync(book, new Date(), new Date(Date.now() + 9_000))
        return got
      }
    })
    const sheet = (await s.open(book)).inspected.sheets[0]!.id
    expect(await s.edit(book, 0, [set(sheet, 1, 0, { v: 1 })], 'owner')).toEqual({ conflict: true, rev: 1 })
    expect(readFileSync(book).equals(other)).toBe(true)
    expect(s.history(book)[0]).toMatchObject({ rev: 1, by: 'file' })
  })

  it('locks the file under the key Files itself takes for it: a library\'s file by its place, any other by its path', async () => {
    const where = locate(rig.ctx, window, WS, at(book), 'work.files.write')
    const files = libraryKey(doorPlace(rig.ctx, window, where).library!, book)
    expect(files.startsWith('lib:')).toBe(true)
    expect(await fileKey(rig.ctx, book)).toBe(files)
    const own = join(rig.folder, 'Budget.xlsx')
    expect(await fileKey(rig.ctx, own)).toBe(refKey({ at: 'file', host: HOST, path: own }))
  })

  it('takes its turn with a change Files is making to the same library file', async () => {
    const s = await store()
    const sheet = (await s.open(book)).inspected.sheets[0]!.id
    const order: string[] = []
    let release!: () => void
    // Files holds the file's lock, by the key its own save takes
    const files = libraryKey(doorPlace(rig.ctx, window, locate(rig.ctx, window, WS, at(book), 'work.files.write')).library!, book)
    const held = withFileLocks([files], () => new Promise<void>((done) => (release = () => (order.push('files'), done()))))
    const saving = s.edit(book, 0, [set(sheet, 1, 0, { v: 7 })], 'owner').then((got) => (order.push('sheet'), got))
    await new Promise((r) => setTimeout(r, 400))
    expect(order).toEqual([])
    expect(valueAt(book, 1, 0)).not.toBe(7)
    release()
    await held
    expect(await saving).toEqual({ rev: 1 })
    expect(order).toEqual(['files', 'sheet'])
  })

  it('keeps its copy of a revision before the file takes it, so a save that landed is never told as one that failed', async () => {
    const s = await store()
    const sheet = (await s.open(book)).inspected.sheets[0]!.id
    const copies = join(rig.dataDir, 'sheets', 'files')
    const dir = join(copies, readdirSync(copies).find((name) => name !== 'work')!)
    // the app's own folder cannot be written: the copy fails first, and the workbook is left as it was
    chmodSync(dir, 0o500)
    const before = readFileSync(book)
    try {
      await expect(s.edit(book, 0, [set(sheet, 1, 0, { v: 5 })], 'owner')).rejects.toThrow('The file was not saved: TempCode could not keep this version among its own files')
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(readFileSync(book).equals(before)).toBe(true)
    // nothing was recorded as someone else's change: the next edit lands on revision 0
    expect(await s.edit(book, 0, [set(sheet, 1, 0, { v: 5 })], 'owner')).toEqual({ rev: 1 })
    expect(s.history(book).map((h) => [h.rev, h.by])).toEqual([[1, 'owner'], [0, 'file']])
    expect(readFileSync(join(dir, '1.xlsx')).equals(readFileSync(book))).toBe(true)
  })

  it('a file moved away while the save is made answers a conflict, and nothing is made under its old name', async () => {
    const real = await localJobs()
    const moved = join(rig.team, 'General', 'Budgets', 'Spring budget.xlsx')
    const s = await store({
      async save(path, output, edits, dir, formats) {
        const got = await real.save(path, output, edits, dir, formats)
        renameSync(book, moved)
        return got
      }
    })
    const sheet = (await s.open(book)).inspected.sheets[0]!.id
    expect(await s.edit(book, 0, [set(sheet, 1, 0, { v: 1 })], 'owner')).toEqual({ conflict: true, rev: 0 })
    expect(folder()).not.toContain('Spring budget.xlsx')
    expect(readFileSync(moved).equals(readFileSync(join(CORPUS, 'formulas.xlsx')))).toBe(true)
    // and the next edit of the file that is gone is refused in words
    await expect(s.edit(book, 0, [set(sheet, 1, 0, { v: 2 })], 'owner')).rejects.toThrow('This file is not where it was: it was moved or deleted.')
    expect(folder()).not.toContain('Spring budget.xlsx')
  })

  it('says a folder that cannot be written in plain words, with no path of the door\'s own', async () => {
    const s = await store()
    const sheet = (await s.open(book)).inspected.sheets[0]!.id
    const general = join(rig.team, 'General')
    chmodSync(general, 0o500)
    try {
      await expect(s.edit(book, 0, [set(sheet, 1, 0, { v: 1 })], 'owner')).rejects.toThrow(/^The file was not saved: this folder is read only$/)
    } finally {
      chmodSync(general, 0o700)
    }
    expect(folder().some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('a restore goes through the same door', async () => {
    mkdirSync(join(rig.dataDir, 'sheets', 'files'), { recursive: true })
    const s = await store()
    const sheet = (await s.open(book)).inspected.sheets[0]!.id
    const was = valueAt(book, 1, 0)
    await s.edit(book, 0, [set(sheet, 1, 0, { v: 99 })], 'owner')
    const before = folder()
    expect(await s.restore(book, 0, 'owner')).toEqual({ rev: 2 })
    expect(valueAt(book, 1, 0)).toBe(was)
    expect(folder()).toEqual(before)
  })
})
