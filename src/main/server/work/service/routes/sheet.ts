import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import { createCollabVerifier, type VerifiedClaims } from 'work-kit/collab-server'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { PASS_PREFIX, type GuestServiceLink } from '../../guests/wire'
import { refKey } from '../../sheets/host/host'
import { guestCells, refusal } from '../../sheets/host/live'
import type { SheetRef } from '../../sheets/host/wire'
import { Bucket, Buckets } from './budget'
import { hostOf } from './internalSheet'
import { refuseUpgrade, type PublicRoute, type RouteCtx } from './route'
import { noteWrote } from './seen'
import { broadcast, dropPresence, hears, peopleOn, rooms, selectionOf, setPresence } from './sheetRooms'

/**
 * `wss …/w/sheet/<sheetId>`: one LifeOS sheet live for every client on it
 * (architecture §7, §8.1; docs/agents/work-sheets.md "Live editing"). Not Yjs:
 * Univer's mutations address rows by index, so the service orders ops itself,
 * and each client keeps its own unanswered edits apart from that order
 * (work-kit/sheet/collab, the client half).
 *
 *   client → `{t: 'hello', token, cid?, since?, snapshot?}`   first, within 10 s; again on the same socket to resync
 *   server → `{t: 'state', rev, mark, last?, ops?, snapshot?}` the ops after `since` when they can be given, the whole
 *                                                              workbook (Univer's JSON) when asked or when they cannot
 *   client → `{t: 'ops', id, baseRev, mutations}`
 *   server → `{t: 'ack', id, rev}` or `{t: 'refused', id, reason}`
 *   server → `{t: 'ops', rev, by, mutations, own?}`            everyone's ops; `own` is the batch id on the sender's socket
 *   client → `{t: 'presence', sheet, range}` (range null: none)
 *   server → `{t: 'presence', id, name, hue, sheet, range}`, `{t: 'left', id}`   to everyone else on the sheet
 *
 * `cid` is a random id the page keeps with its unsent edits; `mark` is this run's start mark. A batch is known by
 * its sender, its `cid` and its id: sent again after a dropped line, it is acknowledged again and not applied twice,
 * and `last` says the newest of a client's batches that landed. After a restart that memory is gone, which the page
 * reads from a new `mark`. A page that sends no `cid` (one built before this) is answered as it was: `state` with
 * the workbook.
 *
 * The token is a collab token naming this sheet (`sheet` claim), checked on
 * hello and then once a second: an expired one closes 4401, a revoked guest
 * link 4403, and so does a project link's sheet that left the project. A view link writes nothing; a guest's ops pass `GUEST_OPS`. An
 * edit made on an older revision is moved through what it missed (work-kit's
 * `moveThrough`), or refused in words when it cannot be. A link has a budget
 * over time (600 sends a minute, 20 MiB an hour): past it a batch is refused.
 * A presence is said at most ten times a second a socket, under the service's
 * name and hue for whoever holds the token.
 *
 * A sheet kept as a file (`.tcsheet`) is live here too, for the owner's hosted
 * editor (the phone) and for a guest link to that file: main names the file in
 * the pass it made for his ticket, or in the link (`sheetFile`, guests/links.ts),
 * under a name with no path in it. Only the owner's own token for that name opens
 * it while a pass of his stands, and only a guest's token of the link that names
 * the file while that link stands.
 */

const SHEET = /^\/w\/sheet\/([A-Za-z0-9]{1,64})$/
const HELLO_MS = 10_000
const MAX_MESSAGE = 4 * 1024 * 1024
/** Messages waiting on one socket's lane; past this the client is sending faster than ops can land. */
const MAX_WAITING = 32
/** The most times a minute one socket may ask for the sheet again: a resync is rare, and each may serialize the workbook. */
export const HELLOS_A_MINUTE = 12
/** A selection said more often than this a second is dropped: nobody reads a caret that fast. */
export const PRESENCE_PER_SECOND = 10

