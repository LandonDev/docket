import type { DatabaseSync } from 'node:sqlite'
import { nanoid } from 'nanoid'
import type { ToolHints, ToolRule } from '@shared/addons'
import type { HeldWhy, OutboxGrant, OutboxItem } from '@shared/contract-work-outbox'
import type { ActKind, ActResult, HeldRef, HeldState } from '@shared/work'

/**
 * The hold's rows on this host (docs/agents/work-outbox.md): every act a
 * Work thread made that waits for, or got, the owner's decision; the
 * standing grants; and the rule he set for each add-on tool.
 *
 * `work_held_acts` is the log as well as the queue: no row is ever deleted.
 * A row is claimed for sending by one UPDATE that names the states it may
 * leave, so two presses, two clients and a press after a restart cannot
 * both take it. A row that was `sending` when the host stopped is never
 * sent again by the host: it reads `failed` and says it may have gone.
 *
 * A LifeOS-held mail or calendar act lives in LifeOS, not here. It gets a
 * row here only once someone decided it (a press, a discard, a grant): the
 * row's `run_key` (`lifeos:<table>:<id>`) is unique, which makes that
 * decision the only one.
 */

export const HELD_TABLE = 'work_held_acts'
/** A LifeOS calendar act's event as last shown, and how often it changed: its revision moves on with it, across restarts. */
export const BOUND_TABLE = 'work_outbox_bound_events'
export const GRANTS_TABLE = 'work_grants'
export const RULES_TABLE = 'work_outbox_tool_rules'
/** The revision his own edit left, by run key: an item whose revision is still that one reads "changed by you", any later one "by the thread". */
export const EDITS_TABLE = 'work_held_edits'

/** States a press may take a row from. `failed` is in: a send that failed waits on him as much as a held one does. */
export const PRESSABLE: readonly HeldState[] = ['held', 'live', 'failed']
/** What removing a thread or a workspace settles: what waits, and a time he set on the host's own timer. */
const CLOSABLE: readonly HeldState[] = ['held', 'live', 'failed', 'scheduled']
/** States that wait on the owner, as the Waiting list shows them; an item that went out of date waits too, until he discards it (`WAITING_SQL`). */
export const WAITING: readonly HeldState[] = ['held', 'live', 'failed', 'sending']
/** What the Waiting list holds, as SQL: the states above, and a stale row he has not discarded. */
const WAITING_SQL = `(state IN ('held', 'live', 'failed', 'sending', 'scheduled') OR (state = 'stale' AND dismissed_at IS NULL))`
/** States a time may be set from: a held or failed item, never a live screen's act. */
const SCHEDULABLE = ['held', 'failed'] as const
/** A schedule this far past its time when the host comes up went by while it was off: back to held, never sent late. */
export const MISSED_MS = 15 * 60_000
export const MISSED = 'Missed its time while the host was off. Send it now or pick another time.'
/** What the count holds (shared/work/outboxCount.ts `needsHim`): the same less a row being sent. */
const COUNTED_SQL = `(state IN ('held', 'live', 'failed') OR (state = 'stale' AND dismissed_at IS NULL))`
/** Where a press was made, as Done says it. `request:<id>` is the host's own, for a thread's request he answered. */
export const VIAS = ['outbox', 'today', 'phone', 'mail', 'scheduled'] as const
export type Via = (typeof VIAS)[number] | `request:${string}`
/** The longest reason a discard keeps for the thread. */
export const REASON_MAX = 500

export const INTERRUPTED = 'The app stopped while this was being sent, so it may or may not have gone. Check before you send it again.'
export const LIVE_LOST = 'The app restarted, so the screen this act was read from is gone.'

export function ensureOutboxTables(db: DatabaseSync): void {
  ensureTables(db)
  // A database made before the mark: every failed row it holds is taken as a send that may have gone.
  const columns = (db.prepare(`SELECT name FROM pragma_table_info('${HELD_TABLE}')`).all() as { name: string }[]).map((c) => c.name)
  if (!columns.includes('outcome_unknown')) {
    db.exec(`ALTER TABLE ${HELD_TABLE} ADD COLUMN outcome_unknown INTEGER NOT NULL DEFAULT 0`)
    db.exec(`UPDATE ${HELD_TABLE} SET outcome_unknown = 1 WHERE state = 'failed' AND run_key NOT LIKE 'lifeos:%'`)
  }
  // Outbox 2: a discard's reason, where the press was made, and when a stale row was put away. A database made before
  // it has every stale row put away already: only what goes out of date from now on waits for him.
  // Send later: when it goes, the zone he picked the time in, who set it, and a generation each change moves on.
  if (!columns.includes('schedule_at') && columns.includes('id')) {
    db.exec(`ALTER TABLE ${HELD_TABLE} ADD COLUMN schedule_at INTEGER`)
    db.exec(`ALTER TABLE ${HELD_TABLE} ADD COLUMN schedule_zone TEXT`)
    db.exec(`ALTER TABLE ${HELD_TABLE} ADD COLUMN schedule_by TEXT`)
    db.exec(`ALTER TABLE ${HELD_TABLE} ADD COLUMN schedule_gen INTEGER NOT NULL DEFAULT 0`)
  }
  // A removed thread's mail LifeOS was to send at his time: taken back from LifeOS before it is put away here.
  if (!columns.includes('cancel_wanted') && columns.includes('id')) db.exec(`ALTER TABLE ${HELD_TABLE} ADD COLUMN cancel_wanted INTEGER NOT NULL DEFAULT 0`)
  if (!columns.includes('dismissed_at')) {
    db.exec(`ALTER TABLE ${HELD_TABLE} ADD COLUMN reason TEXT`)
    db.exec(`ALTER TABLE ${HELD_TABLE} ADD COLUMN via TEXT`)
    db.exec(`ALTER TABLE ${HELD_TABLE} ADD COLUMN dismissed_by TEXT`)
    db.exec(`ALTER TABLE ${HELD_TABLE} ADD COLUMN dismissed_at INTEGER`)
    db.exec(`UPDATE ${HELD_TABLE} SET dismissed_at = updated_at WHERE state = 'stale'`)
  }
}

function ensureTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${HELD_TABLE} (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT,
      session_id     TEXT,
      sector         TEXT,
      kind           TEXT NOT NULL,
      origin         TEXT NOT NULL,
      why            TEXT NOT NULL DEFAULT 'rule',
      summary        TEXT NOT NULL,
      verb           TEXT NOT NULL DEFAULT 'Send',
      account        TEXT,
      payload        TEXT NOT NULL,
      state          TEXT NOT NULL,
      run_key        TEXT NOT NULL UNIQUE,
      grant_id       TEXT,
      decided_by     TEXT,
      decided_at     INTEGER,
      result         TEXT,
      error          TEXT,
      routine_run_id TEXT,
      attempts       INTEGER NOT NULL DEFAULT 0,
      outcome_unknown INTEGER NOT NULL DEFAULT 0,
      task           TEXT,
      reason         TEXT,
      via            TEXT,
      dismissed_by   TEXT,
      dismissed_at   INTEGER,
      schedule_at    INTEGER,
      schedule_zone  TEXT,
      schedule_by    TEXT,
      schedule_gen   INTEGER NOT NULL DEFAULT 0,
      cancel_wanted  INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_held_acts_state ON ${HELD_TABLE}(state, updated_at);
    CREATE INDEX IF NOT EXISTS work_held_acts_session ON ${HELD_TABLE}(session_id);
    CREATE INDEX IF NOT EXISTS work_held_acts_decided ON ${HELD_TABLE}(workspace_id, kind, decided_at);
    CREATE INDEX IF NOT EXISTS work_held_acts_owed ON ${HELD_TABLE}(task) WHERE task = 'owed';
    CREATE TABLE IF NOT EXISTS ${GRANTS_TABLE} (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind         TEXT NOT NULL,
      matcher      TEXT NOT NULL,
      label        TEXT NOT NULL,
      made_from    TEXT NOT NULL,
      routine_id   TEXT,
      created_at   INTEGER NOT NULL,
      removed_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS ${EDITS_TABLE} (
      run_key TEXT PRIMARY KEY,
      rev     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${BOUND_TABLE} (
      act_id  TEXT PRIMARY KEY,
      shown   TEXT NOT NULL,
      bump    INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ${RULES_TABLE} (
      addon_id    TEXT NOT NULL,
      tool        TEXT NOT NULL,
      rule        TEXT NOT NULL,
      hints       TEXT,
      spec_digest TEXT NOT NULL DEFAULT '',
      tool_digest TEXT NOT NULL DEFAULT '',
      set_by      TEXT NOT NULL,
      set_at      INTEGER NOT NULL,
      PRIMARY KEY (addon_id, tool)
    );
  `)
}

type Row = {
  n: number
  id: string
  workspace_id: string | null
  session_id: string | null
  sector: string | null
  kind: string
  origin: string
  why: string
  summary: string
  verb: string
  account: string | null
  payload: string
  state: string
  run_key: string
  grant_id: string | null
  decided_by: string | null
  decided_at: number | null
  result: string | null
  error: string | null
  routine_run_id: string | null
  attempts: number
  outcome_unknown: number
  reason: string | null
  via: string | null
  dismissed_by: string | null
  dismissed_at: number | null
  schedule_at: number | null
  schedule_zone: string | null
  schedule_by: string | null
  schedule_gen: number
  cancel_wanted?: number
  created_at: number
  updated_at: number
}

/** One row of `work_held_acts`. */
export interface HeldRow {
  n: number
  id: string
  workspaceId: string | null
  sessionId: string | null
  sector: string | null
  kind: ActKind
  /** `addon:<id>/<tool>`, `computer`, `app`, or `lifeos:<table>/<id>` for a LifeOS-held item someone decided */
  origin: string
  why: HeldWhy
  summary: string
  verb: string
  account: string | null
  payload: unknown
  state: HeldState
  runKey: string
  grantId: string | null
  decidedBy: string | null
  decidedAt: number | null
  result: ActResult | null
  error: string | null
  routineRunId: string | null
  attempts: number
  /** a failed send whose end nobody knows (a timeout, a lost answer, a stop mid-send): it may have gone, so a press must say "Send again" */
  outcomeUnknown: boolean
  /** why he discarded it, for the thread */
  reason: string | null
  /** where the press was made (`Via`) */
  via: string | null
  /** a stale row he put away: by whom and when; until then it waits */
  dismissedBy: string | null
  dismissedAt: number | null
  /** Send later: when it goes, the zone he picked it in, who set it, and the generation its own claim names */
  scheduleAt: number | null
  scheduleZone: string | null
  scheduleBy: string | null
  scheduleGen: number
  /** its thread or workspace was removed while LifeOS held its time: taken back from LifeOS before it is put away */
  cancelWanted: boolean
  createdAt: number
  updatedAt: number
}

export interface NewHeld {
  workspaceId: string | null
  sessionId: string | null
  sector: string | null
  kind: ActKind
  origin: string
  why: HeldWhy
  summary: string
  verb: string
  account?: string | null
  payload: unknown
  state?: 'held' | 'live'
  /** absent: the row's own (`host:<id>`) */
  runKey?: string
  routineRunId?: string | null
  createdAt?: number
}

/** One tool's rule as stored: bound to the server it was set for and to the tool as it was listed then. */
export interface StoredRule {
  addonId: string
  tool: string
  rule: ToolRule
  hints: ToolHints
  specDigest: string
  toolDigest: string
  setBy: string
  setAt: number
}

const json = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const decode = (r: Row): HeldRow => ({
  n: Number(r.n),
  id: r.id,
  workspaceId: r.workspace_id,
  sessionId: r.session_id,
  sector: r.sector,
  kind: r.kind as ActKind,
  origin: r.origin,
  why: r.why as HeldWhy,
  summary: r.summary,
  verb: r.verb,
  account: r.account,
  payload: json(r.payload),
  state: r.state as HeldState,
  runKey: r.run_key,
  grantId: r.grant_id,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  result: json(r.result) as ActResult | null,
  error: r.error,
  routineRunId: r.routine_run_id,
  attempts: Number(r.attempts),
  outcomeUnknown: Number(r.outcome_unknown) === 1,
  reason: r.reason ?? null,
  via: r.via ?? null,
  dismissedBy: r.dismissed_by ?? null,
  dismissedAt: r.dismissed_at == null ? null : Number(r.dismissed_at),
  scheduleAt: r.schedule_at == null ? null : Number(r.schedule_at),
  scheduleZone: r.schedule_zone ?? null,
  scheduleBy: r.schedule_by ?? null,
  scheduleGen: Number(r.schedule_gen ?? 0),
  cancelWanted: Number(r.cancel_wanted ?? 0) === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at)
})

/** A LifeOS-held item's ref from the run key its row carries, else this host's own ref. */
export function refOfRow(row: Pick<HeldRow, 'id' | 'runKey'>): HeldRef {
  const m = /^lifeos:(outbox|calendarOps):(.+)$/.exec(row.runKey)
  return m ? { at: 'lifeos', table: m[1] as 'outbox' | 'calendarOps', id: m[2]! } : { at: 'host', id: row.id }
}
export const lifeosRunKey = (table: 'outbox' | 'calendarOps', id: string): string => `lifeos:${table}:${id}`

/** A row as a screen lists it. */
export const itemOfRow = (row: HeldRow): OutboxItem => ({
  ref: refOfRow(row),
  kind: row.kind,
  workspaceId: row.workspaceId,
  sessionId: row.sessionId,
  sector: row.sector,
  summary: row.summary,
  verb: row.verb,
  account: row.account,
  state: row.state,
  payload: row.payload,
  createdAt: row.createdAt,
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt,
  n: row.n,
  why: row.why,
  grantId: row.grantId,
  error: row.error,
  result: row.result,
  routineRunId: row.routineRunId,
  ...(row.outcomeUnknown ? { outcomeUnknown: true } : {}),
  ...(row.reason ? { reason: row.reason } : {}),
  ...(row.via ? { via: row.via } : {}),
  ...(row.dismissedAt != null ? { dismissedAt: row.dismissedAt } : {}),
  ...(row.state === 'scheduled' && row.scheduleAt != null ? { scheduledFor: row.scheduleAt, ...(row.scheduleZone ? { scheduledZone: row.scheduleZone } : {}) } : {}),
  updatedAt: row.updatedAt
})

const SELECT = `SELECT rowid AS n, * FROM ${HELD_TABLE}`
const marks = (list: readonly string[]): string => list.map(() => '?').join(', ')

export class HeldStore {
  private readonly listeners = new Set<(row: HeldRow) => void>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {}

  // ── held acts ─────────────────────────────────────────────────────────

  /** A new row, waiting. Throws when its run key is taken: that act already has its one row. */
  insert(input: NewHeld): HeldRow {
    const id = `ha_${nanoid(12)}`
    const at = input.createdAt ?? this.now()
    this.db
      .prepare(
        `INSERT INTO ${HELD_TABLE} (id, workspace_id, session_id, sector, kind, origin, why, summary, verb, account, payload, state, run_key, routine_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.workspaceId,
        input.sessionId,
        input.sector,
        input.kind,
        input.origin,
        input.why,
        input.summary,
        input.verb,
        input.account ?? null,
        JSON.stringify(input.payload ?? null),
        input.state ?? 'held',
        input.runKey ?? `host:${id}`,
        input.routineRunId ?? null,
        at,
        this.now()
      )
    return this.told(id)!
  }
  /**
   * How many times a calendar act's bound event (`shown`) has changed since it was first listed: added to its revision,
   * so a view from before the change names an older one. Kept here so a restart does not let an older revision repeat.
   */
  boundBump(actId: string, shown: string): number {
    const row = this.db.prepare(`SELECT shown, bump FROM ${BOUND_TABLE} WHERE act_id = ?`).get(actId) as { shown: string; bump: number } | undefined
    if (!row) {
      this.db.prepare(`INSERT INTO ${BOUND_TABLE} (act_id, shown, bump) VALUES (?, ?, 0)`).run(actId, shown)
      return 0
    }
    if (row.shown === shown) return Number(row.bump)
    const bump = Number(row.bump) + 1
    this.db.prepare(`UPDATE ${BOUND_TABLE} SET shown = ?, bump = ? WHERE act_id = ?`).run(shown, bump, actId)
    return bump
  }


  get(id: string): HeldRow | null {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Row | undefined
    return row ? decode(row) : null
  }

  byRunKey(runKey: string): HeldRow | null {
    const row = this.db.prepare(`${SELECT} WHERE run_key = ?`).get(runKey) as unknown as Row | undefined
    return row ? decode(row) : null
  }

  /** The row a ref names: this host's by id, a LifeOS-held item's by its run key (null until someone decided it). */
  byRef(ref: HeldRef): HeldRow | null {
    return ref.at === 'host' ? this.get(ref.id) : this.byRunKey(lifeosRunKey(ref.table, ref.id))
  }

  list(q: { show?: 'waiting' | 'decided' | 'all'; workspaceId?: string | null; sessionId?: string; limit?: number } = {}): HeldRow[] {
    const show = q.show ?? 'waiting'
    const where: string[] = []
    const args: (string | number)[] = []
    if (show === 'waiting') where.push(WAITING_SQL)
    else if (show === 'decided') where.push(`NOT ${WAITING_SQL}`)
    // null: the acts outside every workspace (a Work Chat's).
    if (q.workspaceId === null) where.push('workspace_id IS NULL')
    else if (q.workspaceId !== undefined) {
      where.push('workspace_id = ?')
      args.push(q.workspaceId)
    }
    if (q.sessionId !== undefined) {
      where.push('session_id = ?')
      args.push(q.sessionId)
    }
    // What waits reads oldest first, the order he must act in; what was decided reads newest first.
    const order = show === 'waiting' ? 'created_at ASC, rowid ASC' : 'updated_at DESC, rowid DESC'
    const rows = this.db
      .prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`)
      .all(...args, q.limit ?? 200) as unknown as Row[]
    return rows.map(decode)
  }

  /** Rows of one kind in one workspace that someone decided since a time (sent, discarded, going or failed), newest decision first: what an earned grant counts (earned.ts). */
  decidedSince(kind: ActKind, workspaceId: string, since: number, limit = 500): HeldRow[] {
    const rows = this.db
      .prepare(`${SELECT} WHERE kind = ? AND workspace_id = ? AND decided_at IS NOT NULL AND decided_at >= ? ORDER BY decided_at DESC, rowid DESC LIMIT ?`)
      .all(kind, workspaceId, since, limit) as unknown as Row[]
    return rows.map(decode)
  }

  /** How many rows wait on the owner. */
  /** Held rows whose send failed and that wait on him again: the rail's failed mark. */
  failed(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${HELD_TABLE} WHERE state = ?`).get('failed') as { c: number }
    return Number(row.c)
  }

  /** How many rows wait on him (`needsHim`): held, live, failed, and stale until he discards it. */
  waiting(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${HELD_TABLE} WHERE ${COUNTED_SQL}`).get() as { c: number }
    return Number(row.c)
  }

  /**
   * Take a row for sending. The one UPDATE names the states it may leave,
   * so of any number of presses exactly one gets the row back; the others
   * get null and send nothing. A row whose last send may have gone is taken
   * only with `again`: he chose Send again.
   */
  claim(id: string, decidedBy: string, grantId: string | null = null, opts: { again?: boolean; via?: Via | null; /** the revision he saw: a row that moved since is not taken */ rev?: number } = {}): HeldRow | null {
    const at = this.now()
    const done = this.db
      .prepare(
        `UPDATE ${HELD_TABLE} SET state = 'sending', decided_by = ?, decided_at = ?, grant_id = ?, via = ?, error = NULL, outcome_unknown = 0, attempts = attempts + 1, updated_at = MAX(updated_at + 1, ?)
         WHERE id = ? AND state IN (${marks(PRESSABLE)}) AND (outcome_unknown = 0 OR ? = 1) AND (? IS NULL OR updated_at = ?)`
      )
      .run(decidedBy, at, grantId, opts.via ?? null, at, id, ...PRESSABLE, opts.again ? 1 : 0, opts.rev ?? null, opts.rev ?? null)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** How a claimed send ended. Only a row that is `sending` is settled. */
  settle(id: string, state: 'sent' | 'failed' | 'stale', out: { result?: ActResult | null; error?: string | null; unknown?: boolean } = {}): HeldRow | null {
    const done = this.db
      .prepare(`UPDATE ${HELD_TABLE} SET state = ?, result = ?, error = ?, outcome_unknown = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state = 'sending'`)
      .run(state, out.result ? JSON.stringify(out.result) : null, out.error ?? null, state === 'failed' && out.unknown ? 1 : 0, this.now(), id)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /**
   * The act will never go. Only a row that waits is discarded; one being sent is not. A stale row stays stale, put
   * away: Done says it went out of date, with his reason.
   */
  discard(id: string, decidedBy: string, opts: { reason?: string | null; via?: Via | null; rev?: number } = {}): HeldRow | null {
    const at = this.now()
    const reason = opts.reason?.trim().slice(0, REASON_MAX) || null
    const rev = opts.rev ?? null
    const done = this.db
      .prepare(`UPDATE ${HELD_TABLE} SET state = 'discarded', decided_by = ?, decided_at = ?, reason = ?, via = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state IN (${marks(PRESSABLE)}) AND (? IS NULL OR updated_at = ?)`)
      .run(decidedBy, at, reason, opts.via ?? null, at, id, ...PRESSABLE, rev, rev)
    if (Number(done.changes) === 1) return this.told(id)
    const put = this.db
      .prepare(`UPDATE ${HELD_TABLE} SET dismissed_by = ?, dismissed_at = ?, reason = ?, via = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state = 'stale' AND dismissed_at IS NULL AND (? IS NULL OR updated_at = ?)`)
      .run(decidedBy, at, reason, opts.via ?? null, at, id, rev, rev)
    return Number(put.changes) === 1 ? this.told(id) : null
  }

  // ── Send later ────────────────────────────────────────────────────────

  /** His Send later: the row waits for its time on its own claim. Only from held or failed, at the revision he saw. */
  schedule(id: string, by: string, at: number, opts: { zone?: string | null; rev?: number; via?: Via | null } = {}): HeldRow | null {
    const now = this.now()
    const rev = opts.rev ?? null
    const done = this.db
      .prepare(
        `UPDATE ${HELD_TABLE} SET state = 'scheduled', schedule_at = ?, schedule_zone = ?, schedule_by = ?, schedule_gen = schedule_gen + 1, decided_by = ?, decided_at = ?, via = ?, error = NULL, updated_at = MAX(updated_at + 1, ?)
         WHERE id = ? AND state IN (${marks(SCHEDULABLE)}) AND outcome_unknown = 0 AND (? IS NULL OR updated_at = ?)`
      )
      .run(at, opts.zone ?? null, by, by, now, opts.via ?? null, now, id, ...SCHEDULABLE, rev, rev)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** A schedule taken back (Cancel send, a missed time, a check that failed at its time): held again, under a new generation. */
  unschedule(id: string, error: string | null = null, gen?: number): HeldRow | null {
    const g = gen ?? null
    const done = this.db
      .prepare(
        `UPDATE ${HELD_TABLE} SET state = 'held', schedule_at = NULL, schedule_zone = NULL, schedule_gen = schedule_gen + 1, decided_by = NULL, decided_at = NULL, error = ?, updated_at = MAX(updated_at + 1, ?)
         WHERE id = ? AND state = 'scheduled' AND (? IS NULL OR schedule_gen = ?)`
      )
      .run(error, this.now(), id, g, g)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** Another time for a schedule that stands. */
  reschedule(id: string, at: number, zone: string | null): HeldRow | null {
    const done = this.db.prepare(`UPDATE ${HELD_TABLE} SET schedule_at = ?, schedule_zone = COALESCE(?, schedule_zone), schedule_gen = schedule_gen + 1, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state = 'scheduled'`).run(at, zone, this.now(), id)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** The timer's own claim: only the generation it was armed for, so a Cancel send or a new time in between wins. */
  claimScheduled(id: string, gen: number): HeldRow | null {
    const at = this.now()
    const done = this.db
      .prepare(
        `UPDATE ${HELD_TABLE} SET state = 'sending', decided_by = COALESCE(schedule_by, decided_by), decided_at = ?, via = 'scheduled', attempts = attempts + 1, updated_at = MAX(updated_at + 1, ?)
         WHERE id = ? AND state = 'scheduled' AND schedule_gen = ?`
      )
      .run(at, at, id, gen)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** What LifeOS's own timer did with a scheduled mail: it went, or LifeOS no longer has it. */
  settleScheduled(id: string, state: 'sent' | 'stale', error: string | null = null): HeldRow | null {
    const done = this.db.prepare(`UPDATE ${HELD_TABLE} SET state = ?, error = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state = 'scheduled'`).run(state, error, this.now(), id)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** Scheduled rows whose time came, on the host's own timer (a LifeOS mail is LifeOS's to send). */
  dueScheduled(): HeldRow[] {
    return (this.db.prepare(`${SELECT} WHERE state = 'scheduled' AND run_key NOT LIKE 'lifeos:%' AND schedule_at <= ? ORDER BY schedule_at ASC LIMIT 50`).all(this.now()) as unknown as Row[]).map(decode)
  }

  /** The next time the host's timer has to wake, or null. */
  nextScheduledAt(): number | null {
    const row = this.db.prepare(`SELECT MIN(schedule_at) AS at FROM ${HELD_TABLE} WHERE state = 'scheduled' AND run_key NOT LIKE 'lifeos:%'`).get() as { at: number | null }
    return row.at == null ? null : Number(row.at)
  }

  /** Every scheduled row LifeOS's timer holds, to read what became of it. */
  scheduledInLifeos(): HeldRow[] {
    return (this.db.prepare(`${SELECT} WHERE state = 'scheduled' AND run_key LIKE 'lifeos:%' LIMIT 200`).all() as unknown as Row[]).map(decode)
  }

  /** Mark a scheduled LifeOS mail to be taken back from LifeOS (its thread or workspace was removed). */
  wantCancel(id: string): void {
    this.db.prepare(`UPDATE ${HELD_TABLE} SET cancel_wanted = 1 WHERE id = ? AND state = 'scheduled'`).run(id)
  }

  /** A scheduled LifeOS mail LifeOS took back for a removed thread: put away, never to go. */
  putAwayScheduled(id: string, why: string): HeldRow | null {
    const at = this.now()
    const done = this.db
      .prepare(`UPDATE ${HELD_TABLE} SET state = 'stale', error = ?, schedule_at = NULL, schedule_gen = schedule_gen + 1, dismissed_by = 'host', dismissed_at = ?, cancel_wanted = 0, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state = 'scheduled'`)
      .run(why, at, at, id)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** The scheduled LifeOS mail of these threads, or of this workspace: LifeOS's to take back before they are put away. */
  scheduledLifeosOf(q: { sessionIds?: readonly string[]; workspaceId?: string }): HeldRow[] {
    const rows = this.scheduledInLifeos()
    return rows.filter((r) => (q.sessionIds ? !!r.sessionId && q.sessionIds.includes(r.sessionId) : r.workspaceId === q.workspaceId))
  }

  /** A LifeOS mail he took back in its undo time: it waits on him again as held. */
  unsend(id: string): HeldRow | null {
    const done = this.db.prepare(`UPDATE ${HELD_TABLE} SET state = 'held', decided_by = NULL, decided_at = NULL, via = NULL, result = NULL, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state = 'sent'`).run(this.now(), id)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** His own edit left this revision: until it moves, a change from the first words is his. */
  markEdited(runKey: string, rev: number): void {
    this.db.prepare(`INSERT INTO ${EDITS_TABLE} (run_key, rev) VALUES (?, ?) ON CONFLICT(run_key) DO UPDATE SET rev = excluded.rev`).run(runKey, rev)
  }

  /** The revision his last edit left, or null. */
  editedRev(runKey: string): number | null {
    const row = this.db.prepare(`SELECT rev FROM ${EDITS_TABLE} WHERE run_key = ?`).get(runKey) as { rev: number } | undefined
    return row ? Number(row.rev) : null
  }

  /** The screen or the store a waiting act was read from moved on: it can no longer be carried out as shown. */
  stale(id: string, why: string): HeldRow | null {
    const done = this.db
      .prepare(`UPDATE ${HELD_TABLE} SET state = 'stale', error = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state IN ('held', 'live')`)
      .run(why, this.now(), id)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** A LifeOS send the host recorded as sent came back failed in LifeOS's own lane: it waits on him again. */
  failSent(id: string, error: string): HeldRow | null {
    const done = this.db.prepare(`UPDATE ${HELD_TABLE} SET state = 'failed', error = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state = 'sent'`).run(error, this.now(), id)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** A failed row whose end was learned later (LifeOS says an interrupted send did go, or no longer has the mail). */
  settleFailed(id: string, state: 'sent' | 'stale', error: string | null = null): HeldRow | null {
    const done = this.db.prepare(`UPDATE ${HELD_TABLE} SET state = ?, error = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state = 'failed'`).run(state, error, this.now(), id)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /** The threads that made these rows are gone: what still waits can no longer be carried out for them. */
  closeSessions(sessionIds: readonly string[], why: string): number {
    let n = 0
    for (const id of sessionIds)
      for (const row of (this.db.prepare(`${SELECT} WHERE session_id = ? AND state IN (${marks(CLOSABLE)}) AND NOT (state = 'scheduled' AND run_key LIKE 'lifeos:%')`).all(id, ...CLOSABLE) as unknown as Row[]).map(decode)) {
        // He removed the thread himself: what it made is put away with it, not left waiting for him to discard.
        const done = this.db.prepare(`UPDATE ${HELD_TABLE} SET state = 'stale', error = ?, dismissed_by = 'host', dismissed_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state IN (${marks(CLOSABLE)})`).run(why, this.now(), this.now(), row.id, ...CLOSABLE)
        if (Number(done.changes) === 1) {
          n++
          this.told(row.id)
        }
      }
    return n
  }

  /** Change exactly what will go. Only while the row is held: a live act is the screen as it was read, and a row being sent is spoken for. */
  edit(id: string, next: { payload: unknown; summary: string; verb: string; account?: string | null }): HeldRow | null {
    const done = this.db
      .prepare(`UPDATE ${HELD_TABLE} SET payload = ?, summary = ?, verb = ?, account = COALESCE(?, account), updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND state IN ('held', 'failed')`)
      .run(JSON.stringify(next.payload ?? null), next.summary, next.verb, next.account ?? null, this.now(), id)
    return Number(done.changes) === 1 ? this.told(id) : null
  }

  /**
   * What a stop left behind, put right at boot. A row that was being sent
   * is never sent again by the host: nobody knows whether it went. A live
   * act's screen is gone with the process.
   */
  recover(): { interrupted: number; lost: number; missed: number } {
    const at = this.now()
    // A LifeOS row is the exception: LifeOS holds what became of it, and the watcher and the next press both ask it first.
    const interrupted = Number(
      this.db
        .prepare(`UPDATE ${HELD_TABLE} SET state = 'failed', error = ?, outcome_unknown = CASE WHEN run_key LIKE 'lifeos:%' THEN 0 ELSE 1 END, updated_at = MAX(updated_at + 1, ?) WHERE state = 'sending'`)
        .run(INTERRUPTED, at).changes
    )
    const lost = Number(this.db.prepare(`UPDATE ${HELD_TABLE} SET state = 'stale', error = ?, updated_at = MAX(updated_at + 1, ?) WHERE state = 'live'`).run(LIVE_LOST, at).changes)
    // A time that went by while the host was off goes back to him; it is never sent late. LifeOS keeps its own.
    const missed = Number(
      this.db
        .prepare(`UPDATE ${HELD_TABLE} SET state = 'held', schedule_at = NULL, schedule_zone = NULL, schedule_gen = schedule_gen + 1, decided_by = NULL, decided_at = NULL, error = ?, updated_at = MAX(updated_at + 1, ?) WHERE state = 'scheduled' AND run_key NOT LIKE 'lifeos:%' AND schedule_at < ?`)
        .run(MISSED, at, at - MISSED_MS).changes
    )
    return { interrupted, lost, missed }
  }

  /** A deleted workspace's waiting rows can no longer go: its add-ons and its key went with it. The rows stay, as the log. */
  closeWorkspace(workspaceId: string, why: string): number {
    const at = this.now()
    return Number(
      this.db
        .prepare(`UPDATE ${HELD_TABLE} SET state = 'stale', error = ?, dismissed_by = 'host', dismissed_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE workspace_id = ? AND state IN (${marks(CLOSABLE)}) AND NOT (state = 'scheduled' AND run_key LIKE 'lifeos:%')`)
        .run(why, at, at, workspaceId, ...CLOSABLE).changes
    )
  }

  // The linked task a sent act completes (ctx.links.completeFor): owed from the moment the act went, done once LifeOS took it.

  oweTask(id: string): void {
    this.db.prepare(`UPDATE ${HELD_TABLE} SET task = 'owed' WHERE id = ? AND task IS NULL`).run(id)
  }

  owedTasks(): HeldRow[] {
    return (this.db.prepare(`${SELECT} WHERE task = 'owed' ORDER BY rowid ASC LIMIT 50`).all() as unknown as Row[]).map(decode)
  }

  taskDone(id: string): void {
    this.db.prepare(`UPDATE ${HELD_TABLE} SET task = 'done' WHERE id = ?`).run(id)
  }

  /** The live rows of one thread: their screens are that thread's computer session. */
  liveOf(sessionId: string): HeldRow[] {
    return (this.db.prepare(`${SELECT} WHERE session_id = ? AND state = 'live'`).all(sessionId) as unknown as Row[]).map(decode)
  }

  onChange(fn: (row: HeldRow) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private told(id: string): HeldRow | null {
    const row = this.get(id)
    if (row)
      for (const fn of [...this.listeners]) {
        try {
          fn(row)
        } catch (err) {
          console.error('[work] outbox listener', err)
        }
      }
    return row
  }

  // ── grants ────────────────────────────────────────────────────────────

  addGrant(grant: { workspaceId: string; kind: ActKind; matcher: unknown; label: string; madeFrom: HeldRef; routineId?: string | null }): OutboxGrant {
    const id = `gr_${nanoid(12)}`
    this.db
      .prepare(`INSERT INTO ${GRANTS_TABLE} (id, workspace_id, kind, matcher, label, made_from, routine_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, grant.workspaceId, grant.kind, JSON.stringify(grant.matcher ?? null), grant.label, JSON.stringify(grant.madeFrom), grant.routineId ?? null, this.now())
    return this.grant(id)!
  }

  grant(id: string): OutboxGrant | null {
    const r = this.db.prepare(`SELECT * FROM ${GRANTS_TABLE} WHERE id = ?`).get(id) as unknown as GrantRow | undefined
    return r ? decodeGrant(r) : null
  }

  /** The standing grants, oldest first; `all` adds the removed ones. */
  grants(q: { workspaceId?: string; all?: boolean } = {}): OutboxGrant[] {
    const where: string[] = []
    const args: string[] = []
    if (!q.all) where.push('removed_at IS NULL')
    // null: the acts outside every workspace (a Work Chat's).
    if (q.workspaceId === null) where.push('workspace_id IS NULL')
    else if (q.workspaceId !== undefined) {
      where.push('workspace_id = ?')
      args.push(q.workspaceId)
    }
    const rows = this.db.prepare(`SELECT * FROM ${GRANTS_TABLE} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC, rowid ASC`).all(...args) as unknown as GrantRow[]
    return rows.map(decodeGrant)
  }

  /** A grant is never deleted: the acts it released name it. */
  removeGrant(id: string): OutboxGrant | null {
    this.db.prepare(`UPDATE ${GRANTS_TABLE} SET removed_at = ? WHERE id = ? AND removed_at IS NULL`).run(this.now(), id)
    return this.grant(id)
  }

  removeWorkspaceGrants(workspaceId: string): void {
    this.db.prepare(`UPDATE ${GRANTS_TABLE} SET removed_at = ? WHERE workspace_id = ? AND removed_at IS NULL`).run(this.now(), workspaceId)
  }

  // ── tool rules ────────────────────────────────────────────────────────

  setRule(rule: Omit<StoredRule, 'setAt'>): void {
    this.db
      .prepare(
        `INSERT INTO ${RULES_TABLE} (addon_id, tool, rule, hints, spec_digest, tool_digest, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(addon_id, tool) DO UPDATE SET rule = excluded.rule, hints = excluded.hints, spec_digest = excluded.spec_digest, tool_digest = excluded.tool_digest, set_by = excluded.set_by, set_at = excluded.set_at`
      )
      .run(rule.addonId, rule.tool, rule.rule, JSON.stringify(rule.hints ?? {}), rule.specDigest, rule.toolDigest, rule.setBy, this.now())
  }

  rules(addonId: string): StoredRule[] {
    const rows = this.db.prepare(`SELECT * FROM ${RULES_TABLE} WHERE addon_id = ? ORDER BY tool`).all(addonId) as unknown as RuleRow[]
    return rows.map(decodeRule)
  }

  rule(addonId: string, tool: string): StoredRule | null {
    const r = this.db.prepare(`SELECT * FROM ${RULES_TABLE} WHERE addon_id = ? AND tool = ?`).get(addonId, tool) as unknown as RuleRow | undefined
    return r ? decodeRule(r) : null
  }

  dropRules(addonId: string): void {
    this.db.prepare(`DELETE FROM ${RULES_TABLE} WHERE addon_id = ?`).run(addonId)
  }
}

type GrantRow = { id: string; workspace_id: string; kind: string; matcher: string; label: string; made_from: string; routine_id: string | null; created_at: number; removed_at: number | null }
const decodeGrant = (r: GrantRow): OutboxGrant => ({
  id: r.id,
  workspaceId: r.workspace_id,
  kind: r.kind as ActKind,
  matcher: json(r.matcher),
  label: r.label,
  madeFrom: json(r.made_from) as HeldRef,
  routineId: r.routine_id,
  createdAt: Number(r.created_at),
  removedAt: r.removed_at === null ? null : Number(r.removed_at)
})

type RuleRow = { addon_id: string; tool: string; rule: string; hints: string | null; spec_digest: string; tool_digest: string; set_by: string; set_at: number }
const decodeRule = (r: RuleRow): StoredRule => ({
  addonId: r.addon_id,
  tool: r.tool,
  rule: r.rule as ToolRule,
  hints: (json(r.hints) as ToolHints | null) ?? {},
  specDigest: r.spec_digest,
  toolDigest: r.tool_digest,
  setBy: r.set_by,
  setAt: Number(r.set_at)
})
