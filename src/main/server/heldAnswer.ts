/**
 * Answers a window asks for on connect and on focus, held by key so the
 * ask never waits on the work behind it (docs/box.md "Answers under load").
 *
 * A key the host already answered gets that answer at once, and a refresh
 * starts behind it (one per key at a time, none while the held answer is
 * younger than `freshMs`). A key never answered waits for its first
 * answer at most `waitMs`, then gets `fallback()`. When a refresh lands
 * with an answer that differs from what the window was given, `onFresh`
 * tells it to ask again (a push), and the next ask reads the new answer.
 *
 * Why: on 2026-11-23 at load 30 a `checkpoint.status` that costs 30 ms
 * and five git children waited 108 s, and `commands.list` 104 s, behind
 * the bulk lane, the thread's checkpoint chain, the child budgets and a
 * thread pool that agents' own work kept full. The work still runs; only
 * the window no longer waits for it.
 */

export interface HeldAnswersOptions<V> {
  /** How long an ask with nothing held waits for the first answer. */
  waitMs: number
  /** What that ask gets when the first answer is later than `waitMs`. */
  fallback: () => V
  /** A held answer this young is given without a refresh behind it. */
  freshMs?: number
  /** Called with the key when a refresh changes what windows were given. */
  onFresh?: (key: string, value: V) => void
  /** Same answer (no push); JSON equality by default. */
  equal?: (a: V, b: V) => boolean
  /** Most keys held; the oldest-asked go first. */
  max?: number
  now?: () => number
}

interface Held<V> {
  value: V
  at: number
}

export const HELD_WAIT_MS = 250
const DEFAULT_MAX = 500

export class HeldAnswers<V> {
  private readonly held = new Map<string, Held<V>>()
  private readonly inFlight = new Map<string, Promise<V>>()
  /** Keys whose ask got the fallback: their first answer is told. */
  private readonly owed = new Set<string>()
  private readonly now: () => number

  constructor(private readonly options: HeldAnswersOptions<V>) {
    this.now = options.now ?? (() => Date.now())
  }

  /** The answer for `key`: held at once, else the first within the bound. */
  get(key: string, compute: () => Promise<V>): Promise<V> {
    const held = this.held.get(key)
    if (held) {
      // Asked again: keep it among the newest when the map trims.
      this.held.delete(key)
      this.held.set(key, held)
      if (this.now() - held.at >= (this.options.freshMs ?? 0)) void this.refresh(key, compute).catch(() => {})
      return Promise.resolve(held.value)
    }
    const run = this.refresh(key, compute)
    let timer: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<V>((resolve) => {
      timer = setTimeout(() => {
        this.owed.add(key)
        resolve(this.options.fallback())
      }, this.options.waitMs)
      ;(timer as { unref?: () => void }).unref?.()
    })
    return Promise.race([run, late]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  /** The value the host now knows for `key` (an undo's own answer): held without a refresh. */
  set(key: string, value: V): void {
    this.keep(key, value)
  }

  /** The next ask of `key` refreshes behind the held answer whatever its age. */
  stale(key: string): void {
    const held = this.held.get(key)
    if (held) held.at = Number.NEGATIVE_INFINITY
  }

  forget(key: string): void {
    this.held.delete(key)
    this.owed.delete(key)
  }

  /** One refresh per key; the held answer moves when it lands. */
  private refresh(key: string, compute: () => Promise<V>): Promise<V> {
    const running = this.inFlight.get(key)
    if (running) return running
    const run = compute().then((value) => {
      const before = this.held.get(key)
      this.keep(key, value)
      const told = this.owed.delete(key)
      const equal = this.options.equal ?? sameJson
      if (told || (before && !equal(before.value, value))) this.options.onFresh?.(key, value)
      return value
    })
    const settled = run.finally(() => {
      if (this.inFlight.get(key) === settled) this.inFlight.delete(key)
    })
    this.inFlight.set(key, settled)
    return settled
  }

  private keep(key: string, value: V): void {
    this.held.delete(key)
    this.held.set(key, { value, at: this.now() })
    const max = this.options.max ?? DEFAULT_MAX
    while (this.held.size > max) {
      const oldest = this.held.keys().next().value as string
      this.held.delete(oldest)
    }
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
