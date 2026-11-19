import type { DatabaseSync } from 'node:sqlite'
import type { SheetCellJson, SheetSuggestion, SheetSuggestionState, SheetWritten } from '@shared/contract-work-sheets'
import type { Principal } from '@shared/work'
import { hashCells } from 'work-kit/sheet/source'

/**
 * Suggestions over sheets this host holds with no LifeOS row: an opened
 * package now, an Excel workbook (M28) and a Google sheet (M30) later
 * (architecture §3.1). One row per cell, in work-kit's `SuggestionRow` names,
 * under the store it is about (`file:<path>`, …). A LifeOS sheet's live in
 * LifeOS, a `.tcsheet`'s inside the file.
 *
 * Beside them, per store: what an agent does on its own idea (`mode`) and
 * what it last wrote directly (`written`, for the bar's Undo).
 */

export function ensureSuggestionTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_sheets_suggestions (
    store TEXT NOT NULL,
    id TEXT NOT NULL,
    change_set TEXT NOT NULL,
    by TEXT NOT NULL,
    reason TEXT,
    sheet TEXT NOT NULL,
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    base TEXT,
    proposed TEXT,
    base_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (store, id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS work_sheets_suggestions_open ON work_sheets_suggestions (store, state)')
  db.exec(`CREATE TABLE IF NOT EXISTS work_sheets_prefs (
    store TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'writes',
    written TEXT
  )`)
}

interface Row {
  id: string
  change_set: string
  by: string
  reason: string | null
  sheet: string
  row: number
  col: number
  base: string | null
  proposed: string | null
  state: SheetSuggestionState
}

const OPEN = "('pending', 'conflict', 'orphaned')"
const parse = (s: string | null): SheetCellJson | null => (s === null ? null : (JSON.parse(s) as SheetCellJson))
const content = (c: SheetCellJson | null): { f?: string; v?: unknown } => (c === null ? {} : c.f ? { f: c.f } : c.v === undefined ? {} : { v: c.v })

export type Which = { ids: string[] } | { changeSet: string } | 'all'

export class SuggestionStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now
  ) {}

  open(store: string): SheetSuggestion[] {
    const rows = this.db.prepare(`SELECT * FROM work_sheets_suggestions WHERE store = ? AND state IN ${OPEN} ORDER BY sheet, row, col`).all(store) as unknown as Row[]
    return rows.map((r) => ({
      id: r.id,
      changeSet: r.change_set,
      by: r.by as Principal,
      sheet: r.sheet,
      row: r.row,
      col: r.col,
      base: parse(r.base),
      proposed: parse(r.proposed),
      state: r.state,
      ...(r.reason ? { reason: r.reason } : {})
    }))
  }

  /** One change set: a later suggestion on a cell still open replaces the earlier one there. */
  add(store: string, changeSet: string, by: Principal, reason: string | undefined, cells: readonly { sheet: string; row: number; col: number; base: SheetCellJson | null; proposed: SheetCellJson | null }[]): number {
    const drop = this.db.prepare(`UPDATE work_sheets_suggestions SET state = 'rejected' WHERE store = ? AND sheet = ? AND row = ? AND col = ? AND state IN ${OPEN}`)
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO work_sheets_suggestions (store, id, change_set, by, reason, sheet, row, col, base, proposed, base_hash, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    for (const c of cells) {
      drop.run(store, c.sheet, c.row, c.col)
      put.run(store, `${changeSet}:${c.sheet}:${c.row}:${c.col}`, changeSet, by, reason ?? null, c.sheet, c.row, c.col, c.base === null ? null : JSON.stringify(c.base), c.proposed === null ? null : JSON.stringify(c.proposed), hashCells([content(c.base) as never]), this.now())
    }
    return cells.length
  }

  /** Marks the decision and answers the cells decided, in sheet order. Accepting a conflicted or orphaned cell is refused. */
  decide(store: string, which: Which, verdict: 'accept' | 'reject'): SheetSuggestion[] {
    const open = this.open(store)
    const picked = which === 'all' ? open : 'ids' in which ? open.filter((s) => which.ids.includes(s.id)) : open.filter((s) => s.changeSet === which.changeSet)
    const taken = verdict === 'accept' ? picked.filter((s) => s.state === 'pending') : picked
    if (verdict === 'accept' && 'ids' in (which as object) && taken.length < picked.length) throw new Error('That cell changed since the agent saw it: reject it, or edit the cell yourself.')
    const set = this.db.prepare('UPDATE work_sheets_suggestions SET state = ? WHERE store = ? AND id = ?')
    for (const s of taken) set.run(verdict === 'accept' ? 'accepted' : 'rejected', store, s.id)
    return taken
  }

  /** The owner or another writer changed these cells (`sheet:row:col`): a pending suggestion there no longer holds. */
  conflictOn(store: string, touched: ReadonlySet<string>): void {
    if (!touched.size) return
    const set = this.db.prepare("UPDATE work_sheets_suggestions SET state = 'conflict' WHERE store = ? AND id = ?")
    for (const s of this.open(store)) if (s.state === 'pending' && touched.has(`${s.sheet}:${s.row}:${s.col}`)) set.run(store, s.id)
  }

  /** The file came back from outside or was restored: no cell is where the agent saw it for sure. */
  orphanAll(store: string): void {
    this.db.prepare(`UPDATE work_sheets_suggestions SET state = 'orphaned' WHERE store = ? AND state IN ${OPEN}`).run(store)
  }

  mode(store: string): 'suggests' | 'writes' {
    return ((this.db.prepare('SELECT mode FROM work_sheets_prefs WHERE store = ?').get(store) as { mode?: string } | undefined)?.mode as 'suggests' | 'writes' | undefined) ?? 'writes'
  }
  setMode(store: string, mode: 'suggests' | 'writes'): void {
    this.db.prepare('INSERT INTO work_sheets_prefs (store, mode) VALUES (?, ?) ON CONFLICT (store) DO UPDATE SET mode = excluded.mode').run(store, mode)
  }
  written(store: string): SheetWritten | undefined {
    const r = this.db.prepare('SELECT written FROM work_sheets_prefs WHERE store = ?').get(store) as { written: string | null } | undefined
    return r?.written ? (JSON.parse(r.written) as SheetWritten) : undefined
  }
  setWritten(store: string, w: SheetWritten | null): void {
    this.db.prepare("INSERT INTO work_sheets_prefs (store, written) VALUES (?, ?) ON CONFLICT (store) DO UPDATE SET written = excluded.written").run(store, w ? JSON.stringify(w) : null)
  }

  forget(store: string): void {
    this.db.prepare('DELETE FROM work_sheets_suggestions WHERE store = ?').run(store)
    this.db.prepare('DELETE FROM work_sheets_prefs WHERE store = ?').run(store)
  }
}
