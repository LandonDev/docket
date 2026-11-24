import type { DatabaseSync } from 'node:sqlite'
import type { Capability } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { AddonRow } from '@shared/contract-addons'
import type { RoutineJobOpen } from '@shared/contract-work-routines'
import type { WorkPush } from '@shared/contract-work'
import type {
  ActKind,
  ActKindDefOf,
  CanvasItem,
  CanvasKind,
  CanvasSource,
  ContextChip,
  ChipKind,
  Handled,
  HealthRow,
  HeldItem,
  Lapse,
  MentionHit,
  MentionReach,
  HostId,
  PillarId,
  SectorKey,
  TriggerSource,
  UndoSpec,
  Verdict,
  WorkScope,
  WorkspaceWorkSettings,
  WorkToolOf
} from '@shared/work'
import type { Tell, TellKind } from '@shared/work/tell'
import type { AttachmentUploads } from '../attachmentUploads'
import type { ConvertJob, ConvertResult, Converter } from './formats/jobs'
import type { LifeosClient, WorkLink } from './lifeos/ctx'
import type { SearchSource } from './search/source'
import type { CollabClaims } from './service/ctx'
import { errorText, PILLAR_IDS } from '@shared/work/ids'

/**
 * Work's server modules (docs/agents/work.md). One module per pillar, in
 * its own folder, mounted here once. A pillar fills
 * `src/main/server/work/<pillar>/index.ts` and edits nothing in this file:
 * its tables come from its `ensure`, its methods from `handle`, its tools
 * from `tools`, and so on.
 *
 * No pillar is imported when this file loads. Each is loaded on its own by
 * `loadWorkModules`, once, at boot (work/load.ts), so a pillar whose code or
 * whose dependency throws while it loads (a native library this machine
 * lacks) is left out and named, and the host boots as it always did.
 */

/** A tool as a module registers it: `run(args, ctx: ToolCtx)`. */
export type WorkTool = WorkToolOf<ToolCtx>
/** An act kind as a module registers it: `execute(p, ctx: ActCtx)`. */
export type ActKindDef<P = unknown, M = unknown> = ActKindDefOf<P, M, ActCtx>

/** Who a push is for; absent: every client socket. Both fields may be given, and a socket must pass both. */
export interface PushTo {
  /** only the sockets whose key holds that capability (this host's own window holds them all) */
  need?: Capability
  /** only the sockets whose caller could name this file itself, or every one of these files (`ctx.reaches`): a push about an item whose file is outside a remote key's roots never reaches that key */
  path?: string | readonly string[]
  /** only this host's own window, or only remote keys: one push in two shapes, as the canvas list is with paths a key may not see cut to file names */
  only?: 'local' | 'remote'
}
export type WorkSend = (p: WorkPush, to?: PushTo) => void

