/**
 * Scrubs a scratch copy of real data before any instance boots on it, and refuses a copy that was not scrubbed.
 *
 *   bun scripts/perf/scrubCopy.ts <scratch dir>            scrub the copy in place, leave the marker
 *   bun scripts/perf/scrubCopy.ts --check <scratch dir>    say whether it may be booted
 *
 * A copy of his data can act like him: on Nov 1 an instance on an unscrubbed copy resumed a live thread and joined
 * the box as a second Mac. So before a boot the copy loses everything that reaches out or starts work: the resume
 * ledger, every running, starting or queued status, saved hosts, keys, pairings, peers and given computers, the
 * sync marks, add-ons, routines, batches, the LifeOS and guest keys, the process guard's instance mark (with it the
 * copy's guard would take the live box's children for its own), `environment.json`, and Work is switched off.
 * `requireScrubbed` is what the kit calls before it boots a copy: the marker row, and the facts it stands for,
 * read again. The copy holds his transcripts: nothing here reads a row's text, and the folder is kept 0700.
 *
 * Only a folder under /srv/agents/tmp or /tmp is ever touched, never a data folder an app is running on.
 */
import { chmodSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCRUB_MARK = 'perf.scrubbed'
export const SCRUB_VERSION = 1
export const DB_NAME = 'docket.db'
/** Where a scratch copy may live. */
export const SCRATCH_ROOTS = ['/srv/agents/tmp/', '/tmp/']
/** A thread in one of these does nothing by itself. Every other status is set idle. */
export const SETTLED = ['idle', 'paused', 'stopped', 'error', 'done']

/** Tables emptied: what holds a key, a peer, or work that starts by itself. */
export const EMPTIED = [
  'resume_after_boot',
  'remote_keys', 'remote_pairings', 'remote_sessions', 'remote_push', 'remote_push_activities',
  'device_bindings', 'device_mail', 'device_removals', 'device_state',
  'addons', 'addon_tool_cache',
  'work_routines', 'work_routine_runs', 'work_mail_nudge_routines', 'work_prep_ahead',
  'work_lifeos_keys', 'work_lifeos_pending_links', 'work_office_addin_keys', 'work_guest_links',
  'work_held_acts', 'work_held_edits', 'work_grants', 'work_grant_offers', 'work_outbox_requests',
  'launch_mirror_hosts', 'launch_mirror_sessions'
]

/** Settings removed, by prefix: saved hosts, peers, the syncs' marks, accounts' homes, batches, the guard's mark. */
export const SETTINGS_REMOVED = [
  'remote.', 'relay.', 'devices.', 'macBridge.', 'crossHost.', 'batch:', 'accounts.', 'catalog:peer',
  'rules-sync:', 'store-sync:', 'project-settings-sync:', 'memory-sync:', 'memory.sync.', 'harness.sync.',
  'github.inbox.', 'code-offer', 'work.lifeos.', 'work.google.', 'work.guests.', 'guard.instanceNonce', 'release.checkout'
]

/** Files beside the database that name this host or hold a key. */
export const FILES_REMOVED = ['environment.json', 'server.json', 'headroom.json', 'tls', 'muse-accounts', 'memory-sync', 'harness-sync', 'harness', 'winvm']

type Db = Pick<DatabaseSync, 'exec' | 'prepare'>

export interface Scrubbed {
  /** rows removed, by table; a table the copy lacks is absent */
  emptied: Record<string, number>
  settings: number
  /** threads whose status was set idle */
  idled: number
}

const tables = (db: Db): Set<string> =>
  new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name))

const like = (prefix: string): string => prefix.replace(/[\\%_]/g, '\\$&') + '%'

/** The scrub itself, in one transaction. Counts only: no row's text is read. */
export function scrub(db: Db, now = Date.now()): Scrubbed {
  const have = tables(db)
  const result: Scrubbed = { emptied: {}, settings: 0, idled: 0 }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const table of EMPTIED) {
      if (!have.has(table)) continue
      result.emptied[table] = Number(db.prepare(`DELETE FROM ${table}`).run().changes)
    }
    if (have.has('sessions')) {
      result.idled = Number(db.prepare(`UPDATE sessions SET status = 'idle' WHERE status NOT IN (${SETTLED.map(() => '?').join(', ')})`).run(...SETTLED).changes)
    }
    if (have.has('settings')) {
      const remove = db.prepare("DELETE FROM settings WHERE key LIKE ? ESCAPE '\\'")
      for (const prefix of SETTINGS_REMOVED) result.settings += Number(remove.run(like(prefix)).changes)
      const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      set.run('work', JSON.stringify({ enabled: false }))
      set.run('memory.sync.enabled', 'false')
      set.run('harness.sync.enabled', 'false')
      set.run(SCRUB_MARK, JSON.stringify({ version: SCRUB_VERSION, at: now }))
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return result
}

