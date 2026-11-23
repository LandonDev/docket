import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { refKey } from '@shared/work/files'
import { doorPlace, openAs } from '../files/handle'
import { fileMakerFor, registerFileMaker } from '../files/hooks'
import { locate, sharedOf } from '../files/policy'
import { previewScratch } from '../files/preview'
import { libraryKey } from '../files/places/teams'
import { at, HOST, makeRig, window, WS, type Rig } from '../files/testkit'
import { withFileLocks } from '../files/write'
import { fileKey, sharedCopies } from './held'
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

/**
 * A workbook others can open keeps nothing here past its tab or thread, and nothing of it reaches a
 * backup (the editors plan, "University files"): its copies lie under Files' own scratch, which both
 * backups leave out and Files clears at each start; its edits are logged without what was typed;
 * and when its last holder goes, so do the copies.
 */
describe('what is kept of a library\'s workbook', () => {
  const everyFile = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : [])
  const own = () => join(rig.dataDir, 'sheets', 'files')
  const scratch = () => sharedCopies(rig.dataDir)
  async function sharedStore(): Promise<PackageStore> {
    ensurePackageTables(rig.db)
    return new PackageStore(rig.db, await localJobs(), own(), () => null, Date.now, () => {}, null, (path) => fileKey(rig.ctx, path), { root: scratch(), is: (path) => sharedOf(rig.ctx, { at: 'file', host: HOST, path }) })
  }
  const ops = (path: string) => rig.db.prepare('SELECT rev, label, mutations, undo FROM work_sheets_ops WHERE path = ? ORDER BY rev').all(path) as { rev: number; label: string; mutations: string; undo: string | null }[]

  it('the copies lie under Files\' own scratch, which the backups leave out', () => {
    expect(scratch().startsWith(join(previewScratch(rig.dataDir), 'sheets'))).toBe(true)
  })

  it('a library\'s workbook: copies in the scratch alone, a log with no word of what was typed', async () => {
    const s = await sharedStore()
    const { inspected } = await s.open(book)
    expect(s.isShared(book)).toBe(true)
    const sheet = inspected.sheets[0]!.id
    expect(await s.edit(book, 0, [set(sheet, 30, 0, { v: 'Q4-forecast-7731' })], 'owner')).toEqual({ rev: 1 })
    await s.writeCells(book, [{ at: 'A32', v: 'agent-wrote-4410' }], 'agent:local:t1', 'A32', 'w1')
    expect(valueAt(book, 30, 0)).toBe('Q4-forecast-7731')
    // nothing among the app's own kept files; the copies are the scratch's
    expect(everyFile(own())).toEqual([])
    expect(everyFile(scratch()).map((f) => f.slice(scratch().length + 1).replace(/^[0-9a-f]+\//, '')).sort()).toEqual(['0.xlsx', '1.xlsx', '2.xlsx'])
    // the log says a revision and its label, never the cells
    expect(ops(book).map((o) => [o.rev, o.label, o.mutations, o.undo])).toEqual([
      [1, 'A31', '"unkept"', null],
      [2, 'A32', '"unkept"', null]
    ])
    const dump = JSON.stringify(rig.db.prepare('SELECT * FROM work_sheets_ops').all()) + JSON.stringify(rig.db.prepare('SELECT * FROM work_sheets_files').all())
    expect(dump).not.toContain('Q4-forecast-7731')
    expect(dump).not.toContain('agent-wrote-4410')
    // another grid of the file reads it again; an edit made before those still lands, since no cell moved
    expect(s.since(book, 0)).toEqual({ rev: 2, reload: true })
    expect(await s.edit(book, 0, [set(sheet, 33, 0, { v: 'late' })], 'owner')).toEqual({ rev: 3 })
    // a write whose log keeps no cells cannot be taken back from the line
    await expect(s.undo(book, 'w1')).rejects.toThrow('can no longer be taken back')
  })

  it('his own workbook is kept as before: copies among the app\'s files, a log that can be replayed', async () => {
    const mine = join(rig.dataDir, 'Mine.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), mine)
    const s = await sharedStore()
    const { inspected } = await s.open(mine)
    expect(s.isShared(mine)).toBe(false)
    await s.edit(mine, 0, [set(inspected.sheets[0]!.id, 30, 0, { v: 'mine' })], 'owner')
    expect(everyFile(scratch())).toEqual([])
    expect(everyFile(own())).toHaveLength(2)
    expect(ops(mine)[0]!.mutations).toContain('mine')
    expect(s.since(mine, 0)).toMatchObject({ rev: 1, ops: [{ rev: 1 }] })
  })

  it('the copies go when the last holder goes: a tab closed for good, a thread deleted; the row stays, so a suggestion still knows its revision', async () => {
    const s = await sharedStore()
    const { inspected } = await s.open(book)
    s.hold(book, 'item-1', 'pane-1')
    s.hold(book, 'item-2', 'pane-1')
    s.hold(book, '', 'thread-9')
    await s.edit(book, 0, [set(inspected.sheets[0]!.id, 30, 0, { v: 1 })], 'owner')
    expect(everyFile(scratch())).toHaveLength(2)
    // one tab of two closed: still held
    expect(s.release({ items: ['item-1'] })).toEqual([])
    expect(everyFile(scratch())).toHaveLength(2)
    expect(s.release({ items: ['item-2'] })).toEqual([])
    // the thread that read it by path is deleted: nobody holds it now
    expect(s.release({ sessions: ['thread-9'] })).toEqual([book])
    await s.idle()
    expect(everyFile(scratch())).toEqual([])
    expect(everyFile(own())).toEqual([])
    // opened again, it stands at the revision it had, and takes an edit
    const again = await s.open(book)
    expect(again.rev).toBe(1)
    expect(await s.edit(book, 1, [set(inspected.sheets[0]!.id, 31, 0, { v: 2 })], 'owner')).toEqual({ rev: 2 })
    expect(valueAt(book, 31, 0)).toBe(2)
    // an old revision's copy is gone, and is said so
    expect(() => s.fileAt(book, 0)).toThrow('no longer kept')
  })

  it('his own workbook is held by nobody: closing its tab removes nothing', async () => {
    const mine = join(rig.dataDir, 'Mine.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), mine)
    const s = await sharedStore()
    await s.open(mine)
    s.hold(mine, 'item-1', 'pane-1')
    expect(s.release({ items: ['item-1'] })).toEqual([])
    expect(everyFile(own())).toHaveLength(1)
  })

  it('copies made among the app\'s files before this rule move to the scratch the next time the workbook is touched', async () => {
    const before = await store()
    const { inspected } = await before.open(book)
    await before.edit(book, 0, [set(inspected.sheets[0]!.id, 30, 0, { v: 1 })], 'owner')
    expect(everyFile(own())).toHaveLength(2)
    const s = await sharedStore()
    expect((await s.open(book)).rev).toBe(1)
    expect(everyFile(own())).toEqual([])
    expect(everyFile(scratch())).toHaveLength(2)
    expect(s.fileAt(book, 0)).toContain(scratch())
  })

  it('a log written before this rule gives up what was typed the next time the workbook is touched', async () => {
    const before = await store()
    const { inspected } = await before.open(book)
    await before.edit(book, 0, [set(inspected.sheets[0]!.id, 30, 0, { v: 'Q4-forecast-7731' })], 'owner')
    await before.writeCells(book, [{ at: 'A32', v: 'agent-wrote-4410' }], 'agent:local:t1', 'A32', 'w1')
    expect(JSON.stringify(ops(book))).toContain('Q4-forecast-7731')
    const s = await sharedStore()
    await s.open(book)
    expect(ops(book).map((o) => [o.rev, o.mutations, o.undo])).toEqual([
      [1, '"unkept"', null],
      [2, '"unkept"', null]
    ])
    expect(JSON.stringify(rig.db.prepare('SELECT * FROM work_sheets_ops').all())).not.toMatch(/Q4-forecast-7731|agent-wrote-4410/)
  })

  it('at a start, every shared workbook this host knows gives up its old copies and typed log, opened again or not', async () => {
    const before = await store()
    const { inspected } = await before.open(book)
    await before.edit(book, 0, [set(inspected.sheets[0]!.id, 30, 0, { v: 'Q4-forecast-7731' })], 'owner')
    const s = await sharedStore()
    s.sweep()
    expect(everyFile(own())).toEqual([])
    expect(everyFile(scratch())).toHaveLength(2)
    expect(JSON.stringify(rig.db.prepare('SELECT * FROM work_sheets_ops').all())).not.toContain('Q4-forecast-7731')
  })

  it('a release waits for a save in flight: the tab\'s last edit lands, then the copies go', async () => {
    const s = await sharedStore()
    const { inspected } = await s.open(book)
    s.hold(book, 'item-1', 'pane-1')
    const last = s.edit(book, 0, [set(inspected.sheets[0]!.id, 30, 0, { v: 'last words' })], 'owner')
    expect(s.release({ items: ['item-1'] })).toEqual([book])
    expect(await last).toEqual({ rev: 1 })
    await s.idle()
    expect(valueAt(book, 30, 0)).toBe('last words')
    expect(everyFile(scratch())).toEqual([])
  })

  it('History offers the newest revision and those whose copy is still here', async () => {
    const s = await sharedStore()
    const { inspected } = await s.open(book)
    await s.edit(book, 0, [set(inspected.sheets[0]!.id, 30, 0, { v: 1 })], 'owner')
    await s.edit(book, 1, [set(inspected.sheets[0]!.id, 31, 0, { v: 2 })], 'owner')
    expect(s.history(book).map((h) => h.rev)).toEqual([2, 1, 0])
    rmSync(previewScratch(rig.dataDir), { recursive: true, force: true })
    expect(s.history(book).map((h) => h.rev)).toEqual([2])
  })

  it('a save is made in the OS temp folder, never in the scratch Files clears at start, and leaves nothing there', async () => {
    const seen: string[] = []
    const real = await localJobs()
    ensurePackageTables(rig.db)
    const s = new PackageStore(rig.db, { ...real, save: async (input, out, ...rest) => (seen.push(out), real.save(input, out, ...rest)) }, own(), () => null, Date.now, () => {}, null, (path) => fileKey(rig.ctx, path), { root: scratch(), is: (path) => sharedOf(rig.ctx, { at: 'file', host: HOST, path }) })
    const { inspected } = await s.open(book)
    await s.edit(book, 0, [set(inspected.sheets[0]!.id, 30, 0, { v: 1 })], 'owner')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.startsWith(join(tmpdir(), 'tc-sheet-save-'))).toBe(true)
    expect(existsSync(seen[0]!)).toBe(false)
    // a folder of this process alone, for its owner only
    expect(statSync(join(seen[0]!, '..')).mode & 0o077).toBe(0)
  })

  it('a start that cleared the scratch leaves a workbook that still opens, saves and keeps its new revision', async () => {
    const s = await sharedStore()
    const { inspected } = await s.open(book)
    await s.edit(book, 0, [set(inspected.sheets[0]!.id, 30, 0, { v: 1 })], 'owner')
    rmSync(previewScratch(rig.dataDir), { recursive: true, force: true })
    expect((await s.open(book)).rev).toBe(1)
    expect(await s.edit(book, 1, [set(inspected.sheets[0]!.id, 31, 0, { v: 2 })], 'owner')).toEqual({ rev: 2 })
    expect(everyFile(scratch())).toHaveLength(1)
    // changed outside while nothing was kept: its copy is made again
    writeFileSync(book, readFileSync(join(CORPUS, 'formulas.xlsx')))
    rmSync(previewScratch(rig.dataDir), { recursive: true, force: true })
    expect((await s.open(book)).rev).toBe(3)
    expect(everyFile(scratch())).toHaveLength(1)
  })
})
