import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { DIGEST_FIELDS, type DigestDay, type DigestField, type DigestList, type DigestPush, type DigestSettings } from '@shared/contract-work-digest'
import { writtenByOwner } from '@shared/events'
import { errorText } from '@shared/work/ids'
import { DEFAULT_AT, DEFAULT_LEVEL } from '@shared/work/digest'
import { DETAIL_MAX, TELL_GROUPS, TELL_LEVELS, TITLE_MAX, tellLine, TellOpenSchema, type Tell, type TellGroup, type TellKind, type TellLevel, type TellRow } from '@shared/work/tell'
import type { CtxPart } from '../ctx'
import { WORK_MODULES, type WorkCtx } from '../modules'
import { hostReadOf, type HostRead } from '../peer'
import { dayOf, knownZone, lastDigest, nextDigest, zoneOr } from './clock'
import type { Notifier } from '../../remote/notifier'
import { makeDeliverer, ofDay, PEER_WAIT_MS } from './deliver'
import { makeGate, runPressed } from './gate'
import { makeDay } from './make'
import { decide, groupsByKind, groupsListed, LATE_MS, retold } from './rule'
import { Sources } from './sources'
import { SOURCES } from './sources/list'
import { DigestStore, type LedgerRow } from './store'

/**
 * `ctx.tell`, and the digest's ledger behind it (docs/agents/work-digest.md).
 * Made once at boot, Work on or off; nothing here runs on a clock until the
 * module's `start` (work/digest/index.ts), which only runs while Work is on.
 */

export const TICK_MS = 30_000

/** Who carries a notice to him. Absent, a row the rule calls "now" is kept as due and sent by the first tick that has one. */
export interface Deliverer {
  /** Tells him of `row` at once; `open` is every interrupt still open, this one among them. False: nobody took it. */
  now(row: LedgerRow, open: LedgerRow[]): boolean
  /** A row he was told of at once is no longer true; `open` is what is still open. */
  gone(row: LedgerRow, open: LedgerRow[]): void
  /**
   * The day's one notice, of the rows that waited. False, or a promise of false: nobody could take it yet, and the
   * day is offered again at a later look; anything else settles it (sent, nothing to say, or another host sends).
   */
  digest(day: DigestDay, rows: LedgerRow[], stillOwed?: () => boolean): Promise<boolean> | boolean | void
}

/** How long a linked host's read of the list waits for this host's day to be made: inside the asker's own limit (`PEER_WAIT_MS`). */
export const LIST_WAIT_MS = PEER_WAIT_MS - 1_000

export interface DigestDeps {
  db: DatabaseSync
  host: string
  enabled(): boolean
  log(line: string): void
  push(p: DigestPush): void
  /** who lists which kinds: the registry */
  modules(): readonly { tells?: TellKind[] }[]
  now?(): number
}

const levelsOf = (text: string | null): Partial<Record<TellGroup, TellLevel>> => {
  try {
    const raw = JSON.parse(text ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).filter(([g, l]) => (TELL_GROUPS as readonly string[]).includes(g) && (TELL_LEVELS as readonly string[]).includes(l as string))) as Partial<Record<TellGroup, TellLevel>>
  } catch {
    return {}
  }
}

export class Digest {
  readonly store: DigestStore
  deliverer: Deliverer | null = null
  /** Run at the start of each look: the gate's attach, the sources' beats. One that throws stops nothing. */
  readonly beats: ((now: number) => void)[] = []
  /** Awaited before a day is made: the sources that tell at the digest's time. */
  beforeDay: ((now: number) => Promise<void>) | null = null
  /** The day being made, for a test to wait on. */
  making: Promise<void> = Promise.resolve()
  /** The digest time whose day is being made now, so a second look starts no second make. */
  private makingAt: number | null = null
  /** A day's notice is being handed on now, so a second look offers it no second time. */
  private offering = false
  private readonly unknown = new Set<string>()
  private readonly clock: () => number

  constructor(private readonly o: DigestDeps) {
    this.store = new DigestStore(o.db, o.host)
    this.clock = o.now ?? Date.now
  }

