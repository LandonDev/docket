import type { SessionMeta } from '@shared/events'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import { errorText } from '@shared/work/ids'
import { byPressing, byTarget, OPEN_PROJECT_STATES, type OpenProjectState, type TrackerJob, type TrackerOverview, type TrackerProject, type TrackerThread } from '@shared/work/tracker'
import type { WorkCtx } from '../modules'

/**
 * `work.projects.overview` (docs/agents/work-tracker.md): this host's jobs for the tracker. Per Work workspace linked
 * to a sector, LifeOS is asked twice, `projects:list` and `projects:facts`, both for that sector and at once; the
 * mirrors and their root threads are this host's own rows, and each thread's outcome is the one its summary already
 * carries (`workOutcome`, work/threads/record.ts). Nothing is read per project or per thread. A job LifeOS did not
 * answer for says why and lists nothing; the other jobs still answer.
 */

/** A LifeOS project row as the tracker reads it. */
export interface ListedProject {
  _id: string
  name: string
  status: string
  targetDate?: number | null
}

/** One open project's facts, as `projects:facts` answers them. */
export interface ProjectFacts {
  projectId: string
  next: { taskId: string; key: string; title: string; due?: number } | null
  late: number
  dueToday: number
  waiting: { taskId: string; name: string; since: number } | null
  done: number
  total: number
}

const OPEN = new Set<string>(OPEN_PROJECT_STATES)

/** One job's rows from its two LifeOS answers and this host's mirrors and threads: pure, so a test hands it rows. */
export function jobRows(listed: readonly ListedProject[], facts: readonly ProjectFacts[], mirrors: readonly Pick<ProjectMeta, 'id' | 'lifeosProjectId'>[], threadsOf: (mirrorId: string) => TrackerThread[]): TrackerProject[] {
  const factsOf = new Map(facts.map((f) => [f.projectId, f]))
  const mirrorOf = new Map(mirrors.flatMap((m) => (m.lifeosProjectId ? [[m.lifeosProjectId, m.id] as const] : [])))
  return listed
    .filter((p) => OPEN.has(p.status))
    .map((p): TrackerProject => {
      const f = factsOf.get(p._id)
      const mirrorId = mirrorOf.get(p._id) ?? null
      const threads = mirrorId ? [...threadsOf(mirrorId)].sort(byPressing) : []
      return {
        id: p._id,
        name: p.name,
        state: p.status as OpenProjectState,
        targetDate: p.targetDate ?? null,
        next: f?.next ?? null,
        late: f?.late ?? 0,
        dueToday: f?.dueToday ?? 0,
        waiting: f?.waiting ?? null,
        done: f?.done ?? 0,
        total: f?.total ?? 0,
        mirrorId,
        threads: threads.length,
        lead: threads[0] ?? null
      }
    })
    .sort(byTarget)
}

/** What the overview asks of the host's registry. */
export interface OverviewRegistry {
  listWorkspaces(): WorkspaceMeta[]
  listProjects(): ProjectMeta[]
  listRaw(opts: { archived?: boolean; projectId?: string }): SessionMeta[]
  /** the decorated meta, whose `workOutcome` the record keeper folded in */
  get(id: string): SessionMeta | null
}

/** A project mirror's Work root threads on this host, not archived: whose writes its page's Files lists. */
export function mirrorRoots(registry: Pick<OverviewRegistry, 'listRaw'>, mirrorId: string): string[] {
  return registry.listRaw({ archived: false, projectId: mirrorId }).flatMap((s) => (!s.parentId && s.projectId === mirrorId && s.scope === 'work' ? [s.id] : []))
}

/** This host's jobs, or the ones named (a window asks only for the jobs it shows), for the tracker. */
export async function projectsOverview(ctx: Pick<WorkCtx, 'lifeos' | 'log'>, registry: OverviewRegistry, workspaceIds?: readonly string[]): Promise<TrackerOverview> {
  const wanted = workspaceIds ? new Set(workspaceIds) : null
  const jobs = registry.listWorkspaces().filter((w) => w.kind === 'work' && !!w.sector && (!wanted || wanted.has(w.id)))
  const mirrors = registry.listProjects().filter((p) => !p.archived && !!p.lifeosProjectId)
  // Every root thread of a mirror, once: a subagent's work is its root's.
  const rootsBy = new Map<string, TrackerThread[]>()
  const mirrorIds = new Set(mirrors.map((m) => m.id))
  for (const raw of registry.listRaw({ archived: false })) {
    if (raw.parentId || !raw.projectId || !mirrorIds.has(raw.projectId) || raw.scope !== 'work') continue
    const meta = registry.get(raw.id) ?? raw
    const updatedAt = (meta as { updatedAt?: number }).updatedAt ?? meta.createdAt
    rootsBy.set(raw.projectId, [...(rootsBy.get(raw.projectId) ?? []), { sessionId: meta.id, title: meta.title, outcome: meta.workOutcome ?? null, updatedAt }])
  }
  const owner = ctx.lifeos.owner()
  const answered = await Promise.all(
    jobs.map(async (w): Promise<TrackerJob> => {
      const job = { workspaceId: w.id, name: w.name, sector: w.sector! }
      try {
        const [listed, facts] = await Promise.all([owner.query<ListedProject[]>('projects:list', { sector: w.sector }), owner.query<ProjectFacts[]>('projects:facts', { sector: w.sector })])
        const own = mirrors.filter((m) => m.workspaceId === w.id)
        return { ...job, projects: jobRows(listed ?? [], facts ?? [], own, (id) => rootsBy.get(id) ?? []) }
      } catch (err) {
        ctx.log(`projects: the tracker did not read ${w.name}'s projects: ${errorText(err)}`)
        return { ...job, projects: [], down: errorText(err) }
      }
    })
  )
  return { jobs: answered }
}
