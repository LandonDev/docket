import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/**
 * The box's full editor, carried to this computer (docs/agents/work-sheets.md "The full editor": "From another
 * computer"). The box answers the switch with the editor page's address on its public origin; this carries that one
 * address on a loopback port of its own, so the page, its frames and its sockets run on `http://127.0.0.1:<port>`, an
 * origin of their own, never the remote UI's where ONLYOFFICE's code could use the owner's session. Only the paths
 * under the page's own token go through; each request names the loopback origin in `x-tempcode-carry`, which the box's
 * route requires of anything that comes through the tunnel and uses for the editor's own links.
 */

/** The page's address as the box answers it: https (http only to a loopback host, a proof's), `/w/full/<64 hex>/`. */
export function parseCarry(address: string): { upstream: URL; base: string } | null {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  if (url.username || url.password || url.search || url.hash) return null
  const m = /^\/w\/full\/[0-9a-f]{64}\/$/.exec(url.pathname)
  return m ? { upstream: new URL(url.origin), base: url.pathname } : null
}

/** Headers a hop must not pass on (RFC 9110 7.6.1), and what the carrier sets itself. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'x-tempcode-carry'])
/** A cookie of 127.0.0.1 is any loopback server's (cookies keep no port): none goes to the box, nor any credential. */
const PRIVATE = new Set(['cookie', 'authorization'])

/** What the box answers, as the browser should get it: a redirect kept on the carrier's origin, no cookie, no wider service worker. */
export function downstreamHeaders(headers: IncomingHttpHeaders, upstream: URL, origin: string): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers }
  delete out['set-cookie']
  delete out['service-worker-allowed']
  const to = typeof out.location === 'string' ? out.location : undefined
  if (to && /^[a-z][a-z0-9+.-]*:/i.test(to)) {
    // An absolute redirect to the box's own origin comes back through the carrier; one anywhere else is not followed.
    if (to.startsWith(`${upstream.origin}/`)) out.location = origin + to.slice(upstream.origin.length)
    else delete out.location
  }
  return out
}

/** The browser's request as the box should get it: to the box's host, naming the loopback origin it is shown on. */
export function upstreamHeaders(headers: IncomingHttpHeaders, upstream: URL, origin: string, upgrade = false): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP.has(k) && !PRIVATE.has(k)) out[k] = v
  out.host = upstream.host
  out['x-tempcode-carry'] = origin
  if (upgrade) {
    out.connection = 'Upgrade'
    out.upgrade = String(headers.upgrade ?? 'websocket')
  }
  return out
}

/** A path the carrier passes: the page's own token's, nothing else of the box, and nothing a hop could read as another path (dot segments, an escaped slash or dot, a backslash). */
export const carries = (base: string, url: string | undefined): boolean =>
  !!url && (url.startsWith(base) || url === base.slice(0, -1)) && !/(?:^|\/)\.{1,2}(?:\/|\?|$)|%2e|%2f|%5c|\\/i.test(url.split('?')[0]!)

/** Who may write or open a socket through it: the page itself (a browser names its origin); a request of another origin is not passed. */
export const ownOrigin = (origin: string | undefined, own: string): boolean => origin === undefined || origin === own

/** A request named for the carrier's own address: another name that resolves here (DNS rebinding) is not served. */
export const ownHost = (host: string | undefined, port: number): boolean => host === `127.0.0.1:${port}`

/** An idle carrier closes: the box lets an open go after fifteen minutes unloaded, and the page itself keeps a socket open. */
export const CARRY_IDLE_MS = 30 * 60_000

interface Carried {
  server: Server
  url: string
  last: number
  sockets: Set<Socket>
}
const carried = new Map<string, Promise<Carried>>()

/** Carries the page at `address` and answers its loopback address; one carrier for each page, kept while it is used. */
export async function carry(address: string, opts: { idleMs?: number; now?: () => number } = {}): Promise<string> {
  const target = parseCarry(address)
  if (!target) throw new Error('That is not an address of the full editor.')
  let held = carried.get(address)
  if (!held) {
    held = start(target, opts).catch((err: unknown) => {
      carried.delete(address)
      throw err
    })
    carried.set(address, held)
    void held.then((c) => c.server.on('close', () => carried.delete(address)))
  }
  const c = await held
  c.last = (opts.now ?? Date.now)()
  return c.url
}

/** Closes every carrier (the app quitting, a test's end). */
export async function closeCarriers(): Promise<void> {
  const all = [...carried.values()]
  carried.clear()
  for (const held of all) {
    const c = await held.catch(() => null)
    if (!c) continue
    for (const s of c.sockets) s.destroy()
    await new Promise<void>((r) => c.server.close(() => r()))
  }
}

async function start(target: { upstream: URL; base: string }, opts: { idleMs?: number; now?: () => number }): Promise<Carried> {
  const { upstream, base } = target
  const now = opts.now ?? Date.now
  const secure = upstream.protocol === 'https:'
  const port = Number(upstream.port) || (secure ? 443 : 80)
  const c: Carried = { server: createServer(), url: '', last: now(), sockets: new Set() }
  const origin = (): string => new URL(c.url).origin
  const port0 = (): number => Number(new URL(c.url).port)

  c.server.on('request', (req: IncomingMessage, res) => {
    c.last = now()
    const reading = req.method === 'GET' || req.method === 'HEAD'
    if (!carries(base, req.url) || !ownHost(req.headers.host, port0()) || (!reading && !ownOrigin(req.headers.origin, origin())))
      return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
    const up = (secure ? httpsRequest : httpRequest)(
      { host: upstream.hostname, port, path: req.url, method: req.method, headers: upstreamHeaders(req.headers, upstream, origin()), servername: upstream.hostname },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, downstreamHeaders(answer.headers, upstream, origin()))
        answer.pipe(res)
      }
    )
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('the box is not answering')
      else res.destroy()
    })
    res.on('close', () => up.destroy())
    req.pipe(up)
  })

  c.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    c.last = now()
    if (!carries(base, req.url) || !ownHost(req.headers.host, port0()) || !ownOrigin(req.headers.origin, origin())) return void socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    const up: Socket = secure ? tlsConnect({ host: upstream.hostname, port, servername: upstream.hostname }) : netConnect({ host: upstream.hostname, port })
    c.sockets.add(socket)
    socket.on('close', () => c.sockets.delete(socket))
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
    up.once(secure ? 'secureConnect' : 'connect', () => {
      const lines = [`${req.method ?? 'GET'} ${req.url} HTTP/1.1`]
      for (const [k, v] of Object.entries(upstreamHeaders(req.headers, upstream, origin(), true))) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`)
      up.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
  })

  await new Promise<void>((resolve, reject) => {
    c.server.once('error', reject)
    c.server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port: own } = c.server.address() as { port: number }
  c.url = `http://127.0.0.1:${own}${base}`
  // Closed once nothing has come through it for its idle time and no socket is open.
  const idleMs = opts.idleMs ?? CARRY_IDLE_MS
  const tick = setInterval(() => {
    if (c.sockets.size !== 0 || now() - c.last <= idleMs) return
    c.server.close()
    c.server.closeIdleConnections()
  }, Math.min(idleMs, 60_000))
  tick.unref()
  c.server.on('close', () => clearInterval(tick))
  return c
}
