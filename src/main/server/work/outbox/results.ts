import type { DatabaseSync } from 'node:sqlite'
import { notBuilt } from '@shared/work'
import type { CtxPart } from '../ctx'

/**
 * `ctx.results`: what a thread changed that lasts (`work_results`), with
 * its way back. A stub: milestone 14 builds it, and makes its table in
 * `ensureResults`, which the outbox module's `ensure` calls.
 */
export function ensureResults(_db: DatabaseSync): void {}

export const resultsPart: CtxPart<'results'> = () => ({
  results: {
    add: notBuilt('ctx.results.add', 14)
  }
})
