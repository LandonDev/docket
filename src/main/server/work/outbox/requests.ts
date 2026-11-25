import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DecisionResult, OutboxItem, OutboxRequest, OutboxRequestRow } from '@shared/contract-work-outbox'
import { errorText, needsHim, workText, type HeldRef, type WorkToolResult } from '@shared/work'
import { judgeAsk, type AskAction, type AskItem } from '@shared/work/outboxAsk'
import { summaryHead } from '@shared/work/outboxHead'
import type { Caller, ToolCtx, WorkCtx, WorkTool } from '../modules'
import { pressesFor } from '../files/policy'
import { LATER, type Outbox } from './outbox'
import { PRIVATE_CHANGE, PRIVATE_CHANGE_KINDS } from './words'

/**
 * A thread asks for his press (docs/agents/work-outbox.md "A thread asks for his press"). When he tells a Work thread
 * in so many words to send, discard or schedule some of its held items, the thread calls `outbox_request`: the host
 * checks his words (shared/work/outboxAsk.ts), stores one request and answers "asked". It performs nothing. The
 * transcript draws a card from the request's id; every press on it is his window's or his phone's own
 * `work.outbox.decide({request, receipts})` or `decline`, behind the Outbox's person gate. Away, a model, a routine,
 * a guest and a far parent have no way to reach either: no tool names them.
 *
 * What his press may release is bound to what he saw (the plan's contract, rule 4): each row he can press is a receipt
 * this host issued for this request, at the revision the card drew; the press names receipts, and the host allows
 * omissions only. One `UPDATE` claims the request, so a second press, device or tab gets it as it stands.
 */

export const REQUESTS_TABLE = 'work_outbox_requests'
/** A request lasts a day from the message of his that asked for it. */
export const REQUEST_TTL_MS = 24 * 3_600_000
/** How many of his newest messages may carry the words, and how old they may be. */
const OWNER_MESSAGES = 3
/** The most items of one job a request is judged against; past it the host refuses rather than judge part of them. */
const REACH_MAX = 1000

export const ASK_NO_THREAD = 'Refused: only a Work thread with a job asks for his press.'
/** One refusal for a ref unknown here and one of another job's: a thread learns nothing of what waits elsewhere. */
export const ASK_UNKNOWN = (ref: string): string => `Refused: there is no waiting item ${ref} in this thread's job. Call outbox_list for the refs.`
export const ASK_TOO_MANY = 'Refused: too many items wait in this job to check his words against all of them. Ask him to send them from his Outbox.'
export const ASK_SINCE = 'Refused: some of the items his words cover were decided since he wrote them. Ask him again in words.'
export const ASK_NOT_WAITING = (ref: string): string => `Refused: item ${ref} is not waiting on him (it is being sent, scheduled or done).`
export const ASK_OPEN_IT = (ref: string): string => `Refused: item ${ref} goes only from its own page. Tell him to open it in the Outbox; it cannot be sent from a request.`
export const ASK_STALE = (ref: string): string => `Refused: item ${ref} went out of date. Only a discard can be asked for it.`
export const ASK_NO_LATER = (ref: string): string => `Refused: item ${ref} cannot be sent later.`
export const ASK_ANSWERED = 'Refused: he already answered a request from those words. Only new words of his give another; tell him the items wait in his Outbox.'
export const ASK_TWICE = 'Refused: an item is listed twice.'
export const NO_SUCH_REQUEST = 'There is no such request on this host.'
export const REQUEST_CLOSED = 'This request was already answered, or it ran out.'
export const BAD_RECEIPT = 'refused: a press on a request names only the rows this host showed for it'
export const MOVED = 'Its thread or this item moved to another job, or the thread was archived. Nothing was sent.'

type RequestState = OutboxRequest['state']
interface Asked {
  ref: HeldRef
  do: AskAction
  at?: number
  rev: number
}
interface Receipt {
  ref: HeldRef
  do: AskAction
  at?: number
  rev: number
  gen: number
}
type Row = {
  id: string
  n: number
  session_id: string
  root_id: string
  workspace_id: string | null
  sector: string | null
  quote: string
  source_seq: number
  clause_digest: string
  items: string
  receipts: string
  generation: number
  state: string
  why: string | null
  created_at: number
  expires_at: number
  answered_by: string | null
  answered_at: number | null
  answer: string | null
  results: string | null
}

