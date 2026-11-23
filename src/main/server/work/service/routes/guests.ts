import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createCollabVerifier, type VerifiedClaims } from 'work-kit/collab-server'
import { knownSchema, SCHEMA_PARAM } from 'work-kit/collab'
import { projectionLists } from '../../../../../shared/work/guestProjection'
import type { GuestServiceLink } from '../../guests/wire'
import { HOSTED_CSP } from './hosted'
import { BASE_HEADERS, refuseUpgrade, sendText, type InternalRoute, type PublicRoute, type RouteCtx } from './route'
import { sheetRoute } from './sheet'

/**
 * The guest's routes on the public listener (architecture §8.6,
 * docs/agents/work-guests.md "The routes"). A guest holds a link id and its
 * secret (the address's fragment, which no request carries) and nothing
 * else: no key, no thread, no other item. Every check reads the links main
 * last sent (`ctx.links()`), which hold only live links: a revoked or ended
 * one is simply gone.
 *
 *   GET  /g/<id>            the page (the same for any well-formed id: it says nothing of the link)
 *   POST /g/<id>/open       {secret} → who and what, and a token for the item; failed secrets are counted per caller
 *   GET  /g/ws/<id>         the item's socket, bound to the link's item whatever the client names
 *   GET  /g/<id>/threads    a document's comments (Bearer: the token)
 *   POST /g/<id>/comment    {quote, text} or {threadId, text}: plain words; the service builds the comment and marks the words
 *
 * A project's link (view only; "A project's link" in the same doc) opens to
 * the projection main last sent for it and nothing else of the project:
 *
 *   POST /g/<id>/open       {secret} → who and what, and the projection; asked again every 15 s
 *   POST /g/<id>/item       {secret, table, id} → one document or sheet the projection lists: a document's text as it stands now, a sheet's view token
 *   GET  /g/ws/<id>/sheets/<sheet>   that sheet's socket, read only, while the projection lists it
 *
 * A project's document is handed as its present text and never as its live
 * room: the room's state keeps words that were deleted and the marks of his
 * comments, and a guest of the whole project is shown neither. Nothing on
 * these routes writes for a project's link, and a document or sheet outside
 * the projection answers as gone, like an unknown link.
 *
 * Callers are told apart by `CF-Connecting-IP` (every request reaches us
 * from cloudflared on 127.0.0.1), else the peer address.
 */

const ID = '([A-Za-z0-9_-]{1,40})'
const PAGE = new RegExp(`^/g/${ID}$`)
const ACTION = new RegExp(`^/g/${ID}/(open|item|threads|comment)$`)
const SOCKET = new RegExp(`^/g/ws/${ID}(?:/sheets/([A-Za-z0-9]{1,64}))?$`)
const MAX_BODY = 16 * 1024
export const COMMENT_MAX = 4000

// ── limits ─────────────────────────────────────────────────────────────

/**
 * A count per key in a fixed window, holding at most `cap` keys: past that the oldest goes (a Map
 * keeps insertion order), so a flood of new callers costs a bounded map and no scan.
 */
export class Window {
  private readonly hits = new Map<string, { n: number; until: number }>()
  constructor(
    private readonly max: number,
    private readonly ms: number,
    private readonly cap = 20_000
  ) {}
  /** Counts one; false once the key is past its limit in this window. */
  take(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.until <= now) {
      this.hits.delete(key)
      while (this.hits.size >= this.cap) this.hits.delete(this.hits.keys().next().value!)
      this.hits.set(key, { n: 1, until: now + this.ms })
      return true
    }
    h.n++
    return h.n <= this.max
  }
  over(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    return !!h && h.until > now && h.n >= this.max
  }
  get size(): number {
    return this.hits.size
  }
  clear(): void {
    this.hits.clear()
  }
}

/** Requests per caller per minute, failed secrets per caller per ten minutes, comments per link per minute. */
export const LIMITS = { requests: new Window(240, 60_000), failures: new Window(10, 10 * 60_000), comments: new Window(20, 60_000) }

