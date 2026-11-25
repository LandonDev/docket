import type { TeamsLibrary } from '@shared/contract-work-office'
import { canvasSourcePath, type CanvasSource } from '@shared/work'
import type { WorkCtx } from '../modules'
import { within } from '../files/policy'
import { librariesHere, vmLibrariesHere } from '../files/places/libraries'
import { isGuestPath, vmLibraryOf } from '../office/vm/files'
import type { RenderPlace } from '../office/render'

/**
 * Check in Word on a Teams Word file (docs/agents/work-docs.md "Check in Word"; the owner's ruling, decision 17 of
 * the files pass): Word draws it only on the computer that holds the file, the Windows VM for a library in the VM,
 * and only in a tenant that computer is signed in to. The box and its VM are two computers here: a file the box
 * holds is never drawn by the VM's Word. The runner keeps a shared job on this host (formats/jobs.ts), so a holder
 * that is another host is refused here, never carried there.
 */

/** The computer that holds a Word file: a host, or the Windows VM that host keeps. */
export interface WordHolder {
  host: string
  vm: boolean
  path: string
}

/** Who draws Office files on this host (office/render.ts `renderDeps`): his Mac, a Windows PC, or the box's VM. */
export const renderPlaceHere = (platform: NodeJS.Platform = process.platform): RenderPlace =>
  platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'vm'

/**
 * The Word file a source stands for, and the computer that holds it: a `.tcdoc` kept for a Word file of another
 * computer reads its record (`work_files_word`, files/word.ts); a `.docx` on this host is its own. Null for anything
 * else: a Google or web file, another host's path, a document of his own.
 */
export function wordHolderOf(ctx: Pick<WorkCtx, 'db' | 'host'>, source: CanvasSource): WordHolder | null {
  const path = canvasSourcePath(source)
  if (path === null || (source as { host?: string }).host !== ctx.host) return null
  const lower = path.toLowerCase()
  if (lower.endsWith('.tcdoc')) {
    try {
      const row = ctx.db.prepare(`SELECT host, path, vm FROM work_files_word WHERE doc = ?`).get(path) as { host: string; path: string; vm: number } | undefined
      return row ? { host: row.host, vm: !!row.vm, path: row.path } : null
    } catch {
      // A database with no Word records (a test's) holds no Word file.
      return null
    }
  }
  if (!lower.endsWith('.docx')) return null
  return { host: ctx.host, vm: isGuestPath(path) && process.platform !== 'win32', path }
}

/** Why Word may not draw a held file from this host, in a line for the log; null when it may. */
export function wordCheckRefusal(holder: WordHolder | null, here: { host: string; place: RenderPlace }, libraries: readonly TeamsLibrary[]): string | null {
  if (!holder) return 'not a Word file of a library'
  if (holder.host !== here.host) return 'held by another host'
  // The VM's Word draws only the VM's files; his Mac's or PC's Word only that computer's own.
  if (holder.vm !== (here.place === 'vm')) return holder.vm ? 'held in a Windows VM this host does not draw with' : 'held by a computer whose Word is not this host\'s'
  const library = holder.vm ? vmLibraryOf(libraries, holder.path)?.library : libraries.find((l) => !l.vm && within(holder.path, l.path))
  if (!library) return 'in no library the holder lists'
  const tenant = library.tenant?.toLowerCase()
  if (!tenant) return 'in a library of no known tenant'
  // Signed in there: the holder syncs his own OneDrive of that very tenant.
  const signedIn = libraries.some((l) => !!l.vm === holder.vm && l.kind === 'mine' && l.tenant?.toLowerCase() === tenant)
  return signedIn ? null : `the holder is not signed in to ${library.tenant}`
}

/** The check made at dispatch: the holder and its tenant read now, from the libraries as this host last read them. */
export function wordCheckHere(ctx: Pick<WorkCtx, 'db' | 'host'>, sources: readonly CanvasSource[], place: RenderPlace = renderPlaceHere()): string | null {
  const holder = sources.map((s) => wordHolderOf(ctx, s)).find((h) => h !== null) ?? null
  const libraries = holder?.vm ? vmLibrariesHere(ctx) : holder ? librariesHere(ctx) : []
  return wordCheckRefusal(holder, { host: ctx.host, place }, libraries)
}