  // ── what he set ─────────────────────────────────────────────────────
  at(): string {
    return this.store.setting('at') ?? DEFAULT_AT
  }
  zone(): string {
    return zoneOr(this.store.setting('zone'))
  }
  levels(): Partial<Record<TellGroup, TellLevel>> {
    return levelsOf(this.store.setting('levels'))
  }
  levelOf(group: TellGroup): TellLevel {
    return this.levels()[group] ?? DEFAULT_LEVEL
  }
  nextAt(now = this.clock()): number {
    return nextDigest(this.at(), this.zone(), now)
  }
  /** When each field was last set here. */
  private setAt(): Partial<Record<DigestField, number>> {
    try {
      const kept = JSON.parse(this.store.setting('setAt') ?? '{}') as Record<string, unknown>
      return Object.fromEntries(DIGEST_FIELDS.flatMap((f) => (typeof kept?.[f] === 'number' ? [[f, kept[f] as number]] : []))) as Partial<Record<DigestField, number>>
    } catch {
      return {}
    }
  }
  settings(): DigestSettings {
    const setAt = this.setAt()
    return { at: this.at(), zone: this.zone(), levels: this.levels(), nextAt: this.nextAt(), ...(Object.keys(setAt).length ? { setAt } : {}) }
  }
  /**
   * `patch.setAt`: when each field was set, for a write that brings this host to what another already holds. The
   * field is stamped with that time, and one this host holds a newer setting of is left alone, so such a write can
   * never undo a change it did not know of. Absent: he set it now.
   */
  set(patch: { at?: string; levels?: Partial<Record<TellGroup, TellLevel>>; setAt?: Partial<Record<DigestField, number>> }): DigestSettings {
    const now = this.clock()
    const stamps = this.setAt()
    const takes = (field: DigestField): boolean => {
      const given = patch.setAt?.[field]
      if (given !== undefined && (stamps[field] ?? 0) >= given) return false
      stamps[field] = given ?? now
      return true
    }
    if (patch.at && takes('at') && patch.at !== this.at()) {
      this.store.setSetting('at', patch.at)
      this.settled()
    }
    if (patch.levels) {
      // Only what he changed is kept: a group set back to the default has no row.
      const next = { ...this.levels() }
      for (const g of TELL_GROUPS) {
        const level = patch.levels[g]
        if (level === undefined || !takes(g)) continue
        if (level === DEFAULT_LEVEL) delete next[g]
        else next[g] = level
      }
      this.store.setSetting('levels', JSON.stringify(next))
    }
    this.store.setSetting('setAt', JSON.stringify(stamps))
    const settings = this.settings()
    this.o.push({ push: 'work.digest', settings })
    return settings
  }
  /**
   * The desktop he is at says its zone, with when its window came to the front (`at`): the zone of the latest is
   * kept, so a window left in front on another desktop, reconnecting later, does not take it back. A desktop that
   * says no time is taken as now.
   */
  here(zone: string, at?: number): void {
    if (!knownZone(zone)) throw new Error(`unknown time zone: ${zone}`)
    const when = typeof at === 'number' && Number.isFinite(at) ? at : this.clock()
    const kept = Number(this.store.setting('zoneAt') ?? NaN)
    if (Number.isFinite(kept) && kept > when) return
    this.store.setSetting('zoneAt', String(when))
    if (this.store.setting('zone') === zone) return
    this.store.setSetting('zone', zone)
    this.settled()
    this.o.push({ push: 'work.digest', settings: this.settings() })
  }
  /** A new time or zone misses nothing: a digest time it puts in the past is not made late. */
  private settled(): void {
    const handled = Number(this.store.setting('handled') ?? NaN)
    if (!Number.isFinite(handled)) return
    const at = lastDigest(this.at(), this.zone(), this.clock())
    if (at > handled) this.store.setSetting('handled', String(at))
  }

  // ── telling ─────────────────────────────────────────────────────────
  private groupOf(kind: string): TellGroup {
    const group = groupsByKind(this.o.modules()).get(kind)
    if (group) return group
    if (!this.unknown.has(kind)) {
      this.unknown.add(kind)
      this.o.log(`digest: no module lists the kind ${kind} in its tells; kept under system`)
    }
    return 'system'
  }
  private sectorOf(workspaceId: string | null): string | null {
    if (!workspaceId) return null
    try {
      return (this.o.db.prepare('SELECT sector FROM workspaces WHERE id = ?').get(workspaceId) as { sector?: string | null } | undefined)?.sector ?? null
    } catch {
      return null
    }
  }
  /** Hands a row to the deliverer; one nobody takes is kept as due. */
  private tellNow(row: LedgerRow, now: number): LedgerRow {
    let taken = false
    try {
      taken = this.deliverer?.now(row, [...this.store.openNow(now).filter((r) => r.id !== row.id), row]) ?? false
    } catch (err) {
      this.o.log(`digest: a notice was not sent: ${errorText(err)}`)
    }
    const next: LedgerRow = taken ? { ...row, how: 'now', toldAt: now, due: false } : { ...row, due: true }
    this.store.put(next)
    return next
  }

