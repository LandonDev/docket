import type { Store } from './db'
import type { SessionRegistry } from './sessions'
import type { bootStamps } from './stalls'

/**
 * Threads cut mid-turn by a shutdown come back at the next boot.
 *
 * The record is the `resume_after_boot` ledger: `SessionRegistry.append`
 * writes a thread's row on every running status and clears it when the turn
 * settles, and `recordForResume` (before-quit, the signal handlers) stamps
 * the shutdown's time on the rows when it gets to run; a death that skips it
 * (Chromium aborts on the D-Bus disconnect when systemd signals the whole
 * group, a SIGKILL, a power cut) leaves the right set behind all the same.
 * This side runs once the servers and the gateway are up: every recorded
 * thread gets a fresh harness on its transcript and one nudge saying the
 * host restarted (at the shutdown's time when known, else when this boot
 * ran), through the same `resumeStopped` the strip's Resume button uses. Four boot at a time, each
 * worker pausing a little between its threads, so fifty threads do not
 * start in one instant; subagents go before their parents, so an
 * orchestrator wakes to a fleet already moving. A thread the user paused
 * stays paused, and a thread that is gone is just forgotten. The running
 * cap (admission.ts) holds here too: once the host is full, the rest are
 * left `queued` with their nudge stored and the scheduler starts them oldest
 * first as slots free (`queueResume`); their ledger rows stay, so another
 * restart meanwhile brings them back the same way.
 *
 * At boot no window is connected, so the order above is by depth and age
 * alone. When a window says which thread it shows (`session.focus`, `prefer`)
 * while threads still wait here, those threads and the threads above them
 * move to the front of what has not started; the rest keep their order, the
 * width, the gap and the cap. A thread already started, or a call once the
 * run is over, changes nothing.
 *
 * The result feeds one toast per boot in the rail ("7 threads resumed
 * after restart"): `notice` is what a socket connecting later is told, and
 * `onDone` what the sockets already open hear.
 */
export interface BootResumeResult {
  resumed: string[]
  /** Past the running cap: queued with the nudge, started as slots free. */
  queued: string[]
  /** Paused, archived, or no longer there. */
  skipped: string[]
  /** The harness did not boot or refused the nudge; the row reads error. */
  failed: string[]
  /** When this boot ran the resume; the key the renderer dedupes the toast by. */
  at: number
}

export interface BootResumeNotice {
  count: number
  at: number
}

export interface BootResumerDeps {
  store: Pick<Store, 'listResumeAfterBoot' | 'clearResumeAfterBoot' | 'getSession'>
  registry: Pick<SessionRegistry, 'resumeStopped' | 'resumePending'> &
    Partial<Pick<SessionRegistry, 'bootResumeRoom' | 'queueResume'>>
  /** How many harnesses boot at once. */
  width?: number
  /** The pause a worker takes between two of its threads. */
  gapMs?: number
  now?: () => number
  log?: (line: string) => void
  stampBoot?: ReturnType<typeof bootStamps>
}

export const BOOT_RESUME_WIDTH = 4
export const BOOT_RESUME_GAP_MS = 750

export class BootResumer {
  private readonly listeners = new Set<(notice: BootResumeNotice) => void>()
  private done: BootResumeNotice | null = null
  private running: Promise<BootResumeResult> | null = null
  /** What waits, in order, and how many of them have started. */
  private queue: { id: string; recordedAt: number; restartedAt: number; depth: number }[] = []
  private next = 0
  /** Threads a window showed before the queue was made. */
  private readonly wanted = new Set<string>()

  constructor(private readonly deps: BootResumerDeps) {}

  /** The finished boot's notice, null before it ran and when nothing was resumed. */
  get notice(): BootResumeNotice | null {
    return this.done
  }

