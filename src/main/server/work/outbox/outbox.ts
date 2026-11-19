import type { HeldWhy, OutboxGrant, OutboxItem } from '@shared/contract-work-outbox'
import { ACT_PILLAR, errorText, NotBuilt, PILLAR_MILESTONE, type ActKind, type ActResult, type HeldItem, type HeldRef } from '@shared/work'
import type { ActCtx, ActKindDef, WorkCtx } from '../modules'
import { ActNotSent, ActStale, type ActKinds } from './kinds'
import { itemOfRow, lifeosRunKey, PRESSABLE, type HeldRow, type HeldStore } from './store'
import { discardedNote, failedNote, sentNote, staleNote } from './words'

/**
 * The hold as one service (docs/agents/work-outbox.md): an act is held
 * (`hold`), listed, and decided by the owner (`send`, `discard`, `edit`) or
 * by a standing grant he made from a held item (`grant`). It owns the rule
 * that an act runs once, whatever asks: every send claims its row first
 * (store.ts `claim`), and only the claim's winner calls the kind's
 * `execute`.
 *
 * Mail and calendar acts are held in LifeOS, not here (`lifeos`, filled by
 * lifeosHeld.ts). They are listed with this host's rows, pressed through
 * the same `send`, and matched against the same grants; one gets a row here
 * when it is decided, and that row's run key is what makes the decision the
 * only one.
 */

type LifeosRef = Extract<HeldRef, { at: 'lifeos' }>

/** What lifeosHeld.ts answers for the items LifeOS holds. */
export interface LifeosHeld {
  /** The items LifeOS holds for this host's threads, as the watcher last read them: drafts and failed sends, whole payload included. */
  items(): OutboxItem[]
  /** One item read now from LifeOS; null when LifeOS no longer holds it. */
  read(ref: LifeosRef): Promise<OutboxItem | null>
  /** Delete the draft in LifeOS. */
  discard(ref: LifeosRef): Promise<void>
  /** Save a changed payload into the draft; answers the item as it now stands. */
  edit(ref: LifeosRef, payload: unknown): Promise<OutboxItem>
}

export interface OutboxDeps {
  ctx: WorkCtx
  store: HeldStore
  kinds: ActKinds
  /** A thread's grant scope: its Work workspace's id, `"~work"` for a Work Chat; null when it has none (a code thread, a Work thread with no Work home, a deleted thread). */
  scopeKeyOf(sessionId: string): string | null
  /** The routine a run belongs to, or null when no such run is known (the routines pillar keeps them). */
  routineOf(runId: string): string | null
  /** The thread at the top of a thread's tree: the one LifeOS links a task to. */
  rootOf(sessionId: string): string
  /** The routine run a thread acts for: its own, or the nearest above it. */
  routineRunOf(sessionId: string): string | null
  /** A line from the app to a thread that never starts a turn (SessionRegistry.whisper). */
  whisper(sessionId: string, text: string): void
  /** The held notice for a phone or a desktop; absent in a test. */
  notify?(item: OutboxItem): void
}

/** Kinds whose result the thread needs to go on: carrying one out wakes its thread with what came back. The others are told quietly, ahead of the thread's next turn. */
const WAKES: readonly ActKind[] = ['addon.call', 'computer.act']

/** What an edit may change, for the outbox's own kinds: the rest of the act is what was held and stays. */
const KEEPS: Partial<Record<ActKind, (old: unknown, next: unknown) => unknown>> = {
  'addon.call': (old, next) => ({ ...(old as object), arguments: (next as { arguments?: unknown } | null)?.arguments ?? {} })
}

export const NO_SUCH_ITEM = 'no such held item on this host'
export const CHANGED_SINCE = 'This item changed since you opened it. Look at it again before you decide.'
export const MAY_HAVE_GONE = 'This may have gone already: the last send did not say how it ended. Check Sent first, and choose Send again only if it is not there.'
export const REV_NEEDED = 'refused: a press on an item LifeOS holds names what was read (`rev`), so what goes is what was shown'

