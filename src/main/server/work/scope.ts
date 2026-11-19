import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CATALOG, type ProviderId } from '@shared/catalog'
import type { ProjectMeta, ThreadType, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import { NotBuilt, SectorKeySchema, parseWorkSettings, sessionScopeOf, workspaceKindOf, WORK_HOME, WORK_SETTING_KEY, type CanvasSource, type WorkScope } from '@shared/work'
import { configureAddonScope } from '../addons/scope'
import { workRoot } from '../workRoot'
import type { ScopePart } from './ctx'

/**
 * What a Work thread is (docs/agents/work.md "Scope"). Three things decide
 * it, once, when the row is made (`stampScope`, called by
 * SessionRegistry.create): the workspace is a Work workspace; the create
 * asked for a Work Chat; or **the thread's parent or starter is a Work
 * thread**. The last one is the rule that scope follows the parent: a
 * thread a Work thread spawns or starts is a Work thread of the same
 * workspace, or it is refused. It is never a code thread, which would load
 * the person's own MCP servers and sending keys.
 *
 * Code branches on the row (`session.scope === 'work'`), never on the
 * switch; the switch only decides whether a Work thing can be made.
 */

/** What the rule reads: rows, never a live handle. */
export interface ScopeFacts {
  workspaces(): WorkspaceMeta[]
  project(id: string): ProjectMeta | null
  session(id: string): SessionMeta | null
}

/** A refusal the rule words for the caller (a model reads it as its tool's answer). */
export class WorkRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkRefused'
  }
}

export const WORK_OFF = 'Work is off on this host'
/** A Work thread is a chat, a research thread or a master (a chat with the pin): never a plan or a build. */
export const WORK_THREAD_TYPES: readonly ThreadType[] = ['chat', 'research']

/**
 * The harnesses a Work thread may run on. One is offered only when every
 * path out of the fence is shut for it. Today that is Claude Code alone:
 *
 *  - **Claude Code**: its tools are the app's own, in process, bound to the
 *    thread; every source of MCP servers is cut and shown cut with a planted
 *    server in each (work/fence.proof.test.ts).
 *  - **Codex**: every source is cut and shown cut the same way, and the
 *    driver is fenced (drivers/codex.ts). It is withheld for another reason:
 *    its app tools go through the stdio bridge, which sends
 *    `{ sessionId: SESSION, ...params }`, so a tool call that names a
 *    `sessionId` of its own is answered as that thread (scripts/app-mcp-bridge.mjs).
 *    A Work thread could so act as a code thread. When the bridge binds the
 *    caller, add 'codex' here.
 *  - **Muse Code**: its fence needs an empty app-owned primary root, and
 *    whether a child runtime of Muse's own delegation re-reads a `.mcp.json`
 *    the agent wrote there was not shown. It shares the bridge.
 *  - No other harness has a fence at all.
 */
export const WORK_PROVIDERS: readonly ProviderId[] = ['claude']
export const workProviderRefusal = (provider: ProviderId): string | null =>
  WORK_PROVIDERS.includes(provider)
    ? null
    : `refused: Work threads run on Claude Code only. ${CATALOG[provider]?.label ?? provider} is not offered for Work: it cannot yet be kept inside a Work thread's fence.`

/** The Work switch as the store holds it. */
export const workEnabled = (store: { getSetting(key: string): string | null }): boolean => parseWorkSettings(store.getSetting(WORK_SETTING_KEY)).enabled

/** The workspace a thread belongs to: its project's, else its own; null outside every workspace. */
export function workspaceOfSession(facts: ScopeFacts, session: Pick<SessionMeta, 'projectId' | 'workspaceId'>): WorkspaceMeta | null {
  const id = (session.projectId ? facts.project(session.projectId)?.workspaceId : null) ?? session.workspaceId ?? null
  return id ? (facts.workspaces().find((w) => w.id === id) ?? null) : null
}

/**
 * A Work thread's scope from its row, or null for a code thread. The row
 * was stamped at create, so nothing here walks to a parent: a child carries
 * its parent's workspace itself.
 */
export function workScopeOf(facts: ScopeFacts, session: SessionMeta | null | undefined, here: { host: string; away(): boolean }): WorkScope | null {
  if (!session || sessionScopeOf(session) !== 'work') return null
  const home = workHomeOfSession(facts, session)
  const workspace = typeof home === 'string' ? null : home
  return {
    sessionId: session.id,
    workspaceId: workspace?.id ?? null,
    sector: workspace?.sector ?? null,
    host: here.host,
    away: here.away(),
    routineRunId: session.routineRunId ?? null,
    shared: sharedBySource
  }
}

