import { Buffer } from 'node:buffer'
import { BACKPRESSURE_BYTES, noteRequest } from './stalls'
import { PART_CHARS, UNACKED_CHARS, partEnd, partText } from '@shared/answerParts'
import type { IncomingHttpHeaders } from 'node:http'
import type { AgentEvent, EventRow, SessionMeta, ToolPreview } from '@shared/events'
import type { ServerFrame, ServerPush } from '@shared/contract'
import { isOmittedBody, type EventsPage, type OmittedBody, type SessionPage, type WireProfile } from '@shared/wire'
import {
  BODY_HEAD_CHARS,
  BODY_OMIT_BYTES,
  DEFLATE_THRESHOLD,
  HISTORY_PAGE_BYTES,
  HISTORY_PAGE_ROWS,
  PUSH_COALESCE_MS,
  PUSH_EVENTS_COALESCE_MS,
  RESUME_BYTES,
  RESUME_ROWS,
  SHELL_PAGE_BYTES,
  SHELL_PAGE_ROWS,
  STREAMING_BODY_OMIT_BYTES,
  TAIL_BYTES,
  TAIL_ROWS
} from '@shared/wireBudgets'

/**
 * The remote wire profile, server side: which profile a connection asked
 * for, the projection that keeps large bodies off the wire, the bounded
 * pages of the log and the session list, and the per-connection coalescer
 * that turns a burst of pushes into one frame per kind. Projection helpers
 * are pure so wire.perf.test.ts can run the real path over a synthetic
 * workload; SocketBudget tracks each connection's buffer and recovery.
 */

/** Which wire profile a connection gets: the one seam between this
 *  module and the auth work. A socket that authenticated as a remote
 *  principal (shared/capabilities.ts) is remote; the local renderer's
 *  socket is local unless its URL asks for `?profile=remote` (the test
 *  path, and what a client on the loopback port uses to try the shapes). */
export function profileFor(connection: {
  principal?: { kind: string } | null
  url?: string | null
  headers?: IncomingHttpHeaders
}): WireProfile {
  if (connection.principal && connection.principal.kind !== 'local') return 'remote'
  const url = connection.url ?? ''
  const q = url.indexOf('?')
  if (q < 0) return 'local'
  return new URLSearchParams(url.slice(q + 1)).get('profile') === 'remote' ? 'remote' : 'local'
}

/** permessage-deflate as a remote WebSocketServer should enable it: frames
 *  under DEFLATE_THRESHOLD go as they are, a few deflates run at once. */
export function remoteDeflateOptions(): { threshold: number; concurrencyLimit: number } {
  return { threshold: DEFLATE_THRESHOLD, concurrencyLimit: 4 }
}

/** A string this long in a frame is a file's bytes, not words: the frame goes with no deflate (perf M9). */
export const BYTES_UNDEFLATED = 256 * 1024
const BASE64_HEAD = /^[A-Za-z0-9+/]{512}/

/**
 * Whether a frame carries a file's bytes: a base64 string of `BYTES_UNDEFLATED` or more anywhere in its first levels
 * (an answer's `data`, a peer piece's, a chunk's). Such a frame goes with no permessage-deflate: the bytes are mostly
 * zips already (.docx, .xlsx, .pptx, .pdf, pictures), so deflating their base64 bought about a quarter of their size
 * for a pass through libuv's pool on both hosts, with the chat's frames waiting behind it. `text`: the frame's JSON, a
 * short frame passed over before any walk.
 */
export function carriesBytes(frame: unknown, text?: string): boolean {
  if (text !== undefined && text.length < BYTES_UNDEFLATED) return false
  const walk = (value: unknown, depth: number): boolean => {
    if (typeof value === 'string') return value.length >= BYTES_UNDEFLATED && BASE64_HEAD.test(value)
    if (depth >= 4 || value === null || typeof value !== 'object') return false
    for (const v of Array.isArray(value) ? value.slice(0, 8) : Object.values(value)) if (walk(v, depth + 1)) return true
    return false
  }
  return walk(frame, 0)
}

/** The encoded size of a frame or a row, as the socket sends it. */
export function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

// ── bodies ───────────────────────────────────────────────────────────

/** Lines as a person counts them (src/shared/textLines.ts): the empty part
 *  after a final newline is not a line. */
function countLines(text: string): number {
  let n = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  return text.endsWith('\n') ? n - 1 : n
}

function omittedString(text: string): OmittedBody {
  const nl = text.indexOf('\n')
  const first = nl < 0 ? text : text.slice(0, nl)
  return { omitted: true, bytes: Buffer.byteLength(text), lines: countLines(text), head: first.slice(0, BODY_HEAD_CHARS) }
}

/** A string at or past the line: the length check first, since UTF-8 bytes never undercount code units. */
function isLarge(text: string, limit = BODY_OMIT_BYTES): boolean {
  return text.length >= limit && Buffer.byteLength(text) >= limit
}

const WALK_DEPTH = 8

/** `value` with every large string replaced by its OmittedBody, the same
 *  object when nothing was large. Walks arrays and plain objects (a tool
 *  input is one, a normalized patch is an array of them). */
