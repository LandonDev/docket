import type { DatabaseSync } from 'node:sqlite'
import type { CanvasSource } from '@shared/work'
import type { FolderRef } from '@shared/work/files'

/**
 * His marks on files (`work_files_marks`, docs/agents/work-files.md "What sits where"): what he starred, what
 * he opened and when, and what a thread made and whether he has seen it. A row is keyed by the file's own key
 * (`refKey`), so a star is one star whichever computer answers for the file. The rows hold a name and where
 * the thing is, as a canvas item does; never a byte of it.
 */

/** What a mark points at: a file to open, or a folder to list. */
export type Marked = { file: CanvasSource } | { folder: FolderRef }

export interface Mark {
  key: string
  at: Marked
  name: string
  starred: boolean
  openedAt: number | null
  madeBy: string | null
  madeAt: number | null
  seenAt: number | null
}

interface Row {
  ref_key: string
  ref: string
  name: string
  starred: number
  opened_at: number | null
  made_by: string | null
  made_at: number | null
  seen_at: number | null
}

const COLUMNS = 'ref_key, ref, name, starred, opened_at, made_by, made_at, seen_at'

function mark(row: Row): Mark | null {
  let at: Marked
  try {
    at = JSON.parse(row.ref) as Marked
  } catch {
    return null
  }
  if (!at || typeof at !== 'object' || !('file' in at || 'folder' in at)) return null
  return { key: row.ref_key, at, name: row.name, starred: row.starred === 1, openedAt: row.opened_at, madeBy: row.made_by, madeAt: row.made_at, seenAt: row.seen_at }
}

/** How many recents a workspace keeps: older ones lose their time, and a row that says nothing more is dropped. */
export const RECENT_MOST = 200

export class MarkStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {}

  private upsert(workspaceId: string, key: string, at: Marked, name: string): void {
    this.db
      .prepare(`INSERT INTO work_files_marks (workspace_id, ref_key, ref, name) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, ref_key) DO UPDATE SET ref = excluded.ref, name = excluded.name`)
      .run(workspaceId, key, JSON.stringify(at), name)
  }

  /** A row that marks nothing any more goes. */
  private tidy(workspaceId: string, key: string): void {
    this.db.prepare(`DELETE FROM work_files_marks WHERE workspace_id = ? AND ref_key = ? AND starred = 0 AND opened_at IS NULL AND made_by IS NULL`).run(workspaceId, key)
  }

  star(workspaceId: string, key: string, at: Marked, name: string, on: boolean): boolean {
    this.upsert(workspaceId, key, at, name)
    this.db.prepare(`UPDATE work_files_marks SET starred = ? WHERE workspace_id = ? AND ref_key = ?`).run(on ? 1 : 0, workspaceId, key)
    this.tidy(workspaceId, key)
    return on
  }

  /** He opened it: it is recent, and no longer new from a thread. */
  seen(workspaceId: string, key: string, at: Marked, name: string): void {
    const now = this.now()
    this.upsert(workspaceId, key, at, name)
    this.db.prepare(`UPDATE work_files_marks SET opened_at = ?, seen_at = ? WHERE workspace_id = ? AND ref_key = ?`).run(now, now, workspaceId, key)
    // Past the most kept, the oldest lose their place in Recent.
    const cut = this.db.prepare(`SELECT opened_at FROM work_files_marks WHERE workspace_id = ? AND opened_at IS NOT NULL ORDER BY opened_at DESC LIMIT 1 OFFSET ?`).get(workspaceId, RECENT_MOST) as { opened_at: number } | undefined
    if (cut) {
      this.db.prepare(`UPDATE work_files_marks SET opened_at = NULL WHERE workspace_id = ? AND opened_at <= ?`).run(workspaceId, cut.opened_at)
      this.db.prepare(`DELETE FROM work_files_marks WHERE workspace_id = ? AND starred = 0 AND opened_at IS NULL AND made_by IS NULL`).run(workspaceId)
    }
  }

  private all(sql: string, ...args: (string | number)[]): Mark[] {
    return (this.db.prepare(sql).all(...args) as unknown as Row[]).flatMap((row) => mark(row) ?? [])
  }

  /** What he starred, by name. */
  starred(workspaceId: string): Mark[] {
    return this.all(`SELECT ${COLUMNS} FROM work_files_marks WHERE workspace_id = ? AND starred = 1 ORDER BY name COLLATE NOCASE`, workspaceId)
  }

  /** What he opened, newest first. */
  recent(workspaceId: string, most = 50): Mark[] {
    return this.all(`SELECT ${COLUMNS} FROM work_files_marks WHERE workspace_id = ? AND opened_at IS NOT NULL ORDER BY opened_at DESC LIMIT ?`, workspaceId, most)
  }

  /** The marks of these keys, by key: what a page of rows asks before it is shown. */
  of(workspaceId: string, keys: readonly string[]): Map<string, Mark> {
    const out = new Map<string, Mark>()
    const get = this.db.prepare(`SELECT ${COLUMNS} FROM work_files_marks WHERE workspace_id = ? AND ref_key = ?`)
    for (const key of keys) {
      const row = get.get(workspaceId, key) as Row | undefined
      const m = row ? mark(row) : null
      if (m) out.set(key, m)
    }
    return out
  }

  removeWorkspace(workspaceId: string): void {
    this.db.prepare(`DELETE FROM work_files_marks WHERE workspace_id = ?`).run(workspaceId)
  }
}
