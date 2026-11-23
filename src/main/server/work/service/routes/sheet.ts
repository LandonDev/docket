import type { WebSocket } from 'ws'
import { createCollabVerifier, type VerifiedClaims } from 'work-kit/collab-server'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { PASS_PREFIX, type GuestServiceLink } from '../../guests/wire'
import { refKey } from '../../sheets/host/host'
import { guestCells, refusal } from '../../sheets/host/live'
import type { SheetRef } from '../../sheets/host/wire'
import { hostOf } from './internalSheet'
import { refuseUpgrade, type PublicRoute, type RouteCtx } from './route'

/**
 * `wss …/w/sheet/<sheetId>`: one LifeOS sheet live for every client on it
 * (architecture §7, §8.1; docs/agents/work-sheets.md "Live editing"). Not Yjs:
 * Univer's mutations address rows by index, so the service orders ops itself.
 *
 *   client → `{t: 'hello', token}`               first, within 10 s
 *   server → `{t: 'state', rev, snapshot}`       the workbook as Univer's JSON
 *   client → `{t: 'ops', id, baseRev, mutations}`
 *   server → `{t: 'ack', id, rev}` or `{t: 'refused', id, reason}`
 *   server → `{t: 'ops', rev, by, mutations}`    everyone's ops, the sender's own included
 *
 * The token is a collab token naming this sheet (`sheet` claim), checked on
 * hello and then once a second: an expired one closes 4401, a revoked guest
 * link 4403, and so does a project link's sheet that left the project. A view link writes nothing; a guest's ops pass `GUEST_OPS`. An
 * edit made on an older revision is moved through the rows and columns it
 * missed, or refused so the client reloads.
 *
 * A sheet kept as a file (`.tcsheet`) is live here too, for the owner's hosted
 * editor alone (the phone): main names the file in the pass it made for his
 * ticket (`sheetFile`, guests/links.ts), under a name with no path in it, and
 * only the owner's own token for that name opens it, while the pass stands.
 */

const SHEET = /^\/w\/sheet\/([A-Za-z0-9]{1,64})$/
const HELLO_MS = 10_000
const MAX_MESSAGE = 4 * 1024 * 1024
const MAX_BUFFERED = 16 * 1024 * 1024
/** Messages waiting on one socket's lane; past this the client is sending faster than ops can land. */
const MAX_WAITING = 32

/** The sockets on each sheet, by the host's key for it; ops land through the host whoever wrote them. */
const rooms = new Map<string, Set<WebSocket>>()
let listening: RouteCtx | null = null

function listen(ctx: RouteCtx): void {
  if (listening === ctx) return
  listening = ctx
  hostOf(ctx).onCommit((c) => {
    const room = rooms.get(c.key)
    if (!room) return
    const msg = JSON.stringify({ t: 'ops', rev: c.rev, by: c.by, mutations: c.mutations })
    for (const ws of room) {
      // A client that does not read is let go rather than held in the service's memory.
      if (ws.bufferedAmount > MAX_BUFFERED) ws.terminate()
      else ws.send(msg)
    }
  })
}

/** The file a pass of the owner's names for this sheet name, while the pass stands; null for a LifeOS sheet. */
function filedSheet(ctx: RouteCtx, sheetId: string): string | null {
  const now = Date.now()
  for (const [id, l] of ctx.links()) {
    if (!id.startsWith(PASS_PREFIX)) continue
    const p = l as GuestServiceLink
    if (p.pass?.sheetFile && 'sheet' in p.item && p.item.sheet === sheetId && p.expiresAt > now) return p.pass.sheetFile
  }
  return null
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
      let lane = Promise.resolve()
      let waiting = 0
      const close = (code: number, reason: string): void => {
        ws.close(code, reason)
      }
      const hello = setTimeout(() => close(4401, 'no token'), HELLO_MS)
      const sweep = setInterval(() => {
        const gone = claims && live(claims, ctx)
        if (gone) close(gone.code, gone.reason)
        // A file's socket lasts as long as the pass that named the file.
        else if (file && filedSheet(ctx, sheetId) !== file) close(4403, 'this page ran out')
      }, 1000)
      const leave = (): void => {
        clearTimeout(hello)
        clearInterval(sweep)
        rooms.get(key)?.delete(ws)
      }
      ws.on('close', leave)
      ws.on('error', () => ws.terminate())
      ws.on('message', (data: Buffer, binary: boolean) => {
        if (binary || data.length > MAX_MESSAGE) return close(1009, 'a message is JSON text under 4 MiB')
        let msg: { t?: unknown; token?: unknown; id?: unknown; baseRev?: unknown; mutations?: unknown }
        try {
          msg = JSON.parse(data.toString('utf8')) as typeof msg
        } catch {
          return close(1007, 'not JSON')
        }
        if (++waiting > MAX_WAITING) return close(1008, 'too many messages at once')
        lane = lane.then(async () => {
          if (!claims) {
            if (msg.t !== 'hello' || typeof msg.token !== 'string') return close(4401, 'say hello with a token first')
            try {
              const got = await verifier.verify(msg.token)
              if (got.sheet !== sheetId) return close(4403, 'the token names another sheet')
              // A file is its owner's alone: this host's own token for him, never a link's or LifeOS's.
              if (file && (got.principal !== 'owner' || got.link || got.by !== 'host')) return close(4403, 'only the owner opens a file')
              // Reached through a guest link's address: only that link's token opens it.
              const bound = (req as { guestLink?: string }).guestLink
              if (bound && got.link !== bound) return close(4403, 'the token is another link\'s')
              const gone = live(got, ctx)
              if (gone) return close(gone.code, gone.reason)
              claims = got
            } catch (err) {
              return close(4401, err instanceof Error ? err.message.slice(0, 100) : 'the token was refused')
            }
            clearTimeout(hello)
            const state = await host.snapshotJson(ref)
            if (ws.readyState !== ws.OPEN) return
            if (!rooms.has(key)) rooms.set(key, new Set())
            rooms.get(key)!.add(ws)
            ws.send(JSON.stringify({ t: 'state', rev: state.rev, snapshot: state.json }))
            return
          }
          if (msg.t !== 'ops') return
          const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null
          const mutations = msg.mutations as SheetMutationJson[]
          const why = refusal(mutations, claims.role, claims.principal.startsWith('guest:'))
          if (why || typeof msg.baseRev !== 'number') return ws.send(JSON.stringify({ t: 'refused', id, reason: why ?? 'baseRev is missing' }))
          // The host moves an edit made on an older revision through the rows and columns it missed.
          let got: Awaited<ReturnType<typeof host.apply>>
          try {
            got = await host.apply(ref, msg.baseRev, claims.principal.startsWith('guest:') ? guestCells(mutations) : mutations, claims.principal)
          } catch (err) {
            // An op the engine cannot apply is refused and never stored (host.ts commit).
            return ws.send(JSON.stringify({ t: 'refused', id, reason: err instanceof Error ? err.message.slice(0, 300) : 'refused' }))
          }
          if ('conflict' in got) return ws.send(JSON.stringify({ t: 'refused', id, reason: 'the sheet changed under that edit: reload and make it again' }))
          ws.send(JSON.stringify({ t: 'ack', id, rev: got.rev }))
        }).finally(() => waiting--).catch((err: Error) => {
          ctx.log(`[sheet] ${sheetId}: ${err.message}`)
          close(1011, 'the sheet could not be served')
        })
      })
    })
  }
}
