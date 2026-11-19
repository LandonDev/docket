import type { WorkModule } from '../modules'

/**
 * The browser pillar's server module (docs/agents/work-browser.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`.
 */
export const browser: WorkModule = {
  id: 'browser',
  ensure() {}
}