/** What `execute` left behind, small enough to keep in the row: a result too large for the log keeps its line and drops its body. */
function keepable(result: ActResult): ActResult {
  try {
    if (JSON.stringify(result).length <= 200_000) return result
  } catch {
    // not serialisable: the line alone
  }
  return { summary: result.summary }
}

export interface Held {
  row: HeldRow
  /** set when a standing grant fit: the act is being carried out now, and this settles with its row */
  released: Promise<HeldRow> | null
  grant: OutboxGrant | null
}

export class Outbox {
  /** Filled by lifeosHeld.ts when LifeOS's held items are watched; null: this host lists only its own rows. */
  lifeos: LifeosHeld | null = null
  /** What the host adds to a kind's matcher before a grant is kept (an add-on call's server), so a client cannot leave it out. */
  readonly seals = new Map<ActKind, (matcher: never, payload: never) => unknown>()
  private readonly decidedListeners = new Set<(item: HeldItem) => void>()
  private readonly changeListeners = new Set<(item: OutboxItem | null) => void>()

  constructor(private readonly deps: OutboxDeps) {
    deps.store.onChange((row) => this.changed(itemOfRow(row)))
  }

  get store(): HeldStore {
    return this.deps.store
  }

  // ── holding ───────────────────────────────────────────────────────────

  /** The kind's definition, or the milestone that builds it. */
  def(kind: ActKind): ActKindDef {
    const def = this.deps.kinds.get(kind)
    if (!def) throw new NotBuilt(`a held ${kind}`, PILLAR_MILESTONE[ACT_PILLAR[kind]])
    return def
  }

  /**
   * Hold one act for the owner's press. The payload is checked against the
   * kind's own shape, so the row holds exactly what will go. When a
   * standing grant of the thread's workspace fits, the act is claimed for
   * that grant and carried out now; `released` settles with it.
   */
  hold(act: { kind: ActKind; sessionId: string | null; payload: unknown; account?: string | null; why?: HeldWhy; origin?: string; state?: 'held' | 'live'; /** the caller answers the thread itself with what `released` brings */ inline?: boolean }): Held {
    const def = this.def(act.kind)
    if (def.store !== 'host') throw new Error(`${act.kind} is held in LifeOS, not by this host`)
    const payload = def.payload.parse(act.payload)
    const scope = act.sessionId ? this.deps.ctx.scopeOf(act.sessionId) : null
    const words = def.words(payload)
    const row = this.store.insert({
      workspaceId: scope?.workspaceId ?? null,
      sessionId: act.sessionId,
      sector: scope?.sector ?? null,
      kind: act.kind,
      origin: act.origin ?? 'app',
      why: act.why ?? 'pillar',
      summary: words.summary,
      verb: words.verb,
      account: act.account ?? null,
      payload,
      state: act.state ?? 'held',
      routineRunId: (act.sessionId ? this.deps.routineRunOf(act.sessionId) : null) ?? scope?.routineRunId ?? null
    })
    // A live act is the screen as it was read: only his press carries it out, never a grant.
    const grant = row.state === 'held' ? this.grantFor({ kind: row.kind, payload, sessionId: row.sessionId, routineRunId: row.routineRunId, createdAt: row.createdAt }, def) : null
    if (grant) {
      const claimed = this.store.claim(row.id, `grant:${grant.id}`, grant.id)
      if (claimed) return { row: claimed, released: this.run(claimed, def, { quiet: act.inline === true }), grant }
    }
    this.deps.notify?.(itemOfRow(row))
    return { row, released: null, grant: null }
  }

  /** A LifeOS-held item the watcher saw for the first time: sent now when a grant made before it fits, else told as held. */
  async offer(item: OutboxItem, opts: { quiet?: boolean } = {}): Promise<void> {
    if (item.ref.at !== 'lifeos' || this.store.byRef(item.ref)) return
    const def = this.deps.kinds.get(item.kind)
    const grant = def && item.state === 'held' ? this.grantFor({ kind: item.kind, payload: item.payload, sessionId: item.sessionId, routineRunId: item.routineRunId, createdAt: item.createdAt }, def) : null
    if (!def || !grant) return void (opts.quiet ? undefined : this.deps.notify?.(item))
    const row = this.adopt(item)
    const claimed = row && this.store.claim(row.id, `grant:${grant.id}`, grant.id)
    if (claimed) await this.run(claimed, def)
  }

