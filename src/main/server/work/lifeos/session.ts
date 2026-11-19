import type { LifeosState, LifeosStateName } from '@shared/contract-work-lifeos'
import type { LifeosClient } from './ctx'
import type { DeviceTokenStore } from './deviceToken'
import { faultOf, faultWords, redact, type LifeosTransport, type OwnerConnection } from './transport'

/**
 * This host's session with LifeOS (architecture §5): the device token it
 * holds, the JWTs it trades it for, and the owner's live connection that
 * pillars query and subscribe through. One per host. It runs only while
 * Work is on (`start`/`stop`); off, every member answers `off`.
 *
 * Nothing here returns, pushes or logs the device token. A JWT leaves only
 * through `jwt()`, to a screen that asked with approve.
 */

/** A member asked of LifeOS while it cannot answer: `state` says why, for a screen or a tool's error. */
export class LifeosUnavailable extends Error {
  constructor(readonly state: Exclude<LifeosStateName, 'connected'>) {
    super(UNAVAILABLE_WORDS[state])
    this.name = 'LifeosUnavailable'
  }
}
export const UNAVAILABLE_WORDS: Record<Exclude<LifeosStateName, 'connected'>, string> = {
  off: 'Work is off on this host',
  'signed-out': 'This host is not signed in to LifeOS',
  pairing: "This host's LifeOS sign-in waits for approval",
  connecting: 'LifeOS is still connecting',
  unreachable: 'LifeOS is unreachable',
  refused: "LifeOS refused this host's sign-in; sign in again"
}

export interface SessionDeps {
  transport: LifeosTransport
  tokens: DeviceTokenStore
  /** the LifeOS deployment this host talks to */
  url: string
  /** this host's environment id, and the name a pairing shows the owner */
  host: string
  hostName: () => string
  log: (line: string) => void
  now?: () => number
  /** test seams */
  pollMs?: number
  retryMs?: readonly number[]
  liveGraceMs?: number
  connectMs?: number
}

/** A JWT lives an hour; one with less than this left is traded again. */
export const JWT_MARGIN_MS = 2 * 60_000
const POLL_MS = 3_000
const RETRY_MS = [5_000, 15_000, 30_000, 60_000] as const
const LIVE_GRACE_MS = 30_000
const CONNECT_MS = 20_000

/** `run`, or a TypeError (an unreachable fault) once `ms` pass. */
function timed<T>(run: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new TypeError('timed out waiting for LifeOS')), ms)
    timer.unref?.()
  })
  return Promise.race([run, late]).finally(() => clearTimeout(timer))
}

interface Watch {
  fn: string
  args: Record<string, unknown>
  on: (value: unknown) => void
  stop: (() => void) | null
}

export class LifeosSession {
  private current: LifeosState = { state: 'off' }
  private readonly listeners = new Set<(state: LifeosState) => void>()
  private conn: OwnerConnection | null = null
  private readonly jwts = new Map<string, Promise<{ jwt: string; expiresAt: number }>>()
  private readonly held = new Map<string, { jwt: string; expiresAt: number }>()
  private readonly watches = new Set<Watch>()
  private timer: NodeJS.Timeout | null = null
  private pairing: { poll: string; code: string; expiresAt: number } | null = null
  private retry = 0
  private running = false
  private downSince: number | null = null
  private epoch = 0
  private ownerId = ''
  private sessionId: string | null = null
  private readonly connectedHooks = new Set<() => void>()