export interface WorkModule {
  id: PillarId
  /** `CREATE TABLE IF NOT EXISTS work_<id>_*`, and later columns behind a `pragma_table_info` check. Runs at every boot, Work on or off. */
  ensure(db: DatabaseSync): void
  /**
   * The pillar's own methods (`work.<id>.*`, `app.work<Id>*`); the router sends it no other.
   * `signal` aborts when the caller's socket goes or Work is turned off: a handler that runs
   * long (a conversion, a forwarded job) hands it on. The router always passes one; it is
   * optional so a module, or a module calling another's handle, may leave it out.
   */
  handle?(req: ClientRequest, ctx: WorkCtx, by: Caller, signal?: AbortSignal): Promise<Handled>
  /** Subscribes the module's own source; what it sends reaches every client socket, or only those `to` names. Returns its off. */
  onPush?(send: WorkSend): () => void
  /** One tool set for Claude, Codex and Muse. */
  tools?(scope: WorkScope): WorkTool[]
  acts?: ActKindDef[]
  /** The pillar's say on an add-on's tool; null: no say. */
  outward?(addon: AddonRow, tool: string, args: unknown): Verdict | null
  triggers?: TriggerSource[]
  /** Host jobs a routine may run in place of a model thread (docs/agents/work-routines.md "A routine that runs a job"). */
  jobs?: RoutineJob[]
  convert?: Converter[]
  /** The kinds of thing the composer's `@` finds in this pillar (work-canvas.md "Mentions"): each searches only within `reach`. */
  mentions?: MentionSource[]
  /** The kinds of thing Work search finds in this pillar (work-search.md "How a pillar registers"): each searches only within the ask's reach. A pillar with `mentions` and no `search` is found through them. */
  search?: SearchSource[]
  /** Joined, in module order, after the preamble's fixed head. */
  preamble?(scope: WorkScope): string | null
  /**
   * The pillar's say on one tool call of a thread, before it runs: words the model reads in place of the call's
   * answer, or null. Asked of every module by both funnels every call passes (narrowing.ts `callRefusalOf`): the
   * add-on catch (outbox/catch.ts), for every thread's add-on call and before the LifeOS row's run, and the Work
   * tool mount (work/ctx.ts `tools.call`), which serves Claude's `work` server and the bridge's `app.workCall`.
   * Any module's words refuse it. A throw refuses it too.
   */
  callRefusal?(ctx: WorkCtx, call: CallAsk): string | null
  /**
   * The harness's own tools this thread must not have (`Bash`, `WebFetch`), read once at its harness's start
   * (narrowing.ts `harnessDeniedOf`): Claude Code adds them to its denied tools, Codex starts the thread read-only
   * with no shell and no web. Called Work on or off.
   */
  harnessDenied?(sessionId: string): string[]
  /** Pollers and subscriptions. Never called while Work is off; its return stops them. */
  start?(ctx: WorkCtx): () => void
  /** Threads were deleted (a thread and its subagents): drop what the module kept for them. Called Work on or off. */
  sessionsRemoved?(sessionIds: string[], ctx: WorkCtx): void
  /**
   * Canvas items were deleted outright (a Files tab closed, or a deleted workspace's panes went): drop the rows and
   * files the module kept for them by item. Each item is as it was just before it went. Called Work on or off. A
   * deleted thread's items are not said here: `sessionsRemoved` covers them.
   */
  itemsRemoved?(items: CanvasItem[], ctx: WorkCtx): void
  /** A Work workspace was just made: store the module's own defaults for it (a stored choice, so turning one off sticks). */
  workspaceCreated?(workspaceId: string, ctx: WorkCtx): void
  /** A workspace was deleted: drop what the module kept for it. Called Work on or off. */
  workspaceRemoved?(workspaceId: string, ctx: WorkCtx): void
  /** The pillar's own connections on this host, for Connections (docs/agents/work-connections.md). */
  health?: HealthSource
  /** Every kind of news the pillar tells through `ctx.tell`, each with its group (docs/agents/work-digest.md). */
  tells?: TellKind[]
}

/** A host job a routine may run in place of a model thread: no thread, no model. */
export type RoutineJob = {
  /** '<pillar>.<what>', e.g. 'review.make' */
  id: string
  /** what the Routines view says it does, in plain words: 'Makes the week\'s review' */
  name: string
  /** `words`: the run's one-line outcome. `open`: what the run's row opens when pressed. A throw fails the run with its message. */
  run(ctx: WorkCtx, at: { workspaceId: string; firedAt: number }): Promise<{ words: string; open?: RoutineJobOpen }>
}

/**
 * How a pillar answers for its connections. `check` runs only when he opens
 * Connections or presses Check again, or a thread reads `work_connections`:
 * it must be cheap, and it never signs in, sends, starts or changes
 * anything. A row for what this host does not have (Office on the box)
 * is left out, not reported broken. `lapses` answers from what the host
 * already holds, with no network and no child process: the frame reads it
 * once a day to raise a notice before something ends.
 */
export interface HealthSource {
  check(ctx: WorkCtx, signal: AbortSignal): Promise<HealthRow[]>
  lapses?(ctx: WorkCtx): Lapse[]
}

/**
 * One kind `@` offers (work-canvas.md "Mentions"). A pillar lists its own on
 * its module's `mentions`; `work.canvas.mentions` asks every one in module
 * order. `search` answers at most `MENTION_PER_KIND` hits, newest or best
 * first, and never one outside `reach`: the sector, the workspace and the
 * thread it names are the fence.
 */
export interface MentionSource {
  kind: ChipKind
  /** read from LifeOS: the only kinds a code thread of a linked workspace is offered, and none while LifeOS is not connected */
  lifeos?: boolean
  /** `by`: who asked, where the router knows it (`work.canvas.mentions`); a kind fenced by the caller (Files) answers nothing without one */
  search(text: string, reach: MentionReach, ctx: WorkCtx, by?: Caller): Promise<MentionHit[]>
}

