import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SlideOpSchema, type DeckMode, type SlideOp } from '@shared/contract-work-slides'
import type { Principal } from '@shared/work'
import { registerMoveModule, tableMoveModule } from '../../sessionMove'

/**
 * What this host keeps beside a deck (docs/agents/work-slides.md "The
 * store"): the edits an agent proposed that the owner has not settled, in
 * the order they were made, and the deck's mode and last direct write. The
 * deck itself is the .pptx file; copies of it before each write are files
 * in the deck's folder.
 *
 * **Kept by the deck, not the item** (`deckKey`, view.ts): a file on this
 * host is one deck whichever canvas items show it (a thread's canvas and a
 * Files tab at once), so they share one list of waiting edits, one last
 * write and one queue. The key is `file:<real path>` for a file, and the
 * item's own id for a deck only that item can hold (one a thread made, a
 * mail's attachment). The column that holds it is still named `item_id`:
 * the rows of an item-keyed deck from before are found under its item id
 * and moved to its key the first time it is opened (`seat`). `session_id`
 * is the thread for an item's own deck, so its rows go and move with the
 * thread, and empty for a file's, whose rows belong to no thread.
 *
 * **The mode is the seat's, not the deck's.** "Agent writes" is a leave he
 * gives an agent in one tab; kept by the file it would reach every thread
 * that ever opens that file. So each seat has its own mode, as each item
 * had before, and a seat that goes takes its mode with it.
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
  // Which canvas items show which deck: every seat on a deck is told when it changes, and a file's rows are let go with its last seat where they must be.
  // `mode`: what an agent may do to the deck from this tab. `shared`: this seat's source is one others can open.
  db.exec(`CREATE TABLE IF NOT EXISTS work_slides_seats (item_id TEXT PRIMARY KEY, deck TEXT NOT NULL, session_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'suggests', shared INTEGER NOT NULL DEFAULT 0)`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_slides_seats_by_deck ON work_slides_seats (deck)`)
  registerMoveModule(db, tableMoveModule('slides-items', 'work_slides_items'))
  registerMoveModule(db, tableMoveModule('slides-ops', 'work_slides_ops'))
}

/** The thread a deck's rows belong to: the item's for a deck only it can hold, none for a file. */
export const rowSession = (deck: string, sessionId: string): string => (deck.startsWith('file:') ? '' : sessionId)

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
  /** the canvas item the write was made from: for a file others can open, the copy from before is in that item's folder alone */
  item?: string
}

export class SlidesStore {
  constructor(private readonly db: DatabaseSync) {}

  private touch(deck: string, sessionId: string): void {
    this.db.prepare(`INSERT INTO work_slides_items (item_id, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET updated_at = excluded.updated_at`).run(deck, sessionId, Date.now())
  }

  private item(deck: string): { mode: string; written: string | null } | undefined {
    return this.db.prepare(`SELECT mode, written FROM work_slides_items WHERE item_id = ?`).get(deck) as { mode: string; written: string | null } | undefined
  }

  /** What an agent may do to the deck from this canvas item: the seat's own, `suggests` until he says otherwise there. */
  mode(itemId: string): DeckMode {
    const row = this.db.prepare(`SELECT mode FROM work_slides_seats WHERE item_id = ?`).get(itemId) as { mode: string } | undefined
    return row?.mode === 'writes' ? 'writes' : 'suggests'
  }

  /** Sets the mode of an item that has taken its seat (`seat`). */
  setMode(itemId: string, mode: DeckMode): void {
    this.db.prepare(`UPDATE work_slides_seats SET mode = ? WHERE item_id = ?`).run(mode, itemId)
  }

  written(deck: string): DeckWrite | null {
    const raw = this.item(deck)?.written
    if (!raw) return null
    try {
      return JSON.parse(raw) as DeckWrite
    } catch {
      return null
    }
  }

  setWritten(deck: string, sessionId: string, write: DeckWrite | null): void {
    this.touch(deck, sessionId)
    this.db.prepare(`UPDATE work_slides_items SET written = ? WHERE item_id = ?`).run(write ? JSON.stringify(write) : null, deck)
  }

