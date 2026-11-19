import type { WorkModule } from '../modules'
import { ensureResults } from './results'

/**
 * The outbox pillar's server module (docs/agents/work-outbox.md). A stub:
 * `PILLAR_MILESTONE` in src/shared/work/ids.ts names the milestone that
 * fills it. Its tables are made here, in `ensure`; `work_results` is made
 * by results.ts, whose `ensureResults` this must keep calling.
 */
export const outbox: WorkModule = {
  id: 'outbox',
  ensure(db) {
    ensureResults(db)
  }
}
