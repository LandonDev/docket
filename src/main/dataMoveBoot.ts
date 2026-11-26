import type { DataMove } from './dataMove'

/**
 * What the move to Docket's names did at this launch (dataMove.ts), as
 * boot.ts left it on `globalThis.__tempcodeDataMove`: null in a process
 * boot.js did not start (a test, a utility process, a script). The type alone
 * is imported: the boot code runs from the bundle and shares no module with
 * the rest of the app.
 */
export function dataMoveBoot(): DataMove | null {
  return (globalThis as { __tempcodeDataMove?: DataMove }).__tempcodeDataMove ?? null
}

/** doctor.get's `dataMove`: absent in a process boot.js did not start. */
export function doctorDataMove(move = dataMoveBoot()): { dataMove?: { userData: string; db: string; did: string[]; held: string[] } } {
  return move ? { dataMove: { userData: move.userData, db: move.db, did: move.did, held: move.held } } : {}
}
