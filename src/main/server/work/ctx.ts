import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { allows, CAPABILITIES, principalCaps, type Principal as SocketPrincipal } from '@shared/capabilities'
import type { ClientRequest, CreateSessionParams } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import {
  handled,
  NOT_HANDLED,
  NotBuilt,
  PILLAR_MILESTONE,
  pillarOfMethod,
  workToolNameProblem,
  type Handled,
  type PillarId,
  type WorkScope,
  type WorkSettings,
  type WorkToolListing,
  type WorkToolResult
} from '@shared/work'
import type { AddonStore } from '../addonStore'
import type { AddonGrants } from '../addons/addonGrants'
import type { AddonHost } from '../addons/addonHost'
import type { AwayService } from '../away'
import type { CrossHostAgents } from '../crossHostAgents'
import type { Store } from '../db'
import type { CrossHostThreads } from '../remote/crossHostThreads'
import type { MacBridge } from '../remote/macBridge'
import type { Notifier } from '../remote/notifier'
import { admitsPath } from '../remote/fence'
import type { PeerCalls } from '../remote/peerCalls'
import type { Peers } from '../remote/peers'
import type { SessionMover } from '../remote/sessionMover'
import type { StoreSync } from '../remote/storeSync'
import type { SessionRegistry } from '../sessions'
import type { storeRpc } from '../storeRpc'
import { canvasPart } from './canvas/ctx'
import { convertPart } from './formats/jobs'
import { lifeosPart } from './lifeos/ctx'
import { WORK_LOAD_FAULTS, WORK_MODULES, workModulesAsked, type Caller, type PushTo, type ToolCtx, type WorkCtx, type WorkModule, type WorkSend, type WorkTool } from './modules'
import { heldPart } from './outbox/ctx'
import { resultsPart } from './outbox/results'
import { peerPart } from './peer'
import { lifeosProjectIn, mirrorsPart } from './projects/mirrors'
import { ensureWorkTables } from './schema'
import { scopePart } from './scope'
import { routinesHostPart } from './routines/host'
import { servicePart } from './service/ctx'
import { WorkSettingsStore } from './settings'
import { inputShapeOf } from './toolInput'
import { threadsPart } from './threads'

/**
 * Work's one mount on the server (docs/agents/work.md). `startWork(deps)`
 * makes every module's tables, builds the `WorkCtx` the modules share, and
 * answers the four things index.ts and apptools.ts ask of it: a request
 * (`handle`), the pushes (`pushes.onPush`), a thread's tools (`tools`) and
 * the two questions the router asks before a create (`createWorkspace`,
 * `admitSession`). While the switch is off no module's `start` or `onPush`
 * runs, no tool is listed and every pillar method is refused; `work.get`
 * and `work.set` answer, and a bridge that asks for its tools hears none.
 */

/**
 * What index.ts hands over: the host's own handles, for the parts of the
 * context (the files `buildWorkCtx` lists) to build on. A pillar's module
 * never sees this, only `WorkCtx`. The optional ones are absent only in a
 * test. A part that needs a handle this lacks hooks itself into a file its
 * milestone owns through one of these, or asks for a foundation follow-up.
 */
export interface WorkDeps {
  db: DatabaseSync
  store: Store
  registry: SessionRegistry
  /** this host's environment id */
  environmentId: string
  /** <userData>: where a part keeps its files */
  dataDir: string
  /** The listener's path fence for a remote key (index.ts `managedRoots` and the folders it denies): `ctx.reaches` and `PushTo.path` ask it. Absent only in a test, where a remote key then reaches no file. */
  remoteFence?: { roots(): string[]; denied(): string[] }
  /** the links to other hosts, and the calls a registered host answers */
  peers?: Peers
  peerCalls?: PeerCalls
  /** threads another host starts here, and the ones this host starts there */
  crossHostThreads?: CrossHostThreads
  crossHostAgents?: CrossHostAgents
  macBridge?: MacBridge
  sessionMover?: SessionMover
  /** the add-on registry: its rows, its sync, its RPC (a write as this host's own caller), its host and its grants */
  addons?: AddonStore
  addonRpc?: ReturnType<typeof storeRpc>
  storeSync?: StoreSync
  addonHost?: AddonHost
  addonGrants?: AddonGrants
  away?: AwayService
  /** the notices a phone gets; null until the host has built it, late in boot */
  notifier?: () => Notifier | null
  log?(line: string): void
}

