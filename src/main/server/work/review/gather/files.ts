import { relative, sep } from 'node:path'
import type { HistoryVersions } from '@shared/contract-work-history'
import type { CanvasSource, SectorKey } from '@shared/work'
import type { HostPoint } from '@shared/work/review'
import { WORK_MODULES, type WorkCtx } from '../../modules'
import { breathe, jobIndex, stopped, type Asked, type Jobs } from './common'
import { HOST } from './held'

/**
 * Documents he changed, from document history: the one store that says who changed a file. Each version cut in the
 * span that he wrote into is a point. Only the documents this host's Work threads opened and touched since the span
 * began are asked about, 200 at most, through the history pillar's own wire. A sheet, a deck or a file on disk
 * names no author and is not counted.
 *
 * A tab is no proof of whose a document is: a Cosmic document open in a Purdue thread is Cosmic's. So each one is
 * filed by its own sector, LifeOS's for a LifeOS document and the sector of the Work workspace whose folder holds a
 * `.tcdoc`; only a file outside every workspace's folder goes by the tab it was open in.
 */

export const DOCS_MOST = 200

/** Whether a version's principal is him: the owner at a host, or his own LifeOS app (never LifeOS's bot). */
export const isHim = (principal: string): boolean => principal === 'owner' || (principal.startsWith('lifeos:') && !principal.startsWith('lifeos:bot:'))

/** `part`: some documents were not read (past the cap, or one whose history or sector did not answer), so edits may be short. */
export type FileFacts = { points: HostPoint[]; before: HostPoint[]; part: boolean }

/** The sources document history keeps: a LifeOS document or a `.tcdoc` (history/index.ts `targetOf`). */
const kept = (s: CanvasSource): boolean => (s.at === 'lifeos' && s.table === 'docs') || (s.at === 'file' && s.path.toLowerCase().endsWith('.tcdoc'))

const inside = (root: string, path: string): boolean => {
  const r = relative(root, path)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !r.startsWith(sep) && !/^[a-zA-Z]:/.test(r))
}

/**
 * Whose a document is: the LifeOS document's own sector, with the tab's workspace while it is of that sector; the
 * Work workspace whose folder holds a file; and only for a file outside every folder, the tab it was open in.
 */
async function ownerOf(ctx: WorkCtx, source: CanvasSource, tab: string, folders: readonly { id: string; path: string; sector: SectorKey | null }[]): Promise<{ workspaceId: string; sector: SectorKey | null }> {
  if (source.at === 'lifeos') {
    const doc = await ctx.lifeos.owner().query<{ sector?: string } | null>('docs:get', { id: source.id })
    if (typeof doc?.sector !== 'string') throw new Error('LifeOS has no such document')
    return { workspaceId: tab, sector: doc.sector }
  }
  const path = source.at === 'file' ? source.path : ''
  const holder = folders.filter((f) => f.path && inside(f.path, path)).sort((a, b) => b.path.length - a.path.length)[0]
  return holder ? { workspaceId: holder.id, sector: holder.sector } : { workspaceId: tab, sector: null }
}

export async function fileFacts(ctx: WorkCtx, asked: Asked, jobs: Jobs): Promise<FileFacts> {
  const history = WORK_MODULES.find((m) => m.id === 'history')
  if (!history?.handle) throw new Error('Document history is not running on this host')
  const since = Math.min(asked.before.from, asked.from)
  const docs = new Map<string, { source: CanvasSource; workspaceId: string; at: number }>()
  for (const j of jobs.list) {
    for (const item of ctx.canvas.forWorkspace(j.workspaceId, { panes: true })) {
      if (item.kind !== 'document' || item.updatedAt < since || !kept(item.source)) continue
      const key = JSON.stringify(item.source)
      const have = docs.get(key)
      if (!have || have.at < item.updatedAt) docs.set(key, { source: item.source, workspaceId: j.workspaceId, at: item.updatedAt })
    }
  }
  // Every Work workspace's folder, the thread tool's narrowed jobs or not: a file in another job's folder is that job's.
  const folders = (ctx.db.prepare(`SELECT id, path, sector FROM workspaces WHERE kind = 'work'`).all() as { id: string; path: string | null; sector: string | null }[]).map((r) => ({ id: r.id, path: r.path ?? '', sector: r.sector || null }))
  const out: FileFacts = { points: [], before: [], part: docs.size > DOCS_MOST }
  let failed = 0
  const picked = [...docs.values()].sort((a, b) => b.at - a.at).slice(0, DOCS_MOST)
  for (const doc of picked) {
    stopped(asked.signal)
    try {
      const own = await ownerOf(ctx, doc.source, doc.workspaceId, folders)
      // One of a job with no workspace on this host (or, for a thread's tool, not its own job) is not counted here.
      const job = jobIndex(jobs, own.workspaceId, own.sector)
      if (job === null) {
        await breathe()
        continue
      }
      const answer = await history.handle({ id: 'review', method: 'work.history.versions', params: { source: doc.source } } as never, ctx, HOST, asked.signal)
      if (!answer.handled) throw new Error('not taken')
      for (const v of (answer.result as HistoryVersions).versions) {
        if (!v.by.some(isHim)) continue
        if (v.at >= asked.from && v.at < asked.to) out.points.push([v.at, job, 'edited'])
        else if (v.at >= asked.before.from && v.at < asked.before.to) out.before.push([v.at, job, 'edited'])
      }
    } catch {
      // One document that cannot be read (moved, on another host) costs its own edits, not the rest; the page says
      // edits may be short, so no comparison or "nothing" stands on the gap.
      failed++
    }
    await breathe()
  }
  // Every document failing is the history service being down, which the page should say.
  if (picked.length > 0 && failed === picked.length) throw new Error('Document history did not answer')
  if (failed > 0) out.part = true
  return out
}
