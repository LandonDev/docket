import { errorText } from '@shared/work/ids'
import {
  inReach,
  SEARCH_ALL,
  SEARCH_PER_GROUP,
  SEARCH_WAIT_MS,
  searchLabel,
  searchRank,
  searchSnippet,
  type SearchAnswer,
  type SearchGroup,
  type SearchHit,
  type SearchQuiet,
  type SearchReach
} from '@shared/work/search'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { mentionBridge } from './mentions'
import { emptyReach } from './reach'
import type { SearchSource, SearchTier } from './source'

/**
 * The frame every search runs in (docs/agents/work-search.md "The frame").
 * The rules live here, so no source can break them: one provider a kind, a
 * wait no source outlasts, a second check of the fence on every hit, the
 * cap, and one quiet line a cause for what could not be searched.
 */

export interface Listed {
  /** `<pillar>.<kind>`; `<pillar>.<kind>/<tier>` when a pillar lists two of a kind */
  id: string
  pillar: string
  source: SearchSource
}

/**
 * The sources a search asks, one provider a kind: a module's own `search`
 * line first, then this pillar's source of that kind, then the mention
 * bridge. A pillar may list two sources of one kind (titles at once, words
 * over the network); both are asked.
 */
export function listSources(modules: readonly WorkModule[], own: readonly SearchSource[]): Listed[] {
  const out: Listed[] = []
  const taken = new Set<string>()
  const add = (pillar: string, sources: readonly SearchSource[]): void => {
    const fresh = sources.filter((s) => !taken.has(s.kind))
    for (const source of fresh) {
      const twins = fresh.filter((o) => o.kind === source.kind)
      const base = twins.length > 1 ? `${pillar}.${source.kind}/${typeof source.tier === 'string' ? source.tier : 'auto'}` : `${pillar}.${source.kind}`
      const same = out.filter((l) => l.id === base || l.id.startsWith(`${base}#`)).length
      out.push({ id: same ? `${base}#${same + 1}` : base, pillar, source })
    }
    for (const source of fresh) taken.add(source.kind)
  }
  for (const module of modules) if (module.id !== 'search' && module.search?.length) add(module.id, module.search)
  add('search', own)
  for (const { pillar, source } of mentionBridge(modules, taken)) add(pillar, [source])
  return out
}

export interface SearchRun {
  modules: readonly WorkModule[]
  /** this pillar's own sources */
  own: readonly SearchSource[]
  reach: SearchReach
  text: string
  by: Caller
  /** only the instant sources; the network ones are named in `pending` */
  tier?: 'instant'
  /** only these, by id */
  sources?: readonly string[]
  /** one kind alone, `SEARCH_ALL` rows */
  kind?: string
  /** only these kinds (the agents' tool) */
  kinds?: readonly string[]
  /** leave out what is read from LifeOS: another host asks it (the wire's `own`) */
  skipLifeos?: boolean
  limit?: number
  waitMs?: number
  signal?: AbortSignal
  /** when he last opened a thing from search, by key */
  opened?: (key: string) => number | undefined
}

const EMPTY: SearchAnswer = { groups: [], pending: [], quiet: [], searched: 0 }

export async function runSearch(ctx: WorkCtx, o: SearchRun): Promise<SearchAnswer> {
  const text = o.text.trim()
  if (!text || emptyReach(o.reach)) return EMPTY
  let listed = listSources(o.modules, o.own)
    .filter((l) => (o.kind === undefined || l.source.kind === o.kind) && (!o.kinds || o.kinds.includes(l.source.kind)))
    .filter((l) => !(o.skipLifeos && l.source.lifeos))
    .filter((l) => l.source.when !== 'alone' || o.kind !== undefined)
  const quiet: SearchQuiet[] = []
  // LifeOS not connected: none of its sources is asked, and it is said once, in the session's own words.
  if (listed.some((l) => l.source.lifeos) && !safely(() => ctx.lifeos.connected())) {
    listed = listed.filter((l) => !l.source.lifeos)
    quiet.push({ cause: 'lifeos', line: await lifeosWords(ctx) })
  }
  const asked = o.sources ? listed.filter((l) => o.sources!.includes(l.id)) : o.tier === 'instant' ? listed.filter((l) => tierOf(l.source, ctx) === 'instant') : listed
  const pending = o.sources || o.tier !== 'instant' ? [] : listed.filter((l) => tierOf(l.source, ctx) !== 'instant').map((l) => ({ source: l.id, kind: l.source.kind }))
  const limit = o.limit ?? (o.kind !== undefined ? SEARCH_ALL : SEARCH_PER_GROUP)
  const answered = { count: 0 }
  const groups = await Promise.all(asked.map((l) => askOne(ctx, l, { ...o, text }, limit, quiet, answered)))
  return {
    // A stable sort: two sources of one kind stay in the order they were listed.
    groups: groups.filter((g): g is SearchGroup => g !== null).sort((a, b) => searchRank(a.kind) - searchRank(b.kind)),
    pending,
    // One line a cause, and never the same words twice (two sources of one kind that both failed).
    quiet: quiet.filter((q, i) => quiet.findIndex((other) => other.cause === q.cause || other.line === q.line) === i),
    searched: answered.count
  }
}