/** One tool call as `callRefusal` sees it. */
export interface CallAsk {
  /** the calling thread (a subagent's own id: a module walks to its root if it must) */
  sessionId: string
  /** the add-on catch, or the Work tool mount */
  via: 'addon' | 'work'
  /** `lifeos` for the app's own LifeOS row, another add-on's row id, or `work` (WORK_TOOL_SERVER) */
  server: string
  /** the tool's own short name: `archive_mail`, `files_trash` */
  tool: string
  /** what the call was asked with, where the funnel has it */
  args?: Readonly<Record<string, unknown>>
}

/** Who asked: a person at this host, a remote key, or a thread's own call through the bridge. */
export interface Caller {
  kind: 'local' | 'remote' | 'model'
  caps: readonly string[]
  sessionId?: string
  /** a remote call from another host of his, over the host link (`ctx.peer`), under this host's bridge policy for it: the host's id */
  peer?: string
  /** a remote key's id: what binds an upload it began to the key that sends its chunks (`attachment.*` answers its owner alone) */
  keyId?: string
}

/**
 * What one module may ask of the others. A pillar calls these and nothing
 * else across folders. Each member below names the milestone that builds
 * it; until then it throws `NotBuilt` (src/shared/work/ids.ts), from the
 * part file work/ctx.ts lists.
 */
