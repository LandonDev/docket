import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * What a bench that opens a database refuses (bench-boot, bench-db-workers, measure-turn-index): a file under an
 * app's own data folder, on the Mac or the box, by any link to it, and a file in use (its write-ahead log, or its
 * cold file's, moved in the last ten minutes, as bench-review.ts reads it). These benches write into what they
 * open: a second writer on a live database freezes the threads on it.
 */
export const LIVE_DATA_DIRS = [
  '/srv/agents/docket-data',
  '/srv/agents/temp-code-data',
  ...['temp-code', 'TempCode', 'Docket'].map((name) => join(homedir(), 'Library', 'Application Support', name))
]
export const IN_USE_MS = 10 * 60_000

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Why `dbPath` may not be opened by a bench, or null when it may. */
export function benchCopyRefusal(dbPath: string, o: { now?: number; live?: readonly string[] } = {}): string | null {
  const path = real(resolve(dbPath))
  const dir = real(dirname(resolve(dbPath)))
  for (const live of (o.live ?? LIVE_DATA_DIRS).map(real)) {
    if (dir === live || dir.startsWith(`${live}/`) || path.startsWith(`${live}/`)) return `refused: ${dbPath} is an app's own data; bench a scratch copy`
  }
  const now = o.now ?? Date.now()
  for (const wal of [`${path}-wal`, `${path.replace(/\.db$/, '')}-cold.db-wal`]) {
    if (!existsSync(wal)) continue
    const st = statSync(wal)
    if (st.size > 0 && now - st.mtimeMs < IN_USE_MS) return `refused: ${dbPath} is in use (its write-ahead log moved in the last ten minutes)`
  }
  return null
}
