/**
 * Every WebSocket event of a window as CDP's Network domain reports it, with CDP's own times: what the send and link
 * rows (rows/send.ts, link.ts, links.ts) read where the probe's counts are not enough, such as when a socket opened,
 * when its hello came, which methods left before a turn's answer, and the gaps between one thread's streamed frames.
 * It reads only: nothing of the product is changed.
 */
import type { Window } from '../../journeys/lib/window'

export interface WireEvent {
  /** ms on the epoch clock, from CDP's monotonic time and the handshake's wall time */
  at: number
  socket: string
  kind: 'created' | 'handshake' | 'open' | 'sent' | 'received' | 'closed'
  url?: string
  bytes?: number
  /** a sent request's method, id and the thread it names; a received reply's id; a push's name and its thread */
  method?: string
  id?: string
  push?: string
  session?: string
}

/** What a frame says of itself, read without parsing a big one whole. Pure: rows.test.ts drives it. */
export function frameFacts(payload: string, sent: boolean): Pick<WireEvent, 'method' | 'id' | 'push' | 'session'> {
  if (!payload.startsWith('{')) return {}
  // A big frame (a transcript page, a file piece) is read by its head alone.
  const head = payload.length > 4096 ? payload.slice(0, 4096) : payload
  const field = (name: string): string | undefined => head.match(new RegExp(`"${name}":"([^"]{1,200})"`))?.[1]
  const session = field('sessionId')
  if (sent) return { ...(field('method') ? { method: field('method') } : {}), ...(field('id') ? { id: field('id') } : {}), ...(session ? { session } : {}) }
  const push = field('push')
  if (push) return { push, ...(session ? { session } : {}) }
  return field('id') ? { id: field('id') } : {}
}

export class WireLog {
  readonly events: WireEvent[] = []
  private readonly urls = new Map<string, string>()
  /**
   * epoch ms less CDP's monotonic ms: at first this process's own monotonic clock (on Linux both are
   * CLOCK_MONOTONIC), then each handshake's, the only event that carries both clocks.
   */
  private offset = Date.now() - Number(process.hrtime.bigint()) / 1e6

  constructor(page: Window) {
    page.tap((method, raw) => {
      const params = raw as { requestId: string; url?: string; timestamp?: number; wallTime?: number; response?: { payloadData?: string } }
      if (method === 'Network.webSocketCreated') {
        if (!params.url) return
        this.urls.set(params.requestId, params.url)
        this.push({ socket: params.requestId, kind: 'created', url: params.url }, undefined)
        return
      }
      // A socket opened before the log was made is logged too, its URL unknown here (`urlOf` says undefined).
      if (!method.startsWith('Network.webSocket')) return
      if (method === 'Network.webSocketWillSendHandshakeRequest') {
        if (params.timestamp !== undefined && params.wallTime !== undefined) this.offset = params.wallTime * 1000 - params.timestamp * 1000
        this.push({ socket: params.requestId, kind: 'handshake', url: this.urls.get(params.requestId) }, params.timestamp)
      } else if (method === 'Network.webSocketHandshakeResponseReceived') {
        this.push({ socket: params.requestId, kind: 'open' }, params.timestamp)
      } else if (method === 'Network.webSocketClosed') {
        this.push({ socket: params.requestId, kind: 'closed' }, params.timestamp)
      } else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
        const sent = method.endsWith('Sent')
        const payload = params.response?.payloadData ?? ''
        this.push({ socket: params.requestId, kind: sent ? 'sent' : 'received', bytes: payload.length, ...frameFacts(payload, sent) }, params.timestamp)
      }
    })
  }

  private push(event: Omit<WireEvent, 'at'>, timestamp: number | undefined): void {
    const at = timestamp !== undefined ? timestamp * 1000 + this.offset : Date.now()
    this.events.push({ ...event, at })
  }

  /** A place in the log; `since(mark)` is everything after it. */
  mark(): number {
    return this.events.length
  }

  since(mark: number): WireEvent[] {
    return this.events.slice(mark)
  }

  urlOf(socket: string): string | undefined {
    return this.urls.get(socket)
  }
}

/** The methods sent on the matching sockets, in order, up to and including the first `until` (all when it never went). */
export function methodsUntil(events: WireEvent[], until: string, onSocket: (e: WireEvent) => boolean = () => true): string[] {
  const out: string[] = []
  for (const e of events) {
    if (e.kind !== 'sent' || !e.method || !onSocket(e)) continue
    out.push(e.method)
    if (e.method === until) break
  }
  return out
}

/** Counted by method. */
export function tally(methods: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of methods) out[m] = (out[m] ?? 0) + 1
  return out
}

/** The gaps, ms, between consecutive times. */
export const gaps = (times: number[]): number[] => times.slice(1).map((t, i) => t - times[i]!)

/** The nearest-rank percentile of a list (p in 0..100); null for none. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}

/** p50, p95 and max of a list of gaps, rounded; nulls for none. */
export function spread(values: number[]): { n: number; p50: number | null; p95: number | null; max: number | null } {
  const r = (v: number | null): number | null => (v === null ? null : Math.round(v))
  return { n: values.length, p50: r(percentile(values, 50)), p95: r(percentile(values, 95)), max: r(values.length ? Math.max(...values) : null) }
}