/** What a part gets: the host's handles, and a place to hang what must run only while Work is on. */
export interface WorkPartDeps extends WorkDeps {
  /**
   * `run` is called when Work turns on (at boot, when the switch was left
   * on) and its return when Work turns off or the host closes: a part's
   * connection, poller or child process lives between the two, as a
   * module's `start` does. Never called while Work is off.
   */
  whileOn(run: () => (() => void) | void): void
}

/** A member of `WorkCtx` as its owner builds it: called once at boot, Work on or off, with the context (whole by the time any member is called) and the host's handles. Making it starts nothing: what runs goes in `deps.whileOn`. */
export type CtxPart<K extends keyof WorkCtx> = (ctx: WorkCtx, deps: WorkPartDeps) => Pick<WorkCtx, K>

/** What the router asks before a create; work/scope.ts answers (milestone 6). */
export interface WorkAdmission {
  /** `workspace.create {kind: 'work'}`: makes the app's folder and the row, or refuses. */
  createWorkspace(params: { name?: string; sector?: string | null }, by: Caller): Promise<WorkspaceMeta>
  /** A `session.create` that asks for Work (`scope: 'work'`) or carries `about`: throws to refuse. The router calls it for no other create; the scope itself is stamped where the row is made. */
  admitSession(params: CreateSessionParams, by: Caller): void
}
export type ScopePart = (ctx: WorkCtx, deps: WorkPartDeps) => Pick<WorkCtx, 'scopeOf' | 'mentionReach'> & WorkAdmission

/**
 * The context, with each member from the file of the milestone that owns
 * it. That file is a stub that throws `NotBuilt` until then; its owner
 * fills it and edits nothing here.
 *
 *   scopeOf, and the two admissions   work/scope.ts            milestone 6
 *   threads                           work/threads.ts          milestone 6
 *   peer                              work/peer.ts             milestone 6
 *   lifeos, links                     work/lifeos/ctx.ts       milestone 7
 *   canvas                            work/canvas/ctx.ts       milestone 9
 *   held                              work/outbox/ctx.ts       milestone 10
 *   results                           work/outbox/results.ts   milestone 14
 *   convert                           work/formats/jobs.ts     milestone 15
 *   service                           work/service/ctx.ts      milestone 18
 */
export function buildWorkCtx(deps: WorkPartDeps, settings: WorkSettingsStore, push: WorkSend): { ctx: WorkCtx; admission: WorkAdmission } {
  const ctx = {
    db: deps.db,
    host: deps.environmentId,
    dataDir: deps.dataDir,
    reaches: reachesOf(deps.remoteFence),
    enabled: () => settings.enabled(),
    log: deps.log ?? ((line: string) => console.log(`[work] ${line}`)),
    push,
    settings: { workspace: (id: string) => settings.workspace(id), set: (id, patch) => settings.setWorkspace(id, patch) }
  } as WorkCtx
  /** One part's members. A part that throws while it is made never stops the host: its members answer its fault from then on. */
  const part = <T extends object>(file: string, keys: readonly (keyof T)[], make: () => T): T => {
    try {
      return make()
    } catch (err) {
      const why = `work: ${file} did not start: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[work] ${why}`)
      return Object.fromEntries(keys.map((key) => [key, failing(why)])) as T
    }
  }
  const { scopeOf, mentionReach, ...admission } = part('scope.ts', ['scopeOf', 'mentionReach', 'createWorkspace', 'admitSession'], () => scopePart(ctx, deps))
  Object.assign(
    ctx,
    { scopeOf, mentionReach },
    part('threads.ts', ['threads'], () => threadsPart(ctx, deps)),
    part('peer.ts', ['peer'], () => peerPart(ctx, deps)),
    part('lifeos/ctx.ts', ['lifeos', 'links'], () => lifeosPart(ctx, deps)),
    part('canvas/ctx.ts', ['canvas'], () => canvasPart(ctx, deps)),
    part('outbox/ctx.ts', ['held'], () => heldPart(ctx, deps)),
    part('outbox/results.ts', ['results'], () => resultsPart(ctx, deps)),
    part('formats/jobs.ts', ['convert'], () => convertPart(ctx, deps)),
    part('service/ctx.ts', ['service'], () => servicePart(ctx, deps)),
    // Not a member: the host handles the routines engine needs and the context does not carry (milestone 32).
    part('routines/host.ts', [], () => (routinesHostPart(deps), {})),
    // Not a member: the mirrors of LifeOS's projects follow LifeOS while Work is on.
    part('projects/mirrors.ts', [], () => (mirrorsPart(ctx, deps), {}))
  )
  return { ctx, admission }
}

