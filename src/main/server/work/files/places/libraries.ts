import type { DatabaseSync } from 'node:sqlite'
import type { TeamsLibrary } from '@shared/contract-work-office'
import type { WorkCtx } from '../../modules'
import { librariesOf } from '../../office/files/library'
import { vmLibraries } from '../../office/vm/files'

/**
 * This host's libraries as the Files place reads them: the office pillar's own finding (`librariesOf`, which
 * scans OneDrive's folders and resolves every library's real path), kept for one burst of calls. A page of a
 * listing, the fence of each row and a `stat` of the rows on screen all ask within a moment of each other;
 * each would otherwise walk the cloud folder again.
 */

/** How long one finding answers: long enough for a burst, short enough that a library he just synced or turned off shows at the next press. */
export const LIBRARIES_FRESH_MS = 2_000

const kept = new WeakMap<DatabaseSync, { at: number; host: string; libraries: TeamsLibrary[] }>()

/** The libraries on this host's own disk. */
export function librariesHere(ctx: Pick<WorkCtx, 'db' | 'host'>, now = Date.now()): TeamsLibrary[] {
  const was = kept.get(ctx.db)
  if (was && was.host === ctx.host && now - was.at < LIBRARIES_FRESH_MS) return was.libraries
  const libraries = librariesOf(ctx.db, ctx.host)
  kept.set(ctx.db, { at: now, host: ctx.host, libraries })
  return libraries
}

/** The libraries in the Windows VM this host keeps, as last read: a row of the database, never a wake. */
export const vmLibrariesHere = (ctx: Pick<WorkCtx, 'db' | 'host'>): TeamsLibrary[] => vmLibraries(ctx.db, ctx.host)

/** His edit to the list landed, or a test moved the cloud folder: the next ask finds again. */
export const forgetLibraries = (db: DatabaseSync): void => void kept.delete(db)