export function ensureRequestTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${REQUESTS_TABLE} (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      root_id       TEXT NOT NULL,
      workspace_id  TEXT,
      sector        TEXT,
      quote         TEXT NOT NULL,
      source_seq    INTEGER NOT NULL,
      clause_digest TEXT NOT NULL,
      items         TEXT NOT NULL,
      receipts      TEXT NOT NULL DEFAULT '{}',
      generation    INTEGER NOT NULL DEFAULT 1,
      state         TEXT NOT NULL,
      why           TEXT,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      answered_by   TEXT,
      answered_at   INTEGER,
      answer        TEXT,
      results       TEXT,
      UNIQUE (session_id, source_seq)
    );
    CREATE INDEX IF NOT EXISTS work_outbox_requests_open ON ${REQUESTS_TABLE}(state, session_id);
  `)
}

const json = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
const refKey = (ref: HeldRef): string => (ref.at === 'host' ? `host:${ref.id}` : `lifeos:${ref.table}:${ref.id}`)
/** The ref a tool lists: a host row's number, or a LifeOS draft's own kind and id. */
export const toolRef = (item: Pick<OutboxItem, 'ref' | 'n'>): string => (item.n !== null ? `#${item.n}` : item.ref.at === 'lifeos' ? `${item.ref.table === 'outbox' ? 'mail' : 'calendar'}:${item.ref.id}` : item.ref.id)

/** The words a request's head says: "Send 4 mails, post 1 message and discard 2". */
export function headOf(rows: readonly { do: AskAction; kind: string }[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const verb = r.do === 'discard' ? 'discard' : r.do === 'later' ? 'send later' : r.kind === 'teams.post' || r.kind === 'chat.reply' || r.kind === 'frameio.post' ? 'post' : r.kind.includes('calendar') ? 'answer' : r.kind.startsWith('share') ? 'share' : 'send'
    counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }
  const noun = (verb: string, n: number): string => {
    const one = verb === 'post' ? 'message' : verb === 'answer' ? 'invite' : verb === 'share' ? 'share' : 'item'
    return `${n} ${n === 1 ? one : `${one}s`}`
  }
  const parts = [...counts].map(([verb, n]) => `${verb} ${noun(verb, n)}`)
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '')
  return text ? text[0]!.toUpperCase() + text.slice(1) : ''
}

export interface RequestDeps {
  ctx: WorkCtx
  outbox: Outbox
  rootOf(sessionId: string): string
  whisper(sessionId: string, text: string): void
  /** his recorded IANA zone */
  zone(): string
  /** the thread is here and not archived */
  alive(sessionId: string): boolean
  now?(): number
}

/** Each host's requests, by its database: a tool's context is made per call, its database is the host's. */
const byDb = new WeakMap<DatabaseSync, OutboxRequests>()
export const requestsOf = (ctx: Pick<WorkCtx, 'db'>): OutboxRequests | null => byDb.get(ctx.db) ?? null

export class OutboxRequests {
  /** Requests claimed whose items are still going: answered, not yet finished (`running` on the wire). */
  private readonly running = new Set<string>()

  constructor(private readonly deps: RequestDeps) {
    byDb.set(deps.ctx.db, this)
  }

