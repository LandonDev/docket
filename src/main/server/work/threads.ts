import { notBuilt } from '@shared/work'
import type { CtxPart } from './ctx'

/**
 * `ctx.threads`: starting and resuming a Work thread over SessionRegistry,
 * and checking a quote against the owner's own words. A stub: milestone 6
 * builds it.
 */
export const threadsPart: CtxPart<'threads'> = () => ({
  threads: {
    start: notBuilt('ctx.threads.start', 6),
    resume: notBuilt('ctx.threads.resume', 6),
    ownerSaid: notBuilt('ctx.threads.ownerSaid', 6)
  }
})
