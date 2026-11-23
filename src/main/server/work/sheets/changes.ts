import type { DatabaseSync } from 'node:sqlite'
import type { SheetChange } from '@shared/contract-work-sheets'
import type { Principal } from '@shared/work'
import type { PageAsk, TableAsk } from './acts'
import type { FormatAsk, RuleAsk } from './asks'
import type { Which } from './suggestions'

/**
 * Formats, rules and tables an agent proposed (sheet_format, sheet_rule, sheet_table, sheet_page), waiting for the owner. Kept in
 * this host's own database for every kind of sheet, a LifeOS sheet and a `.tcsheet` included:
 * nothing of one is written to the file, its folder, the Work service's live route or any store
 * others read until he takes it, and then it is laid as his own ordinary edit (index.ts).
 *
 * What is kept is the ask, not the mutations it would make: taking it runs the ask against the
 * sheet as it then stands, so a rule lands in the list as it is that day and not over it.
 */

export type ChangeAsk = { kind: 'format'; range: string; format: FormatAsk } | { kind: 'rule'; rule: RuleAsk } | { kind: 'table'; table: TableAsk } | { kind: 'page'; page: PageAsk }

export function ensureChangeTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_sheets_changes (
    store TEXT NOT NULL,
    id TEXT NOT NULL,
    change_set TEXT NOT NULL,
    by TEXT NOT NULL,
    reason TEXT,
    kind TEXT NOT NULL,
    sheet TEXT NOT NULL,
    range TEXT,
    words TEXT NOT NULL,
    ask TEXT NOT NULL,
    state TEXT NOT NULL,
    rev INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (store, id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS work_sheets_changes_open ON work_sheets_changes (store, state)')
}

interface Row {
  id: string
  change_set: string
  by: string
  reason: string | null
  kind: ChangeAsk['kind']
  sheet: string
  range: string | null
  words: string
  ask: string
  state: 'pending' | 'orphaned'
  rev: number
}

const OPEN = "('pending', 'orphaned')"

export interface OpenChange extends SheetChange {
  ask: ChangeAsk
  /** the sheet's revision the agent saw: taking the change is an edit made on it, moved through what landed since or dropped */
  rev: number
}

export class ChangeStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now
  ) {}

  /** The open changes with their asks: the host's own reading. */
  held(store: string): OpenChange[] {
    const rows = this.db.prepare(`SELECT * FROM work_sheets_changes WHERE store = ? AND state IN ${OPEN} ORDER BY at, rowid`).all(store) as unknown as Row[]
    return rows.map((r) => ({
      id: r.id,
      changeSet: r.change_set,
      by: r.by as Principal,
      kind: r.kind,
      sheet: r.sheet,
      range: r.range === null ? null : (JSON.parse(r.range) as SheetChange['range']),
      words: r.words,
      state: r.state,
      ...(r.reason ? { reason: r.reason } : {}),
      ask: JSON.parse(r.ask) as ChangeAsk,
      rev: r.rev
    }))
  }

  /** The open changes as the view carries them: no ask. */
  open(store: string): SheetChange[] {
    return this.held(store).map(({ ask: _ask, rev: _rev, ...change }) => change)
  }

  add(store: string, change: { id: string; changeSet: string; by: Principal; reason?: string; sheet: string; range: SheetChange['range']; words: string; ask: ChangeAsk; rev: number }): void {
    this.db
      .prepare(`INSERT INTO work_sheets_changes (store, id, change_set, by, reason, kind, sheet, range, words, ask, state, rev, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(store, change.id, change.changeSet, change.by, change.reason ?? null, change.ask.kind, change.sheet, change.range === null ? null : JSON.stringify(change.range), change.words, JSON.stringify(change.ask), change.rev, this.now())
  }

  pick(store: string, which: Which): OpenChange[] {
    const open = this.held(store)
    return which === 'all' ? open : 'ids' in which ? open.filter((c) => which.ids.includes(c.id)) : open.filter((c) => c.changeSet === which.changeSet)
  }

  /** Accepted and rejected are final. */
  mark(store: string, ids: readonly string[], state: 'accepted' | 'rejected' | 'orphaned'): void {
    const set = this.db.prepare(`UPDATE work_sheets_changes SET state = ? WHERE store = ? AND id = ? AND state IN ${OPEN}`)
    for (const id of ids) set.run(state, store, id)
  }

  /** Rows, columns or sheets changed, the file came back from outside or was restored: no waiting change is where the agent saw it for sure. */
  /** Drops what was taken or dropped (a shared sheet's decided asks hold its words; the database rides the backup). */
  prune(store: string): void {
    this.db.prepare(`DELETE FROM work_sheets_changes WHERE store = ? AND state NOT IN ${OPEN}`).run(store)
  }

  orphanAll(store: string): void {
    this.db.prepare(`UPDATE work_sheets_changes SET state = 'orphaned' WHERE store = ? AND state = 'pending'`).run(store)
  }

  /** How many changes wait in each of these stores, and when the latest was made: one indexed query. A store with none is absent. */
  openCounts(stores: readonly string[]): Map<string, { count: number; last: number }> {
    if (!stores.length) return new Map()
    const rows = this.db
      .prepare(`SELECT store, COUNT(*) AS n, MAX(at) AS last FROM work_sheets_changes WHERE state IN ${OPEN} AND store IN (${stores.map(() => '?').join(', ')}) GROUP BY store`)
      .all(...stores) as { store: string; n: number; last: number }[]
    return new Map(rows.map((r) => [r.store, { count: r.n, last: r.last }]))
  }

  /** The stores whose key starts with `prefix` that hold waiting changes, the latest first, `most` at most. */
  storesOpen(prefix: string, most: number): { store: string; count: number; last: number }[] {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const rows = this.db
      .prepare(`SELECT store, COUNT(*) AS n, MAX(at) AS last FROM work_sheets_changes WHERE state IN ${OPEN} AND store LIKE ? ESCAPE '\\' GROUP BY store ORDER BY last DESC LIMIT ?`)
      .all(like, most) as { store: string; n: number; last: number }[]
    return rows.map((r) => ({ store: r.store, count: r.n, last: r.last }))
  }

  forget(store: string): void {
    this.db.prepare('DELETE FROM work_sheets_changes WHERE store = ?').run(store)
  }
}
