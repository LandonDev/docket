import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { createCollabVerifier, type VerifiedClaims } from 'work-kit/collab-server'
import { DOCUMENT_FRAGMENT, findQuote, knownSchema, SCHEMA_PARAM, setThreadMark } from 'work-kit/collab'
import { projectionLists } from '../../../../../shared/work/guestProjection'
import { ensureDocUid, fileUid } from '../../guests/fileIdent'
import type { GuestServiceLink } from '../../guests/wire'
import { encodeStateAsUpdate } from 'yjs'
import { BUDGET, Bucket, Buckets, CLOSE_FULL, CLOSE_TOO_MUCH, tooMuchWords } from './budget'
import { HOSTED_CSP } from './hosted'
import { hostOf as sheetHost } from './internalSheet'
import { BASE_HEADERS, refuseUpgrade, RouteError, sendText, type InternalRoute, type PublicRoute, type RouteCtx } from './route'
import { noteOpened, noteSockets, noteWrote, seen } from './seen'
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
 * A start is not an end. Until main has sent its links since this service
 * started (`ctx.settled()`), nothing here can tell a link that ended from one
 * main has not named yet: every route that would answer "gone" answers 503
 * `{error: 'starting'}` instead, counts no failed secret, and the page tries
 * again. Once main has spoken, a link that is not in its list is gone at once.
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

/** Bytes each link's document sockets may send (budget.ts): one bucket a link, whatever sockets it holds. */
export const DOC_BYTES = new Buckets((now) => new Bucket(BUDGET.bytes, BUDGET.bytesPerMinute / 60_000, now))

/** A live document's size as its state, measured at most every ten seconds a document: what a guest may not grow past `BUDGET.docBytes`. */
const sizes = new Map<string, { at: number; bytes: number }>()
function docBytes(ctx: RouteCtx, doc: string, now = Date.now()): number {
  const held = sizes.get(doc)
  if (held && now - held.at < 10_000) return held.bytes
  const live = ctx.collab.hocuspocus.documents.get(doc)
  const bytes = live ? encodeStateAsUpdate(live).byteLength : 0
  if (sizes.size > 2000) sizes.clear()
  sizes.set(doc, { at: now, bytes })
  return bytes
}

/**
 * Whether a frame of the collaboration wire adds to the document: a change, or a sync answer that carries one
 * (after the document's name: kind 0 or 4, then 1 or 2, then the update, which is two bytes when it holds nothing).
 */
export function addsContent(bytes: Uint8Array): boolean {
  let at = 0
  const varUint = (): number | null => {
    let n = 0
    for (let shift = 0; at < bytes.length && shift < 35; shift += 7) {
      const b = bytes[at++]!
      n |= (b & 0x7f) << shift
      if (b < 0x80) return n >>> 0
    }
    return null
  }
  const name = varUint()
  if (name === null) return false
  at += name
  // Sync (0) and its reply (4) both carry a change: Hocuspocus applies either.
  const kind = varUint()
  if (kind !== 0 && kind !== 4) return false
  const step = varUint()
  if (step !== 1 && step !== 2) return false
  const size = varUint()
  return size !== null && size > 2
}

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

/** Main asks it for the audit list: when each link was last opened and how many sockets it holds. */
export const internalGuestRoutes: InternalRoute[] = [
  { path: '/internal/guests/seen', milestone: 31, run: async () => ({ seen: Object.fromEntries(seen) }) },
  {
    // The id a `.tcdoc` or `.tcsheet` carries inside it, made here when it has none: this process is the file's one
    // writer (guests/fileIdent.ts). A sheet is named as its workbook is, by the spelling main gives, in its own lane.
    path: '/internal/guests/ident',
    milestone: 31,
    async run(body, ctx) {
      const path = body.path
      if (typeof path !== 'string' || !isAbsolute(path) || !/\.tc(doc|sheet)$/i.test(path)) throw new RouteError(400, 'path is an absolute .tcdoc or .tcsheet')
      if (!existsSync(path)) throw new RouteError(404, 'there is no file there')
      return { uid: /\.tcsheet$/i.test(path) ? await sheetHost(ctx).ident({ tcsheet: path }) : ensureDocUid(path) }
    }
  }
]

// ── helpers ────────────────────────────────────────────────────────────

const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()
const sameHash = (secret: string, hex: string): boolean => {
  const want = Buffer.from(hex, 'hex')
  const got = sha(secret)
  return want.length === got.length && timingSafeEqual(got, want)
}

/** A sheet socket reached through a guest link's own address: the sheet route takes only that link's token on it. */
export type GuestBound = IncomingMessage & { guestLink?: string }

/**
 * A live guest link by id, or null (a ticket's pass is never one). A file's link is live only while the file at its
 * path is the one he shared (guests/fileIdent.ts): another file put there opens for nobody, from the first request.
 */