/** Who is asking, for the limits: the tunnel's `CF-Connecting-IP`, else the peer; an IPv6 address by its /64, which one home or host holds whole. */
export const callerOf = (req: IncomingMessage): string => {
  const cf = req.headers['cf-connecting-ip']
  return callerKey(typeof cf === 'string' && cf.length > 0 && cf.length < 64 ? cf : (req.socket.remoteAddress ?? '?'))
}
export function callerKey(address: string): string {
  if (!address.includes(':') || address.startsWith('::ffff:')) return address.replace(/^::ffff:/, '')
  // Expand "::" so the first four groups are the /64.
  const [head, tail] = address.split('::') as [string, string | undefined]
  const left = head ? head.split(':') : []
  const right = tail !== undefined && tail ? tail.split(':') : []
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`
}

// ── what the service saw ───────────────────────────────────────────────

const seen = new Map<string, { at: number; open: number }>()
const opened = (id: string): void => void seen.set(id, { at: Date.now(), open: seen.get(id)?.open ?? 0 })
const sockets = (id: string, by: number): void => {
  const s = seen.get(id) ?? { at: Date.now(), open: 0 }
  seen.set(id, { at: Date.now(), open: Math.max(0, s.open + by) })
}

/** Main asks it for the audit list: when each link was last opened and how many sockets it holds. */
export const internalGuestRoutes: InternalRoute[] = [{ path: '/internal/guests/seen', milestone: 31, run: async () => ({ seen: Object.fromEntries(seen) }) }]

// ── helpers ────────────────────────────────────────────────────────────

const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()
const sameHash = (secret: string, hex: string): boolean => {
  const want = Buffer.from(hex, 'hex')
  const got = sha(secret)
  return want.length === got.length && timingSafeEqual(got, want)
}

/** A sheet socket reached through a guest link's own address: the sheet route takes only that link's token on it. */
export type GuestBound = IncomingMessage & { guestLink?: string }

/** A live guest link by id, or null (a ticket's pass is never one). */
export function guestLink(ctx: RouteCtx, id: string, now = Date.now()): (GuestServiceLink & { guest: NonNullable<GuestServiceLink['guest']> }) | null {
  const l = ctx.links().get(id) as GuestServiceLink | undefined
  if (!l?.guest || l.revokedAt !== null || l.expiresAt <= now) return null
  return l as GuestServiceLink & { guest: NonNullable<GuestServiceLink['guest']> }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        resolve(null)
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** The page: one file for every guest and for the owner's hosted editor; it reads the address itself. */
export function sendPage(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): void {
  let page: Buffer
  try {
    page = readFileSync(join(ctx.config().hostedDir, 'guest', 'index.html'))
  } catch {
    return sendText(res, 503, 'the page is not built on this host')
  }
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': HOSTED_CSP, 'X-Robots-Tag': 'noindex' })
  res.end(req.method === 'HEAD' ? undefined : page)
}

/** Plain words a guest typed, as a comment body of one paragraph per line: no links, no marks, nothing but text. */
export function plainBody(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .split('\n')
  return JSON.stringify(lines.map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line, styles: {} }] : [] })))
}

/** LifeOS's `docs.threads` rows as the guest's editor reads them, with every author but the owner and this guest made anonymous. */
interface LifeosThread {
  thread: { _id: string; quote?: string; resolved: boolean; resolvedAt?: number; at: number; editedAt: number; deletedAt?: number }
  comments: Array<{ _id: string; author?: string; externalAuthor?: { name: string }; body: string; at: number; editedAt: number; deletedAt?: number }>
}
export function guestThreads(rows: readonly LifeosThread[], me: string, owner: string) {
  const names: Record<string, string> = { owner, [me]: 'You' }
  const ids = new Map<string, string>([
    ['owner', 'owner'],
    [me, me]
  ])
  const idOf = (author: string): string => {
    let id = ids.get(author)
    if (!id) {
      id = `p${ids.size}`
      ids.set(author, id)
      // Another guest is "A guest": a guest learns nobody else's name from here.
      names[id] = author.startsWith('guest:') ? 'A guest' : author.startsWith('external:') ? author.slice(9).slice(0, 80) || 'Someone' : author.startsWith('agent:') ? `${owner}'s assistant` : owner
    }
    return id
  }
  const out = rows
    .filter((r) => !r.thread.deletedAt)
    .map(({ thread, comments }) => ({
      thread: {
        publicId: thread._id,
        ...(thread.quote !== undefined ? { quote: thread.quote } : {}),
        resolved: thread.resolved,
        resolvedAt: thread.resolvedAt ?? null,
        resolvedByMemberId: null,
        createdAt: thread.at,
        updatedAt: thread.editedAt,
        deletedAt: null
      },
      comments: comments.map((c) => ({
        publicId: c._id,
        body: c.deletedAt ? '[]' : c.body,
        authorMemberId: idOf(c.author ?? `external:${c.externalAuthor?.name ?? 'Someone'}`),
        reactions: [],
        createdAt: c.at,
        updatedAt: c.editedAt,
        deletedAt: c.deletedAt ?? null
      }))
    }))
  return { rows: out, names }
}

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).host
  } catch {
    return null
  }
}