  private get db(): DatabaseSync {
    return this.deps.ctx.db
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ── what a thread may see and ask ─────────────────────────────────────

  /** The waiting items a thread may name: its own tree's, and with `workspace` the same job's other threads'. Never another job's. */
  reach(sessionId: string, scope: 'thread' | 'workspace' = 'thread'): { item: OutboxItem; own: boolean }[] {
    const job = this.deps.ctx.scopeOf(sessionId)
    if (!job) return []
    const root = this.deps.rootOf(sessionId)
    // The job's whole waiting set, filtered by job before any cap: a cut list could pass part of a group as all of it.
    const listed = this.deps.outbox.list({ show: 'waiting', workspaceId: job.workspaceId ?? null, limit: REACH_MAX })
    if (listed.items.length >= REACH_MAX) throw new Error(ASK_TOO_MANY)
    return listed.items
      .filter((i) => needsHim(i) && (i.workspaceId ?? null) === (job.workspaceId ?? null) && (i.sector ?? null) === (job.sector ?? null))
      .flatMap((item) => {
        const own = !!item.sessionId && this.deps.rootOf(item.sessionId) === root
        // A Work Chat sees only its own tree; another thread's items join only when asked for.
        if (!own && (scope === 'thread' || !job.workspaceId)) return []
        return [{ item, own }]
      })
  }

  /** `outbox_list` */
  list(sessionId: string, scope: 'thread' | 'workspace' = 'thread'): WorkToolResult {
    const rows = this.reach(sessionId, scope).map(({ item, own }) => {
      const words = !own && PRIVATE_CHANGE_KINDS.has(item.kind) ? PRIVATE_CHANGE : item.summary
      return { ref: toolRef(item), act: words, state: item.state === 'stale' ? 'out of date' : item.state, thread: own ? 'this thread' : 'another thread', ...(LATER[item.kind] ? { later: true } : {}) }
    })
    if (!rows.length) return workText('Nothing waits in the Outbox for this thread.')
    return { ...workText(rows.map((r) => `${r.ref} · ${r.act} · ${r.state} · ${r.thread}`).join('\n')), structuredContent: { items: rows } }
  }

  /** `outbox_request`: one request stored, or a refusal an agent can act on. Never performs anything. */
  async ask(sessionId: string, args: { items: { ref: string; do: AskAction; at?: number }[]; quote: string }): Promise<WorkToolResult> {
    const refuse = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
    const job = this.deps.ctx.scopeOf(sessionId)
    if (!job || !this.deps.alive(sessionId)) return refuse(ASK_NO_THREAD)
    let reach: { item: OutboxItem; own: boolean }[]
    try {
      reach = this.reach(sessionId, 'workspace')
    } catch (err) {
      return refuse(errorText(err))
    }
    const byTool = new Map(reach.map((r) => [toolRef(r.item), r]))
    const seen = new Set<string>()
    const asked: Asked[] = []
    for (const a of args.items) {
      const hit = byTool.get(a.ref)
      if (!hit) return refuse(ASK_UNKNOWN(a.ref))
      const { item } = hit
      if (seen.has(refKey(item.ref))) return refuse(ASK_TWICE)
      seen.add(refKey(item.ref))
      if (!needsHim(item)) return refuse(ASK_NOT_WAITING(a.ref))
      if (item.state === 'live' || item.kind === 'computer.act' || (item.kind === 'mail.send' && (item.payload as { quote?: unknown } | null)?.quote)) return refuse(ASK_OPEN_IT(a.ref))
      if (item.state === 'stale' && a.do !== 'discard') return refuse(ASK_STALE(a.ref))
      if (a.do === 'later' && !LATER[item.kind]) return refuse(ASK_NO_LATER(a.ref))
      // The list's copy of a LifeOS reply lacks the mail it quotes: read fresh, as the press will.
      if (item.kind === 'mail.send' && item.ref.at === 'lifeos') {
        const fresh = await this.deps.outbox.get(item.ref).catch(() => null)
        if (!fresh || (fresh.payload as { quote?: unknown } | null)?.quote) return refuse(ASK_OPEN_IT(a.ref))
      }
      asked.push({ ref: item.ref, do: a.do, ...(a.at !== undefined ? { at: a.at } : {}), rev: item.updatedAt })
    }
    // The fresh LifeOS reads above yield: where the thread stands is read again before anything is stored.
    const still = this.deps.ctx.scopeOf(sessionId)
    if (!this.deps.alive(sessionId) || !still || (still.workspaceId ?? null) !== (job.workspaceId ?? null) || (still.sector ?? null) !== (job.sector ?? null)) return refuse(ASK_NO_THREAD)
    const now = this.now()
    const messages = this.deps.ctx.threads.ownerRecent(sessionId, OWNER_MESSAGES).filter((m) => m.at <= now && now - m.at <= REQUEST_TTL_MS)
    const items: AskItem[] = reach.map(({ item, own }) => ({ ref: toolRef(item), n: item.n, kind: item.kind, names: namesOf(item), own, heldAt: item.createdAt, ...(item.ref.at === 'host' ? { chipId: item.ref.id } : {}), ...(opOf(item) ? { op: opOf(item)! } : {}) }))
    const root = this.deps.rootOf(sessionId)
    // A LifeOS draft with no row here keeps no history: one of the tree's edited after his words makes "all" unprovable.
    const lifeosSince = (at: number): number => reach.filter(({ item, own }) => own && item.ref.at === 'lifeos' && item.updatedAt > at).length
    const verdict = judgeAsk({ quote: args.quote, messages, items, asked: args.items, zone: this.deps.zone(), decidedSince: (at) => this.decidedSince(root, job.workspaceId ?? null, at) + lifeosSince(at) })
    if (!verdict.ok) return refuse(verdict.refusal)
    const digest = createHash('sha256').update(verdict.clause).digest('hex').slice(0, 32)
    // One message of his gives one request per thread: the same ask again answers the one it made.
    const prior = this.db.prepare(`SELECT rowid AS n, * FROM ${REQUESTS_TABLE} WHERE session_id = ? AND source_seq = ?`).get(sessionId, verdict.source.seq) as unknown as Row | undefined
    if (prior) {
      if (prior.state !== 'open') return refuse(ASK_ANSWERED)
      return this.asked(this.view(prior))
    }
    // A newer request from the thread voids the open one.
    for (const open of this.db.prepare(`SELECT rowid AS n, * FROM ${REQUESTS_TABLE} WHERE session_id = ? AND state = 'open'`).all(sessionId) as unknown as Row[]) this.void(open, 'The thread asked again.')
    const id = `rq_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    this.db
      .prepare(
        `INSERT INTO ${REQUESTS_TABLE} (id, session_id, root_id, workspace_id, sector, quote, source_seq, clause_digest, items, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(id, sessionId, this.deps.rootOf(sessionId), job.workspaceId ?? null, job.sector ?? null, args.quote.slice(0, 2000), verdict.source.seq, digest, JSON.stringify(asked), now, verdict.source.at + REQUEST_TTL_MS)
    const made = this.view(this.row(id)!)
    this.told(made)
    return this.asked(made)
  }

  /** The tool's answer: the request's id and host alone, so the card loads it from its host; and plain words for the thread. */
  private asked(r: OutboxRequest): WorkToolResult {
    const said = `Asked: request ${r.n} lists ${r.rows.length} item${r.rows.length === 1 ? '' : 's'} (${r.head}). It waits for the owner's press on the card; nothing has been sent. Tell him it waits there, and carry on.`
    const card = { outboxRequest: { id: r.id, host: this.deps.ctx.host } }
    return { ...workText(JSON.stringify({ ...card, message: said })), structuredContent: card }
  }

  // ── what his screens read ─────────────────────────────────────────────

  private row(id: string): Row | null {
    return (this.db.prepare(`SELECT rowid AS n, * FROM ${REQUESTS_TABLE} WHERE id = ?`).get(id) as unknown as Row | undefined) ?? null
  }

  /** The open ones, voiding any that ran out or whose items were all decided elsewhere. */
  open(q: { sessionId?: string } = {}): OutboxRequest[] {
    const rows = this.db.prepare(`SELECT rowid AS n, * FROM ${REQUESTS_TABLE} WHERE state = 'open' ${q.sessionId ? 'AND session_id = ?' : ''} ORDER BY created_at ASC`).all(...(q.sessionId ? [q.sessionId] : [])) as unknown as Row[]
    return rows.flatMap((r) => {
      const v = this.settleIfDone(r)
      return v.state === 'open' ? [v] : []
    })
  }

  /** One request as the card draws it: each row its item now, and a receipt for each row he may press as drawn. */
  get(id: string, by: Caller): OutboxRequest {
    const row = this.row(id)
    if (!row) throw new Error(NO_SUCH_REQUEST)
    const v = row.state === 'open' ? this.settleIfDone(row) : this.view(row)
    return v.state === 'open' ? this.withReceipts(v, by) : this.seen(v, by)
  }

  /** He opened a row that changed since the ask: a fresh receipt at what he sees now. He ticks it himself. */
  viewRow(id: string, ref: HeldRef, by: Caller): OutboxRequestRow {
    const row = this.row(id)
    if (!row || row.state !== 'open') throw new Error(REQUEST_CLOSED)
    const asked = json<Asked[]>(row.items, []).find((a) => refKey(a.ref) === refKey(this.deps.outbox.canonical(ref)))
    if (!asked) throw new Error(BAD_RECEIPT)
    const item = this.itemOf(asked.ref)
    if (!item || !needsHim(item) || !this.placed(row, [asked.ref])) throw new Error(REQUEST_CLOSED)
    const receipt = this.issue(row, { ref: asked.ref, do: asked.do, ...(asked.at !== undefined ? { at: asked.at } : {}), rev: item.updatedAt })
    return { ref: asked.ref, do: asked.do, ...(asked.at !== undefined ? { at: asked.at } : {}), item: this.shown(item, by), receipt, changed: false, open: true }
  }

  // ── his press ─────────────────────────────────────────────────────────

  /**
   * His Send on the card. One check of the whole press (open, his host, the generation, the time left, each receipt
   * this request's), one `UPDATE` that claims the request and keeps the answer, then each ticked item through the
   * Outbox's own decide, as one press of many. A second press finds it answered and gets the answer it holds.
   */
  async answer(id: string, receipts: readonly string[], by: string): Promise<OutboxRequest> {
    const row = this.row(id)
    if (!row) throw new Error(NO_SUCH_REQUEST)
    if (row.state !== 'open' || row.expires_at <= this.now()) return this.view(row.state === 'open' ? this.void(row, 'It ran out.') : row)
    const issued = json<Record<string, Receipt>>(row.receipts, {})
    const unique = [...new Set(receipts)]
    const chosen = unique.map((rid) => issued[rid])
    if (!unique.length || chosen.some((r) => !r || r.gen !== Number(row.generation))) throw new Error(BAD_RECEIPT)
    const refs = new Set(chosen.map((r) => refKey(r!.ref)))
    if (refs.size !== chosen.length) throw new Error(BAD_RECEIPT)
    const asked = json<Asked[]>(row.items, [])
    if (chosen.some((r) => !asked.some((a) => refKey(a.ref) === refKey(r!.ref) && a.do === r!.do && a.at === r!.at))) throw new Error(BAD_RECEIPT)
    // Where it all stands now: the thread still here, in the same job, and each item still of that job.
    if (!this.placed(row, chosen.map((r) => r!.ref))) return this.view(this.void(row, 'Its thread or an item moved to another job, or the thread was archived.'))
    const claimed = this.db
      .prepare(`UPDATE ${REQUESTS_TABLE} SET state = 'answered', answered_by = ?, answered_at = ?, answer = ? WHERE id = ? AND state = 'open' AND generation = ? AND expires_at > ?`)
      .run(by, this.now(), JSON.stringify(unique), id, row.generation, this.now())
    if (Number(claimed.changes) !== 1) return this.view(this.row(id)!)
    // Claimed, and its items still to go: a read meanwhile says so, so a press read back now is not called done.
    this.running.add(id)
    try {
      await this.run(id, row, chosen as Receipt[], asked, by)
    } finally {
      this.running.delete(id)
    }
    // Finished (or cut off): the answer and the push say the press's end.
    this.pushed(id)
    return this.view(this.row(id)!)
  }

  /** The claimed press's items, each through the Outbox's own decide, its results kept as each settles. */
  private async run(id: string, row: Row, chosen: Receipt[], asked: Asked[], by: string): Promise<void> {
    const root = row.root_id
    // What became of each item is kept as it settles: a press cut off keeps what it reached, and what it never reached
    // reads as not started, never as done.
    const kept: { ref: HeldRef; ok: boolean; error?: string; state?: string; unknown?: true }[] = []
    const keep = (r: DecisionResult): void => {
      // An item the host could not confirm keeps that: May have gone, never "not sent", on every surface.
      kept.push({ ref: r.ref, ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.item ? { state: r.item.state } : {}), ...(!r.ok && r.item?.outcomeUnknown ? { unknown: true as const } : {}) })
      this.db.prepare(`UPDATE ${REQUESTS_TABLE} SET results = ? WHERE id = ?`).run(JSON.stringify(kept), id)
    }
    const results = await this.deps.outbox.decide(
      chosen.map((r) => ({ ref: r.ref, do: r.do, rev: r.rev, ...(r.at !== undefined ? { at: r.at } : {}) })),
      {
        by,
        via: `request:${id}`,
        many: true,
        // The asking thread hears one note for the whole press, in place of a note per item of its own.
        quiet: (item) => !!item.sessionId && this.deps.rootOf(item.sessionId) === root,
        // Where it stands is checked again inside each item's own lock, just before its claim: a thread archived or an
        // item moved while earlier items were going stops the rest.
        admit: (item) => (this.placedNow(row, item) ? null : MOVED),
        onResult: keep
      }
    )
    const left = asked.length - chosen.length
    this.tellThread(row, answerNote(row.n, results, left))
    this.deps.ctx.tell.done(requestKey(id))
  }

  /** Not now: the items still wait in his Outbox. */
  decline(id: string, by: string): OutboxRequest {
    const row = this.row(id)
    if (!row) throw new Error(NO_SUCH_REQUEST)
    if (row.state === 'open' && row.expires_at <= this.now()) return this.view(this.void(row, 'It ran out.'))
    const done = this.db.prepare(`UPDATE ${REQUESTS_TABLE} SET state = 'declined', answered_by = ?, answered_at = ? WHERE id = ? AND state = 'open' AND expires_at > ?`).run(by, this.now(), id, this.now())
    if (Number(done.changes) === 1) {
      this.tellThread(row, `The owner chose Not now on request ${row.n}. The items still wait in his Outbox. Do not ask again unless he asks.`)
      this.deps.ctx.tell.done(requestKey(id))
      this.pushed(id)
    }
    return this.view(this.row(id)!)
  }

  /** The threads that asked are gone: their open requests end. */
  sessionsRemoved(ids: readonly string[]): void {
    for (const id of ids) for (const r of this.db.prepare(`SELECT rowid AS n, * FROM ${REQUESTS_TABLE} WHERE (session_id = ? OR root_id = ?) AND state = 'open'`).all(id, id) as unknown as Row[]) this.void(r, 'Its thread was removed.', false)
  }

  /**
   * Every open request told again in the notice's words of now: a row the ledger kept from before, with his quote in
   * it, is replaced under its key by one without (the digest keeps one row a key).
   */
  retell(): void {
    try {
      // The stored rows as they are: LifeOS's list may not have arrived yet, so nothing is judged decided here.
      for (const row of this.db.prepare(`SELECT rowid AS n, * FROM ${REQUESTS_TABLE} WHERE state = 'open'`).all() as unknown as Row[]) this.told(this.view(row), { push: false })
      // A request answered, declined or void whose notice outlived it (a stop before its `done`) leaves the ledger.
      for (const row of this.db.prepare(`SELECT id FROM ${REQUESTS_TABLE} WHERE state != 'open'`).all() as { id: string }[]) this.deps.ctx.tell.done(requestKey(row.id))
    } catch (err) {
      this.deps.ctx.log(`outbox: open requests were not told again: ${errorText(err)}`)
    }
  }

  /** Every open request that ran out or whose items were all decided elsewhere, ended now. */
  sweep(): void {
    try {
      this.open()
    } catch (err) {
      this.deps.ctx.log(`outbox: requests were not swept: ${errorText(err)}`)
    }
  }

  // ── inside ────────────────────────────────────────────────────────────

  private settleIfDone(row: Row): OutboxRequest {
    if (row.expires_at <= this.now()) return this.view(this.void(row, 'It ran out.'))
    if (!this.placed(row, [])) return this.view(this.void(row, 'Its thread moved to another job, or was archived.'))
    const asked = json<Asked[]>(row.items, [])
    // An item LifeOS holds is unknown here until its list has arrived: absent then is not decided.
    const loaded = this.deps.outbox.lifeos?.loadedTables?.() ?? null
    const unknown = asked.some((a) => a.ref.at === 'lifeos' && !this.itemOf(a.ref) && !(a.ref.table === 'outbox' ? loaded?.outbox : loaded?.calendarOps))
    const items = asked.map((a) => this.itemOf(a.ref))
    if (!unknown && items.every((i) => !i || !needsHim(i))) return this.view(this.void(row, 'Every item was decided elsewhere.'))
    return this.view(row)
  }

  private void(row: Row, why: string, tell = true): Row {
    const done = this.db.prepare(`UPDATE ${REQUESTS_TABLE} SET state = 'void', why = ?, generation = generation + 1 WHERE id = ? AND state = 'open'`).run(why, row.id)
    if (Number(done.changes) === 1) {
      if (tell) this.tellThread(row, `Request ${row.n} ran out; the items still wait in his Outbox.`)
      this.deps.ctx.tell.done(requestKey(row.id))
      this.pushed(row.id)
    }
    return this.row(row.id) ?? row
  }

  /** The asking thread is still here, unarchived, in the request's job, and each named item is still of that job. */
  private placed(row: Row, refs: readonly HeldRef[]): boolean {
    if (!this.deps.alive(row.session_id)) return false
    const job = this.deps.ctx.scopeOf(row.session_id)
    if (!job || (job.workspaceId ?? null) !== row.workspace_id || (job.sector ?? null) !== row.sector) return false
    return refs.every((ref) => {
      const item = this.itemOf(ref)
      return !!item && this.itemPlaced(row, item)
    })
  }

  /** The request's thread still stands where it asked, and this row's item too (`admit`, inside the item's lock). */
  private placedNow(row: Row, item: { workspaceId: string | null; sector: string | null; sessionId: string | null }): boolean {
    return this.placed(row, []) && this.itemPlaced(row, item)
  }

  /** An item is of the request's job by its stamp and by where its own thread stands now. */
  private itemPlaced(row: Row, item: { workspaceId: string | null; sector: string | null; sessionId: string | null }): boolean {
    if ((item.workspaceId ?? null) !== row.workspace_id || (item.sector ?? null) !== row.sector) return false
    if (!item.sessionId) return true
    const now = this.deps.ctx.scopeOf(item.sessionId)
    return !!now && (now.workspaceId ?? null) === row.workspace_id && (now.sector ?? null) === row.sector
  }

  /** How many of the asking tree's items, held before `at` and waiting then, were decided after it. */
  private decidedSince(root: string, workspaceId: string | null, at: number): number {
    const rows = this.db
      .prepare(
        `SELECT session_id FROM work_held_acts WHERE ${workspaceId === null ? 'workspace_id IS NULL' : 'workspace_id = ?'} AND created_at <= ? AND ((decided_at IS NOT NULL AND decided_at > ?) OR (dismissed_at IS NOT NULL AND dismissed_at > ?) OR (state IN ('held', 'failed', 'scheduled', 'stale') AND updated_at > ?))`
      )
      .all(...(workspaceId === null ? [] : [workspaceId]), at, at, at, at) as { session_id: string | null }[]
    return rows.filter((r) => !!r.session_id && this.deps.rootOf(r.session_id) === root).length
  }

  private itemOf(ref: HeldRef): OutboxItem | null {
    return this.deps.outbox.itemNow(ref)
  }

  private view(row: Row): OutboxRequest {
    const asked = json<Asked[]>(row.items, [])
    const issued = json<Record<string, Receipt>>(row.receipts, {})
    const answeredRefs = new Set(json<string[]>(row.answer, []).flatMap((rid) => (issued[rid] ? [refKey(issued[rid]!.ref)] : [])))
    const results = json<{ ref: HeldRef; ok: boolean; error?: string; state?: string; unknown?: true }[]>(row.results, [])
    const rows: OutboxRequestRow[] = asked.map((a) => {
      const item = this.itemOf(a.ref)
      // A press cut off before its results were kept still says what became of each item it reached.
      const chosenHere = row.state === 'answered' && answeredRefs.has(refKey(a.ref))
      // While the press runs, an item it has not reached yet has no result: it may still go.
      const result = results.find((r) => refKey(r.ref) === refKey(a.ref)) ?? (chosenHere && results.length && !this.running.has(row.id) ? { ok: false, error: 'not started' } : undefined)
      return { ref: a.ref, do: a.do, ...(a.at !== undefined ? { at: a.at } : {}), ...(item ? { item } : {}), changed: !!item && item.updatedAt !== a.rev, open: !!item && needsHim(item), ...(result ? { result } : {}) }
    })
    return {
      id: row.id,
      n: Number(row.n),
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      sector: row.sector,
      quote: row.quote,
      // The window's own words for it (shared/work/outboxHead.ts), so the notice, the card and the row say one thing.
      head: rows.every((r) => r.item) && rows.length ? summaryHead(rows.filter((r) => r.do === 'send').map((r) => r.item!), rows.filter((r) => r.do === 'discard').map((r) => r.item!), { later: rows.filter((r) => r.do === 'later').map((r) => r.item!) }) : headOf(asked.map((a) => ({ do: a.do, kind: rows.find((r) => refKey(r.ref) === refKey(a.ref))?.item?.kind ?? 'mail.send' }))),
      state: row.state as RequestState,
      ...(row.why ? { why: row.why } : {}),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      answeredBy: row.answered_by,
      answeredAt: row.answered_at === null ? null : Number(row.answered_at),
      rows,
      ...(this.running.has(row.id) ? { running: true as const } : {})
    }
  }

  /** Receipts for every row he may press as the card draws it now: unchanged since the ask, still waiting. */
  private withReceipts(v: OutboxRequest, by: Caller): OutboxRequest {
    const row = this.row(v.id)!
    return {
      ...this.seen(v, by),
      rows: v.rows.map((r) => {
        const shown = { ...r, ...(r.item ? { item: this.shown(r.item, by) } : {}) }
        if (!r.item || !r.open || r.changed) return shown
        return { ...shown, receipt: this.issue(row, { ref: r.ref, do: r.do, ...(r.at !== undefined ? { at: r.at } : {}), rev: r.item.updatedAt }) }
      })
    }
  }

  /** The same receipt for the same row at the same revision; a new one when it moved. */
  private issue(row: Row, r: Omit<Receipt, 'gen'>): string {
    const issued = json<Record<string, Receipt>>(this.row(row.id)?.receipts ?? row.receipts, {})
    const gen = Number(row.generation)
    const same = Object.entries(issued).find(([, x]) => refKey(x.ref) === refKey(r.ref) && x.rev === r.rev && x.do === r.do && x.at === r.at && x.gen === gen)
    if (same) return same[0]
    const rid = `rc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    issued[rid] = { ...r, gen }
    this.db.prepare(`UPDATE ${REQUESTS_TABLE} SET receipts = ? WHERE id = ?`).run(JSON.stringify(issued), row.id)
    return rid
  }

  private seen(v: OutboxRequest, by: Caller): OutboxRequest {
    return { ...v, rows: v.rows.map((r) => (r.item ? { ...r, item: this.shown(r.item, by) } : r)) }
  }

  /** A private change is his press's alone to read (index.ts `seenBy`'s rule). */
  private shown(item: OutboxItem, by: Caller): OutboxItem {
    if (pressesFor(by) || !PRIVATE_CHANGE_KINDS.has(item.kind)) return item
    return { ...item, summary: PRIVATE_CHANGE, payload: null, error: null }
  }

  private tellThread(row: Row, text: string): void {
    try {
      this.deps.whisper(row.session_id, text)
    } catch (err) {
      this.deps.ctx.log(`outbox: request ${row.n}'s thread was not told: ${errorText(err)}`)
    }
  }

