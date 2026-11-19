import type { WorkModule } from '../modules'

/**
 * The agenda pillar's server module (docs/agents/work-agenda.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const agenda: WorkModule = {
  id: 'agenda',
  ensure() {}
}
