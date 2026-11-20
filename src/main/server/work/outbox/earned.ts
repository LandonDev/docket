import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { GrantOffer } from '@shared/contract-work-outbox'
import type { ActKind, HeldRef } from '@shared/work'
import { canonical } from '../../addonStore'
import { AddonCallPayloadSchema, addonCallWords } from './catch'
import { CalendarOpPayloadSchema, GRANTABLE_CALENDAR_KINDS, MailSendPayloadSchema } from './lifeosHeld'
import { refOfRow, type HeldRow } from './store'

/**
 * Grants he has earned (docs/agents/work-outbox.md "Offered grants"). When
 * he has pressed Send himself, without changing a word, on several held
 * acts one narrow matcher would fit, the host offers that grant once, beside
 * the item whose press completed the run. Taking it is the same
 * `Outbox.grant` he could ask for by hand from that item; dismissing it is
 * for good.
 *
 * Everything here is counting. The matcher offered is the one each of the
 * acts would earn on its own (`earnedOf`), so it is never wider than any of
 * them: one person on one account for mail, one kind on one calendar, one
 * tool with every argument fixed. A kind with no case here earns nothing.
 */

/** Sends in a row that earn an offer. */
export const EARN_AT = 5
/** The run counts only presses this recent. */
export const EARN_DAYS = 30
const DAY = 86_400_000
/** First words kept this long: past it an act can no longer be part of a run. */
const KEEP_FIRST_DAYS = 60

export const OFFERS_TABLE = 'work_grant_offers'
export const FIRST_TABLE = 'work_held_first'

/** Who presses for himself: the owner at this host or through a paired device. A grant's send is neither. */
export const PERSON_PRESS: ReadonlySet<string> = new Set(['owner', 'owner:remote'])

