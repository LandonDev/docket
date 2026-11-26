import type { DatabaseSync } from 'node:sqlite'

const PATHS = [['projects', 'cwd'], ['workspaces', 'path'], ['sessions', 'cwd']] as const
const TABLE = 'perf_host_copy_paths'
type Db = Pick<DatabaseSync, 'exec' | 'prepare'>

function transaction(db: Db, work: () => void): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    work()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function restore(db: Db): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE)) return
  for (const [table, field] of PATHS) {
    db.prepare(`UPDATE ${table} SET ${field} = (SELECT saved.value FROM ${TABLE} saved WHERE saved.kind = ? AND saved.id = ${table}.id)
      WHERE id IN (SELECT id FROM ${TABLE} WHERE kind = ?)`).run(table, table)
  }
  db.exec(`DROP TABLE ${TABLE}`)
}

/** Only on a validated scrubbed copy, before Electron opens it. Keep every
 * transcript and move only the path pointers so boot sweeps cannot write
 * into the original workspaces. The table also survives an interrupted run. */
export function stageCopyPaths(db: Db, scratch: string): void {
  transaction(db, () => {
    restore(db)
    db.exec(`CREATE TABLE ${TABLE} (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, id))`)
    for (const [table, field] of PATHS) {
      db.prepare(`INSERT INTO ${TABLE} (kind, id, value) SELECT ?, id, ${field} FROM ${table} WHERE ${field} IS NOT NULL`).run(table)
      db.prepare(`UPDATE ${table} SET ${field} = ? || hex(id) WHERE ${field} IS NOT NULL`).run(scratch + '/disconnected/' + table + '/')
    }
  })
}

/** Restore the copy's path pointers after all processes have stopped. */
export function restoreCopyPaths(db: Db): void {
  transaction(db, () => restore(db))
}
