import type { WorkModule } from '../modules'

/**
 * The guests pillar's server module (docs/agents/work-guests.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const guests: WorkModule = {
  id: 'guests',
  ensure() {}
}