function omitStrings(value: unknown, limit = BODY_OMIT_BYTES, depth = 0): unknown {
  if (typeof value === 'string') return isLarge(value, limit) ? omittedString(value) : value
  if (depth >= WALK_DEPTH || typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    let out: unknown[] | null = null
    for (let i = 0; i < value.length; i++) {
      const next = omitStrings(value[i], limit, depth + 1)
      if (next !== value[i]) {
        out ??= value.slice()
        out[i] = next
      }
    }
    return out ?? value
  }
  let out: Record<string, unknown> | null = null
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const next = omitStrings(record[key], limit, depth + 1)
    if (next !== record[key]) {
      out ??= { ...record }
      out[key] = next
    }
  }
  return out ?? value
}

function omitPreview(preview: ToolPreview, limit = BODY_OMIT_BYTES): ToolPreview {
  let out: ToolPreview | null = null
  if (preview.lines && preview.lines.length > 0) {
    const bytes = encodedBytes(preview.lines)
    if (bytes >= limit) {
      out = { ...preview }
      ;(out as { lines: unknown }).lines = {
        omitted: true,
        bytes,
        lines: preview.lines.length,
        head: preview.lines[0].text.slice(0, BODY_HEAD_CHARS)
      } satisfies OmittedBody
    }
  }
  if (preview.output && isLarge(preview.output, limit)) {
    out ??= { ...preview }
    ;(out as { output: unknown }).output = omittedString(preview.output)
  }
  return out ?? preview
}

function linesOf(value: unknown): number | null {
  if (typeof value === 'string') return value.length === 0 ? 0 : countLines(value)
  if (isOmittedBody(value)) return value.lines
  return null
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** The counts of an edit whose text left the wire, for a call that carries
 *  no preview of its own: the renderer counts lines from the strings, and
 *  those are what went. Undefined when nothing of the edit was omitted. */
function editSummary(name: string, input: unknown): ToolPreview | undefined {
  const rec = asRecord(input)
  if (!rec) return undefined
  let additions = 0
  let deletions = 0
  switch (name) {
    case 'Edit':
      if (!isOmittedBody(rec.old_string) && !isOmittedBody(rec.new_string)) return undefined
      additions = linesOf(rec.new_string) ?? 0
      deletions = linesOf(rec.old_string) ?? 0
      break
    case 'MultiEdit': {
      let any = false
      for (const edit of Array.isArray(rec.edits) ? rec.edits : []) {
        const r = asRecord(edit)
        if (!r) continue
        if (isOmittedBody(r.old_string) || isOmittedBody(r.new_string)) any = true
        additions += linesOf(r.new_string) ?? 0
        deletions += linesOf(r.old_string) ?? 0
      }
      if (!any) return undefined
      break
    }
    case 'Write':
      if (!isOmittedBody(rec.content)) return undefined
      additions = linesOf(rec.content) ?? 0
      break
    case 'NotebookEdit':
      if (!isOmittedBody(rec.new_source)) return undefined
      additions = linesOf(rec.new_source) ?? 0
      break
    default:
      return undefined
  }
  const path = typeof rec.file_path === 'string' ? rec.file_path : typeof rec.path === 'string' ? rec.path : undefined
  return {
    kind: 'write',
    ...(path ? { path, fileName: path.slice(path.lastIndexOf('/') + 1) } : {}),
    additions,
    deletions
  }
}

/** The event with its large bodies replaced by OmittedBody values; the
 *  same object when it carries none. Conversation text (user, assistant,
 *  thinking, plan) is never a body: it stays whole whatever its size. */
export function projectEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case 'tool-result': {
      if (!isLarge(event.output)) return event
      return { ...event, output: omittedString(event.output) as unknown as string }
    }
    case 'tool-call': {
      // A partial is the card growing as the model writes: it keeps a far
      // higher line so the card grows on remote too (STREAMING_BODY_OMIT_BYTES).
      const limit = event.partial ? STREAMING_BODY_OMIT_BYTES : BODY_OMIT_BYTES
      const input = omitStrings(event.input, limit)
      const preview = event.preview ? omitPreview(event.preview, limit) : editSummary(event.name, input)
      if (input === event.input && preview === event.preview) return event
      return { ...event, input, ...(preview ? { preview } : {}) }
    }
    case 'approval-request': {
      const input = omitStrings(event.input)
      return input === event.input ? event : { ...event, input }
    }
    default:
      return event
  }
}

/** Rows already projected, so every remote socket shares one projection
 *  (and so one serialization, frameJson) of the same row. */
const projectedRows = new WeakMap<EventRow, EventRow>()

/** The row as a remote connection sees it: the same object when nothing is large. */
export function projectRow(row: EventRow): EventRow {
  const known = projectedRows.get(row)
  if (known) return known
  const event = projectEvent(row.event)
  const out = event === row.event ? row : { ...row, event }
  projectedRows.set(row, out)
  return out
}

type LiveEdit = Extract<ServerPush, { push: 'live-edit' }>

/** A live-edit push for a remote connection: a unified diff past the
 *  streaming line (STREAMING_BODY_OMIT_BYTES) degrades to `diff: null` (the shape a binary or burst edit already
 *  takes), the counts and bytes stay. */
export function projectLiveEdit(push: LiveEdit): LiveEdit {
  if (!push.edit.diff || !isLarge(push.edit.diff, STREAMING_BODY_OMIT_BYTES)) return push
  return { ...push, edit: { ...push.edit, diff: null } }
}

