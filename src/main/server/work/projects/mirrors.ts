import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import { workspaceKindOf } from '@shared/work'
import type { WorkPartDeps } from '../ctx'
import type { WorkCtx } from '../modules'
import { BUSY } from '../routines/host'

/**
 * A Work workspace's mirrors: the TempCode projects that hold its threads
 * about one LifeOS project each (docs/agents/work.md "Mirrors follow
 * LifeOS"). LifeOS owns the project: its name, its state and whether it
 * exists. A mirror is made from LifeOS's own row, never from what a client
 * says, and from then on follows a live `projects:list` of the workspace's
 * sector: a rename there renames it; a project that is done, dropped,
 * deleted or moved to another sector has its mirror archived, which only
 * hides its card and stops no thread, and only once none of its threads
 * works; a project that comes back brings its mirror back.
 */

/** A LifeOS project as `projects:list` answers it: what a mirror follows. */
export interface LifeosProject {
  _id: string
  name: string
  status: string
}

/** The states LifeOS calls finished: such a project's card leaves the column. */
const FINAL = new Set(['done', 'dropped'])

export interface MirrorMoves {
  rename: { id: string; name: string }[]
  archive: string[]
  restore: string[]
}

/**
 * What one sector's list asks of its workspace's mirrors. `busy` says
 * whether a mirror still has a thread that works or waits to: such a mirror
 * is never archived, so nothing is hidden from under a running thread.
 */
export function mirrorMoves(rows: readonly LifeosProject[], mirrors: readonly ProjectMeta[], busy: (projectId: string) => boolean): MirrorMoves {
  const byId = new Map(rows.map((row) => [row._id, row]))
  const moves: MirrorMoves = { rename: [], archive: [], restore: [] }
  for (const mirror of mirrors) {
    if (!mirror.lifeosProjectId) continue
    const row = byId.get(mirror.lifeosProjectId)
    const name = row?.name.trim()
    if (name && name !== mirror.name) moves.rename.push({ id: mirror.id, name })
    const over = !row || FINAL.has(row.status)
    if (over && !mirror.archived && !busy(mirror.id)) moves.archive.push(mirror.id)
    else if (!over && mirror.archived) moves.restore.push(mirror.id)
  }
  return moves
}

/**
 * The project of the workspace's own sector that a mirror holds threads
 * for, asked of LifeOS as the owner. A project of another sector, or none,
 * is refused; so is one that is done or dropped, whose mirror would be
 * archived the moment it was made and its first thread started out of
 * sight: it is reopened first, which is one press on its page.
 */
export async function lifeosProjectIn(
  ctx: Pick<WorkCtx, 'lifeos'>,
  workspace: Pick<WorkspaceMeta, 'name' | 'sector'>,
  lifeosProjectId: string,
  /** `over`: a finished project is answered too, for what is not a thread (linking a document to it) */
  o: { over?: boolean } = {}
): Promise<LifeosProject> {
  const rows = await ctx.lifeos.owner().query<LifeosProject[]>('projects:list', { sector: workspace.sector })
  const row = (rows ?? []).find((p) => p._id === lifeosProjectId)
  if (!row) throw new Error(`LifeOS has no such project in ${workspace.name}'s sector`)
  if (!o.over && FINAL.has(row.status)) throw new Error(`${row.name} is ${row.status}: reopen it to start a thread in it`)
  return row
}

/** The code settings of one project, as the registry reads and clears them. */
export interface CodeSettingsHost {
  workspaces(): WorkspaceMeta[]
  projects(): ProjectMeta[]
  /** Each override the project still holds, with the call that clears it. */
  overrides(project: ProjectMeta): { held: boolean; clear: () => void }[]
}

/**
 * Clears the code settings a Work project was given before the server
 * refused them (workProjectGate.ts): its sheet no longer draws them, so
 * nothing else could. Writes only where something is held, so a second
 * pass tells the catalog nothing. Answers how many projects it cleared.
 */
export function clearCodeSettings(host: CodeSettingsHost): number {
  const work = new Set(
    host
      .workspaces()
      .filter((w) => workspaceKindOf(w) === 'work')
      .map((w) => w.id)
  )
  let cleared = 0
  for (const project of host.projects()) {
    if (!work.has(project.workspaceId)) continue
    const held = host.overrides(project).filter((o) => o.held)
    for (const override of held) override.clear()
    if (held.length) cleared++
  }
  return cleared
}

/** What the follower asks of the host: the registry's own methods, narrowed so a test can stand in. */
export interface MirrorHost {
  workspaces(): WorkspaceMeta[]
  projects(): ProjectMeta[]
  /** Whether a thread of the project works or waits to. */
  busy(projectId: string): boolean
  rename(projectId: string, name: string): void
  archive(projectId: string, archived: boolean): Promise<void>
  onCatalog(fn: (kind: 'workspaces' | 'projects') => void): () => void
  onMeta(fn: (session: SessionMeta) => void): () => void
}

/**
 * Keeps every linked Work workspace's mirrors in step with LifeOS while it
 * runs; the return stops it. One live list a workspace, kept by the host's
 * own LifeOS session, which takes it up again after a reconnect. Nothing
 * moves until a list has answered: a host that cannot reach LifeOS leaves
 * its mirrors as they are.
 */