  // ── the owner's decisions ─────────────────────────────────────────────

  /**
   * The press. Whoever calls it has already been checked to be a person
   * (index.ts): this only makes sure the act runs once. A press that finds
   * the row taken (sent, being sent, discarded) answers the row as it
   * stands and runs nothing.
   */
  async send(ref: HeldRef, opts: { rev?: number; by?: string; again?: boolean } = {}): Promise<OutboxItem> {
    let row = this.store.byRef(ref)
    if (ref.at === 'lifeos' && (!row || PRESSABLE.includes(row.state))) {
      // What goes is what LifeOS holds now, and only if that is what he was shown.
      if (opts.rev === undefined) throw new Error(REV_NEEDED)
      const live = await this.readLifeos(ref)
      if (live.updatedAt !== opts.rev) throw new Error(CHANGED_SINCE)
      row = row ? (this.store.edit(row.id, { payload: live.payload, summary: live.summary, verb: live.verb, account: live.account }) ?? this.store.get(row.id)) : this.adopt(live)
    }
    if (!row) throw new Error(NO_SUCH_ITEM)
    if (ref.at === 'host' && opts.rev !== undefined && row.updatedAt !== opts.rev && PRESSABLE.includes(row.state)) throw new Error(CHANGED_SINCE)
    const def = this.def(row.kind)
    // A send that may have gone is sent again only when he chose that, after checking.
    if (row.state === 'failed' && row.outcomeUnknown && !opts.again) throw new Error(MAY_HAVE_GONE)
    const claimed = this.store.claim(row.id, opts.by ?? 'owner', null, { again: opts.again === true })
    if (!claimed) return this.wire(this.store.get(row.id)!)
    return this.wire(await this.run(claimed, def))
  }

  /** The act will never go. For a LifeOS-held item the draft is deleted there, and a row here records who decided. */
  async discard(ref: HeldRef, by = 'owner'): Promise<OutboxItem> {
    let row = this.store.byRef(ref)
    if (ref.at === 'lifeos' && (!row || PRESSABLE.includes(row.state))) {
      const live = await this.readLifeos(ref)
      row ??= this.adopt(live)
      if (row && PRESSABLE.includes(row.state)) await this.lifeos!.discard(ref)
    }
    if (!row) throw new Error(NO_SUCH_ITEM)
    const gone = this.store.discard(row.id, by)
    if (gone) this.settled(gone)
    return this.wire(gone ?? this.store.get(row.id)!)
  }

  /** Change exactly what will go, while it waits. */
  async edit(ref: HeldRef, payload: unknown): Promise<OutboxItem> {
    if (ref.at === 'lifeos') {
      const row = this.store.byRef(ref)
      if (row && !PRESSABLE.includes(row.state)) throw new Error('This item was already decided; it cannot be changed.')
      if (!this.lifeos) throw new Error(NO_SUCH_ITEM)
      const next = await this.lifeos.edit(ref, payload)
      this.changed(null)
      return next
    }
    const row = this.store.byRef(ref)
    if (!row) throw new Error(NO_SUCH_ITEM)
    const def = this.def(row.kind)
    const next = def.payload.parse(KEEPS[row.kind] ? KEEPS[row.kind]!(row.payload, payload) : payload)
    const words = def.words(next)
    const edited = this.store.edit(row.id, { payload: next, summary: words.summary, verb: words.verb })
    if (!edited) throw new Error(row.state === 'live' ? 'An act read from a live screen is carried out as it was read; it cannot be changed.' : 'This item was already decided; it cannot be changed.')
    return this.wire(edited)
  }

