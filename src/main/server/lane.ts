import { createHash } from 'node:crypto'
import type { ClientRequest } from '@shared/contract'
import { METHOD_CAPABILITY } from '@shared/capabilities'
import { currentLag } from './stalls'

/**
 * Request classes and the gate that orders them (attach() in index.ts, after
 * the capability gate):
 *   - `interactive`: a request naming a thread someone is looking at
 *     (focus.ts: its log, sends, queue, notes, checkpoint state, a focused
 *     master's batch), or one the renderer marked `lane: 'ui'` (a person's
 *     click: send, approve, answer, stop, pause, resume, start now, archive),
 *     or a `session.events` that says `shown` (the window's open);
 *   - `bulk`: the polls and walks nobody waits on second by second: the git
 *     status reads, the searches, GitHub, thread resources, the doctor,
 *     file watches, and the deploy, publish and sync methods;
 *   - `normal`: everything else, among it the two a window asks on connect
 *     and focus that answer from what the host holds (heldAnswer.ts): a
 *     thread's checkpoint state and the command list. In bulk they waited
 *     up to BULK_MAX_WAIT_MS for nothing (2026-11-23: 108 s and 104 s).
 * Interactive and normal run at once. Bulk runs at most BULK_RUNNING at a
 * time per host and only while the loop keeps up (`currentLag().meanMs`
 * under BULK_LAG_MS); otherwise it waits in a FIFO, and a duplicate of a
 * request waiting or running (same method and params) joins it and gets
 * its answer: five windows polling one cwd's git status cost one run. Only
 * a read joins (from any socket); a write or a per-socket subscription
 * always runs, in its turn, so a subscribe, unsubscribe, subscribe never
 * loses the last one. After BULK_MAX_WAIT_MS, lag no longer holds a request; at most twice
 * the normal cap may run.
 *
 * `request.cancel {id}` (index.ts) names a bulk read the same socket sent: its
 * answer is never sent, and once no asker is left the read leaves the queue,
 * or, running, its signal aborts (search.ts stops its git grep or scan). The
 * gate knows a read only by its socket and id, so a cancel naming another
 * socket's request, a write, a subscription or anything outside the bulk lane
 * changes nothing and is refused.
 */

export type Lane = 'interactive' | 'normal' | 'bulk'

/** What the classifier asks the interactive set (focus.ts). */
export interface InteractiveSet {
  isInteractive(sessionId: string): boolean
}

export const BULK_RUNNING = 2
export const BULK_LAG_MS = 50
export const BULK_MAX_WAIT_MS = 20_000
const BULK_POLL_MS = 50
/** The signal of a request no cancel can reach. */
const NEVER_ABORTED = new AbortController().signal

const BULK_METHODS: ReadonlySet<string> = new Set([
  // The git status reads the changes panel and the rail poll.
  'project.changes',
  // The branch compare: several git children, asked on every mount and focus.
  'project.compare',
  'git.diffStats',
  'git.diffIndex',
  'search.project',
  'session.search',
  'doctor.get',
  'fs.watch',
  'host.deploy',
  'host.deployStatus',
  'host.publish',
  'host.publishStatus',
  'harness.manifest',
  'harness.file',
  'harness.commit',
  'harness.status',
  'harness.sync',
  'memory.exchange',
  'memory.files',
  'memory.status',
  'memory.sync',
  'accounts.sync'
])
const BULK_PREFIXES = ['github.', 'resources.']

/** Subscriptions kept per socket: a duplicate from another socket must run for that socket. */
const PER_SOCKET: ReadonlySet<string> = new Set(['fs.watch'])

/** The thread a request names, when it names one. */
function namedSession(req: ClientRequest): string | null {
  const params = 'params' in req ? (req.params as Record<string, unknown> | undefined) : undefined
  if (!params || typeof params !== 'object') return null
  if (typeof params.sessionId === 'string') return params.sessionId
  // A master's batch (batch.get, batch.children, …) names the master.
  if (req.method.startsWith('batch.') && typeof params.masterId === 'string') return params.masterId
  return null
}

function isBulkMethod(method: string): boolean {
  return BULK_METHODS.has(method) || BULK_PREFIXES.some((prefix) => method.startsWith(prefix))
}

export function laneOf(req: ClientRequest, interactive: InteractiveSet): Lane {
  const sessionId = namedSession(req)
  if (sessionId !== null && interactive.isInteractive(sessionId)) return 'interactive'
  if (req.lane === 'ui') return 'interactive'
  // A window's read of the thread it shows, before its pane has said so with
  // `session.focus`: the word picks a lane; the socket's reach is checked as for any ask.
  if (req.method === 'session.events' && req.params?.shown === true) return 'interactive'
  return isBulkMethod(req.method) ? 'bulk' : 'normal'
}

/** The join key of a bulk request: its method and a digest of its params,
 *  for a read every socket may share; null for anything else (never joins). */
export function bulkKey(req: ClientRequest): string | null {
  if (METHOD_CAPABILITY[req.method] !== 'read' || PER_SOCKET.has(req.method)) return null
  const params = 'params' in req ? JSON.stringify(req.params ?? null) : 'null'
  const digest = params.length > 64 ? createHash('sha1').update(params).digest('base64') : params
  return `${req.method}\0${digest}`
}

/** One asker of a bulk request: the first, or one that joined it. */
interface Waiter {
  /** `socket\0requestId` for a read its socket may cancel; null for anything else. */
  owner: string | null
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

interface Entry {
  key: string | null
  enqueuedAt: number
  run: (signal: AbortSignal) => Promise<unknown>
  waiters: Set<Waiter>
  /** Aborted when every asker of a running read cancelled it (search.ts stops). */
  controller: AbortController
  started: boolean
}

/** A bulk read its own socket cancelled (`request.cancel`): nothing is sent for it. */
export class LaneCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'LaneCancelled'
  }
}

