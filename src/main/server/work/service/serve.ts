import { timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  ConvexDocStore,
  convexHttp,
  ConvexVersionStore,
  createCollabServer,
  createCollabVerifier,
  createHistory,
  FileDocStore,
  FileVersionStore,
  type CollabServer,
  type ConvexCall,
  type TrustedIssuer
} from 'work-kit/collab-server'
import { WebSocketServer } from 'ws'
import { PrivateBranchStore } from '../history/privateBranches'
import { notServedWords } from './config'
import { storeBook } from '../docs/storeBook'
import { INTERNAL_ROUTES, routeFor } from './routes'
import { refuseUpgrade, RouteError, sendJson, sendText, type RouteCtx } from './routes/route'
// By its path, as every module this process reaches: the service's bundle and its boundary test follow relative imports.
import { projectionLists } from '../../../../shared/work/guestProjection'
import type { ServiceConfig, ServiceLink, ServiceProject } from './wire'
import { queuedHistory } from '../history/hostQueue'

/**
 * The Work service itself (docs/agents/work-service.md), as its utility
 * process runs it (src/main/workServiceProcess.ts) and as a test runs it in
 * process. Two listeners:
 *  - public, on 127.0.0.1:<port>, the only one the tunnel may reach: the
 *    routes of routes/index.ts and nothing else;
 *  - internal, on a Unix socket (0660), every call carrying the shared
 *    secret: the routes of routes/internal.ts.
 * It never opens the app's database or the vault: main hands it the JWT
 * source, the keys and the link rows over its wire.
 */

export interface ServiceIo {
  /** An unfenced LifeOS device JWT for the owner, from main. */
  jwt(): Promise<string>
  log(line: string): void
}

export interface RunningService {
  port: number
  collab: CollabServer
  setLinks(links: ServiceLink[]): void
  setProject(linkId: string, project: ServiceProject | null): void
  setTrusted(trusted: TrustedIssuer[]): void
  stop(): Promise<void>
}

const MAX_BODY = 4 * 1024 * 1024

/** Sockets the public listener holds at once, and from one caller. */
export const MAX_SOCKETS = 512
export const MAX_SOCKETS_PER_CALLER = 48

/** A JWT's `exp` in ms, read without verifying (it is main's, for our own cache only). */
const expOf = (jwt: string): number => {
  try {
    return (JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as { exp?: number }).exp! * 1000
  } catch {
    return 0
  }
}

