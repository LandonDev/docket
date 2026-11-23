import type { HistoryVersions } from '@shared/contract-work-history'
import type { CanvasSource } from '@shared/work'
import type { HostPoint } from '@shared/work/review'
import { WORK_MODULES, type WorkCtx } from '../../modules'
import { breathe, stopped, type Asked, type Jobs } from './common'
import { HOST } from './held'

/**
 * Documents he changed, from document history: the one store that says who changed a file. Each version cut in the
 * span that he wrote into is a point. Only the documents this host's Work threads opened and touched since the span
 * began are asked about, 200 at most, through the history pillar's own wire. A sheet, a deck or a file on disk
 * names no author and is not counted.
 */

export const DOCS_MOST = 200

/** Whether a version's principal is him: the owner at a host, or his own LifeOS app (never LifeOS's bot). */
export const isHim = (principal: string): boolean => principal === 'owner' || (principal.startsWith('lifeos:') && !principal.startsWith('lifeos:bot:'))

export type FileFacts = { points: HostPoint[]; before: HostPoint[] }

export async function fileFacts(ctx: WorkCtx, asked: Asked, jobs: Jobs): Promise<FileFacts> {
  const history = WORK_MODULES.find((m) => m.id === 'history')
  if (!history?.handle) throw new Error('Document history is not running on this host')
  const since = Math.min(asked.before.from, asked.from)
  const docs = new Map<string, { source: CanvasSource; job: number; at: number }>()
  for (const j of jobs.list) {
    const job = jobs.byWorkspace.get(j.workspaceId)!
    for (const item of ctx.canvas.forWorkspace(j.workspaceId, { panes: true })) {
      if (item.kind !== 'document' || item.updatedAt < since) continue
      const key = JSON.stringify(item.source)
      const have = docs.get(key)
      if (!have || have.at < item.updatedAt) docs.set(key, { source: item.source, job, at: item.updatedAt })
    }
  }
  const out: FileFacts = { points: [], before: [] }
  let failed = 0
  const picked = [...docs.values()].sort((a, b) => b.at - a.at).slice(0, DOCS_MOST)
  for (const doc of picked) {
    stopped(asked.signal)
    try {
      const answer = await history.handle({ id: 'review', method: 'work.history.versions', params: { source: doc.source } } as never, ctx, HOST, asked.signal)
      if (!answer.handled) throw new Error('not taken')
      for (const v of (answer.result as HistoryVersions).versions) {
        if (!v.by.some(isHim)) continue
        if (v.at >= asked.from && v.at < asked.to) out.points.push([v.at, doc.job, 'edited'])
        else if (v.at >= asked.before.from && v.at < asked.before.to) out.before.push([v.at, doc.job, 'edited'])
      }
    } catch {
      // One document that cannot be read (moved, on another host) costs its own edits, not the rest.
      failed++
    }
    await breathe()
  }
  // Every document failing is the history service being down, which the page should say.
  if (picked.length > 0 && failed === picked.length) throw new Error('Document history did not answer')
  return out
}