/**
 * Whether other people can see an item, as far as its source alone says: a
 * file that lives in Microsoft or Google is shared. A LifeOS document or
 * sheet, and a file with a guest link, are known to their pillars only
 * (docs, sheets, guests); until those land this answers false for them.
 */
export function sharedBySource(source: CanvasSource): boolean {
  return source.at === 'microsoft' || source.at === 'google'
}

/** Whether two threads share a scope: both code threads, or Work threads of one workspace (two Work Chats count as one). */
export function sameScope(facts: ScopeFacts, a: SessionMeta, b: SessionMeta): boolean {
  const work = sessionScopeOf(a) === 'work'
  if (work !== (sessionScopeOf(b) === 'work')) return false
  if (!work) return true
  const [x, y] = [workHomeOfSession(facts, a), workHomeOfSession(facts, b)]
  // A thread with no Work home shares a scope with nothing, itself included.
  if (x === 'orphan' || y === 'orphan') return false
  return x === 'chat' || y === 'chat' ? x === y : x.id === y.id
}

/** Whether `other` is inside `caller`'s fence: a Work thread reaches only threads of its own scope; a code thread is not fenced here. */
export const withinFence = (facts: ScopeFacts, caller: SessionMeta, other: SessionMeta): boolean => sessionScopeOf(caller) !== 'work' || sameScope(facts, caller, other)

/** Why a Work thread may not reach `other`, in the words a model reads. */
export const OUTSIDE_FENCE = "is outside this Work thread's workspace; a Work thread reaches only the threads of its own workspace"

/** The rows the rule reads, from a registry. */
export const scopeFactsOf = (registry: { listWorkspaces(): WorkspaceMeta[]; getProject(id: string): ProjectMeta | null; get(id: string): SessionMeta | null | undefined }): ScopeFacts => ({
  workspaces: () => registry.listWorkspaces(),
  project: (id) => registry.getProject(id),
  session: (id) => registry.get(id) ?? null
})

/**
 * A Work thread whose row names a workspace that is not a Work workspace: a
 * move landed it there, or the workspace was remade. It keeps its fence and
 * loses its job: no workspace's add-ons, no sector, only the global add-ons
 * marked for Work.
 */
export const WORK_ORPHAN = '~work-orphan'

/** The Work workspace a Work thread belongs to: `chat` for a Work Chat, `orphan` when its row names a workspace that is not Work's. */
export function workHomeOfSession(facts: ScopeFacts, session: Pick<SessionMeta, 'projectId' | 'workspaceId'>): WorkspaceMeta | 'chat' | 'orphan' {
  const workspace = workspaceOfSession(facts, session)
  if (!workspace) return session.projectId || session.workspaceId ? 'orphan' : 'chat'
  return workspaceKindOf(workspace) === 'work' ? workspace : 'orphan'
}

/** The add-on scope key of a thread: its Work workspace, `WORK_HOME` for a Work Chat, `WORK_ORPHAN` for one with no Work home; null for a code thread (addons/scope.ts). */
export function workAddonScope(facts: ScopeFacts, session: SessionMeta): string | null {
  if (sessionScopeOf(session) !== 'work') return null
  const home = workHomeOfSession(facts, session)
  return home === 'chat' ? WORK_HOME : home === 'orphan' ? WORK_ORPHAN : home.id
}

/** A thread's Work workspace as another host can match it (contract-crosshost.ts `WorkHome`); all null for a Work Chat. */
export const workHomeOf = (workspace: WorkspaceMeta | null): { sector: string | null; workspaceLinkId: string | null; workspaceName: string | null; workspacePath: string | null } => ({
  sector: workspace?.sector ?? null,
  workspaceLinkId: workspace?.linkId ?? null,
  workspaceName: workspace?.name ?? null,
  workspacePath: workspace?.path ?? null
})

export interface StampInput {
  /** What the create asked for. */
  asked: {
    scope?: 'code' | 'work'
    parentId?: string | null
    startedBy?: string | null
    threadType?: ThreadType | null
    /** The create named this workspace itself (not one the registry found by the cwd). */
    workspaceId?: string | null
  }
  /** The project the create names, resolved. */
  project: ProjectMeta | null
  /** The workspace the create names or the registry found by its cwd, when it names no project. */
  workspace: WorkspaceMeta | null
  /** The Work switch. */
  enabled: boolean
}

export interface Stamp {
  scope: 'work'
  /** The Work workspace the thread belongs to; null: a Work Chat. A thread with no project carries it as its own `workspaceId`. */
  workspace: WorkspaceMeta | null
  /** The Work thread this one comes from, when one made it. */
  from: SessionMeta | null
}

