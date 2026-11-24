import {
  AWAY_OFF_STATE,
  AwayDecidedSchema,
  AwayStateSchema,
  anyAway,
  awayKindsChanged,
  awayKindsOf,
  awayStampsOf,
  awayStateOf,
  mergeAway,
  type AwayDecided,
  type AwayKind,
  type AwayKinds,
  type AwayState
} from '@shared/away'
import type { AwaySnapshot } from '@shared/contract-away'

export const AWAY_SETTING = 'away'
export const AWAY_DECIDED_SETTING = 'away:decided'
/** The tally's write waits this long after its last count. */
export const AWAY_TALLY_MS = 1_000

export interface AwayDeps {
  getSetting(key: string): string | null
  setSetting(key: string, value: string | null): void
  environmentId: string
  now?: () => number
}

const parse = <T>(raw: string | null, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): T | null => {
  if (!raw) return null
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? (parsed.data as T) : null
  } catch {
    return null
  }
}

/** What a flip asks for: `code` and `work` each set their own kind and leave the other; `enabled` (an older client's) sets both, and only when neither kind is named. */
export interface AwayFlip {
  enabled?: boolean
  code?: boolean
  work?: boolean
}

/** The kinds a flip leaves on, from the kinds on now. */
export const flipKinds = (now: AwayKinds, flip: AwayFlip): AwayKinds => {
  if (flip.code === undefined && flip.work === undefined) return flip.enabled === undefined ? now : { code: flip.enabled, work: flip.enabled }
  return { code: flip.code ?? now.code, work: flip.work ?? now.work }
}

/** A listener hears the snapshot and the kinds whose switch changed (none: a tally write). */
export type AwayListener = (snapshot: AwaySnapshot, changed: AwayKind[]) => void

/**
 * Away from computer on this host: the state (`away`, one switch per kind
 * of thread) and the stretch's tally of decisions per thread
 * (`away:decided`), both in the settings table. `set` is the person's flip,
 * stamped here; `apply` is a peer's, taken only when newer
 * (remote/awaySync.ts). Every change, and every tally write, reaches the
 * listeners: the sockets' `away` push and the registry. A row written by an
 * older build (`enabled` alone) reads as both kinds at that value.
 */
export class AwayService {
  private state: AwayState
  private decided: AwayDecided
  private readonly listeners = new Set<AwayListener>()
  private tallyTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(private readonly deps: AwayDeps) {
    this.now = deps.now ?? Date.now
    const stored = parse<AwayState>(deps.getSetting(AWAY_SETTING), AwayStateSchema) ?? AWAY_OFF_STATE
    this.state = awayStateOf(awayKindsOf(stored), stored.at, stored.by, awayStampsOf(stored))
    this.decided = parse<AwayDecided>(deps.getSetting(AWAY_DECIDED_SETTING), AwayDecidedSchema) ?? { since: 0, threads: [] }
  }

  /** Whether threads of this kind are away. There is no "is he away" without a kind: ask per thread (`awayKindOf` its scope). */
  on(kind: AwayKind): boolean {
    return awayKindsOf(this.state)[kind]
  }

  kinds(): AwayKinds {
    return awayKindsOf(this.state)
  }

  get(): AwaySnapshot {
    return { state: this.state, decided: this.decided }
  }

  /** The person's flip. A flip that leaves every kind as it was changes nothing. */
  set(flip: AwayFlip): AwayState {
    const next = flipKinds(this.kinds(), flip)
    const now = this.kinds()
    if (next.code === now.code && next.work === now.work) return this.state
    const at = this.now()
    const stamps = awayStampsOf(this.state)
    for (const kind of awayKindsChanged(this.state, awayStateOf(next, at, ''))) stamps[kind] = at
    this.take(awayStateOf(next, at, this.deps.environmentId, stamps))
    return this.state
  }

  /** A peer's state, merged kind by kind: each kind taken when its stamp is newer than this host's (`mergeAway`). An older peer's `enabled` alone is both kinds, stamped `at`. */
  apply(incoming: AwayState): boolean {
    const state = mergeAway(this.state, incoming)
    if (state.at === this.state.at && state.codeAt === this.state.codeAt && state.workAt === this.state.workAt) return false
    if (!awayKindsChanged(this.state, state).length) {
      // Same value, newer stamp: keep the stamp so the hosts agree, tell nobody.
      this.state = state
      this.deps.setSetting(AWAY_SETTING, JSON.stringify(state))
      return false
    }
    this.take(state)
    return true
  }

  /** One decision (an away notice) on `sessionId`, written within a second. */
  count(sessionId: string): void {
    const threads = this.decided.threads.map((t) => (t.sessionId === sessionId ? { ...t, count: t.count + 1 } : t))
    if (!threads.some((t) => t.sessionId === sessionId)) threads.push({ sessionId, count: 1 })
    this.decided = { since: this.decided.since, threads }
    if (this.tallyTimer) return
    this.tallyTimer = setTimeout(() => {
      this.tallyTimer = null
      this.writeTally()
      this.emit([])
    }, AWAY_TALLY_MS)
  }

  onChange(listener: AwayListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.tallyTimer) {
      clearTimeout(this.tallyTimer)
      this.tallyTimer = null
      this.writeTally()
    }
    this.listeners.clear()
  }

  private take(state: AwayState): void {
    const changed = awayKindsChanged(this.state, state)
    const wasAway = anyAway(this.state)
    this.state = state
    this.deps.setSetting(AWAY_SETTING, JSON.stringify(state))
    // A stretch runs while any kind is away: the first kind on starts its own
    // tally, a second kind joins it, and the last one off keeps it for the
    // return toast.
    if (!wasAway && anyAway(state)) {
      if (this.tallyTimer) clearTimeout(this.tallyTimer)
      this.tallyTimer = null
      this.decided = { since: state.at, threads: [] }
      this.writeTally()
    }
    this.emit(changed)
  }

  private writeTally(): void {
    this.deps.setSetting(AWAY_DECIDED_SETTING, JSON.stringify(this.decided))
  }

  private emit(changed: AwayKind[]): void {
    const snapshot = this.get()
    for (const listener of this.listeners) listener(snapshot, changed)
  }
}
