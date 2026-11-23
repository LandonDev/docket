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

/** His own mileage rate for a year, in dollars a mile. */
export function setRate(ctx: Db, workspaceId: string, year: number, rate: number): void {
  const books = booksOf(ctx, workspaceId)
  if (!books) return
  ctx.db.prepare('UPDATE work_money_books SET rates = ? WHERE workspace_id = ?').run(JSON.stringify({ ...books.rates, [year]: rate }), workspaceId)
}

export function setInvoice(ctx: Db, workspaceId: string, invoice: unknown): void {
  ctx.db.prepare('UPDATE work_money_books SET invoice = ? WHERE workspace_id = ?').run(JSON.stringify(invoice), workspaceId)
}

/** A venue as the places table keys it: its words, in lower case, with single spaces. */
export const placeKey = (place: string): string => place.trim().toLowerCase().replace(/\s+/g, ' ')

/** The miles there and back he gave a place, or null. */
export function milesTo(ctx: Db, place: string): number | null {
  const row = ctx.db.prepare('SELECT miles FROM work_money_places WHERE place = ?').get(placeKey(place)) as { miles: number } | undefined
  return row ? row.miles : null
}
export function keepMiles(ctx: Db, place: string, miles: number, now = Date.now()): void {
  if (!placeKey(place) || !(miles > 0)) return
  ctx.db.prepare('INSERT INTO work_money_places (place, miles, updated_at) VALUES (?, ?, ?) ON CONFLICT(place) DO UPDATE SET miles = excluded.miles, updated_at = excluded.updated_at').run(placeKey(place), miles, now)
}

export interface EventMark {
  /** `adding`: its pay is in the ledger and its trip is not yet in the log (a write failed between the two): offered still, and a retry writes only what is missing */
  state: 'added' | 'skipped' | 'adding'
  role: string | null
  fee: number | null
}
export function eventMarks(ctx: Db, workspaceId: string): Map<string, EventMark> {
  const rows = ctx.db.prepare('SELECT event_id, state, role, fee FROM work_money_events WHERE workspace_id = ?').all(workspaceId) as { event_id: string; state: EventMark['state']; role: string | null; fee: number | null }[]
  return new Map(rows.map((r) => [r.event_id, { state: r.state, role: r.role, fee: r.fee }]))
}
export function markEvent(ctx: Db, workspaceId: string, eventId: string, mark: EventMark, now = Date.now()): void {
  ctx.db
    .prepare('INSERT INTO work_money_events (workspace_id, event_id, state, role, fee, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, event_id) DO UPDATE SET state = excluded.state, role = excluded.role, fee = excluded.fee, at = excluded.at')
    .run(workspaceId, eventId, mark.state, mark.role, mark.fee, now)
}
/** The last fee he gave an event with this role, in this job. */
export function lastFee(ctx: Db, workspaceId: string, role: string): number | null {
  const row = ctx.db.prepare("SELECT fee FROM work_money_events WHERE workspace_id = ? AND role = ? AND state = 'added' AND fee IS NOT NULL ORDER BY at DESC LIMIT 1").get(workspaceId, role) as { fee: number } | undefined
  return row ? row.fee : null
}
