import type { FilesAcross, FilesPlaces } from '@shared/contract-work-files'
import { filesPaneOf } from '@shared/work'
import type { Caller, WorkCtx } from '../modules'
import { hostReadOf } from '../peer'
import { NO_WORKSPACE, PEER_LIBRARIES, workspaceHere } from './policy'

/**
 * Files from another window (docs/agents/work-files.md "A desktop the window cannot reach"): his Mac's window has
 * no link to a PC that links only to the box, so it asks a box workspace, and the box asks the PC over its host
 * link (`ctx.peer`, as a Files tab's copy does). Two gates on the box (the workspace may use that desktop, and its
 * binding is live) and one on the PC (its bridge policy for the box, and the rule that another host reaches only
 * its libraries). Only the listing crosses; opening a file is today's copy (`copyIn`, `writeBack`).
 */

/**
 * Whether a desktop's device binding is live. The binding store is built elsewhere; until it lands, every host
 * linked to this one counts as live, since a host link opens only over an admin key (remote/peers.ts).
 */
let liveBinding: (envId: string) => boolean = () => true
/** The binding store (or a test) says which desktops are live; none: every linked host again. */
export const setLiveBinding = (fn?: (envId: string) => boolean): void => void (liveBinding = fn ?? (() => true))

export const NOT_BOUND = "That computer's link to this host is stopped or removed."
/** What the host link says of a desktop it cannot reach now. */
const AWAY = /offline|no live link|not connected|connection closed|timed out/i

export const ACROSS_WINDOW = 'Only your own window lists another computer through this host.'

/** One listing call of a desktop the window cannot reach, run there for it. Places come back read only, named as he names that desktop. */
export async function filesAcross(ctx: WorkCtx, by: Caller, p: { workspaceId: string; host: string; method: FilesAcross; params: Record<string, unknown> }, signal?: AbortSignal): Promise<unknown> {
  if (by.kind === 'model') throw new Error(ACROSS_WINDOW)
  // Another host asking this one to ask a third: never a chain.
  if (by.peer) throw new Error(PEER_LIBRARIES)
  const workspace = workspaceHere(ctx.db, p.workspaceId)
  if (!workspace) throw new Error(NO_WORKSPACE)
  if (p.host === ctx.host) throw new Error('That is this host: ask it directly.')
  if (!liveBinding(p.host)) throw new Error(NOT_BOUND)
  // `ctx.peer` itself holds the call to a desktop the workspace may use ("May use this computer").
  const name = hostReadOf(ctx)?.name?.(p.host) ?? null
  const far = ctx.peer.call({ scope: { sessionId: filesPaneOf(workspace.id), workspaceId: workspace.id }, signal } as never, p.host)
  let answer: unknown
  try {
    answer = await far.call('files', p.method.slice('work.files.'.length), { ...p.params, workspaceId: workspace.id })
  } catch (err) {
    // Asleep, off its VPN or TempCode closed: it is not linked now. Said so, in words a window reads as away.
    if (AWAY.test(err instanceof Error ? err.message : String(err))) throw new Error(`${name ?? 'That computer'} is not reachable now.`)
    throw err
  }
  if (p.method !== 'work.files.places') return answer
  const got = answer as FilesPlaces
  // Nothing is changed there from here: a file opens as a copy made on this host.
  return { ...got, places: got.places.map(({ makes: _, ...place }) => ({ ...place, can: [] })), ...(name ? { name } : {}) }
}