/** A guest link's sends over time (budget.ts holds a document's): batches a minute, and their bytes an hour. */
export const SHEET_BUDGET = { sends: 600, bytesAnHour: 20 * 1024 * 1024 }
const SENDS = new Map<string, { n: number; until: number }>()
export const SHEET_BYTES = new Buckets((now) => new Bucket(SHEET_BUDGET.bytesAnHour, SHEET_BUDGET.bytesAnHour / 3_600_000, now))
export const TOO_MANY_EDITS = 'too many edits at once: wait a minute'
/** Whether a link may send one more batch of this size now. */
export function sheetBudget(link: string, bytes: number, now = Date.now()): boolean {
  const w = SENDS.get(link)
  if (!w || w.until <= now) {
    if (SENDS.size > 5000) SENDS.clear()
    SENDS.set(link, { n: 1, until: now + 60_000 })
  } else if (++w.n > SHEET_BUDGET.sends) return false
  return SHEET_BYTES.of(link, now).take(bytes, now) === 0
}
export function clearSheetBudget(): void {
  SENDS.clear()
  SHEET_BYTES.clear()
}

/**
 * Which batches landed on each sheet since this service started, by who sent them (`<principal>|<cid>`): a batch's
 * revision by its id, so one sent again is acknowledged and not applied twice, and each revision's batch, so a
 * client that comes back is told which of the ops it missed were its own. The newest 64 ids a client and 5,000
 * revisions a sheet; a restart forgets it all, and says so with a new start mark.
 */
interface Landed {
  byWho: Map<string, Map<number, number>>
  byRev: Map<number, { who: string; id: number }>
}
const landed = new Map<string, Landed>()
/** The most clients a sheet remembers batches of, and the most sheets remembered. */
export const CLIENTS_KEPT = 500
const SHEETS_KEPT = 500
const landedOn = (key: string): Landed => {
  let l = landed.get(key)
  if (!l) {
    while (landed.size >= SHEETS_KEPT) landed.delete(landed.keys().next().value!)
    landed.set(key, (l = { byWho: new Map(), byRev: new Map() }))
  }
  return l
}
function noteLanded(key: string, who: string, id: number, rev: number): void {
  const l = landedOn(key)
  let ids = l.byWho.get(who)
  if (!ids) l.byWho.set(who, (ids = new Map()))
  ids.set(id, rev)
  while (ids.size > 64) ids.delete(ids.keys().next().value!)
  // A page that makes up a new client id on every socket gains nothing: the oldest clients are let go past a few hundred a sheet.
  while (l.byWho.size > CLIENTS_KEPT) l.byWho.delete(l.byWho.keys().next().value!)
  l.byRev.set(rev, { who, id })
  while (l.byRev.size > 5000) l.byRev.delete(l.byRev.keys().next().value!)
}
/** A batch answered with no op of its own (it moved to nothing: every cell it wrote went with a row someone removed): known by its id alone. */
function noteAnswered(key: string, who: string, id: number, rev: number): void {
  const l = landedOn(key)
  let ids = l.byWho.get(who)
  if (!ids) l.byWho.set(who, (ids = new Map()))
  if (ids.has(id)) return
  ids.set(id, rev)
  while (ids.size > 64) ids.delete(ids.keys().next().value!)
}

/** What a commit carries of the socket whose batch it was (host.ts `Committed.tag`). */
interface Sent {
  ws: WebSocket
  who: string | null
  id: number | string | null
}

let listening: RouteCtx | null = null

function listen(ctx: RouteCtx): void {
  if (listening === ctx) return
  listening = ctx
  hostOf(ctx).onCommit((c) => {
    const sent = c.tag as Sent | undefined
    // Remembered before anyone is told: a line that drops now is answered from this when it comes back.
    if (sent?.who && typeof sent.id === 'number') noteLanded(c.key, sent.who, sent.id, c.rev)
    const op = { t: 'ops', rev: c.rev, by: c.by, mutations: c.mutations }
    broadcast(c.key, JSON.stringify(op), sent && sent.id !== null ? { own: { ws: sent.ws, msg: JSON.stringify({ ...op, own: sent.id }) } } : {})
  })
}

