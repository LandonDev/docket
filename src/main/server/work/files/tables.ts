import type { DatabaseSync } from 'node:sqlite'

/**
 * The files pillar's tables (docs/agents/work-files.md "What sits where"), each additive and defaulted. They
 * hold names and places of files, as `work_canvas_items` does; no bytes and no picture of a file is kept in
 * the database.
 *
 *  - `work_files_tabs`: the workspace's open tabs in one ordered list, page tabs and file tabs. A file tab's
 *    `item_id` is its canvas item in the workspace's Files pane. `page` is JSON: where a page tab stands, or a
 *    file tab's name and key.
 *  - `work_files_revs`: the workspace-wide revision every tab change bumps, kept apart so it never goes back
 *    when the last tab closes.
 *  - `work_files_marks`: stars, what he opened and when, and what a thread made and whether he has seen it.
 *  - `work_files_trash`: the Trash list. A workspace-folder file's bytes wait under
 *    `<userData>/work-files/trash/<workspaceId>/<id>/`; a row for a provider's own bin holds none.
 *  - `work_files_ops`: the journal behind operation ids, kept a week, with the thread whose tool ran each (`session_id`).
 *  - `work_files_names`: names this host has listed or found, for Go to.
 *  - `work_files_kept`: a mail's file he kept (`mail:<message>:<part>`), and where the copy went, so From mail
 *    and Home's Waiting on you leave it out.
 *  - `work_files_copies`: a Files tab's copy of a file on another computer (or in the Windows VM) whose kind
 *    saves, and where the file itself lies: its host and path there, its version and the sha256 of the bytes it
 *    holds as last read or written (`sent`), the copy's path here and its folder, and how sending it back stands (copies.ts).
 *    `closed`: its tab closed with changes not yet sent; the copy is kept until they are.
 *  - `work_files_word`: a Word file of another computer (or the Windows VM) opened in a Files tab, and the document
 *    made of it in the workspace's own folder (`doc`), where his edits are kept (word.ts): the file's version as
 *    read or last written, the document's change time when made (`doc_at`) and when last saved as Word.
 */
export function ensureFilesTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_files_tabs (
    workspace_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL,
    page TEXT NOT NULL DEFAULT '{}', item_id TEXT, opener TEXT,
    rev INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, id))`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_files_tabs_by_position ON work_files_tabs (workspace_id, position)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_files_revs (workspace_id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_files_marks (
    workspace_id TEXT NOT NULL, ref_key TEXT NOT NULL, ref TEXT NOT NULL, name TEXT NOT NULL,
    starred INTEGER NOT NULL DEFAULT 0, opened_at INTEGER, made_by TEXT, made_at INTEGER, seen_at INTEGER,
    PRIMARY KEY (workspace_id, ref_key))`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_files_trash (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, ref TEXT NOT NULL, name TEXT NOT NULL,
    place TEXT NOT NULL, was_at TEXT NOT NULL, state TEXT NOT NULL,
    held_at INTEGER, deleted_at INTEGER NOT NULL, by TEXT NOT NULL, provider TEXT)`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_files_trash_by_workspace ON work_files_trash (workspace_id, state, deleted_at)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_files_ops (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, verb TEXT NOT NULL, refs TEXT NOT NULL,
    state TEXT NOT NULL, result TEXT, at INTEGER NOT NULL)`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_files_ops_by_time ON work_files_ops (at)`)
  // The thread whose files_* tool ran an op: files_undo undoes only the caller's own. Added to an older table.
  if (!(db.prepare(`SELECT name FROM pragma_table_info('work_files_ops')`).all() as { name: string }[]).some((c) => c.name === 'session_id')) db.exec(`ALTER TABLE work_files_ops ADD COLUMN session_id TEXT`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_files_names (
    workspace_id TEXT NOT NULL, ref_key TEXT NOT NULL, ref TEXT NOT NULL, name TEXT NOT NULL,
    place TEXT NOT NULL, kind TEXT NOT NULL, changed INTEGER,
    PRIMARY KEY (workspace_id, ref_key))`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_files_names_by_place ON work_files_names (workspace_id, place)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_files_kept (
    workspace_id TEXT NOT NULL, ref_key TEXT NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, ref_key))`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_files_copies (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, vm INTEGER NOT NULL DEFAULT 0,
    copy TEXT NOT NULL, dir TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL, sent TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ok', detail TEXT, saved_at INTEGER, changed_at INTEGER, closed INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL, UNIQUE (workspace_id, host, path))`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_files_copies_by_dir ON work_files_copies (dir)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_files_word (
    workspace_id TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, vm INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL,
    version TEXT NOT NULL, doc TEXT, doc_at INTEGER, saved_at INTEGER, saved_doc_at INTEGER, at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, host, path))`)
}

export const FILES_TABLES = ['work_files_tabs', 'work_files_revs', 'work_files_marks', 'work_files_trash', 'work_files_ops', 'work_files_names', 'work_files_kept', 'work_files_copies', 'work_files_word'] as const