// ── the route ──────────────────────────────────────────────────────────

let verifierFor: { ctx: RouteCtx; verify: ReturnType<typeof createCollabVerifier> } | null = null
const verifier = (ctx: RouteCtx): ReturnType<typeof createCollabVerifier> => {
  if (verifierFor?.ctx !== ctx) verifierFor = { ctx, verify: createCollabVerifier(() => ctx.config().trusted) }
  return verifierFor.verify
}

/** The bearer token of a request, checked: this link's, for its item, live. */
async function bearer(req: IncomingMessage, ctx: RouteCtx, id: string): Promise<{ link: NonNullable<ReturnType<typeof guestLink>>; claims: VerifiedClaims } | null> {
  const link = guestLink(ctx, id)
  const auth = req.headers.authorization
  if (!link || typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null
  try {
    const claims = await verifier(ctx).verify(auth.slice(7))
    if (claims.link !== id || claims.principal !== `guest:${id}`) return null
    // The link still stands and this token is no older than its address.
    if (!ctx.claimLive(claims)) return null
    // A project's link has no token of its own: its items' tokens open their sockets and nothing here.
    if ('project' in link.item) return null
    if ('doc' in link.item ? claims.doc !== link.item.doc : claims.sheet !== link.item.sheet) return null
    return { link, claims }
  } catch {
    return null
  }
}

async function open(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, id: string): Promise<void> {
  const caller = callerOf(req)
  if (LIMITS.failures.over(caller)) return json(res, 429, { error: 'Too many tries from here. Try again in a few minutes.' })
  const body = await readJson(req)
  const secret = typeof body?.secret === 'string' && body.secret.length <= 100 ? body.secret : ''
  const link = guestLink(ctx, id)
  // One answer for every refusal: whether the link was never made, ended, was revoked or the secret is wrong.
  if (!link || !secret || !sameHash(secret, link.guest.secretHash)) {
    LIMITS.failures.take(caller)
    return json(res, 403, { error: 'gone' })
  }
  opened(id)
  if ('project' in link.item) {
    // The projection is main's last read of LifeOS's cut; until it lands (a service just started) the page tries again.
    const shown = ctx.projects().get(id)
    if (!shown) return json(res, 503, { error: 'This page cannot be reached right now.' })
    return json(res, 200, { kind: 'project', role: 'view', name: link.guest.name, title: shown.projection.project.name, owner: link.guest.owner, expiresAt: link.expiresAt, me: `guest:${id}`, projection: shown.projection })
  }
  json(res, 200, {
    kind: 'doc' in link.item ? 'doc' : 'sheet',
    role: link.role,
    name: link.guest.name,
    title: link.guest.title,
    owner: link.guest.owner,
    expiresAt: link.expiresAt,
    token: link.guest.token,
    tokenExp: link.guest.tokenExp,
    me: `guest:${id}`,
    ...('doc' in link.item ? { doc: link.item.doc } : {})
  })
}

/** A project link's document or sheet, while the projection lists it: a document's text now, a sheet's view token. Anything else answers as an unknown link does. */
async function item(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, id: string): Promise<void> {
  const caller = callerOf(req)
  if (LIMITS.failures.over(caller)) return json(res, 429, { error: 'Too many tries from here. Try again in a few minutes.' })
  const body = await readJson(req)
  const secret = typeof body?.secret === 'string' && body.secret.length <= 100 ? body.secret : ''
  const link = guestLink(ctx, id)
  if (!link || !secret || !sameHash(secret, link.guest.secretHash)) {
    LIMITS.failures.take(caller)
    return json(res, 403, { error: 'gone' })
  }
  const table = body?.table === 'docs' || body?.table === 'sheets' ? body.table : null
  const itemId = typeof body?.id === 'string' && /^[A-Za-z0-9]{1,64}$/.test(body.id) ? body.id : ''
  const shown = 'project' in link.item ? ctx.projects().get(id) : undefined
  if (!shown || !table || !itemId || !projectionLists(shown.projection, table, itemId)) return json(res, 403, { error: 'gone' })
  const p = shown.projection
  const facts = { role: 'view', name: link.guest.name, owner: link.guest.owner, expiresAt: link.expiresAt, me: `guest:${id}` }
  if (table === 'docs') {
    if (!ctx.config().lifeos.here) return json(res, 503, { error: 'This page cannot be reached right now.' })
    // The text as it stands, read from the live document: no socket, so no deleted words, no comment marks and no one's caret.
    const text = await ctx.collab.read(itemId)
    // Listed still, now that the read is done: a document that left meanwhile is not handed over.
    const still = ctx.projects().get(id)?.projection
    if (!still || !projectionLists(still, 'docs', itemId) || !guestLink(ctx, id)) return json(res, 403, { error: 'gone' })
    return json(res, 200, { ...facts, kind: 'doc', title: p.docs.find((d) => d.id === itemId)?.title ?? p.project.name, doc: itemId, markdown: text.markdown })
  }
  const token = shown.tokens[`sheets:${itemId}`]
  if (!token) return json(res, 403, { error: 'gone' })
  json(res, 200, { ...facts, kind: 'sheet', title: p.sheets.find((s) => s.id === itemId)!.title, token: token.token, tokenExp: token.exp, sheet: itemId })
}

async function threads(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, id: string): Promise<void> {
  const got = await bearer(req, ctx, id)
  if (!got || !('doc' in got.link.item)) return json(res, 403, { error: 'gone' })
  const docId = got.link.item.doc
  const rows = (await ctx.convex('query', 'docs:threads', { docId })) as LifeosThread[]
  json(res, 200, guestThreads(rows, `guest:${id}`, got.link.guest.owner))
}

async function comment(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, id: string): Promise<void> {
  const got = await bearer(req, ctx, id)
  if (!got || !('doc' in got.link.item)) return json(res, 403, { error: 'gone' })
  // A view link writes nothing at all, comments included.
  if (got.link.role === 'view') return json(res, 403, { error: 'This link can view, not comment.' })
  if (!LIMITS.comments.take(id)) return json(res, 429, { error: 'Too many comments at once. Try again in a minute.' })
  const body = await readJson(req)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text || text.length > COMMENT_MAX) return json(res, 400, { error: `A comment is 1 to ${COMMENT_MAX} characters.` })
  if (!ctx.config().lifeos.here) return json(res, 503, { error: 'This page cannot be reached right now.' })
  const docId = got.link.item.doc
  const author = `guest:${id}`
  if (typeof body?.threadId === 'string') {
    // A reply goes only on a thread of this document.
    const rows = (await ctx.convex('query', 'docs:threads', { docId })) as LifeosThread[]
    const thread = rows.find((r) => r.thread._id === body.threadId && !r.thread.deletedAt)
    if (!thread) return json(res, 404, { error: 'That comment is gone.' })
    const made = (await ctx.convex('mutation', 'docs:addComment', { threadId: thread.thread._id, body: plainBody(text), author })) as string | { commentId: string }
    return json(res, 200, { commentId: typeof made === 'string' ? made : made.commentId })
  }
  const quote = typeof body?.quote === 'string' ? body.quote : ''
  if (!quote || quote.length > 2000) return json(res, 400, { error: 'Pick the words the comment is about.' })
  if (!(await ctx.collab.hasQuote(docId, quote))) return json(res, 400, { error: 'Those words are no longer in the document.' })
  const { threadId } = (await ctx.convex('mutation', 'docs:createThread', { docId, body: plainBody(text), quote, author })) as { threadId: string }
  // The guest may not write the document, so the service marks the words; an edit link's editor marks them itself.
  if (got.link.role === 'comment' && !(await ctx.collab.markThread(docId, author, quote, threadId))) ctx.log(`[guests] ${docId}: thread ${threadId} was made but its words could not be marked`)
  json(res, 200, { threadId })
}