  constructor(private readonly deps: SessionDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(line: string): void {
    this.deps.log(redact(`lifeos: ${line}`))
  }

  // ── state ─────────────────────────────────────────────────────────────
  state(): LifeosState {
    return this.current
  }

  onChange(fn: (state: LifeosState) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** Called each time the session comes to `connected`: keys and queued links catch up then. */
  onConnected(fn: () => void): () => void {
    this.connectedHooks.add(fn)
    return () => void this.connectedHooks.delete(fn)
  }

  private set(next: LifeosState): void {
    const was = this.current
    this.current = next
    if (JSON.stringify(was) === JSON.stringify(next)) return
    if (next.state !== was.state) this.log(`${was.state} → ${next.state}${'error' in next ? ` (${next.error})` : ''}`)
    for (const fn of [...this.listeners]) fn(next)
    if (next.state === 'connected' && was.state !== 'connected') for (const fn of [...this.connectedHooks]) fn()
  }

  connected(): boolean {
    return this.current.state === 'connected'
  }

  private unavailable(): LifeosUnavailable {
    return new LifeosUnavailable(this.current.state === 'connected' ? 'connecting' : this.current.state)
  }

  // ── start and stop with the switch ────────────────────────────────────
  start(): void {
    if (this.running) return
    this.running = true
    this.epoch++
    const device = this.device()
    if (device) void this.connect()
    else this.set({ state: 'signed-out' })
  }

  stop(): void {
    this.running = false
    this.epoch++
    this.clearTimer()
    this.pairing = null
    this.drop()
    this.set({ state: 'off' })
  }

  /** The stored token, if it was issued by the deployment this host talks to now. */
  private device(): { token: string } | null {
    const stored = this.deps.tokens.read()
    if (!stored) return null
    if (stored.url !== this.deps.url) {
      this.log('the stored token was issued by another LifeOS address; it is not used')
      return null
    }
    return stored
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private later(ms: number, run: () => void): void {
    this.clearTimer()
    const epoch = this.epoch
    this.timer = setTimeout(() => {
      this.timer = null
      if (epoch === this.epoch && this.running) run()
    }, ms)
    this.timer.unref?.()
  }

  /** Closes the owner's connection and forgets every JWT; watches stay listed and reattach on the next connect. */
  private drop(): void {
    for (const w of this.watches) {
      w.stop?.()
      w.stop = null
    }
    this.conn?.close()
    this.conn = null
    this.jwts.clear()
    this.held.clear()
    this.downSince = null
  }

  // ── the token trade ───────────────────────────────────────────────────
  private async trade(sectors: readonly string[] | undefined, force = false): Promise<{ jwt: string; expiresAt: number }> {
    const key = sectors?.length ? [...sectors].sort().join(',') : ''
    const kept = this.held.get(key)
    if (!force && kept && kept.expiresAt - this.now() > JWT_MARGIN_MS) return kept
    const inFlight = !force && this.jwts.get(key)
    if (inFlight) return inFlight
    const device = this.device()
    if (!device) throw new LifeosUnavailable(this.pairing ? 'pairing' : 'signed-out')
    const epoch = this.epoch
    const run = this.deps.transport
      .open<{ jwt: string; expiresAt: number }>('auth:token', sectors?.length ? { token: device.token, sectors: [...sectors] } : { token: device.token })
      .then((answer) => {
        if (epoch === this.epoch) this.held.set(key, answer)
        return answer
      })
      .finally(() => {
        if (this.jwts.get(key) === run) this.jwts.delete(key)
      })
    this.jwts.set(key, run)
    return run
  }

  /** The first trade, then the owner's connection. Unreachable retries on fixed steps; a refusal stops. */
  private async connect(): Promise<void> {
    if (!this.running) return
    const epoch = this.epoch
    if (this.current.state !== 'unreachable') this.set({ state: 'connecting' })
    try {
      await this.trade(undefined, true)
      if (epoch !== this.epoch) return
      this.retry = 0
      this.open()
      // A socket that never comes up (a proxy refusing the upgrade) reads as unreachable, not as connecting for ever.
      const me = await timed(this.conn!.query<{ ownerId: string; sessionId?: string }>('auth:caller', {}), this.deps.connectMs ?? CONNECT_MS)
      if (epoch !== this.epoch) return
      this.ownerId = me.ownerId
      this.sessionId = me.sessionId ?? null
      this.set({ state: 'connected', ownerId: me.ownerId, since: this.now() })
      this.tick()
    } catch (err) {
      if (epoch !== this.epoch) return
      this.failed(err)
    }
  }

  private failed(err: unknown): void {
    const fault = faultOf(err)
    // Whatever was in flight (a connect awaiting its first query, a trade) belongs to the connection just dropped.
    this.epoch++
    this.drop()
    if (fault === 'refused') {
      this.set({ state: 'refused', error: faultWords(err) })
      return
    }
    const since = this.current.state === 'unreachable' ? this.current.since : this.now()
    this.set({ state: 'unreachable', since, error: faultWords(err) })
    const steps = this.deps.retryMs ?? RETRY_MS
    this.later(steps[Math.min(this.retry++, steps.length - 1)]!, () => void this.connect())
  }

  private open(): void {
    this.conn?.close()
    const conn: OwnerConnection = this.deps.transport.connect(
      async (force) => {
        try {
          return (await this.trade(undefined, force)).jwt
        } catch {
          return null
        }
      },
      // Convex never asks again once a refresh gave it no token: the session reconnects on its own steps, and a refusal shows at the next trade.
      () => {
        if (this.running && this.conn === conn) this.failed(new TypeError('the LifeOS sign-in lapsed'))
      }
    )
    this.conn = conn
    for (const w of this.watches) this.attach(w)
  }

  /** While connected: a socket down for longer than the grace reads as unreachable until it is back. */
  private tick(): void {
    this.later(this.deps.liveGraceMs ? Math.max(50, this.deps.liveGraceMs / 3) : 10_000, () => {
      const grace = this.deps.liveGraceMs ?? LIVE_GRACE_MS
      const live = this.conn?.live() ?? false
      if (live) {
        this.downSince = null
        if (this.current.state === 'unreachable') this.set({ state: 'connected', ownerId: this.ownerId, since: this.now() })
      } else {
        this.downSince ??= this.now()
        if (this.now() - this.downSince >= grace && this.current.state === 'connected') this.set({ state: 'unreachable', since: this.downSince, error: 'the connection to LifeOS dropped' })
      }
      if (this.conn) this.tick()
    })
  }

  // ── what the context hands pillars ────────────────────────────────────
  /** The owner's client. Each call checks the state, so a pillar may keep it. */
  owner(): LifeosClient {
    const call =
      <K extends 'query' | 'mutation' | 'action'>(kind: K) =>
      <T>(fn: string, args: Record<string, unknown> = {}): Promise<T> => {
        if (!this.connected() || !this.conn) return Promise.reject(this.unavailable())
        return this.conn[kind]<T>(fn, args)
      }
    return { query: call('query'), mutation: call('mutation'), action: call('action') }
  }

  /** A JWT of the whole session, or narrowed to `sectors`. */
  async jwt(sectors?: readonly string[]): Promise<{ jwt: string; expiresAt: number }> {
    if (this.current.state !== 'connected' && this.current.state !== 'unreachable') throw this.unavailable()
    const epoch = this.epoch
    let answer: { jwt: string; expiresAt: number }
    try {
      answer = await this.trade(sectors)
    } catch (err) {
      if (err instanceof LifeosUnavailable) throw err
      const fault = faultOf(err)
      if (fault === 'error') throw new Error(`LifeOS refused the JWT: ${faultWords(err)}`)
      // A refusal ends the session; a failed trade for one screen leaves the owner's connection to its own checks.
      if (fault === 'refused') {
        this.failed(err)
        throw this.unavailable()
      }
      throw new LifeosUnavailable('unreachable')
    }
    // A sign-out or a switch-off while the trade ran: the JWT is not handed out.
    if (epoch !== this.epoch || !this.running) throw this.unavailable()
    return answer
  }

  /** A live query as the owner. Listed at once; it runs while connected and comes back after a reconnect. */
  subscribe<T>(fn: string, args: unknown, on: (value: T) => void): () => void {
    const w: Watch = { fn, args: (args ?? {}) as Record<string, unknown>, on: on as (v: unknown) => void, stop: null }
    this.watches.add(w)
    if (this.conn) this.attach(w)
    return () => {
      w.stop?.()
      this.watches.delete(w)
    }
  }

  private attach(w: Watch): void {
    w.stop?.()
    w.stop = this.conn?.watch(w.fn, w.args, w.on, (err) => this.log(`${w.fn} failed: ${faultWords(err)}`)) ?? null
  }

  // ── signing in and out ────────────────────────────────────────────────
  /** A code to approve in LifeOS. The host polls for the token itself and keeps it; the code is the only thing the screen sees. */
  async pairStart(name?: string): Promise<{ code: string; expiresAt: number }> {
    if (!this.running) throw new LifeosUnavailable('off')
    if (this.connected()) throw new Error('This host is signed in to LifeOS; sign out before pairing again')
    const epoch = this.epoch
    const answer = await this.deps.transport.open<{ code: string; poll: string; expiresAt: number }>('auth:pairStart', {
      name: (name?.trim() || `TempCode on ${this.deps.hostName()}`).slice(0, 80),
      host: this.deps.hostName().slice(0, 80)
    })
    if (!this.running) throw new LifeosUnavailable('off')
    if (epoch !== this.epoch) throw new Error('The pairing was overtaken by another sign-in or a sign-out')
    this.epoch++
    this.drop()
    this.pairing = answer
    this.set({ state: 'pairing', code: answer.code, expiresAt: answer.expiresAt })
    this.poll()
    return { code: answer.code, expiresAt: answer.expiresAt }
  }

  private poll(): void {
    this.later(this.deps.pollMs ?? POLL_MS, async () => {
      const pairing = this.pairing
      if (!pairing) return
      if (this.now() > pairing.expiresAt) return this.endPairing('the sign-in code expired')
      const epoch = this.epoch
      try {
        const answer = await this.deps.transport.open<{ status: 'pending' } | { status: 'approved'; token: string }>('auth:pairClaim', { poll: pairing.poll })
        if (epoch !== this.epoch) return
        if (answer.status === 'approved') {
          this.pairing = null
          this.deps.tokens.write({ v: 1, token: answer.token, url: this.deps.url, at: this.now() })
          this.log('signed in by pairing')
          void this.connect()
          return
        }
      } catch (err) {
        if (epoch !== this.epoch) return
        const code = (err as { data?: { code?: unknown } }).data?.code
        if (code === 'pairing-unknown') return this.endPairing('the sign-in was refused or has expired')
        // unreachable a moment: keep polling until the code expires
      }
      this.poll()
    })
  }

  private endPairing(why: string): void {
    this.pairing = null
    this.log(why)
    this.set(this.device() ? { state: 'connecting' } : { state: 'signed-out' })
    if (this.device()) void this.connect()
  }

  pairCancel(): void {
    if (!this.pairing) return
    this.epoch++
    this.clearTimer()
    this.endPairing('the pairing was cancelled')
  }

  /** Signs in with a token made elsewhere (`auth:mint`). It is kept only if LifeOS trades it for a JWT. */
  async setToken(token: string): Promise<void> {
    if (!this.running) throw new LifeosUnavailable('off')
    const epoch = this.epoch
    try {
      await this.deps.transport.open('auth:token', { token })
    } catch (err) {
      throw new Error(faultOf(err) === 'refused' ? 'LifeOS refused that token' : `LifeOS did not take the token: ${faultWords(err)}`)
    }
    if (!this.running) throw new LifeosUnavailable('off')
    if (epoch !== this.epoch) throw new Error('The sign-in was overtaken by another sign-in or a sign-out')
    // The session the new token replaces is ended in LifeOS, not left live behind it.
    if (this.connected() && this.conn && this.sessionId) await this.conn.mutation('auth:revoke', { id: this.sessionId }).catch((err) => this.log(`the old session was not revoked: ${faultWords(err)}`))
    if (epoch !== this.epoch || !this.running) throw new Error('The sign-in was overtaken by another sign-in or a sign-out')
    this.epoch++
    this.pairing = null
    this.drop()
    this.deps.tokens.write({ v: 1, token, url: this.deps.url, at: this.now() })
    this.log('signed in with a token')
    await this.connect()
  }

  /** Ends this host's LifeOS session (revoked there when LifeOS answers) and drops the token here. */
  async signOut(): Promise<void> {
    if (this.connected() && this.conn && this.sessionId) {
      await this.conn.mutation('auth:revoke', { id: this.sessionId }).catch((err) => this.log(`the session was not revoked in LifeOS: ${faultWords(err)}`))
    }
    this.epoch++
    this.clearTimer()
    this.pairing = null
    this.drop()
    this.deps.tokens.clear()
    this.sessionId = null
    this.set(this.running ? { state: 'signed-out' } : { state: 'off' })
  }

  /** The live session's own id in LifeOS, while connected. */
  ownSessionId(): string | null {
    return this.connected() ? this.sessionId : null
  }
}
