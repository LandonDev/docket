import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { CollabServer, ConvexCall } from 'work-kit/collab-server'
import type { WebSocketServer } from 'ws'
import type { ServiceConfig, ServiceLink, ServiceOrigins, ServiceProject } from '../wire'
import type { QueuedHistory } from '../../history/hostQueue'
import type { StoreBook } from '../../docs/storeBook'

/**
 * What a route of the Work service gets (docs/agents/work-service.md). The
 * route list is closed (routes/index.ts); each later milestone fills its own
 * file and edits no other.
 */
export interface RouteCtx {
  config(): ServiceConfig
  collab: CollabServer
  /** versions, compare, restore and branches of the live documents (milestone 19) */
  history: QueuedHistory
  /** LifeOS as the owner (an unfenced device JWT main hands over) */
  convex: ConvexCall
  /** guest links by id, as main last pushed them */
  links(): ReadonlyMap<string, ServiceLink>
  /** what each project link shows, by link id, as main last pushed it */
  projects(): ReadonlyMap<string, ServiceProject>
  /** whether a token's link still stands and, for a project's link, still lists the token's document or sheet */
  claimLive(claims: { link?: string; doc?: string; sheet?: string; iat?: number; role?: string }): boolean
  wss: WebSocketServer
  /** a random value made when this run of the service started: `/w/healthz` answers it, and a sheet's socket says it */
  mark: string
  /** whether main has sent its links since this service started (or handed its last list on at a restart of the service alone) */
  settled(): boolean
  /** which pages may open a socket here */
  origins(): ServiceOrigins
  /** a socket on a live document closed: its compaction may be due (service/compaction.ts) */
  docLeft(doc: string): void
  /** what each live document's last store came to (docs/storeBook.ts); absent in a test's context */
  stores?: StoreBook
  log(line: string): void
}

/** A route on the public listener. */
export interface PublicRoute {
  /** what it serves, in words */
  name: string
  /** the plan milestone that builds it */
  milestone: number
  match: RegExp
  http?(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, m: RegExpExecArray): void | Promise<void>
  upgrade?(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: RouteCtx, m: RegExpExecArray): void
}

/** An internal route (the Unix socket, behind the secret): a JSON body in, a JSON answer out. */
export interface InternalRoute {
  path: string
  milestone: number
  run(body: Record<string, unknown>, ctx: RouteCtx): Promise<unknown>
}

/** A refusal with its status: a 4xx's words reach the caller as they are (M17's worker passes them to the bot). */
export class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export const notBuiltWords = (what: string, milestone: number): string => `not built: ${what} (milestone ${milestone})`

/** A route whose milestone has not landed: it says so, loudly, and serves nothing. */
export function stubRoute(name: string, milestone: number, match: RegExp): PublicRoute {
  const words = notBuiltWords(name, milestone)
  return {
    name,
    milestone,
    match,
    http: (_req, res) => sendText(res, 501, words),
    upgrade: (_req, socket) => refuseUpgrade(socket, 501, words)
  }
}

export function stubInternal(path: string, what: string, milestone: number): InternalRoute {
  return {
    path,
    milestone,
    run: async () => {
      throw new RouteError(501, notBuiltWords(what, milestone))
    }
  }
}

/** Headers every answer of the public listener carries: nothing cached, nothing sniffed, no referrer, never framed. */
export const BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/
/** LifeOS's desktop app loads its window from a file, and a browser names that origin so. */
const FILE_ORIGIN = 'file://'
/** What a test's config, which names no origins, is held to: loopback pages, as an isolated instance. */
export const TEST_ORIGINS: ServiceOrigins = { allowed: [], guest: null, loopback: true }

/**
 * Whether the page behind a socket upgrade may open it, by the `Origin` a browser sends (docs/agents/work-service.md
 * "Origins"). No `Origin` is a native client or main's own relay, and passes; every route still asks for its token.
 *  - A guest's socket (`/g/ws/*`) takes the guest pages' origin alone (the public origin until they have their own),
 *    and on a public host it must name one: only a browser page is a guest.
 *  - Any other socket takes this host's own origins, a page on loopback (a dev build of LifeOS or of ours) and
 *    LifeOS's desktop app, whose window is a file.
 * A sandboxed frame's `null` passes nowhere.
 */
export function originAllowed(req: IncomingMessage, origins: ServiceOrigins, path: string): boolean {
  const origin = req.headers.origin
  const guest = path.startsWith('/g/ws/')
  if (typeof origin !== 'string' || origin === '') return !guest || origins.loopback
  if (LOOPBACK_ORIGIN.test(origin)) return !guest || origins.loopback
  if (guest) return origins.guest !== null ? origin === origins.guest : origins.allowed.includes(origin)
  return origin === FILE_ORIGIN || origins.allowed.includes(origin)
}

export function refuseUpgrade(socket: Duplex, status: number, words: string): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 501 ? 'Not Implemented' : status === 503 ? 'Service Unavailable' : 'Refused'
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(words)}\r\n\r\n${words}`)
}
