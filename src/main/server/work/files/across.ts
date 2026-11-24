import type { FileDone, FileRef, FilesAcross, FilesPlaces } from '@shared/contract-work-files'
import type { FolderRef } from '@shared/work/files'
import { canvasSourcePath, filesPaneOf } from '@shared/work'
import type { Caller, WorkCtx } from '../modules'
import { hostReadOf } from '../peer'
import { noteRequest } from '../../stalls'
import { NEEDS_PRESS, NO_WORKSPACE, PEER_LIBRARIES, pressesFor, workspaceHere } from './policy'

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
/** The name each desktop last had here, for the line that says it is away. */
const lastName = new Map<string, string>()

/** What the host link says of a desktop it cannot reach now. */
const AWAY = /offline|no live link|not connected|connection closed|timed out/i

export const ACROSS_WINDOW = 'Only your own window lists another computer through this host.'

/**
 * What changes a desktop's files from here, on his own press alone (his window, or a key that may approve): a delete to
 * that desktop's own bin and its Put back, a rename, and a move inside that desktop. Sent with where it began, as a
 * copy's save is, so that desktop's door asks it as his (policy.ts `admitWrite`). Nothing else changes a file there
 * from here: New, an upload, a copy and a write are made where the window reaches.
 */
const CHANGES = new Set<string>(['work.files.trash', 'work.files.restore', 'work.files.rename', 'work.files.move'])
/** What a desktop's places offer through this host: the changes above, and nothing else. */
const CHANGES_OFFERED = new Set<string>(['trash', 'rename', 'move'])

/** One listing call of a desktop the window cannot reach, run there for it. Places come back read only, named as he names that desktop. */
export async function filesAcross(ctx: WorkCtx, by: Caller, p: { workspaceId: string; host: string; method: FilesAcross; params: Record<string, unknown> }, signal?: AbortSignal): Promise<unknown> {
  noteRequest('place', 'across')
  if (by.kind === 'model') throw new Error(ACROSS_WINDOW)
  // Another host asking this one to ask a third: never a chain.
  if (by.peer) throw new Error(PEER_LIBRARIES)
  const workspace = workspaceHere(ctx.db, p.workspaceId)
  if (!workspace) throw new Error(NO_WORKSPACE)
  if (p.host === ctx.host) throw new Error('That is this host: ask it directly.')
  if (!liveBinding(p.host)) throw new Error(NOT_BOUND)
  const change = CHANGES.has(p.method)
  if (change && !pressesFor(by)) throw new Error(NEEDS_PRESS)
  // `ctx.peer` itself holds the call to a desktop the workspace may use ("May use this computer").
  // A desktop away has no registration to name it by: the name it last had here stands.
  const name = hostReadOf(ctx)?.name?.(p.host) ?? lastName.get(p.host) ?? null
  if (name) lastName.set(p.host, name)
  const far = ctx.peer.call({ scope: { sessionId: filesPaneOf(workspace.id), workspaceId: workspace.id }, signal } as never, p.host)
  let answer: unknown
  try {
    answer = await far.call('files', p.method.slice('work.files.'.length), { ...p.params, workspaceId: workspace.id, ...(change ? { origin: { from: 'window' } } : {}) })
  } catch (err) {
    // Asleep, off its VPN or TempCode closed: it is not linked now. Said so, in words a window reads as away.
    if (AWAY.test(err instanceof Error ? err.message : String(err))) throw new Error(`${name ?? 'That computer'} is not reachable now.`)
    throw err
  }
  if (p.method !== 'work.files.places') return answer
  const got = answer as FilesPlaces
  // A file there opens as a copy made on this host; of the changes, only a delete (and its Put back) goes there.
  return { ...got, places: got.places.map(({ makes: _, ...place }) => ({ ...place, can: place.can.filter((verb) => CHANGES_OFFERED.has(verb)) })), ...(name ? { name } : {}) }
}

/** A Trash row another host keeps, as this host answers it: Put back finds that host by it (`farIdsOf`). */
const FAR = /^far:(env_[A-Za-z0-9_-]{1,60}):(.+)$/
export const farId = (host: string, id: string): string => `far:${host}:${id}`

/** The one other host every ref names, or null when they all lie here (this disk, its Windows VM, a lens). */
export function farHostOf(ctx: Pick<WorkCtx, 'host'>, refs: readonly FileRef[]): string | null {
  const hosts = new Set(refs.map((r) => ('host' in r && typeof r.host === 'string' && canvasSourcePath(r as never) !== null ? r.host : ctx.host)))
  hosts.delete(ctx.host)
  if (!hosts.size) return null
  if (hosts.size > 1 || refs.some((r) => !('host' in r) || r.host === ctx.host)) throw new Error('Delete the files of one computer at a time.')
  return [...hosts][0]!
}

