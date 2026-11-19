import type { WorkModule } from '../modules'

/**
 * The office pillar's server module (docs/agents/work-office.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const office: WorkModule = {
  id: 'office',
  ensure() {}
}
