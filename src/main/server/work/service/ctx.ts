import { notBuilt, type CanvasSource, type Principal } from '@shared/work'
import type { CtxPart } from '../ctx'

/**
 * `ctx.service`: the Work service's addresses, its collaboration tokens and
 * its internal routes. A stub: milestone 18 builds the service and this
 * member.
 */

/** What a collaboration token says: one document or sheet, a role, and who holds it. Minutes long. */
export interface CollabClaims {
  item: { doc: string } | { sheet: string }
  role: 'view' | 'comment' | 'edit'
  principal: Principal
  /** a file-backed item's source, for the host that serves it */
  source?: CanvasSource
}

export const servicePart: CtxPart<'service'> = () => ({
  service: {
    url: notBuilt('ctx.service.url', 18),
    token: notBuilt('ctx.service.token', 18),
    internal: notBuilt('ctx.service.internal', 18)
  }
})
