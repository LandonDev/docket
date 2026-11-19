import type { DatabaseSync } from 'node:sqlite'
import { nanoid } from 'nanoid'
import type { OutboxItem, WorkResult } from '@shared/contract-work-outbox'
import type { UndoSpec } from '@shared/work'
import { WORK_MODULES, type WorkCtx } from '../modules'
import type { CtxPart } from '../ctx'

/**
 * `ctx.results`: what a thread changed that lasts (`work_results`), with
 * its way back (docs/agents/work-outbox.md, "Results"). A pillar's write on
 * the owner's own files calls `ctx.results.add` with the inverse call; a
 * send that left makes one here too, with its kind's `wayBack`. The thread's
 * right panel lists them; the return from Away lists the writes made since
 * Away began. Undo runs the inverse call once, as the thread's own tool.
 */

export const RESULTS_TABLE = 'work_results'

export const NO_SUCH_RESULT = 'no such result on this host'
export const CANNOT_UNDO = 'refused: this cannot be taken back'
export const ALREADY_UNDONE = 'refused: already undone'

export function ensureResults(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RESULTS_TABLE} (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      root_id      TEXT NOT NULL,
      workspace_id TEXT,
      kind         TEXT NOT NULL,
      summary      TEXT NOT NULL,
      account      TEXT,
      ref          TEXT,
      undo         TEXT,
      undone_at    INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_results_root ON ${RESULTS_TABLE} (root_id, created_at);
    CREATE INDEX IF NOT EXISTS work_results_session ON ${RESULTS_TABLE} (session_id);
    CREATE INDEX IF NOT EXISTS work_results_created ON ${RESULTS_TABLE} (created_at);
  `)
}

type Row = { id: string; session_id: string; root_id: string; workspace_id: string | null; kind: string; summary: string; account: string | null; ref: string | null; undo: string | null; undone_at: number | null; created_at: number }

const json = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const wire = (r: Row): WorkResult => ({
  id: r.id,
  sessionId: r.session_id,
  rootId: r.root_id,
  workspaceId: r.workspace_id,
  kind: r.kind,
  summary: r.summary,
  account: r.account,
  ref: json(r.ref),
  undo: json(r.undo) as UndoSpec | null,
  undoneAt: r.undone_at,
  createdAt: r.created_at
})

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The Results table on one host, and the one way to carry a result back. */
export class Results {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ctx: WorkCtx,
    private readonly now: () => number = Date.now
  ) {}

  add(r: { sessionId: string; kind: string; summary: string; account?: string; ref?: unknown; undo?: UndoSpec }): WorkResult {
    const id = nanoid()
    const workspaceId = this.ctx.scopeOf(r.sessionId)?.workspaceId ?? null
    this.db
      .prepare(`INSERT INTO ${RESULTS_TABLE} (id, session_id, root_id, workspace_id, kind, summary, account, ref, undo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, r.sessionId, this.rootOf(r.sessionId), workspaceId, r.kind, r.summary, r.account ?? null, r.ref === undefined ? null : JSON.stringify(r.ref), r.undo ? JSON.stringify(r.undo) : null, this.now())
    const result = this.get(id)!
    this.ctx.push({ push: 'work.outbox.result', result }, { need: 'read' })
    return result
  }

  get(id: string): WorkResult | null {
    const row = this.db.prepare(`SELECT * FROM ${RESULTS_TABLE} WHERE id = ?`).get(id) as Row | undefined
    return row ? wire(row) : null
  }

  /** The thread whose panel lists a result: the root of the tree (a subagent's writes are its root's). */
  private rootOf(sessionId: string): string {
    try {
      return this.ctx.canvas.paneOf(sessionId)
    } catch {
      return sessionId
    }
  }

  /** A root thread's results with its subagents' (a subagent asking gets its own), or every one since a time; newest first. */
  list(q: { sessionId?: string; since?: number; limit?: number }): WorkResult[] {
    const limit = q.limit ?? 200
    const where: string[] = []
    const args: (string | number)[] = []
    if (q.sessionId !== undefined) {
      where.push('(root_id = ? OR session_id = ?)')
      args.push(q.sessionId, q.sessionId)
    }
    if (q.since !== undefined) {
      where.push('created_at >= ?')
      args.push(q.since)
    }
    const sql = `SELECT * FROM ${RESULTS_TABLE}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`
    return (this.db.prepare(sql).all(...args, limit) as Row[]).map(wire)
  }

  /**
   * Runs a result's way back, once: the row is claimed by one UPDATE before
   * the call starts, so a second press finds it undone and runs nothing. A
   * call that fails gives the claim back, so he can try again.
   */
  async undo(id: string, signal: AbortSignal): Promise<WorkResult> {
    const result = this.get(id)
    if (!result) throw new Error(NO_SUCH_RESULT)
    if (!result.undo) throw new Error(CANNOT_UNDO)
    const claimed = this.db.prepare(`UPDATE ${RESULTS_TABLE} SET undone_at = ? WHERE id = ? AND undone_at IS NULL`).run(this.now(), id)
    if (Number(claimed.changes) !== 1) throw new Error(ALREADY_UNDONE)
    try {
      await this.runBack(result.sessionId, result.undo, signal)
    } catch (err) {
      this.db.prepare(`UPDATE ${RESULTS_TABLE} SET undone_at = NULL WHERE id = ?`).run(id)
      throw new Error(`couldn't undo: ${errorText(err)}`)
    }
    const done = this.get(id)!
    this.ctx.push({ push: 'work.outbox.result', result: done }, { need: 'read' })
    return done
  }

  /** The inverse call is a tool of the pillar that wrote, run as the thread that wrote. */
  private async runBack(sessionId: string, undo: UndoSpec, signal: AbortSignal): Promise<void> {
    const scope = this.ctx.scopeOf(sessionId)
    if (!scope) throw new Error('the thread that wrote it is gone')
    const mod = WORK_MODULES.find((m) => m.id === undo.pillar)
    const tool = mod?.tools?.(scope).find((t) => t.name === undo.verb || t.name === `${undo.pillar}_${undo.verb}`)
    if (!tool) throw new Error(`${undo.pillar} has no ${undo.verb} on this host`)
    const parsed = tool.input.safeParse(undo.args ?? {})
    if (!parsed.success) throw new Error(`the way back no longer fits ${tool.name}`)
    const answer = await tool.run(parsed.data, { ...this.ctx, scope, sessionId, signal })
    if (answer.isError) throw new Error(answer.content.map((c) => ('text' in c ? c.text : '')).join(' ').trim() || 'it failed')
  }

  /** A send that left makes a Result, with its kind's way back; a mail's is none. */
  sent(item: OutboxItem): void {
    if (item.state !== 'sent' || !item.sessionId) return
    const def = WORK_MODULES.flatMap((m) => m.acts ?? []).find((d) => d.kind === item.kind)
    const undo = item.result && def?.wayBack ? def.wayBack(item.result) : null
    // "Echo with Slack: “Standup at 10”": what it was about is the row's detail, so sends of one tool read apart.
    const cut = item.summary.indexOf(': ')
    const about = cut > 0 ? item.summary.slice(cut + 2) : item.account
    this.add({
      sessionId: item.sessionId,
      kind: item.kind,
      summary: item.result?.summary || item.summary,
      ...(about ? { account: about } : {}),
      ref: { held: item.ref, ...(item.result?.ref !== undefined ? { open: item.result.ref } : {}) },
      ...(undo ? { undo } : {})
    })
  }
}

const parts = new WeakMap<WorkCtx, Results>()

/** The context's Results, for the outbox module's methods. */
export const resultsOf = (ctx: WorkCtx): Results | null => parts.get(ctx) ?? null

export const resultsPart: CtxPart<'results'> = (ctx, deps) => {
  const results = new Results(deps.db, ctx)
  parts.set(ctx, results)
  // A send that left, from any thread on this host, while Work is on (the hold sends nothing while it is off).
  deps.whileOn(() => ctx.held.onDecided((item) => results.sent(item as OutboxItem)))
  return {
    results: {
      add: (r) => void results.add(r)
    }
  }
}
