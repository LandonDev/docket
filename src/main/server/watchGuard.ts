import { statSync } from 'node:fs'

/**
 * A file watch never stops a boot (docs/box.md "Answers under load").
 *
 * `fs.watch` throws at once when the kernel refuses a watch: ENOSPC once the
 * user's inotify watches are spent (2026-11-23: the live service held all
 * of them, a deploy's trial threw ENOSPC from the Codex credentials watch at
 * boot, the rejection ended the start before the remote port opened, and
 * the deploy could not pass its health check), EMFILE, a folder gone. Every
 * watch started on the boot path goes through `guardWatch`: a refusal is
 * one log line and a row in `doctor.get` (`watchFailures`), and the caller
 * keeps its timed fallback.
 */

export interface WatchFailure {
  /** What the watch was for. */
  what: string
  /** The error's code or message (`ENOSPC`). */
  error: string
  /** What covers it instead. */
  fallback: string
  at: number
}

const MAX_KEPT = 50
const failures: WatchFailure[] = []
let log: (line: string) => void = (line) => console.warn(line)

/** Start a watch that may be refused; null (logged once, counted) instead of a throw. */
export function guardWatch<T>(what: string, fallback: string, start: () => T): T | null {
  try {
    return start()
  } catch (err) {
    noteWatchFailure(what, fallback, err)
    return null
  }
}

/** A watch refused somewhere a caller already caught it: logged and counted the same way. */
export function noteWatchFailure(what: string, fallback: string, err: unknown): void {
  const error = (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.message : String(err))
  log(`[watch] cannot watch ${what} (${error}); ${fallback}`)
  failures.push({ what, error, fallback, at: Date.now() })
  if (failures.length > MAX_KEPT) failures.shift()
}

/** The refused watches since boot (the last MAX_KEPT), for doctor.get. */
export function watchFailures(): WatchFailure[] {
  return failures.map((f) => ({ ...f }))
}

/** Test seam. */
export function resetWatchFailuresForTests(o: { log?: (line: string) => void } | null = null): void {
  failures.length = 0
  log = o?.log ?? ((line) => console.warn(line))
}

/**
 * The timed fallback for a file whose watch was refused: its mtime every
 * `everyMs`, and `changed()` when it moved. Unref'd; the return stops it.
 */
export function pollFile(path: string, everyMs: number, changed: () => void): () => void {
  const mtime = (): number => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0
  let last = mtime()
  const timer = setInterval(() => {
    const now = mtime()
    if (now === last) return
    last = now
    changed()
  }, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export const POLL_FALLBACK_MS = 30_000

/** Start `watch`; when it is refused, check each file's mtime every `everyMs` instead. */
export function watchOrPoll(
  what: string,
  watch: () => void,
  files: readonly { path: string; changed: () => void }[],
  everyMs = POLL_FALLBACK_MS
): 'watch' | 'poll' {
  const ok = guardWatch(what, `a check every ${Math.round(everyMs / 1000)} s covers it`, () => {
    watch()
    return true
  })
  if (ok) return 'watch'
  for (const f of files) pollFile(f.path, everyMs, f.changed)
  return 'poll'
}