// ── bounded pages of the log ─────────────────────────────────────────

/** `rows` cut to the ones that fit `maxBytes` encoded, kept from the
 *  newest end (a tail or history page) or the oldest (a forward walk).
 *  The first kept row always fits by definition: one row is the floor. */
export function boundRows(
  rows: EventRow[],
  maxBytes: number,
  keep: 'newest' | 'oldest'
): { rows: EventRow[]; bytes: number; cut: boolean } {
  let bytes = 0
  let count = 0
  const step = keep === 'newest' ? -1 : 1
  for (let i = keep === 'newest' ? rows.length - 1 : 0; i >= 0 && i < rows.length; i += step) {
    const size = encodedBytes(rows[i]) + 1
    if (count > 0 && bytes + size > maxBytes) break
    bytes += size
    count++
  }
  const kept = keep === 'newest' ? rows.slice(rows.length - count) : rows.slice(0, count)
  return { rows: kept, bytes, cut: count < rows.length }
}

/** What the page builder reads: the registry's synchronous log read. */
export interface EventSource {
  events(sessionId: string, opts: { afterSeq?: number; beforeSeq?: number; tail?: number; limit?: number }): EventRow[]
}

export interface EventsParams {
  sessionId: string
  afterSeq?: number
  /** the time of the row the reader holds at `afterSeq`: a resume checks it is still that row */
  afterTs?: number
  beforeSeq?: number
  tail?: number
  limit?: number
}

/** The remote wire's byte budget applies after body projection. */
export type EventWindow = Omit<EventsParams, 'sessionId'>
export type EventRead = EventWindow & { wireBytes?: number }
export type RemoteEventRead = { remotePage: EventWindow }

export interface EventsHost {
  knows(sessionId: string): boolean
  eventsAsync(sessionId: string, opts: RemoteEventRead): Promise<EventsPage>
  eventsAsync(sessionId: string, opts: EventWindow): Promise<EventRow[]>
}

/** `session.events` for either profile. An id this host shows no row for
 *  (never here, deleted, a tombstone of a move, a landing still hidden) is
 *  refused, never answered as an empty log: a client that read "no rows"
 *  drew a thread that exists elsewhere as a new chat. `subscribe` runs
 *  after the check and before the read, so a row appended after it is
 *  pushed and one before it is in the page. */
export async function sessionEvents(
  host: EventsHost,
  params: EventsParams & { subscribe?: boolean },
  profile: WireProfile,
  subscribe: () => void
): Promise<EventRow[] | EventsPage> {
  if (!host.knows(params.sessionId)) throw new Error(`unknown session: ${params.sessionId}`)
  if (params.subscribe) subscribe()
  // A scan this ask makes on the loop names whose it was (`timed events tail scan 88ms profile=remote`).
  noteRequest('profile', profile)
  if (profile === 'local') return host.eventsAsync(params.sessionId, params)
  const page = await host.eventsAsync(params.sessionId, { remotePage: params })
  return params.subscribe ? { ...page, subscribed: true } : page
}

export async function eventsPageAsync(readRows: (opts: EventRead) => Promise<EventRow[]>, params: EventWindow): Promise<EventsPage> {
  const read = eventsPageReads(params)
  let step = read.next()
  while (!step.done) step = read.next(await readRows(step.value))
  return step.value
}

export function eventsPage(source: EventSource, params: EventsParams): EventsPage {
  const read = eventsPageReads(params)
  let step = read.next()
  while (!step.done) {
    const { wireBytes: _wireBytes, ...opts } = step.value
    const rows = source.events(params.sessionId, opts)
    step = read.next(rows.map(projectRow))
  }
  return step.value
}

/** One page recipe for both callers. The reader can stop after the first
 * projected row over the byte budget, which also tells us a page was cut. */
function* eventsPageReads(params: EventWindow): Generator<EventRead, EventsPage, EventRow[]> {
  const afterSeq = params.afterSeq ?? 0
  if (params.tail && params.tail > 0) {
    const older = params.beforeSeq !== undefined
    const wireBytes = older ? HISTORY_PAGE_BYTES : TAIL_BYTES
    const raw = yield {
      afterSeq,
      beforeSeq: params.beforeSeq,
      tail: Math.min(params.tail, older ? HISTORY_PAGE_ROWS : TAIL_ROWS),
      wireBytes
    }
    const { rows } = boundRows(raw, wireBytes, 'newest')
    return { rows, moreBefore: rows.length > 0 && rows[0].seq > afterSeq + 1, moreAfter: false, reset: false }
  }
  if (afterSeq > 0 && params.beforeSeq === undefined && !params.limit) {
    // The row the reader says it holds last. A row is pushed when it is appended and written a tick later (db.ts
    // `appendEvent`): a host that died in between lost rows a window saw, and gave their seqs to the rows that came
    // next. A cursor past the log, or on a row of another time, is such a window: it starts over from the tail
    // rather than keep rows the log never held and miss the ones that took their places.
    const held = (yield { afterSeq: afterSeq - 1, limit: 1 })[0]
    const lost = held?.seq !== afterSeq || (params.afterTs !== undefined && held.ts !== params.afterTs)
    const raw = lost ? [] : yield { afterSeq, limit: RESUME_ROWS + 1, wireBytes: RESUME_BYTES }
    if (!lost && raw.length <= RESUME_ROWS) {
      const { rows, cut } = boundRows(raw, RESUME_BYTES, 'oldest')
      if (!cut) return { rows, moreBefore: false, moreAfter: false, reset: false }
    }
    const tail = yield { tail: TAIL_ROWS, wireBytes: TAIL_BYTES }
    const { rows } = boundRows(tail, TAIL_BYTES, 'newest')
    return { rows, moreBefore: rows.length > 0 && rows[0].seq > 1, moreAfter: false, reset: true }
  }
  const limit = Math.min(params.limit ?? HISTORY_PAGE_ROWS, HISTORY_PAGE_ROWS)
  const raw = yield { afterSeq, beforeSeq: params.beforeSeq, limit: limit + 1, wireBytes: HISTORY_PAGE_BYTES }
  const { rows, cut } = boundRows(raw.slice(0, limit), HISTORY_PAGE_BYTES, 'oldest')
  return { rows, moreBefore: false, moreAfter: cut || raw.length > limit, reset: false }
}

