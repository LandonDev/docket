import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasSource } from '@shared/work'
import { csvSheetPath } from './held'
import { sheetFileMoved } from './moved'
import { ensureChangeTables } from './changes'
import { ensurePackageTables } from './packages'
import { ensureSuggestionTables } from './suggestions'

/** A sheet's file renamed or moved: what the pillar keeps by its path goes with it, and nothing of another file's is touched. */

const hash = (path: string): string => createHash('sha256').update(path).digest('hex').slice(0, 24)
const file = (path: string, host = 'env_test'): CanvasSource => ({ at: 'file', host, path })
let dir: string
let db: DatabaseSync
const at = () => ({ db, dataDir: dir, host: 'env_test' })
const stores = (table: string): string[] => (db.prepare(`SELECT store FROM ${table} ORDER BY store`).all() as { store: string }[]).map((r) => r.store)
const keyed = (store: string): void => {
  db.prepare("INSERT INTO work_sheets_suggestions (store, id, change_set, by, sheet, row, col, base_hash, state, at) VALUES (?, 's1', 'cs', 'agent:h:t', 'sheet1', 0, 0, '', 'pending', 1)").run(store)
  // a format an agent proposed, waiting in words
  db.prepare("INSERT INTO work_sheets_changes (store, id, change_set, by, kind, sheet, words, ask, state, rev, at) VALUES (?, 'f1', 'cs2', 'agent:h:t', 'format', 'sheet1', 'Bold on A1', '{}', 'pending', 0, 1)").run(store)
  db.prepare("INSERT INTO work_sheets_prefs (store, mode) VALUES (?, 'suggests')").run(store)
  db.prepare("INSERT INTO work_sheets_charts (store, id, json) VALUES (?, 'c1', '{}')").run(store)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-sheets-moved-'))
  db = new DatabaseSync(':memory:')
  ensurePackageTables(db)
  ensureSuggestionTables(db)
  ensureChangeTables(db)
  db.exec('CREATE TABLE IF NOT EXISTS work_sheets_charts (store TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (store, id))')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a sheet\'s file renamed', () => {
  it('an Excel file takes its revisions, its kept copies, its suggestions, its mode and its charts', () => {
    const from = '/work/Budget.xlsx'
    const to = '/work/Budget 2027.xlsx'
    db.prepare("INSERT INTO work_sheets_files (path, rev, stamp) VALUES (?, 2, '10:20')").run(from)
    db.prepare("INSERT INTO work_sheets_ops (path, rev, by, at, label, mutations) VALUES (?, 1, 'owner', 1, 'B4', '[]'), (?, 2, 'owner', 2, 'Formatting', '[]')").run(from, from)
    const copies = join(dir, 'sheets', 'files', hash(from))
    mkdirSync(copies, { recursive: true })
    writeFileSync(join(copies, '0.xlsx'), 'as opened')
    keyed(`file:${from}`)
    // another file's rows stay where they are
    db.prepare("INSERT INTO work_sheets_files (path, rev, stamp) VALUES ('/work/Other.xlsx', 5, '1:1')").run()
    keyed('file:/work/Other.xlsx')

    sheetFileMoved(file(from), file(to), at())

    expect(db.prepare('SELECT path, rev FROM work_sheets_files ORDER BY path').all()).toEqual([{ path: to, rev: 2 }, { path: '/work/Other.xlsx', rev: 5 }])
    expect((db.prepare('SELECT COUNT(*) AS n FROM work_sheets_ops WHERE path = ?').get(to) as { n: number }).n).toBe(2)
    expect((db.prepare('SELECT COUNT(*) AS n FROM work_sheets_ops WHERE path = ?').get(from) as { n: number }).n).toBe(0)
    for (const table of ['work_sheets_suggestions', 'work_sheets_changes', 'work_sheets_prefs', 'work_sheets_charts']) expect(stores(table)).toEqual([`file:${to}`, 'file:/work/Other.xlsx'].sort())
    expect(existsSync(copies)).toBe(false)
    expect(readFileSync(join(dir, 'sheets', 'files', hash(to), '0.xlsx'), 'utf8')).toBe('as opened')
  })

  it('gives way at the new name: what a file long gone left there is replaced by what moves in', () => {
    const from = '/work/a.xlsx'
    const to = '/work/b.xlsx'
    db.prepare("INSERT INTO work_sheets_files (path, rev, stamp) VALUES (?, 1, 'new'), (?, 9, 'old')").run(from, to)
    keyed(`file:${from}`)
    keyed(`file:${to}`)
    sheetFileMoved(file(from), file(to), at())
    expect(db.prepare('SELECT path, rev FROM work_sheets_files').all()).toEqual([{ path: to, rev: 1 }])
    expect(stores('work_sheets_prefs')).toEqual([`file:${to}`])
  })

  it('a .tcsheet takes its keys and the suggestions the service keeps for it', () => {
    const from = '/work/Plan.tcsheet'
    const to = '/work/Archive/Plan.tcsheet'
    keyed(`tcsheet:${from}`)
    const side = join(dir, 'work-service', 'sheets', 'suggestions')
    mkdirSync(side, { recursive: true })
    writeFileSync(join(side, `${hash(from)}.json`), '[{"id":"s1"}]')
    sheetFileMoved(file(from), file(to), at())
    expect(stores('work_sheets_suggestions')).toEqual([`tcsheet:${to}`])
    expect(existsSync(join(side, `${hash(from)}.json`))).toBe(false)
    expect(readFileSync(join(side, `${hash(to)}.json`), 'utf8')).toBe('[{"id":"s1"}]')
  })

  it('a .csv takes the sheet it opens as', () => {
    const from = '/work/People.csv'
    const to = '/work/Staff.csv'
    const was = csvSheetPath(dir, from)
    mkdirSync(join(dir, 'sheets', 'csv'), { recursive: true })
    writeFileSync(was, 'the sheet')
    keyed(`tcsheet:${was}`)
    sheetFileMoved(file(from), file(to), at())
    const now = csvSheetPath(dir, to)
    expect(existsSync(was)).toBe(false)
    expect(readFileSync(now, 'utf8')).toBe('the sheet')
    expect(stores('work_sheets_charts')).toEqual([`tcsheet:${now}`])
  })

  it('leaves alone a file on another host, a file that is no sheet, and a move to the same path', () => {
    keyed('file:/work/Budget.xlsx')
    sheetFileMoved(file('/work/Budget.xlsx', 'env_mac'), file('/work/B.xlsx', 'env_mac'), at())
    sheetFileMoved(file('/work/Notes.docx'), file('/work/N.docx'), at())
    sheetFileMoved(file('/work/Budget.xlsx'), file('/work/Budget.xlsx'), at())
    expect(stores('work_sheets_suggestions')).toEqual(['file:/work/Budget.xlsx'])
  })
})
