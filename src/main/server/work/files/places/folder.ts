import { basename, join, relative, sep } from 'node:path'
import type { FileCrumb } from '@shared/contract-work-files'
import { PLACE, refKey, type FileEntry, type FilePlace } from '@shared/work/files'
import type { WorkspaceRow } from '../policy'
import { entryOfRow, type DiskRow } from './disk'

/**
 * The workspace's own folder as a place (docs/agents/work-files.md "The model"): the folder on the workspace's
 * host, named for the workspace, with real folders in it. Only he and his threads see it, so every verb runs
 * at once; the verbs themselves land with their milestone, and `can` says which this build carries out.
 */

/** The verbs the folder's adapter carries out today. */
export const FOLDER_CAN: FilePlace['can'] = []

export function folderPlace(host: string, workspace: WorkspaceRow): FilePlace {
  return {
    id: PLACE.folder,
    kind: 'folder',
    name: workspace.name,
    host: '',
    env: host,
    shared: false,
    can: [...FOLDER_CAN],
    state: { state: 'ok' },
    root: { at: 'file', host, path: workspace.path }
  }
}

/** A row of a folder under the workspace's root, as the wire's entry. */
export const folderEntry = (host: string, dir: string, row: DiskRow): FileEntry => {
  const path = join(dir, row.name)
  return entryOfRow(row, host, path, refKey({ at: 'file', host, path }))
}

/** The trail to a folder: the place, then each folder down to it. `root` and `path` are real paths, `path` inside `root`. */
export function folderTrail(host: string, workspace: WorkspaceRow, root: string, path: string): FileCrumb[] {
  const parts = relative(root, path).split(sep).filter(Boolean)
  return [{ name: workspace.name, at: { at: 'place', id: PLACE.folder } }, ...parts.map((name, i) => ({ name, at: { at: 'file' as const, host, path: join(root, ...parts.slice(0, i + 1)) } }))]
}

/** A folder's own name, as its tab says it: the workspace's for its top. */
export const folderName = (workspace: WorkspaceRow, root: string, path: string): string => (path === root ? workspace.name : basename(path))
