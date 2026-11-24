import { MSFORM_UNATTENDED_WITHHELD, MSFORM_WITHHELD_WORDS } from '@shared/work/msforms'
import type { Caller, WorkCtx } from '../modules'
import { MsformsError } from './reach'

/**
 * Purdue's withhold (docs/agents/work-msforms.md "Purdue"): a thread a routine
 * started (its scope's `routineRunId`) reads no answers of a form in a sector of
 * `MSFORM_UNATTENDED_WITHHELD`, whatever started the routine. Every answer read
 * asks this first: `msform_answers`, `msform_find`, the answers in `msform_read`,
 * `work_search`'s answer hits, `person_page`'s Answered line, and
 * `work.msforms.responses` from a thread. His own asks are not withheld.
 */
export function answersWithheld(ctx: Pick<WorkCtx, 'scopeOf'>, by: Caller, sector: string | null): boolean {
  if (by.kind !== 'model' || !by.sessionId || !sector || !MSFORM_UNATTENDED_WITHHELD.includes(sector)) return false
  return Boolean(ctx.scopeOf(by.sessionId)?.routineRunId)
}

/** Throws the withhold's sentence when the read is withheld. */
export function refuseWithheld(ctx: Pick<WorkCtx, 'scopeOf'>, by: Caller, sector: string | null): void {
  if (answersWithheld(ctx, by, sector)) throw new MsformsError(MSFORM_WITHHELD_WORDS)
}

/** Whether a routine whose run would start a thread may be bound to answers of a form in this sector. */
export const routineWithheld = (sector: string | null, startsThread: boolean): boolean => startsThread && !!sector && MSFORM_UNATTENDED_WITHHELD.includes(sector)