/**
 * `ctx.reaches`: the listener's own answer (remote/fence.ts `admitsPath`,
 * over the roots and denied folders the host hands in), asked of a file a
 * module reaches through an id. Only a remote key is fenced, as at the
 * listener; with no roots handed in (a test) it reaches nothing.
 */
export function reachesOf(fence: WorkDeps['remoteFence']): WorkCtx['reaches'] {
  return (by, path) => by.kind !== 'remote' || (!!fence && admitsPath(path, fence.roots(), fence.denied()))
}

/** A member that answers one fault however it is used: called itself (`ctx.convert(job)`), or through any of its methods (`ctx.lifeos.jwt()`). */
function failing(why: string): never {
  const fail = (): never => {
    throw new Error(why)
  }
  return new Proxy(fail, { get: () => fail }) as never
}

/** A thread's Work tools as one mount serves them to Claude (apptools.ts `withWorkTools`) and to the bridge (`app.workTools`, `app.workCall`). */
export interface WorkToolMount {
  /** The thread's tools and its scope; null while Work is off, for a code thread, and for a thread with no scope. */
  of(session: Pick<SessionMeta, 'id' | 'scope'>): { scope: WorkScope; tools: WorkTool[] } | null
  /** The same tools as the bridge lists them. */
  listing(session: Pick<SessionMeta, 'id' | 'scope'>): WorkToolListing[]
  /** Runs one tool for the thread. Arguments that do not fit its input come back as the tool's error, never a throw. The tool's signal aborts on the caller's `signal` or when Work turns off. */
  call(session: Pick<SessionMeta, 'id' | 'scope'>, name: string, args: unknown, signal: AbortSignal): Promise<WorkToolResult>
  /** The thread's own bridge token: one thread's bridge never lists or calls as another. */
  tokenFor(sessionId: string): string
  checkToken(sessionId: string, token: string): boolean
}

export interface Work extends WorkAdmission {
  ctx: WorkCtx
  settings: WorkSettingsStore
  /** One Work request: a method that is not Work's comes back unhandled; an unbuilt one throws `NotBuilt`. `socket.signal` aborts when the caller's socket goes; a module's handler and a bridge's tool call both hear it. */
  handle(req: ClientRequest, principal: SocketPrincipal, socket?: { signal?: AbortSignal }): Promise<Handled>
  /** One socket's pushes: every Work push, less the ones that name a capability its principal lacks. */
  pushes: { onPush(send: (p: WorkPush) => void, principal?: SocketPrincipal): () => void }
  tools: WorkToolMount
  close(): void
}

const callerOf = (principal: SocketPrincipal): Caller => (principal.kind === 'local' ? { kind: 'local', caps: CAPABILITIES } : { kind: 'remote', caps: principal.caps })

