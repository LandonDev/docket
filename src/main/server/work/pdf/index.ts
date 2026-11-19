import type { WorkModule } from '../modules'

/**
 * The pdf pillar's server module (docs/agents/work-pdf.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const pdf: WorkModule = {
  id: 'pdf',
  ensure() {}
}
