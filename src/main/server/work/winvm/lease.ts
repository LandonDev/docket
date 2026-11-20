/**
 * Who uses the Windows VM (docs/agents/work-winvm.md "One thread at a time"):
 * one thread holds it from its first call until two minutes after its turn
 * ends, so two threads never drive the one desktop at once. A thread's
 * subagents use it as the thread itself does (`pane`). Another thread's call
 * is answered with the holder's title and that thread is woken with a notice
 * once the machine is free. His Take over (B8) outranks every thread: while
 * he drives, every thread's call is refused.
 */

export const LEASE_AFTER_TURN_MS = 120_000

export const vmInUseLine = (title: string): string =>
  `The Windows VM is in use by '${title}'. Do not call the windows_* tools again this turn; end your turn and say where you will pick up. You are told when it is free.`
export const VM_FREE_NOTICE = 'The Windows VM is free now. Read it again before you act (windows_observe), then carry on.'
export const VM_OWNER_DRIVES = 'He is driving the Windows VM now. Do not use the windows_* tools until he hands it back; end your turn and say where you will pick up.'

export interface LeaseClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
const REAL: LeaseClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
}

export interface LeaseOptions {
  /** a thread's pane: its root, whose subagents share its hold */
  pane(threadId: string): string
  title(threadId: string): string
  /** a waiting thread is woken with a notice (Work's `ctx.threads.resume`) */
  wake(threadId: string, notice: string): void
  clock?: LeaseClock
}

export class VmLease {
  private holder: { pane: string; settledAt: number | null } | null = null
  private timer: unknown = null
  private readonly waiting = new Set<string>()
  private owner = false
  private readonly clock: LeaseClock

  constructor(private readonly o: LeaseOptions) {
    this.clock = o.clock ?? REAL
  }

  /** Takes or keeps the machine for this thread's call; the line that refuses it otherwise. */
  take(threadId: string): string | null {
    if (this.owner) return VM_OWNER_DRIVES
    const pane = this.o.pane(threadId)
    if (this.holder && this.holder.pane !== pane) {
      this.waiting.add(threadId)
      return vmInUseLine(this.o.title(this.holder.pane))
    }
    this.clear()
    this.holder = { pane, settledAt: null }
    return null
  }

  /** The thread whose pane holds the machine, or null. */
  holderPane(): string | null {
    return this.holder?.pane ?? null
  }

  /**
   * A thread's turn changed: a holder whose turn settled keeps the machine for two more minutes, and one that
   * works again keeps it on. A pane is settled only when its own root thread is (its subagents settle inside it).
   */
  turn(threadId: string, settled: boolean): void {
    if (!this.holder || this.holder.pane !== threadId) return
    if (!settled) {
      this.holder.settledAt = null
      this.clear()
      return
    }
    if (this.holder.settledAt !== null) return
    this.holder.settledAt = this.clock.now()
    this.clear()
    this.timer = this.clock.setTimeout(() => this.release(), LEASE_AFTER_TURN_MS)
  }

  /** The holder is gone for good (the thread deleted): the machine is free now. */
  ended(threadIds: string[]): void {
    for (const id of threadIds) this.waiting.delete(id)
    if (this.holder && threadIds.includes(this.holder.pane)) this.release()
  }

  /** His Take over (`computer.drive` on `vm:windows`, B8): while on, no thread uses the machine; off, it is free. */
  ownerDrives(on: boolean): void {
    this.owner = on
    if (on) {
      this.clear()
      this.holder = null
    } else this.release()
  }

  owns(): boolean {
    return this.owner
  }

  /** Frees the machine and wakes every thread that was turned away. */
  release(): void {
    this.clear()
    this.holder = null
    if (this.owner) return
    const woken = [...this.waiting]
    this.waiting.clear()
    for (const id of woken) this.o.wake(id, VM_FREE_NOTICE)
  }

  private clear(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }
}
