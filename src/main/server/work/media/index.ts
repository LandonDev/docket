import type { WorkModule } from '../modules'

/**
 * The media pillar's server module (docs/agents/work-media.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const media: WorkModule = {
  id: 'media',
  ensure() {}
}
