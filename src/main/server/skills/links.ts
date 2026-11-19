import { readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

/**
 * The directory links of the skills views and scope pointers. Off Windows a
 * symlink with a relative target, as always. On win32 a junction, the one
 * directory link a standard user may make (a symlink needs a privilege): its
 * target is absolute, so it reads back as an absolute path, and the readers
 * here hand it back relative to the link's folder, as a symlink's reads.
 */
export const JUNCTIONS = process.platform === 'win32'

/** A link at `path` to `target` (relative to the link's folder). */
export function linkDir(target: string, path: string, junction = JUNCTIONS): void {
  if (junction) symlinkSync(resolve(dirname(path), target), path, 'junction')
  else symlinkSync(target, path)
}

/** The link's target as `linkDir` was given it; throws as readlinkSync does. */
export function readDirLink(path: string, junction = JUNCTIONS): string {
  const target = readlinkSync(path)
  return junction ? relative(dirname(path), target) : target
}

/** Rename the link at `tmp` over `link`; a junction that Windows will not rename over another is put in its place after it. */
export function swapDirLink(tmp: string, link: string, junction = JUNCTIONS, rename: (from: string, to: string) => void = renameSync): void {
  try {
    rename(tmp, link)
  } catch (err) {
    if (!junction) throw err
    rmSync(link, { force: true })
    rename(tmp, link)
  }
}