  tell(t: Tell): LedgerRow | null {
    if (!this.o.enabled()) return null
    const title = typeof t?.title === 'string' ? tellLine(t.title, TITLE_MAX) : ''
    if (!title || typeof t.kind !== 'string' || !t.kind) {
      this.o.log('digest: a tell with no kind or no title was dropped')
      return null
    }
    const now = this.clock()
    const detail = typeof t.detail === 'string' ? tellLine(t.detail, DETAIL_MAX) : ''
    const open = t.open ? TellOpenSchema.safeParse(t.open) : null
    const by = typeof t.by === 'number' && Number.isFinite(t.by) ? t.by : undefined
    const workspaceId = t.workspaceId ?? null
    const said = {
      kind: t.kind,
      group: this.groupOf(t.kind),
      workspaceId,
      sector: this.sectorOf(workspaceId),
      title,
      ...(detail ? { detail } : {}),
      ...(open?.success ? { open: open.data } : {}),
      ...(by !== undefined ? { by } : {}),
      ...(t.key ? { key: t.key } : {})
    }
    const prev = t.key ? this.store.byKey(t.key) : null
    let row: LedgerRow
    let again = true
    if (prev) {
      const same = prev.kind === said.kind && prev.title === title && (prev.detail ?? '') === detail && prev.by === by && JSON.stringify(prev.open ?? null) === JSON.stringify(said.open ?? null)
      if (same) {
        if (prev.workspaceId === said.workspaceId && prev.sector === said.sector) return prev
        // Only the job it is filed under changed (a workspace linked to its sector since): the row follows, its telling stays.
        const moved: LedgerRow = { ...prev, group: said.group, workspaceId: said.workspaceId, sector: said.sector }
        this.store.put(moved)
        this.pushRow(moved)
        return moved
      }
      if (prev.toldAt != null) {
        // He was told at once already: the words follow, and he hears again only when its clock moved earlier.
        again = retold(prev, said)
        row = { ...said, id: prev.id, host: prev.host, at: prev.at, how: prev.how, day: prev.day, toldAt: again ? null : prev.toldAt, due: false }
      } else {
        // In a digest already and it changed: it is news again, for the next one.
        row = { ...said, id: prev.id, host: prev.host, at: now, how: 'waiting', day: null, toldAt: null, due: prev.due }
      }
    } else {
      row = { ...said, id: randomUUID(), host: this.o.host, at: now, how: 'waiting', day: null, toldAt: null, due: false }
    }
    // A clock that passed more than a day ago is no longer worth an interrupt: it waits, as a due row that old does.
    const stale = row.by != null && row.by < now - LATE_MS
    if (again && !stale && decide(row, this.levelOf(row.group), this.nextAt(now)) === 'now') row = this.tellNow(row, now)
    else {
      if (again && row.toldAt == null) row = { ...row, how: row.day ? 'digest' : 'waiting', due: false }
      this.store.put(row)
    }
    this.o.push({ push: 'work.digest', row: wireRow(row) })
    return row
  }

  done(key: string): void {
    const row = typeof key === 'string' && key ? this.store.byKey(key) : null
    if (!row) return
    this.store.remove(row.id)
    if (row.toldAt != null) {
      try {
        this.deliverer?.gone(row, this.store.openNow(this.clock()))
      } catch (err) {
        this.o.log(`digest: a notice was not withdrawn: ${errorText(err)}`)
      }
    }
    this.o.push({ push: 'work.digest', gone: row.id })
  }

  /** Of the rows whose key starts with `prefix`, only `keys` are still true: every other is done. */
  only(prefix: string, keys: readonly string[]): void {
    if (typeof prefix !== 'string' || !prefix) return
    const keep = new Set(keys)
    for (const row of this.store.byKeyPrefix(prefix)) if (row.key && !keep.has(row.key)) this.done(row.key)
  }

  quiet(sessionId: string): void {
    if (typeof sessionId === 'string' && sessionId) this.store.quiet(sessionId, this.clock())
  }

