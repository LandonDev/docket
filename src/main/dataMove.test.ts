import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MARK, moveData, nodeOps, type MoveInput, type MoveOps } from './dataMove'

let root: string
let home: string
let appData: string
let old: string
let neu: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'data-move-'))
  home = join(root, 'home')
  appData = join(home, 'Library', 'Application Support')
  old = join(appData, 'temp-code')
  neu = join(appData, 'Docket')
  mkdirSync(appData, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const PID = 4242
const dead = (): boolean => false

function launch(over: Partial<MoveInput> = {}): ReturnType<typeof moveData> {
  return moveData({
    platform: 'darwin',
    home,
    defaultUserData: old,
    override: null,
    packaged: true,
    pid: PID,
    alive: dead,
    ...over
  })
}

/**
 * A database as a crash leaves it: the schema and the first value in the
 * file, the rest only in its -wal, and a -shm beside it.
 */
function seedDb(path: string, table: string, values: number[]): void {
  const scratch = mkdtempSync(join(root, 'seed-'))
  const db = new DatabaseSync(join(scratch, 'x.db'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ${table}(x)`)
  db.exec(`INSERT INTO ${table} VALUES (${values[0]}); PRAGMA wal_checkpoint(TRUNCATE)`)
  for (const v of values.slice(1)) db.exec(`INSERT INTO ${table} VALUES (${v})`)
  for (const s of ['', '-wal', '-shm']) copyFileSync(join(scratch, 'x.db' + s), path + s)
  db.close()
}

/** The old layout: both databases with WAL, Chromium's files, staged code, and ~/.temp-code with a worktree. */
function seedOld(): void {
  mkdirSync(join(old, 'code'), { recursive: true })
  writeFileSync(join(old, 'Preferences'), '{}')
  writeFileSync(join(old, 'code', 'state.json'), '{}')
  seedDb(join(old, 'temp-code.db'), 't', [1, 2, 3])
  seedDb(join(old, 'temp-code-cold.db'), 'c', [10, 20])
  mkdirSync(join(home, '.temp-code', 'worktrees', 'proj', 'wt'), { recursive: true })
  writeFileSync(join(home, '.temp-code', 'worktrees', 'proj', 'wt', 'file.txt'), 'x')
}

/** What an app opening `dir/main` with its cold file beside it reads, closing again (a checkpoint, as an app's quit). */
function read(dir: string, main: string): { t: number[]; c: number[] } {
  const db = new DatabaseSync(join(dir, main))
  try {
    db.exec(`ATTACH DATABASE '${join(dir, main.replace(/\.db$/, '-cold.db'))}' AS cold`)
    const col = (sql: string): number[] => (db.prepare(sql).all() as { x: number }[]).map((r) => r.x)
    return { t: col('SELECT x FROM t ORDER BY x'), c: col('SELECT x FROM cold.c ORDER BY x') }
  } finally {
    db.close()
  }
}

/** A folder's entries: `name/` for a folder, `name -> target` for a link, `name` for a file. */
function layout(dir: string): string[] {
  if (!existsSync(dir) && !isLink(dir)) return []
  return readdirSync(dir)
    .filter((name) => !name.endsWith('-shm'))
    .map((name) => {
      const s = lstatSync(join(dir, name))
      return s.isSymbolicLink() ? `${name} -> ${readlinkSync(join(dir, name))}` : s.isDirectory() ? `${name}/` : name
    })
    .sort()
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Every change made, by name, after the first `limit` of which nothing happens and each call throws: a crash. */
function recorder(limit = Infinity): { ops: MoveOps; calls: string[] } {
  const calls: string[] = []
  const wrap =
    <A extends unknown[]>(name: string, fn: (...args: A) => void) =>
    (...args: A): void => {
      if (calls.length >= limit) throw new Error('crashed')
      fn(...args)
      calls.push(`${name} ${(name === 'create' ? args.slice(0, 1) : args).filter((a) => typeof a === 'string' && a !== 'junction').join(' ')}`)
    }
  return {
    calls,
    ops: {
      rename: wrap('rename', nodeOps.rename),
      symlink: wrap('symlink', nodeOps.symlink),
      link: wrap('link', nodeOps.link),
      unlink: wrap('unlink', nodeOps.unlink),
      mkdir: wrap('mkdir', nodeOps.mkdir),
      create: wrap('create', nodeOps.create)
    }
  }
}

const MOVED_DATA = [
  'Preferences',
  'code/',
  'docket-cold.db',
  'docket-cold.db-wal',
  'docket.db',
  'docket.db-wal',
  'temp-code-cold.db -> docket-cold.db',
  'temp-code.db -> docket.db'
]

/** The finished layout; an older build that opened the database in between leaves no -wal (its close checkpoints). */
function expectMoved(wal = true): void {
  expect(readlinkSync(old)).toBe('Docket')
  expect(layout(neu)).toEqual(wal ? MOVED_DATA : MOVED_DATA.filter((name) => !name.endsWith('-wal')))
  expect(readlinkSync(join(home, '.temp-code'))).toBe('.docket')
  expect(layout(join(home, '.docket', 'worktrees', 'proj', 'wt'))).toEqual(['file.txt'])
}

describe('moveData', () => {
  it('moves the old layout to the new names, with links at the old ones', () => {
    seedOld()
    const move = launch()
    expect(move).toMatchObject({ v: 1, userData: neu, setPath: true, db: 'docket.db', held: [] })
    expect(move.did).toHaveLength(4)
    expectMoved()
    expect(read(neu, 'docket.db')).toEqual({ t: [1, 2, 3], c: [10, 20] })
  })

  it('changes nothing at the next launch', () => {
    seedOld()
    launch()
    const { ops, calls } = recorder()
    const again = launch({ ops })
    expect(calls).toEqual([])
    expect(again).toMatchObject({ userData: neu, db: 'docket.db', did: [], held: [] })
  })

  it('lets an older build open the old names: same rows, the same WAL, its writes seen by the new names', () => {
    seedOld()
    launch()
    const older = new DatabaseSync(join(old, 'temp-code.db'))
    older.exec(`ATTACH DATABASE '${join(old, 'temp-code-cold.db')}' AS cold`)
    const t = (db: DatabaseSync): number[] => (db.prepare('SELECT x FROM t ORDER BY x').all() as { x: number }[]).map((r) => r.x)
    expect(t(older)).toEqual([1, 2, 3])
    older.exec('INSERT INTO t VALUES (4); INSERT INTO cold.c VALUES (30)')
    // The WAL is named from the real file: one WAL for both names.
    expect(existsSync(join(neu, 'docket.db-wal'))).toBe(true)
    expect(existsSync(join(neu, 'temp-code.db-wal'))).toBe(false)
    const newer = new DatabaseSync(join(neu, 'docket.db'))
    expect(t(newer)).toEqual([1, 2, 3, 4])
    newer.close()
    older.close()
    expect(read(neu, 'docket.db')).toEqual({ t: [1, 2, 3, 4], c: [10, 20, 30] })
  })

  it('makes the new layout on a fresh install, and an older build that opens the old name fills the new file', () => {
    const move = launch()
    expect(move).toMatchObject({ userData: neu, db: 'docket.db', held: [] })
    expect(readlinkSync(old)).toBe('Docket')
    expect(layout(neu)).toEqual(['temp-code-cold.db -> docket-cold.db', 'temp-code.db -> docket.db'])
    expect(readlinkSync(join(home, '.temp-code'))).toBe('.docket')
    const older = new DatabaseSync(join(old, 'temp-code.db'))
    older.exec('CREATE TABLE t(x); INSERT INTO t VALUES (7)')
    older.close()
    expect(lstatSync(join(neu, 'docket.db')).isFile()).toBe(true)
    expect(launch()).toMatchObject({ did: [], held: [] })
  })

  it('links an old name to a new folder that is already there', () => {
    mkdirSync(neu)
    seedDb(join(neu, 'docket.db'), 't', [1])
    const move = launch()
    expect(move).toMatchObject({ userData: neu, db: 'docket.db', held: [] })
    expect(readlinkSync(old)).toBe('Docket')
    expect(layout(neu)).toContain('temp-code.db -> docket.db')
  })

  it('makes the folder a link waits for', () => {
    symlinkSync('Docket', old)
    expect(launch()).toMatchObject({ userData: neu, held: [] })
    expect(lstatSync(neu).isDirectory()).toBe(true)
  })

  it('never merges two real folders: it runs on the one with the newer database and changes nothing', () => {
    seedOld()
    mkdirSync(neu)
    seedDb(join(neu, 'docket.db'), 't', [9])
    const past = new Date(Date.now() - 86_400_000)
    for (const name of ['temp-code.db', 'temp-code.db-wal', 'temp-code-cold.db', 'temp-code-cold.db-wal']) utimesSync(join(old, name), past, past)
    const before = [layout(old), layout(neu)]
    const { ops, calls } = recorder()
    const move = launch({ ops })
    expect(calls).toEqual([])
    expect(move.userData).toBe(neu)
    expect(move.held.join()).toMatch(/both .* exist/)
    expect([layout(old), layout(neu)]).toEqual(before)
  })

  it('keeps the old folder when the new name belongs to another app', () => {
    seedOld()
    mkdirSync(neu)
    writeFileSync(join(neu, 'settings.json'), '{}')
    const move = launch()
    expect(move).toMatchObject({ userData: old, db: 'temp-code.db' })
    expect(lstatSync(old).isDirectory()).toBe(true)
    expect(layout(neu)).toEqual(['settings.json'])
    expect(lstatSync(join(home, '.temp-code')).isDirectory()).toBe(true)
  })

  it('runs on the old names and changes nothing when the folder cannot be renamed (another disk)', () => {
    seedOld()
    const before = layout(old)
    const refusing: MoveOps = {
      ...nodeOps,
      rename: (from, to) => {
        if (from === old) throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
        nodeOps.rename(from, to)
      }
    }
    const move = launch({ ops: refusing })
    expect(move).toMatchObject({ userData: old, setPath: true, db: 'temp-code.db', did: [] })
    expect(move.held.join()).toMatch(/could not be renamed \(EXDEV\)/)
    expect(layout(old)).toEqual(before)
    expect(existsSync(neu)).toBe(false)
    expect(lstatSync(join(home, '.temp-code')).isDirectory()).toBe(true)
  })

  it('puts the folder back when no link can be made at the old name', () => {
    seedOld()
    const before = layout(old)
    const noLinks: MoveOps = {
      ...nodeOps,
      symlink: () => {
        throw Object.assign(new Error('no'), { code: 'EPERM' })
      }
    }
    const move = launch({ ops: noLinks })
    expect(move).toMatchObject({ userData: old, db: 'temp-code.db' })
    expect(move.held.join()).toMatch(/no link could be made/)
    expect(layout(old)).toEqual(before)
    expect(existsSync(neu)).toBe(false)
  })

  it('leaves a folder another live process holds', () => {
    seedOld()
    symlinkSync('box-777', join(old, 'SingletonLock'))
    const { ops, calls } = recorder()
    const move = launch({ ops, alive: (pid) => pid === 777 })
    expect(calls).toEqual([])
    expect(move).toMatchObject({ userData: old, db: 'temp-code.db' })
    expect(move.held.join()).toMatch(/in use by process 777/)
  })

  it('takes over from a launch that died, and waits out one still moving', () => {
    seedOld()
    writeFileSync(join(old, MARK), JSON.stringify({ pid: 99, at: Date.now() }))
    let now = Date.now()
    const { ops, calls } = recorder()
    const busy = launch({ ops, alive: (pid) => pid === 99, now: () => now, sleep: (ms) => void (now += ms) })
    expect(calls).toEqual([])
    expect(busy.userData).toBe(old)
    expect(busy.held.join()).toMatch(/another launch is moving/)
    // The same mark, its launch gone: this one finishes the move.
    expect(launch()).toMatchObject({ userData: neu, held: [] })
    expectMoved()
    expect(existsSync(join(neu, MARK))).toBe(false)
  })

  it('moves nothing of an override folder but its databases', () => {
    seedOld()
    const dev = join(appData, 'temp-code-dev')
    mkdirSync(dev)
    seedDb(join(dev, 'temp-code.db'), 't', [5])
    const before = layout(old)
    const move = launch({ override: dev })
    expect(move).toMatchObject({ userData: dev, setPath: false, db: 'docket.db', held: [] })
    expect(layout(dev)).toEqual(['docket.db', 'docket.db-wal', 'temp-code-cold.db -> docket-cold.db', 'temp-code.db -> docket.db'])
    expect(layout(old)).toEqual(before)
    expect(lstatSync(join(home, '.temp-code')).isDirectory()).toBe(true)
    expect(existsSync(neu)).toBe(false)
  })

  it('names the databases of an override that is a link to its folder', () => {
    const real = join(root, 'docket-data')
    mkdirSync(real)
    seedDb(join(real, 'temp-code.db'), 't', [7])
    const box = join(root, 'temp-code-data')
    symlinkSync('docket-data', box)
    expect(launch({ override: box })).toMatchObject({ userData: box, db: 'docket.db', held: [] })
    expect(lstatSync(box).isSymbolicLink()).toBe(true)
    expect(layout(real)).toEqual(['docket.db', 'docket.db-wal', 'temp-code-cold.db -> docket-cold.db', 'temp-code.db -> docket.db'])
    const db = new DatabaseSync(join(box, 'temp-code.db'))
    expect(db.prepare('SELECT x FROM t').all()).toEqual([{ x: 7 }])
    db.close()
  })

  it('leaves an override folder that does not exist yet', () => {
    const fresh = join(root, 'fresh')
    expect(launch({ override: fresh })).toMatchObject({ userData: fresh, db: 'docket.db', did: [], held: [] })
    expect(existsSync(fresh)).toBe(false)
  })

  it('touches nothing from a dev build without an override', () => {
    seedOld()
    const { ops, calls } = recorder()
    expect(launch({ packaged: false, ops })).toMatchObject({ userData: old, setPath: false, db: 'temp-code.db' })
    expect(calls).toEqual([])
  })

  it('moves only a folder named temp-code', () => {
    const custom = join(appData, 'Something')
    mkdirSync(custom)
    expect(launch({ defaultUserData: custom })).toMatchObject({ userData: custom, setPath: true })
    expect(existsSync(neu)).toBe(false)
    expect(existsSync(join(home, '.docket'))).toBe(false)
  })

  it('keeps two real databases in one folder apart', () => {
    mkdirSync(neu)
    symlinkSync('Docket', old)
    seedDb(join(neu, 'temp-code.db'), 't', [1])
    seedDb(join(neu, 'docket.db'), 't', [2])
    const before = layout(neu)
    const move = launch()
    expect(move.held.join()).toMatch(/two databases/)
    expect(layout(neu)).toEqual(before)
  })

  it('keeps the old name when both names hold a -wal', () => {
    mkdirSync(neu)
    symlinkSync('Docket', old)
    seedDb(join(neu, 'temp-code.db'), 't', [1, 2])
    copyFileSync(join(neu, 'temp-code.db-wal'), join(neu, 'docket.db-wal'))
    const move = launch()
    expect(move.db).toBe('temp-code.db')
    expect(move.held.join()).toMatch(/both exist/)
    expect(lstatSync(join(neu, 'temp-code.db')).isFile()).toBe(true)
  })

  it('on Windows moves the folder under a junction with a full path and keeps the database names', () => {
    const local = join(home, 'AppData', 'Local')
    const winOld = join(local, 'temp-code')
    mkdirSync(winOld, { recursive: true })
    seedDb(join(winOld, 'temp-code.db'), 't', [1])
    const move = launch({ platform: 'win32', localAppData: local, defaultUserData: join(home, 'AppData', 'Roaming', 'temp-code') })
    expect(move).toMatchObject({ userData: join(local, 'Docket'), db: 'temp-code.db', held: [] })
    expect(isAbsolute(readlinkSync(winOld))).toBe(true)
    expect(layout(join(local, 'Docket'))).toEqual(['temp-code.db', 'temp-code.db-wal'])
    expect(launch({ platform: 'win32', localAppData: local, defaultUserData: join(home, 'AppData', 'Roaming', 'temp-code') }).did).toEqual([])
  })
})

describe('moveData after a crash at each step', () => {
  // A crash right after one of these leaves the old name without its data for
  // an older build until this build's next launch finishes the move.
  const blind = (call: string): boolean => call === `rename ${old} ${neu}` || /^rename .*-wal .*-wal$/.test(call)

  it('is finished by the next launch from every state, and an older build reads every state but the two instants', () => {
    seedOld()
    const full = recorder()
    launch({ ops: full.ops })
    const steps = full.calls
    expect(steps.length).toBeGreaterThan(15)
    // The data folder's rename, and each database's -wal.
    expect(steps.filter(blind)).toHaveLength(3)
    for (let k = 0; k < steps.length; k++) {
      for (const olderFirst of [false, true]) {
        rmSync(home, { recursive: true, force: true })
        mkdirSync(appData, { recursive: true })
        seedOld()
        const dying = recorder(k)
        launch({ ops: dying.ops, pid: 1 })
        expect(dying.calls).toEqual(steps.slice(0, k))
        if (olderFirst) {
          if (k > 0 && blind(steps[k - 1])) continue
          expect(read(old, 'temp-code.db'), `older build after ${steps[k - 1] ?? 'nothing'}`).toEqual({ t: [1, 2, 3], c: [10, 20] })
        }
        const next = launch()
        expect(next.held, `after ${steps[k - 1] ?? 'nothing'}`).toEqual([])
        expect(next).toMatchObject({ userData: neu, db: 'docket.db' })
        expectMoved(!olderFirst)
        expect(read(neu, 'docket.db')).toEqual({ t: [1, 2, 3], c: [10, 20] })
        expect(read(old, 'temp-code.db')).toEqual({ t: [1, 2, 3], c: [10, 20] })
        expect(launch().did, `third launch after ${steps[k - 1] ?? 'nothing'}`).toEqual([])
      }
    }
  })
})
