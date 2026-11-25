import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname } from 'node:path'
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
  const at = real(dir)
  // A Word file's document kept in a copy's folder (files/word.ts `adoptWordCopies`) holds his edits: never dropped.
  // A copy that saves nowhere (copyStays.ts) is judged by its record as its item goes: kept while it holds his edits.
  return ask(db, `SELECT 1 FROM work_files_copies WHERE dir = ? LIMIT 1`, at) || ask(db, `SELECT 1 FROM work_files_word WHERE doc LIKE ? || '/%' LIMIT 1`, at) || ask(db, `SELECT 1 FROM work_files_stays WHERE dir = ? LIMIT 1`, at)
}

/**
 * Whether a copy's folder is another file's: a live copy record of another file lies in it (Keep Both re-pointed that
 * record to the new file, or its file moved), or a Word file's kept document. A copy of `file` made there would write
 * over that record's bytes, so it is made in a folder of its own (copies.ts `copyFolderFor`).
 */
export function copyFolderTaken(db: DatabaseSync, workspaceId: string, dir: string, file: { host: string; path: string }): boolean {
  const at = real(dir)
  const others = [at, workspaceId, file.host, file.path]
  return (
    ask(db, `SELECT 1 FROM work_files_copies WHERE dir = ? AND NOT (workspace_id = ? AND host = ? AND path = ?) LIMIT 1`, ...others) ||
    ask(db, `SELECT 1 FROM work_files_word WHERE doc LIKE ? || '/%' AND NOT (workspace_id = ? AND host = ? AND path = ?) LIMIT 1`, ...others)
  )
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
    // A copy that saves nowhere stays while it holds his edits (copyStays.ts); one with none goes.
    for (const r of db.prepare(`SELECT * FROM work_files_stays WHERE workspace_id = ?`).all(workspaceId) as unknown as StayRow[]) {
      if (stayEdited(r)) kept.add(r.dir)
      else db.prepare(`DELETE FROM work_files_stays WHERE workspace_id = ? AND host = ? AND path = ?`).run(r.workspace_id, r.host, r.path)
    }
    // A Word file's kept document whose folder is a copy's stays too: it holds his edits.
    for (const w of db.prepare(`SELECT doc FROM work_files_word WHERE workspace_id = ? AND doc IS NOT NULL`).all(workspaceId) as { doc: string }[]) kept.add(dirname(real(w.doc)))
  } catch {
    // no table: nothing was kept
  }
  return kept
}

/** A copy that saves nowhere (copyStays.ts): its record. */
export interface StayRow {
  workspace_id: string
  host: string
  path: string
  /** the copy's real path here, and its folder */
  copy: string
  dir: string
  /** the copy's size and change time as it was made */
  size: number
  mtime: number
  /** the kind its tab shows it in */
  kind: 'document' | 'sheet' | 'slides'
  /** the document an import made of it, and its change time as made */
  doc: string | null
  doc_at: number | null
  closed: number
  at: number
}

/** A file's size and change time (ms, rounded), or null when it is not there. */
export function timeOf(path: string): { size: number; mtime: number } | null {
  try {
    const s = statSync(path)
    return { size: s.size, mtime: Math.round(s.mtimeMs) }
  } catch {
    return null
  }
}

/**
 * Whether a copy that saves nowhere holds his edits: the document made of it, or the copy itself, is not as it was made.
 * A document an import made that the record never heard of counts as edited: unknown is kept.
 */
export function stayEdited(r: StayRow): boolean {
  if (r.doc) {
    const now = timeOf(r.doc)
    return now !== null && now.mtime !== r.doc_at
  }
  const now = timeOf(r.copy)
  if (now && (now.size !== r.size || now.mtime !== r.mtime)) return true
  try {
    return readdirSync(r.dir).some((name) => extname(name) === '.tcdoc')
  } catch {
    return false
  }
}