/** The one refusal of a cancel naming no read of this socket's that waits or runs in the bulk lane. */
export const CANCEL_REFUSED = 'request.cancel names no bulk read of this socket waiting or running'

export interface LaneGateOptions {
  maxRunning?: number
  lagMs?: number
  maxWaitMs?: number
  /** The loop's lag now (stalls.ts by default). */
  lag?: () => number
  now?: () => number
}

/** The host's bulk lane: see the file's comment. One per server. */
export class LaneGate {
  private readonly waiting: Entry[] = []
  private readonly byKey = new Map<string, Entry>()
  private running = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly maxRunning: number
  private readonly lagMs: number
  private readonly maxWaitMs: number
  private readonly lag: () => number
  private readonly now: () => number
  /** Requests that joined one already waiting or running, since the gate was made. */
  joins = 0

  constructor(options: LaneGateOptions = {}) {
    this.maxRunning = options.maxRunning ?? BULK_RUNNING
    this.lagMs = options.lagMs ?? BULK_LAG_MS
    this.maxWaitMs = options.maxWaitMs ?? BULK_MAX_WAIT_MS
    this.lag = options.lag ?? (() => currentLag().meanMs)
    this.now = options.now ?? (() => Date.now())
  }

  /** Run `task` in its lane: at once unless bulk; a bulk duplicate of `key`
   *  shares the first one's outcome, and a null key never joins. `owner`
   *  (`socket\0requestId`) makes a read cancellable by that socket alone. */
  run<T>(lane: Lane, key: string | null, task: (signal: AbortSignal) => Promise<T>, owner: string | null = null): Promise<T> {
    if (lane !== 'bulk') return task(NEVER_ABORTED)
    // Only a read that may join (a key) is its socket's to cancel.
    const cancellable = key !== null ? owner : null
    const known = key === null ? undefined : this.byKey.get(key)
    if (known) {
      this.joins++
      return this.wait(known, cancellable) as Promise<T>
    }
    const entry: Entry = { key, enqueuedAt: this.now(), run: task, waiters: new Set(), controller: new AbortController(), started: false }
    const promise = this.wait(entry, cancellable)
    if (key !== null) this.byKey.set(key, entry)
    this.waiting.push(entry)
    this.pump()
    return promise as Promise<T>
  }

  /**
   * `request.cancel`: the socket's own bulk read `owner` stops waiting for
   * its answer, which is never sent. The last asker gone, a waiting read
   * leaves the queue and a running one is told to stop (its signal). False,
   * and nothing changed, for any other id: another socket's request, a
   * write, a subscription, one not in the bulk lane or already answered.
   */
  cancel(owner: string): boolean {
    const found = this.owners.get(owner)
    if (!found) return false
    const { entry, waiter } = found
    this.owners.delete(owner)
    entry.waiters.delete(waiter)
    waiter.reject(new LaneCancelled())
    if (entry.waiters.size > 0) return true
    // No one wants it: a later duplicate starts its own.
    if (entry.key !== null && this.byKey.get(entry.key) === entry) this.byKey.delete(entry.key)
    if (entry.started) entry.controller.abort()
    else {
      const at = this.waiting.indexOf(entry)
      if (at >= 0) this.waiting.splice(at, 1)
      this.cancelled++
    }
    return true
  }

  /** Bulk reads dropped from the queue by a cancel before they ran, since the gate was made. */
  cancelled = 0

  private readonly owners = new Map<string, { entry: Entry; waiter: Waiter }>()

  private wait(entry: Entry, owner: string | null): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const waiter: Waiter = { owner, resolve, reject }
      entry.waiters.add(waiter)
      if (owner !== null) this.owners.set(owner, { entry, waiter })
    })
  }

  private settle(entry: Entry, outcome: (waiter: Waiter) => void): void {
    for (const waiter of entry.waiters) {
      if (waiter.owner !== null && this.owners.get(waiter.owner)?.waiter === waiter) this.owners.delete(waiter.owner)
      outcome(waiter)
    }
    entry.waiters.clear()
  }

  /** Bulk requests running and waiting, for the stall line. */
  stats(): { running: number; held: number } {
    return { running: this.running, held: this.waiting.length }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Start what may start, in order; the head that may not holds the rest. */
  private pump(): void {
    const now = this.now()
    while (this.waiting.length > 0) {
      const head = this.waiting[0]
      const overdue = now - head.enqueuedAt >= this.maxWaitMs
      if (this.running >= (overdue ? this.maxRunning * 2 : this.maxRunning)) break
      if (!overdue && this.lag() >= this.lagMs) break
      this.waiting.shift()
      this.start(head)
    }
    if (this.waiting.length === 0 || this.timer) return
    // Blocked by the lag or the cap: look again soon, and by the head's deadline at the latest.
    const untilDue = this.waiting[0].enqueuedAt + this.maxWaitMs - now
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.pump()
      },
      Math.max(1, Math.min(BULK_POLL_MS, untilDue > 0 ? untilDue : BULK_POLL_MS))
    )
    this.timer.unref?.()
  }

  private start(entry: Entry): void {
    this.running++
    entry.started = true
    let settled: Promise<unknown>
    try {
      settled = entry.run(entry.controller.signal)
    } catch (error) {
      settled = Promise.reject(error)
    }
    settled
      .then(
        (value) => this.settle(entry, (w) => w.resolve(value)),
        (error) => this.settle(entry, (w) => w.reject(error))
      )
      .finally(() => {
        this.running--
        if (entry.key !== null && this.byKey.get(entry.key) === entry) this.byKey.delete(entry.key)
        this.pump()
      })
  }
}