/**
 * The scope a new thread is stamped with: a `Stamp` for a Work thread, null
 * for a code thread, or a `WorkRefused` when the create would take a Work
 * thread's child out of its workspace, would make a Work thing while the
 * switch is off, or asks for a kind of thread Work has none of.
 */
export function stampScope(facts: ScopeFacts, input: StampInput): Stamp | null {
  const { asked, project } = input
  const work = (id: string | null | undefined): SessionMeta | null => {
    const s = id ? facts.session(id) : null
    return s && sessionScopeOf(s) === 'work' ? s : null
  }
  const from = work(asked.parentId) ?? work(asked.startedBy)
  const named = project ? (facts.workspaces().find((w) => w.id === project.workspaceId) ?? null) : input.workspace
  let workspace: WorkspaceMeta | null
  if (from) {
    const home = workHomeOfSession(facts, from)
    if (home === 'orphan') throw new WorkRefused('refused: this Work thread has no Work workspace on this host, so it starts no threads.')
    const own = home === 'chat' ? null : home
    const where = own ? `its own workspace (${own.name})` : 'Work Chats, outside every workspace'
    if (project && project.workspaceId !== own?.id) throw new WorkRefused(`refused: a Work thread starts threads only in ${where}; project "${project.name}" is outside it.`)
    if (!project && asked.workspaceId && asked.workspaceId !== own?.id) throw new WorkRefused(`refused: a Work thread starts threads only in ${where}.`)
    if (asked.scope === 'code') throw new WorkRefused('refused: a thread a Work thread starts is a Work thread.')
    workspace = own
  } else if (named && workspaceKindOf(named) === 'work') {
    if (asked.scope === 'code') throw new WorkRefused(`refused: ${named.name} is a Work workspace; its threads are Work threads.`)
    workspace = named
  } else if (asked.scope === 'work') {
    if (project || asked.workspaceId) throw new WorkRefused(`refused: ${named?.name ?? 'that workspace'} is not a Work workspace. A Work thread lives in a Work workspace or in Work Chats.`)
    workspace = null
  } else return null
  if (!input.enabled) throw new WorkRefused(WORK_OFF)
  // A subagent has no type of its own; a root is a chat or a research thread.
  if (!asked.parentId && !(asked.threadType && WORK_THREAD_TYPES.includes(asked.threadType)))
    throw new WorkRefused(`refused: a Work thread is a chat or a research thread, not ${asked.threadType ? `"${asked.threadType}"` : 'an untyped one'}.`)
  return { scope: 'work', workspace, from }
}

/** A folder name from a workspace's name: no separators, no dots at the ends, never empty. */
export function workFolderName(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim()
  return clean || 'Work'
}

/** Where the app keeps Work folders on this host: `<work root>/Work`. A workspace is a folder under it, and Work Chats run in `Chats`. */
export const workFoldersRoot = (store: { getSetting(key: string): string | null }): string => join(workRoot(store).root, 'Work')
export const WORK_CHATS_FOLDER = 'Chats'

let desktops: ((session: SessionMeta) => readonly string[]) | null = null
/**
 * Whether a thread may use another host's desktop: the Mac bridge's tools,
 * and computer use carried to a Mac. A code thread always may (its bridge
 * setting decides, as before). A Work thread may only when its workspace's
 * Work settings name that host ("May use this Mac"); a Work Chat, which has
 * no workspace to be given one, never.
 */
export function mayUseFarDesktop(session: SessionMeta, host: string | null): boolean {
  if (sessionScopeOf(session) !== 'work') return true
  return !!host && !!desktops?.(session).includes(host)
}

/** The calls of `CrossHostAgents` a Work thread's scope bears on. */
interface FarAgentCalls {
  startThread(caller: SessionMeta, environmentId: string | null | undefined, args: { work?: unknown }): Promise<unknown>
  spawn(caller: SessionMeta, environmentId: string | null | undefined, specs: unknown[]): Promise<unknown>
  adopt(master: SessionMeta, encodedIds: readonly string[]): Promise<{ adopted: string[]; refused: { sessionId: string; why: string }[] }>
}

/**
 * Work's rule on the calls that make or take a thread on another host,
 * whichever tool or method reaches them (a Claude tool, the bridge's
 * `app.*`, the desktop's `batch.adopt`):
 *
 *  - a Work thread starts a thread there only as a Work start (`work` in
 *    the args, which a host from before Work refuses);
 *  - it spawns no subagent there: the spawn request names no scope, so the
 *    child would be a code thread of that host;
 *  - a Work master adopts no thread there: this host cannot see the
 *    thread's scope, and a code thread in its batch is one it may instruct.
 *
 * The rule sits here, wrapped round the object where the host hands it to
 * the tools (orchestration.ts `setCrossHostAgents`), because the calls
 * themselves live in a file outside this milestone (crossHostAgents.ts). It
 * does not wait for Work's mount: a Work row is held to it even on a host
 * where Work failed to come up.
 */
