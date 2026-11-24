import { capabilityRefusal, type Principal } from '@shared/capabilities'
import { REVEAL_INVALID, RevealParamsSchema, type RevealAnswer, type RevealNavigation, type RevealTarget } from '@shared/contract-work-reveal'
import type { FilesTabs } from '@shared/contract-work-files'
import type { WorkspaceMeta } from '@shared/domain'
import { canvasSourcePath, paneWorkspace } from '@shared/work/canvas'
import type { HeldRef } from '@shared/work/acts'
import { WORK_HOME } from '@shared/work/ids'
import type { SessionRegistry } from '../sessions'
import type { Caller, WorkCtx } from './modules'

const METHOD = 'work.reveal'
const NOT_FOUND = 'That destination is unavailable on this computer.'
export const REVEAL_NO_DESKTOP = 'This host has no desktop window. Choose a computer with TempCode open.'
export const REVEAL_ADMIN = 'forbidden: work.reveal needs admin for this Settings page'

const LIFEOS_VIEWS = new Set<RevealTarget['view']>(['agenda', 'mail', 'messages', 'people', 'prep', 'projects', 'tasks'])

const ADMIN_SETTINGS = new Set<RevealTarget['settings']>([
  'remote', 'defaults', 'providers', 'addons', 'skills', 'orchestration',
  'reviews', 'computer', 'archive', 'work', 'connections'
])

export interface RevealWindow {
  check(): string | null
  open(navigation: RevealNavigation, signal?: AbortSignal): Promise<void>
}

interface RevealDeps {
  platform: NodeJS.Platform
  registry: Pick<SessionRegistry, 'get' | 'getProject' | 'listWorkspaces'>
  ctx: Pick<WorkCtx, 'enabled' | 'reaches' | 'canvas' | 'lifeos' | 'host'>
  window?: RevealWindow
  held(ref: HeldRef): Promise<{ workspaceId: string | null; sessionId: string | null; sector: string | null } | null>
  files(by: Caller, workspaceId: string, signal?: AbortSignal): Promise<FilesTabs | null>
}

/** Reuse the view's read and check the returned sector before using the local window's wider access. */
async function viewHas(ctx: RevealDeps['ctx'], view: NonNullable<RevealTarget['view']>, id: string, sector: string): Promise<boolean> {
  const read = () => ctx.lifeos.owner()
  switch (view) {
    case 'agenda':
    case 'prep':
      return (await read().query<{ sector?: string } | null>('events:get', { id }))?.sector === sector
    case 'mail':
      return (await read().query<{ thread: { sector?: string } } | null>('mail:thread', { id }))?.thread.sector === sector
    case 'messages':
      return (await read().query<{ chat: { sector?: string } } | null>('chats:get', { id }))?.chat.sector === sector
    case 'tasks':
      return (await read().query<{ task: { sector?: string } } | null>('tasks:get', { id }))?.task.sector === sector
    case 'people':
      return (await read().query<{ person: { sectors?: string[] } } | null>('people:page', { id, sector, shared: [] }))?.person.sectors?.includes(sector) ?? false
    case 'projects': {
      const projects = await read().query<{ _id: string; sector?: string }[]>('projects:list', { sector })
      return projects.some((p) => p._id === id && p.sector === sector)
    }
    default:
      return false
  }
}

const missing = (): never => { throw new Error(NOT_FOUND) }

