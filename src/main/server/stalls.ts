/**
 * Always-on stall recorder for the main process. One short line per
 * stall in `<userData>/logs/stalls.log` (rotated once to `stalls.log.1`
 * at 2 MB), so an intermittent freeze is diagnosable after the fact. The
 * lines are queued and appended off the loop (`write`), so a slow disk
 * never holds the loop for a line about it:
 *
 *   - `loop`: the event loop was blocked ≥ STALL_MS in the last second
 *     (monitorEventLoopDelay, sampled once a second)
 *   - `timed`: a known synchronous section ran ≥ TIMED_MS
 *   - `checkpoint`: the checkpoint worker (dbWorkers.ts) copied a WAL into
 *     its file for ≥ TIMED_MS; off the loop, but the disk time shows here
 *   - `slow-request`: a WS request took longer than the boot log's cap; a
 *     long poll (LONG_POLL_MS) only past its own wait plus LONG_POLL_GRACE_MS.
 *     The handler's own words ride on it (`noteRequest`): a `work.files.*`
 *     line says `place=<kind>` and, when it woke the VM, `wake=<ms>`
 *   - `work-calls`: once an hour, each `work.*` method's calls and how many
 *     passed SLOW_WORK_MS (`work.files.list:120/3`), so a slow tail has its share
 *   - `[renderer] …`: a line the renderer sent through `stall.report`
 *
 * Every server line carries the requests in flight (method + age), the
 * pushes sent in the last second, the running thread count, loadavg, RSS,
 * the most unsent bytes on a socket and the bulk lane (lane.ts) as
 * `lane=bulk:<running>/<held>`, and `pool=`: how long the last one-a-second
 * `stat` took through libuv's thread pool (every fs/promises call, dns.lookup
 * and zlib share its four threads; a fs-only request that waits there shows
 * here, `pool=<age>ms+` while the probe is still out). Cost: two integer counters, one Map entry per in-flight request,
 * one histogram read a second. Nothing allocates per event.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { loadavg } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { InFlightRequest, LoopLag } from '@shared/contract'

export const STALL_MS = 150
export const TIMED_MS = 50
const ROTATE_BYTES = 2 * 1024 * 1024
const SAMPLE_MS = 1000
export const DEFAULT_IDLE_THRESHOLD_MS = 50
export const DEFAULT_IDLE_MAX_WAIT_MS = 2000
const EWMA_ALPHA = 1 / 10
let lag: LoopLag = { meanMs: 0, maxMs: 0, ewmaMs: 0 }
let testLag: LoopLag | null = null

export function currentLag(): LoopLag {
  return { ...(testLag ?? lag) }
}

export function setLagForTests(sample: LoopLag | null): void {
  testLag = sample
}

export async function untilLoopIdle(opts: { thresholdMs?: number; maxWaitMs?: number } = {}): Promise<void> {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS
  const deadline = performance.now() + (opts.maxWaitMs ?? DEFAULT_IDLE_MAX_WAIT_MS)
  while (currentLag().meanMs >= thresholdMs) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)))
  }
}

/** A background job's pause between slices: one turn of the loop (sockets
 *  and timers run), then untilLoopIdle, so a walk or a move never takes the
 *  loop from a person's request while it lags. */
export async function yieldUntilIdle(opts: { thresholdMs?: number; maxWaitMs?: number } = {}): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await untilLoopIdle(opts)
}

/** Run a host job now when the loop keeps up, else once it is quiet (or
 *  the wait bound passed): a timer's sweep or save never lands on a busy loop. */
export function whenLoopIdle(fn: () => void, opts: { thresholdMs?: number; maxWaitMs?: number } = {}): void {
  if (currentLag().meanMs < (opts.thresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS)) {
    fn()
    return
  }
  void untilLoopIdle(opts).then(fn)
}

let file: string | null = null
let runningCount: () => number = () => 0
let bufferedBytes: () => number = () => 0
let laneStats: () => { running: number; held: number } = () => ({ running: 0, held: 0 })
const inFlight = new Map<string, { method: string; startedAt: number }>()
const pushes = { meta: 0, event: 0 }
/** The last second's meta pushes by producer (notifyMeta's tag) and the distinct sessions they named. */
const metaProducers = new Map<string, number>()
const metaIds = new Set<string>()
/** The thread-pool probe: the last answer's time, and when the one out now left. */
let poolMs = 0
let poolProbeAt: number | null = null

