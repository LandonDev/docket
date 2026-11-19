import type { WebSocket } from 'ws'
import { createCollabVerifier, type VerifiedClaims } from 'work-kit/collab-server'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { refKey } from '../../sheets/host/host'
import { moveThrough, refusal } from '../../sheets/host/live'
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
 * link 4403. A view link writes nothing; a guest's ops pass `GUEST_OPS`. An
 * edit made on an older revision is moved through the rows and columns it
 * missed, or refused so the client reloads.
 */

const SHEET = /^\/w\/sheet\/([A-Za-z0-9]{1,64})$/
const HELLO_MS = 10_000
const MAX_MESSAGE = 4 * 1024 * 1024

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
    for (const ws of room) ws.send(msg)
  })
}

function live(claims: VerifiedClaims, ctx: RouteCtx): { code: number; reason: string } | null {
  if (claims.exp * 1000 <= Date.now()) return { code: 4401, reason: 'the token ran out' }
  if (claims.link) {
    const link = ctx.links().get(claims.link)
    if (!link || link.revokedAt || (link.expiresAt && link.expiresAt <= Date.now())) return { code: 4403, reason: 'the link was revoked' }
  }
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
    if (!ctx.config().lifeos.here) return refuseUpgrade(socket, 503, 'this host does not serve LifeOS sheets')
    listen(ctx)
    const host = hostOf(ctx)
    const ref = { lifeos: sheetId }
    const key = refKey(ref)
    const verifier = createCollabVerifier(() => ctx.config().trusted)
    ctx.wss.handleUpgrade(req, socket, head, (ws) => {
      let claims: VerifiedClaims | null = null
      let lane = Promise.resolve()
      const close = (code: number, reason: string): void => {
        ws.close(code, reason)
      }
      const hello = setTimeout(() => close(4401, 'no token'), HELLO_MS)
      const sweep = setInterval(() => {
        const gone = claims && live(claims, ctx)
        if (gone) close(gone.code, gone.reason)
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
        lane = lane.then(async () => {
          if (!claims) {
            if (msg.t !== 'hello' || typeof msg.token !== 'string') return close(4401, 'say hello with a token first')
            try {
              const got = await verifier.verify(msg.token)
              if (got.sheet !== sheetId) return close(4403, 'the token names another sheet')
              const gone = live(got, ctx)
              if (gone) return close(gone.code, gone.reason)
              claims = got
            } catch (err) {
              return close(4401, err instanceof Error ? err.message.slice(0, 100) : 'the token was refused')
            }
            clearTimeout(hello)
            const state = await host.snapshot(ref)
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
          let base = msg.baseRev
          let ops = mutations
          for (let tries = 0; tries < 3; tries++) {
            const got = await host.apply(ref, base, ops, claims.principal)
            if (!('conflict' in got)) return ws.send(JSON.stringify({ t: 'ack', id, rev: got.rev }))
            const since = await host.since(ref, base)
            const moved = 'reload' in since ? null : moveThrough(ops, since.ops.flatMap((o) => o.mutations))
            if (!moved) return ws.send(JSON.stringify({ t: 'refused', id, reason: 'the sheet changed under that edit: reload and make it again' }))
            ops = moved
            base = since.rev
          }
          ws.send(JSON.stringify({ t: 'refused', id, reason: 'the sheet is busy: try again' }))
        }).catch((err: Error) => {
          ctx.log(`[sheet] ${sheetId}: ${err.message}`)
          close(1011, 'the sheet could not be served')
        })
      })
    })
  }
}
