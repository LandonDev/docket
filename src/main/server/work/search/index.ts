import { handled, NOT_HANDLED } from '@shared/work'
import { inReach, type SearchAnswer } from '@shared/work/search'
import { WORK_MODULES, type WorkCtx, type WorkModule } from '../modules'
import { windowReach } from './reach'
import { startMirror } from './mirror'
import { dropWorkspace, ensureRecents, openedAt, recentGroup, recordOpened } from './recents'
import { namesOnlyReachable, runSearch } from './run'
import type { SearchSource } from './source'
import { fileSources } from './sources/files'
import { lifeosFileSources, lifeosSources } from './sources/lifeos'
import { threadSources } from './sources/threads'
import { standInOf, withStandIn } from './standIn'
import { searchPreamble, searchTools } from './tools'

/**
 * The search pillar's server module (docs/agents/work-search.md): one field
 * over everything in Work. It keeps one table (what he opened from search)
 * and answers `work.search.query` and `work.search.opened`; the things
 * themselves come from the sources every pillar lists on its module, asked
 * through the frame (search/run.ts). It registers no act kind: search
 * sends, posts, shares, books and submits nothing.
 */

/** This pillar's own sources. One stands down for a kind a module lists a `search` source of. Messages and Money list their own (messages/search.ts, money/borders.ts). */
// Files' own names first, then LifeOS's documents where they are files: a document both find stands where Files put it.
export const OWN_SOURCES: SearchSource[] = [...lifeosSources, ...fileSources(), ...lifeosFileSources, ...threadSources]

/** A proof's made-up LifeOS, on an isolated instance alone (search/standIn.ts); null everywhere else. */
const STAND_IN = standInOf()
const reading = <C extends WorkCtx>(ctx: C): C => (STAND_IN ? withStandIn(ctx, STAND_IN) : ctx)

export const search: WorkModule = {
  id: 'search',
  ensure: ensureRecents,
  async handle(req, own, by, signal) {
    const ctx = reading(own)
    switch (req.method) {
      case 'work.search.query': {
        const { text, workspaceId, tier, sources, kind, own } = req.params
        const reach = windowReach(ctx, workspaceId)
        // Nothing typed: what he opened last, and nothing else; held to one kind, the last of that kind, picked before the eight are counted.
        if (!text.trim()) {
          const recent = recentGroup(ctx.db, reach, (hit) => (kind === undefined || hit.kind === kind) && (by.kind !== 'remote' || namesOnlyReachable(ctx, by, hit)))
          return handled({ groups: recent ? [recent] : [], pending: [], quiet: [] } satisfies SearchAnswer)
        }
        return handled(await runSearch(ctx, { modules: WORK_MODULES, own: OWN_SOURCES, reach, text, by, tier, sources, kind, skipLifeos: own, signal, opened: openedAt(ctx.db) }))
      }
      case 'work.search.opened': {
        const { hit } = req.params
        // His own mark on his own host: only for a thing of a job this host has (or of Work Chats).
        if (inReach(windowReach(ctx), hit.workspaceId)) recordOpened(ctx.db, hit)
        return handled({})
      }
    }
    return NOT_HANDLED
  },
  // People, open tasks and events kept in memory while Work is on, so they are found with no round trip.
  start: (ctx) => startMirror(reading(ctx)),
  tools: () => searchTools(() => OWN_SOURCES).map((tool) => ({ ...tool, run: (args, ctx) => tool.run(args, reading(ctx)) })),
  preamble: searchPreamble,
  workspaceRemoved(workspaceId, ctx) {
    dropWorkspace(ctx.db, workspaceId)
  }
}
