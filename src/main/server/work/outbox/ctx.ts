import { notBuilt } from '@shared/work'
import type { CtxPart } from '../ctx'

/**
 * `ctx.held`: the Outbox store over `work_held_acts`, with run-once keys.
 * A stub: milestone 10 builds the hold.
 */
export const heldPart: CtxPart<'held'> = () => ({
  held: {
    create: notBuilt('ctx.held.create', 10),
    onDecided: notBuilt('ctx.held.onDecided', 10)
  }
})