  /** The notice: he asked for it and waits on it, so it does not wait for the digest. It opens the thread, where the card is. */
  private told(r: OutboxRequest, opts: { push?: boolean } = {}): void {
    try {
      // Counts and verbs alone: a digest read needs only read, and his quote can name a person or a file.
      // Counts and kinds, never a tool's or an add-on's own words: a digest read needs only read.
      const items = r.rows.every((row) => row.item) && r.rows.length
      const title = items ? summaryHead(r.rows.filter((row) => row.do === 'send').map((row) => row.item!), r.rows.filter((row) => row.do === 'discard').map((row) => row.item!), { later: r.rows.filter((row) => row.do === 'later').map((row) => row.item!), generic: true }) : r.head
      this.deps.ctx.tell({ kind: 'outbox.request', workspaceId: r.workspaceId, title: `Asked: ${title}`, key: requestKey(r.id), open: { thread: r.sessionId }, by: r.createdAt + 60_000 })
    } catch (err) {
      this.deps.ctx.log(`outbox: request ${r.n} was not told: ${errorText(err)}`)
    }
    if (opts.push !== false) this.pushed(r.id)
  }

  private pushed(id: string): void {
    try {
      const row = this.row(id)
      if (row) this.deps.ctx.push({ push: 'work.outbox.request', request: this.view(row) }, { need: 'approve' })
    } catch (err) {
      this.deps.ctx.log(`outbox: request ${id} was not pushed: ${errorText(err)}`)
    }
  }
}

