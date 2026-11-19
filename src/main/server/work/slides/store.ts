import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SlideOpSchema, type DeckMode, type SlideOp } from '@shared/contract-work-slides'
import type { Principal } from '@shared/work'
import { registerMoveModule, tableMoveModule } from '../../sessionMove'

/**
 * What this host keeps beside a deck (docs/agents/work-slides.md "The
 * store"): the edits an agent proposed that the owner has not settled, in
 * the order they were made, and the item's mode and last direct write. The
 * deck itself is the .pptx file; copies of it before each write are files
 * in the item's folder.
 */

export function ensureSlidesTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_slides_items (
    item_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'suggests', written TEXT,
    updated_at INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_slides_ops (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, session_id TEXT NOT NULL,
    seq INTEGER NOT NULL, slide INTEGER NOT NULL, op TEXT NOT NULL,
    by TEXT NOT NULL, at INTEGER NOT NULL)`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_slides_ops_by_item ON work_slides_ops (item_id, seq)`)
  registerMoveModule(db, tableMoveModule('slides-items', 'work_slides_items'))
  registerMoveModule(db, tableMoveModule('slides-ops', 'work_slides_ops'))
}

/** One pending edit: the op, whose slide it belongs to, and who proposed it. */
export interface PendingOp {
  id: string
  /** the slide the stepper counts it under */
  slide: number
  op: SlideOp
  by: Principal
}

/** The agent's last direct write: the copy to put back, and what the file's bytes were after it. */
export interface DeckWrite {
  id: string
  text: string
  at: number
  /** the file's name in the item's `history/` folder */
  before: string
  /** sha256 of the file after the write: an Undo is refused once the file has changed again */
  after: string
}

export class SlidesStore {
  constructor(private readonly db: DatabaseSync) {}

  private touch(itemId: string, sessionId: string): void {
    this.db.prepare(`INSERT INTO work_slides_items (item_id, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET updated_at = excluded.updated_at`).run(itemId, sessionId, Date.now())
  }

  private item(itemId: string): { mode: string; written: string | null } | undefined {
    return this.db.prepare(`SELECT mode, written FROM work_slides_items WHERE item_id = ?`).get(itemId) as { mode: string; written: string | null } | undefined
  }

  mode(itemId: string): DeckMode {
    return this.item(itemId)?.mode === 'writes' ? 'writes' : 'suggests'
  }

  setMode(itemId: string, sessionId: string, mode: DeckMode): void {
    this.touch(itemId, sessionId)
    this.db.prepare(`UPDATE work_slides_items SET mode = ? WHERE item_id = ?`).run(mode, itemId)
  }

  written(itemId: string): DeckWrite | null {
    const raw = this.item(itemId)?.written
    if (!raw) return null
    try {
      return JSON.parse(raw) as DeckWrite
    } catch {
      return null
    }
  }

  setWritten(itemId: string, sessionId: string, write: DeckWrite | null): void {
    this.touch(itemId, sessionId)
    this.db.prepare(`UPDATE work_slides_items SET written = ? WHERE item_id = ?`).run(write ? JSON.stringify(write) : null, itemId)
  }

  /** The pending edits, oldest first. A row that no longer parses is left out. */
  pending(itemId: string): PendingOp[] {
    const rows = this.db.prepare(`SELECT id, slide, op, by FROM work_slides_ops WHERE item_id = ? ORDER BY seq`).all(itemId) as unknown as Array<{ id: string; slide: number; op: string; by: string }>
    return rows.flatMap((row) => {
      try {
        return [{ id: row.id, slide: row.slide, op: SlideOpSchema.parse(JSON.parse(row.op)), by: row.by as Principal }]
      } catch {
        return []
      }
    })
  }

  add(itemId: string, sessionId: string, ops: ReadonlyArray<{ slide: number; op: SlideOp }>, by: Principal): void {
    const next = (this.db.prepare(`SELECT max(seq) AS n FROM work_slides_ops WHERE item_id = ?`).get(itemId) as { n: number | null }).n ?? 0
    const st = this.db.prepare(`INSERT INTO work_slides_ops (id, item_id, session_id, seq, slide, op, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    ops.forEach((o, i) => st.run(randomUUID(), itemId, sessionId, next + 1 + i, o.slide, JSON.stringify(o.op), by, Date.now()))
    this.touch(itemId, sessionId)
  }

  /** Drops pending edits by id: they were written into the file, or rejected. */
  drop(itemId: string, ids: readonly string[]): void {
    const st = this.db.prepare(`DELETE FROM work_slides_ops WHERE item_id = ? AND id = ?`)
    for (const id of ids) st.run(itemId, id)
  }

  /** Rewrites pending edits in place (an anchor that named a slide which is not coming). */
  rewrite(itemId: string, ops: readonly PendingOp[]): void {
    const st = this.db.prepare(`UPDATE work_slides_ops SET op = ? WHERE item_id = ? AND id = ?`)
    for (const o of ops) st.run(JSON.stringify(o.op), itemId, o.id)
  }

  removeSessions(ids: readonly string[]): void {
    for (const table of ['work_slides_items', 'work_slides_ops']) {
      const st = this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`)
      for (const id of ids) st.run(id)
    }
  }
}
