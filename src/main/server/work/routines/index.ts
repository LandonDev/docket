import type { WorkModule } from '../modules'

/**
 * The routines pillar's server module (docs/agents/work-routines.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const routines: WorkModule = {
  id: 'routines',
  ensure() {}
}
