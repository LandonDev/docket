import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { ADDIN_ASSETS } from '../../office/addin/assets'
import { bearerMatches } from '../serve'
import { BASE_HEADERS, refuseUpgrade, sendText, type PublicRoute, type RouteCtx } from './route'

/**
 * `wss …/w/office` and `GET …/w/addin/*`: the relay between our Office add-in
 * and this host (docs/agents/work-office.md "The add-in"). The add-in runs in
 * Office's own web view, which may not reach this machine's loopback, so it
 * connects out to the public address and the relay hands it to main.
 *
 * The relay judges nothing itself. Main holds the keys and the pairing code
 * and connects to `/w/office/host` with the service's secret (from this
 * machine only: a request through the tunnel carries `CF-Connecting-IP` and
 * is refused). Then, for each add-in socket:
 *
 *   add-in → `{t: 'hello', key, …}` or `{t: 'pair', code, …}`  first, within 10 s, under 4 KiB
 *   relay → main `{t: 'open', conn, first, from}`
 *   main → relay `{t: 'send', conn, data}`        `data` (a JSON value) goes to the add-in
 *   main → relay `{t: 'admit', conn}`             from now on the add-in's messages go to main
 *   main → relay `{t: 'refuse', conn, code, reason}`  the socket closes
 *   relay → main `{t: 'msg', conn, data}` and `{t: 'close', conn}`
 *
 * A socket that has not been let in holds a slot for 5 s at most, and one
 * caller holds four such slots at once.
 *
 * With main away, an add-in is refused at the upgrade (503), and every open
 * add-in socket closes 4503 when main's link goes.
 */

const HELLO_MS = 5000
const FIRST_MAX = 4 * 1024
/** An add-in's message: one workbook block's answer, with room over Excel on the web's 5 MB a request. */
const MAX_MESSAGE = 8 * 1024 * 1024
const MAX_ADDINS = 64
const MAX_WAITING = 32
const MAX_WAITING_PER_CALLER = 4
const MAX_BUFFERED = 16 * 1024 * 1024
const PING_MS = 30_000

/** Where Office may frame the pane: Excel, Word and PowerPoint on the web. */
const FRAME_ANCESTORS = "frame-ancestors 'self' https://*.officeapps.live.com https://*.office.com https://*.office365.com https://*.microsoft365.com https://*.cloud.microsoft https://*.sharepoint.com https://*.live.com"

interface AddinSocket {
  ws: WebSocket
  admitted: boolean
  /** gives back its waiting slot */
  settle(): void
}

interface Relay {
  host: WebSocket | null
  conns: Map<number, AddinSocket>
  /** sockets not yet let in, by caller */
  waiting: Map<string, number>
  next: number
}

/** The relay's own sockets: the service's carry 4 MiB, a block and its envelope can carry more. */
const addinWss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE })
const hostWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })

const relays = new WeakMap<RouteCtx, Relay>()
const relayOf = (ctx: RouteCtx): Relay => {
  let r = relays.get(ctx)
  if (!r) relays.set(ctx, (r = { host: null, conns: new Map(), waiting: new Map(), next: 1 }))
  return r
}
const waitingCount = (r: Relay): number => [...r.waiting.values()].reduce((a, b) => a + b, 0)

const toHost = (r: Relay, msg: unknown): void => {
  if (r.host && r.host.readyState === r.host.OPEN) r.host.send(JSON.stringify(msg))
}

/** Main's side: one link at a time; a new one replaces the old. */
function hostUpgrade(req: IncomingMessage, socket: Parameters<NonNullable<PublicRoute['upgrade']>>[1], head: Buffer, ctx: RouteCtx): void {
  if (req.headers['cf-connecting-ip'] !== undefined) return refuseUpgrade(socket, 404, 'not found')
  if (!bearerMatches(req.headers.authorization, ctx.config().secret)) return refuseUpgrade(socket, 401, 'no secret')
  const r = relayOf(ctx)
  hostWss.handleUpgrade(req, socket, head, (ws) => {
    // A new link knows none of the add-ins on the old one: they reconnect and say hello to it.
    if (r.host) {
      r.host.close(4409, 'another link took over')
      for (const c of r.conns.values()) c.ws.close(4503, 'TempCode went away')
    }
    r.host = ws
    ws.on('error', () => ws.terminate())
    ws.on('close', () => {
      if (r.host !== ws) return
      r.host = null
      for (const c of r.conns.values()) c.ws.close(4503, 'TempCode went away')
    })
    ws.on('message', (data: Buffer, binary: boolean) => {
      if (binary) return
      let m: { t?: unknown; conn?: unknown; data?: unknown; code?: unknown; reason?: unknown }
      try {
        m = JSON.parse(data.toString('utf8')) as typeof m
      } catch {
        return
      }
      const c = typeof m.conn === 'number' ? r.conns.get(m.conn) : undefined
      if (!c) return
      if (m.t === 'send' && m.data !== undefined) {
        if (c.ws.bufferedAmount > MAX_BUFFERED) c.ws.terminate()
        else c.ws.send(JSON.stringify(m.data))
      } else if (m.t === 'admit') {
        c.admitted = true
        c.settle()
      }
      else if (m.t === 'refuse') c.ws.close(typeof m.code === 'number' && m.code >= 4000 && m.code < 5000 ? m.code : 4403, typeof m.reason === 'string' ? m.reason.slice(0, 120) : 'refused')
    })
  })
}

