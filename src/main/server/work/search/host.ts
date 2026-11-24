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
  /** Every Work thread that is not archived, newest first. Never a code thread. */
  threads(): WorkThread[]
  /** One Work thread by id; null for a code thread or an unknown id. */
  thread(id: string): WorkThread | null
  /** The transcript index, held to Work threads: best first. */
  words(query: string, limit: number): Promise<SessionSearchHit[]>
}

/** What the host part is made from: a test passes its own store and rows. */
export interface SearchHostDeps {
  sessions(): SessionMeta[]
  session(id: string): SessionMeta | null
  workspaceOfProject(projectId: string): string | null
  searchEvents(o: { query: string; limit: number; scope: 'work'; perThread: true }): Promise<{ hits: SessionSearchHit[] }>
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
    threads: () =>
      deps
        .sessions()
        .filter((s) => sessionScopeOf(s) === 'work' && !s.archived)
        .map(threadOf)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    thread(id) {
      const s = deps.session(id)
      return s && sessionScopeOf(s) === 'work' ? threadOf(s) : null
    },
    // One row a Work thread, its best: the index ranks rows and knows no job, and one long thread must not fill the read.
    words: async (query, limit) => (await deps.searchEvents({ query, limit, scope: 'work', perThread: true })).hits
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
    sessions: () => registry.listRaw({ archived: false }),
    session: (id) => registry.get(id),
    workspaceOfProject: (id) => registry.getProject(id)?.workspaceId ?? null,
    searchEvents: (o) => store.searchEvents(o)
  })
}
