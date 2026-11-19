import type { DatabaseSync } from 'node:sqlite'
import { errorText, type PillarId } from '@shared/work/ids'
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
 * **Each ensure runs inside a savepoint the host owns.** All of it lands or
 * none of it does: on a fault the savepoint is rolled back and released, so
 * no half-made table and no open transaction is left for the host's later
 * writes to join. An ensure therefore never runs `BEGIN`, `COMMIT` or
 * `ROLLBACK` of its own (SQLite refuses a `BEGIN` inside one; a `COMMIT`
 * or `ROLLBACK` that ended the host's is caught here and counted a fault).
 * A step that must be atomic on its own uses a nested `SAVEPOINT`.
 *
 * A module whose ensure throws never stops the host: the code app boots as
 * it always did, the fault is logged, and it comes back as that pillar's
 * word, which `startWork` answers for the pillar from then on instead of
 * running any of it.
 */
const SAVEPOINT = 'work_ensure'

export function ensureWorkTables(db: DatabaseSync, modules: WorkModule[] = WORK_MODULES): Map<PillarId, string> {
  const failed = new Map<PillarId, string>()
  for (const module of modules) {
    const fault = ensureOne(db, module)
    if (!fault) continue
    const why = `work: ${module.id} could not make its tables: ${fault}`
    console.error(`[work] ${why}`)
    failed.set(module.id, why)
  }
  return failed
}

/** One module's ensure inside the host's savepoint; null when it landed, else what went wrong, with the database as it was before. */
function ensureOne(db: DatabaseSync, module: WorkModule): string | null {
  // Whether the host itself was inside a transaction: only one this ensure opened is ever closed here.
  const outer = db.isTransaction
  let fault: string | null = null
  try {
    db.exec(`SAVEPOINT ${SAVEPOINT}`)
  } catch (err) {
    return errorText(err)
  }
  try {
    module.ensure(db)
  } catch (err) {
    fault = errorText(err)
  }
  if (fault === null) {
    try {
      db.exec(`RELEASE ${SAVEPOINT}`)
    } catch {
      // The savepoint is gone: the ensure ended the host's transaction itself, so what it wrote was not the host's to keep or undo.
      fault = 'its ensure ended the transaction the host ran it in (an ensure never runs COMMIT or ROLLBACK)'
    }
  } else {
    try {
      db.exec(`ROLLBACK TO ${SAVEPOINT}`)
      db.exec(`RELEASE ${SAVEPOINT}`)
    } catch {
      // gone already; the check below leaves nothing open
    }
  }
  // Whatever the ensure did, the host is not left inside a transaction it did not open.
  if (!outer && db.isTransaction) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // nothing open after all
    }
    fault ??= 'its ensure left a transaction open'
  }
  return fault
}