export function guardCrossHostAgents(agents: object, facts: () => ScopeFacts | null): void {
  const target = agents as FarAgentCalls & { workGuarded?: true }
  if (target.workGuarded) return
  target.workGuarded = true
  const isWork = (session: SessionMeta): boolean => sessionScopeOf(facts()?.session(session.id) ?? session) === 'work'
  const { startThread, spawn, adopt } = target
  target.startThread = async function (this: unknown, caller, environmentId, args) {
    if (isWork(caller) && !args?.work) throw new WorkRefused('a Work thread starts a thread on another host only as a Work thread')
    return startThread.call(this, caller, environmentId, args)
  }
  target.spawn = async function (this: unknown, caller, environmentId, specs) {
    if (isWork(caller)) throw new WorkRefused('a Work thread spawns its subagents on its own host; a subagent on another host would not be a Work thread')
    return spawn.call(this, caller, environmentId, specs)
  }
  target.adopt = async function (this: unknown, master, encodedIds) {
    if (isWork(master)) return { adopted: [], refused: [...new Set(encodedIds)].map((sessionId) => ({ sessionId, why: 'a Work master takes no thread from another host into its batch' })) }
    return adopt.call(this, master, encodedIds)
  }
}

export const scopePart: ScopePart = (ctx, deps) => {
  const facts = scopeFactsOf(deps.registry)
  const here = { host: deps.environmentId, away: () => deps.away?.enabled ?? false }
  // The add-on registry reads a thread's scope from here: a Work thread sees its workspace's rows and the global ones marked for Work.
  configureAddonScope({
    scopeOf: (session) => workAddonScope(facts, session),
    isWork: (workspaceId) => workspaceId === WORK_HOME || workspaceId === WORK_ORPHAN || facts.workspaces().some((w) => w.id === workspaceId && workspaceKindOf(w) === 'work'),
    forWork: (addonId) => deps.addons?.workMarks(addonId)?.forWork ?? false
  })
  desktops = (session) => {
    const home = workHomeOfSession(facts, session)
    return typeof home === 'string' ? [] : ctx.settings.workspace(home.id).mayUseDesktop
  }
  // What a new thread is about is linked in LifeOS once its row exists (ctx.links, milestone 7).
  deps.registry.onAbout?.((session, about) => {
    void Promise.resolve()
      .then(() => ctx.links.link(about, session.id, session.title))
      .catch((err) => ctx.log(`thread ${session.id}: its ${about.kind} was not linked: ${err instanceof Error ? err.message : String(err)}`))
  })
  return {
    scopeOf: (sessionId) => workScopeOf(facts, deps.registry.get(sessionId), here),
    async createWorkspace(params) {
      if (!ctx.enabled()) throw new WorkRefused(WORK_OFF)
      const sector = params.sector ? SectorKeySchema.parse(params.sector) : null
      const all = deps.registry.listWorkspaces()
      const taken = sector ? all.find((w) => workspaceKindOf(w) === 'work' && w.sector === sector) : null
      if (taken) throw new WorkRefused(`this host already has a Work workspace for ${sector}: ${taken.name}`)
      const name = (params.name ?? '').trim() || sector || 'Work'
      const root = workFoldersRoot(deps.store)
      // The app makes the folder; a name already used here (a workspace's, or Work Chats') gets a number.
      const used = new Set(all.map((w) => w.path))
      const base = workFolderName(name) === WORK_CHATS_FOLDER ? `${WORK_CHATS_FOLDER} workspace` : workFolderName(name)
      let path = join(root, base)
      for (let n = 2; used.has(path) || existsSync(path); n++) path = join(root, `${base} ${n}`)
      mkdirSync(path, { recursive: true })
      return deps.registry.createWorkspace(path, name, { kind: 'work', sector })
    },
    admitSession(params) {
      // The router asks only for a create that names Work or carries a chip; any other passes untouched.
      if (params.scope !== 'work' && !params.about) return
      if (!ctx.enabled()) throw new WorkRefused(WORK_OFF)
      // The scope is stamped, and a create Work cannot honour refused, where the row is made (stampScope).
      // What a thread is about is linked in LifeOS: until that is built, a create with a chip says so.
      if (params.about) {
        try {
          ctx.lifeos.connected()
        } catch (err) {
          if (err instanceof NotBuilt) throw new NotBuilt('session.create {about}', 7)
        }
      }
    }
  }
}