// ── the session list ─────────────────────────────────────────────────

const WORKING = new Set<SessionMeta['status']>(['starting', 'running', 'waiting'])

/** Where a meta sorts in a remote shell: working roots, then working
 *  subagents (their parents' boards show them live), then settled roots,
 *  then settled subagents; newest first inside a bucket. A settled
 *  subagent is the bulk of a big workspace (6,198 under 13 idle roots on
 *  2026-10-17) and nothing paints it until its parent's board opens. */
function bucketOf(meta: SessionMeta): number {
  const working = WORKING.has(meta.status)
  if (!meta.parentId) return working ? 0 : 2
  return working ? 1 : 3
}

type ListKey = { bucket: number; updatedAt: number; id: string }

function compareKeys(a: ListKey, b: ListKey): number {
  return a.bucket - b.bucket || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function parseCursor(cursor: string): ListKey | null {
  const m = /^(\d+):(\d+):(.+)$/.exec(cursor)
  return m ? { bucket: Number(m[1]), updatedAt: Number(m[2]), id: m[3] } : null
}

/** One page of `sessions` for a remote connection: working rows first,
 *  cut at SHELL_PAGE_BYTES or SHELL_PAGE_ROWS, with a cursor into the
 *  stable ordering for the next page. A meta that moves between pages
 *  shows up on both or neither; the client merges by id and the pushes
 *  keep it current. */
export function sessionPage(
  sessions: SessionMeta[],
  cursor: string | null | undefined,
  limits: { maxBytes?: number; maxRows?: number } = {}
): SessionPage {
  const maxBytes = limits.maxBytes ?? SHELL_PAGE_BYTES
  const maxRows = limits.maxRows ?? SHELL_PAGE_ROWS
  const ordered = sessions
    .map((meta) => ({ meta, key: { bucket: bucketOf(meta), updatedAt: meta.updatedAt, id: meta.id } }))
    .sort((a, b) => compareKeys(a.key, b.key))
  let start = 0
  if (cursor) {
    const after = parseCursor(cursor)
    if (!after) return { sessions: [], cursor: null }
    start = ordered.findIndex((entry) => compareKeys(entry.key, after) > 0)
    if (start < 0) return { sessions: [], cursor: null }
  }
  const page: SessionMeta[] = []
  let bytes = 0
  let last: ListKey | null = null
  let i = start
  for (; i < ordered.length; i++) {
    const size = encodedBytes(ordered[i].meta) + 1
    if (page.length > 0 && (page.length >= maxRows || bytes + size > maxBytes)) break
    page.push(ordered[i].meta)
    bytes += size
    last = ordered[i].key
  }
  const next = i < ordered.length && last ? `${last.bucket}:${last.updatedAt}:${last.id}` : null
  return { sessions: page, cursor: next }
}

// ── one serialization per piece ──────────────────────────────────────

/** The JSON of a meta or a row, made once: the registry hands the same
 *  decorated meta to every socket's listener and the same row to every
 *  subscriber, so the second socket reuses the first one's string. Metas and
 *  rows are never changed once pushed (a change is a new object). */
const pieceJson = new WeakMap<object, string>()
function jsonOf(piece: object): string {
  let json = pieceJson.get(piece)
  if (json === undefined) {
    json = JSON.stringify(piece)
    pieceJson.set(piece, json)
  }
  return json
}

/** A row whose event the store just stringified for the log
 *  (Store.appendEvent): the wire reuses that string instead of a second
 *  stringify of the same event. The bytes are JSON.stringify(row)'s. */
export function seedRowJson(row: EventRow, eventJson: string): void {
  pieceJson.set(row, `{"sessionId":${JSON.stringify(row.sessionId)},"seq":${row.seq},"ts":${row.ts},"event":${eventJson}}`)
}

/** A frame as the socket sends it. The pushes that carry metas and rows are
 *  assembled from each piece's shared JSON (the same bytes JSON.stringify
 *  would give); everything else is stringified as it is. */
export function frameJson(frame: ServerFrame): string {
  if (!('push' in frame)) return JSON.stringify(frame)
  switch (frame.push) {
    case 'session':
      return `{"push":"session","session":${jsonOf(frame.session)}}`
    case 'sessions':
      return `{"push":"sessions","sessions":[${frame.sessions.map(jsonOf).join(',')}]}`
    case 'event':
      return `{"push":"event","row":${jsonOf(frame.row)}}`
    case 'events':
      return `{"push":"events","sessionId":${JSON.stringify(frame.sessionId)},"rows":[${frame.rows.map(jsonOf).join(',')}]}`
    default:
      return JSON.stringify(frame)
  }
}

// ── push coalescing ──────────────────────────────────────────────────

/** The loop's mean lag (stalls.ts) at which unfocused rows wait longer. */
export const LAGGING_MS = 50
/** The events window for unfocused rows while the loop lags: one frame a tenth
 *  of a second to the desktop, four a second over a remote link. */
export const LAGGING_EVENTS_MS = { local: 100, remote: 250 } as const

/** The events window for rows of threads a socket is not looking at:
 *  PUSH_EVENTS_COALESCE_MS while the loop keeps up, LAGGING_EVENTS_MS while it
 *  lags, so a busy host spends its loop on the thread on screen. */
export function eventsWindowMs(profile: WireProfile, lagMs: number): number {
  return lagMs >= LAGGING_MS ? LAGGING_EVENTS_MS[profile] : PUSH_EVENTS_COALESCE_MS
}

export interface CoalescerOptions {
  /** Project large bodies off the wire (projectRow, projectLiveEdit): the
   *  remote profile. A local socket sends rows as they are. Default true. */
  project?: boolean
  /** The seam for a focused thread: a session this answers true for sends
   *  its stored rows at once, after any of its rows still waiting, instead
   *  of on the events window. Default: none. */
  immediate?: (sessionId: string) => boolean
  /** The events window, asked each time one opens (eventsWindowMs); default
   *  the constructor's fixed `eventsDelayMs`. */
  eventsDelay?: () => number
}

type BuildPush = Extract<ServerPush, { push: 'build' }>

/** The coalescer's lanes: stored transcript rows; metas and build lines;
 *  and previews (partial tool calls and live edits), the growing
 *  snapshots that each supersede the last. */
type Lane = 'events' | 'rest' | 'previews'

/** True for a partial tool call: a broadcast-only row (seq -1, never in
 *  the log) carrying the whole input so far, which the next row of the
 *  same call replaces in the fold. */
function isPartialCall(row: EventRow): row is EventRow & { event: Extract<AgentEvent, { type: 'tool-call' }> } {
  return row.event.type === 'tool-call' && row.event.partial === true
}

/** Per connection (remote and local alike; index.ts), three lanes:
 *  - events: stored rows (text deltas, tool calls, results, status), a
 *    PUSH_EVENTS_COALESCE_MS window with a leading edge: the first row of
 *    a quiet lane goes out at once, the rest as one frame per session when
 *    the window closes, and a window that closes on waiting rows opens the
 *    next, so a stream leaves as one frame per window.
 *  - rest: metas (the newest per session) and build lines (joined per
 *    run), a PUSH_COALESCE_MS window with the same leading edge.
 *  - previews: partial tool calls (the newest per call) and live edits,
 *    a PUSH_COALESCE_MS window with no leading edge: the first preview
 *    opens the window and everything in it leaves when it closes. Each
 *    preview can carry up to STREAMING_BODY_OMIT_BYTES and is stale the
 *    moment the next one lands, so they leave at most ten times a second
 *    and never compete with the text for the link.
 *  A later row of a call drops that call's waiting partial, whichever
 *  lane it rides, so a stale preview never lands after the final call.
 *  Any other push flushes what waits first and goes out at once, so the
 *  order a client sees is the order the server produced. */
export class PushCoalescer {
  private events = new Map<string, EventRow[]>()
  /** `sessionId\0callId` → the newest waiting partial of that call */
  private partials = new Map<string, EventRow>()
  private sessions = new Map<string, SessionMeta>()
  private liveEdits: Omit<LiveEdit, 'push'>[] = []
  private builds: Omit<BuildPush, 'push'>[] = []
  private timers: Record<Lane, ReturnType<typeof setTimeout> | null> = { events: null, rest: null, previews: null }
  private disposed = false

  private readonly project: boolean
  private readonly immediate: (sessionId: string) => boolean
  private readonly eventsDelay: () => number

  constructor(
    private readonly emit: (frame: ServerPush) => void,
    private readonly delayMs = PUSH_COALESCE_MS,
    private readonly eventsDelayMs = PUSH_EVENTS_COALESCE_MS,
    options: CoalescerOptions = {}
  ) {
    this.project = options.project ?? true
    this.immediate = options.immediate ?? (() => false)
    this.eventsDelay = options.eventsDelay ?? (() => this.eventsDelayMs)
  }

  push(frame: ServerPush): void {
    if (this.disposed) return
    switch (frame.push) {
      case 'event': {
        const row = this.project ? projectRow(frame.row) : frame.row
        if (row.event.type === 'tool-call') this.partials.delete(`${row.sessionId}\0${row.event.callId}`)
        // A result settles the call: a live preview still waiting (a mac_run's output) must not land after it.
        if (row.event.type === 'tool-result') this.partials.delete(`${row.sessionId}\0${row.event.callId}`)
        if (isPartialCall(row)) {
          this.partials.set(`${row.sessionId}\0${row.event.callId}`, row)
          this.arm('previews')
          return
        }
        const rows = this.events.get(row.sessionId)
        if (rows) rows.push(row)
        else this.events.set(row.sessionId, [row])
        if (this.immediate(row.sessionId)) {
          this.flushSession(row.sessionId)
          return
        }
        this.arm('events')
        return
      }
      case 'live-edit': {
        const { push: _push, ...rest } = this.project ? projectLiveEdit(frame) : frame
        this.liveEdits.push(rest)
        this.arm('previews')
        return
      }
      case 'session':
        this.sessions.set(frame.session.id, frame.session)
        break
      case 'build': {
        const { push: _push, ...rest } = frame
        const prev = this.builds[this.builds.length - 1]
        if (prev && prev.projectId === rest.projectId && prev.run.id === rest.run.id) {
          this.builds[this.builds.length - 1] = {
            ...rest,
            ...(prev.lines || rest.lines ? { lines: [...(prev.lines ?? []), ...(rest.lines ?? [])] } : {})
          }
        } else this.builds.push(rest)
        break
      }
      default:
        this.flush()
        this.emit(frame)
        return
    }
    this.arm('rest')
  }

  /** Everything waiting goes out now, metas first (a status row's meta
   *  lands before the row). Open windows stay open: a push inside one
   *  still waits for its end, so the frame rate holds. */
  flush(): void {
    this.flushSessions()
    this.flushEvents()
    this.flushPartials()
    this.flushLiveEdits()
    this.flushBuilds()
  }

  /** The socket closed: nothing waiting can be sent. */
  dispose(): void {
    this.disposed = true
    for (const lane of ['events', 'rest', 'previews'] as const) {
      const timer = this.timers[lane]
      if (timer) clearTimeout(timer)
      this.timers[lane] = null
    }
    this.events.clear()
    this.partials.clear()
    this.sessions.clear()
    this.liveEdits = []
    this.builds = []
  }

  /** Events and rest have a leading edge: a quiet lane sends now and opens
   *  its window, a window that closes on waiting pushes sends them and
   *  opens the next, one that closes on nothing leaves the lane quiet.
   *  Previews only open the window and send when it closes. */
  private arm(lane: Lane): void {
    if (this.timers[lane]) return
    if (lane !== 'previews') this.flushLane(lane)
    this.openWindow(lane)
  }

  private openWindow(lane: Lane): void {
    this.timers[lane] = setTimeout(
      () => {
        this.timers[lane] = null
        if (this.disposed || !this.waiting(lane)) return
        this.flushLane(lane)
        if (lane !== 'previews') this.openWindow(lane)
      },
      lane === 'events' ? this.eventsDelay() : this.delayMs
    )
  }

  private waiting(lane: Lane): boolean {
    switch (lane) {
      case 'events':
        return this.events.size > 0
      case 'rest':
        return this.sessions.size > 0 || this.builds.length > 0
      case 'previews':
        return this.partials.size > 0 || this.liveEdits.length > 0
    }
  }

  private flushLane(lane: Lane): void {
    switch (lane) {
      case 'rest':
        this.flushSessions()
        this.flushBuilds()
        return
      case 'previews':
        this.flushPartials()
        this.flushLiveEdits()
        return
      case 'events': {
        // Metas keep their own window; only a status row's waiting meta
        // rides ahead of the rows, so the row never lands before its meta.
        const ahead: SessionMeta[] = []
        for (const [sessionId, rows] of this.events) {
          const meta = this.sessions.get(sessionId)
          if (meta && rows.some((r) => r.event.type === 'status')) {
            this.sessions.delete(sessionId)
            ahead.push(meta)
          }
        }
        if (ahead.length > 0) this.emit({ push: 'sessions', sessions: ahead })
        this.flushEvents()
      }
    }
  }

  /** One session's waiting rows now (the immediate seam), its waiting meta
   *  ahead of them when they carry a status, as the events lane does. */
  private flushSession(sessionId: string): void {
    const rows = this.events.get(sessionId)
    if (!rows) return
    this.events.delete(sessionId)
    const meta = this.sessions.get(sessionId)
    if (meta && rows.some((r) => r.event.type === 'status')) {
      this.sessions.delete(sessionId)
      this.emit({ push: 'sessions', sessions: [meta] })
    }
    this.emit({ push: 'events', sessionId, rows })
  }

  private flushSessions(): void {
    if (this.sessions.size === 0) return
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this.emit({ push: 'sessions', sessions })
  }

  private flushEvents(): void {
    if (this.events.size === 0) return
    const events = this.events
    this.events = new Map()
    for (const [sessionId, rows] of events) this.emit({ push: 'events', sessionId, rows })
  }

  /** The waiting partials as one events frame per session. */
  private flushPartials(): void {
    if (this.partials.size === 0) return
    const bySession = new Map<string, EventRow[]>()
    for (const row of this.partials.values()) {
      const rows = bySession.get(row.sessionId)
      if (rows) rows.push(row)
      else bySession.set(row.sessionId, [row])
    }
    this.partials.clear()
    for (const [sessionId, rows] of bySession) this.emit({ push: 'events', sessionId, rows })
  }

  private flushLiveEdits(): void {
    if (this.liveEdits.length === 0) return
    const items = this.liveEdits
    this.liveEdits = []
    this.emit({ push: 'live-edits', items })
  }

  private flushBuilds(): void {
    if (this.builds.length === 0) return
    const items = this.builds
    this.builds = []
    this.emit({ push: 'builds', items })
  }
}

/** The methods whose answers are content alone (src/shared/answerParts.ts): a file's bytes, a page of a transcript, a
 *  row's body. Their rows fold by seq and their bytes stand alone, so a push may overtake them; a list may not (a
 *  meta it carries is the newest the store holds). */
export const PART_METHODS: ReadonlySet<string> = new Set([
  'fs.read',
  'session.events',
  'session.rowBody',
  'work.files.read',
  'work.office.filesRead',
  'work.canvas.read',
  'mac.readFile',
  'work.sheets.previewRead',
  'work.slides.previewRead'
])

/** Of PART_METHODS, those whose answer is one thread's (`params.sessionId`): pushes for it wait behind it. */
export const THREAD_METHODS: ReadonlySet<string> = new Set(['session.events', 'session.rowBody'])

/**
 * One window socket's big content answers, in parts behind every other frame (src/shared/answerParts.ts): a part goes
 * while the window holds all but UNACKED_CHARS of what was sent, so the shown thread's rows never sit behind more.
 * Off until the window says `#parts`.
 */
/** What one socket's parts may hold, answers waiting whole or in part: SOCKET_MAX_BYTES's order, as chars. */
export const PARTS_HELD_MAX_CHARS = 64 * 1024 * 1024
/** Parts out and no ack that moves for this long: the window is not reading, and the socket closes. */
export const PARTS_ACK_STALL_MS = 60_000

export interface AnswerPartsOptions {
  /** The socket's own close (SocketBudget's): 1013, so the window backs off. */
  close?: (code: number, reason: string) => void
  /** PARTS_HELD_MAX_CHARS unless a test names less. */
  maxHeldChars?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

type HeldPush = { text: string; compress: boolean; threads: string[] }

export class AnswerParts {
  private on = false
  /** Chars of answers waiting here, whole or in part, against PARTS_HELD_MAX_CHARS. */
  private held = 0
  private stall: unknown = null
  /** Marked requests, with the thread their answer is of (`session.events`, `session.rowBody`), if any. */
  private readonly marked = new Map<string, string | null>()
  private queue: { id: string; text: string; at: number; compress: boolean; thread: string | null }[] = []
  /** Answers of a thread waiting here or going out in parts. */
  private readonly outstanding = new Map<string, number>()
  /** Pushes that name a thread with an answer in parts (or one already waiting here), in the order they came:
   *  each goes once every thread it names is clear, and never ahead of an earlier one for the same thread. */
  private behind: HeldPush[] = []
  private sent = 0
  private acked = 0
  private closed = false

  constructor(
    private readonly send: (text: string, compress: boolean) => void,
    private readonly options: AnswerPartsOptions = {}
  ) {}

  enable(): void {
    this.on = true
  }

  /** A request whose answer may go in parts. A second request under an id still outstanding here is a client's
   *  slip: neither is marked again, so its answer goes whole. */
  mark(id: string, method: string, thread?: string): void {
    if (!this.on || !PART_METHODS.has(method)) return
    if (this.marked.has(id)) return void this.marked.delete(id)
    if (this.queue.some((q) => q.id === id)) return
    this.marked.set(id, THREAD_METHODS.has(method) && thread ? thread : null)
  }

  /**
   * A push, held when it names a thread whose answer is in parts here: the thread's order is the socket's, so a
   * later row, a meta or a `resync` never reaches the window ahead of that page or row body. It goes right after
   * the answer's last part. False: send it now (pushes for other threads pass between parts).
   */
  holdPush(frame: ServerFrame, text: string, compress: boolean): boolean {
    if (this.closed || !('push' in frame)) return false
    let named: string[]
    switch (frame.push) {
      case 'event': named = [frame.row.sessionId]; break
      case 'events': named = [frame.sessionId]; break
      case 'session': named = [frame.session.id]; break
      case 'sessions': named = frame.sessions.map((s) => s.id); break
      // The host shed pushes: the window replays from its cursors, so it must see every page out before it.
      case 'resync': named = [...this.outstanding.keys(), ...this.behind.flatMap((b) => b.threads)]; break
      default: return false
    }
    const waiting = new Set(this.behind.flatMap((b) => b.threads))
    const threads = [...new Set(named)]
    if (!threads.some((t) => (this.outstanding.get(t) ?? 0) > 0 || waiting.has(t))) return false
    this.behind.push({ text, compress, threads })
    this.held += text.length
    return true
  }

  /** The window holds `chars` of the parts sent: a whole count within what was acked and what was sent, else ignored. */
  ack(chars: number): void {
    if (!Number.isSafeInteger(chars) || chars <= this.acked || chars > this.sent) return
    this.acked = chars
    this.clearStall()
    this.pump()
  }

  /** Takes a marked answer longer than a part and sends it in parts; false: send it as it is. */
  take(id: string, text: string, compress: boolean): boolean {
    if (!this.marked.has(id)) return false
    const thread = this.marked.get(id) ?? null
    this.marked.delete(id)
    if (this.closed || text.length <= PART_CHARS) return false
    if (this.queue.some((q) => q.id === id)) return false
    if (this.held + text.length > (this.options.maxHeldChars ?? PARTS_HELD_MAX_CHARS)) {
      this.shut('answers waiting in parts passed 64 MiB')
      return true
    }
    this.held += text.length
    this.queue.push({ id, text, at: 0, compress, thread })
    if (thread) this.outstanding.set(thread, (this.outstanding.get(thread) ?? 0) + 1)
    this.pump()
    return true
  }

  /** Characters of parts sent that the window has not said it holds. */
  get unacked(): number {
    return this.sent - this.acked
  }

  /** Answers still waiting, whole or in part. */
  get waiting(): number {
    return this.queue.length
  }

  private pump(): void {
    while (!this.closed && this.queue.length > 0) {
      const answer = this.queue[0]!
      // A running offset: a part that stops short of a surrogate pair's split leaves the pair to the next.
      const end = partEnd(answer.text, answer.at)
      // The credit is checked against this part's own length: never more than UNACKED_CHARS out.
      if (this.sent - this.acked + (end - answer.at) > UNACKED_CHARS) break
      const body = answer.text.slice(answer.at, end)
      const last = end >= answer.text.length
      this.send(partText(answer.id, answer.at, last, body), answer.compress)
      this.sent += body.length
      this.held -= body.length
      answer.at = end
      if (last) {
        this.queue.shift()
        if (answer.thread) this.finished(answer.thread)
      }
    }
    this.armStall()
  }

  /** A thread's answer went out whole: the pushes held for it go now, in order, up to one still blocked. */
  private finished(thread: string): void {
    const left = (this.outstanding.get(thread) ?? 1) - 1
    if (left > 0) this.outstanding.set(thread, left)
    else this.outstanding.delete(thread)
    const blocked = new Set<string>()
    const keep: HeldPush[] = []
    for (const push of this.behind) {
      if (push.threads.some((t) => (this.outstanding.get(t) ?? 0) > 0 || blocked.has(t))) {
        keep.push(push)
        for (const t of push.threads) blocked.add(t)
        continue
      }
      this.held -= push.text.length
      this.send(push.text, push.compress)
    }
    this.behind = keep
  }

  /** Parts out: the window has PARTS_ACK_STALL_MS to move its ack, or the socket goes. */
  private armStall(): void {
    if (this.closed || this.sent === this.acked || this.stall !== null) return
    const set = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref())
    this.stall = set(() => {
      this.stall = null
      if (this.sent > this.acked) this.shut('parts went unacknowledged for 60 s')
    }, PARTS_ACK_STALL_MS)
  }

  private clearStall(): void {
    if (this.stall === null) return
    ;(this.options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.stall)
    this.stall = null
  }

  private shut(reason: string): void {
    this.dispose()
    this.options.close?.(1013, reason)
  }

  /** Chars of answers held here, whole or in part. */
  get heldChars(): number {
    return this.held
  }

  dispose(): void {
    this.closed = true
    this.clearStall()
    this.queue = []
    this.behind = []
    this.outstanding.clear()
    this.held = 0
    this.marked.clear()
  }
}

/** An upper bound on queued bytes, including focused traffic and answers. */
export const SOCKET_MAX_BYTES = 64 * 1024 * 1024

export interface SocketBudgetOptions {
  buffered: () => number
  focused: (sessionId: string) => boolean
  resync: () => void
  close: (code: number, reason: string) => void
}

/** Background transcript and meta pushes may be replayed after a slow
 * socket drains. Answers and host/control pushes always pass. */
export class SocketBudget {
  private lagging = false
  private closed = false
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly options: SocketBudgetOptions) {}

  /** Called after sends too, so one large frame cannot escape the cap. */
  poll(): boolean {
    if (this.closed) return false
    const bytes = this.options.buffered()
    if (bytes > SOCKET_MAX_BYTES) {
      this.dispose()
      this.options.close(1013, 'socket send queue exceeded 64 MiB')
      return false
    }
    if (this.lagging && bytes < BACKPRESSURE_BYTES / 2) {
      this.lagging = false
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.options.resync()
    }
    return true
  }

  filter(frame: ServerFrame): ServerFrame | null {
    if (!this.poll()) return null
    if (!('push' in frame) || this.options.buffered() <= BACKPRESSURE_BYTES) return frame
    const focused = this.options.focused
    let next: ServerFrame | null = frame
    switch (frame.push) {
      case 'session': if (!focused(frame.session.id)) next = null; break
      case 'sessions': {
        const sessions = frame.sessions.filter((s) => focused(s.id))
        if (sessions.length !== frame.sessions.length) next = sessions.length ? { ...frame, sessions } : null
        break
      }
      case 'event': if (!focused(frame.row.sessionId)) next = null; break
      case 'events': if (!focused(frame.sessionId)) next = null; break
      // Only replayable log/list pushes are shed. Keep control and peer
      // traffic intact, including key and relay messages.
      default: break
    }
    if (next !== frame) {
      this.lagging = true
      if (!this.timer) {
        this.timer = setInterval(() => this.poll(), 100)
        this.timer.unref?.()
      }
    }
    return next
  }

  dispose(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