  onDone(listener: (notice: BootResumeNotice) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * A window shows these threads: each, with the threads above it, goes to the front of what has not started,
   * the shown thread before its parents. Returns how many waiting threads moved ahead of another.
   */
  prefer(ids: Iterable<string>): number {
    const first: string[] = []
    for (const id of ids) {
      for (let cursor: string | null = id, hops = 0; cursor && hops < 32; hops++) {
        if (!first.includes(cursor)) first.push(cursor)
        cursor = this.deps.store.getSession(cursor)?.parentId ?? null
      }
    }
    for (const id of first) this.wanted.add(id)
    const waiting = this.queue.slice(this.next)
    const ahead = first.flatMap((id) => waiting.filter((item) => item.id === id))
    if (!ahead.length) return 0
    const rest = waiting.filter((item) => !ahead.includes(item))
    const order = [...ahead, ...rest]
    const moved = order.filter((item, i) => item !== waiting[i]).length
    this.queue.splice(this.next, waiting.length, ...order)
    return moved
  }

  /** Resume everything recorded. Runs once; a second call returns the first run. */
  run(): Promise<BootResumeResult> {
    if (!this.running) this.running = this.resumeAll()
    return this.running
  }

  private async resumeAll(): Promise<BootResumeResult> {
    const { store, registry, stampBoot } = this.deps
    const now = this.deps.now ?? Date.now
    const log = this.deps.log ?? ((line: string) => console.log(line))
    const at = now()
    const result: BootResumeResult = { resumed: [], queued: [], skipped: [], failed: [], at }
    const rows = store.listResumeAfterBoot()
    if (rows.length === 0) {
      stampBoot?.('resumed', 0)
      return result
    }

    // Decide what still qualifies before any harness boots; the rest is
    // cleared at once so a restart mid-resume never replays it.
    const queue = this.queue
    for (const row of rows) {
      const meta = store.getSession(row.sessionId)
      if (!meta || meta.archived || meta.status === 'paused') {
        result.skipped.push(row.sessionId)
        continue
      }
      let depth = 0
      for (let cursor = meta; cursor.parentId; depth++) {
        const parent = store.getSession(cursor.parentId)
        if (!parent) break
        cursor = parent
      }
      queue.push({ id: row.sessionId, recordedAt: row.recordedAt, restartedAt: row.shutdownAt ?? at, depth })
    }
    store.clearResumeAfterBoot(result.skipped)
    // Deepest first (a subagent before its orchestrator), oldest record first within a depth.
    queue.sort((a, b) => b.depth - a.depth || a.recordedAt - b.recordedAt)
    // What a window already showed while this boot was getting here.
    if (this.wanted.size) this.prefer([...this.wanted])
    for (const item of queue) registry.resumePending.add(item.id)
    log(`[resume] ${queue.length} thread(s) were mid-turn at the last shutdown; resuming ${Math.min(this.deps.width ?? BOOT_RESUME_WIDTH, queue.length)} at a time`)

    const width = Math.max(1, this.deps.width ?? BOOT_RESUME_WIDTH)
    const gapMs = this.deps.gapMs ?? BOOT_RESUME_GAP_MS
    let lastResumedAt: number | undefined
    const worker = async (): Promise<void> => {
      while (this.next < queue.length) {
        const item = queue[this.next++]!
        // A slot under the cap, not counting the threads still waiting here
        // (their rows say running with no harness behind them yet).
        const room = registry.bootResumeRoom?.([item.id, ...queue.slice(this.next).map((q) => q.id)]) ?? Number.POSITIVE_INFINITY
        if (room <= 0 && registry.queueResume) {
          registry.queueResume(item.id, item.restartedAt)
          result.queued.push(item.id)
          continue
        }
        try {
          // A resumed thread writes its own fresh row (it is mid-turn again);
          // a skipped or failed one settled its row through its status.
          const resumed = await registry.resumeStopped(item.id, { restartedAt: item.restartedAt })
          ;(resumed ? result.resumed : result.skipped).push(item.id)
          if (resumed && stampBoot) {
            lastResumedAt = process.uptime() * 1000
            if (result.resumed.length === 1) stampBoot('resumed-first', undefined, lastResumedAt)
          }
          if (!resumed) store.clearResumeAfterBoot([item.id])
        } catch (error) {
          result.failed.push(item.id)
          store.clearResumeAfterBoot([item.id])
          log(`[resume] ${item.id} did not come back: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          registry.resumePending.delete(item.id)
        }
        if (this.next < queue.length && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
      }
    }
    await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker))
    stampBoot?.('resumed', result.resumed.length, lastResumedAt)

    log(`[resume] ${result.resumed.length} resumed, ${result.queued.length} queued at the cap, ${result.skipped.length} skipped, ${result.failed.length} failed`)
    if (result.resumed.length > 0) {
      this.done = { count: result.resumed.length, at }
      for (const listener of this.listeners) listener(this.done)
    }
    return result
  }
}
