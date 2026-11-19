import type { WorkModule } from '../modules'

/**
 * The lifeos pillar's server module (docs/agents/work-lifeos.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const lifeos: WorkModule = {
  id: 'lifeos',
  ensure() {}
}