export function startWork(deps: WorkDeps, modules: WorkModule[] = WORK_MODULES): Work {
  // The registry is filled by a load, never by importing it: without one the default list would be silently empty.
  if (modules === WORK_MODULES && !workModulesAsked()) throw new Error('work: the pillars are not loaded; await loadWorkModules() (work/modules.ts) before startWork, or pass the modules')
  // Tables first, Work on or off: they only add. A pillar whose tables could not be made is left out of everything below.
  const broken = ensureWorkTables(deps.db, modules)
  // So is a pillar whose code could not be loaded at all (work/modules.ts): its methods answer why.
  if (modules === WORK_MODULES) for (const [id, why] of WORK_LOAD_FAULTS) broken.set(id, why)
  const sound = modules.filter((m) => !broken.has(m.id))
  const settings = new WorkSettingsStore(deps.store)
  const sinks = new Map<(p: WorkPush) => void, SocketPrincipal>()
  const reaches = reachesOf(deps.remoteFence)
  /** Whether a remote key could name every path a push names: one answer for every key, since no key has roots of its own. A fence that throws admits none. */
  const remoteReaches = (path: string | readonly string[]): boolean => {
    try {
      return (typeof path === 'string' ? [path] : path).every((one) => reaches({ kind: 'remote', caps: [] }, one))
    } catch (err) {
      console.error('[work] the path fence did not answer; the push goes only to this host:', err)
      return false
    }
  }
  const broadcast = (p: WorkPush, to?: PushTo): void => {
    const remoteOk = to?.path === undefined || remoteReaches(to.path)
    for (const [send, principal] of [...sinks]) {
      if (to?.need && !allows(principalCaps(principal), to.need)) continue
      if (!remoteOk && principal.kind !== 'local') continue
      if (to?.only && (to.only === 'local') !== (principal.kind === 'local')) continue
      send(p)
    }
  }
  /** What the parts asked to run only while Work is on. */
  const whileOn: (() => (() => void) | void)[] = []
  const { ctx, admission } = buildWorkCtx({ ...deps, whileOn: (run) => void whileOn.push(run) }, settings, broadcast)
  const byId = new Map<PillarId, WorkModule>(sound.map((m) => [m.id, m]))

  // ── start and stop with the switch ──────────────────────────────────
  let stops: (() => void)[] = []
  /**
   * The stretch Work is on. Every tool call's signal is joined with this one
   * (`tools.call`), whichever harness made the call, so turning Work off
   * stops what is running and not only what would start next. Aborted while
   * Work is off; a fresh one each time it turns on.
   */
  let period = new AbortController()
  period.abort()
  const startModules = (): void => {
    period = new AbortController()
    // The parts first: a module's start may call what they bring up.
    for (const run of whileOn) {
      try {
        const stop = run()
        if (stop) stops.push(stop)
      } catch (err) {
        console.error('[work] a part of the context did not start:', err)
      }
    }
    for (const module of sound) {
      // One module's fault leaves the others running, and says so.
      try {
        if (module.onPush) stops.push(module.onPush(broadcast))
        if (module.start) stops.push(module.start(ctx))
      } catch (err) {
        console.error(`[work] ${module.id} did not start:`, err)
      }
    }
  }
  const stopModules = (): void => {
    // The calls in flight first: a tool stops before the module and the parts it calls into do.
    period.abort()
    const running = stops
    stops = []
    for (const stop of running.reverse()) {
      try {
        stop()
      } catch (err) {
        console.error('[work] a module did not stop:', err)
      }
    }
  }
  if (settings.enabled()) startModules()
  const offSwitch = settings.onChange((next) => {
    if (next.enabled) startModules()
    else stopModules()
    broadcast({ push: 'work', settings: next })
  })

  // ── what a deleted thread or workspace left behind ──────────────────
  // On or off: the rows may be from a time the switch was on.
  const tell = (what: string, each: (module: WorkModule) => void): void => {
    for (const module of sound) {
      try {
        each(module)
      } catch (err) {
        console.error(`[work] ${module.id} ${what}:`, err)
      }
    }
  }
  const offRemoved = deps.registry.onRemoved?.((ids) => tell('did not clear deleted threads', (m) => m.sessionsRemoved?.(ids, ctx)))
  const offWorkspace = deps.registry.onWorkspaceDeleted?.((id) => tell('did not clear a deleted workspace', (m) => m.workspaceRemoved?.(id, ctx)))

  // ── tools ───────────────────────────────────────────────────────────
  // An isolated instance (TEMP_CODE_USER_DATA) may take its key from TEMP_CODE_WORK_TOKEN_SEED, so a proof script can
  // call a thread's tools as its bridge does (as macTools.ts's seeds let it for the Mac's and the bridge's tokens).
  const seed = process.env.TEMP_CODE_USER_DATA ? process.env.TEMP_CODE_WORK_TOKEN_SEED : undefined
  const secret = seed && /^[0-9a-f]{64,}$/i.test(seed) ? Buffer.from(seed, 'hex') : randomBytes(32)
  const tokenFor = (sessionId: string): string => createHmac('sha256', secret).update(sessionId).digest('base64url')
  const tools: WorkToolMount = {
    of(session) {
      // The row decides, never the switch alone: a code thread has no Work tools, and asking costs it nothing.
      if (session.scope !== 'work' || !settings.enabled()) return null
      const scope = ctx.scopeOf(session.id)
      if (!scope) return null
      const seen = new Set<string>()
      const list: WorkTool[] = []
      for (const module of sound) {
        for (const tool of module.tools?.(scope) ?? []) {
          const problem = workToolNameProblem(tool.name) ?? (seen.has(tool.name) ? `${tool.name}: registered twice` : null) ?? (inputShapeOf(tool.input) ? null : `${tool.name}: its input is not a z.object`)
          if (problem) {
            console.error(`[work] ${module.id} tool refused: ${problem}`)
            continue
          }
          seen.add(tool.name)
          list.push(tool)
        }
      }
      return { scope, tools: list }
    },
    listing(session) {
      return (tools.of(session)?.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>,
        readOnly: tool.readOnly
      }))
    },
    async call(session, name, args, signal) {
      const mounted = tools.of(session)
      const tool = mounted?.tools.find((t) => t.name === name)
      if (!mounted || !tool) throw new Error(`unknown tool: ${name}`)
      const parsed = tool.input.safeParse(args ?? {})
      if (!parsed.success) return { content: [{ type: 'text', text: `invalid arguments: ${parsed.error.message}` }], isError: true }
      // The caller's signal (the harness's cancel, the bridge's socket) or Work turning off, whichever comes first.
      const toolCtx: ToolCtx = { ...ctx, scope: mounted.scope, sessionId: session.id, signal: AbortSignal.any([signal, period.signal]) }
      return tool.run(parsed.data, toolCtx)
    },
    tokenFor,
    checkToken(sessionId, token) {
      const want = Buffer.from(tokenFor(sessionId))
      const got = Buffer.from(token)
      return want.length === got.length && timingSafeEqual(want, got)
    }
  }
  const openingProjects = new Map<string, Promise<ProjectMeta>>()
  const knownWorkspace = (id: string): WorkspaceMeta => {
    const workspace = deps.registry.listWorkspaces().find((w) => w.id === id)
    if (!workspace) throw new Error(`unknown workspace: ${id}`)
    return workspace
  }
  /** A bridge call's thread: its token must be its own. */
  const bridgeSession = (params: { sessionId?: unknown; token?: unknown } | undefined): SessionMeta => {
    if (typeof params?.sessionId !== 'string' || typeof params.token !== 'string' || !tools.checkToken(params.sessionId, params.token))
      throw new Error("forbidden: not this thread's Work token")
    const session = deps.registry.get(params.sessionId)
    if (!session) throw new Error(`unknown thread: ${params.sessionId}`)
    return session
  }
  /** The bridge's running tool calls, by thread and the bridge's own request id, so a cancel reaches the tool's signal. */
  const running = new Map<string, AbortController>()
  const callKey = (sessionId: string, call: string | number): string => `${sessionId}\0${typeof call}:${call}`

  return {
    ctx,
    settings,
    ...admission,
    async handle(req, principal, socket) {
      switch (req.method) {
        case 'work.get':
          return handled(settings.get())
        case 'work.set':
          return handled(settings.set({ enabled: req.params.enabled }) satisfies WorkSettings)
        case 'work.workspace.get':
          return handled(settings.workspace(knownWorkspace(req.params.workspaceId).id))
        case 'work.workspace.set': {
          if (!settings.enabled()) throw new Error('Work is off on this host')
          const { workspaceId, patch } = req.params
          if (knownWorkspace(workspaceId).kind !== 'work') throw new Error('refused: only a Work workspace has Work settings')
          // null clears a model back to the Work default; absent keeps what is set.
          const { model, reasoning, ...rest } = patch
          settings.setWorkspace(workspaceId, {
            ...rest,
            ...(model !== undefined ? { model: model ?? undefined } : {}),
            ...(reasoning !== undefined ? { reasoning: reasoning ?? undefined } : {})
          })
          return handled(settings.workspace(workspaceId))
        }
        case 'work.project.open': {
          if (!settings.enabled()) throw new Error('Work is off on this host')
          const { workspaceId, lifeosProjectId } = req.params
          const workspace = knownWorkspace(workspaceId)
          if (workspace.kind !== 'work' || !workspace.sector) throw new Error(`${workspace.name} is not a Work workspace linked to LifeOS`)
          const mine = deps.registry.listProjects().find((p) => p.workspaceId === workspaceId && p.lifeosProjectId === lifeosProjectId)
          if (mine) return handled(mine)
          // Two asks at once (a double click, a second window) make one project.
          const key = `${workspaceId}\0${lifeosProjectId}`
          let making = openingProjects.get(key)
          if (!making) {
            // LifeOS is asked, as the owner: the project must be one of this workspace's sector, and the mirror takes the name it has there, never a client's.
            making = lifeosProjectIn(ctx, workspace, lifeosProjectId)
              .then((project) => deps.registry.createProject(workspaceId, project.name, 'local', { lifeosProjectId }))
              .finally(() => openingProjects.delete(key))
            openingProjects.set(key, making)
          }
          return handled(await making)
        }
        case 'app.workTools':
          return handled({ tools: tools.listing(bridgeSession(req.params)) })
        case 'app.workCall': {
          const session = bridgeSession(req.params)
          // Aborted by the harness's cancel (app.workCancel) or when the bridge's socket goes.
          const abort = new AbortController()
          const onSocket = (): void => abort.abort()
          socket?.signal?.addEventListener('abort', onSocket, { once: true })
          if (socket?.signal?.aborted) abort.abort()
          const key = callKey(session.id, req.params.call)
          running.set(key, abort)
          try {
            return handled(await tools.call(session, req.params.tool, req.params.args, abort.signal))
          } finally {
            if (running.get(key) === abort) running.delete(key)
            socket?.signal?.removeEventListener('abort', onSocket)
          }
        }
        case 'app.workCancel':
          running.get(callKey(bridgeSession(req.params).id, req.params.call))?.abort()
          return handled(null)
      }
      const pillar = pillarOfMethod(req.method)
      if (!pillar) return NOT_HANDLED
      if (!settings.enabled()) throw new Error('Work is off on this host')
      const fault = broken.get(pillar)
      if (fault) throw new Error(fault)
      // A pillar's bridge method is a thread's own call: the model's, and only with that thread's token.
      const by: Caller = req.method.startsWith('app.')
        ? { kind: 'model', caps: [], sessionId: bridgeSession((req as { params?: { sessionId?: unknown; token?: unknown } }).params).id }
        : callerOf(principal)
      const module = byId.get(pillar)
      // The handler's signal: the caller's socket going, or Work turning off, whichever comes first.
      const signal = socket?.signal ? AbortSignal.any([socket.signal, period.signal]) : period.signal
      const answer = module?.handle ? await module.handle(req, ctx, by, signal) : NOT_HANDLED
      // A method its contract declares and no module answers never hangs and never passes: it says which milestone builds it.
      if (!answer.handled) throw new NotBuilt(req.method, PILLAR_MILESTONE[pillar])
      return answer
    },
    pushes: {
      onPush(send, principal = { kind: 'local' }) {
        sinks.set(send, principal)
        return () => void sinks.delete(send)
      }
    },
    tools,
    close() {
      offSwitch()
      offRemoved?.()
      offWorkspace?.()
      for (const abort of running.values()) abort.abort()
      running.clear()
      stopModules()
      sinks.clear()
    }
  }
}