export interface WorkCtx {
  db: DatabaseSync
  host: HostId
  /** <userData> on this host: a module keeps its files under `<dataDir>/<its own folder>` (the canvas: `canvas/`, media: `work-media/`) */
  dataDir: string
  /** the Work switch */
  enabled(): boolean
  log(line: string): void
  /** to every client socket, or only those `to` names */
  push(p: WorkPush, to?: PushTo): void
  /**
   * The listener's path fence (remote/fence.ts), for a file a module
   * reaches through an id rather than a path in the params: whether `by`
   * could have named `path` itself. This host's window and a thread's own
   * call always could; a remote key only under the app-managed roots
   * (index.ts `managedRoots`) and outside the denied folders. It answers
   * for this call's caller alone: what a module later sends to sockets
   * goes through `PushTo.path`, never on a model caller's yes, and a read
   * by id answers a remote key only what this admits.
   */
  reaches(by: Caller, path: string): boolean
  /** milestone 6; null for a code thread */
  scopeOf(sessionId: string): WorkScope | null
  /** F-mentions, in work/scope.ts: what `@` may offer the thread, or a draft by where it will be made; null: nothing */
  mentionReach(sessionId: string, draft?: { projectId?: string | null; workspaceId?: string | null; work?: boolean }): MentionReach | null
  settings: {
    workspace(id: string): WorkspaceWorkSettings
    set(id: string, patch: Partial<WorkspaceWorkSettings>): void
  }
  /** milestone 7 */
  lifeos: {
    connected(): boolean
    /** the host's device session */
    owner(): LifeosClient
    jwt(sector?: SectorKey): Promise<string>
    subscribe<T>(fn: string, args: unknown, on: (v: T) => void): () => void
  }
  /** milestone 7, over LifeOS `workLinks` */
  links: {
    link(about: ContextChip, sessionId: string, title: string): Promise<void>
    forThread(sessionId: string): Promise<WorkLink[]>
    /** completes the linked task with the thread link */
    completeFor(sessionId: string, reason: string): Promise<void>
  }
  /** milestone 9 */
  canvas: {
    open(sessionId: string, kind: CanvasKind, source: CanvasSource, title: string): CanvasItem
    close(itemId: string): void
    /** opens an item in `sessionId`'s pane in the place of `oldItemId` (closed when it is that pane's own): a Files tab that showed the old one follows to the new */
    replace(sessionId: string, oldItemId: string | null | undefined, kind: CanvasKind, source: CanvasSource, title: string): CanvasItem
    /** deletes items outright, with what every pillar kept for them (`itemsRemoved`): what closing a Files tab does to its item */
    remove(itemIds: readonly string[]): void
    /** runs `fn` with the canvas's pushes held back until it has returned, for a caller that changes items inside a savepoint of its own; a throw sends none */
    inside<T>(fn: () => T): T
    /** hears each replacement (`replace`) before the old item closes; returns its off */
    onReplaced(fn: (old: CanvasItem, next: CanvasItem) => void): () => void
    forSession(sessionId: string): CanvasItem[]
    /** the items of a workspace's threads, open and closed (`open`: open alone), newest change first; a pane owner's (the Mail view's, the Files place's tabs) only with `panes` */
    forWorkspace(workspaceId: string, opts?: { open?: boolean; panes?: boolean }): CanvasItem[]
    /** any item by id, open or closed; null when there is none (or its row no longer parses) */
    get(itemId: string): CanvasItem | null
    /** the thread whose pane a thread's items show in: its root thread (a subagent has none of its own) */
    paneOf(sessionId: string): string
    /** says an owner's open items again, for a caller that changed their rows itself (Files re-points a renamed file's items) */
    announce(owner: string): void
  }
  /** milestone 10 */
  held: {
    /** holds the act, or runs it at once if a grant fits */
    create(act: { kind: ActKind; sessionId: string | null; payload: unknown; account?: string }): HeldItem
    /** `asHeld`: the act's words as the thread wrote them, when the host kept them (outbox/earned.ts `wordsOf`); null otherwise */
    onDecided(fn: (item: HeldItem, asHeld: unknown) => void): () => void
  }
  /** milestone 14 */
  results: {
    add(r: { sessionId: string; kind: string; summary: string; account?: string; ref?: unknown; undo?: UndoSpec }): void
  }
  /** milestone 6, over SessionRegistry */
  threads: {
    /** `title` names the thread, and no model is asked for one. */
    start(o: { workspaceId: string; projectId?: string; text: string; model?: string; routineRunId?: string; about?: ContextChip; title?: string }): Promise<string>
    resume(sessionId: string, notice: string): Promise<void>
    /** whether the owner typed this quote in the thread; with `about`, in a message that also names one of those (work/threads.ts) */
    ownerSaid(sessionId: string, quote: string, about?: readonly string[]): boolean
    /** whether the thread is this host's and nobody has written in it yet: no message, so no turn */
    fresh(sessionId: string): boolean
    /**
     * Ends the harness a fresh thread may have started at its create (the registry boots one eagerly), so the next
     * send boots it under what the pillars say now (a mail chat's narrowing, its preamble part). A thread with a
     * message in it is left alone.
     */
    rearm(sessionId: string): Promise<void>
  }
  /** milestone 6: the cross-host route for Work tools, over `peer.call` */
  peer(host: HostId): { call(module: PillarId, verb: string, args: unknown): Promise<unknown> }
  /** milestone 18 */
  service: {
    url(route: string): string
    token(claims: CollabClaims): Promise<string>
    internal(route: string, body: unknown): Promise<unknown>
  }
  /** milestone 15 */
  convert(job: ConvertJob): Promise<ConvertResult>
  /**
   * The one way a pillar tells him something (work/digest/ctx.ts,
   * docs/agents/work-digest.md). Say what is true and, only when he alone
   * can unblock it, the time after which it is too late (`by`): the digest's
   * rule decides whether it interrupts or waits for the day's one notice.
   * Never throws, and does nothing while Work is off.
   */
  tell: {
    (t: Tell): void
    /** it is no longer true: the row goes, and a notice of it is withdrawn */
    done(key: string): void
    /** of the rows whose key starts with `prefix`, only `keys` are still true: every other is done. For a caller that tells a set (the held items, the clashes) and may have missed one leaving. */
    only(prefix: string, keys: readonly string[]): void
    /** this thread started on its own, not on his press: its done, failed and stuck wait for the digest */
    quiet(sessionId: string): void
  }
  /** the host's chunked uploads (attachmentUploads.ts), for a pillar that takes a file into a place of its own (`beginInto`); null only in a test that has none */
  uploads: AttachmentUploads | null
}

/** What a tool's `run` gets: the context, the calling thread and its scope. */
export interface ToolCtx extends WorkCtx {
  scope: WorkScope
  sessionId: string
  signal: AbortSignal
}

/** What an act's `execute` gets: the context, the held item and who decided. */
export interface ActCtx extends WorkCtx {
  item: HeldItem
  decidedBy: 'owner' | `grant:${string}`
}

export { inputShapeOf } from './toolInput'

/**
 * Every pillar that loaded, in `PILLAR_IDS`' order. Empty until
 * `loadWorkModules` has run: the host awaits it before `startWork`, and a
 * test that wants the whole registry awaits it first. The array is one
 * object for the life of the process, so a reader that holds it sees it
 * filled.
 */
export const WORK_MODULES: WorkModule[] = []

