import { subscribe } from 'node:diagnostics_channel'
import type { Principal } from '@shared/capabilities'

/**
 * A window's ticket to a saved host (`remote.environments.ticket`), timed by leg.
 *
 * A window's link to the box asks this host for a 30 s ticket before every socket. That was one `POST /api/ticket`
 * from here, a cold DNS, TCP and TLS setup through the tunnel every time (sockets are minutes apart, past any
 * keep-alive): 16 asks over 500 ms in a day from his Mac, 11 over 1 s, two at the 4 s deadline. One of the sixteen
 * met a 2.6 s block of the box's own loop; the others had nothing on the box's side. So the ask now goes first over
 * the socket this host already holds to that host (the peer link, src/main/server/remote/peers.ts, made with the
 * same saved key), one round trip on a warm socket; HTTPS starts beside it when the peer has not answered in
 * `TICKET_HEDGE_MS`, or at once when it fails, and the first ticket back is the one. Either ticket is the key's
 * own, consumed once and checked against the key again at the upgrade.
 *
 * Every ask writes one `ticket` stall line: `wait=` (the window's wait for its own link to this host), `peer=`, and
 * for HTTPS `connect=` (DNS, TCP and TLS, `reused` on a kept socket), `answer=` (the request out to its headers in:
 * the tunnel and the box), `box=` and `boxloop=` (the box's own handling and its loop's worst lag that second, from
 * its `Server-Timing`).
 */

export type Ticket = { ticket: string; expiresIn: number }

/** The peer has this long to answer before HTTPS starts beside it. A warm round trip to the box is well under it. */
export const TICKET_HEDGE_MS = 500
/** A peer ask still out this long is given up (HTTPS is already running). */
export const PEER_TICKET_TIMEOUT_MS = 4_000

/** What one HTTPS ask learned on its way. */
export type HttpsTiming = { connectMs?: number | 'reused'; answerMs?: number; boxMs?: number; boxLoopMs?: number }

export type TicketLegs = {
  via: 'peer' | 'https' | 'none'
  ms: number
  waitMs?: number
  peerMs?: number | 'fail' | 'late'
  httpsMs?: number | 'fail'
  https?: HttpsTiming
  outcome: string
}

const n = (v: number | string | undefined): string => (v === undefined ? '-' : String(typeof v === 'number' ? Math.round(v) : v))

/** The stall line for one ask. */
export function ticketLine(env: string, legs: TicketLegs): string {
  const h = legs.https ?? {}
  return (
    `ticket env=${env} via=${legs.via} ms=${n(legs.ms)} wait=${n(legs.waitMs)} peer=${n(legs.peerMs)} https=${n(legs.httpsMs)}` +
    ` connect=${n(h.connectMs)} answer=${n(h.answerMs)} box=${n(h.boxMs)} boxloop=${n(h.boxLoopMs)} outcome=${legs.outcome}`
  )
}

/** The outcome word of a failure: the HostError reason (`unavailable`, `unauthorized`), else `error`. */
function outcomeOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const reason = /^([a-z-]+):/.exec(message)?.[1]
  return reason ?? 'error'
}