export const requestKey = (id: string): string => `request:${id}`

/** A calendar act's own answer, so "accept" never names a decline. */
function opOf(item: OutboxItem): string | null {
  const p = (item.payload ?? {}) as Record<string, unknown>
  if (item.kind === 'calendar.op') return typeof p.kind === 'string' ? p.kind : null
  if (item.kind === 'office.calendar.op') return p.op === 'create' ? 'create' : typeof p.answer === 'string' ? p.answer : null
  return null
}

/** What names an item exactly, for "a unique full name": its people, its place, its file, its title. */
function namesOf(item: OutboxItem): string[] {
  const p = (item.payload ?? {}) as Record<string, unknown>
  const out: string[] = []
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.trim().length >= 3) out.push(v.trim())
  }
  const people = (list: unknown): void => {
    if (Array.isArray(list)) for (const a of list) typeof a === 'string' ? add(a) : (add((a as { name?: unknown })?.name), add((a as { address?: unknown })?.address))
  }
  const m = (p.message ?? null) as Record<string, unknown> | null
  if (m) {
    people(m.to)
    add(m.subject)
  }
  people(p.to)
  add(p.subject)
  add(p.chat)
  add(p.title)
  add(p.name)
  add(p.email)
  add(p.eventTitle)
  return [...new Set(out)]
}

