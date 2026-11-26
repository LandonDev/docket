import type { EventRow } from '@shared/events'
import type { GatewaySendTiming } from './gatewayCore'

/**
 * One span per `session.send`, from the RPC's arrival to the first content
 * the harness produced: a stalls.log line that says WHERE a slow send spent
 * its time. The phases, as ms from `accepted`:
 *
 *   accepted       the RPC arrived (sessions.ts send())
 *   prepared       attachments, thread references and digests resolved
 *   handle         the driver handle: `live` (one was up), else the CLI's
 *                  own word, `warm` (adopted) or `cold` (spawned)
 *   delivered      handle.send returned (the text is in the harness)
 *   init           the harness's own init (claude's system/init, codex's
 *                  turn/started)
 *   first-message  any message back from the harness
 *   model          the model took the request (claude's top-lane
 *                  message_start), noted `hit` or `miss 88k` from its cache
 *                  usage: init → model is the CLI plus the provider's
 *                  prefill, model → first-content the model's own time
 *   first-content  an assistant text, thinking delta or a tool call
 *
 * The line waits for the first content row sent on a socket and, for a
 * routed send, the gateway's first-byte stamp. The existing deadline or
 * the next send writes any marks collected so far. A queued send opens a
 * new span when it leaves the queue, carrying its wait separately.
 */
export type SendPhase = 'accepted' | 'prepared' | 'handle' | 'delivered' | 'init' | 'first-message' | 'model' | 'first-content'

export const SEND_PHASES: readonly SendPhase[] = ['accepted', 'prepared', 'handle', 'delivered', 'init', 'first-message', 'model', 'first-content']

export const SEND_SPAN_DEADLINE_MS = 15_000

export interface McpTiming {
  ms: number
  source: 'codex-gate' | 'codex-timeout' | 'claude-init' | 'muse-session'
  servers?: ReadonlyMap<string, number>
}

interface SendTimings {
  queue?: number
  handleWait?: number
  mcp?: McpTiming
  'gateway-dispatch'?: number
  'first-byte'?: number
  'first-row'?: number
}

interface Span {
  startedAt: number
  at: Partial<Record<SendPhase, number>>
  note: Partial<Record<SendPhase, string>>
  timer: unknown
  timings: SendTimings
  outgoingAt?: number
  gatewayExpected?: boolean
  gatewayId?: number
  firstRowSeq?: number
}

export interface SendSpanOptions {
  /** Where the line goes (stalls.ts recordSendSpan). */
  write: (line: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  deadlineMs?: number
}

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return t
}

export class SendSpans {
  private readonly spans = new Map<string, Span>()
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly deadlineMs: number

