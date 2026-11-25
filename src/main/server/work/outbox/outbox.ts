import type { Decision, DecisionResult, GrantOffer, HeldWhy, OutboxChanged, OutboxGrant, OutboxItem, OutboxReplied } from '@shared/contract-work-outbox'
import { hasFormLink, payloadText } from '@shared/work/msforms'
import { ACT_PILLAR, errorText, needsHim, NotBuilt, PILLAR_MILESTONE, type ActKind, type ActResult, type HeldItem, type HeldRef } from '@shared/work'
import type { ActCtx, ActKindDef, WorkCtx } from '../modules'
import { canonical } from '../../addonStore'
import { EARN_DAYS, earn, sameWords, wireOffer, wordsOf, type EarnedStore, type StoredOffer } from './earned'
import { effectOf } from './effects'
import type { SentFact } from './confirmed'
import { ActNotSent, ActStale, type ActKinds } from './kinds'
import { itemOfRow, lifeosRunKey, MISSED, MISSED_MS, PRESSABLE, refOfRow, type HeldRow, type HeldStore, type Via } from './store'
import { askAgainNote, discardedNote, failedNote, OUT_OF_DATE, queuedNote, sentNote, staleNote, takenBackNote, wentNote } from './words'

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

export const NO_GRANT_FROM_CONSOLE = 'refused: this act runs in a command line, which no grant may cover; it waits for your press every time'
export const NO_GRANT_FROM_FORM_LINK = "refused: this act carries a Microsoft form's link, which no grant may cover; it waits for your press every time"

/** Whether an act's payload holds a Microsoft form's link people answer at (shared/work/msforms.ts). */
const carriesFormLink = (payload: unknown): boolean => hasFormLink(payloadText(payload))

/**
 * An act no grant may cover, so it waits for his press every time and earns no offer: one the host read as no
 * grant's (a command line's, `consoleRead`; a co-author's edit), or one whose words hold a Microsoft form's link,
 * whatever its kind (`mail.send`, `chat.reply`, any later one): the link reaches people only on his press.
 */
export const notGrantable = (payload: unknown): boolean => (payload as { read?: { grantable?: unknown } | null } | null)?.read?.grantable === false || carriesFormLink(payload)

/** The refusal a grant made from such an act answers. */
export const notGrantableWords = (payload: unknown): string => (carriesFormLink(payload) ? NO_GRANT_FROM_FORM_LINK : NO_GRANT_FROM_CONSOLE)

/** What lifeosHeld.ts answers for the items LifeOS holds. */

export interface LifeosHeld {
  /** The items LifeOS holds for this host's threads, as the watcher last read them: drafts and failed sends, whole payload included. */
  items(): OutboxItem[]
  /** Whether LifeOS has answered the watch of its held mail since the watch began: until then `items()` knows nothing. */
  loaded(): boolean
  /** The same, a list each: its held mail and its calendar acts are watched apart. */
  loadedTables?(): { outbox: boolean; calendarOps: boolean }
  /** One item read now from LifeOS; null when LifeOS no longer holds it. */
  read(ref: LifeosRef): Promise<OutboxItem | null>
  /** Delete the draft in LifeOS. */
  discard(ref: LifeosRef): Promise<void>
  /** Save a changed payload into the draft; answers the item as it now stands. */
  edit(ref: LifeosRef, payload: unknown): Promise<OutboxItem>
  /** Put an item read now in place of its listed copy, and tell the screens: what they show catches up with LifeOS. */
  relist?(item: OutboxItem): void
  /** What LifeOS last said of a row stored sent (confirmed.ts): read only, it changes no state. */
  sentFact?(row: HeldRow): SentFact | undefined
  /** Send later for a held mail: LifeOS's own `compose.send` with a time, as his press; LifeOS is its only timer. */
  scheduleMail?(p: unknown, time: { at: number; zone?: string; cancelIfReply?: boolean }): Promise<void>
  /** Take a mail LifeOS holds (scheduled, or in its undo time) back to a draft; false when it is already on its way. */
  cancelMail?(id: string): Promise<boolean>
  /** A scheduled mail goes now, after LifeOS's undo time. */
  sendMailNow?(id: string): Promise<void>
  /** Another time for a scheduled mail. */
  rescheduleMail?(id: string, time: { at: number; zone?: string; cancelIfReply?: boolean }): Promise<void>
  /** LifeOS's own status of a mail row, or null when it has none. */
  mailStatus?(id: string): Promise<string | null>
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
  /** What the thread first wrote and the grants he has earned (earned.ts); absent, nothing is offered. */
  earned?: EarnedStore
}

/**
 * A matcher as its kind matches it: the people of a LifeOS mail or invite in
 * any case, spacing, order or repeat are the same people (mailGrantFits,
 * calendarGrantFits). Any other kind's matcher is compared as written.
 */
export function sameAs(kind: ActKind, matcher: unknown): unknown {
  if (!matcher || typeof matcher !== 'object' || (kind !== 'mail.send' && kind !== 'calendar.op')) return matcher
  const m = { ...(matcher as Record<string, unknown>) }
  for (const key of ['recipients', 'domains', 'attendees']) {
    if (!Array.isArray(m[key])) continue
    // As the kind matches them: an address trimmed and in lower case; a domain with its "@" taken off too. None is no list.
    const list = [...new Set((m[key] as unknown[]).map((v) => (typeof v !== 'string' ? v : key === 'domains' ? v.trim().toLowerCase().replace(/^@/, '') : v.trim().toLowerCase())))].sort()
    if (list.length) m[key] = list
    else delete m[key]
  }
  return m
}

/** A LifeOS draft first seen this long after it was made, and edited since it was made, holds words nobody can name the writer of. */
const FIRST_SIGHT_SLACK = 2_000

/** Kinds whose result the thread needs to go on: carrying one out wakes its thread with what came back. The others are told quietly, ahead of the thread's next turn. */
const WAKES: readonly ActKind[] = ['addon.call', 'computer.act']

/** What an edit may change, for the outbox's own kinds: the rest of the act is what was held and stays. */
const KEEPS: Partial<Record<ActKind, (old: unknown, next: unknown) => unknown>> = {
  'addon.call': (old, next) => ({ ...(old as object), arguments: (next as { arguments?: unknown } | null)?.arguments ?? {} })
}

/** What a calendar act shows of its event, as one string: the press refuses a change to any of it. */
type EventShown = { eventTitle?: string; eventStartsAt?: number; eventEndsAt?: number; eventLocation?: string }
export const shownEvent = (p: EventShown | null | undefined): string =>
  JSON.stringify([p?.eventTitle ?? null, p?.eventStartsAt ?? null, p?.eventEndsAt ?? null, p?.eventLocation ?? null])