/** A guest's leaving cuts a version at most every five minutes per link and document: reconnecting in a loop makes no pile of them. */
const lastCut = new Map<string, number>()
export function cutDue(key: string, now = Date.now()): boolean {
  if ((lastCut.get(key) ?? 0) > now - 5 * 60_000) return false
  if (lastCut.size > 5000) lastCut.clear()
  lastCut.set(key, now)
  return true
}

function upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, ctx: RouteCtx, id: string, sheet?: string): void {
  const link = guestLink(ctx, id)
  if (!link) return refuseUpgrade(socket, 404, 'gone')
  // A project's link opens only a sheet its projection lists (its documents have no socket); any other link only its own item.
  let item: { doc: string } | { sheet: string }
  if ('project' in link.item) {
    const shown = ctx.projects().get(id)?.projection
    if (!sheet || !shown || !projectionLists(shown, 'sheets', sheet)) return refuseUpgrade(socket, 404, 'gone')
    item = { sheet }
  } else {
    if (sheet) return refuseUpgrade(socket, 404, 'gone')
    item = link.item
  }
  sockets(id, 1)
  socket.once('close', () => sockets(id, -1))
  if ('sheet' in item) {
    // The sheet's own route, on the link's sheet: it checks the token, the link each second and every op,
    // and takes only a token of the link this address names.
    req.url = `/w/sheet/${item.sheet}`
    ;(req as GuestBound).guestLink = id
    return sheetRoute.upgrade!(req, socket, head, ctx, /.*/.exec(req.url)!)
  }
  const doc = item.doc
  ctx.wss.handleUpgrade(req, socket, head, (ws) => {
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    // The guest's editor says the document schema it knows in its socket's address: carried through, and nothing
    // else of the address (work-kit's schema gate; a guest that says none knows 0 and is refused a styled document).
    const known = knownSchema(new URL(req.url ?? '/', 'http://localhost').searchParams.get(SCHEMA_PARAM))
    const accepted = ctx.collab.accept(ws, new Request(`http://localhost/w/doc/${encodeURIComponent(doc)}${known > 0 ? `?${SCHEMA_PARAM}=${known}` : ''}`, { headers }), { doc })
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      accepted.message(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    })
    ws.on('close', (code: number, reason: Buffer) => {
      accepted.close(code, reason.toString())
      // What an edit link's guest wrote is a version of its own (M19's `guest-end`); nothing written cuts nothing.
      if (link.role === 'edit' && cutDue(`${doc}|${id}`)) void ctx.history.cut(doc, 'guest-end').catch((err: Error) => ctx.log(`[guests] ${doc}: the guest-end version was not cut: ${err.message}`))
    })
    ws.on('error', () => ws.terminate())
  })
}

