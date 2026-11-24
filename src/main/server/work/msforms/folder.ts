import type { CanvasSource } from '@shared/work'
import { refKey } from '@shared/work/files'
import { registerFolderExtras, type FolderExtra } from '../files/hooks'
import { workspaceHere } from '../files/policy'
import type { WorkCtx } from '../modules'
import type { TeamsLibrary } from '@shared/contract-work-office'
import { MsformsStore } from './store'

/**
 * A library folder in Files lists each Microsoft form made in it as a row of its own (docs/agents/work-files.md
 * "Rows a pillar adds"): kind `form`, opened by its `msform` source, just before its answers workbook, whose row reads
 * "Answers to <form>" and opens the form from its menu. Only the listing workspace's forms of its own sector, as the
 * one reach check keeps them.
 */

const parts = (path: string): string[] => path.split(/[\\/]+/).filter((p) => p && p !== '.')

/** `path`'s place inside the library, `/`-joined and in one case; null when it is not inside it. */
function inside(library: TeamsLibrary, path: string): string | null {
  const root = parts(library.path).map((p) => p.toLowerCase())
  const at = parts(path)
  if (at.length < root.length || root.some((seg, i) => seg !== at[i]!.toLowerCase())) return null
  return at.slice(root.length).join('/').toLowerCase()
}

export function formsInFolder(ctx: Pick<WorkCtx, 'db' | 'host'>, folder: { workspaceId: string; library: TeamsLibrary; path: string }): FolderExtra[] {
  const here = inside(folder.library, folder.path)
  if (here === null) return []
  const workspace = workspaceHere(ctx.db, folder.workspaceId)
  if (!workspace) return []
  let rows
  try {
    rows = new MsformsStore(ctx.db).list(folder.workspaceId)
  } catch {
    // (no forms table on this host yet)
    return []
  }
  return rows
    .filter((r) => r.folder.libraryId === folder.library.id && parts(r.folder.path).join('/').toLowerCase() === here && (r.sector ?? null) === (workspace.sector ?? null))
    .map((r) => {
      const ref: CanvasSource = { at: 'msform', host: ctx.host, workspaceId: r.workspaceId, formId: r.formId, tenant: r.tenant }
      const book = r.workbook && r.workbook.libraryId === folder.library.id ? parts(r.workbook.path) : null
      // Its workbook goes beside it only when Forms made it in this same folder.
      const before = book && book.slice(0, -1).join('/').toLowerCase() === here ? book.at(-1)! : null
      return {
        entry: { key: refKey(ref), ref, folder: null, name: r.title, kind: 'form' as const, changed: r.updatedAt, shared: true },
        before,
        ...(before ? { answersTo: { title: r.title, ref } } : {})
      }
    })
}

registerFolderExtras(formsInFolder)