  /** The pending edits, oldest first. A row that no longer parses is left out. */
  pending(deck: string): PendingOp[] {
    const rows = this.db.prepare(`SELECT id, slide, op, by FROM work_slides_ops WHERE item_id = ? ORDER BY seq`).all(deck) as unknown as Array<{ id: string; slide: number; op: string; by: string }>
    return rows.flatMap((row) => {
      try {
        return [{ id: row.id, slide: row.slide, op: SlideOpSchema.parse(JSON.parse(row.op)), by: row.by as Principal }]
      } catch {
        return []
      }
    })
  }

  add(deck: string, sessionId: string, ops: ReadonlyArray<{ slide: number; op: SlideOp }>, by: Principal): void {
    const next = (this.db.prepare(`SELECT max(seq) AS n FROM work_slides_ops WHERE item_id = ?`).get(deck) as { n: number | null }).n ?? 0
    const st = this.db.prepare(`INSERT INTO work_slides_ops (id, item_id, session_id, seq, slide, op, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    ops.forEach((o, i) => st.run(randomUUID(), deck, sessionId, next + 1 + i, o.slide, JSON.stringify(o.op), by, Date.now()))
    this.touch(deck, sessionId)
  }

  /** Drops pending edits by id: they were written into the file, or rejected. */
  drop(deck: string, ids: readonly string[]): void {
    const st = this.db.prepare(`DELETE FROM work_slides_ops WHERE item_id = ? AND id = ?`)
    for (const id of ids) st.run(deck, id)
  }

  /** Rewrites pending edits in place (an anchor that named a slide which is not coming). */
  rewrite(deck: string, ops: readonly PendingOp[]): void {
    const st = this.db.prepare(`UPDATE work_slides_ops SET op = ? WHERE item_id = ? AND id = ?`)
    for (const o of ops) st.run(JSON.stringify(o.op), deck, o.id)
  }

  /**
   * Threads were removed: the rows of the decks only they held go, and so does every edit one of their agents
   * left waiting on a file (a file's rows belong to no thread, but a suggestion is its thread's: nobody is left
   * to answer for it). Answers each deck that lost a seat, with how many it has left and whether any seat on it,
   * gone or staying, was on a source others can open: the caller lets go of what a deck with no seat must not keep.
   */
  removeSessions(ids: readonly string[]): Array<{ deck: string; left: number; shared: boolean }> {
    const lost = new Map<string, boolean>()
    const seated = this.db.prepare(`SELECT deck, shared FROM work_slides_seats WHERE session_id = ?`)
    for (const id of ids) if (id) for (const row of seated.all(id) as unknown as Array<{ deck: string; shared: number }>) lost.set(row.deck, (lost.get(row.deck) ?? false) || row.shared === 1)
    for (const table of ['work_slides_items', 'work_slides_ops', 'work_slides_seats']) {
      const st = this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`)
      for (const id of ids) if (id) st.run(id)
    }
    const by = this.db.prepare(`DELETE FROM work_slides_ops WHERE by LIKE ? ESCAPE '\\'`)
    for (const id of ids) if (id) by.run(`agent:%:${id.replace(/[\\%_]/g, '\\$&')}`)
    return [...lost].map(([deck, shared]) => ({ deck, left: this.seats(deck).length, shared: shared || this.sharedDeck(deck) }))
  }

  /** Everything kept for a deck: its last write and its waiting edits. */
  removeDeck(deck: string): void {
    this.db.prepare(`DELETE FROM work_slides_items WHERE item_id = ?`).run(deck)
    this.db.prepare(`DELETE FROM work_slides_ops WHERE item_id = ?`).run(deck)
  }

  /**
   * An item takes its seat on a deck, saying whether its source is one others can open. Rows kept under the
   * item's own id from before decks were kept by the file move to the deck's key, once: its mode becomes the
   * seat's, its waiting edits join the deck's after those already there, and its last write is the deck's unless
   * the deck already has one.
   */
  seat(itemId: string, sessionId: string, deck: string, shared = false): void {
    const was = this.db.prepare(`SELECT deck, shared FROM work_slides_seats WHERE item_id = ?`).get(itemId) as { deck: string; shared: number } | undefined
    if (was?.deck === deck) {
      if ((was.shared === 1) !== shared) this.db.prepare(`UPDATE work_slides_seats SET shared = ? WHERE item_id = ?`).run(shared ? 1 : 0, itemId)
      return
    }
    // The mode it had as an item, from before modes were kept by the seat.
    const old = was ? undefined : this.item(itemId)
    this.db
      .prepare(`INSERT INTO work_slides_seats (item_id, deck, session_id, mode, shared) VALUES (?, ?, ?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET deck = excluded.deck, session_id = excluded.session_id, shared = excluded.shared`)
      .run(itemId, deck, sessionId, old?.mode === 'writes' ? 'writes' : 'suggests', shared ? 1 : 0)
    if (deck === itemId) return
    const session = rowSession(deck, sessionId)
    const has = (table: string, key: string): boolean => this.db.prepare(`SELECT 1 FROM ${table} WHERE item_id = ? LIMIT 1`).get(key) !== undefined
    if (has('work_slides_items', itemId)) {
      if (has('work_slides_items', deck)) this.db.prepare(`DELETE FROM work_slides_items WHERE item_id = ?`).run(itemId)
      else this.db.prepare(`UPDATE work_slides_items SET item_id = ?, session_id = ? WHERE item_id = ?`).run(deck, session, itemId)
    }
    if (has('work_slides_ops', itemId)) {
      const after = (this.db.prepare(`SELECT max(seq) AS n FROM work_slides_ops WHERE item_id = ?`).get(deck) as { n: number | null }).n ?? 0
      this.db.prepare(`UPDATE work_slides_ops SET item_id = ?, session_id = ?, seq = seq + ? WHERE item_id = ?`).run(deck, session, after, itemId)
    }
  }

  /** The items seated on a deck. */
  seats(deck: string): Array<{ itemId: string; sessionId: string; shared: boolean }> {
    return (this.db.prepare(`SELECT item_id, session_id, shared FROM work_slides_seats WHERE deck = ? ORDER BY item_id`).all(deck) as unknown as Array<{ item_id: string; session_id: string; shared: number }>).map((r) => ({
      itemId: r.item_id,
      sessionId: r.session_id,
      shared: r.shared === 1
    }))
  }

  /** Whether any seat on the deck is on a source others can open: the deck is then theirs too, whichever seat asks. */
  sharedDeck(deck: string): boolean {
    return this.db.prepare(`SELECT 1 FROM work_slides_seats WHERE deck = ? AND shared = 1 LIMIT 1`).get(deck) !== undefined
  }

  /** An item left: its seat goes; answers the deck it sat on, how many seats that deck has left, and whether any seat on it (this one included) was shared. */
  unseat(itemId: string): { deck: string; left: number; shared: boolean } | null {
    const was = this.db.prepare(`SELECT deck, shared FROM work_slides_seats WHERE item_id = ?`).get(itemId) as { deck: string; shared: number } | undefined
    if (!was) return null
    this.db.prepare(`DELETE FROM work_slides_seats WHERE item_id = ?`).run(itemId)
    return { deck: was.deck, left: this.seats(was.deck).length, shared: was.shared === 1 || this.sharedDeck(was.deck) }
  }

  /**
   * A file was renamed or moved: its deck's rows and seats take the new key. Rows already under the new key (a
   * deck that was there) are replaced. A key with nothing kept under it changes nothing: renaming a link to a
   * deck must not wipe the deck's own rows.
   */
  rekey(from: string, to: string): void {
    if (from === to) return
    const any = (table: string, column: string): boolean => this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(from) !== undefined
    if (!any('work_slides_items', 'item_id') && !any('work_slides_ops', 'item_id') && !any('work_slides_seats', 'deck')) return
    for (const table of ['work_slides_items', 'work_slides_ops']) {
      this.db.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(to)
      this.db.prepare(`UPDATE ${table} SET item_id = ? WHERE item_id = ?`).run(to, from)
    }
    this.db.prepare(`UPDATE work_slides_seats SET deck = ? WHERE deck = ?`).run(to, from)
  }
}
