import type { SearchHit, SearchKind, SearchReach } from '@shared/work/search'
import type { Caller, WorkCtx } from '../modules'

/**
 * How a pillar makes its things findable (docs/agents/work-search.md "How a
 * pillar registers"): it lists `search: [source]` on its module, beside
 * `mentions` and `health`. Types only: importing this file loads nothing of
 * search.
 *
 * The frame (search/run.ts) holds every source to the rules, so a source
 * cannot break them: it waits `SEARCH_WAIT_MS` and no longer, drops a hit
 * outside `ask.reach`, caps the group and says `more` itself.
 */
export type SearchTier = 'instant' | 'network'

export interface SearchSource {
  kind: SearchKind
  /** the group's heading, for a kind `SEARCH_ORDER` does not know */
  label: string
  /** instant: answers from this host's memory or SQLite, never the network. A function: decided at each ask (what the mirror holds is instant, the same read from LifeOS is not). */
  tier: SearchTier | ((ctx: WorkCtx) => SearchTier)
  /** read from LifeOS: not asked while LifeOS is not connected, and asked of one host only */
  lifeos?: boolean
  /** asked only when its kind is asked alone ("All files for …"), never as he types among the others */
  when?: 'alone'
  /** its order is a list's, not a ranking: a thing he opened before goes first */
  unranked?: boolean
  /** Best first, `ask.limit + 1` hits to say there are more, each inside `ask.reach`. */
  search(ask: SearchAsk, ctx: WorkCtx): Promise<SearchHit[]>
}

export interface SearchAsk {
  /** trimmed, never empty */
  text: string
  reach: SearchReach
  limit: number
  by: Caller
  signal: AbortSignal
}