/** Main's JWT, kept until a minute before it runs out. */
function cachedJwt(io: ServiceIo): () => Promise<string> {
  let held: { jwt: string; until: number } | null = null
  let asking: Promise<string> | null = null
  return async () => {
    if (held && Date.now() < held.until) return held.jwt
    asking ??= io
      .jwt()
      .then((jwt) => {
        held = { jwt, until: expOf(jwt) - 60_000 }
        return jwt
      })
      .finally(() => (asking = null))
    return asking
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new RouteError(413, 'the body is too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Whether `header` is `Bearer <secret>`, compared in constant time. */
export function bearerMatches(header: string | undefined, secret: string): boolean {
  const want = Buffer.from(`Bearer ${secret}`)
  const got = Buffer.from(header ?? '')
  return secret.length >= 32 && got.length === want.length && timingSafeEqual(got, want)
}

export async function startWorkService(initial: ServiceConfig, io: ServiceIo): Promise<RunningService> {
  let config = initial
  let links = new Map(initial.links.map((l) => [l.linkId, l]))
  let trusted = initial.trusted
  const jwt = cachedJwt(io)
  const convex: ConvexCall = convexHttp(config.lifeos.url, jwt)
  const lifeosStore = new ConvexDocStore(convex)
  const fileStore = new FileDocStore()
  const notServed = config.lifeos.here ? null : notServedWords(config.lifeos.host)

  const projects = new Map<string, ServiceProject>()
  const linkLive = (id: string): boolean => {
    const link = links.get(id)
    return !!link && link.revokedAt === null && Date.now() < link.expiresAt
  }
  /**
   * Whether a token's link still lets it in. A project's link signs a token for each sheet it lists
   * and none for a document (a document is handed as its text, routes/guests.ts): a sheet's token
   * stands only while the projection lists that sheet, so one that left the project is shut at once
   * and opens nothing again, on any route, before the token runs out.
   */
  const claimLive = (claims: { link?: string; doc?: string; sheet?: string; iat?: number }): boolean => {
    if (!claims.link) return true
    if (!linkLive(claims.link)) return false
    const link = links.get(claims.link)!
    // A token signed before the link took a new address opens nothing (guests/links.ts rekey).
    const keyed = (link as { guest?: { keyedAt?: number } }).guest?.keyedAt ?? 0
    if (keyed && (claims.iat ?? 0) < keyed) return false
    if (!('project' in link.item)) return true
    const shown = projects.get(claims.link)?.projection
    if (!shown) return false
    return !!claims.sheet && projectionLists(shown, 'sheets', claims.sheet)
  }
  // The live documents' stores, each outcome written down: a tab's close is told the document is on disk only when it is.
  const stores = storeBook()
  const liveFiles = stores.wrap(fileStore)
  const liveLifeos = stores.wrap(lifeosStore)
  const verifier = createCollabVerifier(() => trusted)
  const collab = createCollabServer({
    // No client is given a document newer than it knows, and a document's schema rises only by this service's hand.
    schemaGate: true,
    // A window that says no schema is from before the gate, and v1.0.362 among those empties a document it opens
    // (work-docs.md "The first copy"): none is let onto any document. Every page this service serves says its schema.
    refuseSilent: true,
    verify: {
      ...verifier,
      async verify(token) {
        const claims = await verifier.verify(token)
        if (!claimLive(claims)) throw new Error('the link no longer shows this')
        return claims
      }
    },
    storeFor: (name) => (name.startsWith('file:') ? liveFiles : (notServed ?? liveLifeos)),
    journalDir: join(config.dataDir, 'journal'),
    linkLive,
    // A guest's caret carries the name the owner gave the link, whatever the page claims (work-kit guardPresence).
    presenceName: (c) => (c.link ? ((links.get(c.link) as { guest?: { name?: string } } | undefined)?.guest?.name ?? 'A guest') : null),
    log: io.log
  })
  // Versions and branches are kept where the document is: LifeOS's rows, or inside the .tcdoc (milestone 19),
  // but an agent's branch of a .tcdoc on this host's own disk, never in the file (history/privateBranches.ts).
  const lifeosVersions = new ConvexVersionStore(convex)
  const fileVersions = new PrivateBranchStore(new FileVersionStore(), join(config.dataDir, 'private-branches'))
  // One turn per document on this host around the history's acts: a check and its take run together (history/hostQueue.ts).
  const history = queuedHistory(createHistory({
    collab,
    versionsFor: (name) => (name.startsWith('file:') ? fileVersions : (notServed ?? lifeosVersions)),
    storeFor: (name) => (name.startsWith('file:') ? fileStore : (notServed ?? lifeosStore)),
    log: io.log
  }))
  // Yjs updates are small; an import's bulk comes through the internal routes, never a socket.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
  const ctx: RouteCtx = { config: () => config, collab, history, convex, links: () => links, projects: () => projects, claimLive, wss, stores, log: io.log }

  // ── public ────────────────────────────────────────────────────────────
  const pathOf = (req: IncomingMessage): string | null => {
    try {
      return new URL(req.url ?? '/', 'http://service').pathname
    } catch {
      return null
    }
  }
  const publicServer: Server = createServer((req, res) => {
    const path = pathOf(req)
    const found = path ? routeFor(path) : null
    if (!found?.route.http) return sendText(res, 404, 'not found')
    Promise.resolve(found.route.http(req, res, ctx, found.m)).catch((err: Error) => {
      io.log(`${path}: ${err.message}`)
      if (!res.headersSent) sendText(res, 500, 'the service failed')
    })
  })
  // Open sockets, all and per caller (the tunnel's CF-Connecting-IP; every request reaches us from 127.0.0.1).
  const open = new Map<string, number>()
  let openTotal = 0
  const callerOf = (req: IncomingMessage): string => {
    const cf = req.headers['cf-connecting-ip']
    return typeof cf === 'string' && cf.length < 64 ? cf : (req.socket.remoteAddress ?? '?')
  }
  publicServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy())
    const path = pathOf(req)
    const found = path ? routeFor(path) : null
    if (!found?.route.upgrade) return refuseUpgrade(socket, 404, 'not found')
    const caller = callerOf(req)
    if (openTotal >= MAX_SOCKETS || (open.get(caller) ?? 0) >= MAX_SOCKETS_PER_CALLER) return refuseUpgrade(socket, 503, 'too many sockets')
    openTotal++
    open.set(caller, (open.get(caller) ?? 0) + 1)
    socket.once('close', () => {
      openTotal--
      const left = (open.get(caller) ?? 1) - 1
      if (left > 0) open.set(caller, left)
      else open.delete(caller)
    })
    try {
      found.route.upgrade(req, socket, head, ctx, found.m)
    } catch (err) {
      io.log(`${path}: ${(err as Error).message}`)
      socket.destroy()
    }
  })
  publicServer.headersTimeout = 10_000
  publicServer.requestTimeout = 30_000

  // ── internal ──────────────────────────────────────────────────────────
  const internalServer: Server = createServer((req, res) => void internal(req, res))
  async function internal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!bearerMatches(req.headers.authorization, config.secret)) return sendJson(res, 401, { error: 'no secret' })
    const route = INTERNAL_ROUTES.find((r) => r.path === pathOf(req))
    if (!route) return sendJson(res, 404, { error: 'no such route' })
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
    try {
      const body = JSON.parse(await readBody(req)) as unknown
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RouteError(400, 'the body is not an object')
      sendJson(res, 200, (await route.run(body as Record<string, unknown>, ctx)) ?? {})
    } catch (err) {
      const status = err instanceof RouteError ? err.status : err instanceof SyntaxError ? 400 : 500
      // A route's own refusal keeps its words; anything else is logged here and told in one sentence.
      if (!(err instanceof RouteError)) io.log(`${route.path}: ${(err as Error).message}`)
      sendJson(res, status, { error: err instanceof RouteError || status < 500 ? (err as Error).message : 'the Work service failed; nothing changed' })
    }
  }

  const listen = (server: Server, how: { port: number; host: string } | { path: string }): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(how, () => {
        server.off('error', reject)
        resolve()
      })
    })

  if (existsSync(config.socketPath)) unlinkSync(config.socketPath)
  await listen(internalServer, { path: config.socketPath })
  chmodSync(config.socketPath, 0o660)
  try {
    await listen(publicServer, { port: config.port, host: '127.0.0.1' })
  } catch (err) {
    internalServer.close()
    await collab.stop()
    throw err
  }
  const port = (publicServer.address() as AddressInfo).port
  // Edits a killed process left in the journal, or a store that failed as its last editor left,
  // for documents nobody has opened since: stored now, and tried again every minute.
  let recovering: Promise<unknown> = Promise.resolve()
  const recover = (): void => {
    recovering = recovering.then(() => collab.recover()).catch((err: Error) => io.log(`recovering the journal failed: ${err.message}`))
  }
  recover()
  const recovery = setInterval(recover, 60_000)
  recovery.unref()

  return {
    port,
    collab,
    setLinks(next) {
      const keyedOf = (l: ServiceLink | undefined): number => (l as { guest?: { keyedAt?: number } } | undefined)?.guest?.keyedAt ?? 0
      const before = links
      links = new Map(next.map((l) => [l.linkId, l]))
      // A link that took a new address: every socket on it came in on a token from before, so all close now.
      const rekeyed = new Set([...links.values()].filter((l) => keyedOf(l) > keyedOf(before.get(l.linkId))).map((l) => l.linkId))
      // A link that went: its sockets close now, not at the next sweep.
      collab.closeWhere((c, name) => (!!c.link && rekeyed.has(c.link)) || !claimLive({ link: c.link, doc: name }), 'the link was revoked')
    },
    setProject(linkId, project) {
      if (project) projects.set(linkId, project)
      else projects.delete(linkId)
      // No document socket ever stands on a project's link; were one to, it closes here.
      collab.closeWhere((c, name) => c.link === linkId && !claimLive({ link: c.link, doc: name }), 'the link no longer shows this')
    },
    setTrusted(next) {
      trusted = next
      config = { ...config, trusted: next }
    },
    async stop() {
      clearInterval(recovery)
      history.stop()
      for (const client of wss.clients) client.terminate()
      await collab.stop()
      await recovering
      await Promise.all([new Promise((r) => publicServer.close(r)), new Promise((r) => internalServer.close(r))])
      publicServer.closeAllConnections()
      if (existsSync(config.socketPath)) unlinkSync(config.socketPath)
    }
  }
}
