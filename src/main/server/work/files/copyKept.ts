import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
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

/**
 * Whether a copy's folder must stay when its tab's item goes: a recorded copy's folder is the record's to let go
 * (copies.ts `letGo`, once nothing waits in it), however its item went.
 */
export function copyKeptIn(db: DatabaseSync, dir: string): boolean {
  return ask(db, `SELECT 1 FROM work_files_copies WHERE dir = ? LIMIT 1`, real(dir))
}

/**
 * Whether a copy holds changes that have not reached its file: its computer did not answer, a send is under way or
 * was refused, the file changed there, its tab closed before it was sent, or its bytes are not what the file holds.
 */
export function copyWaits(r: { state: string; closed: number; copy: string; sent: string }): boolean {
  if (r.state !== 'ok' || r.closed) return true
  try {
    return createHash('sha256').update(readFileSync(r.copy)).digest('hex') !== r.sent
  } catch {
    return false
  }
}

/**
 * Copy Teams files turned off, or the workspace gone: every copy record of it with nothing waiting goes. One whose
 * changes have not reached their file stays with its copy, and is sent and let go as any other: only his Discard
 * drops it. Answers the folders kept.
 */
export function dropCopyRecords(db: DatabaseSync, workspaceId: string): Set<string> {
  const kept = new Set<string>()
  try {
    const rows = db.prepare(`SELECT id, state, closed, copy, sent, dir FROM work_files_copies WHERE workspace_id = ?`).all(workspaceId) as unknown as { id: string; state: string; closed: number; copy: string; sent: string; dir: string }[]
    for (const r of rows) {
      if (copyWaits(r)) kept.add(r.dir)
      else db.prepare(`DELETE FROM work_files_copies WHERE id = ?`).run(r.id)
    }
  } catch {
    // no table: nothing was kept
  }
  return kept
}