export function guestLink(ctx: RouteCtx, id: string, now = Date.now()): (GuestServiceLink & { guest: NonNullable<GuestServiceLink['guest']> }) | null {
  const l = ctx.links().get(id) as GuestServiceLink | undefined
  if (!l?.guest || l.revokedAt !== null || l.expiresAt <= now) return null
  if (l.guest.file && fileUid(l.guest.file.path) !== l.guest.file.uid) return null
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

/**
 * Once guest pages have an origin of their own (docs/agents/work-guests.md "The guest origin"), they are served
 * there alone: the origin a request reached us on that is not it, or null. A page asked for elsewhere is sent on
 * (308: an address already handed out keeps opening, and a browser carries its fragment across), and nothing else
 * of a guest's answers there.
 */
export function elsewhere(req: IncomingMessage, ctx: RouteCtx): string | null {
  const guest = ctx.origins().guest
  if (!guest) return null
  const host = req.headers.host
  return typeof host === 'string' && host.toLowerCase() !== hostOf(guest) ? guest : null
}

/** 308 to the same path on the guest pages' origin. */
export function sendOn(res: ServerResponse, origin: string, path: string): void {
  res.writeHead(308, { ...BASE_HEADERS, Location: `${origin}${path}` })
  res.end()
}

/** What a route answers (503) while main has not named its links since this service started. */
export const STARTING = { error: 'starting' } as const

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
  noteOpened(id)
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
    ...('doc' in link.item ? { doc: link.item.doc } : {}),
    // A document kept as a file keeps its comments where the page cannot reach them: the page draws none.
    ...(link.guest.comments === false ? { comments: false } : {})
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

/** Whether a live document holds these words on one line; a document kept as a file is opened as that file. */
async function quoteIn(ctx: RouteCtx, doc: string, quote: string, file?: { path: string }): Promise<boolean> {
  if (!file) return ctx.collab.hasQuote(doc, quote)
  let found = false
  await ctx.collab.edit(doc, 'owner', (d) => void (found = findQuote(d.getXmlFragment(DOCUMENT_FRAGMENT), quote) !== null), { path: file.path })
  return found
}

/** A thread's mark put on those words as `principal` (the service's write for a guest who may not write the text). */
async function markIn(ctx: RouteCtx, doc: string, principal: string, quote: string, threadId: string, file?: { path: string }): Promise<boolean> {
  if (!file) return ctx.collab.markThread(doc, principal, quote, threadId)
  let marked = false
  await ctx.collab.edit(
    doc,
    principal,
    (d) => {
      const fragment = d.getXmlFragment(DOCUMENT_FRAGMENT)
      d.transact(() => {
        const range = findQuote(fragment, quote)
        marked = !!range && setThreadMark(fragment, range, threadId)
      })
    },
    { path: file.path }
  )
  return marked
}

/** What main answered about a file document, as the route's answer: its words when it refused, 503 when it could not be asked. */
async function askMain(res: ServerResponse, ctx: RouteCtx, ask: Parameters<NonNullable<RouteCtx['guestAsk']>>[0]): Promise<unknown | undefined> {
  if (!ctx.guestAsk) return void json(res, 503, { error: 'This page cannot be reached right now.' })
  try {
    return await ctx.guestAsk(ask)
  } catch (err) {
    const words = err instanceof Error ? err.message : ''
    if (words === 'gone') return void json(res, 403, { error: 'gone' })
    if (words === 'That comment is gone.') return void json(res, 404, { error: words })
    if (words === 'This link can view, not comment.') return void json(res, 403, { error: words })
    ctx.log(`[guests] a file document's comments: ${words}`)
    return void json(res, 503, { error: 'This page cannot be reached right now.' })
  }
}

async function threads(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, id: string): Promise<void> {
  const got = await bearer(req, ctx, id)
  if (!got || !('doc' in got.link.item)) return json(res, 403, { error: 'gone' })
  // A document kept as a file: its comments are rows only main holds (guests/comments.ts).
  if (got.link.item.doc.startsWith('file:')) {
    const answer = await askMain(res, ctx, { what: 'threads', linkId: id })
    return answer === undefined ? undefined : json(res, 200, answer)
  }
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
  const docId = got.link.item.doc
  const author = `guest:${id}`
  const file = docId.startsWith('file:')
  // Asked again right before anything is written: a link revoked, ended, given a new address or a new role while the body was read writes nothing.
  const stands = (): boolean => {
    const now = guestLink(ctx, id)
    return !!now && now.role !== 'view' && now.role === got.link.role && ctx.claimLive(got.claims)
  }
  if (!file && !ctx.config().lifeos.here) return json(res, 503, { error: 'This page cannot be reached right now.' })
  if (typeof body?.threadId === 'string') {
    if (!stands()) return json(res, 403, { error: 'gone' })
    if (file) {
      const made = await askMain(res, ctx, { what: 'comment', linkId: id, body: plainBody(text), threadId: body.threadId.slice(0, 64) })
      return made === undefined ? undefined : json(res, 200, made)
    }
    // A reply goes only on a thread of this document.
    const rows = (await ctx.convex('query', 'docs:threads', { docId })) as LifeosThread[]
    const thread = rows.find((r) => r.thread._id === body.threadId && !r.thread.deletedAt)
    if (!thread) return json(res, 404, { error: 'That comment is gone.' })
    if (!stands()) return json(res, 403, { error: 'gone' })
    const made = (await ctx.convex('mutation', 'docs:addComment', { threadId: thread.thread._id, body: plainBody(text), author })) as string | { commentId: string }
    return json(res, 200, { commentId: typeof made === 'string' ? made : made.commentId })
  }
  const quote = typeof body?.quote === 'string' ? body.quote : ''
  if (!quote || quote.length > 2000) return json(res, 400, { error: 'Pick the words the comment is about.' })
  // The words are looked for in the live document; a file's is opened as its file (the link's own, by its resolved path).
  const at = file ? got.link.guest.file : undefined
  if (file && !at) return json(res, 503, { error: 'This page cannot be reached right now.' })
  if (!(await quoteIn(ctx, docId, quote, at).catch(() => false))) return json(res, 400, { error: 'Those words are no longer in the document.' })
  if (!stands()) return json(res, 403, { error: 'gone' })
  let threadId: string
  if (file) {
    const made = (await askMain(res, ctx, { what: 'comment', linkId: id, body: plainBody(text), quote })) as { threadId: string } | undefined
    if (made === undefined) return
    threadId = made.threadId
  } else threadId = ((await ctx.convex('mutation', 'docs:createThread', { docId, body: plainBody(text), quote, author })) as { threadId: string }).threadId
  // The guest may not write the document, so the service marks the words; an edit link's editor marks them itself.
  if (got.link.role === 'comment' && !(await markIn(ctx, docId, author, quote, threadId, at).catch(() => false))) ctx.log(`[guests] ${docId}: thread ${threadId} was made but its words could not be marked`)
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
  // A link holds a few sockets at a time, and none while it waits out what it overdrew (budget.ts).
  if ((seen.get(id)?.open ?? 0) >= BUDGET.sockets) return refuseUpgrade(socket, 429, 'too many pages are open on this link')
  if (DOC_BYTES.of(id).held() > 0) return refuseUpgrade(socket, 429, 'too much at once: wait a minute')
  noteSockets(id, 1)
  socket.once('close', () => noteSockets(id, -1))
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
    const accepted = ctx.collab.accept(ws, new Request(`http://localhost/w/doc/${encodeURIComponent(doc)}${known > 0 ? `?${SCHEMA_PARAM}=${known}` : ''}`, { headers }), { doc, link: id })
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      const frame = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      // The link's budget, before the document sees the frame: one over it is not passed on, and the page is told how long to wait.
      const wait = DOC_BYTES.of(id).take(frame.byteLength)
      if (wait > 0) return ws.close(CLOSE_TOO_MUCH, tooMuchWords(wait))
      // A guest adds nothing to a document that is as large as a guest may make it; reading it, and the owner's own edits, go on.
      const adds = link.role === 'edit' && addsContent(frame)
      if (adds && docBytes(ctx, doc) > BUDGET.docBytes) return ws.close(CLOSE_FULL, 'the document is as large as a guest can make it')
      if (adds) noteWrote(id)
      accepted.message(frame)
    })
    ws.on('close', (code: number, reason: Buffer) => {
      accepted.close(code, reason.toString())
      ctx.docLeft(doc)
      // What an edit link's guest wrote is a version of its own (M19's `guest-end`); nothing written cuts nothing.
      // A file's document is cut by its file: the name alone opens no file (work-kit `fileFits`).
      const file = link.guest?.file ? { file: { path: link.guest.file.path } } : undefined
      if (link.role === 'edit' && cutDue(`${doc}|${id}`)) void ctx.history.cut(doc, 'guest-end', file).catch((err: Error) => ctx.log(`[guests] ${doc}: the guest-end version was not cut: ${err.message}`))
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
    const other = elsewhere(req, ctx)
    if (PAGE.test(path)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'read only')
      if (other) return sendOn(res, other, path)
      return sendPage(req, res, ctx)
    }
    const m = ACTION.exec(path)
    if (!m || other) return sendText(res, 404, 'not found')
    const [, id, what] = m as unknown as [string, string, 'open' | 'item' | 'threads' | 'comment']
    if (what === 'threads' ? req.method !== 'GET' : req.method !== 'POST') return sendText(res, 405, what === 'threads' ? 'GET only' : 'POST only')
    if (!ctx.settled()) return json(res, 503, STARTING)
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
    if (!m || elsewhere(req, ctx)) return refuseUpgrade(socket, 404, 'not found')
    if (!LIMITS.requests.take(callerOf(req))) return refuseUpgrade(socket, 503, 'too many requests')
    if (!ctx.settled()) return refuseUpgrade(socket, 503, 'starting')
    upgrade(req, socket, head, ctx, m[1]!, m[2])
  }
}
