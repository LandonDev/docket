import type { ClientRequest } from '@shared/contract'
import { NotBuilt } from '@shared/work/ids'
import type { Caller, WorkCtx, WorkModule } from '../modules'

/**
 * How search asks another pillar for what is the pillar's own to find
 * (docs/agents/work-search.md "Files and Messages"): through the pillar's
 * own wire method, by its module's `handle`, with the caller the search was
 * given, so the pillar's own fences answer. A method that is not built, not
 * known or whose pillar did not load is absent: it answers `undefined`, and
 * the source that asked says nothing. That is how search stands before a
 * pillar lands and gains its group the day the method answers, with no edit
 * here.
 */

/** A pillar's words for a verb it declares and does not answer yet. */
const NOT_YET = /^not built\b|\byet: that arrives with its milestone\b|^unknown method\b/i

export async function askPillar<T>(ctx: WorkCtx, modules: readonly WorkModule[], method: string, params: Record<string, unknown>, by: Caller, signal?: AbortSignal): Promise<T | undefined> {
  const pillar = method.startsWith('work.') ? method.split('.')[1] : undefined
  const module = modules.find((m) => m.id === pillar)
  if (!module?.handle) return undefined
  try {
    const answer = await module.handle({ id: 'work-search', method, params } as unknown as ClientRequest, ctx, by, signal)
    return answer.handled ? (answer.result as T) : undefined
  } catch (err) {
    if (err instanceof NotBuilt || (err instanceof Error && NOT_YET.test(err.message))) return undefined
    throw err
  }
}
