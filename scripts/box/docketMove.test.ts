import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * docket-move.sh, rehearsed: DOCKET_MOVE_REHEARSAL puts every path it touches
 * under a scratch folder and stands files in for the service and AppArmor, so
 * the script runs as it would on the box without root.
 */
const script = join(import.meta.dirname, 'docket-move.sh')
const tops: string[] = []
afterEach(() => {
  for (const top of tops.splice(0)) rmSync(top, { recursive: true, force: true })
})

/** The box before the move: the three folders by their old names, a build linked absolutely, a database with a WAL. */
function box(o: { service?: 'active' | 'inactive' } = {}): string {
  const top = mkdtempSync(join(tmpdir(), 'docket-move-'))
  tops.push(top)
  const agents = join(top, 'srv/agents')
  const data = join(agents, 'temp-code-data')
  mkdirSync(data, { recursive: true })
  mkdirSync(join(agents, 'temp-code-builds/abc123'), { recursive: true })
  symlinkSync(join(agents, 'temp-code-builds/abc123'), join(agents, 'temp-code-builds/current'))
  mkdirSync(join(agents, 'home/.temp-code/worktrees/wt'), { recursive: true })
  writeFileSync(join(data, 'environment.json'), '{"id":"box"}')
  sqlite(join(data, 'temp-code.db'), 'create table t(x); insert into t values (1);')
  mkdirSync(join(top, 'etc/apparmor.d'), { recursive: true })
  writeFileSync(
    join(top, 'etc/apparmor.d/temp-code'),
    'profile temp-code "/srv/agents/{temp-code,temp-code-builds/*}/node_modules/electron/dist/electron" flags=(unconfined) {\n  userns,\n}\n'
  )
  mkdirSync(join(top, 'etc/restic'), { recursive: true })
  writeFileSync(join(top, 'etc/restic/excludes'), '/srv/agents/temp-code-builds\n')
  mkdirSync(join(top, 'usr/local/sbin'), { recursive: true })
  writeFileSync(join(top, 'usr/local/sbin/box-update'), '# the box-update before the move\n')
  writeFileSync(join(top, 'service'), `${o.service ?? 'inactive'}\n`)
  return top
}

/** Runs SQL against a database and leaves its WAL behind, as a live app would. */
function sqlite(path: string, sql: string): string {
  const py = `
import sqlite3, sys, os
db = sqlite3.connect(sys.argv[1])
db.execute('pragma journal_mode=wal')
db.execute('pragma wal_autocheckpoint=0')
db.executescript(sys.argv[2])
print(db.execute('select group_concat(x) from t').fetchone()[0], flush=True)
os._exit(0)
`
  const r = spawnSync('python3', ['-c', py, path, sql], { encoding: 'utf8' })
  if (r.status !== 0) throw Error(r.stderr)
  return r.stdout.trim()
}

function run(top: string, ...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, DOCKET_MOVE_REHEARSAL: top } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const at = (top: string, path: string): string => join(top, 'srv/agents', path)
const isLink = (path: string): boolean => lstatSync(path).isSymbolicLink()
const service = (top: string): string => readFileSync(join(top, 'service'), 'utf8').trim()