/** Where stall lines go; `null` (tests, no data dir) disables the recorder. */
export function setStallLog(logDir: string | null): void {
  file = logDir ? join(logDir, 'stalls.log') : null
  known = null
}

/** How many threads are live right now; asked only when a line is written. */
export function setRunningCount(fn: () => number): void {
  runningCount = fn
}

/** The most bytes any client socket holds unsent (`ws.bufferedAmount`);
 *  the `wsbuf=` field. A renderer that cannot drain its socket shows here
 *  while every request still reads as served (2026-10-17: a full kernel
 *  send queue behind an idle server). */
export function setBufferedBytes(fn: () => number): void {
  bufferedBytes = fn
}

/** The bulk lane's requests running and waiting (lane.ts); the `lane=` field. */
export function setLaneStats(fn: () => { running: number; held: number }): void {
  laneStats = fn
}

/** Unsent bytes past which a socket's connection logs one `backpressure` line. */
export const BACKPRESSURE_BYTES = 8 * 1024 * 1024

export function recordBackpressure(connection: number, bytes: number): void {
  write(`backpressure connection=${connection} unsent=${Math.round(bytes / 1024)}KB`)
}

/** A request the socket handler is working on: `key` is unique per connection + id. */
export function trackRequest(key: string, method: string): void {
  inFlight.set(key, { method, startedAt: Date.now() })
}

export function untrackRequest(key: string): void {
  inFlight.delete(key)
}

export function inFlightRequests(): InFlightRequest[] {
  const now = Date.now()
  return [...inFlight.values()].map((r) => ({ method: r.method, ageMs: now - r.startedAt }))
}

/** One push frame went out; the loop line reports the last second's totals.
 *  A meta push names its producer (the registry's tag: `status`, `accounts`,
 *  …) and the session, so a storm reads `meta:4038/781ids(accounts:3900,status:138)`:
 *  how many frames, for how many threads, from which code. */
export function countPush(kind: 'meta' | 'event', producer?: string, sessionId?: string): void {
  pushes[kind] += 1
  if (kind !== 'meta') return
  if (producer) metaProducers.set(producer, (metaProducers.get(producer) ?? 0) + 1)
  if (sessionId) metaIds.add(sessionId)
}

/** The `pushes=` field: totals, and the meta breakdown when one was tagged. */
export function pushesField(): string {
  let meta = `meta:${pushes.meta}`
  if (metaIds.size > 0 || metaProducers.size > 0) {
    const by = [...metaProducers.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([producer, n]) => `${producer}:${n}`)
      .join(',')
    meta += `/${metaIds.size}ids${by ? `(${by})` : ''}`
  }
  return `pushes=${meta},event:${pushes.event}`
}

/** Test seam: the counters a tick would clear. */
export function resetPushesForTests(): void {
  resetPushes()
}

function resetPushes(): void {
  pushes.meta = 0
  pushes.event = 0
  metaProducers.clear()
  metaIds.clear()
}

/** A send's phase line (sendSpans.ts): the send-time picture rides with it. */
export function recordSendSpan(body: string): void {
  write(body)
}

/** A driver's note about a thread that the stall log keeps (codex's model metadata wait, a fallback first turn). */
export function recordDriverNote(body: string): void {
  write(body, false)
}

/** A bridged computer call whose bridge legs passed their bound (computer/bridge.ts); the line carries its own legs and lag. */
export function recordComputerSpan(body: string): void {
  write(body)
}

/** What a request's handler said of it (`noteRequest`), kept for the lines written inside it. */
const requestNotes = new AsyncLocalStorage<Map<string, string>>()

/** Runs one request with a place for its handler's words. */
export function withRequestNotes<T>(fn: () => T): T {
  return requestNotes.run(new Map(), fn)
}

/** A word for this request's stall lines: `place=vm`, `wake=13200ms`, `profile=remote`. Outside a request it is dropped. */
export function noteRequest(key: string, value: string | number): void {
  requestNotes.getStore()?.set(key, String(value).replace(/\s+/g, '_').slice(0, 40))
}

/** The notes as ` key=value …`, or nothing. */
export function requestNotesField(): string {
  const notes = requestNotes.getStore()
  return notes?.size ? ' ' + [...notes].map(([key, value]) => `${key}=${value}`).join(' ') : ''
}

