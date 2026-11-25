import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import { waitsOnHim } from '@shared/work/tracker'
import { jobRows, mirrorFiles, mirrorRoots, projectsOverview, type ListedProject, type OverviewRegistry, type ProjectFacts } from './overview'

/**
 * The tracker's host part: one `projects:list` and one `projects:facts` a job, joined in memory with this host's
 * mirrors and the outcome each root thread's summary already carries.
 */

const DAY = 86_400_000
const ws = (id: string, sector: string, kind: 'work' | 'code' = 'work'): WorkspaceMeta => ({ id, name: `Job ${sector}`, sector, kind, environmentId: 'box' }) as unknown as WorkspaceMeta
const mirror = (id: string, workspaceId: string, lifeosProjectId: string, archived = false): ProjectMeta => ({ id, workspaceId, lifeosProjectId, archived, name: id }) as unknown as ProjectMeta
const thread = (id: string, projectId: string, o: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, projectId, parentId: null, scope: 'work', title: `Thread ${id}`, createdAt: 1, updatedAt: 1, archived: false, ...o }) as unknown as SessionMeta

const LISTED: Record<string, ListedProject[]> = {
  purdue: [
    { _id: 'lan', name: 'Spring LAN', status: 'active', targetDate: 30 * DAY },
    { _id: 'gear', name: 'Arena lighting', status: 'paused' },
    { _id: 'tryouts', name: 'Tryouts', status: 'active', targetDate: 10 * DAY },
    { _id: 'old', name: 'Fall LAN', status: 'done', targetDate: 1 * DAY }
  ],
  cosmic: [{ _id: 'rel', name: 'Release 4.2', status: 'backlog' }]
}
const FACTS: Record<string, ProjectFacts[]> = {
  purdue: [
    { projectId: 'lan', next: { taskId: 't1', key: 'PUR-4', title: 'Count the patch cables', due: 2 * DAY }, late: 1, dueToday: 0, waiting: { taskId: 't2', name: 'Sam Ortiz', since: 0 }, done: 2, total: 7 },
    { projectId: 'tryouts', next: null, late: 0, dueToday: 0, waiting: null, done: 0, total: 0 }
  ],
  cosmic: []
}

function rig(o: { down?: string } = {}) {
  const asked: { name: string; args: unknown }[] = []
  const metas = [
    thread('t-held', 'm-lan', { updatedAt: 5, workOutcome: { words: '1 mail to send', tone: 'held' } }),
    thread('t-live', 'm-lan', { updatedAt: 9, workOutcome: { words: 'Working', tone: 'working' } }),
    thread('t-child', 'm-lan', { parentId: 't-live', workOutcome: { words: 'Asks you', tone: 'asks' } }),
    thread('t-code', 'm-lan', { scope: undefined }),
    thread('t-old', 'm-old'),
    thread('t-shelved', 'm-lan', { archived: true, title: 'Seat map for 64' })
  ]
  const registry: OverviewRegistry = {
    listWorkspaces: () => [ws('w-purdue', 'purdue'), ws('w-cosmic', 'cosmic'), ws('w-code', '', 'code')],
    listProjects: () => [mirror('m-lan', 'w-purdue', 'lan'), mirror('m-old', 'w-purdue', 'old', true)],
    listRaw: (opts) => metas.filter((m) => opts.archived === undefined || m.archived === opts.archived),
    get: (id) => metas.find((m) => m.id === id) ?? null
  }
  const ctx = {
    log: () => {},
    lifeos: {
      owner: () => ({
        query: async <T>(name: string, args: { sector: string }): Promise<T> => {
          asked.push({ name, args })
          if (o.down && args.sector === o.down) throw new Error('LifeOS did not answer')
          return (name === 'projects:list' ? LISTED[args.sector] : FACTS[args.sector]) as T
        }
      })
    }
  } as never
  return { ctx, registry, asked }
}