/** What the asking thread hears once his press settled: counts and safe reasons, never another thread's words. */
export function answerNote(n: number, results: readonly DecisionResult[], left: number): string {
  const ok = results.filter((r) => r.ok)
  const scheduled = ok.filter((r) => r.item?.state === 'scheduled').length
  const discarded = ok.filter((r) => r.item?.state === 'discarded' || (r.item?.state === 'stale' && r.item.dismissedAt)).length
  const queued = ok.filter((r) => r.item?.state !== 'scheduled' && r.item?.state !== 'discarded' && r.item?.state !== 'stale' && (r.item?.kind === 'mail.send' || r.item?.kind === 'calendar.op')).length
  const sent = ok.length - queued - scheduled - discarded
  const unknown = results.filter((r) => !r.ok && r.item?.outcomeUnknown)
  const failed = results.filter((r) => !r.ok && !r.item?.outcomeUnknown)
  // Fixed words only: a provider's own error can quote a file or a person, and the thread's transcript is read by more than his press.
  const why = (f: DecisionResult): string => (/changed since/i.test(f.error ?? '') ? 'changed since he saw it' : /out of date/i.test(f.error ?? '') ? 'out of date' : /own page/i.test(f.error ?? '') ? 'goes from its own page' : 'not sent')
  const reasons = [...new Set(failed.map(why))]
  const parts = [
    ...(sent ? [`sent ${sent}`] : []),
    ...(queued ? [`queued ${queued} in LifeOS (they go after his undo time)`] : []),
    ...(scheduled ? [`scheduled ${scheduled}`] : []),
    ...(discarded ? [`discarded ${discarded}`] : []),
    ...(unknown.length ? [`${unknown.length} may have gone (its send did not say how it ended; it is not to be sent again until he has checked)`] : []),
    ...(failed.length ? [`${failed.length} not sent (${reasons.join('; ')})`] : []),
    ...(left ? [`${left} left out`] : [])
  ]
  return `The owner approved request ${n}: ${parts.join(', ') || 'nothing went'}. Do not send any of them another way.`
}

