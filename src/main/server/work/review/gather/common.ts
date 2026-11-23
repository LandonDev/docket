import type { DatabaseSync } from 'node:sqlite'
import type { SectorKey } from '@shared/work'
import type { ReviewJob, Span } from '@shared/work/review'

/**
 * What every source of the weekly review is asked with (docs/agents/work-review.md "The gather"). Each source is one
 * file here and reads one thing; a source that throws is left out by the caller and named in the body's `left`, so
 * one that is down never takes the page with it.
 */
export type Asked = {
  /** the week, `[from, to)` */
  from: number
  to: number
  tz: string
  now: number
  /** where the week's facts stop: its end, or now while it runs */
  cut: number
  /** the same span of the week before, for the comparison */
  before: Span
  /** a thread's tool reads its own job alone: every other sector is dropped as it is read */
  only?: SectorKey | null
  signal?: AbortSignal
}

export type Jobs = {
  list: ReviewJob[]
  byWorkspace: Map<string, number>
  bySector: Map<SectorKey, number>
}

/** This host's jobs: its Work workspaces, oldest first (the order they were made is the order the rail first drew them). */
export function jobsOf(db: DatabaseSync, only?: { workspaceId: string | null }): Jobs {
  const rows = db.prepare(`SELECT id, name, sector FROM workspaces WHERE kind = 'work' ORDER BY created_at, id`).all() as { id: string; name: string; sector: string | null }[]
  const list: ReviewJob[] = rows.filter((r) => !only || r.id === only.workspaceId).map((r) => ({ workspaceId: r.id, sector: r.sector || null, name: r.name }))
  const byWorkspace = new Map<string, number>()
  const bySector = new Map<SectorKey, number>()
  list.forEach((j, i) => {
    byWorkspace.set(j.workspaceId, i)
    if (j.sector && !bySector.has(j.sector)) bySector.set(j.sector, i)
  })
  return { list, byWorkspace, bySector }
}

/** The job of a row that names a workspace, a sector, or both: the workspace first. */
export const jobIndex = (jobs: Jobs, workspaceId: string | null | undefined, sector: SectorKey | null | undefined): number | null =>
  (workspaceId ? jobs.byWorkspace.get(workspaceId) : undefined) ?? (sector ? jobs.bySector.get(sector) : undefined) ?? null

/** Hands the loop back between two pieces of work, so a long read never holds the host. */
export const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export const stopped = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new Error('The review was stopped')
}

const text = (v: unknown, max = 2_000): string => (typeof v === 'string' ? v.slice(0, max) : '')
/** A name for a person on a row: the name they go by, else the address. */
export const personName = (p: { name?: string; address?: string } | null | undefined): string => text(p?.name?.trim() || p?.address || '', 320)
export { text }