/** A source's tier now. One whose tier cannot be read is asked over the network. */
export function tierOf(source: SearchSource, ctx: WorkCtx): SearchTier {
  if (typeof source.tier === 'string') return source.tier
  try {
    return source.tier(ctx)
  } catch {
    return 'network'
  }
}

async function askOne(ctx: WorkCtx, listed: Listed, o: SearchRun, limit: number, quiet: SearchQuiet[], answered: { count: number }): Promise<SearchGroup | null> {
  const { id, source } = listed
  const label = searchLabel(source.kind, source.label)
  // The source's own signal: the caller's, and the wait's end, so a source that heeds it stops when nobody listens.
  const own = new AbortController()
  const stop = (): void => own.abort()
  o.signal?.addEventListener('abort', stop, { once: true })
  if (o.signal?.aborted) own.abort()
  let hits: SearchHit[]
  try {
    // The caller giving up ends the wait at once, whether or not the source heeds its signal.
    const gone = new Promise<never>((_, reject) => (own.signal.aborted ? reject(new Error('given up')) : own.signal.addEventListener('abort', () => reject(new Error('given up')), { once: true })))
    hits = (await Promise.race([within(Promise.resolve().then(() => source.search({ text: o.text, reach: o.reach, limit, by: o.by, signal: own.signal }, ctx)), o.waitMs ?? SEARCH_WAIT_MS), gone])) ?? []
  } catch (err) {
    if (o.signal?.aborted) return null
    ctx.log(`search: ${id} did not answer: ${errorText(err)}`)
    // LifeOS went between the check and the ask: its one line, not one a kind.
    quiet.push(err instanceof Error && err.name === 'LifeosUnavailable' ? { cause: 'lifeos', line: err.message } : { cause: `source:${id}`, line: `${label} did not answer.` })
    return null
  } finally {
    own.abort()
    o.signal?.removeEventListener('abort', stop)
  }
  answered.count++
  // The fence, a second time: whatever a source answered, a hit outside the reach is never shown.
  const inside = hits.filter((hit) => hit && typeof hit.key === 'string' && inReach(o.reach, hit.workspaceId ?? null))
  if (inside.length !== hits.length) ctx.log(`search: ${id} answered ${hits.length - inside.length} hit(s) outside the reach; dropped`)
  let kept = inside.filter((hit) => o.by.kind !== 'remote' || namesOnlyReachable(ctx, o.by, hit)).map((hit) => tidy(hit, source.kind))
  if (source.unranked && o.opened) {
    const when = (hit: SearchHit): number => o.opened!(hit.key) ?? 0
    kept = kept.map((hit, i) => ({ hit, i })).sort((a, b) => when(b.hit) - when(a.hit) || a.i - b.i).map((x) => x.hit)
  }
  if (kept.length === 0) return null
  return { source: id, kind: source.kind, label, hits: kept.slice(0, limit), more: kept.length > limit }
}

/** A hit as the wire carries it: its source's kind, its job named, its snippet cut. */
function tidy(hit: SearchHit, kind: string): SearchHit {
  const { snippet, ...rest } = hit
  const cut = searchSnippet(snippet)
  return { ...rest, kind, workspaceId: hit.workspaceId ?? null, ...(cut ? { snippet: cut } : {}) }
}

/** A remote key is shown a hit that names a file only when the key could have named the file itself. */
export function namesOnlyReachable(ctx: Pick<WorkCtx, 'reaches'>, by: Caller, hit: SearchHit): boolean {
  const paths: string[] = []
  if (!sourcePaths([hit.open, hit.chip], paths)) return false
  try {
    return paths.every((path) => ctx.reaches(by, path))
  } catch {
    return false
  }
}

/** The file paths of every `CanvasSource` in a value, as the listener's fence reads them (remote/fence.ts); false when it is deeper than this reads. */
function sourcePaths(value: unknown, out: string[], depth = 0): boolean {
  if (depth > 12) return false
  if (Array.isArray(value)) return value.every((v) => sourcePaths(v, out, depth + 1))
  if (!value || typeof value !== 'object') return true
  const o = value as { at?: unknown; path?: unknown; ref?: { kind?: unknown; path?: unknown } }
  if (o.at === 'file' && typeof o.path === 'string') out.push(o.path)
  if (o.at === 'microsoft' && o.ref && o.ref.kind === 'path' && typeof o.ref.path === 'string') out.push(o.ref.path)
  return Object.values(value).every((v) => sourcePaths(v, out, depth + 1))
}

/** Why LifeOS cannot be asked, in its session's own words. */
async function lifeosWords(ctx: WorkCtx): Promise<string> {
  try {
    // Not connected: the client refuses before anything leaves this host, and its error is the state's words.
    await ctx.lifeos.owner().query('sectors:list', {})
    return 'LifeOS did not answer'
  } catch (err) {
    return errorText(err)
  }
}

function safely(fn: () => boolean): boolean {
  try {
    return fn()
  } catch {
    return false
  }
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}
