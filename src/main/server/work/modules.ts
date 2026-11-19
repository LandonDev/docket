import type { DatabaseSync } from 'node:sqlite'
import type { ZodType } from 'zod'
import type { Capability } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { AddonRow } from '@shared/contract-addons'
import type { WorkPush } from '@shared/contract-work'
import type {
  ActKind,
  ActKindDefOf,
  CanvasItem,
  CanvasKind,
  CanvasSource,
  ContextChip,
  Handled,
  HeldItem,
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
import type { ConvertJob, ConvertResult, Converter } from './formats/jobs'
import type { LifeosClient, WorkLink } from './lifeos/ctx'
import type { CollabClaims } from './service/ctx'
import { outbox } from './outbox'
import { canvas } from './canvas'
import { lifeos } from './lifeos'
import { routines } from './routines'
import { rules } from './rules'
import { mail } from './mail'
import { tasks } from './tasks'
import { agenda } from './agenda'
import { docs } from './docs'
import { history } from './history'
import { formats } from './formats'
import { sheets } from './sheets'
import { office } from './office'
import { google } from './google'
import { guests } from './guests'
import { pdf } from './pdf'
import { slides } from './slides'
import { media } from './media'
import { frameio } from './frameio'
import { meetings } from './meetings'
import { forms } from './forms'
import { dashboards } from './dashboards'
import { browser } from './browser'

/**
 * Work's server modules (docs/agents/work.md). One module per pillar, in
 * its own folder, mounted here once. A pillar fills
 * `src/main/server/work/<pillar>/index.ts` and edits nothing in this file:
 * its tables come from its `ensure`, its methods from `handle`, its tools
 * from `tools`, and so on. `startWork` (work/ctx.ts) and `ensureWorkTables`
 * (work/schema.ts) are the two places the list is read.
 */

/** A tool as a module registers it: `run(args, ctx: ToolCtx)`. */
export type WorkTool = WorkToolOf<ToolCtx>
/** An act kind as a module registers it: `execute(p, ctx: ActCtx)`. */
export type ActKindDef<P = unknown, M = unknown> = ActKindDefOf<P, M, ActCtx>

/** Who a push is for. `need`: only the sockets whose key holds that capability (this host's own window holds them all); absent: every client socket. */
export interface PushTo {
  need?: Capability
}
export type WorkSend = (p: WorkPush, to?: PushTo) => void

export interface WorkModule {
  id: PillarId
  /** `CREATE TABLE IF NOT EXISTS work_<id>_*`, and later columns behind a `pragma_table_info` check. Runs at every boot, Work on or off. */
  ensure(db: DatabaseSync): void
  /** The pillar's own methods (`work.<id>.*`, `app.work<Id>*`); the router sends it no other. */
  handle?(req: ClientRequest, ctx: WorkCtx, by: Caller): Promise<Handled>
  /** Subscribes the module's own source; what it sends reaches every client socket, or only those `to` names. Returns its off. */
  onPush?(send: WorkSend): () => void
  /** One tool set for Claude, Codex and Muse. */
  tools?(scope: WorkScope): WorkTool[]
  acts?: ActKindDef[]
  /** The pillar's say on an add-on's tool; null: no say. */
  outward?(addon: AddonRow, tool: string, args: unknown): Verdict | null
  triggers?: TriggerSource[]
  convert?: Converter[]
  /** Joined, in module order, after the preamble's fixed head. */
  preamble?(scope: WorkScope): string | null
  /** Pollers and subscriptions. Never called while Work is off; its return stops them. */
  start?(ctx: WorkCtx): () => void
  /** Threads were deleted (a thread and its subagents): drop what the module kept for them. Called Work on or off. */
  sessionsRemoved?(sessionIds: string[], ctx: WorkCtx): void
  /** A workspace was deleted: drop what the module kept for it. Called Work on or off. */
  workspaceRemoved?(workspaceId: string, ctx: WorkCtx): void
}

/** Who asked: a person at this host, a remote key, or a thread's own call through the bridge. */
export interface Caller {
  kind: 'local' | 'remote' | 'model'
  caps: readonly string[]
  sessionId?: string
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
  /** the Work switch */
  enabled(): boolean
  log(line: string): void
  /** to every client socket, or only those `to` names */
  push(p: WorkPush, to?: PushTo): void
  /** milestone 6; null for a code thread */
  scopeOf(sessionId: string): WorkScope | null
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
    forSession(sessionId: string): CanvasItem[]
  }
  /** milestone 10 */
  held: {
    /** holds the act, or runs it at once if a grant fits */
    create(act: { kind: ActKind; sessionId: string | null; payload: unknown; account?: string }): HeldItem
    onDecided(fn: (item: HeldItem) => void): () => void
  }
  /** milestone 14 */
  results: {
    add(r: { sessionId: string; kind: string; summary: string; account?: string; ref?: unknown; undo?: UndoSpec }): void
  }
  /** milestone 6, over SessionRegistry */
  threads: {
    start(o: { workspaceId: string; projectId?: string; text: string; model?: string; routineRunId?: string; about?: ContextChip }): Promise<string>
    resume(sessionId: string, notice: string): Promise<void>
    /** whether the owner typed this quote in the thread */
    ownerSaid(sessionId: string, quote: string): boolean
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

/** A tool's input must be a `z.object`: Claude's server registers its shape. */
export const inputShapeOf = (input: ZodType): Record<string, ZodType> | null => {
  const shape = (input as { shape?: unknown }).shape
  return shape && typeof shape === 'object' ? (shape as Record<string, ZodType>) : null
}

/** Every pillar, mounted once, in `PILLAR_IDS`' order. */
export const WORK_MODULES: WorkModule[] = [
  outbox,
  canvas,
  lifeos,
  routines,
  rules,
  mail,
  tasks,
  agenda,
  docs,
  history,
  formats,
  sheets,
  office,
  google,
  guests,
  pdf,
  slides,
  media,
  frameio,
  meetings,
  forms,
  dashboards,
  browser
]
