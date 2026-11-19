import type { WorkModule } from '../modules'

/**
 * The dashboards pillar's server module (docs/agents/work-dashboards.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const dashboards: WorkModule = {
  id: 'dashboards',
  ensure() {}
}
