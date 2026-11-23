import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  LIFEOS_TRIGGER_KINDS,
  parseSchedule,
  scheduleWords,
  type LifeosTriggerKind,
  type RoutineJobOpen,
  type RoutineRow,
  type RoutineRun
} from '@shared/contract-work-routines'
import { errorText, type Trigger, type TriggerSource } from '@shared/work'
import type { SessionMeta } from '@shared/events'
import type { AddonCallResult } from '../../addons/addonWire'
import type { WorkCtx } from '../modules'
import type { LifeosHeld } from '../outbox/outbox'
import { BUSY, type RoutinesHost } from './host'
import { dueCount, nextAt } from './schedule'
import { PlayStore } from './plays'
import { RoutineStore, type Cursor, type Routine } from './store'

/**
 * The scheduler (architecture §11.1). One tick every half minute, beside
 * the host's other sweeps, fires what is due:
 *
 *  - `schedule`: at each due time; times missed while the host was down
 *    fold into one run that says how many.
 *  - `read`: the host calls a tool the owner set to Runs, with the
 *    arguments fixed when the watch was made, no model at all, and fires
 *    when the answer changes (or is not empty).
 *  - `file`: a file on this host is looked at by its size and time, and
 *    hashed when those move; a change this host's Work wrote itself
 *    (`noteOwnWrite`) fires nothing. A LifeOS document or sheet fires on its
 *    `doc.changed` or `sheet.changed` event. Other places (Google, Excel,
 *    Frame.io) arm through their pillar's `triggers`.
 *  - `lifeos`: one `lifeosEvents.since` subscription per workspace,
 *    fanned out to its routines, each keeping its own cursor.
 *
 * A firing starts a new root Work thread (`ctx.threads.start`, so the
 * queue and the running cap apply) carrying the run's id, or, for a watch an
 * agent set, wakes that thread with what changed, or, for a routine with a
 * `job`, runs a pillar's host job with no thread and no model. When the run's thread
 * settles with nothing held, nothing asked and no failure it is marked read;
 * otherwise unread, so a quiet morning leaves nothing to look at.
 */

export const TICK_MS = 30_000
/** How often a file on this host is looked at. */
export const FILE_EVERY_MS = 60_000
/** What of a watched read a woken thread is told, or a run starts with. */
const NOTICE_MAX = 4000
/** How long a watch's read may take before the host gives up on it. */
export const READ_TIMEOUT_MS = 60_000

const cut = (text: string): string => (text.length > NOTICE_MAX ? `${text.slice(0, NOTICE_MAX)}…` : text)

export const LIFEOS_SINCE = 'lifeosEvents:since'

export interface LifeosEvent {
  sector: string
  kind: string
  ref: { table: string; id: string }
  at: number
}

/** A registered job as the engine runs it: its pillar's `RoutineJob` with the context bound. */
export interface HostJob {
  name: string
  run(at: { workspaceId: string; firedAt: number }): Promise<{ words: string; open?: RoutineJobOpen }>
}

export interface EngineDeps {
  ctx: Pick<WorkCtx, 'db' | 'host' | 'log' | 'push' | 'threads' | 'lifeos'>
  host: RoutinesHost
  now(): number
  /** Other pillars' trigger sources, for places this pillar does not watch itself. */
  sources?(): TriggerSource[]
  /** A file's look, for a test; default: the disk. */
  files?: { stat(path: string): { mtimeMs: number; size: number } | null; read(path: string): Buffer | null }
  /** The Outbox's live list of LifeOS's held items, null while it is not watching LifeOS: a run's drafts are counted from it. */
  lifeosHeld?(): Pick<LifeosHeld, 'items' | 'loaded'> | null
  /** A job a loaded pillar registered (`WorkModule.jobs`), by id; null when none on this host has it. */
  job?(id: string): HostJob | null
}