describe('docket-move.sh', () => {
  it('moves the three folders, links the old names, and leaves every stored path working', () => {
    const top = box()
    const r = run(top)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    for (const [old, neu] of [
      ['temp-code-data', 'docket-data'],
      ['temp-code-builds', 'docket-builds'],
      ['home/.temp-code', 'home/.docket']
    ]) {
      expect(isLink(at(top, old))).toBe(true)
      expect(readlinkSync(at(top, old))).toBe(neu.split('/').pop())
      expect(lstatSync(at(top, neu)).isDirectory()).toBe(true)
      expect(r.out).toContain(`DONE: moved ${at(top, old)} to ${at(top, neu)}`)
    }
    // The builds' absolute link, the data's files and the database with its WAL, all by their old paths.
    expect(realpathSync(at(top, 'temp-code-builds/current'))).toBe(realpathSync(at(top, 'docket-builds/abc123')))
    expect(readFileSync(at(top, 'temp-code-data/environment.json'), 'utf8')).toBe('{"id":"box"}')
    expect(sqlite(at(top, 'temp-code-data/temp-code.db'), 'insert into t values (2);')).toBe('1,2')
    expect(existsSync(at(top, 'home/.temp-code/worktrees/wt'))).toBe(true)
    // AppArmor covers the new builds, restic leaves them out.
    expect(readFileSync(join(top, 'etc/apparmor.d/temp-code'), 'utf8')).toContain('{temp-code,temp-code-builds/*,docket-builds/*}')
    expect(readFileSync(join(top, 'apparmor-reloads'), 'utf8')).toContain('-r')
    const excludes = readFileSync(join(top, 'etc/restic/excludes'), 'utf8').split('\n')
    expect(excludes).toContain('/srv/agents/docket-builds')
    expect(excludes).toContain('/srv/agents/docket-data/*.db-wal')
    // box-update from this build, which resolves the builds folder before it prunes.
    expect(readFileSync(join(top, 'usr/local/sbin/box-update'), 'utf8')).toBe(readFileSync(join(import.meta.dirname, 'box-update.sh'), 'utf8'))
  })

  it('is safe to run twice: the second run changes nothing and says so', () => {
    const top = box()
    expect(run(top).code).toBe(0)
    const excludes = readFileSync(join(top, 'etc/restic/excludes'), 'utf8')
    const again = run(top)
    expect(again.code).toBe(0)
    expect(again.out).not.toContain('DONE:')
    expect(again.out.match(/^ALREADY: /gm)).toHaveLength(3)
    expect(readFileSync(join(top, 'etc/restic/excludes'), 'utf8')).toBe(excludes)
  })

  it('refuses while the service runs, and with --stop-service stops it, moves, and starts it again', () => {
    const top = box({ service: 'active' })
    const refused = run(top)
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('temp-code.service is running')
    expect(isLink(at(top, 'temp-code-data'))).toBe(false)
    expect(service(top)).toBe('active')

    const r = run(top, '--stop-service')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/DONE: stopped temp-code.service[\s\S]*DONE: moved[\s\S]*DONE: started temp-code.service/)
    expect(service(top)).toBe('active')
    expect(isLink(at(top, 'temp-code-data'))).toBe(true)
  })

  it('never merges two real folders, and changes nothing when one pair is in doubt', () => {
    const top = box()
    mkdirSync(at(top, 'docket-builds'))
    const r = run(top)
    expect(r.code).toBe(1)
    expect(r.err).toContain('are both real; nothing is merged')
    expect(r.err).toContain('Nothing was changed')
    // The data folder, checked first and movable, did not move either.
    expect(isLink(at(top, 'temp-code-data'))).toBe(false)
    expect(existsSync(at(top, 'docket-data'))).toBe(false)
  })

  it('finishes a run cut off between a rename and its link', () => {
    const top = box()
    renameSync(at(top, 'temp-code-data'), at(top, 'docket-data'))
    const r = run(top)
    expect(r.code).toBe(0)
    expect(r.out).not.toContain(`moved ${at(top, 'temp-code-data')}`)
    expect(r.out).toContain(`DONE: linked ${at(top, 'temp-code-data')} to ${at(top, 'docket-data')}`)
    expect(isLink(at(top, 'temp-code-data'))).toBe(true)
  })

  it('--dry-run says what it would do and changes nothing', () => {
    const top = box({ service: 'active' })
    const r = run(top, '--dry-run', '--stop-service')
    expect(r.code).toBe(0)
    expect(r.out).toContain('WOULD: stopped temp-code.service')
    expect(r.out).toContain(`WOULD: moved ${at(top, 'temp-code-data')} to ${at(top, 'docket-data')}`)
    expect(r.out).toContain('WOULD: start temp-code.service again')
    expect(r.out).not.toContain('DONE:')
    expect(service(top)).toBe('active')
    expect(isLink(at(top, 'temp-code-data'))).toBe(false)
    expect(readFileSync(join(top, 'etc/restic/excludes'), 'utf8')).toBe('/srv/agents/temp-code-builds\n')
  })

  it('--undo gives the folders and the database their old names back, with links at the new names', () => {
    const top = box()
    expect(run(top).code).toBe(0)
    // What the app does at its next start: docket.db, with temp-code.db a link to it.
    const data = at(top, 'docket-data')
    renameSync(join(data, 'temp-code.db'), join(data, 'docket.db'))
    renameSync(join(data, 'temp-code.db-wal'), join(data, 'docket.db-wal'))
    rmSync(join(data, 'temp-code.db-shm'), { force: true })
    symlinkSync('docket.db', join(data, 'temp-code.db'))
    expect(sqlite(join(data, 'docket.db'), 'insert into t values (3);')).toBe('1,3')

    const r = run(top, '--undo')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    for (const [old, neu] of [
      ['temp-code-data', 'docket-data'],
      ['temp-code-builds', 'docket-builds'],
      ['home/.temp-code', 'home/.docket']
    ]) {
      expect(lstatSync(at(top, old)).isDirectory()).toBe(true)
      expect(readlinkSync(at(top, neu))).toBe(old.split('/').pop())
    }
    const old = at(top, 'temp-code-data')
    expect(lstatSync(join(old, 'temp-code.db')).isFile()).toBe(true)
    expect(existsSync(join(old, 'docket.db'))).toBe(false)
    expect(existsSync(join(old, 'temp-code.db-wal'))).toBe(false)
    // The WAL's rows went into the file before it took its old name.
    expect(sqlite(join(old, 'temp-code.db'), 'select 1;')).toBe('1,3')

    // Twice is fine, and going forward again takes the links --undo left away first.
    expect(run(top, '--undo').out.match(/^ALREADY: /gm)).toHaveLength(3)
    const forward = run(top)
    expect(forward.code).toBe(0)
    expect(forward.out).toContain(`DONE: removed the link ${at(top, 'docket-data')} that --undo left`)
    expect(isLink(at(top, 'temp-code-data'))).toBe(true)
    expect(lstatSync(at(top, 'docket-data')).isDirectory()).toBe(true)
  })

  it('--undo refuses two real databases and leaves the service stopped, saying so', () => {
    const top = box({ service: 'active' })
    expect(run(top, '--stop-service').code).toBe(0)
    sqlite(at(top, 'docket-data/docket.db'), 'create table t(x); insert into t values (9);')
    const r = run(top, '--undo', '--stop-service')
    expect(r.code).toBe(1)
    expect(r.err).toContain('as separate databases; nothing is merged')
    expect(r.err).toContain('temp-code.service is left stopped')
    expect(service(top)).toBe('inactive')
    expect(isLink(at(top, 'temp-code-data'))).toBe(true)
  })
})