/** Kinds whose payload, edited here, is what goes. The renderer's Edit follows the same list (work/outbox/model.ts EDITABLE). */
export const EDITABLE_KINDS: readonly ActKind[] = ['mail.send', 'addon.call', 'teams.post', 'office.mail.send', 'chat.reply']
export const NOT_EDITABLE = 'This act cannot be changed here; change it where it was made, and it is held again.'
export const NO_SUCH_ITEM = 'no such held item on this host'
export const CHANGED_SINCE = 'This item changed since you opened it. Look at it again before you decide.'
/** A mail he scheduled was his press already: the Outbox neither sends nor discards it, only Cancel send takes it back. */
export const SCHEDULED_BY_HIM = 'You scheduled this: it goes at its time. Cancel send takes it back.'
export const MAY_HAVE_GONE = 'This may have gone already: the last send did not say how it ended. Check Sent first, and choose Send again only if it is not there.'
export const NO_SUCH_OFFER = 'There is no such offer on this host, or it was already decided.'
export const REV_NEEDED = 'refused: a press on an item LifeOS holds names what was read (`rev`), so what goes is what was shown'
export const NOT_OUT_OF_DATE = 'Only an item that went out of date can be asked for again.'
export const OUT_OF_DATE_SEND = 'This went out of date: discard it, or ask the thread again.'
export const OPEN_TO_SEND = 'Open to send: this one is sent from its own page, alone.'
export const NOT_LATER = 'This cannot be sent later.'
export const NOT_SCHEDULED = 'This is not scheduled.'
export const ON_ITS_WAY = 'It is already on its way and cannot be taken back.'
export const BAD_TIME = 'Pick a time at least a minute from now and within a year.'
export const TIME_PASSED = 'Its time passed before it could go. Send it now or pick another time.'
export const SCOPE_GONE = 'The thread or workspace it belonged to is gone, so it did not go.'

/**
 * The kinds that may be sent later, and whose timer runs it (docs/agents/work-outbox.md "Send later"): LifeOS keeps
 * its own for a mail it holds; the host's runs the rest. Only a kind that checks itself again when it runs is here.
 */
export const LATER: Partial<Record<ActKind, 'host' | 'lifeos'>> = { 'mail.send': 'lifeos', 'office.mail.send': 'host', 'teams.post': 'host', 'chat.reply': 'host' }
const LATER_MIN_MS = 60_000
const LATER_MAX_MS = 366 * 86_400_000
/** The longest a timer may be set for in one go (setTimeout's own limit). */
const TIMER_MAX_MS = 2 ** 31 - 1
/** How often the mail still to be taken back from LifeOS is asked about again. */
const CANCEL_DRAIN_MS = 60_000
export const TWICE = 'This item is named twice in one press.'
/** How many items of one press run at once. */
export const DECIDE_AT_ONCE = 4


/** A LifeOS reply that carries the mail it answers under its body: read whole before it goes, never from a row. */
const quotesItsMail = (item: Pick<OutboxItem, 'kind' | 'payload'>): boolean => item.kind === 'mail.send' && !!(item.payload as { quote?: unknown } | null)?.quote

/** `fn` over the list, at most `n` at once, the answers in the list's order. */
async function mapLimit<T, R>(list: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < list.length) {
      const i = next++
      out[i] = await fn(list[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker))
  return out
}

