import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkCtx, WorkModule } from '../modules'
import { digestOf, type Digest } from './ctx'
import { DIGEST_TELLS } from './rule'
import { ensureDigestTables } from './store'

/**
 * The digest pillar's server module (docs/agents/work-digest.md): the
 * ledger behind `ctx.tell`, the day's one notice, and what he sets. It
 * lists no tool and adds nothing to a thread's preamble: a thread never
 * tells him through the digest, a pillar does.
 */

/** A test's seam: no timer. */
export const digestSeams: { current: { interval?: false } | null } = { current: null }

const host = (ctx: WorkCtx): Digest => {
  const d = digestOf(ctx)
  if (!d) throw new Error('The digest is not running on this host')
  return d
}

export const digest: WorkModule = {
  id: 'digest',
  ensure: ensureDigestTables,
  tells: DIGEST_TELLS,
  async handle(req, ctx) {
    switch (req.method) {
      case 'work.digest.list':
        return handled(host(ctx).list(req.params))
      case 'work.digest.get':
        return handled(host(ctx).settings())
      case 'work.digest.set':
        return handled(host(ctx).set(req.params))
      case 'work.digest.here':
        return handled(host(ctx).here(req.params.zone))
      case 'work.digest.seen':
        return handled(host(ctx).seen(req.params.day))
    }
    return NOT_HANDLED
  },
  start(ctx) {
    return digestOf(ctx)?.start(digestSeams.current ?? {}) ?? (() => {})
  },
  sessionsRemoved(ids, ctx) {
    digestOf(ctx)?.store.unquiet(ids)
  },
  workspaceRemoved(workspaceId, ctx) {
    digestOf(ctx)?.workspaceRemoved(workspaceId)
  }
}