  constructor(private readonly options: SendSpanOptions) {
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? defaultSetTimer
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))
    this.deadlineMs = options.deadlineMs ?? SEND_SPAN_DEADLINE_MS
  }

  /** The RPC arrived: a span opens; one still open on the session is flushed first. */
  begin(sessionId: string, queuedAt?: number): void {
    this.flush(sessionId)
    const startedAt = this.now()
    const queue = queuedAt === undefined ? 0 : Math.max(0, startedAt - queuedAt)
    const span: Span = { startedAt, at: { accepted: 0 }, note: {}, timer: null, timings: { queue } }
    span.timer = this.setTimer(() => this.flush(sessionId), this.deadlineMs)
    this.spans.set(sessionId, span)
  }

  /** A phase landed. The first mark of a phase sets its time; a note (the
   *  handle's `warm`/`cold`/`live`) is taken whenever given. Nothing without a span. */
  mark(sessionId: string, phase: SendPhase, note?: string): void {
    const span = this.spans.get(sessionId)
    if (!span) return
    if (span.at[phase] === undefined) span.at[phase] = this.now() - span.startedAt
    if (note) span.note[phase] = note
    this.maybeFlush(sessionId, span)
  }

  handoff(sessionId: string, gatewayExpected: boolean): void {
    const span = this.spans.get(sessionId)
    if (!span) return
    span.outgoingAt = this.now()
    span.gatewayExpected = gatewayExpected
  }

  handleWait(sessionId: string, ms: number): void {
    const span = this.spans.get(sessionId)
    if (span) span.timings.handleWait = ms
  }

  mcp(sessionId: string, timing: McpTiming): void {
    const span = this.spans.get(sessionId)
    if (span && !span.timings.mcp) span.timings.mcp = timing
  }

  gateway(info: GatewaySendTiming): void {
    const span = this.spans.get(info.thread)
    if (span?.outgoingAt === undefined || info.at < span.outgoingAt) return
    if (info.phase === 'gateway-dispatch') span.gatewayId ??= info.id
    if (span.gatewayId !== info.id) return
    span.timings[info.phase] ??= info.at - span.startedAt
    this.maybeFlush(info.thread, span)
  }

  /** Register the row before its subscribers get it, then stamp the first socket to send it. */
  contentRow(row: EventRow): void {
    const span = this.spans.get(row.sessionId)
    if (span?.outgoingAt === undefined || span.firstRowSeq !== undefined || !isContentRow(row)) return
    span.firstRowSeq = row.seq
  }

  rowOut(row: EventRow): void {
    const span = this.spans.get(row.sessionId)
    if (span?.firstRowSeq === undefined || row.seq < span.firstRowSeq || span.timings['first-row'] !== undefined || !isContentRow(row)) return
    span.timings['first-row'] = this.now() - span.startedAt
    this.maybeFlush(row.sessionId, span)
  }

  private maybeFlush(sessionId: string, span: Span): void {
    if (span.timings['first-row'] !== undefined && span.at.delivered !== undefined &&
      (!span.gatewayExpected || span.timings['first-byte'] !== undefined)) this.flush(sessionId)
  }

  /** The send never reached a harness (queued, held back): no line. */
  drop(sessionId: string): void {
    const span = this.spans.get(sessionId)
    if (!span) return
    this.clearTimer(span.timer)
    this.spans.delete(sessionId)
  }

  /** Write the span's line once. */
  flush(sessionId: string): void {
    const span = this.spans.get(sessionId)
    if (!span) return
    this.clearTimer(span.timer)
    this.spans.delete(sessionId)
    this.options.write(formatSpan(sessionId, span.at, span.note, span.timings))
  }

  /** Open spans, for a test. */
  open(): string[] {
    return [...this.spans.keys()]
  }
}

/** `send session=<id> accepted=0 prepared=12 handle=340(warm) … first-content=2100`; a missing phase reads `-`. */
export function formatSpan(
  sessionId: string,
  at: Partial<Record<SendPhase, number>>,
  note: Partial<Record<SendPhase, string>> = {},
  timings: SendTimings = {}
): string {
  const fields = SEND_PHASES.map((phase) => {
    const ms = at[phase]
    const value = ms === undefined ? '-' : String(Math.round(ms))
    const tag = note[phase]
    return `${phase}=${value}${tag ? `(${tag})` : ''}`
  })
  const mcp = timings.mcp
  const ms = (value: number | undefined): string | number => value === undefined ? '-' : Math.round(value)
  const keys = [
    `queue=${ms(timings.queue)}`,
    `handle-wait=${ms(timings.handleWait)}`,
    `mcp=${ms(mcp?.ms)}`,
    `gateway-dispatch=${ms(timings['gateway-dispatch'])}`,
    `first-byte=${ms(timings['first-byte'])}`,
    `first-row=${ms(timings['first-row'])}`
  ]
  if (mcp) keys.push(`mcp.source=${mcp.source}`)
  if (mcp?.servers?.size) {
    const servers = [...mcp.servers].map(([name, duration]) => `${encodeURIComponent(Buffer.from(name).toString())}:${ms(duration)}`)
    keys.push(`mcp.servers=${servers.join(',')}`)
  }
  return `send session=${sessionId} ${fields.concat(keys).join(' ')}`
}

function isContentRow(row: EventRow): boolean {
  return row.event.type === 'assistant-text' || row.event.type === 'thinking' || row.event.type === 'tool-call'
}
