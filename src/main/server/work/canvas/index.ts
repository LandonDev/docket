import type { WorkModule } from '../modules'

/**
 * The canvas pillar's server module (docs/agents/work-canvas.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const canvas: WorkModule = {
  id: 'canvas',
  ensure() {}
}
