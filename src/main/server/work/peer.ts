import { notBuilt } from '@shared/work'
import type { CtxPart } from './ctx'

/**
 * `ctx.peer(host)`: a Work tool's route to the same module on another host,
 * over `peer.call`, under that host's bridge policy and the workspace's
 * `mayUseDesktop`. A stub: milestone 6 builds it.
 */
export const peerPart: CtxPart<'peer'> = () => ({
  peer: notBuilt('ctx.peer', 6)
})
