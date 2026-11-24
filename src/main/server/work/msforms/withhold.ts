import { MSFORM_UNATTENDED_WITHHELD, MSFORM_WITHHELD_WORDS } from '@shared/work/msforms'
import type { Caller, WorkCtx } from '../modules'
import { MsformsError } from './reach'

/**
 * Purdue's withhold (docs/agents/work-msforms.md "Purdue"): a thread a routine
 * started, or one it delegated to (its scope's `routineRun`, the run up its line: work/provenance.ts), reads no answers of a form in a sector of
 * `MSFORM_UNATTENDED_WITHHELD`, whatever started the routine. Every answer read
 * asks this first: `msform_answers`, `msform_find`, the answers in `msform_read`,
 * `work_search`'s answer hits, `person_page`'s Answered line, and
 * `work.msforms.responses` from a thread. His own asks are not withheld.
 */
export function answersWithheld(ctx: Pick<WorkCtx, 'scopeOf'>, by: Caller, sector: string | null): boolean {
  if (by.kind !== 'model' || !sector || !MSFORM_UNATTENDED_WITHHELD.includes(sector)) return false
  // A thread whose provenance cannot be established is withheld: no session named, no scope, or a line not followed.
  const scope = by.sessionId ? ctx.scopeOf(by.sessionId) : null
  if (!scope) return true
  // the run it acts for up its line (a routine's delegated child), else its own row's (provenance.ts)
  return Boolean(scope.routineRun ?? scope.routineRunId)
}

/** Throws the withhold's sentence when the read is withheld. */
export function refuseWithheld(ctx: Pick<WorkCtx, 'scopeOf'>, by: Caller, sector: string | null): void {
  if (answersWithheld(ctx, by, sector)) throw new MsformsError(MSFORM_WITHHELD_WORDS)
}

/** Whether a routine whose run would start a thread may be bound to answers of a form in this sector. */
export const routineWithheld = (sector: string | null, startsThread: boolean): boolean => startsThread && !!sector && MSFORM_UNATTENDED_WITHHELD.includes(sector)
