import type { WorkModule } from '../modules'

/**
 * The history pillar's server module (docs/agents/work-history.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const history: WorkModule = {
  id: 'history',
  ensure() {}
}
