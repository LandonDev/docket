import type { DatabaseSync } from 'node:sqlite'
import type { SectorKey } from '@shared/work'

/**
 * Money's own tables (docs/agents/work-money.md "What is kept where"). None
 * holds a ledger row: the sheet is the truth. They hold where a job's books
 * are, what waits for his accept, the miles to a place and the calendar
 * events already offered.
 */
export function ensureMoneyTables(db: DatabaseSync): void {
  // One row a workspace. `home` and `calendar` are the owner's two rulings that can flip (the plan's 1 and 3).
  db.exec(`CREATE TABLE IF NOT EXISTS work_money_books (
    workspace_id TEXT PRIMARY KEY,
    home TEXT NOT NULL DEFAULT 'file',
    ledger TEXT NOT NULL,
    mileage TEXT NOT NULL,
    calendar TEXT NOT NULL DEFAULT 'games',
    rates TEXT NOT NULL DEFAULT '{}',
    invoice TEXT,
    created_at INTEGER NOT NULL
  )`)
  // What waits for his accept, by the sender's own key: a retry files nothing twice.
  db.exec(`CREATE TABLE IF NOT EXISTS work_money_inbox (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    state TEXT NOT NULL,
    source TEXT NOT NULL,
    name TEXT,
    mime TEXT,
    file TEXT,
    lines TEXT,
    fields TEXT,
    session_id TEXT,
    ref TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS work_money_inbox_ws ON work_money_inbox (workspace_id, state)')
  // The miles there and back to a venue, typed once.
  db.exec('CREATE TABLE IF NOT EXISTS work_money_places (place TEXT PRIMARY KEY, miles REAL NOT NULL, updated_at INTEGER NOT NULL)')
  // A calendar event is offered once: added or skipped, it is not offered again.
  db.exec(`CREATE TABLE IF NOT EXISTS work_money_events (
    workspace_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    state TEXT NOT NULL,
    role TEXT,
    fee INTEGER,
    at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, event_id)
  )`)
}

export interface Workspace {
  id: string
  name: string
  /** the workspace's own folder on this host */
  path: string
  sector: SectorKey | null
}

type Db = { db: DatabaseSync }

/** A Work workspace of this host, or null: Money keeps books for a job, never for a code workspace. */
export function workspaceOf(ctx: Db, id: string): Workspace | null {
  const row = ctx.db.prepare("SELECT id, name, path, sector FROM workspaces WHERE id = ? AND kind = 'work'").get(id) as Workspace | undefined
  return row ?? null
}

export function workspaces(ctx: Db): Workspace[] {
  return ctx.db.prepare("SELECT id, name, path, sector FROM workspaces WHERE kind = 'work' ORDER BY created_at").all() as unknown as Workspace[]
}

export interface Books {
  workspaceId: string
  /** absolute paths of the two sheets on this host */
  ledger: string
  mileage: string
  calendar: 'games' | 'all' | 'off'
  /** his own mileage rates, dollars a mile by year */
  rates: Record<number, number>
  /** what the invoice dialog brings back: his details, and the last number and terms he used */
  invoice: unknown
}

export function booksOf(ctx: Db, workspaceId: string): Books | null {
  const row = ctx.db.prepare('SELECT * FROM work_money_books WHERE workspace_id = ?').get(workspaceId) as
    | { workspace_id: string; ledger: string; mileage: string; calendar: string; rates: string; invoice: string | null }
    | undefined
  if (!row) return null
  const json = (text: string | null): unknown => {
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }
  return {
    workspaceId: row.workspace_id,
    ledger: row.ledger,
    mileage: row.mileage,
    calendar: row.calendar === 'all' || row.calendar === 'off' ? row.calendar : 'games',
    rates: (json(row.rates) as Record<number, number> | null) ?? {},
    invoice: json(row.invoice)
  }
}

export function putBooks(ctx: Db, b: { workspaceId: string; ledger: string; mileage: string }, now = Date.now()): void {
  ctx.db
    .prepare('INSERT INTO work_money_books (workspace_id, ledger, mileage, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET ledger = excluded.ledger, mileage = excluded.mileage')
    .run(b.workspaceId, b.ledger, b.mileage, now)
}

/** Everything Money kept for a workspace that is gone. Its files are the folder's, and go with it or stay as he left them. */
export function dropWorkspace(ctx: Db, workspaceId: string): void {
  for (const table of ['work_money_books', 'work_money_inbox', 'work_money_events']) ctx.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId)
}
