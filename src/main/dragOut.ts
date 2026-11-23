import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/**
 * A file dragged out of the Files place to the desktop (docs/agents/work-files.md "Drag out"): the window names
 * the files, the system carries them. Only whole, real files of this machine go: an absolute path each, a regular
 * file (never a folder, a link or a device), a hundred at most. One that is not is the whole drag refused, so a
 * drop never lands half of what was dragged.
 */
export const DRAG_OUT_MOST = 100

export async function dragOutPaths(paths: unknown): Promise<string[] | null> {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > DRAG_OUT_MOST) return null
  const out: string[] = []
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null
    try {
      if (!(await lstat(path)).isFile()) return null
    } catch {
      return null
    }
    out.push(path)
  }
  return out
}
