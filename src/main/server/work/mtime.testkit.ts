import { statSync, utimesSync } from 'node:fs'

/** Move a scratch file's timestamp from the value the filesystem actually assigned. */
export function shiftMtime(path: string, offsetMs: number): void {
  const { atime, mtimeMs } = statSync(path)
  utimesSync(path, atime, new Date(mtimeMs + offsetMs))
}