export function followMirrors(ctx: Pick<WorkCtx, 'lifeos' | 'log'>, host: MirrorHost): () => void {
  const watches = new Map<string, { sector: string; stop: () => void }>()
  const lists = new Map<string, readonly LifeosProject[]>()
  /** Each thread's last known busy-ness: only a thread coming to rest can free a mirror to be archived. */
  const wasBusy = new Map<string, boolean>()
  let settling = false
  let stopped = false

  const settle = (workspaceId: string): void => {
    const rows = lists.get(workspaceId)
    if (!rows || stopped) return
    const mirrors = host.projects().filter((p) => p.workspaceId === workspaceId && !!p.lifeosProjectId)
    const moves = mirrorMoves(rows, mirrors, host.busy)
    if (!moves.rename.length && !moves.archive.length && !moves.restore.length) return
    // Each move tells the catalog, which asks to settle again: once, after these.
    settling = true
    try {
      for (const { id, name } of moves.rename) host.rename(id, name)
      for (const id of moves.archive) void host.archive(id, true).catch((err) => ctx.log(`projects: a mirror was not archived: ${err instanceof Error ? err.message : String(err)}`))
      for (const id of moves.restore) void host.archive(id, false).catch((err) => ctx.log(`projects: a mirror was not brought back: ${err instanceof Error ? err.message : String(err)}`))
    } finally {
      settling = false
    }
  }

  const watch = (): void => {
    const linked = new Map(
      host
        .workspaces()
        .filter((w) => workspaceKindOf(w) === 'work' && !!w.sector)
        .map((w) => [w.id, w.sector!])
    )
    for (const [id, held] of watches) {
      if (linked.get(id) === held.sector) continue
      held.stop()
      watches.delete(id)
      lists.delete(id)
    }
    for (const [id, sector] of linked) {
      if (watches.has(id)) continue
      const stop = ctx.lifeos.subscribe<LifeosProject[]>('projects:list', { sector }, (rows) => {
        // A list that is not one (a fault's shape) moves nothing.
        if (!Array.isArray(rows)) return
        lists.set(id, rows)
        settle(id)
      })
      watches.set(id, { sector, stop })
    }
  }

  watch()
  const offCatalog = host.onCatalog((kind) => {
    if (kind === 'workspaces') watch()
    // A mirror just made (its name may already be stale), or a move of our own that is still landing.
    else if (!settling) for (const id of watches.keys()) settle(id)
  })
  const offMeta = host.onMeta((session) => {
    const busy = BUSY.has(session.status)
    if (wasBusy.get(session.id) === busy) return
    wasBusy.set(session.id, busy)
    if (busy || !session.projectId) return
    const project = host.projects().find((p) => p.id === session.projectId)
    if (project?.lifeosProjectId) settle(project.workspaceId)
  })

  return () => {
    stopped = true
    offCatalog()
    offMeta()
    for (const held of watches.values()) held.stop()
    watches.clear()
    lists.clear()
    wasBusy.clear()
  }
}

/** The follower on the host's own registry, running while Work is on. Called once from `buildWorkCtx`. */
export function mirrorsPart(ctx: WorkCtx, deps: WorkPartDeps): void {
  const { registry } = deps
  deps.whileOn(() => {
    // A test's registry is often a few methods of the real one: only the real one is swept.
    if (typeof registry.getProjectTurnPass === 'function') {
      try {
        const cleared = clearCodeSettings({
          workspaces: () => registry.listWorkspaces(),
          projects: () => registry.listProjects(),
          overrides: (p) => [
            { held: registry.getProjectTurnPass(p.id) !== null, clear: () => registry.setProjectTurnPass(p.id, null) },
            { held: registry.getProjectBuild(p.id) !== null, clear: () => registry.setProjectBuild(p.id, null) },
            { held: registry.getReviewSettings(p.id) !== null, clear: () => registry.setReviewSettings(p.id, null) },
            { held: registry.getPlanSettings(p.id) !== null, clear: () => registry.setPlanSettings(p.id, null) },
            { held: p.startOn != null, clear: () => registry.setProjectStartOn(p.id, null) }
          ]
        })
        if (cleared) ctx.log(`projects: cleared the code settings of ${cleared} Work project${cleared === 1 ? '' : 's'}`)
      } catch (err) {
        ctx.log(`projects: the code settings of Work projects were not cleared: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return followMirrors(ctx, {
      // Each asked for only if the registry has it: a test's registry is often a few methods of the real one.
      workspaces: () => registry.listWorkspaces?.() ?? [],
      projects: () => registry.listProjects?.() ?? [],
      busy: (projectId) => (registry.listRaw?.({ projectId, archived: undefined }) ?? []).some((s) => BUSY.has(s.status)),
      rename: (projectId, name) => registry.renameProject(projectId, name),
      archive: (projectId, archived) => registry.archiveProject(projectId, archived),
      onCatalog: (fn) => registry.onCatalog?.(fn) ?? (() => {}),
      onMeta: (fn) => registry.onMeta?.((session) => fn(session)) ?? (() => {})
    })
  })
}
