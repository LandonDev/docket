import type { WorkModule } from '../modules'

/**
 * The docs pillar's server module (docs/agents/work-docs.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const docs: WorkModule = {
  id: 'docs',
  ensure() {}
}
