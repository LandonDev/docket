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
}

export interface SourceRead {
  tells: Tell[]
  /** the keys under `prefix` that are still true; absent: the tells' own keys */
  keep?: string[]
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
}

export class Sources {
  private readonly last = new Map<string, number>()
  private readonly running = new Set<string>()
  /** Sources whose last read failed: a fault is said once, not at every beat, until a read succeeds. */
  private readonly failing = new Set<string>()

  constructor(private readonly deps: SourcesDeps) {}

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
      since: this.deps.since()
    }
  }

  /** One source read and told. Never throws; never runs twice at once. */
  async run(source: Source, now: number): Promise<void> {
    const { ctx } = this.deps
    if (this.running.has(source.id)) return
    if (source.pillar && !this.deps.modules().some((m) => m.id === source.pillar)) return
    this.running.add(source.id)
    try {
      const read = await source.read(this.env(now), now)
      const { tells, keep } = Array.isArray(read) ? { tells: read, keep: undefined } : read
      for (const tell of tells) ctx.tell(tell)
      if (source.prefix) ctx.tell.only(source.prefix, keep ?? tells.flatMap((t) => (t.key ? [t.key] : [])))
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
