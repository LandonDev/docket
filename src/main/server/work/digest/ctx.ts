import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DigestDay, DigestList, DigestPush, DigestSettings } from '@shared/contract-work-digest'
import { writtenByOwner } from '@shared/events'
import { errorText } from '@shared/work/ids'
import { DEFAULT_AT, DEFAULT_LEVEL } from '@shared/work/digest'
import { DETAIL_MAX, TELL_GROUPS, TELL_LEVELS, TITLE_MAX, tellLine, TellOpenSchema, type Tell, type TellGroup, type TellKind, type TellLevel } from '@shared/work/tell'
import type { CtxPart } from '../ctx'
import { WORK_MODULES, type WorkCtx } from '../modules'
import { hostReadOf } from '../peer'
import { dayOf, knownZone, lastDigest, nextDigest, zoneOr } from './clock'
import type { Notifier } from '../../remote/notifier'
import { makeDeliverer, ofDay } from './deliver'
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
  /** The day's one notice, of the rows that waited. */
  digest(day: DigestDay, rows: LedgerRow[]): void
}

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
  settings(): DigestSettings {
    const setAt = Number(this.store.setting('setAt') ?? NaN)
    return { at: this.at(), zone: this.zone(), levels: this.levels(), nextAt: this.nextAt(), ...(Number.isFinite(setAt) ? { setAt } : {}) }
  }
  set(patch: { at?: string; levels?: Partial<Record<TellGroup, TellLevel>> }): DigestSettings {
    if (patch.at && patch.at !== this.at()) {
      this.store.setSetting('at', patch.at)
      this.settled()
    }
    if (patch.levels) {
      // Only what he changed is kept: a group set back to the default has no row.
      const next = { ...this.levels(), ...patch.levels }
      for (const g of TELL_GROUPS) if (next[g] === DEFAULT_LEVEL) delete next[g]
      this.store.setSetting('levels', JSON.stringify(next))
    }
    // When he last set them here: a window brings a host that missed a write to the newest (the renderer's store).
    if (patch.at || patch.levels) this.store.setSetting('setAt', String(this.clock()))
    const settings = this.settings()
    this.o.push({ push: 'work.digest', settings })
    return settings
  }
  /** The desktop he is at says its zone; the newest is kept. */
  here(zone: string): void {
    if (!knownZone(zone)) throw new Error(`unknown time zone: ${zone}`)
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
      if (same) return prev
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
        const next = this.tellNow(row, now)
        if (!next.due) this.pushRow(next)
      }
    }
    const next = this.nextAt(now)
    for (const row of this.store.clocked(now)) {
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
      this.store.setSetting('handled', String(at))
      this.makingAt = null
      const made = makeDay(this.store, day, this.clock())
      if (made) this.o.push({ push: 'work.digest', day: made.day })
      try {
        // A day this host has nothing for is still handed on: the host that sends the phone's digest adds what
        // its linked hosts hold, and a Mac's jobs must not go unsaid because the box has none of its own.
        this.deliverer?.digest(made?.day ?? { day, madeAt: this.clock(), seenAt: null, count: 0 }, made?.rows ?? [])
      } catch (err) {
        this.o.log(`digest: the day's notice was not sent: ${errorText(err)}`)
      }
    }
    if (!this.beforeDay) return make()
    // What is told only at the digest's time is read first; a source that fails holds nothing up.
    this.making = this.beforeDay(now)
      .catch((err: unknown) => this.o.log(`digest: what is read at the digest's time failed: ${errorText(err)}`))
      .then(make)
      .catch((err: unknown) => this.o.log(`digest: the day was not made: ${errorText(err)}`))
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

/** A ledger row as the wire carries it. */
export const wireRow = ({ due: _due, ...row }: LedgerRow): Omit<LedgerRow, 'due'> => row

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
    digest = new Digest({ db: deps.db, host: deps.environmentId, enabled: () => ctx.enabled(), log: (line) => ctx.log(line), push: (p) => ctx.push(p, { need: 'read' }), modules: () => WORK_MODULES })
    // The notifier is built late in boot: until then nothing takes a row, and it is kept as due.
    digest.deliverer = makeDeliverer({
      notifier: () => deps.notifier?.() ?? null,
      sendsDigest: () => deps.sendsDigest?.() ?? true,
      // Each reachable Work host's own ledger, over the transport Work's cross-host calls ride (work/peer.ts): the
      // hosts this one dials and the ones that dialed it, so the box reaches a Mac it has not saved.
      peers: (day) => {
        const far = hostReadOf(ctx)
        return (far?.hosts() ?? []).map((host) => far!.read<DigestList>(host, 'digest', 'list', {}).then((list) => ofDay(list, day)))
      },
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
      since: () => made.store.days()[0]?.madeAt ?? 0
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
      tell: (t) => void made.tell(t),
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