  // ── the clock ───────────────────────────────────────────────────────
  /**
   * One look, each 30 s while Work is on: a due row goes out once a deliverer
   * exists, a waiting row whose clock has come inside the window is told at
   * once whatever digest it is in, and at the digest's time the day is made.
   */
  tick(now = this.clock()): void {
    if (!this.o.enabled()) return
    for (const beat of this.beats) {
      try {
        beat(now)
      } catch (err) {
        this.o.log(`digest: a beat failed: ${errorText(err)}`)
      }
    }
    if (this.deliverer) {
      for (const row of this.store.due()) {
        // Too late to be of use: it waits for the digest like the rest.
        if (row.by != null && row.by < now - LATE_MS) {
          this.store.put({ ...row, due: false })
          continue
        }
        // He set its group to wait since it was owed: it waits, and no notice goes.
        if (decide(row, this.levelOf(row.group), this.nextAt(now)) !== 'now') {
          this.store.put({ ...row, due: false })
          continue
        }
        const next = this.tellNow(row, now)
        if (!next.due) this.pushRow(next)
      }
    }
    this.offerOwed()
    const next = this.nextAt(now)
    // From a day back: a host asleep through a row's clock still tells it when it wakes, as a due row that late is.
    for (const row of this.store.clocked(now - LATE_MS)) {
      if (decide(row, this.levelOf(row.group), next) !== 'now') continue
      const told = this.tellNow(row, now)
      if (!told.due) this.pushRow(told)
    }
    const at = lastDigest(this.at(), this.zone(), now)
    const handled = Number(this.store.setting('handled') ?? NaN)
    // The first look ever: nothing was missed, so nothing is made late.
    if (!Number.isFinite(handled)) return void this.store.setSetting('handled', String(at))
    if (at <= handled || this.makingAt === at) return
    // Marked handled only once the day is made: a stop while its sources are read makes it at the next start, not never.
    this.makingAt = at
    const day = dayOf(this.zone(), at)
    const make = (): void => {
      this.makingAt = null
      let made: ReturnType<typeof makeDay> = null
      let dropped: string[] = []
      // One write: the slot handled, the day and its rows stamped, the 30 days kept and the day's notice owed. A stop
      // part way leaves the slot unhandled, to be made whole at the next start.
      this.store.atomically(() => {
        // Another look made this slot while the sources were read (a restart in between): nothing is made or sent twice.
        if (Number(this.store.setting('handled') ?? NaN) >= at) return
        const madeAt = this.clock()
        this.store.setSetting('handled', String(at))
        made = makeDay(this.store, day, madeAt)
        // Kept at each digest time, a day made or not: a ledger whose rows all interrupted still drops old words.
        dropped = this.store.prune(madeAt)
        // A day this host has nothing for is still handed on: the host that sends the phone's digest adds what
        // its linked hosts hold, and a Mac's jobs must not go unsaid because the box has none of its own.
        this.store.setSetting('owed', day)
      })
      for (const id of dropped) this.o.push({ push: 'work.digest', gone: id })
      const done = made as ReturnType<typeof makeDay>
      if (done) this.o.push({ push: 'work.digest', day: done.day })
      this.offerOwed()
    }
    if (!this.beforeDay) return make()
    // What is told only at the digest's time is read first; a source that fails holds nothing up.
    this.making = this.beforeDay(now)
      .catch((err: unknown) => this.o.log(`digest: what is read at the digest's time failed: ${errorText(err)}`))
      .then(make)
      .catch((err: unknown) => this.o.log(`digest: the day was not made: ${errorText(err)}`))
  }
  /**
   * The day's notice, owed until someone takes it: a host that made its day before its notifier was built (late in
   * boot) sends it at the first look that has one. One he has already seen on a desktop is not sent.
   */
  private offerOwed(): void {
    const day = this.store.setting('owed')
    if (!day || this.offering || !this.deliverer) return
    const made = this.store.day(day)
    const settle = (): void => {
      if (this.store.setting('owed') === day) this.store.setSetting('owed', '')
    }
    if (made?.seenAt != null) return settle()
    const rows = made ? this.store.rows({ day }).filter((r) => r.toldAt == null) : []
    this.offering = true
    let answer: ReturnType<Deliverer['digest']>
    try {
      answer = this.deliverer.digest(made ?? { day, madeAt: this.clock(), seenAt: null, count: 0 }, rows, () => this.store.setting('owed') === day && this.store.day(day)?.seenAt == null)
    } catch (err) {
      answer = false
      this.o.log(`digest: the day's notice was not sent: ${errorText(err)}`)
    }
    // An answer given at once settles at once; one still being sent holds off a second offer until it answers.
    if (!(answer instanceof Promise)) {
      this.offering = false
      if (answer !== false) settle()
      return
    }
    void answer
      .then((sent) => {
        if (sent !== false) settle()
      })
      .catch((err: unknown) => this.o.log(`digest: the day's notice was not sent: ${errorText(err)}`))
      .finally(() => {
        this.offering = false
      })
  }
  private pushRow(row: LedgerRow): void {
    this.o.push({ push: 'work.digest', row: wireRow(row) })
  }
  start(o: { interval?: false } = {}): () => void {
    this.tick()
    const timer = o.interval === false ? null : setInterval(() => this.guarded(), TICK_MS)
    return () => {
      if (timer) clearInterval(timer)
    }
  }
  private guarded(): void {
    try {
      this.tick()
    } catch (err) {
      this.o.log(`digest: a look at the ledger failed: ${errorText(err)}`)
    }
  }

