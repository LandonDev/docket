import type { DatabaseSync } from 'node:sqlite'
import type { DigestDay } from '@shared/contract-work-digest'
import { TellOpenSchema, type TellGroup, type TellOpen, type TellRow } from '@shared/work/tell'

/**
 * The digest's ledger on this host (docs/agents/work-digest.md): every
 * tell for 30 days, the days a digest was made of, his three settings and
 * the threads that started on their own.
 *
 * A row waits (no day, never told), is in a day's digest (`day`), or was
 * told at once (`told_at`); `due` marks one the rule called "now" that no
 * deliverer has taken yet.
 */

export const KEEP_DAYS = 30
const DAY_MS = 24 * 3_600_000

export function ensureDigestTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_digest_tells (
    id TEXT PRIMARY KEY,
    key TEXT,
    kind TEXT NOT NULL,
    grp TEXT NOT NULL,
    workspace_id TEXT,
    sector TEXT,
    title TEXT NOT NULL,
    detail TEXT,
    open TEXT,
    by_at INTEGER,
    at INTEGER NOT NULL,
    due INTEGER NOT NULL DEFAULT 0,
    day TEXT,
    told_at INTEGER
  )`)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS work_digest_tells_key ON work_digest_tells (key) WHERE key IS NOT NULL')
  db.exec('CREATE INDEX IF NOT EXISTS work_digest_tells_at ON work_digest_tells (at)')
  db.exec('CREATE TABLE IF NOT EXISTS work_digest_days (day TEXT PRIMARY KEY, made_at INTEGER NOT NULL, seen_at INTEGER, count INTEGER NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS work_digest_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS work_digest_quiet (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
}

interface Raw {
  id: string
  key: string | null
  kind: string
  grp: string
  workspace_id: string | null
  sector: string | null
  title: string
  detail: string | null
  open: string | null
  by_at: number | null
  at: number
  due: number
  day: string | null
  told_at: number | null
}

/** A row as the ledger keeps it: the wire's row, and whether it is owed a notice. */
export interface LedgerRow extends TellRow {
  due: boolean
}

function openOf(text: string | null): TellOpen | undefined {
  if (!text) return undefined
  try {
    const parsed = TellOpenSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

const dayOfRaw = (r: { day: string; made_at: number; seen_at: number | null; count: number }): DigestDay => ({ day: r.day, madeAt: r.made_at, seenAt: r.seen_at, count: r.count })

export class DigestStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: string
  ) {}

  private rowOf(r: Raw): LedgerRow {
    return {
      id: r.id,
      host: this.host,
      kind: r.kind,
      group: r.grp as TellGroup,
      workspaceId: r.workspace_id,
      sector: r.sector,
      title: r.title,
      ...(r.detail ? { detail: r.detail } : {}),
      ...(openOf(r.open) ? { open: openOf(r.open) } : {}),
      ...(r.by_at != null ? { by: r.by_at } : {}),
      ...(r.key ? { key: r.key } : {}),
      at: r.at,
      how: r.told_at != null ? 'now' : r.day ? 'digest' : 'waiting',
      day: r.day,
      toldAt: r.told_at,
      due: r.due === 1
    }
  }
  private all(where: string, ...args: (string | number)[]): LedgerRow[] {
    return (this.db.prepare(`SELECT * FROM work_digest_tells ${where}`).all(...args) as unknown as Raw[]).map((r) => this.rowOf(r))
  }

  // ── tells ───────────────────────────────────────────────────────────
  /** Writes a row whole: a new one, or the row of the same id as it now stands. */
  put(row: LedgerRow): void {
    this.db
      .prepare(
        `INSERT INTO work_digest_tells (id, key, kind, grp, workspace_id, sector, title, detail, open, by_at, at, due, day, told_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET key = excluded.key, kind = excluded.kind, grp = excluded.grp, workspace_id = excluded.workspace_id, sector = excluded.sector,
           title = excluded.title, detail = excluded.detail, open = excluded.open, by_at = excluded.by_at, at = excluded.at, due = excluded.due, day = excluded.day, told_at = excluded.told_at`
      )
      .run(
        row.id,
        row.key ?? null,
        row.kind,
        row.group,
        row.workspaceId,
        row.sector,
        row.title,
        row.detail ?? null,
        row.open ? JSON.stringify(row.open) : null,
        row.by ?? null,
        row.at,
        row.due ? 1 : 0,
        row.day,
        row.toldAt
      )
  }
  byKey(key: string): LedgerRow | null {
    return this.all('WHERE key = ?', key)[0] ?? null
  }
  /** Every row whose key starts with `prefix`. */
  byKeyPrefix(prefix: string): LedgerRow[] {
    return this.all('WHERE key IS NOT NULL AND substr(key, 1, ?) = ?', prefix.length, prefix)
  }
  byId(id: string): LedgerRow | null {
    return this.all('WHERE id = ?', id)[0] ?? null
  }
  remove(id: string): void {
    this.db.prepare('DELETE FROM work_digest_tells WHERE id = ?').run(id)
  }
  /** Newest first; `day`: that day's rows alone; `since`: rows told at or after it. */
  rows(o: { day?: string; since?: number } = {}): LedgerRow[] {
    if (o.day) return this.all('WHERE day = ? ORDER BY at DESC', o.day)
    return this.all('WHERE at >= ? ORDER BY at DESC', o.since ?? 0)
  }
  /** Rows no digest holds yet and nobody is owed a notice of: what the next digest is made of (those never told at once are its count). */
  unstamped(): LedgerRow[] {
    return this.all('WHERE day IS NULL AND due = 0 ORDER BY at')
  }
  waitingCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM work_digest_tells WHERE day IS NULL AND told_at IS NULL').get() as { n: number }).n
  }
  /** Rows the rule called "now" that no deliverer took. */
  due(): LedgerRow[] {
    return this.all('WHERE due = 1 ORDER BY at')
  }
  /** Rows with a clock still ahead that he was never told at once, whatever digest they are in. */
  clocked(now: number): LedgerRow[] {
    return this.all('WHERE by_at IS NOT NULL AND by_at > ? AND told_at IS NULL AND due = 0 ORDER BY by_at', now)
  }
  /** Rows he was told at once, a day old at most, whose clock has not passed since: the interrupts still open. A clock already past when it was told (a send that failed) stays open for the day. */
  openNow(now: number): LedgerRow[] {
    return this.all('WHERE told_at IS NOT NULL AND (by_at IS NULL OR by_at > ? OR by_at <= told_at) AND told_at > ? ORDER BY told_at', now, now - DAY_MS)
  }
  stamp(day: string, ids: readonly string[]): void {
    const set = this.db.prepare('UPDATE work_digest_tells SET day = ? WHERE id = ?')
    for (const id of ids) set.run(day, id)
  }
  removeWorkspace(workspaceId: string): string[] {
    const ids = (this.db.prepare('SELECT id FROM work_digest_tells WHERE workspace_id = ?').all(workspaceId) as { id: string }[]).map((r) => r.id)
    this.db.prepare('DELETE FROM work_digest_tells WHERE workspace_id = ?').run(workspaceId)
    return ids
  }
  /** Drops what is older than the ledger keeps; a row whose clock is still ahead stays. */
  prune(now: number): void {
    const before = now - KEEP_DAYS * DAY_MS
    this.db.prepare('DELETE FROM work_digest_tells WHERE at < ? AND (by_at IS NULL OR by_at < ?)').run(before, now)
    this.db.prepare('DELETE FROM work_digest_days WHERE made_at < ?').run(before)
  }

  // ── days ────────────────────────────────────────────────────────────
  day(day: string): DigestDay | null {
    const r = this.db.prepare('SELECT * FROM work_digest_days WHERE day = ?').get(day) as Parameters<typeof dayOfRaw>[0] | undefined
    return r ? dayOfRaw(r) : null
  }
  days(): DigestDay[] {
    return (this.db.prepare('SELECT * FROM work_digest_days ORDER BY day DESC').all() as Parameters<typeof dayOfRaw>[0][]).map(dayOfRaw)
  }
  /** False when the day was already made: a digest is never made twice. */
  addDay(d: DigestDay): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO work_digest_days (day, made_at, seen_at, count) VALUES (?, ?, ?, ?)').run(d.day, d.madeAt, d.seenAt, d.count).changes === 1
  }
  seen(day: string, at: number): DigestDay | null {
    this.db.prepare('UPDATE work_digest_days SET seen_at = ? WHERE day = ? AND seen_at IS NULL').run(at, day)
    return this.day(day)
  }

  // ── settings ────────────────────────────────────────────────────────
  setting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM work_digest_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO work_digest_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ── threads that started on their own ───────────────────────────────
  quiet(sessionId: string, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO work_digest_quiet (session_id, at) VALUES (?, ?)').run(sessionId, at)
  }
  isQuiet(sessionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM work_digest_quiet WHERE session_id = ?').get(sessionId)
  }
  unquiet(sessionIds: readonly string[]): void {
    const drop = this.db.prepare('DELETE FROM work_digest_quiet WHERE session_id = ?')
    for (const id of sessionIds) drop.run(id)
  }
}
