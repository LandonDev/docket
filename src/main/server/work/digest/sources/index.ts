import { errorText, type PillarId } from '@shared/work/ids'
import { pillarOfMethod } from '@shared/work/wire'
import type { Tell } from '@shared/work/tell'
import type { Caller, WorkCtx, WorkModule } from '../../modules'

/**
 * Sources: the news of a pillar that hands a read, not a tell
 * (docs/agents/work-digest.md "Sources"). Each is one small file. A source
 * reads another pillar only through that module's own `handle`, as this
 * host's caller, never its files or tables, and is skipped while that
 * pillar is not loaded. One that throws stops nothing.
 *
 * A source runs on its own beat (`every` ms, and once at start), or only
 * when a day's digest is about to be made (`every: 0`).
 */

export interface SourceEnv {
  ctx: WorkCtx
  modules: readonly WorkModule[]
  /** another pillar's own method, asked as this host's caller; throws when the pillar is not loaded or does not take it */
  call<T>(method: string, params: unknown): Promise<T>
  /** this host's Work workspaces that are linked to a sector */
  workspaces(): { id: string; name: string; sector: string }[]
  /** the day of the digest being made, or of the last one made: for a row told once a day */
  day: string
  /** the zone the digest runs in (the last desktop's): every time a title says is written in it, never in the host's own */
  zone: string
  /** when this host last made a digest; 0: never */
  since: number
  /** what a source keeps between reads on this host (a cutoff per job), in the digest's own settings */
  kept?: Kept
  /**
   * The zone to write `key`'s times in: the one it was first told in. A row's identity is the thing told, never the
   * words' clock, so a desktop in another zone does not rewrite a told thing into news. Absent: `zone`.
   */
  zoneOf?(key: string): string
}

export interface Kept {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** The zones remembered for a source's keys: the newest this many. */
const ZONES_MAX = 500

export interface SourceRead {
  tells: Tell[]
  /** the keys under `prefix` that are still true; absent: the tells' own keys */
  keep?: string[]
  /**
   * Run after its tells were handed to the ledger, while Work is on: `accepted` answers which keys the ledger kept,
   * so a cutoff moves past what was kept and never past a tell that did not reach it.
   */
  done?(accepted: (key: string) => boolean): void
}

export interface Source {
  id: string
  /** the pillar it reads; null: the frame's own */
  pillar: PillarId | null
  /** ms between reads; 0: only before a day's digest is made */
  every: number
  /** its keys' prefix: after a read, a row under it that is no longer named is done. Absent: its rows stay as a record. */
  prefix?: string
  read(env: SourceEnv, now: number): Promise<SourceRead | Tell[]> | SourceRead | Tell[]
}

/** A read at the digest's time may take this long before the day is made without it. */
export const SOURCE_WAIT_MS = 10_000

const LOCAL: Caller = { kind: 'local', caps: ['read'] }

export interface SourcesDeps {
  ctx: WorkCtx
  modules(): readonly WorkModule[]
  sources: readonly Source[]
  day(now: number): string
  zone(): string
  since(): number
  kept?: Kept
  /** Tells one, answering whether the ledger kept it (ctx.ts); absent: `ctx.tell`, taken as kept. */
  tell?(t: Tell): boolean
}

export class Sources {
  private readonly last = new Map<string, number>()
  private readonly running = new Set<string>()
  /** Sources whose last read failed: a fault is said once, not at every beat, until a read succeeds. */
  private readonly failing = new Set<string>()

  constructor(private readonly deps: SourcesDeps) {}

  /** The zone each key of a source was first told in (`zoneOf`), kept as `zones:<source>`. */
  private zones(source: Source): Record<string, string> {
    try {
      const raw = JSON.parse(this.deps.kept?.get(`zones:${source.id}`) ?? '{}') as unknown
      return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {}
    } catch {
      return {}
    }
  }

  private env(now: number): SourceEnv {
    const { ctx } = this.deps
    const modules = this.deps.modules()
    return {
      ctx,
      modules,
      async call<T>(method: string, params: unknown): Promise<T> {
        const pillar = pillarOfMethod(method)
        const module = modules.find((m) => m.id === pillar)
        if (!module?.handle) throw new Error(`${pillar ?? method} is not running on this host`)
        const answer = await module.handle({ id: 'digest', method, params } as never, ctx, LOCAL)
        if (!answer.handled) throw new Error(`${method} was not answered`)
        return answer.result as T
      },
      workspaces: () => ctx.db.prepare("SELECT id, name, sector FROM workspaces WHERE kind = 'work' AND sector IS NOT NULL ORDER BY created_at").all() as unknown as { id: string; name: string; sector: string }[],
      day: this.deps.day(now),
      zone: this.deps.zone(),
      since: this.deps.since(),
      ...(this.deps.kept ? { kept: this.deps.kept } : {})
    }
  }

  /** One source read and told. Never throws; never runs twice at once. */
  async run(source: Source, now: number): Promise<void> {
    const { ctx } = this.deps
    if (this.running.has(source.id)) return
    if (source.pillar && !this.deps.modules().some((m) => m.id === source.pillar)) return
    this.running.add(source.id)
    try {
      const env = this.env(now)
      const pinned = this.zones(source)
      const read = await source.read({ ...env, zoneOf: (key) => pinned[key] ?? env.zone }, now)
      const { tells, keep, done } = Array.isArray(read) ? { tells: read, keep: undefined, done: undefined } : read
      const accepted = new Set<string>()
      for (const tell of tells) {
        const kept = this.deps.tell ? this.deps.tell(tell) : (ctx.tell(tell), true)
        if (kept && tell.key) accepted.add(tell.key)
      }
      if (source.prefix) ctx.tell.only(source.prefix, keep ?? tells.flatMap((t) => (t.key ? [t.key] : [])))
      if (this.deps.kept && ctx.enabled()) {
        // Each key told keeps the zone it was first told in; the newest ZONES_MAX are remembered.
        const next = { ...pinned }
        for (const t of tells) if (t.key && !(t.key in next)) next[t.key] = env.zone
        const entries = Object.entries(next)
        this.deps.kept.set(`zones:${source.id}`, JSON.stringify(Object.fromEntries(entries.slice(-ZONES_MAX))))
      }
      if (done && ctx.enabled()) done((key) => accepted.has(key))
      this.failing.delete(source.id)
    } catch (err) {
      if (!this.failing.has(source.id)) ctx.log(`digest: the ${source.id} source was not read: ${errorText(err)}`)
      this.failing.add(source.id)
    } finally {
      this.running.delete(source.id)
    }
  }

  /** Each look: the sources whose beat has come, the first look among them. */
  beat(now: number): void {
    for (const source of this.deps.sources) {
      if (source.every <= 0) continue
      const last = this.last.get(source.id)
      if (last !== undefined && now - last < source.every) continue
      this.last.set(source.id, now)
      void this.run(source, now)
    }
  }

  /** Before a day is made: every source that tells only then, each given `SOURCE_WAIT_MS`. */
  async beforeDay(now: number): Promise<void> {
    const within = (work: Promise<void>): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, SOURCE_WAIT_MS)
        timer.unref?.()
        void work.finally(() => (clearTimeout(timer), resolve()))
      })
    await Promise.all(this.deps.sources.filter((s) => s.every <= 0).map((s) => within(this.run(s, now))))
  }
}
