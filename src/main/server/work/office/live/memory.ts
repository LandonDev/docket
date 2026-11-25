import type { DatabaseSync } from 'node:sqlite'
import type { OfficeLiveMode } from '@shared/contract-work-office'

export function ensureLiveTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_office_live (
    workspace_id TEXT NOT NULL, ref_key TEXT NOT NULL, mode TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, ref_key)
  )`)
}

export function libraryDefault(db: DatabaseSync, libraryId: string): OfficeLiveMode {
  const row = db.prepare('SELECT value FROM work_office_files WHERE key = ?').get(`live:${libraryId}`)
  return row?.value === 'live' ? 'live' : 'here'
}

export function setLibraryDefault(db: DatabaseSync, libraryId: string, mode: OfficeLiveMode): void {
  db.prepare('INSERT OR REPLACE INTO work_office_files (key, value) VALUES (?, ?)').run(`live:${libraryId}`, mode)
}

export function modeOf(db: DatabaseSync, workspaceId: string, refKey: string, libraryId: string | null, fallback?: OfficeLiveMode): OfficeLiveMode {
  const row = db.prepare('SELECT mode FROM work_office_live WHERE workspace_id = ? AND ref_key = ?').get(workspaceId, refKey)
  return row?.mode === 'here' || row?.mode === 'live' ? row.mode : fallback ?? (libraryId === null ? 'here' : libraryDefault(db, libraryId))
}

export function setMode(db: DatabaseSync, workspaceId: string, refKey: string, mode: OfficeLiveMode): void {
  db.prepare(`INSERT INTO work_office_live (workspace_id, ref_key, mode, at) VALUES (?, ?, ?, ?)
    ON CONFLICT (workspace_id, ref_key) DO UPDATE SET mode = excluded.mode, at = excluded.at`).run(workspaceId, refKey, mode, Date.now())
}

/**
 * The file's version as its tab went live (switch.ts): Edit here waits for the file to move from it. Kept beside the
 * library defaults, so it pins no mode; null when none was read (gone, not answering, or a tab from an older build).
 */
const baseKey = (workspaceId: string, refKey: string): string => `base\t${workspaceId}\t${refKey}`
export function liveBase(db: DatabaseSync, workspaceId: string, refKey: string): string | null {
  const row = db.prepare('SELECT value FROM work_office_files WHERE key = ?').get(baseKey(workspaceId, refKey))
  return typeof row?.value === 'string' ? row.value : null
}

export function setLiveBase(db: DatabaseSync, workspaceId: string, refKey: string, base: string | null): void {
  if (base === null) db.prepare('DELETE FROM work_office_files WHERE key = ?').run(baseKey(workspaceId, refKey))
  else db.prepare('INSERT OR REPLACE INTO work_office_files (key, value) VALUES (?, ?)').run(baseKey(workspaceId, refKey), base)
}

/** A removed workspace's remembered modes go with it (made first: a host may remove a workspace before the module's first start). */
export function dropWorkspaceModes(db: DatabaseSync, workspaceId: string): void {
  ensureLiveTables(db)
  db.exec('CREATE TABLE IF NOT EXISTS work_office_files (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('DELETE FROM work_office_live WHERE workspace_id = ?').run(workspaceId)
  db.prepare(`DELETE FROM work_office_files WHERE substr(key, 1, ?) = ?`).run(`base\t${workspaceId}\t`.length, `base\t${workspaceId}\t`)
}