  // ── grants ────────────────────────────────────────────────────────────

  /**
   * A standing grant, made from one held item. The matcher must fit the
   * item it is made from, so a grant is never wider than something he has
   * seen; a grant made from a routine's act fits that routine alone. Who may
   * call this is checked in index.ts: a person with admin, never a model.
   */
  async grant(from: HeldRef, matcher: unknown, opts: { label?: string; routine?: boolean } = {}): Promise<OutboxGrant> {
    const row = this.store.byRef(from)
    const item = row ? itemOfRow(row) : from.at === 'lifeos' ? await this.readLifeos(from) : null
    if (!item) throw new Error(NO_SUCH_ITEM)
    if (item.state === 'discarded' || item.state === 'stale') throw new Error('refused: a grant is made from an item that waits or went, not from one that was dropped')
    const def = this.def(item.kind)
    if (!def.matcher || !def.matches) throw new Error(`refused: ${item.kind} is always held; no grant can be made for it`)
    const payload = def.payload.parse(item.payload)
    const seal = this.seals.get(item.kind)
    const parsed = seal ? def.matcher.parse(seal(def.matcher.parse(matcher) as never, payload as never)) : def.matcher.parse(matcher)
    if (!def.matches(parsed, payload)) throw new Error('refused: a grant must fit the item it is made from')
    const scope = item.sessionId ? this.deps.scopeKeyOf(item.sessionId) : null
    if (!scope) throw new Error('refused: this item belongs to no Work workspace, so no grant can be made from it')
    // A routine's act gives a grant for that routine alone, whatever was asked: no agent's run widens into every thread.
    const routineId = item.routineRunId ? this.deps.routineOf(item.routineRunId) : null
    if (item.routineRunId && !routineId) throw new Error("refused: this item's routine is not known on this host, so no grant can be made from it")
    if (opts.routine && !routineId) throw new Error('refused: this item was not made by a routine')
    const label = (opts.label ?? '').trim() || `Like: ${item.summary}`
    return this.store.addGrant({ workspaceId: scope, kind: item.kind, matcher: parsed, label: label.slice(0, 200), madeFrom: item.ref, routineId })
  }

  ungrant(id: string): OutboxGrant {
    const grant = this.store.removeGrant(id)
    if (!grant) throw new Error('no such grant on this host')
    return grant
  }

  /**
   * The standing grant an act fits, or null. Same rule for this host's rows
   * and LifeOS-held items: the grant is of the act's own workspace and kind,
   * was made before the act, and its matcher fits the act's payload. A
   * routine's act fits only that routine's grants; any other thread's act
   * fits only grants that name no routine.
   */
  grantFor(act: { kind: ActKind; payload: unknown; sessionId: string | null; routineRunId: string | null; createdAt: number }, def: ActKindDef): OutboxGrant | null {
    if (!def.matcher || !def.matches || !act.sessionId) return null
    const scope = this.deps.scopeKeyOf(act.sessionId)
    if (!scope) return null
    const routineId = act.routineRunId ? this.deps.routineOf(act.routineRunId) : null
    if (act.routineRunId && !routineId) return null
    const payload = def.payload.safeParse(act.payload)
    if (!payload.success) return null
    for (const grant of this.store.grants({ workspaceId: scope })) {
      if (grant.kind !== act.kind || (grant.routineId ?? null) !== routineId || grant.createdAt > act.createdAt) continue
      const matcher = def.matcher.safeParse(grant.matcher)
      try {
        if (matcher.success && def.matches(matcher.data, payload.data)) return grant
      } catch {
        // a matcher that throws fits nothing
      }
    }
    return null
  }

  // ── reading ───────────────────────────────────────────────────────────