export function ensureEarnedTables(db: DatabaseSync, now = Date.now()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FIRST_TABLE} (
      run_key TEXT PRIMARY KEY,
      words   TEXT NOT NULL,
      at      INTEGER NOT NULL,
      batch   INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ${OFFERS_TABLE} (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind         TEXT NOT NULL,
      key          TEXT NOT NULL,
      matcher      TEXT NOT NULL,
      label        TEXT NOT NULL,
      routine_id   TEXT,
      made_from    TEXT NOT NULL,
      run          TEXT NOT NULL DEFAULT '[]',
      count        INTEGER NOT NULL,
      state        TEXT NOT NULL,
      grant_id     TEXT,
      created_at   INTEGER NOT NULL,
      decided_at   INTEGER,
      UNIQUE (workspace_id, kind, key)
    );
  `)
  db.prepare(`DELETE FROM ${FIRST_TABLE} WHERE at < ?`).run(now - KEEP_FIRST_DAYS * DAY)
}

// ── what an act says, and what it would earn ─────────────────────────────

const lower = (s: string): string => s.trim().toLowerCase()

/**
 * The words of an act he can change before the press, as one value: what
 * the thread wrote is kept at first sight (`noteFirst`), and an act sent
 * with other words was edited. Null for a kind whose words are not read.
 */
export function wordsOf(kind: ActKind, payload: unknown): unknown {
  if (kind === 'mail.send') {
    const p = MailSendPayloadSchema.safeParse(payload)
    if (!p.success) return null
    const m = p.data.message as typeof p.data.message & Record<string, unknown>
    const people = (list: readonly { address: string }[]) => list.map((a) => lower(a.address)).sort()
    // Everything that goes: the people, the account and identity, what it answers, the words in both forms, what rides with it.
    return {
      accountId: m.accountId,
      from: m.from ? lower(m.from.address) : null,
      to: people(m.to),
      cc: people(m.cc),
      bcc: people(m.bcc),
      threadId: m.threadId ?? null,
      inReplyTo: m.inReplyTo ?? null,
      mode: m.mode ?? null,
      subject: m.subject,
      text: m.text,
      html: m.html,
      attachments: m.attachments ?? null,
      forwardParts: m.forwardParts ?? null
    }
  }
  if (kind === 'calendar.op') {
    const p = CalendarOpPayloadSchema.safeParse(payload)
    return p.success
      ? { kind: p.data.kind ?? null, account: p.data.account ?? null, calendarId: p.data.calendarId ?? null, eventId: p.data.eventId ?? null, route: p.data.route ?? null, payload: p.data.payload ?? {} }
      : null
  }
  if (kind === 'addon.call') {
    const p = AddonCallPayloadSchema.safeParse(payload)
    return p.success ? { addonId: p.data.addonId, tool: p.data.tool, arguments: p.data.arguments } : null
  }
  if (kind === 'teams.post') {
    const p = payload as { chat?: unknown; text?: unknown } | null
    return typeof p?.chat === 'string' && typeof p.text === 'string' ? { chat: p.chat, text: p.text } : null
  }
  return null
}

/** Spacing in a mail's or an event's words never counts as an edit: a composer that tidies a line break changed nothing he meant. An add-on's arguments are compared exactly: a tool may tell "a  b" from "a b". */
const squashed = (value: unknown): unknown =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : Array.isArray(value)
      ? value.map(squashed)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, squashed(v)]))
        : value
export const sameWords = (kind: ActKind, a: unknown, b: unknown): boolean =>
  a !== null && b !== null && (kind === 'addon.call' ? canonical(a) === canonical(b) : canonical(squashed(a)) === canonical(squashed(b)))

/**
 * Who or what an act's words are aimed at: the same target in its first
 * words or its last makes an act part of a run's history, so an edit that
 * moved it from one person to another breaks the run of both.
 */
export function targetOf(kind: ActKind, words: unknown): string | null {
  const w = words as Record<string, unknown> | null
  if (!w) return null
  if (kind === 'mail.send') {
    const all = [...new Set([...(w.to as string[]), ...(w.cc as string[]), ...(w.bcc as string[])])].sort()
    return `mail|${String(w.accountId)}|${all.join(',')}`
  }
  if (kind === 'calendar.op') {
    const invited = ((w.payload as { attendees?: { address: string }[] } | null)?.attendees ?? []).map((a) => lower(a.address)).sort()
    return `cal|${String(w.kind)}|${String(w.account)}|${String(w.calendarId ?? '')}|${invited.join(',')}`
  }
  if (kind === 'addon.call') return `addon|${String(w.addonId)}|${String(w.tool)}|${digest(canonical(w.arguments))}`
  return null
}

export interface Earned {
  /** acts with the same key earn the same grant */
  key: string
  /** the kind's own matcher, as narrow as one act */
  matcher: unknown
  label: string
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32)

/**
 * The narrowest grant one act would earn, or null. A run of acts with one
 * key earns its matcher, which fits each of them and nothing they did not
 * share: a mail to one person from one account (a domain is never offered;
 * it is wider than the people he pressed for), an invitation's answer of one
 * kind on one calendar, an invite of one person on one calendar, an add-on
 * call with every argument as it was. A kind with no case earns nothing:
 * a computer act, a Teams post, a form's publish.
 */
export function earnedOf(kind: ActKind, payload: unknown): Earned | null {
  if (kind === 'mail.send') {
    const p = MailSendPayloadSchema.safeParse(payload)
    if (!p.success) return null
    const m = p.data.message
    const all = [...m.to, ...m.cc, ...m.bcc]
    const people = [...new Set(all.map((a) => lower(a.address)))]
    if (people.length !== 1 || !m.accountId) return null
    const one = people[0]!
    // Named by the address, never a display name a draft may carry; from the address it went from when LifeOS says.
    const from = m.from?.address ? ` from ${lower(m.from.address)}` : ''
    return { key: `mail|${m.accountId}|${one}`, matcher: { accountId: m.accountId, recipients: [one] }, label: `Mail to ${one}${from}` }
  }
  if (kind === 'calendar.op') {
    const p = CalendarOpPayloadSchema.safeParse(payload)
    if (!p.success) return null
    const op = p.data
    const account = op.account ?? null
    const calendarId = op.calendarId ?? null
    if (!account || !op.kind || !(GRANTABLE_CALENDAR_KINDS as readonly string[]).includes(op.kind)) return null
    if (op.payload?.uninvite?.length || op.payload?.series) return null
    const invited = op.payload?.attendees ?? []
    const people = [...new Set(invited.map((a) => lower(a.address)))]
    const where = `${account}|${calendarId ?? ''}`
    if (op.kind === 'create') {
      if (people.length !== 1) return null
      const one = people[0]!
      return { key: `cal|create|${where}|${one}`, matcher: { kind: 'create', account, calendarId, attendees: [one] }, label: `Invites to ${one} on ${account}` }
    }
    if (people.length) return null
    const verb = { accept: 'Accept', decline: 'Decline', tentative: 'Answer maybe to' }[op.kind as 'accept' | 'decline' | 'tentative']
    return { key: `cal|${op.kind}|${where}`, matcher: { kind: op.kind, account, calendarId }, label: `${verb} invitations on ${account}` }
  }
  if (kind === 'addon.call') {
    const p = AddonCallPayloadSchema.safeParse(payload)
    // Only a call held with the server's and the tool's digests can be granted at all.
    if (!p.success || !p.data.specDigest || !p.data.toolDigest) return null
    const { addonId, tool, arguments: args } = p.data
    return {
      key: `addon|${addonId}|${tool}|${p.data.specDigest}|${p.data.toolDigest}|${digest(canonical(args))}`,
      // Every argument fixed, none free: the grant fits this exact call again and nothing else of the tool.
      matcher: { addonId, tool, arguments: args },
      label: addonCallWords(p.data).summary.slice(0, 200)
    }
  }
  return null
}

// ── the tables ───────────────────────────────────────────────────────────

type OfferRow = {
  id: string
  workspace_id: string
  kind: string
  key: string
  matcher: string
  label: string
  routine_id: string | null
  made_from: string
  run: string
  count: number
  state: string
  grant_id: string | null
  created_at: number
  decided_at: number | null
}

/** An offer as the host keeps it: the wire's, with the matcher a client never sends. */
export interface StoredOffer extends GrantOffer {
  key: string
  matcher: unknown
  state: 'open' | 'dismissed' | 'made'
  grantId: string | null
  /** the run keys of the sends that earned it: each must still read sent for the offer to stand */
  run: string[]
}

const decodeOffer = (r: OfferRow): StoredOffer => ({
  id: r.id,
  workspaceId: r.workspace_id,
  kind: r.kind as ActKind,
  key: r.key,
  matcher: JSON.parse(r.matcher) as unknown,
  label: r.label,
  routineId: r.routine_id,
  from: JSON.parse(r.made_from) as HeldRef,
  count: Number(r.count),
  state: r.state as StoredOffer['state'],
  grantId: r.grant_id,
  run: JSON.parse(r.run) as string[],
  createdAt: Number(r.created_at)
})

/** What a screen is sent of an offer: never its matcher, which only the host uses. */
export const wireOffer = (o: StoredOffer): GrantOffer => ({ id: o.id, workspaceId: o.workspaceId, kind: o.kind, label: o.label, routineId: o.routineId, from: o.from, count: o.count, createdAt: o.createdAt })

export class EarnedStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {}

  /** What the thread wrote, kept the first time the host sees the act; a later sight changes nothing. */
  noteFirst(runKey: string, kind: ActKind, payload: unknown): void {
    const words = wordsOf(kind, payload)
    if (words === null) return
    this.db.prepare(`INSERT OR IGNORE INTO ${FIRST_TABLE} (run_key, words, at) VALUES (?, ?, ?)`).run(runKey, JSON.stringify(words), this.now())
  }

  /** The act's words as first seen; null when the host never saw it before it was decided. */
  first(runKey: string): unknown {
    const row = this.db.prepare(`SELECT words FROM ${FIRST_TABLE} WHERE run_key = ?`).get(runKey) as { words: string } | undefined
    return row ? (JSON.parse(row.words) as unknown) : null
  }

  /** Sent as the thread wrote it: seen when it was made, and its words the same at the send. */
  unedited(row: Pick<HeldRow, 'runKey' | 'kind' | 'payload'>): boolean {
    return sameWords(row.kind, this.first(row.runKey), wordsOf(row.kind, row.payload))
  }

  /** Sent with others by one press (a group's Send N, ticked rows): one gesture is not five decisions. */
  markBatch(runKey: string): void {
    this.db.prepare(`UPDATE ${FIRST_TABLE} SET batch = 1 WHERE run_key = ?`).run(runKey)
  }

  batched(runKey: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM ${FIRST_TABLE} WHERE run_key = ? AND batch = 1`).get(runKey)
  }

  /** Whether this matcher was ever offered in the workspace: an offer is made once, whatever became of it. */
  offered(workspaceId: string, kind: ActKind, key: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM ${OFFERS_TABLE} WHERE workspace_id = ? AND kind = ? AND key = ?`).get(workspaceId, kind, key)
  }

  add(o: { workspaceId: string; kind: ActKind; key: string; matcher: unknown; label: string; routineId: string | null; from: HeldRef; run: string[] }): StoredOffer | null {
    const id = `go_${randomUUID()}`
    const done = this.db
      .prepare(
        `INSERT OR IGNORE INTO ${OFFERS_TABLE} (id, workspace_id, kind, key, matcher, label, routine_id, made_from, run, count, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .run(id, o.workspaceId, o.kind, o.key, JSON.stringify(o.matcher), o.label, o.routineId, JSON.stringify(o.from), JSON.stringify(o.run), o.run.length, this.now())
    return Number(done.changes) === 1 ? this.get(id) : null
  }

  get(id: string): StoredOffer | null {
    const row = this.db.prepare(`SELECT * FROM ${OFFERS_TABLE} WHERE id = ?`).get(id) as unknown as OfferRow | undefined
    return row ? decodeOffer(row) : null
  }

  open(q: { workspaceId?: string; kind?: ActKind } = {}): StoredOffer[] {
    const where = [`state = 'open'`]
    const args: string[] = []
    if (q.workspaceId) {
      where.push('workspace_id = ?')
      args.push(q.workspaceId)
    }
    if (q.kind) {
      where.push('kind = ?')
      args.push(q.kind)
    }
    return (this.db.prepare(`SELECT * FROM ${OFFERS_TABLE} WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...args) as unknown as OfferRow[]).map(decodeOffer)
  }

  /** Take an open offer for one decision: of two presses, one gets it. */
  claim(id: string, to: 'made' | 'dismissed'): StoredOffer | null {
    const done = this.db.prepare(`UPDATE ${OFFERS_TABLE} SET state = ?, decided_at = ? WHERE id = ? AND state = 'open'`).run(to, this.now(), id)
    return Number(done.changes) === 1 ? this.get(id) : null
  }

  /** The grant a taken offer made; or, the grant failed, the offer open again. */
  settle(id: string, grantId: string | null): void {
    if (grantId) this.db.prepare(`UPDATE ${OFFERS_TABLE} SET grant_id = ? WHERE id = ?`).run(grantId, id)
    else this.db.prepare(`UPDATE ${OFFERS_TABLE} SET state = 'open', decided_at = NULL WHERE id = ? AND state = 'made' AND grant_id IS NULL`).run(id)
  }

  dropWorkspace(workspaceId: string): void {
    this.db.prepare(`DELETE FROM ${OFFERS_TABLE} WHERE workspace_id = ?`).run(workspaceId)
  }
}

// ── the run ──────────────────────────────────────────────────────────────

export interface RunDeps {
  earned: EarnedStore
  /** this host's rows of one kind in one workspace that a person or a grant decided since a time, newest decision first */
  decidedSince(kind: ActKind, workspaceId: string, since: number): HeldRow[]
  routineOf(runId: string): string | null
  /** whether a standing grant already fits the act */
  granted(row: HeldRow): boolean
  /** an act the host read as no grant's (a command line's) */
  notGrantable(payload: unknown): boolean
  now(): number
}

/**
 * The workspace and the routine an act counts under, as the row recorded
 * them when it was held: a thread deleted or moved since changes nothing of
 * its history. A Work Chat's act (no workspace) earns nothing.
 */
function placeOf(deps: RunDeps, row: HeldRow): { scope: string; routineId: string | null } | null {
  const scope = row.workspaceId
  if (!scope || !row.sessionId) return null
  const routineId = row.routineRunId ? deps.routineOf(row.routineRunId) : null
  // A run this host cannot place takes no grant, so it earns none.
  if (row.routineRunId && !routineId) return null
  return { scope, routineId }
}

/** An act's own claim to count: his press on it alone, as written, sent, on a kind that takes grants. */
function clean(deps: RunDeps, row: HeldRow): boolean {
  return (
    row.state === 'sent' &&
    PERSON_PRESS.has(row.decidedBy ?? '') &&
    row.why !== 'unreviewed' &&
    !deps.notGrantable(row.payload) &&
    deps.earned.unedited(row) &&
    !deps.earned.batched(row.runKey)
  )
}

/**
 * Whether the press that sent `row` completed a run, and if it did, the
 * offer it made. The run is the newest `EARN_AT` decisions on the same
 * target in the same workspace (and the same routine, or none), all within
 * `EARN_DAYS`: each a send by his own press, alone, of the act as the
 * thread wrote it. Any other decision aimed at that target, as written or
 * as sent, breaks the run: an edited send, a discard, a send still going or
 * failed, one sent with others by one press. A send by a grant is no
 * decision of his and is passed over. A matcher offered once is never
 * offered again, and one a standing grant already covers is not offered.
 */
export function earn(deps: RunDeps, row: HeldRow): StoredOffer | null {
  if (!clean(deps, row)) return null
  const mine = earnedOf(row.kind, row.payload)
  const place = placeOf(deps, row)
  if (!mine || !place) return null
  const key = `${place.routineId ?? ''}|${mine.key}`
  if (deps.earned.offered(place.scope, row.kind, key) || deps.granted(row)) return null
  const target = targetOf(row.kind, wordsOf(row.kind, row.payload))
  const run: string[] = []
  for (const other of deps.decidedSince(row.kind, place.scope, deps.now() - EARN_DAYS * DAY)) {
    if (other.decidedBy?.startsWith('grant:')) continue
    const at = placeOf(deps, other)
    if (!at || at.routineId !== place.routineId) continue
    const aimed = targetOf(other.kind, wordsOf(other.kind, other.payload)) === target || targetOf(other.kind, deps.earned.first(other.runKey)) === target
    if (!aimed) continue
    if (!clean(deps, other)) break
    // The same people or call to another server, or the tool as it was listed before: no part of this run, and no break in it.
    if (earnedOf(other.kind, other.payload)?.key !== mine.key) continue
    run.push(other.runKey)
    if (run.length >= EARN_AT) break
  }
  if (run.length < EARN_AT) return null
  return deps.earned.add({ workspaceId: place.scope, kind: row.kind, key, matcher: mine.matcher, label: mine.label, routineId: place.routineId, from: refOfRow(row), run })
}
