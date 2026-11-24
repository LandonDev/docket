import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureFilesTables } from '../files/library'
import { ensureLiveTables, libraryDefault, modeOf, setLibraryDefault, setMode } from './memory'

describe('remembering how a shared Office file opens', () => {
  let db: DatabaseSync
  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    ensureFilesTables(db)
    ensureLiveTables(db)
  })
  afterEach(() => db.close())

  it('defaults to here and keeps each library’s choice in the Files table', () => {
    expect(libraryDefault(db, 'library-a')).toBe('here')
    expect(modeOf(db, 'ws', 'plan', 'library-a')).toBe('here')
    setLibraryDefault(db, 'library-a', 'live')
    expect(db.prepare('SELECT value FROM work_office_files WHERE key = ?').get('live:library-a')).toMatchObject({ value: 'live' })
    expect(modeOf(db, 'ws', 'plan', 'library-a')).toBe('live')
    expect(modeOf(db, 'ws', 'plan', 'library-b')).toBe('here')
    setLibraryDefault(db, 'library-a', 'here')
    expect(libraryDefault(db, 'library-a')).toBe('here')
  })

  it('sets and overwrites a file’s mode for one workspace, ahead of the library default', () => {
    setLibraryDefault(db, 'library-a', 'live')
    setMode(db, 'ws', 'plan', 'here')
    ensureLiveTables(db)
    expect(modeOf(db, 'ws', 'plan', 'library-a')).toBe('here')
    expect(modeOf(db, 'ws', 'deck', 'library-a')).toBe('live')
    expect(modeOf(db, 'other', 'plan', 'library-a')).toBe('live')
    db.prepare('UPDATE work_office_live SET at = 0').run()
    setMode(db, 'ws', 'plan', 'live')
    expect(modeOf(db, 'ws', 'plan', 'library-a')).toBe('live')
    expect(db.prepare('SELECT at FROM work_office_live').all()).toEqual([{ at: expect.any(Number) }])
    expect(db.prepare('SELECT at FROM work_office_live').get()?.at).not.toBe(0)
  })

  it('uses the source host’s library default when supplied, still behind the file’s own mode', () => {
    expect(modeOf(db, 'ws', 'plan', 'far~library', 'live')).toBe('live')
    setMode(db, 'ws', 'plan', 'here')
    expect(modeOf(db, 'ws', 'plan', 'far~library', 'live')).toBe('here')
  })
})