/** The file a pass or a guest link names for a sheet name, while it stands. */
const fileOf = (l: GuestServiceLink | undefined, sheetId: string, now: number): string | null =>
  l && 'sheet' in l.item && l.item.sheet === sheetId && l.expiresAt > now && l.revokedAt === null ? (l.pass?.sheetFile ?? l.guest?.sheetFile ?? null) : null

/** The file a pass of the owner's or a guest link names for this sheet name, while it stands; null for a LifeOS sheet. */
function filedSheet(ctx: RouteCtx, sheetId: string): string | null {
  const now = Date.now()
  for (const l of ctx.links().values()) {
    const file = fileOf(l as GuestServiceLink, sheetId, now)
    if (file) return file
  }
  return null
}

/**
 * Whether a token opens this file now: this host's own token for the owner while a pass of his names the file, or
 * a guest's token while the link it names names the file. A LifeOS token, and a link of another file, open nothing.
 */
export function opensFile(ctx: RouteCtx, sheetId: string, file: string, claims: Pick<VerifiedClaims, 'principal' | 'link' | 'by'>): boolean {
  if (claims.by !== 'host') return false
  const now = Date.now()
  if (claims.principal === 'owner' && !claims.link) return [...ctx.links()].some(([id, l]) => id.startsWith(PASS_PREFIX) && fileOf(l as GuestServiceLink, sheetId, now) === file)
  if (!claims.link || claims.principal !== `guest:${claims.link}`) return false
  const l = ctx.links().get(claims.link) as GuestServiceLink | undefined
  return !!l?.guest && fileOf(l, sheetId, now) === file
}

function live(claims: VerifiedClaims, ctx: RouteCtx): { code: number; reason: string } | null {
  // `exp` is in milliseconds already (the verifier answers it so).
  if (claims.exp <= Date.now()) return { code: 4401, reason: 'the token ran out' }
  // A guest link's token: the link still stands, and a project's link still lists this sheet.
  if (!ctx.claimLive(claims)) return { code: 4403, reason: 'the link was revoked' }
  return null
}

