import type { SessionMeta } from '@shared/events'

/**
 * Which routine run a thread acts for (docs/agents/work-routines.md "Provenance"): its own, or the nearest above it
 * by parent or starter, so a routine's subagent and any thread it delegated to act for the run. One walk for the
 * Outbox's grants and the Microsoft Forms withhold.
 */

/** The run a thread acts for when this host cannot follow its line to the end (a parent on another host, or past 32 links). */
export const ROUTINE_UNKNOWN = 'unknown-run'

type Row = Pick<SessionMeta, 'routineRunId' | 'parentId' | 'startedBy'>

/** `get` reads a thread's row on this host. Null: no routine above it. `ROUTINE_UNKNOWN`: its line could not be followed. */
export function routineRunUp(get: (sessionId: string) => Row | null | undefined, sessionId: string): string | null {
  let at = get(sessionId)
  if (!at) return ROUTINE_UNKNOWN
  for (let hops = 0; at; hops++) {
    if (at.routineRunId) return at.routineRunId
    const up = at.parentId ?? at.startedBy
    if (!up) return null
    if (hops >= 32) return ROUTINE_UNKNOWN
    at = get(up)
    if (!at) return ROUTINE_UNKNOWN
  }
  return null
}
