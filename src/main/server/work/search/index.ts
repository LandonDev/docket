import { handled, NOT_HANDLED } from '@shared/work'
import { inReach, type SearchAnswer } from '@shared/work/search'
import { WORK_MODULES, type WorkModule } from '../modules'
import { windowReach } from './reach'
import { dropWorkspace, ensureRecents, openedAt, recentGroup, recordOpened } from './recents'
import { namesOnlyReachable, runSearch } from './run'
import type { SearchSource } from './source'

/**
 * The search pillar's server module (docs/agents/work-search.md): one field
 * over everything in Work. It keeps one table (what he opened from search)
 * and answers `work.search.query` and `work.search.opened`; the things
 * themselves come from the sources every pillar lists on its module, asked
 * through the frame (search/run.ts). It registers no act kind: search
 * sends, posts, shares, books and submits nothing.
 */

/** This pillar's own sources. One stands down for a kind a module lists a `search` source of. */
export const OWN_SOURCES: SearchSource[] = []

export const search: WorkModule = {
  id: 'search',
  ensure: ensureRecents,
  async handle(req, ctx, by, signal) {
    switch (req.method) {
      case 'work.search.query': {
        const { text, workspaceId, tier, sources, kind, own } = req.params
        const reach = windowReach(ctx, workspaceId)
        // Nothing typed: what he opened last, and nothing else.
        if (!text.trim()) {
          const recent = recentGroup(ctx.db, reach, (hit) => by.kind !== 'remote' || namesOnlyReachable(ctx, by, hit))
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
  workspaceRemoved(workspaceId, ctx) {
    dropWorkspace(ctx.db, workspaceId)
  }
}