const disk = {
  stat(path: string) {
    try {
      const s = statSync(path)
      return { mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      return null
    }
  },
  read(path: string) {
    try {
      return readFileSync(path)
    } catch {
      return null
    }
  }
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/** Hashes of files this host's Work wrote itself, so a file trigger fires only on someone else's change. */
const ownWrites = new Set<string>()
/** A pillar that writes a file calls this with the bytes it wrote: a routine watching that file does not fire on it. */
export function noteOwnWrite(path: string, data: string | Buffer): void {
  ownWrites.add(`${path}\n${sha(data)}`)
  if (ownWrites.size > 500) ownWrites.delete(ownWrites.values().next().value!)
}

/** A tool's answer as text: its text parts joined. */
export function resultText(result: AddonCallResult): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

const emptyAnswer = (text: string): boolean => /^\s*(\[\s*\]|\{\s*\}|null|none|no results?\.?)?\s*$/i.test(text)

const lifeosWords = (kinds: readonly string[]): string => {
  const words = kinds.map((k) => LIFEOS_TRIGGER_KINDS[k as LifeosTriggerKind] ?? k)
  return words.length ? (words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} or ${words.at(-1)!.toLowerCase()}`) : 'Any LifeOS event'
}

/** The pillar's source that watches a file's place (Excel, Google, Frame.io); this pillar watches files here and LifeOS itself. */
function fileSourceFor(t: Extract<Trigger, { on: 'file' }>, sources: readonly TriggerSource[]): TriggerSource | null {
  const at = t.source.at
  if (at === 'file' || at === 'lifeos') return null
  return sources.find((s) => s.on === 'file' && s.at === at) ?? null
}

/** A trigger in plain words, never a tag. */
export function triggerWords(t: Trigger, sources: readonly TriggerSource[] = []): string {
  if (t.on === 'schedule') {
    const s = parseSchedule(t.rrule)
    return s ? scheduleWords(s) : 'On a schedule'
  }
  if (t.on === 'lifeos') return lifeosWords(t.kinds)
  if (t.on === 'read') return scheduleWords({ every: 'minutes', interval: Math.max(1, Math.round(t.everySec / 60)) })
  const other = fileSourceFor(t, sources)
  if (other) {
    try {
      return other.words(t)
    } catch {
      // fall through to our own words
    }
  }
  return 'When someone else changes it'
}

/** The LifeOS events a routine listens to, or null when it hears none. */
function heardKinds(t: Trigger): { kinds: string[]; ref?: { table: string; id: string }; filter?: Record<string, string> } | null {
  if (t.on === 'lifeos') return { kinds: t.kinds, ...(t.filter ? { filter: t.filter } : {}) }
  if (t.on === 'file' && t.source.at === 'lifeos') return { kinds: ['doc.changed', 'sheet.changed'], ref: { table: t.source.table, id: t.source.id } }
  return null
}

function heard(r: Routine, e: LifeosEvent): boolean {
  const h = heardKinds(r.trigger)
  if (!h) return false
  if (h.kinds.length && !h.kinds.includes(e.kind)) return false
  if (h.ref && (h.ref.table !== e.ref.table || h.ref.id !== e.ref.id)) return false
  for (const [key, value] of Object.entries(h.filter ?? {})) {
    if (key === 'table' && e.ref.table !== value) return false
    if (key === 'id' && e.ref.id !== value) return false
  }
  return true
}

const eventsCause = (events: readonly LifeosEvent[]): string => {
  const mail = events.filter((e) => e.kind === 'mail.received').length
  if (mail === events.length) return mail === 1 ? 'New mail' : `${mail} new mail`
  const first = LIFEOS_TRIGGER_KINDS[events[0]!.kind as LifeosTriggerKind] ?? events[0]!.kind
  return events.length === 1 ? first : `${first}, and ${events.length - 1} more`
}

interface Feed {
  sector: string
  after: number
  gen: number
  off: () => void
}

export class RoutinesEngine {
  readonly store: RoutineStore
  private ticking: Promise<void> | null = null
  private feeds = new Map<string, Feed>()
  /** other pillars' triggers armed for routines, by routine id */
  private armed = new Map<string, { spec: string; off: () => void }>()
  private stopped = false
  /** reads in flight, by routine id: the next tick skips a routine whose read has not answered */
  private reading = new Set<string>()
  /** what a pass set going and did not wait for: a test waits on it (`drain`) */
  private pending = new Set<Promise<unknown>>()
  /** threads seen working, so a run is not taken for settled before its thread began */
  private seenBusy = new Set<string>()
  /** each feed's own token: a subscription that answers inside its own call replaces the feed by token, never by cursor */
  private feedGen = 0

  constructor(private readonly deps: EngineDeps) {
    this.store = new RoutineStore(deps.ctx.db)
  }

  private get ctx() {
    return this.deps.ctx
  }

  /** The engine's clock: the host's, or a test's. */
  clock(): number {
    return this.deps.now()
  }

  private now(): number {
    return this.deps.now()
  }

  private changed(r: Pick<Routine, 'id' | 'workspaceId'>): void {
    this.ctx.push({ push: 'work.routines', workspaceId: r.workspaceId, id: r.id })
  }

  /** Starts the tick and the settle watch; returns the stop. `interval: false` leaves ticking to the caller (a test). */
  start(o: { interval?: boolean } = {}): () => void {
    this.stopped = false
    const offMeta = this.deps.host.onMeta((s) => this.metaChanged(s))
    this.recover()
    const timer = o.interval === false ? null : setInterval(() => void this.tick(), TICK_MS)
    timer?.unref?.()
    if (o.interval !== false) void this.tick()
    return () => {
      this.stopped = true
      offMeta()
      if (timer) clearInterval(timer)
      for (const feed of this.feeds.values()) feed.off()
      this.feeds.clear()
      for (const a of this.armed.values()) a.off()
      this.armed.clear()
    }
  }

  /**
   * At boot: a run cut off before its thread existed failed, unless the
   * thread was made before the stop; one whose thread settled while the host
   * was down settles now. A thread left `stopped` stays its run's: the boot
   * resumer or the owner may finish it, and a firing due meanwhile folds in.
   */
  recover(): void {
    for (const run of this.store.unsettled()) {
      // A job runs in this process: a stop cut it off, and no thread may finish it.
      if (!run.sessionId && this.store.get(run.routineId)?.job) {
        this.store.settle(run.id, 'failed', 'Failed: the host stopped before the job finished')
        continue
      }
      const sessionId = run.sessionId ?? this.deps.host.threadOfRun(run.id)
      if (!sessionId) {
        this.store.settle(run.id, 'failed', 'Failed: the host stopped before its thread started')
        continue
      }
      if (!run.sessionId) this.store.started(run.id, sessionId)
      this.sessionChanged(sessionId, true)
    }
  }

  /** What a pass set going: resolves once it is all done. For a test. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }

  private track(p: Promise<unknown>): void {
    const done = p.catch((err) => this.ctx.log(`routines: ${errorText(err)}`)).finally(() => this.pending.delete(done))
    this.pending.add(done)
  }

  /** One pass: ends what is over, fires what is due, keeps the LifeOS feeds and other pillars' triggers in step. Never two at once. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = this.pass().finally(() => (this.ticking = null))
    return this.ticking
  }

  /** Nothing slow is awaited here: a read or a thread's start runs on its own, so one slow add-on never holds back another routine's time. */
  private async pass(): Promise<void> {
    if (this.stopped) return
    const now = this.now()
    for (const r of this.store.active()) {
      if (r.untilAt !== null && r.untilAt <= now) {
        this.store.end(r.id, 'Ended')
        this.changed(r)
        continue
      }
      const t = r.trigger
      if (t.on === 'schedule') {
        if (r.nextAt === null || r.nextAt > now) continue
        const s = parseSchedule(t.rrule)
        if (!s) continue
        const due = dueCount(s, t.tz, r.nextAt, now)
        this.track(this.fire(r, triggerWords(t), Math.max(0, due - 1), { nextAt: nextAt(s, t.tz, now) }))
      } else if (t.on === 'read') {
        if ((r.nextAt !== null && r.nextAt > now) || this.reading.has(r.id)) continue
        this.store.setNext(r.id, now + t.everySec * 1000)
        this.reading.add(r.id)
        this.track(this.read(r, t).finally(() => this.reading.delete(r.id)))
      } else if (t.on === 'file' && t.source.at === 'file') {
        if (r.nextAt !== null && r.nextAt > now) continue
        this.store.setNext(r.id, now + FILE_EVERY_MS)
        this.look(r, t.source.host, t.source.path)
      }
    }
    this.keepFeeds()
    this.keepArmed()
  }

  // ── firing ────────────────────────────────────────────────────────────

  /**
   * One firing. `nextAt` is the schedule's next due time, written with the
   * run's row. A routine whose last run still works takes no second one:
   * the firing folds into the run in flight, and what it heard (a mail, a
   * read's answer) is told to that run's thread so nothing is lost. A run
   * whose thread failed or is gone while it waited is closed first.
   * The routine is read afresh: one paused, changed or removed since the
   * pass looked fires nothing. `force` (Run now) fires a paused one.
   */
  async fire(seen: Routine, cause: string, folded = 0, o: { nextAt?: number | null; detail?: string; force?: boolean } = {}): Promise<RoutineRun | null> {
    const r = this.store.get(seen.id)
    if (!r || r.proposed || r.ended || (!r.enabled && !o.force) || JSON.stringify(r.trigger) !== JSON.stringify(seen.trigger)) return null
    const now = this.now()
    let flying = this.store.inFlight(r.id)
    if (flying?.sessionId) {
      const status = this.deps.host.session(flying.sessionId)?.status
      if (!status || status === 'error' || status === 'stopped') {
        this.store.settle(flying.id, 'failed', status ? 'Failed' : 'Failed: its thread was deleted')
        flying = null
      }
    }
    if (flying) {
      this.store.addFolded(flying.id, folded + 1, o.nextAt !== undefined ? { routineId: r.id, nextAt: o.nextAt } : undefined)
      if (o.detail && flying.sessionId) await this.ctx.threads.resume(flying.sessionId, `More for this run of “${r.name}”: ${cause}.\n${cut(o.detail)}`).catch(() => {})
      return null
    }
    if (r.resumeSessionId) return this.wake(r, cause, o)
    if (r.job) return this.runJob(r, r.job, cause, folded, o)
    const run = this.store.newRun(r.id, now, cause, folded, 'starting', { ...(o.nextAt !== undefined ? { nextAt: o.nextAt } : {}) })
    if (r.once) this.store.end(r.id, 'Ran once')
    this.changed(r)
    try {
      // A routine that runs a play reads it now, so his last edit of the play is what runs.
      const play = r.playId ? new PlayStore(this.ctx.db).get(r.playId) : null
      if (r.playId && (!play || play.proposed)) throw new Error('its play was removed')
      if (play?.takes.length) throw new Error(`its play now takes ${play.takes.join(', ')}`)
      const body = play ? [play.instructions.trim(), r.prompt.trim()].filter(Boolean).join('\n\n') : r.prompt
      const text = `${body}\n\n---\nStarted by the routine “${r.name}”${play ? `, which runs the play “${play.name}”` : ''}: ${cause}${folded ? ` (${folded + 1} times due since the last run; this one run covers them)` : ''}.${o.detail ? `\n${cut(o.detail)}` : ''}`
      const sessionId = await this.ctx.threads.start({
        workspaceId: r.workspaceId,
        ...(r.projectId ? { projectId: r.projectId } : {}),
        text,
        ...(r.model ? { model: r.model } : {}),
        routineRunId: run.id
      })
      this.store.started(run.id, sessionId)
      // A thread can settle before its id comes back (a refusal, a queue): look once now.
      this.sessionChanged(sessionId)
    } catch (err) {
      this.store.settle(run.id, 'failed', `Failed: ${errorText(err)}`)
      this.ctx.log(`routine ${r.id} did not start: ${errorText(err)}`)
    }
    this.changed(r)
    return this.store.run(run.id)
  }

  /** A watch an agent set: its firing wakes that thread with what changed, and a watch with no day ends with it. */
  private async wake(r: Routine, cause: string, o: { nextAt?: number | null; detail?: string }): Promise<RoutineRun | null> {
    const sessionId = r.resumeSessionId!
    const now = this.now()
    if (!this.deps.host.session(sessionId)) {
      const run = this.store.newRun(r.id, now, cause, 0, 'failed', { summary: 'Failed: its thread is gone' })
      this.store.end(r.id, 'Its thread is gone')
      this.changed(r)
      return run
    }
    const run = this.store.newRun(r.id, now, cause, 0, 'fired', { sessionId, summary: 'Woke its thread', ...(o.nextAt !== undefined ? { nextAt: o.nextAt } : {}) })
    if (r.once || r.untilAt === null) this.store.end(r.id, 'Fired')
    this.changed(r)
    const detail = o.detail ? `\n\n${cut(o.detail)}` : ''
    try {
      await this.ctx.threads.resume(sessionId, `Your watch “${r.name}” fired: ${cause}.${detail}`)
    } catch (err) {
      this.store.settle(run.id, 'failed', `Failed: ${errorText(err)}`)
      this.changed(r)
    }
    return this.store.run(run.id)
  }

  /**
   * A routine that runs a host job: its run row and next due time are written
   * in one step, as any firing's, then the job runs on its own (`track`), so a
   * pass or Run now never waits on it. No thread: nothing is marked read or
   * unread and nothing held is counted. A job no loaded pillar has fails the run.
   */
  private runJob(r: Routine, id: string, cause: string, folded: number, o: { nextAt?: number | null }): RoutineRun | null {
    const firedAt = this.now()
    const run = this.store.newRun(r.id, firedAt, cause, folded, 'running', { ...(o.nextAt !== undefined ? { nextAt: o.nextAt } : {}) })
    if (r.once) this.store.end(r.id, 'Ran once')
    this.changed(r)
    const job = this.deps.job?.(id) ?? null
    if (!job) {
      this.store.settle(run.id, 'failed', 'Failed: its job is not on this host')
      this.changed(r)
      return this.store.run(run.id)
    }
    this.track(
      (async () => {
        try {
          const done = await job.run({ workspaceId: r.workspaceId, firedAt })
          this.store.settle(run.id, 'quiet', done.words, done.open)
        } catch (err) {
          this.store.settle(run.id, 'failed', `Failed: ${errorText(err)}`)
          this.ctx.log(`routine ${r.id}: job ${id} failed: ${errorText(err)}`)
        }
        this.changed(r)
      })()
    )
    return this.store.run(run.id)
  }

  /** Run now, whatever the trigger. */
  runNow(r: Routine): Promise<RoutineRun | null> {
    return this.fire(r, 'Run now', 0, { force: true })
  }

  // ── settling ──────────────────────────────────────────────────────────

  /** Any thread changed: its own run, or the run of the thread at the top of its tree (a subagent settling may settle the run). */
  private metaChanged(s: Pick<SessionMeta, 'id' | 'status' | 'routineRunId' | 'parentId'>): void {
    if (BUSY.has(s.status ?? '')) this.seenBusy.add(s.id)
    let top: Pick<SessionMeta, 'id' | 'routineRunId' | 'parentId'> | null = s
    for (let hops = 0; top && !top.routineRunId && top.parentId && hops < 32; hops++) top = this.deps.host.session(top.parentId)
    this.sessionChanged(top?.routineRunId ? top.id : s.id)
  }

  /**
   * A run's thread changed: when it and every thread under it have settled,
   * so has the run. Quiet runs are marked read; the rest unread. A thread
   * left `stopped` (the host went down under it) is not settled: the boot
   * resumer or the owner may finish it. `booting`: seen at boot, when an
   * idle thread has finished while the host was down.
   */
  private sessionChanged(sessionId: string, booting = false): void {
    const s = this.deps.host.session(sessionId)
    const runId = s?.routineRunId
    if (!s || !runId) {
      if (!s) this.goneThread(sessionId)
      return
    }
    if (BUSY.has(s.status)) this.seenBusy.add(sessionId)
    const run = this.store.run(runId)
    if (!run || run.state !== 'running' || run.sessionId !== sessionId) return
    const r = this.store.get(run.routineId)
    if (s.status === 'idle' || s.status === 'done') {
      // An idle thread that never worked has not begun; one whose subagents still work has not ended.
      if ((!booting && !this.seenBusy.has(sessionId)) || this.deps.host.busyBelow(sessionId)) return
      this.seenBusy.delete(sessionId)
      const held = this.heldBy(run.id, sessionId)
      if (held > 0) {
        this.store.settle(run.id, 'held', `Held ${held}`)
        this.deps.host.markUnread(sessionId)
      } else {
        this.store.settle(run.id, 'quiet', 'Nothing held')
        this.deps.host.markRead(sessionId)
      }
    } else if (s.status === 'waiting') {
      this.store.settle(run.id, 'asked', 'Waiting on you')
      this.deps.host.markUnread(sessionId)
    } else if (s.status === 'error') {
      this.seenBusy.delete(sessionId)
      this.store.settle(run.id, 'failed', 'Failed')
      this.deps.host.markUnread(sessionId)
    } else return
    if (r) this.changed(r)
  }

  /**
   * What a run left for the owner. LifeOS's drafts are counted from the Outbox's own list, by the run their
   * origin names, whenever the Outbox is watching LifeOS: a draft made by any path (a Codex or Muse bridge
   * call, a subagent, a tool the transcript names otherwise) counts, and one already sent or discarded does
   * not. Without that list, or before LifeOS has first answered it (at boot, or with LifeOS out of reach), the
   * transcripts are read instead.
   */
  private heldBy(runId: string, sessionId: string): number {
    const lifeos = this.deps.lifeosHeld?.()
    if (!lifeos?.loaded()) return this.deps.host.heldIn(sessionId)
    const drafts = lifeos.items().filter((i) => i.routineRunId === runId && (i.state === 'held' || i.state === 'live' || i.state === 'failed')).length
    return this.deps.host.heldIn(sessionId, { drafts: false }) + drafts
  }

  /** A run's thread that no longer exists ends its run. */
  private goneThread(sessionId: string): void {
    const row = this.ctx.db.prepare(`SELECT id FROM work_routine_runs WHERE session_id = ? AND state = 'running'`).get(sessionId) as { id: string } | undefined
    if (row) this.store.settle(row.id, 'failed', 'Failed: its thread was deleted')
  }

  // ── watched reads ─────────────────────────────────────────────────────

  private async read(r: Routine, t: Extract<Trigger, { on: 'read' }>): Promise<void> {
    const host = this.deps.host
    const now = this.now()
    // Its add-on left the workspace's reach since the watch was made (a global one no longer For Work, or removed): it ends.
    if (!host.addon(r.workspaceId, t.addon)) {
      this.store.end(r.id, 'Its add-on is no longer in this workspace')
      this.changed(r)
      return
    }
    // The owner may have set the tool back since the watch was made: a watch never reads with a tool that would be held.
    if (!host.mayRead(t.addon, t.tool)) {
      this.store.setLastWords(r.id, 'Waiting: its tool is not set to Runs')
      this.changed(r)
      return
    }
    let text: string
    try {
      const result = await host.read(t.addon, t.tool, (t.args ?? {}) as Record<string, unknown>, AbortSignal.timeout(READ_TIMEOUT_MS))
      text = resultText(result)
      if ((result as { isError?: boolean }).isError) throw new Error(text || 'the tool answered with an error')
    } catch (err) {
      this.store.setCursor(r.id, { ...r.cursor, readAt: now }, `Read failed: ${errorText(err)}`)
      this.changed(r)
      return
    }
    // The owner may have paused, changed or removed it while the read ran: then this answer is not its.
    const now2 = this.store.get(r.id)
    if (!now2 || !now2.enabled || now2.ended || JSON.stringify(now2.trigger) !== JSON.stringify(r.trigger)) return
    const hash = sha(text)
    const before = r.cursor.hash
    const fire = t.fire === 'changed' ? before !== undefined && hash !== before : !emptyAnswer(text) && hash !== before
    this.store.setCursor(r.id, { ...r.cursor, hash, readAt: now }, fire ? undefined : null)
    if (fire) await this.fire(now2, t.fire === 'changed' ? 'What it reads changed' : 'It found something', 0, { detail: text })
    else this.changed(r)
  }

  // ── files ─────────────────────────────────────────────────────────────

  private look(r: Routine, host: string, path: string): void {
    if (host !== this.ctx.host) {
      this.store.setLastWords(r.id, 'Waiting: the file is on another host')
      return
    }
    const files = this.deps.files ?? disk
    const now = this.now()
    const st = files.stat(path)
    if (!st) {
      this.store.setCursor(r.id, { ...r.cursor, readAt: now }, 'Waiting: the file is not there')
      return
    }
    const key = `${st.mtimeMs}:${st.size}`
    if (r.cursor.key === key) {
      this.store.setCursor(r.id, { ...r.cursor, readAt: now })
      return
    }
    const data = files.read(path)
    if (!data) return
    const hash = sha(data)
    const cursor: Cursor = { ...r.cursor, key, hash, readAt: now }
    const theirs = r.cursor.hash !== undefined && hash !== r.cursor.hash && !ownWrites.has(`${path}\n${hash}`)
    this.store.setCursor(r.id, cursor, theirs ? undefined : null)
    if (theirs) this.track(this.fire(r, `${basename(path)} changed`, 0, { detail: `The file: ${path}` }))
  }

  /** Places this pillar does not watch (Google, Excel, Frame.io): their pillar's trigger, armed while the routine is active. */
  private keepArmed(): void {
    const sources = this.deps.sources?.() ?? []
    const want = new Map(this.store.active().flatMap((r) => (r.trigger.on === 'file' && r.trigger.source.at !== 'file' && r.trigger.source.at !== 'lifeos' ? [[r.id, r] as const] : [])))
    for (const [id, a] of this.armed) {
      const r = want.get(id)
      if (!r || JSON.stringify(r.trigger) !== a.spec) {
        a.off()
        this.armed.delete(id)
      }
    }
    for (const [id, r] of want) {
      if (this.armed.has(id)) continue
      const source = r.trigger.on === 'file' ? fileSourceFor(r.trigger, sources) : null
      if (!source) {
        if (r.lastWords === null) {
          this.store.setLastWords(id, 'Waiting: nothing watches files there yet')
          this.changed(r)
        }
        continue
      }
      try {
        const off = source.arm(r.trigger, (cause) => this.track(this.fire(r, cause)), r.cursor)
        this.armed.set(id, { spec: JSON.stringify(r.trigger), off })
      } catch (err) {
        this.store.setLastWords(id, `Waiting: ${errorText(err)}`)
      }
    }
  }

  // ── LifeOS events ─────────────────────────────────────────────────────

  /** Why a routine cannot fire now, or null. */
  waiting(r: Routine): string | null {
    if (!heardKinds(r.trigger)) return null
    if (!this.deps.host.workspace(r.workspaceId)?.sector) return 'Its workspace has no LifeOS sector'
    if (!this.ctx.lifeos.connected()) return 'Waiting on LifeOS'
    return null
  }

  /** One `since` subscription per workspace with a routine that listens, from the oldest cursor among them. */
  private keepFeeds(): void {
    const want = new Map<string, number>()
    if (this.ctx.lifeos.connected()) {
      for (const r of this.store.active()) {
        if (!heardKinds(r.trigger)) continue
        const after = r.cursor.after ?? r.createdAt
        want.set(r.workspaceId, Math.min(want.get(r.workspaceId) ?? Infinity, after))
      }
    }
    for (const [ws, feed] of this.feeds) {
      if (!want.has(ws)) {
        feed.off()
        this.feeds.delete(ws)
      }
    }
    for (const [ws, after] of want) {
      const sector = this.deps.host.workspace(ws)?.sector
      if (!sector) continue
      const feed = this.feeds.get(ws)
      if (feed && feed.sector === sector) continue
      feed?.off()
      this.feeds.delete(ws)
      this.follow(ws, sector, after)
    }
  }

  private follow(ws: string, sector: string, after: number): void {
    const feed: Feed = { sector, after, gen: ++this.feedGen, off: () => {} }
    // In place before the call: a subscription may answer inside it.
    this.feeds.set(ws, feed)
    try {
      feed.off = this.ctx.lifeos.subscribe<{ events: LifeosEvent[]; next: number } | null>(LIFEOS_SINCE, { sector, after }, (page) => this.took(ws, feed.gen, page))
    } catch (err) {
      if (this.feeds.get(ws) === feed) this.feeds.delete(ws)
      this.ctx.log(`routines: no LifeOS feed for ${ws}: ${errorText(err)}`)
      return
    }
    // It answered inside the call and a newer feed took its place: close this one now that its off exists.
    if (this.feeds.get(ws) !== feed) feed.off()
  }

  /** One page of a workspace's events: each routine fires once for what it hears past its own cursor, then every cursor moves to `next`. */
  private took(ws: string, gen: number, page: { events: LifeosEvent[]; next: number } | null): void {
    const feed = this.feeds.get(ws)
    if (this.stopped || !page || !feed || feed.gen !== gen || page.next <= feed.after) return
    const sector = feed.sector
    for (const r of this.store.list(ws)) {
      if (!r.enabled || r.proposed || r.ended || !heardKinds(r.trigger)) continue
      const mine = page.events.filter((e) => e.sector === sector && e.at > (r.cursor.after ?? r.createdAt) && heard(r, e))
      this.store.setCursor(r.id, { ...r.cursor, after: Math.max(page.next, r.cursor.after ?? 0) })
      if (mine.length) this.track(this.fire(r, eventsCause(mine), 0, { detail: `What it heard: ${mine.map((e) => `${e.kind} ${e.ref.table}/${e.ref.id}`).join(', ')}` }))
    }
    feed.off()
    this.feeds.delete(ws)
    this.follow(ws, sector, page.next)
  }

  // ── rows for a screen ─────────────────────────────────────────────────

  private jobName(id: string): { jobName?: string } {
    const name = this.deps.job?.(id)?.name
    return name ? { jobName: name } : {}
  }

  row(r: Routine): RoutineRow {
    const sources = this.deps.sources?.() ?? []
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      projectId: r.projectId,
      kind: r.kind,
      name: r.name,
      prompt: r.prompt,
      playId: r.playId,
      ...(r.job ? { job: r.job, ...this.jobName(r.job) } : {}),
      model: r.model,
      reasoning: r.reasoning,
      trigger: r.trigger,
      words: triggerWords(r.trigger, sources),
      ends: r.untilAt !== null ? { kind: 'day', at: r.untilAt } : r.once ? { kind: 'once' } : { kind: 'never' },
      enabled: r.enabled && !r.ended,
      proposed: r.proposed,
      resumeSessionId: r.resumeSessionId,
      madeIn: r.madeIn,
      nextAt: r.trigger.on === 'schedule' && r.enabled && !r.ended && !r.proposed ? r.nextAt : null,
      lastAt: r.lastAt,
      lastState: r.lastState,
      lastWords: r.lastWords,
      checkedAt: r.cursor.readAt ?? null,
      waiting: r.enabled && !r.proposed && !r.ended ? this.waiting(r) : null,
      running: this.store.inFlight(r.id) !== null,
      ended: r.ended,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      host: this.ctx.host
    }
  }
}
