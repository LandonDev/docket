/**
 * What a guest's link shows of a project (docs/agents/work-guests.md "A
 * project's link"): LifeOS's `projects:guestView`, the one place the cut is
 * made, read back key by key. Main passes nothing on that this does not
 * name, so a field LifeOS adds later (whom a task waits on, where it came
 * from) never reaches the Work service or the guest's page by default.
 * Pure: main, the service and the page all read it.
 */

export type GuestTaskState = 'todo' | 'doing' | 'waiting' | 'done'

export interface GuestProjection {
  project: { id: string; name: string; status: 'backlog' | 'active' | 'paused' | 'done' | 'dropped'; description: string; docId: string | null }
  counts: { todo: number; doing: number; waiting: number; done: number }
  tasks: {
    id: string
    key: string | null
    parentId: string | null
    rank: string | null
    title: string
    status: GuestTaskState
    priority: 'high' | 'low' | null
    dueAt: number | null
    notes: string
  }[]
  truncated: boolean
  docs: { id: string; title: string }[]
  sheets: { id: string; title: string }[]
}

/** Every key a projection may hold, by where it sits: the test of the cut reads these. */
export const GUEST_PROJECTION_KEYS = {
  top: ['project', 'counts', 'tasks', 'truncated', 'docs', 'sheets'],
  project: ['id', 'name', 'status', 'description', 'docId'],
  counts: ['todo', 'doing', 'waiting', 'done'],
  task: ['id', 'key', 'parentId', 'rank', 'title', 'status', 'priority', 'dueAt', 'notes'],
  item: ['id', 'title']
} as const

const STATES = new Set(['backlog', 'active', 'paused', 'done', 'dropped'])
const TASK_STATES = new Set(['todo', 'doing', 'waiting', 'done'])
const ID = /^[A-Za-z0-9]{1,64}$/

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const textOrNull = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null)

/** The projection as LifeOS answered it, with only the keys above; null for an answer that is not one (a project no longer shared answers null). */
export function guestProjectionOf(raw: unknown): GuestProjection | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { project?: Record<string, unknown>; counts?: Record<string, unknown>; tasks?: unknown; truncated?: unknown; docs?: unknown; sheets?: unknown }
  const id = idOrNull(r.project?.id)
  const status = r.project?.status
  if (!id || typeof status !== 'string' || !STATES.has(status)) return null
  const items = (rows: unknown): { id: string; title: string }[] =>
    (Array.isArray(rows) ? rows : []).flatMap((row: Record<string, unknown> | null) => {
      const itemId = idOrNull(row?.id)
      return itemId ? [{ id: itemId, title: text(row?.title, 500) }] : []
    })
  return {
    project: { id, name: text(r.project?.name, 500), status: status as GuestProjection['project']['status'], description: text(r.project?.description, 20_000), docId: idOrNull(r.project?.docId) },
    counts: { todo: count(r.counts?.todo), doing: count(r.counts?.doing), waiting: count(r.counts?.waiting), done: count(r.counts?.done) },
    tasks: (Array.isArray(r.tasks) ? r.tasks : []).flatMap((t: Record<string, unknown> | null) => {
      const taskId = idOrNull(t?.id)
      if (!taskId || typeof t?.status !== 'string' || !TASK_STATES.has(t.status)) return []
      return [
        {
          id: taskId,
          key: textOrNull(t.key, 40),
          parentId: idOrNull(t.parentId),
          rank: textOrNull(t.rank, 200),
          title: text(t.title, 2000),
          status: t.status as GuestTaskState,
          priority: t.priority === 'high' || t.priority === 'low' ? t.priority : null,
          dueAt: typeof t.dueAt === 'number' && Number.isFinite(t.dueAt) ? t.dueAt : null,
          notes: text(t.notes, 50_000)
        }
      ]
    }),
    truncated: r.truncated === true,
    docs: items(r.docs),
    sheets: items(r.sheets)
  }
}

/** A document or sheet a projection lists, the description's document among them: what a guest's child token may be for. */
export function projectionLists(p: GuestProjection, table: 'docs' | 'sheets', id: string): boolean {
  if (table === 'sheets') return p.sheets.some((s) => s.id === id)
  return p.project.docId === id || p.docs.some((d) => d.id === id)
}

/** Every document and sheet of a projection as `docs:<id>` or `sheets:<id>`, the description's document first. */
export function projectionItems(p: GuestProjection): string[] {
  return [...(p.project.docId ? [`docs:${p.project.docId}`] : []), ...p.docs.filter((d) => d.id !== p.project.docId).map((d) => `docs:${d.id}`), ...p.sheets.map((s) => `sheets:${s.id}`)]
}
