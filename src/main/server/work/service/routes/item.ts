import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PASS_PREFIX, type GuestServiceLink } from '../../guests/wire'
import { callerOf, json, LIMITS, readJson, sendPage } from './guests'
import { sendText, type PublicRoute, type RouteCtx } from './route'

/**
 * `GET …/w/open#t=<ticket>`: the owner's own hosted editor, the page the
 * phone opens (architecture §8.1, §8.6; docs/agents/work-guests.md "The
 * owner's hosted editor"). Main makes a ticket for one item (`work.guests.ticket`):
 * single use, two minutes, in the fragment so no request or log holds it.
 * The page trades it once for a token and a renewal key this process makes
 * and keeps only in memory; the key renews the token while main keeps the
 * pass (eight hours), and a restart of the service ends it.
 *
 *   POST /w/open/redeem  {ticket} → the item, a token and `renew`
 *   POST /w/open/renew   {renew}  → a fresh token
 */

type Pass = GuestServiceLink & { pass: NonNullable<GuestServiceLink['pass']> }

const used = new Set<string>()
/** When this process started: a ticket main made before then may have been used by the process before, so it opens nothing. */
const STARTED = Date.now()
const renewals = new Map<string, string>()

const hashOf = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

function passes(ctx: RouteCtx): Pass[] {
  const out: Pass[] = []
  for (const [id, l] of ctx.links()) if (id.startsWith(PASS_PREFIX) && (l as GuestServiceLink).pass && l.expiresAt > Date.now()) out.push(l as Pass)
  return out
}

function answer(res: ServerResponse, p: Pass, extra: Record<string, unknown> = {}): void {
  json(res, 200, {
    kind: 'doc' in p.item ? 'doc' : 'sheet',
    role: 'edit',
    title: p.pass.title,
    me: 'owner',
    token: p.pass.token,
    tokenExp: p.pass.tokenExp,
    expiresAt: p.expiresAt,
    ...('doc' in p.item ? { doc: p.item.doc } : { sheet: p.item.sheet }),
    ...extra
  })
}

async function redeem(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): Promise<void> {
  const caller = callerOf(req)
  if (LIMITS.failures.over(caller)) return json(res, 429, { error: 'Too many tries from here. Try again in a few minutes.' })
  const body = await readJson(req)
  const ticket = typeof body?.ticket === 'string' && body.ticket.length <= 100 ? body.ticket : ''
  const got = ticket ? hashOf(ticket) : null
  const now = Date.now()
  const p = got ? passes(ctx).find((x) => { const want = Buffer.from(x.pass.ticketHash, 'hex'); return want.length === got.length && timingSafeEqual(want, got) }) : undefined
  if (!p || p.pass.ticketUntil <= now || p.pass.issuedAt < STARTED || used.has(p.linkId)) {
    LIMITS.failures.take(caller)
    return json(res, 403, { error: 'This page has already been opened, or it ran out. Open it again from TempCode.' })
  }
  for (const u of used) if (!ctx.links().has(u)) used.delete(u)
  used.add(p.linkId)
  const renew = randomBytes(32).toString('base64url')
  renewals.set(hashOf(renew).toString('hex'), p.linkId)
  answer(res, p, { renew })
}

async function renew(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): Promise<void> {
  const caller = callerOf(req)
  if (LIMITS.failures.over(caller)) return json(res, 429, { error: 'Too many tries from here. Try again in a few minutes.' })
  const body = await readJson(req)
  const key = typeof body?.renew === 'string' && body.renew.length <= 100 ? body.renew : ''
  const id = key ? renewals.get(hashOf(key).toString('hex')) : undefined
  const p = id ? passes(ctx).find((x) => x.linkId === id) : undefined
  if (!p) {
    if (id) renewals.delete(hashOf(key).toString('hex'))
    LIMITS.failures.take(caller)
    return json(res, 403, { error: 'This page ran out. Open it again from TempCode.' })
  }
  answer(res, p)
}

export const itemRoute: PublicRoute = {
  name: "the owner's hosted editor",
  milestone: 31,
  match: /^\/w\/open(\/.*)?$/,
  async http(req, res, ctx, m) {
    if (!LIMITS.requests.take(callerOf(req))) return json(res, 429, { error: 'Too many requests from here. Try again in a minute.' })
    const rest = m[1] ?? ''
    if (rest === '' || rest === '/') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'read only')
      return sendPage(req, res, ctx)
    }
    if (req.method !== 'POST') return sendText(res, 405, 'POST only')
    if (rest === '/redeem') return redeem(req, res, ctx)
    if (rest === '/renew') return renew(req, res, ctx)
    sendText(res, 404, 'not found')
  }
}
