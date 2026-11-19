import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { CollabServer, ConvexCall, History } from 'work-kit/collab-server'
import type { WebSocketServer } from 'ws'
import type { ServiceConfig, ServiceLink } from '../wire'

/**
 * What a route of the Work service gets (docs/agents/work-service.md). The
 * route list is closed (routes/index.ts); each later milestone fills its own
 * file and edits no other.
 */
export interface RouteCtx {
  config(): ServiceConfig
  collab: CollabServer
  /** versions, compare, restore and branches of the live documents (milestone 19) */
  history: History
  /** LifeOS as the owner (an unfenced device JWT main hands over) */
  convex: ConvexCall
  /** guest links by id, as main last pushed them */
  links(): ReadonlyMap<string, ServiceLink>
  wss: WebSocketServer
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

export function refuseUpgrade(socket: Duplex, status: number, words: string): void {
  const reason = status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : status === 501 ? 'Not Implemented' : status === 503 ? 'Service Unavailable' : 'Refused'
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(words)}\r\n\r\n${words}`)
}
