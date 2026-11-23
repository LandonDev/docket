import type { MentionHit, MentionReach } from '@shared/work'
import { chipKey, searchLabel, type SearchHit, type SearchReach } from '@shared/work/search'
import type { MentionSource, WorkModule } from '../modules'
import type { SearchSource } from './source'

/**
 * A pillar with `mentions` and no `search` is found through them
 * (docs/agents/work-search.md "The mention bridge"). The composer's `@`
 * asks a mention source within one thread's reach, and a hit carries no
 * job; here each source is asked once a job in reach, so every hit is
 * stamped with the job it was found in, and it opens as its chip does from
 * a sent message.
 */

/** The job a thread's own things belong to: Work Chats for a Work Chat, else its one workspace. */
const homeOf = (reach: SearchReach): string | null | undefined => (reach.sessionId === null ? undefined : reach.chats ? null : reach.workspaces.length === 1 ? reach.workspaces[0].id : undefined)

/** One mention reach a place: a job's sector and things, or Work Chats' (no sector: a Work Chat's LifeOS rows belong to the jobs). */
function places(reach: SearchReach): MentionReach[] {
  const home = homeOf(reach)
  const at = (workspaceId: string | null, sectors: string[]): MentionReach => ({ work: true, workspaceId, sectors, sessionId: home === workspaceId ? reach.sessionId : null })
  return [...reach.workspaces.map((w) => at(w.id, w.sector ? [w.sector] : [])), ...(reach.chats ? [at(null, [])] : [])]
}

const hitOf = (kind: string, hit: MentionHit, workspaceId: string | null): SearchHit => ({
  key: chipKey(hit.chip),
  kind,
  title: hit.chip.label,
  ...(hit.detail ? { detail: hit.detail } : {}),
  ...(hit.at !== undefined ? { at: hit.at } : {}),
  workspaceId,
  open: { to: 'chip', chip: hit.chip },
  chip: hit.chip
})

/** A mention source as a search source. */
export function bridged(mention: MentionSource): SearchSource {
  return {
    kind: mention.kind,
    label: searchLabel(mention.kind),
    tier: mention.lifeos ? 'network' : 'instant',
    ...(mention.lifeos ? { lifeos: true } : {}),
    async search(ask, ctx) {
      const each = await Promise.all(
        places(ask.reach).map(async (place) => (await mention.search(ask.text, place, ctx)).map((hit) => hitOf(mention.kind, hit, place.workspaceId)))
      )
      // A turn a job, so one job's rows never fill the group before another's first.
      const out: SearchHit[] = []
      for (let i = 0; out.length <= ask.limit && each.some((hits) => i < hits.length); i++) for (const hits of each) if (i < hits.length) out.push(hits[i])
      return out.slice(0, ask.limit + 1)
    }
  }
}

/** Every module's mention sources, by pillar, for the kinds no search source covers. */
export function mentionBridge(modules: readonly WorkModule[], taken: ReadonlySet<string>): { pillar: string; source: SearchSource }[] {
  const seen = new Set(taken)
  const out: { pillar: string; source: SearchSource }[] = []
  for (const module of modules) {
    for (const mention of module.mentions ?? []) {
      if (seen.has(mention.kind)) continue
      seen.add(mention.kind)
      out.push({ pillar: module.id, source: bridged(mention) })
    }
  }
  return out
}