  // ── reads ───────────────────────────────────────────────────────────
  list(o: { day?: string; since?: number } = {}): DigestList {
    return {
      days: o.day ? this.store.days().filter((d) => d.day === o.day) : this.store.days(),
      rows: this.store.rows(o).map(wireRow),
      waiting: this.store.waitingCount(),
      groups: groupsListed(this.o.modules())
    }
  }
  /**
   * The list once a day due now is made, its sources read: a linked host that asks at its own digest time is not
   * answered from a ledger a source pass is still filling. The wait is held inside the asker's limit
   * (`LIST_WAIT_MS`): past it the list is answered as it stands, its waiting rows among it, rather than not at all.
   *
   * `day`: that day's rows alone once this host has made that day's slot; until then every row, the waiting ones
   * counted by the asker (deliver.ts `ofDay`). So a row told here after its day was made waits for the next one.
   */
  async listMade(o: { day?: string; since?: number } = {}): Promise<DigestList> {
    const handled = (): number => Number(this.store.setting('handled') ?? NaN)
    if (this.o.enabled()) {
      if (Number.isFinite(handled()) && lastDigest(this.at(), this.zone(), this.clock()) > handled()) this.guarded()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.making, new Promise<void>((done) => void (timer = setTimeout(done, LIST_WAIT_MS)))])
      clearTimeout(timer)
    }
    // A day asked for that this host has not made yet: every row, so the asker counts the waiting ones too.
    if (o.day && !(Number.isFinite(handled()) && dayOf(this.zone(), handled()) >= o.day)) return this.list({ since: o.since })
    return this.list(o)
  }
  seen(day: string): void {
    const before = this.store.day(day)
    if (!before || before.seenAt != null) return
    const after = this.store.seen(day, this.clock())
    if (after) this.o.push({ push: 'work.digest', day: after })
  }
  workspaceRemoved(workspaceId: string): void {
    for (const id of this.store.removeWorkspace(workspaceId)) this.o.push({ push: 'work.digest', gone: id })
  }
}

/**
 * Who a push may reach unasked. A row about a held item names a draft's recipients and subject, so it goes only to
 * the keys that may decide one, as the Outbox's own push does (outbox/index.ts); a read-only key reads it when it
 * asks (`work.digest.list`). Everything else, and a `gone` (an id alone), reaches every key that may read.
 */
export const pushNeed = (p: DigestPush): 'read' | 'approve' => (p.row && (p.row.group === 'held' || (!!p.row.open && 'held' in p.row.open)) ? 'approve' : 'read')

/** A ledger row as the wire carries it. */
export const wireRow = ({ due: _due, ...row }: LedgerRow): Omit<LedgerRow, 'due'> => row

/** Each linked host's rows for `day`, asked with the day, so one that has made it answers that day's rows alone (`listMade`). */
export const peerDays = (far: Pick<HostRead, 'hosts' | 'read'> | undefined, day: string): Promise<TellRow[]>[] =>
  (far?.hosts() ?? []).map((host) => far!.read<DigestList>(host, 'digest', 'list', { day }).then((list) => ofDay(list, day)))

const hosts = new WeakMap<WorkCtx, Digest>()
/** The digest of a context, for its module and its sources; undefined when the part could not be made. */
export const digestOf = (ctx: WorkCtx): Digest | undefined => hosts.get(ctx)