export async function reveal(deps: RevealDeps, raw: unknown, principal: Principal, signal?: AbortSignal): Promise<RevealAnswer> {
  const refused = principal.kind === 'remote' && capabilityRefusal(principal.caps, { method: METHOD })
  if (refused) throw new Error(refused)
  const parsed = RevealParamsSchema.safeParse(raw)
  if (!parsed.success) throw new Error(REVEAL_INVALID)
  const { target } = parsed.data
  if (target.settings && ADMIN_SETTINGS.has(target.settings) && principal.kind === 'remote' && capabilityRefusal(principal.caps, { method: 'work.set' })) {
    throw new Error(REVEAL_ADMIN)
  }
  const window = deps.window
  if (!window) throw new Error(REVEAL_NO_DESKTOP)
  const lifeosRefused = principal.kind === 'remote' && capabilityRefusal(principal.caps, { method: 'work.lifeos.jwt' })
  const needsLifeos = LIFEOS_VIEWS.has(target.view) || target.place === 'today' || target.held?.at === 'lifeos'
  if (needsLifeos && lifeosRefused) return missing()
  if (target.settings === 'computer' && deps.platform !== 'darwin') return missing()
  const unavailable = window.check()
  if (unavailable) throw new Error(unavailable)
  if (!deps.ctx.enabled() && (target.view || target.place || target.item || target.held || target.settings === 'connections')) {
    throw new Error('Work is off on this host')
  }

  const by: Caller = principal.kind === 'local' ? { kind: 'local', caps: [] } : { kind: 'remote', caps: principal.caps, keyId: principal.keyId }
  const jobs = deps.registry.listWorkspaces()
  const reaches = (path: string) => deps.ctx.reaches(by, path)
  const workspaceOf = (id: string) => {
    const workspace = jobs.find((w) => w.id === id)
    return workspace && reaches(workspace.path) ? workspace : missing()
  }
  const readThread = (id: string) => {
    const thread = deps.registry.get(id)
    if (!thread) return missing()
    const project = thread.projectId ? deps.registry.getProject(thread.projectId) : null
    if (project && !reaches(project.cwd)) return missing()
    if (project?.workspaceId) workspaceOf(project.workspaceId)
    if (thread.workspaceId && thread.workspaceId !== project?.workspaceId) workspaceOf(thread.workspaceId)
    if (!reaches(thread.cwd)) return missing()
    return thread
  }
  const threadOf = (id: string) => {
    const thread = readThread(id)
    // The desktop opens the parent tab to show a subagent.
    if (thread.parentId) readThread(thread.parentId)
    return thread
  }
  const nav: RevealNavigation = { target }
  const setWorkspace = (w: WorkspaceMeta) => { nav.workspace = { id: w.id, path: w.path } }
  const read = async <T>(ask: Promise<T>): Promise<T> => {
    try { return await ask } catch { return missing() }
  }

  if (target.held) {
    const held = await read(deps.held(target.held))
    if (!held || (target.thread && held.sessionId !== target.thread)) return missing()
    const workspaceId = held.workspaceId === WORK_HOME ? null : held.workspaceId
    if (workspaceId) workspaceOf(workspaceId)
    if (held.sessionId) threadOf(held.sessionId)
    if (!workspaceId && held.sector) {
      for (const workspace of jobs.filter((w) => w.sector === held.sector)) workspaceOf(workspace.id)
    }
  } else if (target.thread) {
    threadOf(target.thread)
  } else if (target.view && target.workspaceId) {
    const job = workspaceOf(target.workspaceId)
    if (job.kind !== 'work' || !job.sector) return missing()
    if (target.at && !(await read(viewHas(deps.ctx, target.view, target.at, job.sector)))) return missing()
    setWorkspace(job)
  } else if (target.place) {
    for (const job of jobs.filter((w) => w.kind === 'work')) workspaceOf(job.id)
  } else if (target.item) {
    const item = deps.ctx.canvas.get(target.item)
    if (!item || item.source.at === 'thread' || item.source.at === 'browser') return missing()
    const { source } = item
    if (lifeosRefused && (source.at === 'mail' || source.at === 'lifeos')) return missing()
    if ('host' in source && source.host !== deps.ctx.host) return missing()
    const path = canvasSourcePath(source)
    if (path !== null && !reaches(path)) return missing()
    const pane = paneWorkspace(item.sessionId)
    const job = item.workspaceId ? workspaceOf(item.workspaceId) : null
    if (!pane) {
      threadOf(item.sessionId)
      nav.item = { owner: item.sessionId }
    } else {
      if (!job || job.id !== pane || job.kind !== 'work') return missing()
      setWorkspace(job)
      const tabs = await read(deps.files(by, job.id, signal))
      const tab = tabs?.tabs.find((t) => t.itemId === item.id || t.side?.itemId === item.id)
      if (tab?.copyOf && tab.copyOf.host !== deps.ctx.host) return missing()
      if (tab) nav.item = { tab: tab.id, itemId: item.id }
      else if (source.at === 'mail' && job.sector && await read(viewHas(deps.ctx, source.from === 'chat' ? 'messages' : 'mail', source.threadId, job.sector))) {
        nav.item = { ref: source, name: item.title }
      } else return missing()
    }
  }

  if (signal?.aborted) throw new Error('The connection closed before the destination opened.')
  await window.open(nav, signal)
  return { opened: true }
}
