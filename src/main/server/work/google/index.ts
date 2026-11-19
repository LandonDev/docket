import type { WorkModule } from '../modules'

/**
 * The google pillar's server module (docs/agents/work-google.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const google: WorkModule = {
  id: 'google',
  ensure() {}
}
