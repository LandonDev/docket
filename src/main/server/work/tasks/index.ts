import type { WorkModule } from '../modules'

/**
 * The tasks pillar's server module (docs/agents/work-tasks.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const tasks: WorkModule = {
  id: 'tasks',
  ensure() {}
}
