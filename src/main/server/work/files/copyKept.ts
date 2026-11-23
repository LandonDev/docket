import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/**
 * What the rest of Work asks of a Files tab's copies that save back (copies.ts), from the database alone. A leaf:
 * it imports nothing of Files or the office pillar, so `sharedOf` (policy.ts) and the office pillar's copy drops
 * (office/files/handle.ts) can both read it. A database with no `work_files_copies` table answers as if none.
 */

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function ask(db: DatabaseSync, sql: string, ...args: string[]): boolean {
  try {
    return !!db.prepare(sql).get(...args)
  } catch {
    return false
  }
}

/**
 * Whether a path is a copy that saves back to a file others can open, or lies beside one in its own folder (one
 * folder a source file, office/files/handle.ts `copyFolderOf`): it is as shared as that file, so every editor's
 * hold for a shared file reads it.
 */
export function isSavingCopy(db: DatabaseSync, path: string): boolean {
  const at = real(path)
  return ask(db, `SELECT 1 FROM work_files_copies WHERE copy = ? OR dir = ? LIMIT 1`, at, dirname(at))
}

/** Whether a copy's folder must stay when its tab's item goes: a copy with changes not yet sent is kept until they are. */
export function copyKeptIn(db: DatabaseSync, dir: string): boolean {
  return ask(db, `SELECT 1 FROM work_files_copies WHERE closed = 1 AND dir = ? LIMIT 1`, real(dir))
}

/** Copy Teams files turned off, or the workspace gone: every copy record of it goes with the copies themselves. */
export function dropCopyRecords(db: DatabaseSync, workspaceId: string): void {
  try {
    db.prepare(`DELETE FROM work_files_copies WHERE workspace_id = ?`).run(workspaceId)
  } catch {
    // no table: nothing was kept
  }
}
