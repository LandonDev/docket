import type { DatabaseSync } from 'node:sqlite'
import { nanoid } from 'nanoid'
import { RoutineJobOpenSchema, type RoutineEnds, type RoutineJobOpen, type RoutineKind, type RoutineRun, type RoutineRunState } from '@shared/contract-work-routines'
import { TriggerSchema, type Trigger } from '@shared/work'
import { ensurePlayTable } from './plays'

/**
 * The routines' rows (architecture §3.1). Every change is written the
 * moment it happens, never at shutdown: the next due time is stored before
 * a run starts, a run's row before its thread exists, a cursor as soon as
 * it moves. So a host killed at any point comes back with its schedule
 * whole, and a run that was cut off reads as failed, never as one to make
 * again.
 */

export const ROUTINES_TABLE = 'work_routines'
export const RUNS_TABLE = 'work_routine_runs'

export function ensureRoutineTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ROUTINES_TABLE} (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL,
      project_id        TEXT,
      kind              TEXT NOT NULL,
      name              TEXT NOT NULL,
      prompt            TEXT NOT NULL,
      model             TEXT,
      reasoning         TEXT,
      trigger_spec      TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      until_at          INTEGER,
      once              INTEGER NOT NULL DEFAULT 0,
      resume_session_id TEXT,
      next_at           INTEGER,
      last_at           INTEGER,
      last_session_id   TEXT,
      last_state        TEXT,
      last_words        TEXT,
      cursor            TEXT,
      proposed          INTEGER NOT NULL DEFAULT 0,
      ended             INTEGER NOT NULL DEFAULT 0,
      made_in           TEXT,
      created_by        TEXT NOT NULL,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_routines_workspace ON ${ROUTINES_TABLE}(workspace_id);
    CREATE TABLE IF NOT EXISTS ${RUNS_TABLE} (
      id          TEXT PRIMARY KEY,
      routine_id  TEXT NOT NULL,
      session_id  TEXT,
      fired_at    INTEGER NOT NULL,
      cause       TEXT NOT NULL,
      folded      INTEGER NOT NULL DEFAULT 0,
      state       TEXT NOT NULL,
      summary     TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS work_routine_runs_routine ON ${RUNS_TABLE}(routine_id, fired_at);
    CREATE INDEX IF NOT EXISTS work_routine_runs_state ON ${RUNS_TABLE}(state);
  `)
  // Added with plays: the play a routine runs. A column added, never a table remade, so the build before still reads it.
  const columns = (db.prepare(`PRAGMA table_info(${ROUTINES_TABLE})`).all() as { name: string }[]).map((c) => c.name)
  if (!columns.includes('play_id')) db.exec(`ALTER TABLE ${ROUTINES_TABLE} ADD COLUMN play_id TEXT`)
  // Added with jobs: the host job a routine runs in place of a thread, and what a job run's row opens.
  if (!columns.includes('job')) db.exec(`ALTER TABLE ${ROUTINES_TABLE} ADD COLUMN job TEXT`)
  const runColumns = (db.prepare(`PRAGMA table_info(${RUNS_TABLE})`).all() as { name: string }[]).map((c) => c.name)
  if (!runColumns.includes('open')) db.exec(`ALTER TABLE ${RUNS_TABLE} ADD COLUMN open TEXT`)
  ensurePlayTable(db)
}

/** A routine as the engine holds it. */
export interface Routine {
  id: string
  workspaceId: string
  projectId: string | null
  kind: RoutineKind
  name: string
  prompt: string
  /** the play each run starts, or null */
  playId: string | null
  /** the host job each run runs in place of a thread, or null */
  job: string | null
  model: string | null
  reasoning: string | null
  trigger: Trigger
  enabled: boolean
  untilAt: number | null
  once: boolean
  resumeSessionId: string | null
  nextAt: number | null
  lastAt: number | null
  lastSessionId: string | null
  lastState: RoutineRunState | null
  lastWords: string | null
  /** the event cursor, or the last read's hash and time */
  cursor: Cursor
  proposed: boolean
  ended: boolean
  madeIn: string | null
  createdBy: 'owner' | 'model'
  createdAt: number
}

export interface Cursor {
  /** LifeOS events seen up to here */
  after?: number
  /** the last read's or the file's hash */
  hash?: string
  /** the file's mtime and size when it was hashed */
  key?: string
  /** when it was last read */
  readAt?: number
}

type Row = Record<string, string | number | null>

const parseJson = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== 'string') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const routineOf = (r: Row): Routine | null => {
  const trigger = TriggerSchema.safeParse(parseJson(r.trigger_spec, null))
  if (!trigger.success) return null
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    projectId: (r.project_id as string | null) ?? null,
    kind: r.kind === 'watch' ? 'watch' : 'routine',
    name: String(r.name),
    prompt: String(r.prompt),
    playId: (r.play_id as string | null) ?? null,
    job: (r.job as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    reasoning: (r.reasoning as string | null) ?? null,
    trigger: trigger.data as Trigger,
    enabled: r.enabled === 1,
    untilAt: (r.until_at as number | null) ?? null,
    once: r.once === 1,
    resumeSessionId: (r.resume_session_id as string | null) ?? null,
    nextAt: (r.next_at as number | null) ?? null,
    lastAt: (r.last_at as number | null) ?? null,
    lastSessionId: (r.last_session_id as string | null) ?? null,
    lastState: (r.last_state as RoutineRunState | null) ?? null,
    lastWords: (r.last_words as string | null) ?? null,
    cursor: parseJson<Cursor>(r.cursor, {}),
    proposed: r.proposed === 1,
    ended: r.ended === 1,
    madeIn: (r.made_in as string | null) ?? null,
    createdBy: r.created_by === 'model' ? 'model' : 'owner',
    createdAt: Number(r.created_at)
  }
}

const runOf = (r: Row): RoutineRun => {
  const open = RoutineJobOpenSchema.safeParse(parseJson(r.open, null))
  return {
    id: String(r.id),
    routineId: String(r.routine_id),
    sessionId: (r.session_id as string | null) ?? null,
    firedAt: Number(r.fired_at),
    cause: String(r.cause),
    folded: Number(r.folded),
    state: r.state as RoutineRunState,
    summary: String(r.summary ?? ''),
    ...(open.success ? { open: open.data } : {})
  }
}

/** What a new routine is made of. */
export interface NewRoutine {
  workspaceId: string
  projectId?: string | null
  kind: RoutineKind
  name: string
  prompt: string
  playId?: string | null
  job?: string | null
  model?: string | null
  reasoning?: string | null
  trigger: Trigger
  ends: RoutineEnds
  resumeSessionId?: string | null
  nextAt: number | null
  cursor?: Cursor
  proposed?: boolean
  madeIn?: string | null
  createdBy: 'owner' | 'model'
}

export class RoutineStore {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): Routine | null {
    const row = this.db.prepare(`SELECT * FROM ${ROUTINES_TABLE} WHERE id = ?`).get(id) as Row | undefined
    return row ? routineOf(row) : null
  }

  list(workspaceId?: string): Routine[] {
    const rows = (workspaceId === undefined
      ? this.db.prepare(`SELECT * FROM ${ROUTINES_TABLE} ORDER BY created_at`).all()
      : this.db.prepare(`SELECT * FROM ${ROUTINES_TABLE} WHERE workspace_id = ? ORDER BY created_at`).all(workspaceId)) as Row[]
    return rows.flatMap((r) => routineOf(r) ?? [])
  }

  /** What may fire: made by him (or created from a proposal), not paused, not ended. */
  active(): Routine[] {
    return (this.db.prepare(`SELECT * FROM ${ROUTINES_TABLE} WHERE enabled = 1 AND proposed = 0 AND ended = 0`).all() as Row[]).flatMap((r) => routineOf(r) ?? [])
  }

  create(n: NewRoutine, now: number): Routine {
    const id = nanoid(12)
    this.db
      .prepare(
        `INSERT INTO ${ROUTINES_TABLE} (id, workspace_id, project_id, kind, name, prompt, play_id, job, model, reasoning, trigger_spec, enabled, until_at, once,
          resume_session_id, next_at, cursor, proposed, made_in, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        n.workspaceId,
        n.projectId ?? null,
        n.kind,
        n.name,
        n.prompt,
        n.playId ?? null,
        n.job ?? null,
        n.model ?? null,
        n.reasoning ?? null,
        JSON.stringify(n.trigger),
        n.proposed ? 0 : 1,
        n.ends.kind === 'day' ? n.ends.at : null,
        n.ends.kind === 'once' ? 1 : 0,
        n.resumeSessionId ?? null,
        n.nextAt,
        JSON.stringify(n.cursor ?? {}),
        n.proposed ? 1 : 0,
        n.madeIn ?? null,
        n.createdBy,
        now
      )
    return this.get(id)!
  }

  /** A person's edit, or his Create on a proposal: the trigger starts again from now. */
  update(id: string, n: Omit<NewRoutine, 'createdBy' | 'madeIn' | 'resumeSessionId'>): Routine | null {
    this.db
      .prepare(
        `UPDATE ${ROUTINES_TABLE} SET workspace_id = ?, project_id = ?, kind = ?, name = ?, prompt = ?, play_id = ?, job = ?, model = ?, reasoning = ?, trigger_spec = ?,
          until_at = ?, once = ?, next_at = ?, cursor = ?, proposed = 0, enabled = 1, ended = 0 WHERE id = ?`
      )
      .run(
        n.workspaceId,
        n.projectId ?? null,
        n.kind,
        n.name,
        n.prompt,
        n.playId ?? null,
        n.job ?? null,
        n.model ?? null,
        n.reasoning ?? null,
        JSON.stringify(n.trigger),
        n.ends.kind === 'day' ? n.ends.at : null,
        n.ends.kind === 'once' ? 1 : 0,
        n.nextAt,
        JSON.stringify(n.cursor ?? {}),
        id
      )
    return this.get(id)
  }

  setEnabled(id: string, enabled: boolean, nextAt?: number | null): void {
    if (nextAt === undefined) this.db.prepare(`UPDATE ${ROUTINES_TABLE} SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id)
    else this.db.prepare(`UPDATE ${ROUTINES_TABLE} SET enabled = ?, next_at = ? WHERE id = ?`).run(enabled ? 1 : 0, nextAt, id)
  }

  /** A watch that is over: its day passed, it fired once, or its thread is gone. */
  end(id: string, words: string): void {
    this.db.prepare(`UPDATE ${ROUTINES_TABLE} SET ended = 1, next_at = NULL, last_words = ? WHERE id = ?`).run(words, id)
  }

  setNext(id: string, nextAt: number | null): void {
    this.db.prepare(`UPDATE ${ROUTINES_TABLE} SET next_at = ? WHERE id = ?`).run(nextAt, id)
  }

  setCursor(id: string, cursor: Cursor, lastWords?: string | null): void {
    if (lastWords === undefined) this.db.prepare(`UPDATE ${ROUTINES_TABLE} SET cursor = ? WHERE id = ?`).run(JSON.stringify(cursor), id)
    else this.db.prepare(`UPDATE ${ROUTINES_TABLE} SET cursor = ?, last_words = ? WHERE id = ?`).run(JSON.stringify(cursor), lastWords, id)
  }

  setLastWords(id: string, words: string | null): void {
    this.db.prepare(`UPDATE ${ROUTINES_TABLE} SET last_words = ? WHERE id = ?`).run(words, id)
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM ${RUNS_TABLE} WHERE routine_id = ?`).run(id)
    this.db.prepare(`DELETE FROM ${ROUTINES_TABLE} WHERE id = ?`).run(id)
  }

  /** Every routine of the workspace, and their runs. Their threads stay. */
  /** The routines that run this play: one that has ended runs nothing, and lets it go. */
  runningPlay(playId: string): Routine[] {
    return (this.db.prepare(`SELECT * FROM ${ROUTINES_TABLE} WHERE play_id = ? AND ended = 0`).all(playId) as Row[]).flatMap((r) => routineOf(r) ?? [])
  }

  removeWorkspace(workspaceId: string): string[] {
    const ids = (this.db.prepare(`SELECT id FROM ${ROUTINES_TABLE} WHERE workspace_id = ?`).all(workspaceId) as { id: string }[]).map((r) => r.id)
    for (const id of ids) this.remove(id)
    return ids
  }

  /** The watches set by these threads. */
  watchesOf(sessionIds: readonly string[]): Routine[] {
    if (!sessionIds.length) return []
    const marks = sessionIds.map(() => '?').join(',')
    return (this.db.prepare(`SELECT * FROM ${ROUTINES_TABLE} WHERE resume_session_id IN (${marks})`).all(...sessionIds) as Row[]).flatMap((r) => routineOf(r) ?? [])
  }

  // ── runs ──────────────────────────────────────────────────────────────

  /**
   * A firing, written with the routine's next due time in one step, so a
   * kill between the two can neither lose the schedule nor fire it twice.
   */
  newRun(routineId: string, at: number, cause: string, folded: number, state: RoutineRunState, o: { sessionId?: string | null; summary?: string; nextAt?: number | null } = {}): RoutineRun {
    const id = nanoid(12)
    this.db.exec('SAVEPOINT routine_run')
    try {
      this.db
        .prepare(`INSERT INTO ${RUNS_TABLE} (id, routine_id, session_id, fired_at, cause, folded, state, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, routineId, o.sessionId ?? null, at, cause, folded, state, o.summary ?? '')
      this.db
        .prepare(`UPDATE ${ROUTINES_TABLE} SET last_at = ?, last_state = ?, last_words = ?, last_session_id = COALESCE(?, last_session_id) WHERE id = ?`)
        .run(at, state, o.summary || null, o.sessionId ?? null, routineId)
      if (o.nextAt !== undefined) this.db.prepare(`UPDATE ${ROUTINES_TABLE} SET next_at = ? WHERE id = ?`).run(o.nextAt, routineId)
      this.db.exec('RELEASE routine_run')
    } catch (err) {
      this.db.exec('ROLLBACK TO routine_run')
      this.db.exec('RELEASE routine_run')
      throw err
    }
    return this.run(id)!
  }

  run(id: string): RoutineRun | null {
    const row = this.db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE id = ?`).get(id) as Row | undefined
    return row ? runOf(row) : null
  }

  runs(routineId: string, limit = 50): RoutineRun[] {
    return (this.db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE routine_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT ?`).all(routineId, limit) as Row[]).map(runOf)
  }

  /** The run of this routine that is still starting or working, if one is. */
  inFlight(routineId: string): RoutineRun | null {
    const row = this.db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE routine_id = ? AND state IN ('starting', 'running') ORDER BY fired_at DESC LIMIT 1`).get(routineId) as Row | undefined
    return row ? runOf(row) : null
  }

  /** Runs cut off by a stop: the boot settles each one. */
  unsettled(): RoutineRun[] {
    return (this.db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE state IN ('starting', 'running')`).all() as Row[]).map(runOf)
  }

  /** A firing folded into the run in flight, with the routine's next due time, in one step. */
  addFolded(runId: string, n: number, next?: { routineId: string; nextAt: number | null }): void {
    this.db.exec('SAVEPOINT routine_fold')
    try {
      this.db.prepare(`UPDATE ${RUNS_TABLE} SET folded = folded + ? WHERE id = ?`).run(n, runId)
      if (next) this.db.prepare(`UPDATE ${ROUTINES_TABLE} SET next_at = ? WHERE id = ?`).run(next.nextAt, next.routineId)
      this.db.exec('RELEASE routine_fold')
    } catch (err) {
      this.db.exec('ROLLBACK TO routine_fold')
      this.db.exec('RELEASE routine_fold')
      throw err
    }
  }

  started(runId: string, sessionId: string): void {
    const run = this.run(runId)
    this.db.prepare(`UPDATE ${RUNS_TABLE} SET session_id = ?, state = 'running' WHERE id = ?`).run(sessionId, runId)
    if (run) this.db.prepare(`UPDATE ${ROUTINES_TABLE} SET last_session_id = ?, last_state = 'running' WHERE id = ?`).run(sessionId, run.routineId)
  }

  /** A run's end, and its routine's last state, together. `open`: what a job run's row opens. */
  settle(runId: string, state: RoutineRunState, summary: string, open?: RoutineJobOpen): RoutineRun | null {
    const run = this.run(runId)
    if (!run) return null
    this.db.prepare(`UPDATE ${RUNS_TABLE} SET state = ?, summary = ?, open = COALESCE(?, open) WHERE id = ?`).run(state, summary, open ? JSON.stringify(open) : null, runId)
    // Only the newest run speaks for the routine.
    this.db
      .prepare(`UPDATE ${ROUTINES_TABLE} SET last_state = ?, last_words = ? WHERE id = ? AND (last_at IS NULL OR last_at <= ?)`)
      .run(state, summary, run.routineId, run.firedAt)
    return this.run(runId)
  }
}
