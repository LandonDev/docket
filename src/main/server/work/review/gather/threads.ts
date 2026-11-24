import type { DatabaseSync } from 'node:sqlite'
import type { HostPoint, Span } from '@shared/work/review'
import { breathe, stopped, type Jobs } from './common'

/**
 * What this host's Work threads say about a week: when he wrote in them (a point each, the estimate's main
 * evidence) and how long they worked (measured from their `status` rows).
 *
 * The events table holds millions of rows, its one index is `(session_id, seq)`, and SQLite answers on the host's
 * own loop. So the read is bounded and handed back often (docs/agents/work-review.md "The scan"):
 *
 *  1. only the Work threads touched in the span are opened (`updated_at >= from AND created_at < to`);
 *  2. a thread's rows for the span are found by bisection on `ts` over its `seq` range, since both only grow;
 *  3. those rows are read a batch at a time. A batch is sized by bytes, not by rows: the rows' lengths are read first
 *     (`length(payload)`, which SQLite answers from the row's header without loading it), a row at a time with an
 *     eye on the clock, and the batch ends once the rows it would parse add up to its budget. A batch that ran long
 *     halves the budget; a quick one doubles it. One clock runs over the whole read (`pace`): the loop is handed
 *     back after every batch, and after any run of probes or headers that has held it for `SLICE_AIM_MS`.
 *  4. a row over `ROW_MOST` bytes is never loaded: a tool's output or a picture, or a paste so long it is no sign of
 *     typing. A status row is a few dozen bytes, so only rows under `STATUS_MOST` are looked at for one.
 *
 * A message counts only when he wrote it (`by`: the owner at this host, or a key that could approve). A row from
 * before rows said who wrote them counts only at the top of a tree no model could have written into, as
 * work/threads.ts `ownerMessages` reads them. A subagent's thread counts under its top thread's job.
 */

/** The setting that names the host a thread was started from (remote/crossHostThreads.ts `OWNER_PREFIX`; threads.test.ts holds the two equal). */
export const FAR_OWNER_PREFIX = 'crossHost.owner.'

/** A slice is aimed at this long; one over `SLICE_LONG_MS` halves the next one's budget. */
const SLICE_AIM_MS = 8
const SLICE_LONG_MS = 20
/** A slice's budget: the bytes of rows it will load, and the rows whose lengths it reads to find them. */
const BUDGET_START = 256 * 1024
const BUDGET_MIN = 32 * 1024
const BUDGET_MAX = 4 * 1024 * 1024
const HEADS = 2_000
/** A row longer than this is never loaded; a status row is far shorter than `STATUS_MOST`. */
export const ROW_MOST = 256 * 1024
const STATUS_MOST = 400
/** How far back, in rows, the read looks for the status a thread was in when the span began. */
const LOOK_BACK = 400
/** How far on, in rows, the read looks past the span's end for the status that closed a turn still open there. */
const LOOK_AHEAD = 400

type SessionRow = { id: string; parent_id: string | null; workspace_id: string | null; cold: number | null; routine_run_id: string | null; master_id: string | null; started_by: string | null; status: string; created_at: number; updated_at: number }
type Statement = ReturnType<DatabaseSync['prepare']>
type Statements = { ends: Statement; probe: Statement; prior: Statement; next: Statement; lastBefore: Statement; heads: Statement; read: Statement }
type EventRow = { seq: number; ts: number; t: string | null; st: string | null; bk: string | null; bo: number | null }

const WORKING = new Set(['running', 'starting'])

export type ThreadFacts = {
  /** his messages in the week */
  points: HostPoint[]
  /** his messages in the same span of the week before */
  before: HostPoint[]
  ran: [job: number, ms: number][]
  /** how the read went, for the bench: slices run, the longest in ms, threads opened, rows read */
  cost: { slices: number; longestMs: number; threads: number; rows: number }
}