/** Why a pillar is not in `WORK_MODULES`: it could not be loaded. `startWork` answers its methods with this. */
export const WORK_LOAD_FAULTS = new Map<PillarId, string>()

/** One import per pillar, each its own: the only place a pillar's module is named. */
export type PillarLoaders = Record<PillarId, () => Promise<WorkModule>>
export const PILLAR_LOADERS: PillarLoaders = {
  outbox: () => import('./outbox').then((m) => m.outbox),
  canvas: () => import('./canvas').then((m) => m.canvas),
  lifeos: () => import('./lifeos').then((m) => m.lifeos),
  routines: () => import('./routines').then((m) => m.routines),
  rules: () => import('./rules').then((m) => m.rules),
  mail: () => import('./mail').then((m) => m.mail),
  messages: () => import('./messages').then((m) => m.messages),
  tasks: () => import('./tasks').then((m) => m.tasks),
  agenda: () => import('./agenda').then((m) => m.agenda),
  docs: () => import('./docs').then((m) => m.docs),
  history: () => import('./history').then((m) => m.history),
  formats: () => import('./formats').then((m) => m.formats),
  sheets: () => import('./sheets').then((m) => m.sheets),
  office: () => import('./office').then((m) => m.office),
  google: () => import('./google').then((m) => m.google),
  guests: () => import('./guests').then((m) => m.guests),
  pdf: () => import('./pdf').then((m) => m.pdf),
  slides: () => import('./slides').then((m) => m.slides),
  media: () => import('./media').then((m) => m.media),
  frameio: () => import('./frameio').then((m) => m.frameio),
  meetings: () => import('./meetings').then((m) => m.meetings),
  forms: () => import('./forms').then((m) => m.forms),
  dashboards: () => import('./dashboards').then((m) => m.dashboards),
  browser: () => import('./browser').then((m) => m.browser),
  projects: () => import('./projects').then((m) => m.projects),
  winvm: () => import('./winvm').then((m) => m.winvm),
  capture: () => import('./capture').then((m) => m.capture),
  files: () => import('./files').then((m) => m.files),
  prep: () => import('./prep').then((m) => m.prep),
  money: () => import('./money').then((m) => m.money),
  search: () => import('./search').then((m) => m.search),
  review: () => import('./review').then((m) => m.review),
  clashes: () => import('./clashes').then((m) => m.clashes),
  templates: () => import('./templates').then((m) => m.templates),
  digest: () => import('./digest').then((m) => m.digest)
}

let loaded: Promise<Map<PillarId, string>> | null = null

/** Whether the registry has been loaded (or is loading): `startWork` refuses the default list before that. */
export const workModulesAsked = (): boolean => loaded !== null

/**
 * Loads every pillar, each behind its own guard, and fills `WORK_MODULES`
 * with the ones that loaded. Never throws. Answers the pillars that did
 * not load and why. Once per process: a second call answers the first's
 * result. `loaders` is for a test (which then owns the registry's state:
 * a call with loaders always loads again).
 */
export function loadWorkModules(loaders?: PillarLoaders): Promise<Map<PillarId, string>> {
  if (loaded && !loaders) return loaded
  const run = (async () => {
    const use = loaders ?? PILLAR_LOADERS
    // One pillar at a time: pillars import one another's files in cycles, and two
    // loads of one cycle at once wait on each other forever under vitest's module
    // runner (office and files did on 2026-11-24). The app's main is CommonJS, where
    // each import() is a require that runs at once, so in order costs nothing there.
    const got: (WorkModule | string)[] = []
    for (const id of PILLAR_IDS) {
      try {
        const module = await use[id]()
        got.push(!module || module.id !== id || typeof module.ensure !== 'function' ? `work: ${id} did not load: its module is not the ${id} pillar's` : module)
      } catch (err) {
        got.push(`work: ${id} did not load: ${errorText(err)}`)
      }
    }
    WORK_LOAD_FAULTS.clear()
    const modules: WorkModule[] = []
    got.forEach((result, i) => {
      if (typeof result !== 'string') return void modules.push(result)
      console.error(`[work] ${result}`)
      WORK_LOAD_FAULTS.set(PILLAR_IDS[i], result)
    })
    WORK_MODULES.splice(0, WORK_MODULES.length, ...modules)
    return new Map(WORK_LOAD_FAULTS)
  })()
  loaded = run
  return run
}
