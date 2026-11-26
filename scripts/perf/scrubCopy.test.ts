import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DB_NAME, requireScrubbed, scratchDir, scrub, SCRUB_MARK, scrubDir, unscrubbed } from './scrubCopy'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A small database in the live one's shape: threads mid-turn, a saved host, keys, a routine, the guard's mark. */
function copyLike(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, title TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE resume_after_boot (session_id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL);
    CREATE TABLE remote_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE addons (id TEXT PRIMARY KEY);
    CREATE TABLE work_routines (id TEXT PRIMARY KEY);
    CREATE TABLE events (session_id TEXT, seq INTEGER, data TEXT);
    INSERT INTO sessions VALUES ('a', 'running', 'A'), ('b', 'starting', 'B'), ('c', 'queued', 'C'), ('d', 'idle', 'D'), ('e', 'done', 'E'), ('f', 'paused', 'F');
    INSERT INTO resume_after_boot VALUES ('a', 1), ('b', 2);
    INSERT INTO remote_keys VALUES ('k1', 'Mac'), ('k2', 'Laptop');
    INSERT INTO addons VALUES ('linear');
    INSERT INTO work_routines VALUES ('friday');
    INSERT INTO events VALUES ('a', 1, 'his words');
    INSERT INTO settings VALUES
      ('remote.environments.env_box', '{"key":"tc_secret"}'), ('macBridge.policy.env_box', '"read+run"'),
      ('guard.instanceNonce', 'abc'), ('batch:m1', '{}'), ('rules-sync:peer:env_b', '1'), ('work', '{"enabled":true}'),
      ('workspace.root', '/srv/agents/work'), ('admission.maxRunning', '40'), ('remote_looks_like_but_is_not', 'kept');
  `)
}

describe('the scrub of a scratch copy', () => {
  it('empties what reaches out or starts work, sets every live status idle, switches Work off and leaves the marker', () => {
    const db = new DatabaseSync(':memory:')
    copyLike(db)
    expect(unscrubbed(db)).toBe('it carries no scrub marker')
    const done = scrub(db, 1234)
    expect(done.idled).toBe(3)
    expect(done.emptied).toEqual({ resume_after_boot: 2, remote_keys: 2, addons: 1, work_routines: 1 })
    expect(done.settings).toBe(5)
    const statuses = (db.prepare('SELECT id, status FROM sessions ORDER BY id').all() as { id: string; status: string }[]).map((row) => row.status)
    expect(statuses).toEqual(['idle', 'idle', 'idle', 'idle', 'done', 'paused'])
    const keys = (db.prepare('SELECT key FROM settings ORDER BY key').all() as { key: string }[]).map((row) => row.key)
    expect(keys).toEqual(['admission.maxRunning', 'harness.sync.enabled', 'memory.sync.enabled', SCRUB_MARK, 'remote_looks_like_but_is_not', 'work', 'workspace.root'])
    expect((db.prepare("SELECT value FROM settings WHERE key = 'work'").get() as { value: string }).value).toBe('{"enabled":false}')
    // The transcript is untouched: benches time it, nothing reads it out.
    expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1)
    expect(unscrubbed(db)).toBeNull()
  })

  it('a marker alone is not trusted: each fact it stands for is read again', () => {
    const cases: [string, string][] = [
      ["INSERT INTO resume_after_boot VALUES ('x', 9)", 'its resume ledger holds rows'],
      ["UPDATE sessions SET status = 'running' WHERE id = 'd'", 'it holds a thread that is running, starting or queued'],
      ["INSERT INTO remote_keys VALUES ('k9', 'again')", 'it holds remote keys'],
      ["INSERT INTO settings VALUES ('remote.environments.env_x', '{}')", 'it holds saved hosts'],
      ["UPDATE settings SET value = '{\"enabled\":true}' WHERE key = 'work'", 'Work is not switched off in it'],
      [`UPDATE settings SET value = '{"version":0}' WHERE key = '${SCRUB_MARK}'`, 'its scrub marker is of another version']
    ]
    for (const [sql, why] of cases) {
      const db = new DatabaseSync(':memory:')
      copyLike(db)
      scrub(db)
      db.exec(sql)
      expect(unscrubbed(db), sql).toBe(why)
    }
  })

  it('a failed scrub leaves nothing half done', () => {
    const db = new DatabaseSync(':memory:')
    copyLike(db)
    db.exec('DROP TABLE settings; CREATE TABLE settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK (typeof(value) = \'integer\'))')
    expect(() => scrub(db)).toThrow()
    expect((db.prepare('SELECT COUNT(*) AS n FROM resume_after_boot').get() as { n: number }).n).toBe(2)
  })
})

describe('the kit refuses a copy that was not scrubbed', () => {
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-scrub-'))
    dirs.push(dir)
    const db = new DatabaseSync(join(dir, DB_NAME))
    copyLike(db)
    db.close()
    return dir
  }

  it('boots nothing before the scrub, and takes the copy after it', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'environment.json'), '{"id":"env_live"}')
    mkdirSync(join(dir, 'tls'))
    expect(() => requireScrubbed(dir)).toThrow(/environment\.json/)
    rmSync(join(dir, 'environment.json'))
    expect(() => requireScrubbed(dir)).toThrow(/no scrub marker/)
    writeFileSync(join(dir, 'environment.json'), '{"id":"env_live"}')
    expect(scrubDir(dir).idled).toBe(3)
    expect(() => requireScrubbed(dir)).not.toThrow()
  })

  it('touches only a scratch folder that no app is running on', () => {
    expect(() => scratchDir('/srv')).toThrow(/not under/)
    const dir = scratch()
    writeFileSync(join(dir, 'SingletonLock'), '')
    expect(() => scrubDir(dir)).toThrow(/an app is using/)
    const empty = mkdtempSync(join(tmpdir(), 'perf-scrub-'))
    dirs.push(empty)
    expect(() => requireScrubbed(empty)).toThrow(/holds no docket\.db/)
  })
})
