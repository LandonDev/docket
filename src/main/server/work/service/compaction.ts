/**
 * When a live document is compacted (docs/agents/work-service.md "Compaction"). A document's state keeps every
 * deleted word (its history reads them), so it only grows; work-kit's `history.compact` rewrites one past 2 MiB with
 * the deleted content gone, its versions kept as their blocks first, and refuses while anyone has it open. Nothing
 * called it. This does, at the two moments it can run: a little after the last connection leaves a document, and
 * at the minute's tick for one that has stood idle ten minutes (its last try lost to someone opening it, or its
 * editor was an agent's write, which passes no socket).
 */

export const COMPACTION = {
  /** how long after the last socket left before the try: the document's last store lands first */
  settleMs: 15_000,
  /** a document nobody has touched this long is tried again */
  idleMs: 10 * 60_000,
  /** work-kit's `COMPACT_BYTES`; a test lowers it */
  minBytes: 2 * 1024 * 1024
}

export interface CompactionDeps {
  /** connections on the document now; 0 when it is not loaded */
  connections(name: string): number
  compact(name: string, file: { path: string } | undefined, minBytes: number): Promise<unknown>
  log(line: string): void
  now?(): number
}

export interface CompactionSchedule {
  /** a socket signed in on the document (its file, for one kept as a file) */
  seen(name: string, file?: { path: string }): void
  /** a socket on the document closed */
  left(name: string): void
  /** the minute's tick: every try that is due, one after another */
  tick(): Promise<void>
  /** documents it is keeping an eye on (a test's) */
  size(): number
}

export function compactionSchedule(deps: CompactionDeps): CompactionSchedule {
  const now = deps.now ?? Date.now
  /** `due`: when to try; `tried`: whether a try ran since the document was last touched */
  const docs = new Map<string, { file?: { path: string }; touched: number; due: number | null }>()
  let running: Promise<void> = Promise.resolve()
  const touch = (name: string, file?: { path: string }) => {
    const d = docs.get(name) ?? { touched: 0, due: null }
    if (file) d.file = file
    d.touched = now()
    docs.set(name, d)
    return d
  }
  return {
    seen(name, file) {
      // Someone is in: nothing is due while they are.
      touch(name, file).due = null
    },
    left(name) {
      const d = touch(name)
      d.due = deps.connections(name) > 0 ? null : now() + COMPACTION.settleMs
    },
    tick() {
      running = running.then(async () => {
        for (const [name, d] of [...docs]) {
          const at = now()
          if (deps.connections(name) > 0) {
            d.touched = at
            d.due = null
            continue
          }
          // Not due after a leave: tried once it has stood idle the ten minutes, then let go until someone opens it again.
          const due = d.due ?? d.touched + COMPACTION.idleMs
          if (at < due) continue
          docs.delete(name)
          try {
            await deps.compact(name, d.file, COMPACTION.minBytes)
          } catch (err) {
            deps.log(`${name}: not compacted: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      })
      return running
    },
    size: () => docs.size
  }
}