/**
 * The part is total: siblings call `ctx.tell?.(…)` with no try, so nothing
 * here may throw, not while it is made and not when it is called. A fault is
 * logged once and the call returns.
 */
export const tellPart: CtxPart<'tell'> = (ctx, deps) => {
  let said = false
  const fault = (what: string, err: unknown): void => {
    if (said) return
    said = true
    try {
      ctx.log(`digest: ${what}: ${errorText(err)}`)
    } catch {
      /* a log that throws stops nothing */
    }
  }
  let digest: Digest | null = null
  try {
    digest = new Digest({ db: deps.db, host: deps.environmentId, enabled: () => ctx.enabled(), log: (line) => ctx.log(line), push: (p) => ctx.push(p, { need: pushNeed(p) }), modules: () => WORK_MODULES })
    // The notifier is built late in boot: until then nothing takes a row, and it is kept as due.
    digest.deliverer = makeDeliverer({
      notifier: () => deps.notifier?.() ?? null,
      sendsDigest: () => deps.sendsDigest?.() ?? true,
      // Each reachable Work host's own ledger, over the transport Work's cross-host calls ride (work/peer.ts): the
      // hosts this one dials and the ones that dialed it, so the box reaches a Mac it has not saved.
      peers: (day) => peerDays(hostReadOf(ctx), day),
      log: (line) => ctx.log(line)
    })
    hosts.set(ctx, digest)
    const made = digest
    // Sources: the news of a pillar that hands a read, not a tell (sources/).
    const sources = new Sources({
      ctx,
      modules: () => WORK_MODULES,
      sources: SOURCES,
      day: (now) => dayOf(made.zone(), lastDigest(made.at(), made.zone(), now)),
      zone: () => made.zone(),
      since: () => made.store.days()[0]?.madeAt ?? 0,
      kept: {
        get: (key) => made.store.setting(`source:${key}`),
        set: (key, value) => made.store.setSetting(`source:${key}`, value)
      },
      // Whether the ledger kept it: a source's cutoff moves only past what was kept (`SourceRead.done`).
      tell: (t) => {
        try {
          return made.tell(t) != null
        } catch (err) {
          ctx.log(`digest: a source's tell was not kept: ${errorText(err)}`)
          return false
        }
      }
    })
    made.beats.push((now) => sources.beat(now))
    made.beforeDay = (now) => sources.beforeDay(now)
    // The gate for threads that started on their own (gate.ts). The notifier is built late in boot, so it is
    // handed the gate at the first look that finds it; with Work off it has none.
    const gate = makeGate({
      enabled: () => ctx.enabled(),
      isQuiet: (sessionId) => made.store.isQuiet(sessionId),
      workspaceOf: (sessionId) => ctx.scopeOf(sessionId)?.workspaceId ?? null,
      pressed: runPressed(ctx, () => WORK_MODULES),
      // He wrote in the thread himself: it is his from then on (events.ts `writtenByOwner`).
      ownerWrote: (sessionId) => deps.registry.eventsAfter(sessionId, 0).some((row) => row.event.type === 'user-text' && !!row.event.by && writtenByOwner(row.event.by)),
      tell: (t) => made.tell(t) != null,
      log: (line) => ctx.log(line)
    })
    let gated: Notifier | null = null
    made.beats.push(() => {
      const notifier = deps.notifier?.() ?? null
      if (!notifier || notifier === gated) return
      notifier.setGate(gate)
      gated = notifier
    })
    deps.whileOn(() => () => {
      gated?.setGate(null)
      gated = null
    })
  } catch (err) {
    fault('ctx.tell did not start', err)
  }
  const quietly =
    <A>(what: string, run: (d: Digest, a: A) => void) =>
    (a: A): void => {
      try {
        if (digest) run(digest, a)
      } catch (err) {
        fault(what, err)
      }
    }
  const tell = Object.assign(
    quietly<Tell>('a tell was not kept', (d, t) => void d.tell(t)),
    {
      done: quietly<string>('a tell was not withdrawn', (d, key) => d.done(key)),
      only: (prefix: string, keys: readonly string[]): void => quietly<readonly string[]>('tells were not withdrawn', (d, k) => d.only(prefix, k))(keys),
      quiet: quietly<string>('a quiet thread was not kept', (d, id) => d.quiet(id))
    }
  )
  return { tell }
}
