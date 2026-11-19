import type { WorkModule } from '../modules'

/**
 * The sheets pillar's server module (docs/agents/work-sheets.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const sheets: WorkModule = {
  id: 'sheets',
  ensure() {}
}