/** The run key an item's decision would carry: a host row's own, a LifeOS item's by its table and id. */
const runKeyOfRef = (ref: HeldRef): string => (ref.at === 'lifeos' ? lifeosRunKey(ref.table, ref.id) : `host:${ref.id}`)

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
  private readonly decidedListeners = new Set<(item: HeldItem, asHeld: unknown) => void>()
  private readonly changeListeners = new Set<(item: OutboxItem | null) => void>()
  /** the press under way on each item, by run key (`serial`) */
  private readonly locks = new Map<string, Promise<unknown>>()
  /** the host's one Send later timer, while Work is on (`startSchedules`) */
  private timer: ReturnType<typeof setTimeout> | null = null
  private timing = false
  /** moves on at every start and stop of the timer: a wake from an earlier Work period claims nothing */
  private period = 0

  constructor(private readonly deps: OutboxDeps) {
    deps.store.onChange((row) => this.changed(this.wire(row)))
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
    this.noteFirst(row.runKey, row.kind, payload)
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
    // What the thread wrote, unless the draft was already changed when the host first saw it (made while it was off):
    // then nobody can say whose words it holds, and its send never counts toward an earned grant.
    // One made before the run's window began is never taken up with today's words either.
    const editedAt = (item.payload as { editedAt?: unknown } | null)?.editedAt
    const fresh = item.createdAt >= Date.now() - EARN_DAYS * 86_400_000
    if (fresh && typeof editedAt === 'number' && editedAt - item.createdAt <= FIRST_SIGHT_SLACK) this.noteFirst(lifeosRunKey(item.ref.table, item.ref.id), item.kind, item.payload)
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
  async send(ref: HeldRef, opts: { rev?: number; by?: string; again?: boolean; /** one of several sent by one press */ many?: boolean; via?: Via; quiet?: (row: HeldRow) => boolean; admit?: (row: HeldRow) => string | null } = {}): Promise<OutboxItem> {
    ref = this.canonical(ref)
    return this.serial(ref, () => this.sendNow(ref, opts))
  }

  private async sendNow(ref: HeldRef, opts: { rev?: number; by?: string; again?: boolean; many?: boolean; via?: Via; quiet?: (row: HeldRow) => boolean; admit?: (row: HeldRow) => string | null }): Promise<OutboxItem> {
    let row = this.store.byRef(ref)
    if (row?.state === 'scheduled') throw new Error(SCHEDULED_BY_HIM)
    if (ref.at === 'lifeos' && (!row || PRESSABLE.includes(row.state))) {
      // What goes is what LifeOS holds now, and only if that is what he was shown.
      if (opts.rev === undefined) throw new Error(REV_NEEDED)
      const live = await this.readLifeos(ref)
      if (live.scheduledFor !== undefined) throw new Error(SCHEDULED_BY_HIM)
      // A reply that carries the mail it answers is read whole on its own page: the fresh read has the quote the list lacks.
      if (opts.many && quotesItsMail(live)) throw new Error(OPEN_TO_SEND)
      // A calendar act binds its event as it was listed to the screens: an event changed since is refused, and the listing
      // catches up (its revision moves on, so every older view is refused too) (milestone 50's hold review, 29).
      if (live.kind === 'calendar.op') {
        const listed = this.lifeos?.items().find((i) => JSON.stringify(i.ref) === JSON.stringify(ref))
        if (listed && shownEvent(listed.payload as EventShown) !== shownEvent(live.payload as EventShown)) {
          this.lifeos?.relist?.(live)
          throw new Error(CHANGED_SINCE)
        }
      }
      if (live.updatedAt !== opts.rev) throw new Error(CHANGED_SINCE)
      row = row ? (this.store.edit(row.id, { payload: live.payload, summary: live.summary, verb: live.verb, account: live.account }) ?? this.store.get(row.id)) : this.adopt(live)
    }
    if (!row) throw new Error(NO_SUCH_ITEM)
    const refused = opts.admit?.(row)
    if (refused) throw new Error(refused)
    if (ref.at === 'host' && opts.rev !== undefined && row.updatedAt !== opts.rev && PRESSABLE.includes(row.state)) throw new Error(CHANGED_SINCE)
    const def = this.def(row.kind)
    // A send that may have gone is sent again only when he chose that, after checking.
    if (row.state === 'failed' && row.outcomeUnknown && !opts.again) throw new Error(MAY_HAVE_GONE)
    // The revision he saw is part of the claim itself: a host row that moved since is never taken on this press.
    const rev = ref.at === 'host' ? opts.rev : row.updatedAt
    const claimed = this.store.claim(row.id, opts.by ?? 'owner', null, { again: opts.again === true, via: opts.via ?? null, ...(rev !== undefined ? { rev } : {}) })
    if (!claimed) {
      const now = this.store.get(row.id)!
      if (rev !== undefined && PRESSABLE.includes(now.state) && now.updatedAt !== rev) throw new Error(CHANGED_SINCE)
      return this.wire(now)
    }
    if (opts.many) this.markBatch(claimed.runKey)
    // A kind that wakes its thread with what came back still does: the thread needs it to go on.
    const quiet = !!opts.quiet?.(claimed) && !WAKES.includes(claimed.kind)
    return this.wire(await this.run(claimed, def, { quiet }))
  }

  /**
   * The act will never go. For a LifeOS-held item the draft is deleted there, and a row here records who decided. An
   * item that went out of date is put away: it stops waiting, and its thread, which heard it went stale, hears nothing more.
   */
  async discard(ref: HeldRef, by = 'owner', opts: { reason?: string; via?: Via; rev?: number; quiet?: (row: HeldRow) => boolean; admit?: (row: HeldRow) => string | null } = {}): Promise<OutboxItem> {
    ref = this.canonical(ref)
    return this.serial(ref, () => this.discardNow(ref, by, opts))
  }

  private async discardNow(ref: HeldRef, by: string, opts: { reason?: string; via?: Via; rev?: number; quiet?: (row: HeldRow) => boolean; admit?: (row: HeldRow) => string | null }): Promise<OutboxItem> {
    let row = this.store.byRef(ref)
    if (row?.state === 'scheduled') throw new Error(SCHEDULED_BY_HIM)
    if (ref.at === 'lifeos' && (!row || PRESSABLE.includes(row.state))) {
      const live = await this.readLifeos(ref)
      if (live.scheduledFor !== undefined) throw new Error(SCHEDULED_BY_HIM)
      if (opts.rev !== undefined && live.updatedAt !== opts.rev) throw new Error(CHANGED_SINCE)
      // The log records what was discarded as LifeOS holds it now, not as an earlier decision left it.
      if (row && PRESSABLE.includes(row.state)) row = this.store.edit(row.id, { payload: live.payload, summary: live.summary, verb: live.verb, account: live.account }) ?? row
      row ??= this.adopt(live)
      if (!row) throw new Error(NO_SUCH_ITEM)
      const refusedHere = opts.admit?.(row)
      if (refusedHere) throw new Error(refusedHere)
      // The row here is claimed first, so nothing of the host's can send it once he discarded it; then LifeOS deletes
      // its draft. A LifeOS that does not answer leaves a draft no press of the host's will ever send.
      const gone = this.store.discard(row.id, by, { reason: opts.reason ?? null, via: opts.via ?? null, rev: row.updatedAt })
      if (gone?.state === 'discarded') {
        try {
          await this.lifeos!.discard(ref)
        } catch (err) {
          this.deps.ctx.log(`outbox: LifeOS kept the draft of discarded item ${gone.n}: ${errorText(err)}`)
        }
        this.settled(gone, null, !!opts.quiet?.(gone))
      }
      return this.wire(gone ?? this.store.get(row.id)!)
    }
    if (!row) throw new Error(NO_SUCH_ITEM)
    const refused = opts.admit?.(row)
    if (refused) throw new Error(refused)
    const hostRev = ref.at === 'host' ? opts.rev : undefined
    if (hostRev !== undefined && row.updatedAt !== hostRev && (PRESSABLE.includes(row.state) || row.state === 'stale')) throw new Error(CHANGED_SINCE)
    const gone = this.store.discard(row.id, by, { reason: opts.reason ?? null, via: opts.via ?? null, ...(hostRev !== undefined ? { rev: hostRev } : {}) })
    if (gone?.state === 'discarded') this.settled(gone, null, !!opts.quiet?.(gone))
    return this.wire(gone ?? this.store.get(row.id)!)
  }

  /**
   * His press on an item that went out of date: put away as out of date, and its thread woken to draft it again from
   * what is true now. It may start a turn: he asked for it.
   */
  async askAgain(ref: HeldRef, by = 'owner', opts: { via?: Via } = {}): Promise<OutboxItem> {
    ref = this.canonical(ref)
    return this.serial(ref, async () => this.askAgainNow(ref, by, opts))
  }

  private askAgainNow(ref: HeldRef, by: string, opts: { via?: Via }): OutboxItem {
    const row = this.store.byRef(ref)
    if (!row) throw new Error(NO_SUCH_ITEM)
    if (row.state !== 'stale' || row.dismissedAt !== null) throw new Error(NOT_OUT_OF_DATE)
    const gone = this.store.discard(row.id, by, { reason: OUT_OF_DATE, via: opts.via ?? null })
    if (!gone) return this.wire(this.store.get(row.id)!)
    if (gone.sessionId) {
      const sessionId = gone.sessionId
      const note = askAgainNote(gone)
      void this.deps.ctx.threads.resume(sessionId, note).catch(() => this.deps.whisper(sessionId, note))
    }
    return this.wire(gone)
  }

  /**
   * The one decision service (docs/agents/work-outbox.md "One press, many items"): each item runs through the same
   * send, discard or schedule a single press does, four at a time, and answers its own result. Whether the press is
   * "many" is the host's call: more than one item, or `many` from the caller (a thread's request always is). Some
   * items are judged here, not by the screen: an item out of date is Discard and Ask again only; a live screen's act,
   * a computer act and a LifeOS reply that quotes the mail it answers go only from their own detail, alone.
   */
  async decide(
    items: readonly Decision[],
    opts: {
      by: string
      via?: Via
      many?: boolean
      /** items whose own note to their thread is left out: a thread's request tells its thread once for the whole press */
      quiet?: (row: HeldRow) => boolean
      /** checked inside each item's lock, just before its claim: why it may not go now, or null (a request's placement) */
      admit?: (row: HeldRow) => string | null
      /** each item's result as it settles, so a press cut off keeps what it reached */
      onResult?: (result: DecisionResult) => void
    }
  ): Promise<DecisionResult[]> {
    const many = opts.many === true || items.length > 1
    const seen = new Set<string>()
    const run = async (d: Decision): Promise<DecisionResult> => {
      try {
        const ref = this.canonical(d.ref)
        const key = runKeyOfRef(ref)
        if (seen.has(key)) throw new Error(TWICE)
        seen.add(key)
        if (d.do === 'discard') {
          const item = await this.discard(ref, opts.by, { ...(d.reason ? { reason: d.reason } : {}), ...(opts.via ? { via: opts.via } : {}), ...(d.rev !== undefined ? { rev: d.rev } : {}), ...(opts.quiet ? { quiet: opts.quiet } : {}), ...(opts.admit ? { admit: opts.admit } : {}) })
          return { ref, ok: item.state === 'discarded' || item.dismissedAt !== undefined, item }
        }
        if (d.do === 'later') {
          if (d.at === undefined) throw new Error(BAD_TIME)
          const refusal = this.sendRefusal(ref, many)
          if (refusal) throw new Error(refusal)
          const item = await this.later(ref, { at: d.at, by: opts.by, ...(d.zone ? { zone: d.zone } : {}), ...(d.rev !== undefined ? { rev: d.rev } : {}), ...(d.cancelIfReply !== undefined ? { cancelIfReply: d.cancelIfReply } : {}), ...(opts.via ? { via: opts.via } : {}), ...(many ? { many: true } : {}), ...(opts.admit ? { admit: opts.admit } : {}) })
          return { ref, ok: item.state === 'scheduled', item }
        }
        const refusal = this.sendRefusal(ref, many)
        if (refusal) throw new Error(refusal)
        const item = await this.send(ref, { ...(d.rev !== undefined ? { rev: d.rev } : {}), ...(d.again ? { again: true } : {}), ...(many ? { many: true } : {}), ...(opts.via ? { via: opts.via } : {}), ...(opts.quiet ? { quiet: opts.quiet } : {}), ...(opts.admit ? { admit: opts.admit } : {}), by: opts.by })
        return { ref, ok: item.state === 'sent' || item.state === 'sending', item, ...(item.state === 'failed' || item.state === 'stale' ? { error: item.error ?? 'It was not sent.' } : {}) }
      } catch (err) {
        return { ref: d.ref, ok: false, error: errorText(err) }
      }
    }
    return mapLimit(items, DECIDE_AT_ONCE, async (d) => {
      const result = await run(d)
      try {
        opts.onResult?.(result)
      } catch (err) {
        this.deps.ctx.log(`outbox: a press's result was not kept: ${errorText(err)}`)
      }
      return result
    })
  }

  // ── Send later ────────────────────────────────────────────────────────

  /**
   * His Send later. The host keeps the time on the row first; a LifeOS mail then goes to LifeOS with that time, its
   * only timer, and a failure there puts the row back. A host kind waits for the host's timer and its own claim. A
   * time set is his press already: it earns no offered grant.
   */
  async later(ref: HeldRef, opts: { at: number; by: string; zone?: string; rev?: number; cancelIfReply?: boolean; via?: Via; many?: boolean; admit?: (row: HeldRow) => string | null }): Promise<OutboxItem> {
    ref = this.canonical(ref)
    return this.serial(ref, async () => {
      const now = Date.now()
      if (opts.at < now + LATER_MIN_MS || opts.at > now + LATER_MAX_MS) throw new Error(BAD_TIME)
      let row = this.store.byRef(ref)
      const kind = row?.kind ?? (ref.at === 'lifeos' ? (ref.table === 'outbox' ? 'mail.send' : 'calendar.op') : null)
      const timer = kind ? LATER[kind] : undefined
      if (!timer) throw new Error(NOT_LATER)
      if (ref.at === 'lifeos') {
        if (opts.rev === undefined) throw new Error(REV_NEEDED)
        if (!row || PRESSABLE.includes(row.state)) {
          const live = await this.readLifeos(ref)
          if (live.scheduledFor !== undefined) throw new Error(SCHEDULED_BY_HIM)
          if (live.updatedAt !== opts.rev) throw new Error(CHANGED_SINCE)
          if (opts.many && quotesItsMail(live)) throw new Error(OPEN_TO_SEND)
          row = row ? (this.store.edit(row.id, { payload: live.payload, summary: live.summary, verb: live.verb, account: live.account }) ?? this.store.get(row.id)) : this.adopt(live)
        }
      }
      if (!row) throw new Error(NO_SUCH_ITEM)
      const refused = opts.admit?.(row)
      if (refused) throw new Error(refused)
      if (row.state === 'failed' && row.outcomeUnknown) throw new Error(MAY_HAVE_GONE)
      const rev = ref.at === 'host' ? opts.rev : row.updatedAt
      const set = this.store.schedule(row.id, opts.by, opts.at, { zone: opts.zone ?? null, via: opts.via ?? null, ...(rev !== undefined ? { rev } : {}) })
      if (!set) {
        const now2 = this.store.get(row.id)!
        if (rev !== undefined && now2.updatedAt !== rev && PRESSABLE.includes(now2.state)) throw new Error(CHANGED_SINCE)
        return this.wire(now2)
      }
      this.markBatch(set.runKey)
      if (timer === 'lifeos') {
        try {
          if (!this.lifeos?.scheduleMail) throw new Error('LifeOS is not reachable from this host')
          await this.lifeos.scheduleMail(set.payload, { at: opts.at, ...(opts.zone ? { zone: opts.zone } : {}), ...(opts.cancelIfReply !== undefined ? { cancelIfReply: opts.cancelIfReply } : {}) })
        } catch (err) {
          // An answer lost on the way may hide a time LifeOS took: it is asked, and the row goes back only when LifeOS
          // still holds a draft. Unsure, the row stays scheduled and the watcher settles it from what LifeOS says.
          const status = ref.at === 'lifeos' ? await this.lifeos?.mailStatus?.(ref.id).catch(() => undefined) : null
          if (status === 'draft' || status === 'failed' || status === null) this.store.unschedule(set.id, `LifeOS did not take the time: ${errorText(err)}`, set.scheduleGen)
          if (status === 'queued' || status === 'sending') return this.wire(this.store.get(set.id)!)
          throw err
        }
      } else this.arm()
      return this.wire(this.store.get(set.id)!)
    })
  }

  /** Cancel send: a scheduled item waits on him again as held. A LifeOS mail only once LifeOS says it took it back. */
  async cancelSend(ref: HeldRef, opts: { rev?: number } = {}): Promise<OutboxItem> {
    ref = this.canonical(ref)
    return this.serial(ref, async () => {
      const row = this.store.byRef(ref)
      if (!row || row.state !== 'scheduled') throw new Error(NOT_SCHEDULED)
      if (opts.rev !== undefined && row.updatedAt !== opts.rev) throw new Error(CHANGED_SINCE)
      if (LATER[row.kind] === 'lifeos' && ref.at === 'lifeos') {
        if (!(await this.lifeos?.cancelMail?.(ref.id))) throw new Error(ON_ITS_WAY)
      }
      const back = this.store.unschedule(row.id)
      this.arm()
      return this.wire(back ?? this.store.get(row.id)!)
    })
  }

  /** Send now: a scheduled item goes at once, on its own claim (a LifeOS mail after LifeOS's undo time). */
  async sendScheduledNow(ref: HeldRef, opts: { rev?: number } = {}): Promise<OutboxItem> {
    ref = this.canonical(ref)
    return this.serial(ref, async () => {
      const row = this.store.byRef(ref)
      if (!row || row.state !== 'scheduled') throw new Error(NOT_SCHEDULED)
      // The time he saw: a press from an older view never takes a schedule set again since.
      if (opts.rev !== undefined && row.updatedAt !== opts.rev) throw new Error(CHANGED_SINCE)
      if (LATER[row.kind] === 'lifeos' && ref.at === 'lifeos') {
        if (!this.lifeos?.sendMailNow) throw new Error('LifeOS is not reachable from this host')
        await this.lifeos.sendMailNow(ref.id)
        return this.wire(this.store.reschedule(row.id, Date.now(), null) ?? row)
      }
      return this.wire(await this.fire(row, { now: true }))
    })
  }

  /**
   * Undo on the press's toast: a LifeOS mail LifeOS still holds in its undo time goes back to a draft, and the row
   * waits on him again as held. False when it already went.
   */
  async undoSend(ref: HeldRef): Promise<{ back: boolean; item?: OutboxItem }> {
    ref = this.canonical(ref)
    return this.serial(ref, async () => {
      const row = this.store.byRef(ref)
      if (!row || row.state !== 'sent' || row.kind !== 'mail.send' || ref.at !== 'lifeos') return { back: false }
      if (!(await this.lifeos?.cancelMail?.(ref.id))) return { back: false }
      const back = this.store.unsend(row.id)
      if (back?.sessionId) this.deps.whisper(back.sessionId, takenBackNote(back))
      return { back: !!back, ...(back ? { item: this.wire(back) } : {}) }
    })
  }

  /** The host's Send later timer runs while Work is on. */
  startSchedules(): () => void {
    this.timing = true
    this.period++
    this.arm()
    void this.drainCancels()
    const drain = setInterval(() => void this.drainCancels(), CANCEL_DRAIN_MS)
    drain.unref?.()
    return () => {
      this.timing = false
      this.period++
      clearInterval(drain)
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Another time for a scheduled LifeOS mail, under the item's own lock: LifeOS first, then the row. */
  async rescheduleLifeos(ref: HeldRef, time: { at: number; zone?: string; cancelIfReply?: boolean }): Promise<OutboxItem> {
    ref = this.canonical(ref)
    return this.serial(ref, async () => {
      const row = this.store.byRef(ref)
      if (!row || row.state !== 'scheduled' || ref.at !== 'lifeos') throw new Error(NOT_SCHEDULED)
      if (!this.lifeos?.rescheduleMail) throw new Error('LifeOS is not reachable from this host')
      await this.lifeos.rescheduleMail(ref.id, time)
      return this.wire(this.store.reschedule(row.id, time.at, time.zone ?? null) ?? row)
    })
  }

  /**
   * A removed thread or workspace's mail LifeOS was to send at his time: taken back from LifeOS first, and only then
   * put away here. One LifeOS cannot reach now keeps its schedule, marked, and the watcher asks again each pass.
   */
  async cancelForRemoval(rows: readonly HeldRow[], why: string): Promise<void> {
    // Every row is already marked (store.ts `markCancelFor`, before this runs): a stop now leaves each one to the drain.
    for (const row of rows) await this.cancelOne(row, why)
  }

  /** Every mail still marked to be taken back, asked of LifeOS again: on a steady beat, whatever LifeOS's watch says. */
  async drainCancels(): Promise<void> {
    try {
      for (const row of this.store.cancelsWanted()) await this.cancelOne(row, 'The thread that made this was deleted.')
    } catch (err) {
      this.deps.ctx.log(`outbox: the cancels still wanted were not asked: ${errorText(err)}`)
    }
  }

  /** One marked mail taken back from LifeOS under its own lock; put away only once LifeOS says it took it back. */
  private async cancelOne(seen: HeldRow, why: string): Promise<void> {
    if (!seen.runKey.startsWith('lifeos:outbox:')) return
    const ref = refOfRow(seen)
    await this.serial(ref, async () => {
      const row = this.store.get(seen.id)
      if (!row || row.state !== 'scheduled' || !row.cancelWanted || ref.at !== 'lifeos') return
      let back: boolean | undefined
      try {
        back = await this.lifeos?.cancelMail?.(ref.id)
      } catch (err) {
        this.deps.ctx.log(`outbox: LifeOS could not take back scheduled item ${row.n}; asking again later: ${errorText(err)}`)
        return
      }
      if (back) this.store.putAwayScheduled(row.id, why)
    })
  }

  /** Run `fn` under an item's own lock: LifeOS's watcher moves a scheduled row only between presses, never in one. */
  withLock<T>(ref: HeldRef, fn: () => Promise<T>): Promise<T> {
    return this.serial(this.canonical(ref), fn)
  }

  /** Set the one timer for the next time due. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.timing) return
    let next: number | null
    try {
      next = this.store.nextScheduledAt()
    } catch {
      return
    }
    if (next === null) return
    this.timer = setTimeout(() => void this.due(), Math.min(Math.max(0, next - Date.now()), TIMER_MAX_MS))
    this.timer.unref?.()
  }

  /** Every item whose time came, each on its own claim, then the next time. */
  private async due(): Promise<void> {
    this.timer = null
    // The Work period this wake belongs to: Work turned off (or off and on) in the middle ends the rest of the batch.
    const period = this.period
    const live = (): boolean => this.timing && this.period === period
    try {
      for (const row of this.store.dueScheduled()) {
        if (!live()) break
        await this.serial(refOfRow(row), async () => (live() ? this.fire(row) : row))
      }
    } catch (err) {
      this.deps.ctx.log(`outbox: a scheduled send did not run: ${errorText(err)}`)
    }
    this.arm()
  }

  /**
   * One scheduled item at its time: the generation the timer saw, its kind's deadline, its thread or workspace still
   * there, then its own claim and the kind's own fresh checks in `execute`. A time missed by more than a quarter hour
   * goes back to him, never out late.
   */
  private async fire(seen: HeldRow, opts: { now?: boolean } = {}): Promise<HeldRow> {
    const row = this.store.get(seen.id)
    if (!row || row.state !== 'scheduled' || row.scheduleGen !== seen.scheduleGen) return row ?? seen
    const def = this.deps.kinds.get(row.kind)
    const now = Date.now()
    if (!opts.now && row.scheduleAt !== null && now - row.scheduleAt > MISSED_MS) return this.store.unschedule(row.id, MISSED, row.scheduleGen) ?? row
    if (!def) return this.store.unschedule(row.id, NOT_LATER, row.scheduleGen) ?? row
    const by = (() => {
      try {
        return def.by?.(def.payload.parse(row.payload)) ?? null
      } catch {
        return null
      }
    })()
    if (by !== null && now >= by) return this.store.unschedule(row.id, TIME_PASSED, row.scheduleGen) ?? row
    if (row.sessionId && row.workspaceId && !this.deps.scopeKeyOf(row.sessionId)) return this.store.unschedule(row.id, SCOPE_GONE, row.scheduleGen) ?? row
    const claimed = this.store.claimScheduled(row.id, row.scheduleGen)
    if (!claimed) return this.store.get(row.id)!
    return this.run(claimed, def)
  }

  /** LifeOS's own timer sent a mail he scheduled: the linked task and the thread's note, once, now that it went. */
  scheduledWent(row: HeldRow): void {
    // The task completes and the listeners hear it; the thread is told it went at his time, not that it was queued.
    this.settled(row, null, true)
    if (row.sessionId) this.deps.whisper(row.sessionId, wentNote(row))
  }

  /** Why an item may not be sent on this press, or null. */
  private sendRefusal(ref: HeldRef, many: boolean): string | null {
    const row = this.store.byRef(ref)
    const item = row ? itemOfRow(row) : this.lifeos?.items().find((i) => runKeyOfRef(i.ref) === runKeyOfRef(ref))
    if (!item) return null
    if (item.state === 'stale') return OUT_OF_DATE_SEND
    if (many && (item.state === 'live' || item.kind === 'computer.act' || quotesItsMail(item))) return OPEN_TO_SEND
    return null
  }

  /** One name for one item: a host ref to a row that records a LifeOS item is that item's LifeOS ref, so no alias skips its checks. */
  canonical(ref: HeldRef): HeldRef {
    if (ref.at !== 'host') return ref
    const row = this.store.get(ref.id)
    return row ? refOfRow(row) : ref
  }

  /** Presses on one item run one after another, each from what the last left, before any outside call. */
  private serial<T>(ref: HeldRef, fn: () => Promise<T>): Promise<T> {
    const key = runKeyOfRef(ref)
    const before = this.locks.get(key) ?? Promise.resolve()
    const mine = before.catch(() => undefined).then(fn)
    const tail = mine.catch(() => undefined)
    this.locks.set(key, tail)
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    })
    return mine
  }

  /** Change exactly what will go, while it waits. */
  async edit(ref: HeldRef, payload: unknown): Promise<OutboxItem> {
    if (ref.at === 'lifeos') {
      const row = this.store.byRef(ref)
      if (row && !PRESSABLE.includes(row.state)) throw new Error('This item was already decided; it cannot be changed.')
      if (!this.lifeos) throw new Error(NO_SUCH_ITEM)
      const next = await this.lifeos.edit(ref, payload)
      this.markEdited(runKeyOfRef(ref), next.updatedAt)
      this.changed(null)
      return this.withChanged(next)
    }
    const row = this.store.byRef(ref)
    if (!row) throw new Error(NO_SUCH_ITEM)
    // Only a kind whose payload is what goes may be changed here: a form's publish, say, sends the form as stored (the hold review).
    if (!EDITABLE_KINDS.includes(row.kind)) throw new Error(NOT_EDITABLE)
    const def = this.def(row.kind)
    const parsed = def.payload.parse(KEEPS[row.kind] ? KEEPS[row.kind]!(row.payload, payload) : payload)
    const next = def.keep ? def.keep(def.payload.parse(row.payload), parsed) : parsed
    const words = def.words(next)
    const edited = this.store.edit(row.id, { payload: next, summary: words.summary, verb: words.verb })
    if (!edited) throw new Error(row.state === 'live' ? 'An act read from a live screen is carried out as it was read; it cannot be changed.' : 'This item was already decided; it cannot be changed.')
    this.markEdited(edited.runKey, edited.updatedAt)
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
    if (notGrantable(item.payload)) throw new Error(notGrantableWords(item.payload))
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
    // A grant like one that stands is that one: an offer taken and the same grant asked for by hand never make two, so one Remove ends it.
    const same = this.store.grants({ workspaceId: scope }).find((g) => g.kind === item.kind && (g.routineId ?? null) === routineId && canonical(sameAs(item.kind, g.matcher)) === canonical(sameAs(item.kind, parsed)))
    if (same) {
      this.closeCovered(same, def)
      return same
    }
    const grant = this.store.addGrant({ workspaceId: scope, kind: item.kind, matcher: parsed, label: label.slice(0, 200), madeFrom: item.ref, routineId })
    this.closeCovered(grant, def)
    return grant
  }

  // ── grants he has earned (earned.ts) ──────────────────────────────────

  /** The offers still open, each from an item that is still in a Work workspace and fits no standing grant. */
  offers(q: { workspaceId?: string } = {}): GrantOffer[] {
    const earned = this.deps.earned
    if (!earned) return []
    return earned.open(q).flatMap((o) => (this.offerStands(o) ? [wireOffer(o)] : []))
  }

  /**
   * Make the grant an offer names. It is the same `grant` he could ask for
   * by hand from the offer's item, with the matcher the host worked out:
   * the client names only the offer. Who may call this is checked in
   * index.ts: a person with admin, never a model.
   */
  async takeOffer(id: string): Promise<OutboxGrant> {
    const earned = this.deps.earned
    const open = earned?.get(id)
    if (!earned || !open || open.state !== 'open' || !this.offerStands(open)) throw new Error(NO_SUCH_OFFER)
    // The grant first, then the offer marked: a stop between them leaves the offer open, never decided with no grant. Two
    // presses at once make one grant (`grant` answers the one that stands).
    const grant = await this.grant(open.from, open.matcher, { label: open.label, ...(open.routineId ? { routine: true } : {}) })
    if ((grant.routineId ?? null) !== open.routineId) throw new Error(NO_SUCH_OFFER)
    try {
      if (earned.claim(id, 'made')) earned.settle(id, grant.id)
    } catch (err) {
      // The grant stands: it is what he asked for, so the press answers it whatever became of the offer's mark.
      this.deps.ctx.log(`outbox: offer ${id} was not marked taken: ${errorText(err)}`)
    }
    this.changed(null)
    return grant
  }

  /** Never offered again, whatever he sends after. */
  dismissOffer(id: string): GrantOffer {
    const gone = this.deps.earned?.claim(id, 'dismissed')
    if (!gone) throw new Error(NO_SUCH_OFFER)
    this.changed(null)
    return wireOffer(gone)
  }

  /**
   * An offer still stands while every send that earned it still reads sent,
   * its item is in the workspace it was earned in and was held in, under
   * the same routine, and no standing grant fits it.
   */
  offerStands(o: StoredOffer): boolean {
    // Sent by the press that earned it: a retry after a failure, edited or not, is another decision.
    if (o.run.some((r) => { const row = this.store.byRunKey(r.runKey); return row?.state !== 'sent' || row.decidedAt !== r.at })) return false
    const row = this.store.byRef(o.from)
    if (!row?.sessionId || row.state !== 'sent' || row.workspaceId !== o.workspaceId || this.deps.scopeKeyOf(row.sessionId) !== o.workspaceId) return false
    const routineId = row.routineRunId ? this.deps.routineOf(row.routineRunId) : null
    if ((row.routineRunId && !routineId) || routineId !== o.routineId) return false
    const def = this.deps.kinds.get(row.kind)
    return !!def && !this.grantFor({ kind: row.kind, payload: row.payload, sessionId: row.sessionId, routineRunId: row.routineRunId, createdAt: Number.MAX_SAFE_INTEGER }, def)
  }

  /** A grant he made fits an open offer's item: that offer is decided, by the grant. */
  private closeCovered(grant: OutboxGrant, def: ActKindDef): void {
    const earned = this.deps.earned
    if (!earned || !def.matcher || !def.matches) return
    try {
      const matcher = def.matcher.parse(grant.matcher)
      for (const o of earned.open({ workspaceId: grant.workspaceId, kind: grant.kind })) {
        const row = this.store.byRef(o.from)
        const payload = row ? def.payload.safeParse(row.payload) : null
        if (payload?.success && (grant.routineId ?? null) === o.routineId && def.matches(matcher, payload.data) && earned.claim(o.id, 'made')) earned.settle(o.id, grant.id)
      }
    } catch (err) {
      this.deps.ctx.log(`outbox: offers a grant covers were not closed: ${errorText(err)}`)
    }
  }

  private markBatch(runKey: string): void {
    try {
      this.deps.earned?.markBatch(runKey)
    } catch (err) {
      this.deps.ctx.log(`outbox: a send of several was not marked: ${errorText(err)}`)
    }
  }

  /** What the thread wrote, kept at first sight. Never in the way of a hold. */
  private noteFirst(runKey: string, kind: ActKind, payload: unknown): void {
    try {
      this.deps.earned?.noteFirst(runKey, kind, payload)
    } catch (err) {
      this.deps.ctx.log(`outbox: the first words of an act were not kept: ${errorText(err)}`)
    }
  }

  /** A send he pressed may complete a run: the offer is made now, before the press answers. Never in the way of a send. */
  private earnFrom(row: HeldRow): void {
    const earned = this.deps.earned
    if (!earned || row.state !== 'sent') return
    try {
      const made = earn(
        {
          earned,
          decidedSince: (kind, workspaceId, since) => this.store.decidedSince(kind, workspaceId, since),
          routineOf: (id) => this.deps.routineOf(id),
          granted: (r) => {
            const def = this.deps.kinds.get(r.kind)
            return !def || !!this.grantFor({ kind: r.kind, payload: r.payload, sessionId: r.sessionId, routineRunId: r.routineRunId, createdAt: Number.MAX_SAFE_INTEGER }, def)
          },
          stands: (o) => this.offerStands(o),
          notGrantable,
          now: Date.now
        },
        row
      )
      if (made) this.changed(null)
    } catch (err) {
      this.deps.ctx.log(`outbox: an earned grant was not worked out: ${errorText(err)}`)
    }
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
    if (!def.matcher || !def.matches || !act.sessionId || notGrantable(act.payload)) return null
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
  list(q: { show?: 'waiting' | 'done' | 'decided' | 'all'; /** null: a Work Chat's, outside every workspace */ workspaceId?: string | null; sessionId?: string; limit?: number } = {}): { items: OutboxItem[]; waiting: number } {
    const show = q.show === 'done' ? 'decided' : (q.show ?? 'waiting')
    // A LifeOS item recorded here (a send that failed) and still waiting is listed with LifeOS's own copy and revision,
    // so a later press names what LifeOS holds now (milestone 50's hold review).
    const rows = this.store.list({ ...q, show }).map((row) => {
      const item = this.wire(row)
      if (item.ref.at !== 'lifeos' || !PRESSABLE.includes(row.state)) return item
      const there = this.lifeos?.items().find((i) => JSON.stringify(i.ref) === JSON.stringify(item.ref))
      return there ? this.withChanged({ ...item, payload: there.payload, updatedAt: there.updatedAt, effect: this.effect(item.kind, there.payload) }) : item
    })
    const held = show === 'decided' ? [] : this.undecided().map((i) => this.withChanged({ ...i, effect: this.effect(i.kind, i.payload), ...(LATER[i.kind] && i.state === 'held' ? { later: true as const } : {}) })).filter((i) => (q.workspaceId === undefined || i.workspaceId === q.workspaceId) && (q.sessionId === undefined || i.sessionId === q.sessionId))
    const items = [...rows, ...held]
    if (show === 'waiting') items.sort((a, b) => a.createdAt - b.createdAt)
    return { items: items.slice(0, q.limit ?? 200), waiting: this.waiting() }
  }

  /** One item whole: what the list carries, the thread's first words beside a change, and a newer message in a mail's conversation. */
  async get(ref: HeldRef): Promise<OutboxItem> {
    const row = this.store.byRef(ref)
    let item: OutboxItem
    if (row && (ref.at === 'host' || !PRESSABLE.includes(row.state))) item = this.wire(row)
    else if (ref.at === 'lifeos') {
      const live = await this.readLifeos(ref)
      item = this.withChanged({ ...live, effect: this.effect(live.kind, live.payload) })
    } else throw new Error(NO_SUCH_ITEM)
    if (item.changed) item = { ...item, changed: { ...item.changed, first: this.firstOf(runKeyOfRef(item.ref)) } }
    const replied = needsHim(item) ? await this.repliedTo(item) : null
    return replied ? { ...item, replied } : item
  }

  /** One item as the list would show it now, read here alone (no LifeOS call); null when this host has no such item. */
  itemNow(ref: HeldRef): OutboxItem | null {
    ref = this.canonical(ref)
    const row = this.store.byRef(ref)
    if (row) {
      const item = this.wire(row)
      if (ref.at !== 'lifeos' || !PRESSABLE.includes(row.state)) return item
      const there = this.lifeos?.items().find((i) => runKeyOfRef(i.ref) === runKeyOfRef(ref))
      return there ? this.withChanged({ ...item, payload: there.payload, updatedAt: there.updatedAt, effect: this.effect(item.kind, there.payload) }) : item
    }
    const held = this.lifeos?.items().find((i) => runKeyOfRef(i.ref) === runKeyOfRef(ref))
    return held ? this.withChanged({ ...held, effect: this.effect(held.kind, held.payload), ...(LATER[held.kind] && held.state === 'held' ? { later: true as const } : {}) }) : null
  }

  /** How many items wait on the owner (`needsHim`): this host's and LifeOS's. A mail he scheduled is his press already. */
  waiting(): number {
    return this.store.waiting() + this.undecided().filter((i) => needsHim(i)).length
  }

  /** What a press does, in one sentence. */
  effect(kind: ActKind, payload: unknown): string {
    const own = this.deps.kinds.get(kind)?.effect
    return effectOf(kind, payload, own ? (p) => own(p as never) : undefined)
  }

  /** The words as first written, kept by earned.ts; null when the host never saw them. */
  private firstOf(runKey: string): unknown {
    try {
      return this.deps.earned?.first(runKey) ?? null
    } catch {
      return null
    }
  }

  /** An item with `changed` when what would go is not what the thread first wrote: his own edit while its revision stands, else the thread's. */
  withChanged<T extends OutboxItem>(item: T): T {
    const first = this.firstOf(runKeyOfRef(item.ref))
    const now = wordsOf(item.kind, item.payload)
    if (first === null || now === null || sameWords(item.kind, first, now)) return item
    let mine: number | null = null
    try {
      mine = this.store.editedRev(runKeyOfRef(item.ref))
    } catch {
      // no edits table: every change reads as the thread's
    }
    const changed: OutboxChanged = { at: item.updatedAt, by: mine === item.updatedAt ? 'you' : 'thread' }
    return { ...item, changed }
  }

  private markEdited(runKey: string, rev: number): void {
    try {
      this.store.markEdited(runKey, rev)
    } catch (err) {
      this.deps.ctx.log(`outbox: an edit was not marked as his: ${errorText(err)}`)
    }
  }

  /** The newest message from someone else in a LifeOS mail's conversation, when it came after the mail was made. Never in the way of a read. */
  private async repliedTo(item: OutboxItem): Promise<OutboxReplied | null> {
    if (item.kind !== 'mail.send') return null
    const threadId = (item.payload as { message?: { threadId?: unknown } } | null)?.message?.threadId
    if (typeof threadId !== 'string' || !threadId) return null
    try {
      const view = await this.deps.ctx.lifeos.owner().query<{ messages?: { fromMe: boolean; sentAt: number; snippet?: string; from?: { name?: string; address: string } }[] } | null>('mail:thread', { id: threadId })
      const newer = (view?.messages ?? []).filter((m) => !m.fromMe && m.sentAt > item.createdAt).sort((a, b) => b.sentAt - a.sentAt)[0]
      if (!newer) return null
      const line = (newer.snippet ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
      return { from: newer.from?.name?.trim() || newer.from?.address || 'Someone', at: newer.sentAt, line: line.length > 140 ? `${line.slice(0, 139)}…` : line }
    } catch {
      return null
    }
  }

  /** Of those waiting, the ones whose send failed: here, and LifeOS's own that came back failed. */
  failed(): number {
    return this.store.failed() + this.undecided().filter((item) => item.state === 'failed').length
  }

  /** LifeOS-held items with no decision recorded here. One whose send failed here is listed from its row. */
  private undecided(): OutboxItem[] {
    return (this.lifeos?.items() ?? []).filter((item) => !this.store.byRef(item.ref))
  }

  /** A row as a screen gets it: a kind's payload is its own to trim (a picture's file path never leaves the host). */
  wire(row: HeldRow): OutboxItem {
    const fact = row.state === 'sent' ? this.lifeos?.sentFact?.(row) : undefined
    const item = this.withChanged({ ...itemOfRow(row), ...fact, effect: this.effect(row.kind, row.payload), ...(LATER[row.kind] && (row.state === 'held' || row.state === 'failed') && !row.outcomeUnknown ? { later: true as const } : {}) })
    const payload = item.payload as { picture?: { path?: string } | null } | null
    if (row.kind === 'computer.act' && payload?.picture && typeof payload.picture === 'object') {
      const { path: _path, ...picture } = payload.picture
      return { ...item, payload: { ...payload, picture } }
    }
    return item
  }

  // ── listeners ─────────────────────────────────────────────────────────

  /** A held act reached its end: sent, failed, discarded or stale. `asHeld`: its words as the thread wrote them (earned.ts `wordsOf`), or null. */
  onDecided(fn: (item: HeldItem, asHeld: unknown) => void): () => void {
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
    this.earnFrom(row)
    const item = itemOfRow(row)
    let asHeld: unknown = null
    try {
      asHeld = this.deps.earned?.first(row.runKey) ?? null
    } catch {
      // not kept: the listeners read no edit
    }
    for (const fn of [...this.decidedListeners]) {
      try {
        fn(item, asHeld)
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
        // LifeOS holds what it took for its undo time, or until the calendar takes it: the task says queued, not sent.
        const done = this.deps.kinds.get(row.kind)?.store === 'lifeos' ? 'Queued to send' : 'Sent'
        await this.deps.ctx.links.completeFor(this.deps.rootOf(row.sessionId), `${done}: ${row.summary}`.slice(0, 300))
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
        // A mail or calendar act LifeOS took is queued there, not yet sent: the thread hears that, and that it is his now.
        const note = this.deps.kinds.get(row.kind)?.store === 'lifeos' ? queuedNote(row) : sentNote(row, detail)
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
