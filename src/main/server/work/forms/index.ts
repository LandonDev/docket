import type { WorkModule } from '../modules'

/**
 * The forms pillar's server module (docs/agents/work-forms.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const forms: WorkModule = {
  id: 'forms',
  ensure() {}
}
