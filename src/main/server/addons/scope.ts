import { visibleRows } from '@shared/addons'
import type { AddonRow, AddonStatus, AddonTool } from '@shared/contract-addons'
import type { ProjectMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'

/**
 * Which add-ons a thread sees (plan section 7): its root's workspace (the
 * project's, else the thread's own), every global row plus that
 * workspace's, a workspace row shadowing the global one of its name.
 *
 * A Work thread (docs/agents/work.md "Scope") sees less: the rows of its own
 * Work workspace, and of the global rows only those the person marked for
 * Work (`addons.for_work`). A Work Chat, which has no workspace, is the scope
 * `WORK_HOME`. So a child of a Work thread reaches no add-on its parent
 * could not, and no Work thread reaches another workspace's rows.
 */

export interface ScopeSessions {
  get(id: string): SessionMeta | null
  getProject(id: string): ProjectMeta | null
}

export interface ScopeStore {
  list(): AddonRow[]
  status(): Record<string, AddonStatus>
  tools(id: string): { tools: AddonTool[] } | null
}

/** What Work tells this file (work/scope.ts): which threads and scopes are Work's, and which global rows are marked for it. */
export interface AddonWorkScope {
  /** A Work thread's scope key (its workspace, or `WORK_HOME`); null for a code thread. */
  scopeOf(session: SessionMeta): string | null
  /** Whether a scope key is a Work workspace or `WORK_HOME`. */
  isWork(workspaceId: string): boolean
  /** Whether a global row is marked for Work. */
  forWork(addonId: string): boolean
}
let work: AddonWorkScope | null = null
/** Set once at boot by Work's scope part. Unset (Work's mount did not come up, a test), a code thread reads by the code rule and a Work thread reads nothing. */
export function configureAddonScope(next: AddonWorkScope | null): void {
  work = next
}

/**
 * The scope of a Work thread on a host where Work's own rule is not there to
 * say which workspace and which marked rows are its: no add-on at all. The
 * row still says it is a Work thread, and that is enough to keep the person's
 * own add-ons from it.
 */
export const WORK_UNSCOPED = '~work-unscoped'

/** A Work thread's scope key, by Work's rule when it is configured, else the closed scope; null for a code thread. */
const workScopeKey = (session: SessionMeta): string | null => (session.scope === 'work' ? (work ? (work.scopeOf(session) ?? WORK_UNSCOPED) : WORK_UNSCOPED) : null)

/** The workspace a thread's add-ons come from: its root's project's, else the root's own. A Work thread, and any thread under one, answers its Work scope instead. */
export function workspaceIdOf(sessions: ScopeSessions, session: SessionMeta): string | null {
  const own = workScopeKey(session)
  if (own) return own
  let root = session
  for (let i = 0; root.parentId && i < 32; i++) {
    const parent = sessions.get(root.parentId)
    if (!parent) break
    // A thread under a Work thread never reads past it, whatever its own row says.
    const above = workScopeKey(parent)
    if (above) return above
    root = parent
  }
  return (root.projectId ? sessions.getProject(root.projectId)?.workspaceId : null) ?? root.workspaceId ?? null
}

/** The visible rows, disabled ones included (a disabled workspace row still shadows its global namesake). In a Work scope a global row shows only when it is marked for Work; in the closed scope nothing shows. */
export const visibleAddons = (store: ScopeStore, workspaceId: string | null): AddonRow[] => {
  if (workspaceId === WORK_UNSCOPED) return []
  const rows = visibleRows(store.list(), workspaceId)
  const marks = work
  return workspaceId !== null && marks?.isWork(workspaceId) ? rows.filter((row) => row.workspaceId !== null || marks.forWork(row.id)) : rows
}

/** Whether the scope holds an enabled add-on: the bridge lists addon_find and addon_call only then. */
export const hasAddons = (store: ScopeStore, workspaceId: string | null): boolean => visibleAddons(store, workspaceId).some((r) => r.enabled)

export interface VisibleTool {
  row: AddonRow
  tool: AddonTool
}

/** Each visible, enabled, ready add-on's tools as this host last listed them. */
export function visibleTools(store: ScopeStore, workspaceId: string | null): VisibleTool[] {
  const status = store.status()
  const out: VisibleTool[] = []
  for (const row of visibleAddons(store, workspaceId)) {
    if (!row.enabled || status[row.id]?.state !== 'ready') continue
    for (const tool of store.tools(row.id)?.tools ?? []) out.push({ row, tool })
  }
  return out
}