/** `every`: for the bench alone (scripts/bench-review.ts), every thread of the host read as one job, so the read is timed at the size of the whole database. */
export async function scanThreads(db: DatabaseSync, week: Span, before: Span | null, jobs: Jobs, signal?: AbortSignal, every = false): Promise<ThreadFacts> {
  const lo = before ? Math.min(before.from, week.from) : week.from
  const hi = week.to
  const all = db.prepare(`SELECT id, parent_id, workspace_id, cold, routine_run_id, master_id, started_by, status, created_at, updated_at FROM sessions${every ? '' : ` WHERE scope = 'work'`}`).all() as unknown as SessionRow[]
  const byId = new Map(all.map((s) => [s.id, s]))
  const rootOf = (s: SessionRow): SessionRow => {
    let at = s
    for (let hops = 0; at.parent_id && hops < 32; hops++) {
      const up = byId.get(at.parent_id)
      if (!up) break
      at = up
    }
    return at
  }
  const farOwner = db.prepare('SELECT value FROM settings WHERE key = ?')

  const facts: ThreadFacts = { points: [], before: [], ran: [], cost: { slices: 0, longestMs: 0, threads: 0, rows: 0 } }
  const ranMs = new Map<number, number>()
  let budget = BUDGET_START

  // One clock for the whole read: the time since the loop was last handed back. `pace` hands it back once that
  // passes the aim (or at once, after a batch of rows was loaded), so no step of the read, a probe, a run of row
  // headers or a batch, is ever followed by another without the host getting a turn.
  let mark = performance.now()
  const pace = async (now = false): Promise<void> => {
    const held = performance.now() - mark
    if (!now && held < SLICE_AIM_MS) return
    facts.cost.slices++
    facts.cost.longestMs = Math.max(facts.cost.longestMs, held)
    await breathe()
    stopped(signal)
    mark = performance.now()
  }

  // The statements, made once a table: a week opens thousands of threads.
  const made = new Map<string, Statements>()
  const statements = (table: string): Statements => {
    let st = made.get(table)
    if (!st) {
      st = {
        ends: db.prepare(`SELECT MIN(seq) AS a, MAX(seq) AS b FROM ${table} WHERE session_id = ?`),
        probe: db.prepare(`SELECT seq, ts FROM ${table} WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT 1`),
        // Only short rows are looked at, so a tool's output in the rows before the span is never loaded.
        prior: db.prepare(`SELECT json_extract(payload, '$.status') AS st FROM ${table} WHERE session_id = ? AND seq >= ? AND seq < ? AND length(payload) <= ${STATUS_MOST} AND json_extract(payload, '$.type') = 'status' ORDER BY seq DESC LIMIT 1`),
        // The first status at or past the span's end, among short rows a bounded way on: what closed a turn open there.
        next: db.prepare(`SELECT ts, json_extract(payload, '$.status') AS st FROM ${table} WHERE session_id = ? AND seq >= ? AND seq < ? AND length(payload) <= ${STATUS_MOST} AND json_extract(payload, '$.type') = 'status' ORDER BY seq LIMIT 1`),
        // The time of the last row before the span's end, of any kind (a tool's output too), by its key alone.
        lastBefore: db.prepare(`SELECT ts FROM ${table} WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1`),
        heads: db.prepare(`SELECT seq, length(payload) AS n FROM ${table} WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq LIMIT ${HEADS}`),
        read: db.prepare(
          `SELECT seq, ts, json_extract(payload, '$.type') AS t, json_extract(payload, '$.status') AS st, json_extract(payload, '$.by.kind') AS bk, json_extract(payload, '$.by.owner') AS bo
           FROM ${table} WHERE session_id = ? AND seq >= ? AND seq < ? AND length(payload) <= ${ROW_MOST}
             AND (instr(payload, '"type":"user-text"') > 0 OR (length(payload) <= ${STATUS_MOST} AND instr(payload, '"type":"status"') > 0)) ORDER BY seq`
        )
      }
      made.set(table, st)
    }
    return st
  }

  for (const s of all) {
    if (s.updated_at < lo || s.created_at >= hi) continue
    const root = rootOf(s)
    const job = every ? 0 : root.workspace_id ? jobs.byWorkspace.get(root.workspace_id) : undefined
    if (job === undefined) continue
    facts.cost.threads++
    const st = statements(s.cold ? 'cold.events' : 'events')
    const ends = st.ends.get(s.id) as { a: number | null; b: number | null }
    if (ends.a === null || ends.b === null) continue
    /** The first seq whose row is at or after `ts`; one past the last when none is. */
    const seqAt = async (ts: number): Promise<number> => {
      let a = ends.a!
      let b = ends.b! + 1
      while (a < b) {
        const mid = Math.floor((a + b) / 2)
        const row = st.probe.get(s.id, mid) as { seq: number; ts: number } | undefined
        if (!row || row.ts >= ts) b = mid
        else a = row.seq + 1
        await pace()
      }
      return a
    }
    const first = await seqAt(lo)
    const last = await seqAt(hi)

    // Whether the thread was working when the span began: its last status in the rows just before. A span with no
    // rows of its own still counts, whole, for a turn that was open across it.
    const prior = st.prior.get(s.id, Math.max(ends.a, first - LOOK_BACK), first) as { st: string | null } | undefined
    let since: number | null = prior?.st && WORKING.has(prior.st) ? lo : null
    await pace()
    if (first >= last && since === null) continue

    // A row before F1 says nothing of who wrote it: it counts only where no model could have written.
    const legacy = s === root && !s.parent_id && !s.routine_run_id && !s.master_id && !s.started_by && !(farOwner.get(`${FAR_OWNER_PREFIX}${s.id}`) as { value?: string } | undefined)?.value
    const worked = (from: number, to: number): void => {
      const a = Math.max(from, week.from)
      const b = Math.min(to, week.to)
      if (b > a) ranMs.set(job, (ranMs.get(job) ?? 0) + (b - a))
    }
    /**
     * Where a turn still open at the span's end ends: past the span when the status that closed it came after the
     * cut (it ran across Sunday midnight); to the span's end while the thread works now; else at its last row in
     * the span, of any kind (a host that stopped mid-turn never wrote the status that ends it, and a tool's output
     * is still the turn at work).
     */
    const openEnd = (): number => {
      const next = st.next.get(s.id, last, last + LOOK_AHEAD) as { ts: number; st: string | null } | undefined
      if (next?.st && !WORKING.has(next.st)) return next.ts
      if (!next && WORKING.has(s.status)) return week.to
      return (st.lastBefore.get(s.id, last) as { ts: number } | undefined)?.ts ?? lo
    }

    for (let at = first; at < last; ) {
      // Where this batch ends: the first row past its budget of bytes to load, or where the time for reading
      // headers ran out. Headers come a row at a time, so the clock is looked at as they do.
      let end = last
      let bytes = 0
      let seen = 0
      let lastSeq = at
      // A runtime from before `iterate` reads the headers in one go: they are short, and the batch is still bounded.
      const lengths = (typeof st.heads.iterate === 'function' ? st.heads.iterate(s.id, at, last) : st.heads.all(s.id, at, last)) as Iterable<{ seq: number; n: number }>
      for (const h of lengths) {
        seen++
        lastSeq = h.seq
        if (h.n <= ROW_MOST) {
          if (bytes > 0 && bytes + h.n > budget) {
            end = h.seq
            break
          }
          bytes += h.n
        }
        if (seen % 64 === 0 && performance.now() - mark > SLICE_AIM_MS) {
          end = h.seq + 1
          break
        }
      }
      if (end === last && seen === HEADS) end = lastSeq + 1
      const began = performance.now()
      const rows = bytes > 0 ? (st.read.all(s.id, at, end) as unknown as EventRow[]) : []
      for (const r of rows) {
        if (r.t === 'user-text') {
          const his = r.bk === null ? legacy : r.bk === 'owner' || (r.bk === 'key' && !!r.bo)
          if (!his) continue
          if (r.ts >= week.from && r.ts < week.to) facts.points.push([r.ts, job, 'said'])
          else if (before && r.ts >= before.from && r.ts < before.to) facts.before.push([r.ts, job, 'said'])
        } else if (r.t === 'status' && r.st) {
          if (WORKING.has(r.st)) since ??= r.ts
          else if (since !== null) {
            worked(since, r.ts)
            since = null
          }
        }
      }
      // The batch's own time sets the next one's budget.
      const took = performance.now() - began
      if (took > SLICE_LONG_MS) budget = Math.max(BUDGET_MIN, Math.floor(budget / 2))
      else if (took < SLICE_AIM_MS / 2) budget = Math.min(BUDGET_MAX, budget * 2)
      facts.cost.rows += end - at
      at = end
      await pace(rows.length > 0 || bytes > 0)
    }
    // Still working when the rows ran out (`openEnd` says to when), each read bounded.
    if (since !== null) {
      worked(since, openEnd())
      await pace()
    }
  }
  await pace(true)
  facts.ran = [...ranMs.entries()].sort((a, b) => a[0] - b[0])
  return facts
}
