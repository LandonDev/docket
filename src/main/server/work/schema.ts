import type { DatabaseSync } from 'node:sqlite'
import type { PillarId } from '@shared/work'
import { WORK_MODULES, type WorkModule } from './modules'

/**
 * Every Work table is made by the module that owns it, in its own
 * `ensure(db)`, the way `notes` and `addons` make theirs: a pillar adds a
 * table or a later column in its own folder and never touches db.ts.
 * `startWork` (work/ctx.ts) calls this once at boot, Work on or off, since
 * an ensure only adds. A table is named `work_<pillar>_*` (or the name
 * docs/agents/work.md lists for it); the core columns on `workspaces`,
 * `sessions`, `projects` and `addons` are db.ts's and addonStore.ts's.
 *
 * A module whose ensure throws never stops the host: the code app boots as
 * it always did, the fault is logged, and it comes back as that pillar's
 * word, which `startWork` answers for the pillar from then on instead of
 * running any of it on tables that may be half made.
 */
export function ensureWorkTables(db: DatabaseSync, modules: WorkModule[] = WORK_MODULES): Map<PillarId, string> {
  const failed = new Map<PillarId, string>()
  for (const module of modules) {
    try {
      module.ensure(db)
    } catch (err) {
      const why = `work: ${module.id} could not make its tables: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[work] ${why}`)
      failed.set(module.id, why)
    }
  }
  return failed
}
