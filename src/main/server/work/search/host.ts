import type { SessionSearchHit } from '@shared/contract-m3a'
import type { SessionMeta } from '@shared/events'
import { sessionScopeOf } from '@shared/work/ids'
import type { WorkPartDeps } from '../ctx'

/**
 * What Work search needs of the host that `WorkCtx` does not carry
 * (docs/agents/work-search.md "Threads"): the Work threads' rows, and the
 * thread index every host already keeps. `searchHostPart` is called once
 * from `buildWorkCtx` with the host's handles; a test hands the sources its
 * own `SearchHost`.
 */

/** A Work thread as search reads it. */
export interface WorkThread {
  id: string
  title: string
  /** its job: the workspace its row or its project names; null: Work Chats */
  workspaceId: string | null
  updatedAt: number
  archived: boolean
  /** a subagent's row: found by its words, never listed by its title */
  child: boolean
}

export interface SearchHost {
  /** The live Work threads, newest first; `archived` the archived ones alone. Never a code thread. */
  threads(archived?: boolean): WorkThread[]
  /** One Work thread by id; null for a code thread or an unknown id. */
  thread(id: string): WorkThread | null
  /** The transcript index and the threads' notes, held to Work threads and to `within` (the threads in reach), one row a thread: best first. */
  words(query: string, limit: number, within: readonly string[]): Promise<SessionSearchHit[]>
}

/** What the host part is made from: a test passes its own store and rows. */
export interface SearchHostDeps {
  /** The host's Work rows, live or archived: the registry's own scope filter, so a code row is never read or sorted. */
  sessions(archived: boolean): SessionMeta[]
  session(id: string): SessionMeta | null
  workspaceOfProject(projectId: string): string | null
  searchEvents(o: { query: string; limit: number; scope: 'work'; perThread: true; sessionIds: readonly string[] }): Promise<{ hits: SessionSearchHit[] }>
}

export function makeSearchHost(deps: SearchHostDeps): SearchHost {
  const threadOf = (s: SessionMeta): WorkThread => ({
    id: s.id,
    title: s.title,
    workspaceId: (s.projectId ? deps.workspaceOfProject(s.projectId) : null) ?? s.workspaceId ?? null,
    updatedAt: (s as { updatedAt?: number }).updatedAt ?? (s as { createdAt?: number }).createdAt ?? 0,
    archived: s.archived,
    child: !!s.parentId
  })
  return {
    threads: (archived = false) =>
      deps
        .sessions(archived)
        .filter((s) => sessionScopeOf(s) === 'work')
        .map(threadOf)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    thread(id) {
      const s = deps.session(id)
      return s && sessionScopeOf(s) === 'work' ? threadOf(s) : null
    },
    // One row a Work thread, its best, among the threads in reach: the index ranks rows and knows no job, and neither
    // one long thread nor another job's many threads may fill the read.
    words: async (query, limit, within) => (within.length ? (await deps.searchEvents({ query, limit, scope: 'work', perThread: true, sessionIds: within })).hits : [])
  }
}

let current: SearchHost | null = null

/** The host's handles as the thread sources read them; null before boot. */
export const searchHost = (): SearchHost | null => current
/** A test's own host; null puts back none. */
export const setSearchHost = (host: SearchHost | null): void => void (current = host)

export function searchHostPart(deps: WorkPartDeps): void {
  const { registry, store } = deps
  current = makeSearchHost({
    // Archived threads are their own read: Work Search finds them, marked, only where it needs them (sources/threads.ts).
    sessions: (archived) => registry.listRaw({ archived, scope: 'work' }),
    session: (id) => registry.get(id),
    workspaceOfProject: (id) => registry.getProject(id)?.workspaceId ?? null,
    searchEvents: (o) => store.searchEvents(o)
  })
}