// ── the tools ───────────────────────────────────────────────────────────

const ListInput = z.object({ scope: z.enum(['thread', 'workspace']).optional().describe('thread (default): this thread and its subagents; workspace: also the same job\'s other threads') }).strict()
const AskInputSchema = z
  .object({
    items: z
      .array(
        z.object({
          ref: z.string().min(1).max(200).describe('the ref outbox_list gave'),
          do: z.enum(['send', 'discard', 'later']),
          at: z.number().int().optional().describe('for later: the exact time he named, ms since the epoch')
        }).strict()
      )
      .min(1)
      .max(50),
    quote: z.string().min(1).max(2000).describe("his own words in this thread that tell you to do this, quoted exactly")
  })
  .strict()

export function requestTools(): WorkTool[] {
  const need = (ctx: ToolCtx): OutboxRequests => {
    const r = requestsOf(ctx)
    if (!r) throw new Error('the Outbox is not running on this host')
    return r
  }
  return [
    {
      name: 'outbox_list',
      description: "List the held items waiting in the owner's Outbox that this thread may ask him about, each with the ref outbox_request takes. Read only.",
      input: ListInput,
      readOnly: true,
      run: async (args, ctx) => need(ctx).list(ctx.sessionId, (args as z.infer<typeof ListInput>).scope ?? 'thread')
    },
    {
      name: 'outbox_request',
      description:
        "Ask the owner to press for held items, only when he told you in this thread, in words, to send, discard or schedule them. List exactly the items he named (or all of this thread's, when he said all), and quote his words. It only asks: a card shows him the items and nothing goes until his press. Never ask unless he asked.",
      input: AskInputSchema,
      readOnly: true,
      run: (args, ctx) => need(ctx).ask(ctx.sessionId, AskInputSchema.parse(args))
    }
  ]
}
