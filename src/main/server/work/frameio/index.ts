import type { WorkModule } from '../modules'

/**
 * The frameio pillar's server module (docs/agents/work-frameio.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const frameio: WorkModule = {
  id: 'frameio',
  ensure() {}
}