  /** This host's rows and the LifeOS-held items nobody here decided, as one list. */
  list(q: { show?: 'waiting' | 'decided' | 'all'; workspaceId?: string; sessionId?: string; limit?: number } = {}): { items: OutboxItem[]; waiting: number } {
    const show = q.show ?? 'waiting'
    const rows = this.store.list(q).map((row) => this.wire(row))
    const held = show === 'decided' ? [] : this.undecided().filter((i) => (q.workspaceId === undefined || i.workspaceId === q.workspaceId) && (q.sessionId === undefined || i.sessionId === q.sessionId))
    const items = [...rows, ...held]
    if (show === 'waiting') items.sort((a, b) => a.createdAt - b.createdAt)
    return { items: items.slice(0, q.limit ?? 200), waiting: this.waiting() }
  }

  async get(ref: HeldRef): Promise<OutboxItem> {
    const row = this.store.byRef(ref)
    if (row && (ref.at === 'host' || !PRESSABLE.includes(row.state))) return this.wire(row)
    if (ref.at === 'lifeos') return this.readLifeos(ref)
    throw new Error(NO_SUCH_ITEM)
  }

  /** How many items wait on the owner: this host's and LifeOS's. */
  waiting(): number {
    return this.store.waiting() + this.undecided().length
  }

  /** LifeOS-held items with no decision recorded here. One whose send failed here is listed from its row. */
  private undecided(): OutboxItem[] {
    return (this.lifeos?.items() ?? []).filter((item) => !this.store.byRef(item.ref))
  }

  /** A row as a screen gets it: a kind's payload is its own to trim (a picture's file path never leaves the host). */
  wire(row: HeldRow): OutboxItem {
    const item = itemOfRow(row)
    const payload = item.payload as { picture?: { path?: string } | null } | null
    if (row.kind === 'computer.act' && payload?.picture && typeof payload.picture === 'object') {
      const { path: _path, ...picture } = payload.picture
      return { ...item, payload: { ...payload, picture } }
    }
    return item
  }

  // ── listeners ─────────────────────────────────────────────────────────

  /** A held act reached its end: sent, failed, discarded or stale. */
  onDecided(fn: (item: HeldItem) => void): () => void {
    this.decidedListeners.add(fn)
    return () => this.decidedListeners.delete(fn)
  }

  /** Anything a list would show differently: a row moved (its item), or LifeOS's held items did (null). */
  onChange(fn: (item: OutboxItem | null) => void): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  changed(item: OutboxItem | null): void {
    for (const fn of [...this.changeListeners]) {
      try {
        fn(item)
      } catch (err) {
        this.deps.ctx.log(`outbox: a listener failed: ${errorText(err)}`)
      }
    }
  }

  // ── carrying an act out ───────────────────────────────────────────────

  private async readLifeos(ref: LifeosRef): Promise<OutboxItem> {
    const live = this.lifeos ? await this.lifeos.read(ref) : null
    if (!live) throw new Error('LifeOS no longer holds that item')
    return live
  }

  /** The row that records a decision on a LifeOS-held item. Its run key is unique: a second one for the same item finds the first. */
  private adopt(item: OutboxItem): HeldRow | null {
    if (item.ref.at !== 'lifeos') return null
    const runKey = lifeosRunKey(item.ref.table, item.ref.id)
    try {
      return this.store.insert({
        workspaceId: item.workspaceId,
        sessionId: item.sessionId,
        sector: item.sector,
        kind: item.kind,
        origin: `lifeos:${item.ref.table}/${item.ref.id}`,
        why: 'lifeos',
        summary: item.summary,
        verb: item.verb,
        account: item.account,
        payload: item.payload,
        runKey,
        routineRunId: item.routineRunId,
        createdAt: item.createdAt
      })
    } catch {
      return this.store.byRunKey(runKey)
    }
  }

