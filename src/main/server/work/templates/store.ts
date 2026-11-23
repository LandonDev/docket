import { sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/**
 * What the templates pillar keeps in the database
 * (docs/agents/work-templates.md "The shelf"): each template file's fields
 * by its path, size and time, so a file is opened only when it changed, and
 * the starters he hid in each workspace. The files themselves are the
 * shelf; these rows can be dropped and are made again.
 */

export function ensureTemplatesTables(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS work_templates_index (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, fields TEXT NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS work_templates_hidden (workspace_id TEXT NOT NULL, starter TEXT NOT NULL, PRIMARY KEY (workspace_id, starter))')
}

export class TemplatesStore {
  constructor(private readonly db: DatabaseSync) {}

  /** The fields kept for a file as it is now; null when it changed since, or was never read. */
  fields(path: string, size: number, mtime: number): string[] | null {
    const row = this.db.prepare('SELECT size, mtime, fields FROM work_templates_index WHERE path = ?').get(path) as { size: number; mtime: number; fields: string } | undefined
    if (!row || row.size !== size || row.mtime !== mtime) return null
    try {
      const fields = JSON.parse(row.fields) as unknown
      return Array.isArray(fields) && fields.every((f) => typeof f === 'string') ? fields : null
    } catch {
      return null
    }
  }

  keep(path: string, size: number, mtime: number, fields: readonly string[]): void {
    this.db.prepare('INSERT INTO work_templates_index (path, size, mtime, fields) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, fields = excluded.fields').run(path, size, mtime, JSON.stringify(fields))
  }

  /** Drops the rows of a folder's files that are no longer there. */
  prune(dir: string, present: ReadonlySet<string>): void {
    const rows = this.db.prepare('SELECT path FROM work_templates_index WHERE substr(path, 1, ?) = ?').all(dir.length + 1, `${dir}${sep}`) as { path: string }[]
    for (const { path } of rows) if (!present.has(path) && !path.slice(dir.length + 1).includes(sep)) this.db.prepare('DELETE FROM work_templates_index WHERE path = ?').run(path)
  }

  /** The starters hidden in a workspace, by key (`<sector>/<slug>`). */
  hidden(workspaceId: string): Set<string> {
    return new Set((this.db.prepare('SELECT starter FROM work_templates_hidden WHERE workspace_id = ?').all(workspaceId) as { starter: string }[]).map((r) => r.starter))
  }

  hide(workspaceId: string, starter: string): void {
    this.db.prepare('INSERT OR IGNORE INTO work_templates_hidden (workspace_id, starter) VALUES (?, ?)').run(workspaceId, starter)
  }

  unhide(workspaceId: string): void {
    this.db.prepare('DELETE FROM work_templates_hidden WHERE workspace_id = ?').run(workspaceId)
  }

  /** A workspace was deleted: its hidden rows go, and the index rows of its own Templates folder. */
  workspaceRemoved(workspaceId: string, templatesDir?: string): void {
    this.unhide(workspaceId)
    if (templatesDir) this.prune(templatesDir, new Set())
  }
}
