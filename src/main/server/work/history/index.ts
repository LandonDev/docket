import { existsSync } from 'node:fs'
import { HISTORY_CAPS, type HistoryBranch, type HistoryCompare, type HistoryVersion, type HistoryVersions } from '@shared/contract-work-history'
import { handled, NOT_HANDLED, type CanvasSource } from '@shared/work'
import { fetchedItemOfPath } from '../canvas/fetch'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { canonicalPath } from '../service/ctx'
import { guestNameOf } from '../guests/store'
import { madeFromShared } from '../docs/target'
import { NEEDS_PRESS, pressesFor } from '../files/policy'

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
    // A source names its host by environment id, or as this host saw it when it was opened (pdf/file.ts reads it the same way).
    if (source.host !== ctx.host && !existsSync(source.path)) throw new Error('that document is on another host; open its history there')
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
 * words for the rest. A guest is named by their link's row (milestone 31).
 */
export function namesFor(ctx: WorkCtx, principals: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {}
  const title = ctx.db.prepare('SELECT title FROM sessions WHERE id = ?')
  for (const p of new Set(principals)) {
    if (p === 'owner' || (p.startsWith('lifeos:') && !p.startsWith('lifeos:bot:'))) out[p] = 'You'
    else if (p.startsWith('lifeos:bot:')) out[p] = 'LifeOS'
    else if (p.startsWith('external:')) out[p] = p.slice('external:'.length) || 'Someone'
    else if (p.startsWith('guest:')) out[p] = guestNameOf(ctx.db, p) ?? 'A guest'
    else if (p.startsWith('agent:')) {
      const [, host, thread] = p.split(':')
      const row = host === ctx.host && thread ? (title.get(thread) as { title?: string } | undefined) : undefined
      out[p] = row?.title?.trim() || 'An agent'
    } else out[p] = 'Someone'
  }
  return out
}

/**
 * Whether others can read a document: a LifeOS document shared by a guest link, or a .tcdoc where `madeFromShared`
 * says so. Asked only of a caller that is not his press (`pressesFor`); what cannot be read is taken as shared.
 */
async function othersRead(ctx: WorkCtx, source: CanvasSource): Promise<boolean> {
  if (source.at !== 'lifeos') return madeFromShared(ctx, source)
  try {
    return !!(await ctx.lifeos.owner().query<{ shared?: boolean } | null>('docs:get', { id: source.id }))?.shared
  } catch {
    return true
  }
}

const call = <T>(ctx: WorkCtx, route: string, body: Record<string, unknown>): Promise<T> => ctx.service.internal(`/internal/history/${route}`, body) as Promise<T>

export const NEEDS_REVISION = 'Others read this document: look at the change again, then take it from what is shown.'

export const READ_ONLY = "This document is a mail's attachment, read only: keep it as a document of your own to decide its changes."

export const history: WorkModule = {
  id: 'history',
  ensure() {},
  async handle(req, ctx, by) {
    if (!(req.method in HISTORY_CAPS)) return NOT_HANDLED
    const at = (source: CanvasSource) => targetOf(ctx, by, req.method, source)
    // A mail's attachment read as a document is read only (work-mail.md "Attachments"): its versions and changes show, and none is cut, restored or decided.
    if ((req.method === 'work.history.decide' || req.method === 'work.history.restore' || req.method === 'work.history.cut') && 'file' in at(req.params.source)) {
      const target = at(req.params.source) as { file: string }
      if (fetchedItemOfPath(ctx, target.file)) throw new Error(READ_ONLY)
    }
    // An agent's branch on a document others can read is shown to, and taken or dropped by, his press alone: his
    // window or a key that may approve; never a read or operate key, another host of his or a thread.
    if ((req.method === 'work.history.branches' || req.method === 'work.history.decide') && !pressesFor(by)) {
      at(req.params.source)
      if (await othersRead(ctx, req.params.source)) throw new Error(NEEDS_PRESS)
    }
    // Taken into a document others read, a branch is bound to the revision his screen read (round 3): an Accept with
    // none could take words an agent wrote after he looked.
    if (req.method === 'work.history.decide' && req.params.accept && req.params.editedAt === undefined) {
      at(req.params.source)
      if (await othersRead(ctx, req.params.source)) throw new Error(NEEDS_REVISION)
    }
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
        const { source, branchId, which, accept, editedAt } = req.params
        const target = at(source)
        return handled(await call(ctx, 'decide', bodyOf(target, { branchId, which, accept, ...(editedAt !== undefined ? { editedAt } : {}), ...('file' in target ? { shared: target.shared } : {}) })))
      }
      default:
        return NOT_HANDLED
    }
  }
}