/** A block of the loop as loopWatch.ts saw it from beside the main thread: what the thread waited in. */
export function recordLoopBlock(body: string): void {
  write(body)
}

/** Runs `fn` and logs it when it held the loop for TIMED_MS or more. */
export function timed<T>(label: string, fn: () => T): T {
  const startedAt = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - startedAt
    if (ms >= TIMED_MS) write(`timed ${label} ${Math.round(ms)}ms${requestNotesField()}`)
  }
}

/** A WAL checkpoint the worker ran: logged when it took TIMED_MS or more. */
export function recordCheckpoint(schema: string, frames: number, ms: number): void {
  if (ms >= TIMED_MS) write(`checkpoint schema=${schema} frames=${frames} ms=${Math.round(ms)}`)
}

/** A request slower than this is a slow request (the boot log's cap). */
export const SLOW_REQUEST_MS = 500
/** Methods that wait by design, with the longest each waits: slow only past that plus the grace. */
export const LONG_POLL_MS: Readonly<Record<string, number>> = { 'work.docs.recv': 20_000 }
export const LONG_POLL_GRACE_MS = 2000

/** Whether a request of `ms` is slow: a long poll that answered within its own wait is working as built. */
export function isSlowRequest(method: string, ms: number): boolean {
  const wait = LONG_POLL_MS[method]
  return ms > (wait === undefined ? SLOW_REQUEST_MS : wait + LONG_POLL_GRACE_MS)
}

/** `lane=` and, for bulk, `gate=` (the wait before it ran; `gate=joined` when it shared another's run), then the handler's notes. */
export function recordSlowRequest(method: string, ms: number, how?: { lane: string; gateMs: number | null }): void {
  const lane = how ? ` lane=${how.lane}${how.lane === 'bulk' ? ` gate=${how.gateMs === null ? 'joined' : `${how.gateMs}ms`}` : ''}` : ''
  write(`slow-request ${method} ${ms}ms${lane}${requestNotesField()}`)
}

/** A `work.*` call past this counts as slow in the hourly line. */
export const SLOW_WORK_MS = 500
const WORK_CALLS_EVERY_MS = 60 * 60 * 1000
/** The hour's `work.*` calls: method → [calls, slow]. The methods are a fixed set, so the map is bounded by them. */
const workCalls = new Map<string, [number, number]>()
let workCallsAt = Date.now()

/** One `work.*` request ended after `ms`; other methods are not counted. */
export function countWorkCall(method: string, ms: number): void {
  if (!method.startsWith('work.')) return
  const row = workCalls.get(method) ?? [0, 0]
  row[0] += 1
  if (ms > SLOW_WORK_MS) row[1] += 1
  workCalls.set(method, row)
}

/** The `work-calls` line for the calls counted so far, busiest first, or null when there were none. Empties the count. */
export function workCallsLine(): string | null {
  if (workCalls.size === 0) return null
  const body = [...workCalls]
    .sort((a, b) => b[1][0] - a[1][0] || a[0].localeCompare(b[0]))
    .map(([method, [calls, slow]]) => `${method}:${calls}/${slow}`)
    .join(',')
  workCalls.clear()
  return `work-calls ${body}`
}

/** A stall the renderer measured; its line already carries its own context. */
export function reportRendererStall(line: string): void {
  write(`[renderer] ${line.replace(/[\r\n]+/g, ' ').slice(0, 2000)}`, false)
}

/** The `loop` line for one histogram sample, or null when the loop kept up. */
export function loopLine(sample: { max: number; mean: number }): string | null {
  const max = Math.round(sample.max / 1e6)
  if (max < STALL_MS) return null
  return `loop max=${max}ms mean=${Math.round(sample.mean / 1e6)}ms`
}

/**
 * Samples the loop delay once a second for the life of the process.
 * Returns the stop function; the timer is unref'd so it never holds exit.
 */