/**
 * `work.files.trash` of files another host holds (his Mac's, his PC's), asked of this, the workspace's host: sent to
 * that host, which puts them in its own bin and keeps their Trash rows (`filesAcross`, his press alone). The rows come
 * back as `far:` ids, so Undo and Put back asked here go to the same host. Once that bin took a file, its copy tabs
 * here close, the changes they still held let go as his confirm said; a file that stayed keeps its tab.
 */
export async function trashElsewhere(ctx: WorkCtx, by: Caller, host: string, p: { workspaceId: string; refs: FileRef[]; op: string; asked?: boolean; forGood?: boolean }, closeTabs: (paths: readonly string[]) => void, signal?: AbortSignal): Promise<FileDone> {
  const done = (await filesAcross(ctx, by, { workspaceId: p.workspaceId, host, method: 'work.files.trash', params: { refs: p.refs, op: p.op, ...(p.asked ? { asked: true } : {}), ...(p.forGood ? { forGood: true } : {}) } }, signal)) as FileDone
  const refused = new Set(done.refused.map((r) => r.name))
  const went = p.refs.flatMap((r) => {
    const path = canvasSourcePath(r as never)
    return path !== null && !refused.has(path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)) ? [path] : []
  })
  if (went.length) closeTabs(went)
  return { ...done, trashed: (done.trashed ?? []).map((id) => farId(host, id)) }
}

/** Put back of rows other hosts keep (`far:` ids), each asked of its own host; the rest are this host's. */
export async function restoreElsewhere(ctx: WorkCtx, by: Caller, p: { workspaceId: string; ids: string[]; op: string }, signal?: AbortSignal): Promise<{ done: FileDone; here: string[] }> {
  const byHost = new Map<string, string[]>()
  const here: string[] = []
  for (const id of p.ids) {
    const far = FAR.exec(id)
    if (far) byHost.set(far[1]!, [...(byHost.get(far[1]!) ?? []), far[2]!])
    else here.push(id)
  }
  const done: FileDone = { entries: [], refused: [], op: p.op }
  for (const [host, ids] of byHost) {
    const got = (await filesAcross(ctx, by, { workspaceId: p.workspaceId, host, method: 'work.files.restore', params: { ids, op: `${p.op}:${host}` } }, signal)) as FileDone
    done.entries.push(...got.entries)
    done.refused.push(...got.refused)
  }
  return { done, here }
}

/**
 * A rename, or a move inside one other host, of that host's files, asked of this, the workspace's host: sent there on
 * his press (`filesAcross`), and this workspace's copies of them follow to where each went (`moved`: copies.ts
 * `copiesMoved`). A move to another computer is a copy and a delete, made where the window reaches.
 */
export async function changeElsewhere(ctx: WorkCtx, by: Caller, host: string, method: 'work.files.rename' | 'work.files.move', p: { workspaceId: string; ref?: FileRef; refs?: FileRef[]; to?: FolderRef; name?: string; op: string; asked?: boolean }, moved: (pairs: { from: string; to: string }[]) => void, signal?: AbortSignal): Promise<FileDone> {
  if (method === 'work.files.move' && (!p.to || !('host' in p.to) || p.to.host !== host)) throw new Error('A move to another computer is a copy, then a delete: copy it there first.')
  const { workspaceId: _, ...params } = p
  const done = (await filesAcross(ctx, by, { workspaceId: p.workspaceId, host, method, params }, signal)) as FileDone
  const pathOf = (r: FileRef | null | undefined): string | null => (r ? canvasSourcePath(r as never) : null)
  const nameOf = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const pairs: { from: string; to: string }[] = []
  if (method === 'work.files.rename') {
    const from = pathOf(p.ref)
    const to = pathOf(done.entries[0]?.ref ?? done.entries[0]?.folder)
    if (from && to && from !== to) pairs.push({ from, to })
  } else {
    // Paired by a name one thing alone holds, never one the move refused (as the window's `movedPairs`).
    const asked = (p.refs ?? []).map(pathOf).filter((x): x is string => x !== null)
    const went = done.entries.map((e) => pathOf(e.ref ?? e.folder)).filter((x): x is string => x !== null)
    const refused = new Set(done.refused.map((r) => r.name))
    const once = (names: string[], name: string): boolean => names.filter((n) => n === name).length === 1
    for (const from of asked) {
      const name = nameOf(from)
      if (refused.has(name) || !once(asked.map(nameOf), name) || !once(went.map(nameOf), name)) continue
      const to = went.find((w) => nameOf(w) === name)!
      if (to !== from) pairs.push({ from, to })
    }
  }
  if (pairs.length) moved(pairs)
  return done
}