/** Why a database may not be booted, or null when it is a scrubbed copy: the marker and the facts behind it. */
export function unscrubbed(db: Db): string | null {
  const have = tables(db)
  if (!have.has('settings')) return 'it has no settings table'
  const mark = (db.prepare('SELECT value FROM settings WHERE key = ?').get(SCRUB_MARK) as { value: string } | undefined)?.value
  if (!mark) return 'it carries no scrub marker'
  try {
    if ((JSON.parse(mark) as { version?: unknown }).version !== SCRUB_VERSION) return 'its scrub marker is of another version'
  } catch {
    return 'its scrub marker does not parse'
  }
  const count = (sql: string, ...params: string[]): number => Number((db.prepare(sql).get(...params) as { n: number }).n)
  if (have.has('resume_after_boot') && count('SELECT COUNT(*) AS n FROM resume_after_boot')) return 'its resume ledger holds rows'
  if (have.has('sessions') && count(`SELECT COUNT(*) AS n FROM sessions WHERE status NOT IN (${SETTLED.map(() => '?').join(', ')})`, ...SETTLED)) return 'it holds a thread that is running, starting or queued'
  if (have.has('remote_keys') && count('SELECT COUNT(*) AS n FROM remote_keys')) return 'it holds remote keys'
  if (count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'remote.environments.%'")) return 'it holds saved hosts'
  const work = (db.prepare("SELECT value FROM settings WHERE key = 'work'").get() as { value: string } | undefined)?.value
  if (!work || !/"enabled":\s*false/.test(work)) return 'Work is not switched off in it'
  return null
}

/** The scratch folder, resolved; throws when it is not one. */
export function scratchDir(dir: string): string {
  const real = realpathSync(dir)
  if (!SCRATCH_ROOTS.some((root) => (real + '/').startsWith(root))) throw new Error(`${real} is not under ${SCRATCH_ROOTS.join(' or ')}: only a scratch copy is scrubbed or booted`)
  if (!existsSync(join(real, DB_NAME))) throw new Error(`${real} holds no ${DB_NAME}`)
  // A data folder an app runs on carries Chromium's lock.
  if (readdirSync(real).some((name) => name.startsWith('Singleton'))) throw new Error(`${real} is a data folder an app is using`)
  return real
}

/** Throws unless `dir` is a scrubbed scratch copy: the kit calls this before it boots anything on one. */
export function requireScrubbed(dir: string): void {
  const real = scratchDir(dir)
  if (existsSync(join(real, 'environment.json'))) throw new Error(`${real} still has its environment.json: not scrubbed`)
  const db = new DatabaseSync(join(real, DB_NAME), { readOnly: true })
  try {
    const why = unscrubbed(db)
    if (why) throw new Error(`${real} may not be booted: ${why}. Run bun scripts/perf/scrubCopy.ts ${real}`)
  } finally {
    db.close()
  }
}

/** Scrubs the copy in `dir` in place. */
export function scrubDir(dir: string, now = Date.now()): Scrubbed {
  const real = scratchDir(dir)
  chmodSync(real, 0o700)
  for (const name of FILES_REMOVED) rmSync(join(real, name), { recursive: true, force: true })
  const db = new DatabaseSync(join(real, DB_NAME))
  try {
    return scrub(db, now)
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  try {
    if (args[0] === '--check') {
      requireScrubbed(args[1] ?? '')
      console.log('scrubbed: may be booted by the kit')
    } else if (args.length === 1) {
      const done = scrubDir(args[0]!)
      const rows = Object.values(done.emptied).reduce((sum, n) => sum + n, 0)
      console.log(`scrubbed ${args[0]}: ${rows} rows removed from ${Object.keys(done.emptied).length} tables, ${done.settings} settings removed, ${done.idled} threads set idle, Work off`)
    } else {
      throw new Error('usage: bun scripts/perf/scrubCopy.ts [--check] <scratch dir>')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