export type WindowTicketDeps = {
  /** The peer link's ask, or null when no link is up or its host has no `remote.ticket`. */
  peer: () => ((method: string, params: unknown, opts: { timeoutMs: number }) => Promise<unknown>) | null
  /** `POST /api/ticket`, filling `timing` as it goes. */
  https: (timing: HttpsTiming) => Promise<Ticket>
  log: (line: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  hedgeMs?: number
}

const isTicket = (v: unknown): v is Ticket => !!v && typeof (v as Ticket).ticket === 'string'

/** The ticket for `env`, over the peer link first and HTTPS beside it (see the file's note); one line logged. */
export function windowTicket(env: string, waitMs: number | undefined, deps: WindowTicketDeps): Promise<Ticket> {
  const now = deps.now ?? (() => performance.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const started = now()
  const legs: TicketLegs = { via: 'none', ms: 0, ...(waitMs !== undefined ? { waitMs } : {}), outcome: 'ok' }
  const timing: HttpsTiming = {}
  const peerAsk = deps.peer()
  return new Promise<Ticket>((resolve, reject) => {
    let settled = false
    let out = 0
    let httpsOn = false
    let httpsError: unknown = null
    let peerError: unknown = null
    let hedge: unknown = null
    const finish = (err: unknown, ticket?: Ticket): void => {
      if (settled) return
      settled = true
      if (hedge !== null) clearTimer(hedge)
      legs.ms = now() - started
      if (httpsOn) legs.https = timing
      if (err !== null) legs.outcome = outcomeOf(err)
      deps.log(ticketLine(env, legs))
      if (err !== null) reject(err)
      else resolve(ticket!)
    }
    const failed = (): void => {
      if (--out === 0 && (httpsOn || !peerAsk)) finish(httpsError ?? peerError)
    }
    const startHttps = (): void => {
      if (httpsOn || settled) return
      httpsOn = true
      out++
      deps.https(timing).then(
        (ticket) => {
          legs.httpsMs = now() - started
          if (!settled) legs.via = 'https'
          finish(null, ticket)
        },
        (err) => {
          legs.httpsMs = 'fail'
          httpsError = err
          failed()
        }
      )
    }
    if (!peerAsk) return startHttps()
    out++
    hedge = setTimer(() => {
      hedge = null
      startHttps()
    }, deps.hedgeMs ?? TICKET_HEDGE_MS)
    peerAsk('remote.ticket', {}, { timeoutMs: PEER_TICKET_TIMEOUT_MS }).then(
      (answer) => {
        if (!isTicket(answer)) throw new Error('unavailable: the peer sent no ticket')
        legs.peerMs = now() - started
        if (!settled) legs.via = 'peer'
        finish(null, { ticket: answer.ticket, expiresIn: typeof answer.expiresIn === 'number' ? answer.expiresIn : 30 })
      },
    ).catch((err: unknown) => {
      if (settled) {
        legs.peerMs ??= 'late'
        return
      }
      legs.peerMs = 'fail'
      peerError = err
      if (hedge !== null) clearTimer(hedge)
      hedge = null
      startHttps()
      failed()
    })
  })
}

/**
 * The box's side: a ticket for the socket's own key, what `POST /api/ticket` mints for it. Refused to this machine's
 * own sockets (no key), to a cookie session (its caps may be narrower than the key's, and a ticket names the key
 * alone), to a relayed lane (its caps are the carrier's word) and to anything but a client key.
 */
export function socketTicket(
  auth: { mintTicket: (p: Principal & { kind: 'remote' }, provedEnv: undefined, window: true) => Ticket; inFarewell: (keyId: string) => boolean },
  principal: Principal
): Ticket {
  if (principal.kind !== 'remote') throw new Error('forbidden: remote.ticket is for a key')
  if (principal.sessionId || principal.via || principal.audience !== 'client' || principal.caps.includes('pending'))
    throw new Error('forbidden: remote.ticket is for a client key on its own socket')
  if (auth.inFarewell(principal.keyId)) throw new Error('forbidden: this key is in farewell')
  // Marked: whatever the upgrade carries, the socket it opens is a window's, never a peer endpoint (auth.ts).
  return auth.mintTicket(principal, undefined, true)
}

/** `Server-Timing: mint;dur=<ms>, loop;dur=<ms>` on the box's ticket answer. */
export function ticketServerTiming(handledMs: number, loopMaxMs: number): string {
  return `mint;dur=${Math.round(handledMs)}, loop;dur=${Math.round(loopMaxMs)}`
}

/** The box's two numbers back out of its `Server-Timing` (absent on an older box). */
export function readServerTiming(header: string | null): { boxMs?: number; boxLoopMs?: number } {
  if (!header) return {}
  const dur = (name: string): number | undefined => {
    const m = new RegExp(`(?:^|,)\\s*${name};dur=([0-9.]+)`).exec(header)
    return m ? Number(m[1]) : undefined
  }
  const boxMs = dur('mint')
  const boxLoopMs = dur('loop')
  return { ...(boxMs !== undefined ? { boxMs } : {}), ...(boxLoopMs !== undefined ? { boxLoopMs } : {}) }
}

/**
 * How long fetch's last connection setup to `hostname` took (DNS, TCP, TLS), read from undici's diagnostics
 * channels, which Node's own fetch publishes. Keyed by host name, the last few hosts only.
 */
const CONNECT_HOSTS = 16
const connecting = new Map<object, { host: string; at: number }>()
const connected = new Map<string, { at: number; ms: number }>()
let watching = false

type ConnectMessage = { connectParams?: { hostname?: string; host?: string } }

function watchConnects(): void {
  if (watching) return
  watching = true
  subscribe('undici:client:beforeConnect', (message) => {
    const params = (message as ConnectMessage).connectParams
    const host = params?.hostname ?? params?.host
    if (params && host) connecting.set(params, { host, at: performance.now() })
  })
  subscribe('undici:client:connected', (message) => {
    const params = (message as ConnectMessage).connectParams
    const start = params ? connecting.get(params) : undefined
    if (!params || !start) return
    connecting.delete(params)
    connected.delete(start.host)
    connected.set(start.host, { at: performance.now(), ms: performance.now() - start.at })
    if (connected.size > CONNECT_HOSTS) connected.delete(connected.keys().next().value as string)
  })
  subscribe('undici:client:connectError', (message) => {
    const params = (message as ConnectMessage).connectParams
    if (params) connecting.delete(params)
  })
}

/** Start reading connections; the time of a connection to `hostname` made after `since` (performance.now()), else `reused`. */
export function connectTime(hostname: string, since: number): number | 'reused' {
  watchConnects()
  const last = connected.get(hostname)
  return last && last.at >= since ? last.ms : 'reused'
}

export { watchConnects }
