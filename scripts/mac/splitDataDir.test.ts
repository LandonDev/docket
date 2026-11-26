import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * split-data-dir.sh after the move to Docket's names (docs/agents/docket-data-move.md), on a
 * scratch HOME: `temp-code` is a link to `Docket`, and temp-code.db a link to docket.db. The split
 * must move the real folder and leave the link, or refuse a move the app left unfinished.
 */
const script = join(import.meta.dirname, 'split-data-dir.sh')
const env = 'env_abcdefghijklmnopqrstuv'
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** Runs SQL against a database and leaves its WAL behind, as a live app would. */
function sqlite(path: string, sql: string): string {
  const py = `
import sqlite3, sys, os
db = sqlite3.connect(sys.argv[1])
db.execute('pragma journal_mode=wal')
db.execute('pragma wal_autocheckpoint=0')
rows = db.executescript(sys.argv[2]) and db.execute("select group_concat(name) from sqlite_master where type='table'").fetchone()[0]
print(rows, flush=True)
os._exit(0)
`
  const r = spawnSync('python3', ['-c', py, path, sql], { encoding: 'utf8' })
  if (r.status !== 0) throw Error(r.stderr)
  return r.stdout.trim()
}

/** The Mac's data folder after the move, with history and the box saved, the box's row only in the WAL. */
function moved(): { home: string; support: string } {
  const home = mkdtempSync(join(tmpdir(), 'split-docket-'))
  homes.push(home)
  const support = join(home, 'Library/Application Support')
  const docket = join(support, 'Docket')
  mkdirSync(docket, { recursive: true })
  symlinkSync('Docket', join(support, 'temp-code'))
  writeFileSync(join(docket, 'environment.json'), '{"environmentId":"env_mac"}\n')
  sqlite(join(docket, 'docket.db'), "create table settings (key text primary key, value text not null); create table sessions (id text); insert into sessions values ('history');")
  sqlite(join(docket, 'docket.db'), `insert into settings values ('remote.environments.${env}', '{"name":"Box"}');`)
  symlinkSync('docket.db', join(docket, 'temp-code.db'))
  return { home, support }
}

function split(home: string): { code: number | null; out: string; err: string } {
  const r = spawnSync('bash', [script, 'split'], { encoding: 'utf8', env: { ...process.env, HOME: home, TEMP_CODE_DATA: '', TC_BOX_ENV_ID: env } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const isLink = (path: string): boolean => lstatSync(path).isSymbolicLink()
const today = (): string => new Date().toLocaleDateString('en-CA')

describe('split-data-dir.sh after the move to Docket', () => {
  it('moves the real folder aside and leaves temp-code a link to the fresh Docket', () => {
    const { home, support } = moved()
    const r = split(home)
    expect(r.code, r.err).toBe(0)
    // The box's row lived only in docket.db's WAL: the split read the real database.
    expect(r.out).toContain(`box already saved as environment ${env}`)
    expect(isLink(join(support, 'temp-code'))).toBe(true)
    expect(readlinkSync(join(support, 'temp-code'))).toBe('Docket')
    const fresh = join(support, 'Docket')
    expect(isLink(fresh)).toBe(false)
    expect(readFileSync(join(fresh, 'environment.json'), 'utf8')).toBe('{"environmentId":"env_mac"}\n')
    expect(sqlite(join(fresh, 'temp-code.db'), 'select 1;')).toBe('settings')
    const aside = join(support, `temp-code.moved-${today()}`)
    expect(isLink(aside)).toBe(false)
    expect(sqlite(join(aside, 'temp-code.db'), 'select 1;')).toBe('settings,sessions')
    expect(readdirSync(support).sort()).toEqual(['Docket', 'temp-code', `temp-code.moved-${today()}`])
  })

  it('refuses two real databases, and changes nothing', () => {
    const { home, support } = moved()
    const docket = join(support, 'Docket')
    rmSync(join(docket, 'temp-code.db'))
    sqlite(join(docket, 'temp-code.db'), 'create table settings (key text primary key, value text not null);')
    const r = split(home)
    expect(r.code).toBe(1)
    expect(r.err).toContain(`${docket} holds both temp-code.db and docket.db: the move to Docket's names is unfinished or held`)
    expect(readdirSync(support).sort()).toEqual(['Docket', 'temp-code'])
  })

  it('refuses two real folders, and changes nothing', () => {
    const { home, support } = moved()
    rmSync(join(support, 'temp-code'))
    mkdirSync(join(support, 'temp-code'))
    sqlite(join(support, 'temp-code/temp-code.db'), 'create table settings (key text primary key, value text not null);')
    const r = split(home)
    expect(r.code).toBe(1)
    expect(r.err).toContain('holds both temp-code and Docket as real folders')
    expect(readdirSync(support).sort()).toEqual(['Docket', 'temp-code'])
    expect(existsSync(join(support, 'Docket/docket.db'))).toBe(true)
  })
})
