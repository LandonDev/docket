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