describe('the tracker overview', () => {
  it('lists every open project of each job by target date, no target last, with its facts and its most pressing thread', async () => {
    const { ctx, registry, asked } = rig()
    const { jobs } = await projectsOverview(ctx, registry)
    expect(jobs.map((j) => [j.workspaceId, j.projects.map((p) => p.id)])).toEqual([
      ['w-purdue', ['tryouts', 'lan', 'gear']],
      ['w-cosmic', ['rel']]
    ])
    const lan = jobs[0]!.projects[1]!
    expect(lan).toMatchObject({ name: 'Spring LAN', state: 'active', targetDate: 30 * DAY, late: 1, done: 2, total: 7, mirrorId: 'm-lan', threads: 2 })
    expect(lan.next).toEqual({ taskId: 't1', key: 'PUR-4', title: 'Count the patch cables', due: 2 * DAY })
    expect(lan.waiting).toEqual({ taskId: 't2', name: 'Sam Ortiz', since: 0 })
    // A held act outranks live work; a subagent and a code thread are not the project's threads.
    expect(lan.lead).toEqual({ sessionId: 't-held', title: 'Thread t-held', outcome: { words: '1 mail to send', tone: 'held' }, updatedAt: 5 })
    // A project LifeOS gave no facts for, and one with no mirror yet.
    expect(jobs[0]!.projects[2]).toMatchObject({ id: 'gear', targetDate: null, next: null, done: 0, total: 0, mirrorId: null, threads: 0, lead: null })
    // Two reads a job, never one a project; a code workspace is not asked about.
    expect(asked.map((a) => a.name).sort()).toEqual(['projects:facts', 'projects:facts', 'projects:list', 'projects:list'])
  })

  it('a job LifeOS did not answer for says why and lists nothing; the other job still answers', async () => {
    const { ctx, registry } = rig({ down: 'purdue' })
    const { jobs } = await projectsOverview(ctx, registry)
    expect(jobs[0]).toEqual({ workspaceId: 'w-purdue', name: 'Job purdue', sector: 'purdue', projects: [], down: 'LifeOS did not answer' })
    expect(jobs[1]!.projects.map((p) => p.id)).toEqual(['rel'])
  })

  it('asks only for the jobs named', async () => {
    const { ctx, registry, asked } = rig()
    const { jobs } = await projectsOverview(ctx, registry, ['w-cosmic'])
    expect(jobs.map((j) => j.workspaceId)).toEqual(['w-cosmic'])
    expect(asked.every((a) => (a.args as { sector: string }).sector === 'cosmic')).toBe(true)
  })

  it('"Waiting on you" keeps a held, asking or failed thread, a late task or one due today', () => {
    const rows = jobRows(LISTED.purdue!, FACTS.purdue!, [mirror('m-lan', 'w', 'lan')], () => [])
    expect(rows.filter(waitsOnHim).map((p) => p.id)).toEqual(['lan'])
    const quiet = { lead: null, late: 0, dueToday: 0 }
    expect(waitsOnHim(quiet)).toBe(false)
    expect(waitsOnHim({ ...quiet, dueToday: 1 })).toBe(true)
    expect(waitsOnHim({ ...quiet, lead: { sessionId: 's', title: 't', updatedAt: 1, outcome: { words: '1 mail to send', tone: 'held' } } })).toBe(true)
    expect(waitsOnHim({ ...quiet, lead: { sessionId: 's', title: 't', updatedAt: 1, outcome: { words: 'Working', tone: 'working' } } })).toBe(false)
  })
})

describe('a mirror’s root threads', () => {
  it('lists the Work roots filed in the mirror, never a subagent or a code thread', () => {
    const { registry } = rig()
    expect(mirrorRoots(registry, 'm-lan').map((r) => r.id)).toEqual(['t-held', 't-live', 't-shelved'])
    expect(mirrorRoots(registry, 'm-none')).toEqual([])
  })

  it('Files keeps what an archived root made, named by its title, which the window may not hold', () => {
    const { registry } = rig()
    const asked: string[][] = []
    const made = (rootId: string) => ({ id: `r-${rootId}`, sessionId: rootId, rootId, key: `files:${rootId}`, kind: 'file.make', verb: 'Made', name: `${rootId}.xlsx`, summary: '', at: 1, undone: false, open: null })
    const files = mirrorFiles(registry, (roots) => (asked.push([...roots]), roots.map(made)), 'm-lan')
    expect(asked).toEqual([['t-held', 't-live', 't-shelved']])
    expect(files.find((f) => f.rootId === 't-shelved')?.rootTitle).toBe('Seat map for 64')
  })
})