export const guestsRoute: PublicRoute = {
  name: 'guest links',
  milestone: 31,
  match: /^\/g(\/.*)?$/,
  async http(req, res, ctx) {
    if (!LIMITS.requests.take(callerOf(req))) return json(res, 429, { error: 'Too many requests from here. Try again in a minute.' })
    const path = new URL(req.url ?? '/', 'http://service').pathname
    if (PAGE.test(path)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'read only')
      return sendPage(req, res, ctx)
    }
    const m = ACTION.exec(path)
    if (!m) return sendText(res, 404, 'not found')
    const [, id, what] = m as unknown as [string, string, 'open' | 'item' | 'threads' | 'comment']
    if (what === 'threads' ? req.method !== 'GET' : req.method !== 'POST') return sendText(res, 405, what === 'threads' ? 'GET only' : 'POST only')
    // A body from a page of another origin is refused: the guest's page is this origin's.
    const origin = req.headers.origin
    if (what !== 'threads' && typeof origin === 'string' && origin !== 'null' && hostOf(origin) !== req.headers.host) return json(res, 403, { error: 'refused' })
    if (what === 'open') return open(req, res, ctx, id)
    if (what === 'item') return item(req, res, ctx, id)
    if (what === 'threads') return threads(req, res, ctx, id)
    return comment(req, res, ctx, id)
  },
  upgrade(req, socket, head, ctx) {
    const path = (req.url ?? '').split('?')[0]
    const m = SOCKET.exec(path)
    if (!m) return refuseUpgrade(socket, 404, 'not found')
    if (!LIMITS.requests.take(callerOf(req))) return refuseUpgrade(socket, 503, 'too many requests')
    upgrade(req, socket, head, ctx, m[1]!, m[2])
  }
}