export const sheetRoute: PublicRoute = {
  name: 'live sheets',
  milestone: 27,
  match: /^\/w\/sheet(\/.*)?$/,
  http: (_req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket', 'Cache-Control': 'no-store' })
    res.end('a live sheet is a socket')
  },
  upgrade(req, socket, head, ctx) {
    const m = SHEET.exec((req.url ?? '').split('?')[0])
    if (!m) return refuseUpgrade(socket, 404, 'no such sheet')
    const sheetId = m[1]
    const file = filedSheet(ctx, sheetId)
    if (!file && !ctx.config().lifeos.here) return refuseUpgrade(socket, 503, 'this host does not serve LifeOS sheets')
    listen(ctx)
    const host = hostOf(ctx)
    const ref: SheetRef = file ? { tcsheet: file } : { lifeos: sheetId }
    const key = refKey(ref)
    const verifier = createCollabVerifier(() => ctx.config().trusted)
    ctx.wss.handleUpgrade(req, socket, head, (ws) => {
      let claims: VerifiedClaims | null = null
      /** who this socket's batches are known by across a dropped line; null for a page that says no `cid` */
      let who: string | null = null
      const presenceId = randomBytes(6).toString('base64url')
      let said = { at: 0, n: 0 }
      let asked = { at: 0, n: 0 }
      let lane = Promise.resolve()
      let waiting = 0
      const close = (code: number, reason: string): void => {
        ws.close(code, reason)
      }
      const hello = setTimeout(() => close(4401, 'no token'), HELLO_MS)
      const sweep = setInterval(() => {
        const gone = claims && live(claims, ctx)
        if (gone) close(gone.code, gone.reason)
        // A file's socket lasts as long as the pass or the link that named the file to this token.
        else if (file && (claims ? !opensFile(ctx, sheetId, file, claims) : filedSheet(ctx, sheetId) !== file)) close(4403, 'this page ran out')
      }, 1000)
      const leave = (): void => {
        clearTimeout(hello)
        clearInterval(sweep)
        rooms.get(key)?.delete(ws)
        dropPresence(key, presenceId)
      }
      ws.on('close', leave)
      ws.on('error', () => ws.terminate())
      /** The one frame a client is answered as it joins, comes back or asks again: in the room before anything else can land. */
      const sendState = async (msg: { cid?: unknown; since?: unknown; snapshot?: unknown }): Promise<void> => {
        const since = typeof msg.since === 'number' && Number.isInteger(msg.since) && msg.since >= 0 ? msg.since : undefined
        // A page that names no client id is one built before this wire: the workbook, as it always got.
        const got = await host.catchUp(ref, { ...(who !== null && since !== undefined ? { since } : {}), snapshot: who === null || msg.snapshot !== false || since === undefined })
        if (ws.readyState !== ws.OPEN) return
        if (!rooms.has(key)) rooms.set(key, new Set())
        const joining = !rooms.get(key)!.has(ws)
        rooms.get(key)!.add(ws)
        const l = who !== null ? landedOn(key) : null
        const mine = who !== null ? l!.byWho.get(who) : undefined
        const last = mine?.size ? [...mine].reduce((a, b) => (b[0] > a[0] ? b : a)) : undefined
        ws.send(
          JSON.stringify({
            t: 'state',
            rev: got.rev,
            mark: ctx.mark,
            ...(last ? { last: { id: last[0], rev: last[1] } } : {}),
            ...(got.ops ? { ops: got.ops.map((op) => (l!.byRev.get(op.rev)?.who === who ? { ...op, own: l!.byRev.get(op.rev)!.id } : op)) } : {}),
            ...(got.json !== undefined ? { snapshot: got.json } : {})
          })
        )
        // Who is on the sheet already, to one who just came.
        if (joining) for (const person of peopleOn(key)) ws.send(JSON.stringify({ t: 'presence', ...person }))
      }
      ws.on('message', (data: Buffer, binary: boolean) => {
        if (binary || data.length > MAX_MESSAGE) return close(1009, 'a message is JSON text under 4 MiB')
        let msg: { t?: unknown; token?: unknown; id?: unknown; baseRev?: unknown; mutations?: unknown; cid?: unknown; since?: unknown; snapshot?: unknown; sheet?: unknown; range?: unknown }
        try {
          msg = JSON.parse(data.toString('utf8')) as typeof msg
        } catch {
          return close(1007, 'not JSON')
        }
        // Only an object with a kind is a message: anything else (`null`, a number, a list) would throw outside the lane and take the service down.
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return close(1007, 'a message is an object with its kind')
        // A selection is said outside the lane and counts nothing against it: it changes no sheet, and is dropped past ten a second.
        if (msg.t === 'presence') {
          if (!claims) return
          // The link as it stands now: a guest whose link went says nothing more, under any name.
          const gone = live(claims, ctx) ?? (file && !opensFile(ctx, sheetId, file, claims) ? { code: 4403, reason: 'this page ran out' } : null)
          if (gone) return close(gone.code, gone.reason)
          const now = Date.now()
          if (now - said.at >= 1000) said = { at: now, n: 0 }
          if (++said.n > PRESENCE_PER_SECOND) return
          const at = msg.range === null ? null : selectionOf(msg.sheet, msg.range)
          if (!at) return void dropPresence(key, presenceId, ws)
          const guest = claims.link ? (ctx.links().get(claims.link) as GuestServiceLink | undefined)?.guest : undefined
          // A guest's token whose link holds no guest now is said under no name at all: never the owner's.
          if (claims.principal.startsWith('guest:') && !guest) return
          // The name is the service's: the link's for a guest, the owner's for him, never what a page says.
          setPresence(key, presenceId, { principal: claims.principal, name: guest ? guest.name : (ctx.config().owner ?? 'The owner') }, at, ws)
          return
        }
        if (++waiting > MAX_WAITING) return close(1008, 'too many messages at once')
        lane = lane.then(async () => {
          if (!claims) {
            if (msg.t !== 'hello' || typeof msg.token !== 'string') return close(4401, 'say hello with a token first')
            try {
              const got = await verifier.verify(msg.token)
              if (got.sheet !== sheetId) return close(4403, 'the token names another sheet')
              // A file is his, and a guest's only through the link he made for it: never LifeOS's token, never another link's.
              if (file && !opensFile(ctx, sheetId, file, got)) return close(4403, 'only the owner or its link opens a file')
              // Reached through a guest link's address: only that link's token opens it.
              const bound = (req as { guestLink?: string }).guestLink
              if (bound && got.link !== bound) return close(4403, 'the token is another link\'s')
              // And a link's token opens nothing here reached directly: on its own address its sockets are counted and its link named.
              if (!bound && got.link) return close(4403, 'a link\'s token opens its own address')
              const gone = live(got, ctx)
              if (gone) return close(gone.code, gone.reason)
              claims = got
            } catch (err) {
              return close(4401, err instanceof Error ? err.message.slice(0, 100) : 'the token was refused')
            }
            clearTimeout(hello)
            const mine = claims
            if (typeof msg.cid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(msg.cid)) who = `${mine.principal}|${msg.cid}`
            hears.set(ws, () => !live(mine, ctx) && (!file || opensFile(ctx, sheetId, file, mine)))
            return sendState(msg)
          }
          // The link as it stands now, not at hello: what was queued before a revoke, a new address or a role change lands nowhere and reads nothing.
          const gone = live(claims, ctx) ?? (file && !opensFile(ctx, sheetId, file, claims) ? { code: 4403, reason: 'this page ran out' } : null)
          if (gone) return close(gone.code, gone.reason)
          // A hello again on the same socket: the client asks for the sheet as it stands (a resync).
          if (msg.t === 'hello') {
            const now = Date.now()
            if (now - asked.at >= 60_000) asked = { at: now, n: 0 }
            if (++asked.n > HELLOS_A_MINUTE) return close(1008, 'the sheet was asked for too often')
            return sendState(msg)
          }
          if (msg.t !== 'ops') return
          // A batch still waiting when its socket closed is dropped: the page that comes back is told it never landed, and sends it again.
          if (ws.readyState !== ws.OPEN) return
          const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null
          const mutations = msg.mutations as SheetMutationJson[]
          const guest = claims.principal.startsWith('guest:')
          const why = refusal(mutations, claims.role, guest)
          if (why || typeof msg.baseRev !== 'number') return ws.send(JSON.stringify({ t: 'refused', id, reason: why ?? 'baseRev is missing' }))
          // A batch this client already sent and that landed (its line dropped before the answer): acknowledged again, applied once.
          const before = who !== null && typeof id === 'number' ? landedOn(key).byWho.get(who)?.get(id) : undefined
          if (before !== undefined) return ws.send(JSON.stringify({ t: 'ack', id, rev: before }))
          if (guest && claims.link && !sheetBudget(claims.link, data.length)) return ws.send(JSON.stringify({ t: 'refused', id, reason: TOO_MANY_EDITS }))
          // The host moves an edit made on an older revision through what it missed.
          let got: Awaited<ReturnType<typeof host.apply>>
          try {
            got = await host.apply(ref, msg.baseRev, guest ? guestCells(mutations) : mutations, claims.principal, { ws, who, id } satisfies Sent)
          } catch (err) {
            // An op the engine cannot apply is refused and never stored (host.ts commit).
            return ws.send(JSON.stringify({ t: 'refused', id, reason: err instanceof Error ? err.message.slice(0, 300) : 'refused' }))
          }
          if ('conflict' in got) return ws.send(JSON.stringify({ t: 'refused', id, reason: 'the sheet changed under that edit: reload and make it again' }))
          // A guest's batch landed: main tells the owner of a day's edits (guests/tells.ts).
          if (claims.link && guest) noteWrote(claims.link)
          if (who !== null && typeof id === 'number') noteAnswered(key, who, id, got.rev)
          ws.send(JSON.stringify({ t: 'ack', id, rev: got.rev }))
        }).finally(() => waiting--).catch((err: Error) => {
          ctx.log(`[sheet] ${sheetId}: ${err.message}`)
          close(1011, 'the sheet could not be served')
        })
      })
    })
  }
}
