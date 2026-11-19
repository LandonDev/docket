import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { VIDEO_PATH } from '@shared/contract-video'
import { SUBPROTOCOL } from '@shared/video/nsl1'
import type { RemoteAuth } from '../remote/auth'
import type { VideoRelay } from './relay'

/**
 * The upgrade of a stream's own socket, `/video/<stream>?ticket=…`, on the
 * local server and on the fixed-port listener. Binary frames, no deflate (the
 * payload is H.264), subprotocol `nsl1`. The ticket is the only credential:
 * single use, bound to the stream, its scope and who asked (remote/auth.ts).
 * A local server takes only a ticket its own socket asked for, the listener
 * only a key's.
 */

/** A viewer's socket is pinged this often, so a still page's silent stream is not cut by a proxy's idle timer. */
export const VIDEO_PING_MS = 30_000
const MISSED_PONGS = 2
/** A viewer sends acks (24 bytes) and input (36 bytes); nothing of its is ever larger. */
const VIEWER_MAX_PAYLOAD = 4096

/** The stream a `/video/<stream>` path names, or null for any other path. */
export function videoStreamOf(path: string): string | null {
  if (!path.startsWith(VIDEO_PATH)) return null
  const id = path.slice(VIDEO_PATH.length)
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null
}

/** The subprotocols a request offers. */
export function offeredProtocols(req: IncomingMessage): string[] {
  const raw = req.headers['sec-websocket-protocol']
  return (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',').map((p) => p.trim()).filter(Boolean)
}

/** Why an upgrade was refused, as the HTTP status it answers. */
export type VideoUpgradeRefusal = 400 | 401 | 403 | 404

const REFUSAL_TEXT: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests' }

/** Answers a refused upgrade and drops the connection. */
export function refuseVideoUpgrade(socket: Duplex, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${REFUSAL_TEXT[status] ?? 'Refused'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

export class VideoSockets {
  private readonly wss: WebSocketServer
  private readonly timers = new Map<WebSocket, NodeJS.Timeout>()

  constructor(
    private readonly relay: VideoRelay,
    private readonly auth: Pick<RemoteAuth, 'consumeStreamTicket'>,
    private readonly pingMs = VIDEO_PING_MS
  ) {
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: VIEWER_MAX_PAYLOAD, handleProtocols: () => SUBPROTOCOL })
  }

  /**
   * Upgrades a viewer's request, or answers the status to refuse it with. The
   * ticket is spent whatever the answer. `where` is the server it came in on.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, where: 'local' | 'remote'): VideoUpgradeRefusal | null {
    const url = new URL(req.url ?? '/', 'http://host')
    const stream = videoStreamOf(url.pathname)
    if (!stream) return 404
    if (!offeredProtocols(req).includes(SUBPROTOCOL)) return 400
    const ticket = url.searchParams.get('ticket')
    const claim = ticket ? this.auth.consumeStreamTicket(ticket, stream) : null
    if (!claim || claim.scope === 'publish') return 401
    if (('local' in claim.holder) !== (where === 'local')) return 403
    if (!this.relay.claimable(claim)) return 404
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (!this.relay.attach(claim, ws)) return ws.close(1008, 'gone')
      this.keepAlive(ws)
    })
    return null
  }

  /** Every socket drops: the host is closing. */
  close(): void {
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    for (const ws of this.wss.clients) ws.terminate()
  }

  private keepAlive(ws: WebSocket): void {
    let missed = 0
    ws.on('pong', () => (missed = 0))
    const timer = setInterval(() => {
      if (missed >= MISSED_PONGS) return ws.terminate()
      missed++
      ws.ping()
    }, this.pingMs)
    timer.unref?.()
    this.timers.set(ws, timer)
    ws.on('close', () => {
      clearInterval(timer)
      this.timers.delete(ws)
    })
  }
}
