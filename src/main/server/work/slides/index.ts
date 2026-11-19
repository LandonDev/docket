import type { WorkModule } from '../modules'

/**
 * The slides pillar's server module (docs/agents/work-slides.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const slides: WorkModule = {
  id: 'slides',
  ensure() {}
}