function addinUpgrade(req: IncomingMessage, socket: Parameters<NonNullable<PublicRoute['upgrade']>>[1], head: Buffer, ctx: RouteCtx): void {
  const r = relayOf(ctx)
  if (!r.host) return refuseUpgrade(socket, 503, 'TempCode is not listening on this host')
  const cf = req.headers['cf-connecting-ip']
  const from = typeof cf === 'string' ? cf.slice(0, 64) : (req.socket.remoteAddress ?? '?')
  const admitted = [...r.conns.values()].filter((c) => c.admitted).length
  if (admitted >= MAX_ADDINS || waitingCount(r) >= MAX_WAITING || (r.waiting.get(from) ?? 0) >= MAX_WAITING_PER_CALLER) return refuseUpgrade(socket, 503, 'too many add-ins')
  r.waiting.set(from, (r.waiting.get(from) ?? 0) + 1)
  let waiting = true
  const settle = (): void => {
    if (!waiting) return
    waiting = false
    const left = (r.waiting.get(from) ?? 1) - 1
    if (left > 0) r.waiting.set(from, left)
    else r.waiting.delete(from)
  }
  socket.once('close', settle)
  addinWss.handleUpgrade(req, socket, head, (ws) => {
    const conn = r.next++
    const me: AddinSocket = { ws, admitted: false, settle }
    let opened = false
    let alive = true
    const hello = setTimeout(() => !me.admitted && ws.close(4401, 'say hello with a key first'), HELLO_MS)
    const ping = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, PING_MS)
    ping.unref?.()
    r.conns.set(conn, me)
    ws.on('pong', () => (alive = true))
    ws.on('error', () => ws.terminate())
    ws.on('close', () => {
      clearTimeout(hello)
      clearInterval(ping)
      settle()
      r.conns.delete(conn)
      if (opened) toHost(r, { t: 'close', conn })
    })
    ws.on('message', (data: Buffer, binary: boolean) => {
      if (binary) return ws.close(1003, 'a message is JSON text')
      const text = data.toString('utf8')
      if (me.admitted) {
        try {
          return toHost(r, { t: 'msg', conn, data: JSON.parse(text) as unknown })
        } catch {
          return ws.close(1007, 'not JSON')
        }
      }
      // Before main answers, one first message and nothing more.
      if (opened) return ws.close(1008, 'wait for the answer')
      if (data.length > FIRST_MAX) return ws.close(4401, 'say hello with a key first')
      let first: { t?: unknown }
      try {
        first = JSON.parse(text) as typeof first
      } catch {
        return ws.close(1007, 'not JSON')
      }
      if (!first || (first.t !== 'hello' && first.t !== 'pair')) return ws.close(4401, 'say hello with a key first')
      opened = true
      clearTimeout(hello)
      toHost(r, { t: 'open', conn, first, from })
    })
  })
}

export const officeRoute: PublicRoute = {
  name: 'the Office add-in',
  milestone: 29,
  match: /^\/w\/(office|addin)(\/.*)?$/,
  http(_req, res, _ctx, m) {
    if (m[1] === 'office') {
      res.writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket', 'Cache-Control': 'no-store' })
      res.end('the add-in relay is a socket')
      return
    }
    const asset = ADDIN_ASSETS[(m[2] ?? '').replace(/^\//, '')]
    if (!asset) return sendText(res, 404, 'not found')
    const headers: Record<string, string> = { ...BASE_HEADERS, 'Content-Type': asset.type, 'Cache-Control': 'no-cache' }
    // Office on the web frames the pane and draws the icons on its own pages.
    delete headers['X-Frame-Options']
    headers['Content-Security-Policy'] = FRAME_ANCESTORS
    headers['Cross-Origin-Resource-Policy'] = 'cross-origin'
    res.writeHead(200, headers)
    res.end(asset.body)
  },
  upgrade(req, socket, head, ctx, m) {
    if (m[1] !== 'office') return refuseUpgrade(socket, 404, 'not found')
    if (m[2] === '/host') return hostUpgrade(req, socket, head, ctx)
    if (m[2]) return refuseUpgrade(socket, 404, 'not found')
    addinUpgrade(req, socket, head, ctx)
  }
}