export function startStallMonitor(): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  lag = { meanMs: 0, maxMs: 0, ewmaMs: 0 }
  histogram.enable()
  const timer = setInterval(() => {
    // The last second's mean and max, read before the reset; the EWMA folds
    // each second in with weight 1/10, so it follows the last ~10 s.
    const meanMs = Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : 0
    lag = {
      meanMs,
      maxMs: histogram.max / 1e6,
      ewmaMs: lag.ewmaMs + EWMA_ALPHA * (meanMs - lag.ewmaMs)
    }
    const line = loopLine({ max: histogram.max, mean: histogram.mean })
    histogram.reset()
    if (line) write(line)
    resetPushes()
    probePool()
    if (Date.now() - workCallsAt >= WORK_CALLS_EVERY_MS) {
      workCallsAt = Date.now()
      const calls = workCallsLine()
      if (calls) write(calls, false)
    }
  }, SAMPLE_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
    histogram.disable()
    lag = { meanMs: 0, maxMs: 0, ewmaMs: 0 }
  }
}

/** One `stat` through the thread pool unless one is still out. */
function probePool(): void {
  if (poolProbeAt !== null) return
  const at = performance.now()
  poolProbeAt = at
  void stat(process.execPath)
    .catch(() => null)
    .finally(() => {
      poolMs = performance.now() - at
      poolProbeAt = null
    })
}

/** The `pool=` field: the probe out now when it is older than the last answer. */
export function poolField(): string {
  const out = poolProbeAt === null ? 0 : performance.now() - poolProbeAt
  return out > poolMs ? `pool=${Math.round(out)}ms+` : `pool=${Math.round(poolMs)}ms`
}

/** The state suffix every server line ends with. */
export function context(): string {
  const requests = inFlightRequests()
    .map((r) => `${r.method}:${r.ageMs}ms`)
    .slice(0, 12)
    .join(',')
  let running = 0
  try {
    running = runningCount()
  } catch {
    // context is best effort
  }
  const rss = Math.round(process.memoryUsage.rss() / 1048576)
  let wsbuf = 0
  try {
    wsbuf = Math.round(bufferedBytes() / 1024)
  } catch {
    // context is best effort
  }
  let lane = '0/0'
  try {
    const { running: bulkRunning, held } = laneStats()
    lane = `${bulkRunning}/${held}`
  } catch {
    // context is best effort
  }
  return `inflight=${requests || '-'} ${pushesField()} running=${running} load=${loadavg()[0].toFixed(1)} rss=${rss}MB wsbuf=${wsbuf}KB lane=bulk:${lane} ${poolField()}`
}

/** Pending text past which new lines are dropped (and counted) until the disk catches up. */
export const STALL_QUEUE_MAX_BYTES = 1024 * 1024
/** Lines waiting for the one append in flight, their bytes, and the lines dropped past the bound. */
let pending: string[] = []
let pendingBytes = 0
let dropped = 0
let draining: Promise<void> | null = null
/** The log's size as the writer knows it: stat once per file, then counted. */
let known: { target: string; bytes: number } | null = null

/**
 * One stall line, queued: the main thread never waits on the disk for it
 * (2026-11-24: a guest's flush burst stalled ext4's journal and every
 * synchronous append froze the loop for seconds). One append at a time
 * takes everything queued; past STALL_QUEUE_MAX_BYTES new lines are
 * dropped, and the log says how many once it drains.
 */
function write(body: string, withContext = true): void {
  if (!file) return
  const line = `${new Date().toISOString()} ${body}${withContext ? ` ${context()}` : ''}\n`
  if (pendingBytes + line.length > STALL_QUEUE_MAX_BYTES) {
    dropped += 1
    return
  }
  pending.push(line)
  pendingBytes += line.length
  draining ??= drain().finally(() => (draining = null))
}

async function drain(): Promise<void> {
  while (pending.length || dropped) {
    const target = file
    let text = pending.join('')
    pending = []
    pendingBytes = 0
    if (dropped) {
      text += `${new Date().toISOString()} stall log dropped ${dropped} lines while the disk was slow\n`
      dropped = 0
    }
    if (!target) return
    try {
      let log = known
      if (log?.target !== target) {
        await mkdir(join(target, '..'), { recursive: true })
        log = known = { target, bytes: await stat(target).then((s) => s.size, () => 0) }
      }
      if (log.bytes >= ROTATE_BYTES) {
        await rename(target, `${target}.1`)
        log.bytes = 0
      }
      await appendFile(target, text)
      log.bytes += Buffer.byteLength(text)
    } catch {
      // diagnostics never fail the app; the next batch stats the file again
      known = null
    }
  }
}

/** Resolves once every queued line is on disk (tests, a script reading the log it made). */
export async function flushStallLog(): Promise<void> {
  while (draining) await draining
}
