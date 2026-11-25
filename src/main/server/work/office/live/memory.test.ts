import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureFilesTables } from '../files/library'
import { dropWorkspaceModes, ensureLiveTables, libraryDefault, liveBase, modeOf, setLibraryDefault, setLiveBase, setMode } from './memory'

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

  it('keeps a file’s version as it went live per workspace, pinning no mode, and drops it with the workspace', () => {
    setLiveBase(db, 'ws', 'plan', 'sha256:aa')
    setLiveBase(db, 'other', 'plan', 'sha256:bb')
    expect(liveBase(db, 'ws', 'plan')).toBe('sha256:aa')
    expect(modeOf(db, 'ws', 'plan', 'library-a')).toBe('here')
    setLiveBase(db, 'ws', 'plan', null)
    expect(liveBase(db, 'ws', 'plan')).toBeNull()
    setLiveBase(db, 'ws', 'plan', 'sha256:cc')
    dropWorkspaceModes(db, 'ws')
    expect(liveBase(db, 'ws', 'plan')).toBeNull()
    expect(liveBase(db, 'other', 'plan')).toBe('sha256:bb')
  })
})
