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
 *  - `work_files_ops`: the journal behind operation ids, kept a week.
 *  - `work_files_names`: names this host has listed or found, for Go to.
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
  db.exec(`CREATE TABLE IF NOT EXISTS work_files_names (
    workspace_id TEXT NOT NULL, ref_key TEXT NOT NULL, ref TEXT NOT NULL, name TEXT NOT NULL,
    place TEXT NOT NULL, kind TEXT NOT NULL, changed INTEGER,
    PRIMARY KEY (workspace_id, ref_key))`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_files_names_by_place ON work_files_names (workspace_id, place)`)
}

export const FILES_TABLES = ['work_files_tabs', 'work_files_revs', 'work_files_marks', 'work_files_trash', 'work_files_ops', 'work_files_names'] as const