  /** Carry out a claimed row: once, by the claim's winner. Never throws; the row says how it ended. `quiet`: the caller answers the thread itself. */
  private async run(row: HeldRow, def: ActKindDef, opts: { quiet?: boolean } = {}): Promise<HeldRow> {
    const decidedBy = (row.decidedBy?.startsWith('grant:') ? row.decidedBy : 'owner') as ActCtx['decidedBy']
    let end: HeldRow | null
    let result: ActResult | null = null
    let started = false
    try {
      const payload = def.payload.parse(row.payload)
      const ctx: ActCtx = { ...this.deps.ctx, item: itemOfRow(row), decidedBy }
      started = true
      result = await def.execute(payload, ctx)
      end = this.store.settle(row.id, 'sent', { result: keepable(result) })
    } catch (err) {
      // Unless the kind says nothing went, a failed send may have gone (a timeout, a lost answer). A LifeOS row is the
      // exception: LifeOS holds what became of it, and its kind reads that before it sends again.
      const unknown = started && !(err instanceof ActNotSent) && def.store !== 'lifeos'
      end = err instanceof ActStale ? this.store.settle(row.id, 'stale', { error: err.message }) : this.store.settle(row.id, 'failed', { error: errorText(err), unknown })
    }
    const last = end ?? this.store.get(row.id)!
    this.settled(last, result, opts.quiet)
    return last
  }

  /** What follows an end: the linked task, the thread, the listeners. */
  private settled(row: HeldRow, result: ActResult | null = null, quiet = false): void {
    // A send completes the thread's linked task, with the reason and the thread link. A call held only because its
    // add-on was never reviewed is no send, so it completes nothing.
    if (row.state === 'sent' && row.sessionId && row.why !== 'unreviewed') {
      this.store.oweTask(row.id)
      void this.completeTasks()
    }
    if (!quiet && row.sessionId) this.tell(row, result)
    const item = itemOfRow(row)
    for (const fn of [...this.decidedListeners]) {
      try {
        fn(item)
      } catch (err) {
        this.deps.ctx.log(`outbox: a listener failed: ${errorText(err)}`)
      }
    }
  }

  /** The tasks owed a completion: tried now, kept for the next try while LifeOS cannot be reached. */
  async completeTasks(): Promise<void> {
    let owed: HeldRow[]
    try {
      owed = this.store.owedTasks()
    } catch (err) {
      // The hold's tables could not be made on this host (the pillar's fault is said where its methods answer).
      return void this.deps.ctx.log(`outbox: the owed tasks could not be read: ${errorText(err)}`)
    }
    for (const row of owed) {
      if (!row.sessionId) {
        this.store.taskDone(row.id)
        continue
      }
      try {
        await this.deps.ctx.links.completeFor(this.deps.rootOf(row.sessionId), `Sent: ${row.summary}`.slice(0, 300))
        this.store.taskDone(row.id)
      } catch (err) {
        // Signed out or unreachable: the row stays owed, and the next send or the next start tries again.
        this.deps.ctx.log(`outbox: the task linked to item ${row.n} was not completed: ${errorText(err)}`)
        return
      }
    }
  }

  /** The thread hears how its act ended, as the app's own note. */
  private tell(row: HeldRow, result: ActResult | null): void {
    const sessionId = row.sessionId!
    try {
      if (row.state === 'sent') {
        const detail = WAKES.includes(row.kind) ? textOf(result) : undefined
        const note = sentNote(row, detail)
        if (WAKES.includes(row.kind)) void this.deps.ctx.threads.resume(sessionId, note).catch(() => this.deps.whisper(sessionId, note))
        else this.deps.whisper(sessionId, note)
      } else if (row.state === 'failed') this.deps.whisper(sessionId, failedNote(row))
      else if (row.state === 'discarded') this.deps.whisper(sessionId, discardedNote(row))
      else if (row.state === 'stale') this.deps.whisper(sessionId, staleNote(row))
    } catch (err) {
      this.deps.ctx.log(`outbox: thread ${sessionId} was not told of item ${row.n}: ${errorText(err)}`)
    }
  }
}

/** The text a result carries for its thread: an add-on call's text parts, a computer act's lines. */
export function textOf(result: ActResult | null): string | undefined {
  const ref = result?.ref as { content?: unknown; text?: unknown } | undefined
  if (typeof ref?.text === 'string') return ref.text
  if (Array.isArray(ref?.content))
    return ref.content
      .flatMap((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []))
      .join('\n')
  return undefined
}
