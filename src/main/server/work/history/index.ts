import { HISTORY_CAPS, type HistoryBranch, type HistoryCompare, type HistoryVersion, type HistoryVersions } from '@shared/contract-work-history'
import { handled, NOT_HANDLED, type CanvasSource } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { canonicalPath } from '../service/ctx'

/**
 * The history pillar's server module (docs/agents/work-history.md): a
 * document's versions, compares, restores and branches. The live document
 * and its history are the Work service's (work/history/serviceRoutes.ts,
 * work-kit's collab-server/history.ts); this module checks who asks and
 * what, calls the service's internal routes, and names the principals.
 */

/** What the service is told a document is, after this host's own checks. */
type Target = { docId: string } | { file: string; shared: boolean }

/** A source history serves: a LifeOS document, or a `.tcdoc` on this host the caller could name. */
export function targetOf(ctx: WorkCtx, by: Caller, method: string, source: CanvasSource): Target {
  if (source.at === 'lifeos' && source.table === 'docs') return { docId: source.id }
  if (source.at === 'file' && source.path.toLowerCase().endsWith('.tcdoc')) {
    if (source.host !== ctx.host) throw new Error('that document is on another host; open its history there')
    if (!ctx.reaches(by, source.path)) throw new FenceError(method)
    // A file is shared once a guest link names it (milestone 31); none can yet.
    return { file: canonicalPath(source.path), shared: false }
  }
  throw new Error('history is kept for documents: a LifeOS document or a .tcdoc')
}

/** The owner acts through the service unfenced: the method's own capability and the path fence are the checks. */
const bodyOf = (target: Target, rest: Record<string, unknown> = {}) => ({ ...target, ...rest, fence: { sectors: 'all' } })

/**
 * The words a screen shows for each principal: "You" for the owner and his
 * own LifeOS apps, a thread's title for an agent of this host, and plain
 * words for the rest. A guest is named by M31's link rows when they exist.
 */
export function namesFor(ctx: WorkCtx, principals: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {}
  const title = ctx.db.prepare('SELECT title FROM sessions WHERE id = ?')
  for (const p of new Set(principals)) {
    if (p === 'owner' || (p.startsWith('lifeos:') && !p.startsWith('lifeos:bot:'))) out[p] = 'You'
    else if (p.startsWith('lifeos:bot:')) out[p] = 'LifeOS'
    else if (p.startsWith('external:')) out[p] = p.slice('external:'.length) || 'Someone'
    else if (p.startsWith('guest:')) out[p] = 'A guest'
    else if (p.startsWith('agent:')) {
      const [, host, thread] = p.split(':')
      const row = host === ctx.host && thread ? (title.get(thread) as { title?: string } | undefined) : undefined
      out[p] = row?.title?.trim() || 'An agent'
    } else out[p] = 'Someone'
  }
  return out
}

const call = <T>(ctx: WorkCtx, route: string, body: Record<string, unknown>): Promise<T> => ctx.service.internal(`/internal/history/${route}`, body) as Promise<T>

export const history: WorkModule = {
  id: 'history',
  ensure() {},
  async handle(req, ctx, by) {
    if (!(req.method in HISTORY_CAPS)) return NOT_HANDLED
    const at = (source: CanvasSource) => targetOf(ctx, by, req.method, source)
    switch (req.method) {
      case 'work.history.versions': {
        const target = at(req.params.source)
        const got = await call<{ versions: HistoryVersion[]; shared: boolean }>(ctx, 'list', bodyOf(target, 'file' in target ? { shared: target.shared } : {}))
        const answer: HistoryVersions = { ...got, names: namesFor(ctx, got.versions.flatMap((v) => v.by)) }
        return handled(answer)
      }
      case 'work.history.compare': {
        const { source, from, to } = req.params
        const got = await call<Omit<HistoryCompare, 'names'>>(ctx, 'compare', bodyOf(at(source), { from, to }))
        const answer: HistoryCompare = { ...got, names: namesFor(ctx, got.diff.rows.flatMap((r) => r.by ?? [])) }
        return handled(answer)
      }
      case 'work.history.cut': {
        const { source, label } = req.params
        return handled(await call<HistoryVersion>(ctx, 'cut', bodyOf(at(source), label ? { label } : {})))
      }
      case 'work.history.restore': {
        const { source, versionId } = req.params
        const target = at(source)
        return handled(await call(ctx, 'restore', bodyOf(target, { versionId, ...('file' in target ? { shared: target.shared } : {}) })))
      }
      case 'work.history.branches': {
        const got = await call<{ branches: HistoryBranch[] }>(ctx, 'branches', bodyOf(at(req.params.source)))
        return handled({ branches: got.branches, names: namesFor(ctx, got.branches.flatMap((b) => b.authors)) })
      }
      case 'work.history.decide': {
        const { source, branchId, which, accept } = req.params
        const target = at(source)
        return handled(await call(ctx, 'decide', bodyOf(target, { branchId, which, accept, ...('file' in target ? { shared: target.shared } : {}) })))
      }
      default:
        return NOT_HANDLED
    }
  }
}
