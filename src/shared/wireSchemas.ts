import { z } from 'zod'
import { StartOnSchema } from './defaults'
import { SessionScopeSchema, WorkspaceKindSchema } from './work/ids'
import { WorkSettingsSchema } from './work/scope'
import { PillarIdSchema } from './work/ids'
import { ActKindSchema, HeldRefSchema } from './work/acts'
import { OutboxItemSchema, ToolHintsSchema, ToolRuleSchema, type OutboxGrant, type OutboxItem, type ToolRulesCard, type WorkResult } from './contract-work-outbox'
import { LifeosKeyStateSchema, LifeosStateSchema, type LifeosStatus } from './contract-work-lifeos'
import { AwayDecidedSchema, AwayStateSchema } from './away'
import { CanvasItemSchema, type CanvasItem } from './work/canvas'
import type { WorkspaceWorkSettings } from './work/scope'
import type { LifeosJwtAnswer } from './contract-work-lifeos'
import type { MailSendAnswer } from './contract-work-mail'
import type { GuestCreated } from './contract-work-guests'
import type { PdfView } from './contract-work-pdf'
import type { DeckView } from './contract-work-slides'
import type { MediaRange } from './contract-fsgit'
import { FrameTableSchema, type MediaView } from './contract-work-media'
import type { Meeting } from './contract-work-meetings'
import type { FormResponses } from './contract-work-forms'
import type { DashboardView } from './contract-work-dashboards'
import type { HistoryCompare, HistoryVersions } from './contract-work-history'
import { BROWSER_DRIVERS, PortalSourceSchema, type BrowserState } from './contract-work-browser'
import { ROUTINE_KINDS, RoutineEndsSchema, type RoutineRow } from './contract-work-routines'
import type { DraftEdit, EditOp, HouseRule, RuleProposal, RulesPage, VoiceFacts } from './contract-work-rules'
import { GUEST_ROLES, GuestSourceSchema, type GuestLinkRow } from './contract-work-guests'
import type { AccountPins, AccountProvider, AccountsSnapshot } from './accounts'
import { BatchStateSchema } from './contract-batch'
import { ComputerHistoryCallSchema, ComputerServiceStateSchema, ComputerSessionRowSchema, PREVIEW_END_REASONS, type ComputerSessionsAnswer } from './contract-computer'
import { VIDEO_REFUSALS, type VideoOpenAnswer } from './contract-video'
import type { DeployStatus, HostJobPhase, HostJobStatus } from './contract-host'
import { HostJobSchema } from './contract-host'
import { HostDevicesReportSchema, type HostDevicesHost } from './contract-hostdevices'
import type { MacBridgeThreadState } from './contract-macbridge'
import {
  THREAD_RESOURCE_KINDS,
  type ThreadResource,
  type ThreadResourceKind,
  type ThreadResourceRemoval
} from './contract-resources'
import type { BuildFacts } from './deployDrift'
import type { PortForwardInfo } from './contract-ports'
import type { PlanSettings } from './plans'
import { PlanSettingsSchema } from './plans'
import type { ReviewSettings } from './review'
import { ReviewSettingsSchema } from './review'
import type { BuildOutput, BuildRun, BuildStatus } from './build'
import {
  AGENT_TYPES,
  REASONING_LEVELS,
  type AgentType,
  type ModelInfo,
  type ProviderId,
  type ProviderInfo,
  type Reasoning
} from './catalog'
import type { Capability } from './capabilities'
import { PowerStateSchema, ScreenStateSchema, type HostPresence } from './contract-relay'
import type {
  QueuedMessage,
  QueueAddResult,
  ServerPush,
  SessionBatchResult,
  ThreadNotesDoc
} from './contract'
import type {
  FsMedia,
  GitHubPrDiff,
  GitHubPrFile,
  GitHubWorkItemComment,
  GitHubWorkItemDetails,
  GitHubWorkItemThread
} from './contract-fsgit'
import type {
  GithubInboxAuth,
  GithubInboxChecks,
  GithubInboxItem,
  GithubInboxPerson,
  GithubInboxRepo,
  GithubInboxReviewDecision,
  GithubInboxSnapshot
} from './contract-github'
import type {
  NoteSearchHit,
  NoteSearchResult,
  ProjectSearchMatch,
  ProjectSearchResult,
  SessionSearchHit,
  SessionSearchResult
} from './contract-m3a'
import {
  AudienceSchema,
  CapabilitySchema,
  PushEventSchema,
  WebhookEventSchema,
  type PushStatus,
  type RemoteKey,
  type RemotePairing,
  type RemoteSession,
  type RemoteStatus
} from './contract-remote'
import {
  ProjectModeSchema,
  ThreadTypeSchema,
  type FileChange,
  type ProjectMeta,
  type WorkspaceIcon,
  type WorkspaceMeta
} from './domain'
import {
  AgentEventSchema,
  BackgroundWorkSchema,
  FailureSchema,
  AttachmentSchema,
  NoticeKindSchema,
  PermissionPolicySchema,
  SessionStatusSchema,
  ToolPreviewSchema,
  type AgentEvent,
  type EventRow,
  type NoticeKind,
  type SessionMeta,
  type ToolPreview
} from './events'
import type { EventsPage, OmittedBody, SessionChanges, SessionPage } from './wire'
import type { HarnessEnvironmentStatus, HarnessSyncStatus } from './contract-harness'
import type { MemoryConflict, MemoryEnvironmentStatus, MemorySyncStatus } from './contract-memory'
import {
  MAC_METHODS,
  MacBridgePolicySchema,
  type MacBridgeActivity,
  type MacBridgeActivityHost,
  type MacBridgeCall,
  type MacBridgeHeld,
  type MacBridgeLoad
} from './contract-macbridge'

/**
 * The server → client shapes as zod, for clients that are not this
 * renderer: scripts/gen-swift-contract.ts turns them (and the request
 * params of src/shared/contract.ts) into the Swift package under
 * ios/TempCodeContract, and scripts/capture-swift-fixtures.ts parses every
 * captured frame with them before it becomes a fixture.
 *
 * The interfaces in events.ts, domain.ts, contract.ts, contract-remote.ts
 * and wire.ts stay the source of truth. Each schema here is pinned to its
 * interface by a type-level `Mirror` check at the bottom of the file: a
 * field added to SessionMeta without a line here fails the typecheck, and
 * so fails the release gate, before any Swift could drift.
 *
 * Numbers: a field is `.int()` only where the server computes an integer
 * (`Date.now()`, sequence numbers, counts); the Swift side maps integer to
 * Int and number to Double. Bodies: the remote profile (wire.ts) widens a
 * tool result's `output`, a preview's `lines` and `output` to
 * `string | OmittedBody`; the `Wire*` schemas carry that widening.
 */

// ── type pins ───────────────────────────────────────────────────────────

type Flat<T> = { [K in keyof T]: T[K] }
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type IsObject<T> = [T] extends [object]
  ? [T] extends [(...args: never) => unknown]
    ? false
    : true
  : false
type AllTrue<T> = T[keyof T] extends true ? true : false
/** `A` and `B` are mutually assignable and, at every object level, have the
 *  same keys, so an optional field added to one side is a difference too.
 *  Arrays compare by element. (The usual identity trick is not used: it
 *  gives up on deep types and answered both ways here.) Already checked
 *  pairs stop recursive types from walking the same fields forever. */
type SeenPair<A, B, Seen> = Seen extends [infer SA, infer SB]
  ? Equal<A, SA> extends true
    ? Equal<B, SB>
    : false
  : false
type Pin<A, B, Seen = never> = [A] extends [B]
  ? [B] extends [A]
    ? true extends SeenPair<A, B, Seen>
      ? true
      : PinKeys<A, B, Seen | [A, B]>
    : false
  : false
type PinKeys<A, B, Seen> = [NonNullable<A>] extends [(infer AU)[]]
  ? [NonNullable<B>] extends [(infer BU)[]]
    ? Pin<AU, BU, Seen>
    : false
  : IsObject<NonNullable<A>> extends true
    ? Equal<keyof NonNullable<A>, keyof NonNullable<B>> extends true
      ? AllTrue<{
          [K in keyof NonNullable<A>]-?: Pin<
            NonNullable<A>[K],
            NonNullable<B>[K & keyof NonNullable<B>],
            Seen
          >
        }>
      : false
    : true
/** The schema's output type is the interface: the same keys at every level, the same types. */
type Mirror<S extends z.ZodType, T> = Pin<z.infer<S>, T>
type Expect<T extends true> = T
/** A phone's narrowed view of `T`: every value of `T` is a value the schema reads (fields it leaves out are ignored). */
type Reads<S extends z.ZodType, T> = [T] extends [z.infer<S>] ? true : false
/** `K` of `T` kept opaque on the wire: a client never reads inside it. */
type Opaque<T, K extends keyof T> = Flat<Omit<T, K> & { [P in K]?: unknown }>

// ── catalog ─────────────────────────────────────────────────────────────

export const ProviderIdSchema = z.enum([
  'claude',
  'codex',
  'cursor',
  'grok',
  'opencode',
  'pi',
  'omp',
  'fx',
  'muse'
])
export const ReasoningSchema = z.enum(REASONING_LEVELS)
export const AgentTypeSchema = z.enum(AGENT_TYPES)
export const AccountProviderSchema = z.enum(['claude', 'codex', 'cursor', 'meta', 'muse'])
export const AccountPinsSchema = z.partialRecord(AccountProviderSchema, z.string())

// ── accounts on the wire (the phone's subset of accounts.ts) ────────────
// The desktop's ProfileView and UsageReport carry more; the phone reads the
// fields the chip, the menu's rows and the headroom bar need and ignores
// the rest (createdAt, syncedAt, plan, …).

/** The account fields the phone reads; the desktop's ProfileView carries more. */
export const AccountProfileSchema = z.object({
  name: z.string(),
  email: z.string().optional(),
  nickname: z.string().optional(),
  color: z.string().optional(),
  active: z.boolean(),
  duplicate: z.boolean().optional(),
  static: z.boolean().optional(),
  /** `key` for an API key (Meta): no usage windows, nothing to sign in to. */
  kind: z.enum(['key']).optional()
})
export const UsageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.number().int().optional(),
  periodMs: z.number().int().optional()
})
export const UsageReportSchema = z.object({
  profileName: z.string(),
  windows: z.array(UsageWindowSchema),
  note: z.string().optional(),
  expired: z.boolean().optional(),
  rateLimit: z.object({ provider: z.string(), until: z.number().int().optional() }).optional()
})
export const AccountHeadroomSchema = z.object({
  room: z.number().nullable(),
  resetsAt: z.number().int().optional(),
  throttledUntil: z.number().int().optional(),
  ratePerMin: z.number(),
  tier: z.string().optional(),
  seenAt: z.number().int().nullable()
})
export const ProviderAccountsSchema = z.object({
  pinned: z.string().nullable(),
  profiles: z.array(AccountProfileSchema),
  reports: z.array(UsageReportSchema),
  note: z.string().optional(),
  headroom: z.record(z.string(), AccountHeadroomSchema).optional()
})
export const AccountsSnapshotSchema = z.object({
  updatedAt: z.number().int(),
  providers: z.object({
    claude: ProviderAccountsSchema,
    codex: ProviderAccountsSchema,
    cursor: ProviderAccountsSchema,
    /** Meta Model API keys; optional so an older host's snapshot decodes. */
    meta: ProviderAccountsSchema.optional(),
    /** Muse Code logins; optional for the same reason. */
    muse: ProviderAccountsSchema.optional()
  })
})

export const ModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  reasoning: z.array(ReasoningSchema),
  defaultReasoning: ReasoningSchema.optional(),
  context: z.number().int().optional(),
  speedTiers: z.array(z.string()).optional(),
  minCodexVersion: z.string().optional(),
  vendor: z.enum(['meta']).optional()
})
export const ProviderInfoSchema = z.object({
  id: ProviderIdSchema,
  label: z.string(),
  models: z.array(ModelInfoSchema),
  defaultModel: z.string(),
  experimental: z.boolean().optional()
})
/** `catalog.get` → one entry per provider. */
export const CatalogSchema = z.record(ProviderIdSchema, ProviderInfoSchema)

// ── bodies off the wire (wire.ts) ───────────────────────────────────────

export const OmittedBodySchema = z.object({
  omitted: z.literal(true),
  bytes: z.number().int(),
  lines: z.number().int(),
  head: z.string()
})
/** A body slot on the remote profile: the text, or its OmittedBody. */
export const BodySchema = z.union([z.string(), OmittedBodySchema])

const previewLines = ToolPreviewSchema.shape.lines.unwrap()
export const WireToolPreviewSchema = ToolPreviewSchema.extend({
  lines: z.union([previewLines, OmittedBodySchema]).optional(),
  output: BodySchema.optional()
})

type ToolCallEvent = Extract<AgentEvent, { type: 'tool-call' }>
type ToolResultEvent = Extract<AgentEvent, { type: 'tool-result' }>
export type WireToolPreview = Flat<
  Omit<ToolPreview, 'lines' | 'output'> & {
    lines?: NonNullable<ToolPreview['lines']> | OmittedBody
    output?: string | OmittedBody
  }
>
/** An AgentEvent as a remote connection sees it (wire.ts projectEvent). */
export type WireAgentEvent =
  | Exclude<AgentEvent, ToolCallEvent | ToolResultEvent>
  | Flat<Omit<ToolCallEvent, 'preview'> & { preview?: WireToolPreview }>
  | Flat<Omit<ToolResultEvent, 'output'> & { output: string | OmittedBody }>

type EventBranch = z.ZodObject<{ type: z.ZodLiteral<string> }>
const eventBranches = AgentEventSchema.options as unknown as readonly EventBranch[]
const wireEventBranches = eventBranches.map((branch) => {
  switch (branch.shape.type.value) {
    case 'tool-result':
      return branch.extend({ output: BodySchema })
    case 'tool-call':
      return branch.extend({ preview: WireToolPreviewSchema.optional() })
    default:
      return branch
  }
})
/** Every row kind of events.ts, with the remote profile's body slots widened. */
export const WireAgentEventSchema = z.discriminatedUnion(
  'type',
  wireEventBranches as unknown as [EventBranch, ...EventBranch[]]
) as unknown as z.ZodType<WireAgentEvent>

export const EventRowSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int(),
  ts: z.number().int(),
  event: WireAgentEventSchema,
  ephemeral: z.boolean().optional()
})
export type WireEventRow = Flat<Omit<EventRow, 'event'> & { event: WireAgentEvent }>

export const EventsPageSchema = z.object({
  rows: z.array(EventRowSchema),
  moreBefore: z.boolean(),
  moreAfter: z.boolean(),
  reset: z.boolean(),
  subscribed: z.boolean().optional()
})
export type WireEventsPage = Flat<Omit<EventsPage, 'rows'> & { rows: WireEventRow[] }>

// ── sessions, projects, workspaces ──────────────────────────────────────

export const SessionMetaSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  threadType: ThreadTypeSchema.nullable(),
  planPath: z.string().nullable(),
  provider: ProviderIdSchema,
  model: z.string(),
  reasoning: ReasoningSchema,
  agentType: AgentTypeSchema,
  title: z.string(),
  cwd: z.string(),
  status: SessionStatusSchema,
  pinned: z.boolean(),
  archived: z.boolean(),
  permission: PermissionPolicySchema,
  fast: z.boolean(),
  ultrafast: z.boolean(),
  context1m: z.boolean(),
  busySince: z.number().int().nullable(),
  pausedAt: z.number().int().nullable(),
  frozenActiveElapsed: z.number().int().nullable(),
  nativeId: z.string().nullable(),
  account: z.string().nullable().optional(),
  activity: z.string().nullable().optional(),
  statusDetail: z.string().nullable().optional(),
  activityKind: z.enum(['think', 'investigate', 'edit']).nullable().optional(),
  background: BackgroundWorkSchema.nullable().optional(),
  awaiting: z.array(z.string()).optional(),
  lastEventAt: z.number().int().nullable().optional(),
  tasks: z
    .object({
      done: z.number().int(),
      total: z.number().int(),
      current: z.string().nullable().optional()
    })
    .nullable()
    .optional(),
  goal: z
    .object({ condition: z.string(), iterations: z.number().int(), setAt: z.number().int() })
    .nullable()
    .optional(),
  context: z
    .object({ tokens: z.number().int(), window: z.number().int().nullable() })
    .nullable()
    .optional(),
  canContinue: z.boolean().optional(),
  failure: FailureSchema.nullable().optional(),
  treeCanContinue: z.boolean().optional(),
  treeHasLiveWork: z.boolean().optional(),
  treeHasPaused: z.boolean().optional(),
  treeFrozenActiveElapsed: z.number().int().nullable().optional(),
  /** An orchestration run's tune (rules.ts): a large settings object no remote client reads. */
  threadRules: z.unknown().optional(),
  planCompletedAt: z.number().int().nullable().optional(),
  implementationId: z.string().nullable().optional(),
  planThreadId: z.string().nullable().optional(),
  startedBy: z.string().nullable().optional(),
  isMaster: z.boolean().optional(),
  masterId: z.string().nullable().optional(),
  after: z.string().nullable().optional(),
  readAt: z.number().int().optional(),
  scope: SessionScopeSchema.optional(),
  routineRunId: z.string().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

/** SessionMeta as a remote client reads it: `threadRules` opaque. */
export type WireSessionMeta = Opaque<SessionMeta, 'threadRules'>

export const SessionPageSchema = z.object({
  sessions: z.array(SessionMetaSchema),
  cursor: z.string().nullable()
})
export type WireSessionPage = Flat<Omit<SessionPage, 'sessions'> & { sessions: WireSessionMeta[] }>
/** `session.changes` on the phone: the flat shape of both members of
 *  `SessionChanges` (the reset answer simply omits the arrays). The generator's
 *  union support is string-tagged, so the discriminated-on-boolean union
 *  stays one object here; `WireSessionChangesPins` keeps it honest. */
export const SessionChangesSchema = z.object({
  reset: z.boolean(),
  seq: z.number().int(),
  generation: z.string(),
  sessions: z.array(SessionMetaSchema).optional(),
  removed: z.array(z.string()).optional()
})
export type WireSessionChanges = {
  reset: boolean
  seq: number
  generation: string
  sessions?: WireSessionMeta[]
  removed?: string[]
}
/** Both members of the server's `SessionChanges` are assignable to the flat wire shape. */
type Assignable<A, B> = [A] extends [B] ? true : false
type SessionChangesReset = Extract<SessionChanges, { reset: true }>
type SessionChangesDelta = Flat<
  Omit<Extract<SessionChanges, { reset: false }>, 'sessions'> & { sessions: WireSessionMeta[] }
>
export type WireSessionChangesPins = [
  Expect<Assignable<SessionChangesReset, WireSessionChanges>>,
  Expect<Assignable<SessionChangesDelta, WireSessionChanges>>
]

/** `session.reroute` → where the thread landed (sessions.ts `reroute`): the
 *  account it is on now, and whether that is a move. */
export const RerouteAnswerSchema = z.object({ account: z.string().nullable(), moved: z.boolean() })
export type RerouteAnswer = { account: string | null; moved: boolean }

/** `review.override` → the merge past a held review (mergeBranch.ts `MergeResult`). */
export const ReviewOverrideAnswerSchema = z.object({
  sha: z.string(),
  merged: z.boolean(),
  pushed: z.boolean()
})
export type ReviewOverrideAnswer = { sha: string; merged: boolean; pushed: boolean }

export const WorkspaceMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  git: z.boolean(),
  accountPins: AccountPinsSchema.optional(),
  githubRepo: z.string().nullable().optional(),
  githubRepoCheckedAt: z.number().int().nullable().optional(),
  preamble: z.string().nullable().optional(),
  preambleEnabled: z.boolean().optional(),
  linkId: z.string().nullable().optional(),
  kind: WorkspaceKindSchema.optional(),
  sector: z.string().nullable().optional(),
  createdAt: z.number().int()
})

export const WorkspaceIconSchema = z.object({
  dataUrl: z.string().nullable(),
  host: z.enum(['github', 'gitlab', 'bitbucket']).nullable()
})

export const ProjectMetaSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  mode: ProjectModeSchema,
  branch: z.string().nullable(),
  cwd: z.string(),
  archived: z.boolean(),
  accountPins: AccountPinsSchema.optional(),
  preamble: z.string().nullable().optional(),
  preambleEnabled: z.boolean().optional(),
  linkId: z.string().nullable().optional(),
  linkNote: z.string().nullable().optional(),
  settingsUpdatedAt: z.number().int().nullable().optional(),
  startOn: StartOnSchema.nullable().optional(),
  lifeosProjectId: z.string().nullable().optional(),
  createdAt: z.number().int()
})

/** `project.ensureLinked`'s answer: this host's copy of a linked project, or why there is none. */
export const EnsureLinkedResultSchema = z.object({
  /** where the copy's threads run; null when this host has no checkout for it */
  cwd: z.string().nullable(),
  /** the copy was already here (false: created by this call, or would be) */
  exists: z.boolean(),
  project: ProjectMetaSchema.nullable(),
  /** what kept the copy from being made, or what was done instead (a local copy for a failed worktree) */
  note: z.string().nullable()
})
export type EnsureLinkedResult = z.infer<typeof EnsureLinkedResultSchema>

export const FileChangeSchema = z.object({
  path: z.string(),
  adds: z.number().int(),
  dels: z.number().int(),
  status: z.enum(['modified', 'added', 'deleted', 'untracked', 'renamed'])
})

export const QueuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  ts: z.number().int(),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  /** the held-back boot's first message: already on the transcript as the user row, so the composer's queue skips it */
  stored: z.boolean().optional(),
  /** a steer waiting for the next turn: the id its `steer` rows name */
  steerId: z.string().optional()
})

/** queue.add's answer: the message waits in the list, or went into the live turn. */
export const QueueAddResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('queued'), item: QueuedMessageSchema }),
  z.object({ kind: z.literal('steered'), id: z.string() })
])

// ── search ─────────────────────────────────────────────────────────────

export const SessionSearchHitSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant']),
  snippet: z.string(),
  ts: z.number().int(),
  rank: z.number().optional(),
  source: z.enum(['notes']).optional()
})
export const SessionSearchResultSchema = z.object({
  hits: z.array(SessionSearchHitSchema),
  truncated: z.boolean()
})
export const ProjectSearchMatchSchema = z.object({
  path: z.string(),
  relative: z.string(),
  line: z.number().int(),
  column: z.number().int(),
  preview: z.string(),
  mtime: z.number().int().optional()
})
export const ProjectSearchResultSchema = z.object({
  matches: z.array(ProjectSearchMatchSchema),
  truncated: z.boolean()
})
export const NoteSearchHitSchema = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  updatedAt: z.number().int(),
  sourceCwd: z.string().optional()
})
export const NoteSearchResultSchema = z.object({
  hits: z.array(NoteSearchHitSchema),
  truncated: z.boolean()
})

// ── GitHub ─────────────────────────────────────────────────────────────

// ── the 2026-10-21/22 features: what each method answers and each push carries ──
// (CLAUDE.md "Master threads", "Thread notes", "Plans", "Review before merge",
// "Thread resources", the restart ledger, the launch mirror, devices, deploy,
// the Mac bridge's thread switch, accounts). The interface each pins to is
// named beside it.

// master threads (contract-batch.ts, contract.ts)
export const SessionBatchResultSchema = z.object({
  attempted: z.array(z.string()),
  succeeded: z.array(z.string()),
  failed: z.array(z.object({ sessionId: z.string(), error: z.string() }))
})
export const SessionStartedSchema = z.object({ started: z.boolean() })
export const BatchChildrenSchema = z.object({ children: z.array(SessionMetaSchema) })
export const BatchStoppedSchema = z.object({ stopped: z.boolean() })


// thread resources (contract-resources.ts); a port's forwards (contract-ports.ts)
export const PortForwardInfoSchema = z.object({
  environmentId: z.string(),
  hostName: z.string().nullable(),
  macPort: z.number().int().nullable(),
  error: z.string().nullable()
})
export const ThreadResourceKindSchema = z.enum(THREAD_RESOURCE_KINDS)
export const ThreadResourceSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  environmentId: z.string(),
  kind: ThreadResourceKindSchema,
  identifier: z.string(),
  label: z.string(),
  branch: z.string().nullable(),
  createdAt: z.number().int(),
  removeRequestedAt: z.number().int().nullable(),
  removedAt: z.number().int().nullable(),
  note: z.string().nullable(),
  pid: z.number().int().nullable().optional(),
  callId: z.string().nullable().optional(),
  what: z.string().nullable().optional(),
  forwards: z.array(PortForwardInfoSchema).optional()
})
export const ThreadResourceRemovalSchema = z.object({
  id: z.string(),
  outcome: z.enum(['removed', 'waiting', 'failed']),
  note: z.string().nullable()
})
export const ResourcesListSchema = z.object({ resources: z.array(ThreadResourceSchema) })
export const ResourcesRemovedSchema = z.object({ results: z.array(ThreadResourceRemovalSchema) })

// devices on a Mac (contract-hostdevices.ts has the report; the hosts row is an interface)
export const HostDevicesHostSchema = z.object({ environmentId: z.string(), name: z.string(), local: z.boolean() })
export const HostDevicesOkSchema = z.object({ ok: z.literal(true) })
export const HostDeviceOpenedSchema = z.object({ ok: z.literal(true), opened: z.enum(['devices', 'xcode']) })

// deploy from the app (contract-host.ts)
export const HostJobPhaseSchema = z.enum(['idle', 'pending', 'running', 'done'])
export const HostJobStatusSchema = z.object({
  job: HostJobSchema,
  phase: HostJobPhaseSchema,
  target: z.string().nullable(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  exit: z.number().int().nullable(),
  stoppable: z.boolean()
})
export const DeployStatusSchema = HostJobStatusSchema.extend({
  job: z.literal('deploy'),
  installed: z.boolean(),
  installHint: z.string(),
  version: z.string()
})
export const HostLogSnapshotSchema = z.object({ text: z.string(), status: HostJobStatusSchema })

// the Mac bridge's thread switch (contract-macbridge.ts MacBridgeThreadState)
export const MacBridgeThreadStateSchema = z.object({
  sessionId: z.string(),
  macPeer: z.string().nullable(),
  inherited: z.boolean(),
  online: z.boolean(),
  registered: z.array(z.string()),
  held: z.number().int().optional()
})

export const GithubInboxAuthSchema = z.object({
  state: z.enum(['ok', 'missing-gh', 'logged-out', 'error']),
  message: z.string()
})
export const GithubInboxPersonSchema = z.object({
  login: z.string(),
  avatarUrl: z.string()
})
export const GithubInboxChecksSchema = z
  .enum(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED'])
  .nullable()
export const GithubInboxReviewDecisionSchema = z.enum([
  '',
  'APPROVED',
  'CHANGES_REQUESTED',
  'REVIEW_REQUIRED'
])
export const GithubInboxItemSchema = z.object({
  kind: z.enum(['issue', 'pr']),
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  updatedAt: z.string(),
  author: GithubInboxPersonSchema.nullable(),
  assignees: z.array(GithubInboxPersonSchema),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  reviewDecision: GithubInboxReviewDecisionSchema,
  headRefName: z.string(),
  baseRefName: z.string(),
  checks: GithubInboxChecksSchema,
  reviewRequested: z.array(z.string())
})
export const GithubInboxRepoSchema = z.object({
  repo: z.string(),
  fetchedAt: z.number().int(),
  error: z.string().nullable(),
  items: z.array(GithubInboxItemSchema)
})
export const GithubInboxSnapshotSchema = z.object({
  viewer: z.string().nullable(),
  auth: GithubInboxAuthSchema,
  fetchedAt: z.number().int().nullable(),
  refreshing: z.boolean(),
  repos: z.array(GithubInboxRepoSchema)
})

export const GitHubWorkItemDetailsSchema = z.object({
  body: z.string(),
  author: z.string(),
  authorAvatarUrl: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  reviewDecision: z.string()
})
export const GitHubWorkItemCommentSchema = z.object({
  id: z.string(),
  kind: z.string(),
  author: z.string(),
  authorAvatarUrl: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
  state: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  resolved: z.boolean(),
  threadId: z.string(),
  get replies(): z.ZodArray<z.ZodLazy<typeof GitHubWorkItemCommentSchema>> {
    return z.array(z.lazy(() => GitHubWorkItemCommentSchema))
  }
})
export const GitHubWorkItemThreadSchema = z.object({
  comments: z.array(GitHubWorkItemCommentSchema),
  truncated: z.boolean(),
  reviewDecision: z.string(),
  baseRefName: z.string(),
  headRefName: z.string()
})
export const GitHubPrFileSchema = z.object({
  path: z.string(),
  additions: z.number().int(),
  deletions: z.number().int()
})
export const GitHubPrDiffSchema = z.object({
  additions: z.number().int(),
  deletions: z.number().int(),
  files: z.array(GitHubPrFileSchema),
  patch: z.string(),
  truncated: z.boolean()
})

// ── remote access ───────────────────────────────────────────────────────

export const RemoteStatusSchema = z.object({
  environmentId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  port: z.number().int(),
  configuredPort: z.number().int(),
  running: z.boolean(),
  error: z.string().nullable(),
  origin: z.string(),
  publicOrigin: z.string(),
  learnedOrigin: z.string().nullable(),
  contract: z.number().int(),
  stuckMinutes: z.number().int()
})

export const PushStatusSchema = z.object({
  registered: z.boolean(),
  relay: z.enum(['ok', 'none', 'failed']),
  error: z.string().nullable(),
  events: z.array(PushEventSchema),
  updatedAt: z.number().int().nullable()
})

export const RemoteKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  audience: AudienceSchema,
  caps: z.array(CapabilitySchema),
  kind: z.enum(['bearer', 'browser']),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
  createdBy: z.string(),
  webhookUrl: z.string().nullable(),
  events: z.array(WebhookEventSchema).nullable()
})

export const RemotePairingSchema = z.object({
  id: z.string(),
  name: z.string(),
  audience: AudienceSchema,
  caps: z.array(CapabilitySchema),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  consumedAt: z.number().int().nullable(),
  consumedBy: z.string().nullable()
})

export const RemoteSessionSchema = z.object({
  id: z.string(),
  keyId: z.string(),
  keyName: z.string(),
  caps: z.array(CapabilitySchema),
  userAgent: z.string().nullable(),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
  expiresAt: z.number().int()
})

/** `remote.keys.create` → the key and, once only, its token. */
export const CreatedKeySchema = z.object({
  key: RemoteKeySchema,
  token: z.string(),
  webhookSecret: z.string().optional()
})
/** `remote.pairings.create` → the pairing, its code and the link. */
export const CreatedPairingSchema = z.object({
  pairing: RemotePairingSchema,
  code: z.string(),
  url: z.string()
})

// ── the HTTP side of pairing (remote/listener.ts) ───────────────────────

/** What a host runs (src/shared/deployDrift.ts BuildFacts): release.json `n`, `1.0.N`, the commit, the platform. */
export const BuildFactsSchema = z.object({
  release: z.number().int(),
  version: z.string(),
  sha: z.string().nullable(),
  platform: z.string()
})

/** The relay's host rows (contract-relay.ts HostPresence): a host reachable through this one and its state. */
export { PowerStateSchema, ScreenStateSchema }
export const HostPresenceSchema = z.object({
  environmentId: z.string(),
  name: z.string(),
  platform: z.string(),
  link: z.enum(['up', 'down']),
  since: z.number().int(),
  screen: ScreenStateSchema,
  power: PowerStateSchema,
  saver: z.boolean().optional(),
  lastSeenAt: z.number().int().nullable(),
  build: BuildFactsSchema.nullable()
})

/** `GET /api/hello`: public, with `key` when the bearer was accepted. */
export const HelloResponseSchema = z.object({
  environmentId: z.string(),
  /** The hostname, version and build come only with a credential the host accepted. */
  name: z.string().optional(),
  version: z.string().optional(),
  build: BuildFactsSchema.optional(),
  contract: z.number().int(),
  key: z
    .object({
      id: z.string(),
      name: z.string(),
      caps: z.array(CapabilitySchema),
      audience: AudienceSchema
    })
    .optional(),
  /** Hosts reachable through this one with their presence (contract-relay.ts); with a credential the host accepted. */
  hosts: z.array(HostPresenceSchema).optional()
})
/** `POST /api/pair` with `kind: 'key'`: the raw key, readable once. */
export const PairKeyResponseSchema = z.object({
  key: z.string(),
  keyId: z.string(),
  name: z.string(),
  caps: z.array(CapabilitySchema),
  audience: AudienceSchema,
  environmentId: z.string()
})
/** `POST /api/ticket`: a single-use ticket for `/ws?ticket=…`. */
export const TicketResponseSchema = z.object({ ticket: z.string(), expiresIn: z.number().int() })
/** Any `/api/*` failure body. */
export const HttpErrorSchema = z.object({ error: z.string() })

/** fs.media: a file the viewer shows as media, served over `tempcode-asset://file` (and `/asset/file` remotely). */
export const FsMediaSchema = z.object({
  kind: z.enum(['image', 'video', 'audio']),
  mime: z.string(),
  url: z.string(),
  size: z.number().int(),
  mtimeMs: z.number()
})

export type HelloResponse = z.infer<typeof HelloResponseSchema>
export type PairKeyResponse = z.infer<typeof PairKeyResponseSchema>
export type TicketResponse = z.infer<typeof TicketResponseSchema>

// ── a host's activity, as the phone reads it (iOS thread 21) ─────────────
// The sync lines (contract-harness.ts, contract-memory.ts) and the Mac
// bridge's calls past the prompt (contract-macbridge.ts); the devices and
// the deploy job above are the subset's own.

/** `{ ok: true }`: the answer of every method that only acts. */
export const OkSchema = z.object({ ok: z.literal(true) })


export const HarnessEnvironmentStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean(),
  running: z.boolean(),
  files: z.number().int().nullable(),
  sets: z.record(z.string(), z.number().int()).nullable(),
  syncedAt: z.number().int().nullable(),
  lastAttemptAt: z.number().int().nullable(),
  error: z.string().nullable()
})
export const HarnessSyncStatusSchema = z.object({
  enabled: z.boolean(),
  skipped: z.number().int(),
  environments: z.array(HarnessEnvironmentStatusSchema),
  pathMap: z.object({ roots: z.record(z.string(), z.string()), prefixes: z.record(z.string(), z.string()) })
})
export const MemoryEnvironmentStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean(),
  running: z.boolean(),
  files: z.number().int().nullable(),
  syncedAt: z.number().int().nullable(),
  lastAttemptAt: z.number().int().nullable(),
  error: z.string().nullable(),
  conflicts: z.number().int()
})
export const MemoryConflictSchema = z.object({
  path: z.string(),
  of: z.string(),
  host: z.string(),
  at: z.number().int()
})
export const MemorySyncStatusSchema = z.object({
  enabled: z.boolean(),
  skipped: z.number().int(),
  environments: z.array(MemoryEnvironmentStatusSchema),
  conflicts: z.array(MemoryConflictSchema)
})

export const MacBridgeHeldSchema = z.object({
  reason: z.enum(['cap', 'load', 'computer']),
  position: z.number().int(),
  load: z.number(),
  limit: z.number(),
  cores: z.number().int(),
  maxRunning: z.number().int(),
  running: z.number().int(),
  computer: z.number().int().optional(),
  maxComputer: z.number().int().optional()
})
export const MacBridgeLoadSchema = z.object({
  load: z.number(),
  cores: z.number().int(),
  limit: z.number(),
  pinned: z.boolean(),
  resumeBelow: z.number(),
  busy: z.boolean(),
  sampledAt: z.number().int()
})
export const MacBridgeCallSchema = z.object({
  id: z.string(),
  environmentId: z.string(),
  hostName: z.string(),
  sessionId: z.string(),
  threadTitle: z.string(),
  kind: z.enum(['read', 'run', 'write', 'computer']),
  method: z.enum([...MAC_METHODS, 'mac.computer']),
  command: z.string().optional(),
  argv: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  path: z.string().optional(),
  computer: z.object({ app: z.string(), window: z.string().nullable() }).optional(),
  status: z.enum(['held', 'running', 'paused']),
  held: MacBridgeHeldSchema.optional(),
  interactive: z.literal(true).optional(),
  createdAt: z.number().int()
})
export const MacBridgeActivityHostSchema = z.object({
  environmentId: z.string(),
  name: z.string(),
  policy: MacBridgePolicySchema,
  registered: z.boolean(),
  maxRunning: z.number().int(),
  maxThreads: z.number().int(),
  running: z.number().int(),
  held: z.number().int(),
  threads: z.number().int(),
  pending: z.number().int()
})
export const MacBridgeActivitySchema = z.object({
  hosts: z.array(MacBridgeActivityHostSchema),
  load: MacBridgeLoadSchema,
  calls: z.array(MacBridgeCallSchema),
  at: z.number().int()
})

// ── pushes a remote socket receives ─────────────────────────────────────

const push = <P extends string, S extends z.ZodRawShape>(
  name: P,
  shape: S
): z.ZodObject<{ push: z.ZodLiteral<P> } & S> => z.object({ push: z.literal(name), ...shape })

export const HelloPushSchema = push('hello', {
  environmentId: z.string(),
  name: z.string().optional(),
  contract: z.number().int(),
  caps: z.array(CapabilitySchema),
  key: z.object({ id: z.string(), name: z.string() }).optional(),
  build: BuildFactsSchema.optional(),
  hosts: z.array(HostPresenceSchema).optional(),
  via: z.string().optional(),
  presence: HostPresenceSchema.optional()
})
export const ResyncPushSchema = push('resync', {})
/** A relayed host's presence changed: the whole list (contract-relay.ts). */
export const PresencePushSchema = push('presence', { hosts: z.array(HostPresenceSchema) })
export const WorkspacesPushSchema = push('workspaces', { workspaces: z.array(WorkspaceMetaSchema) })
export const ProjectsPushSchema = push('projects', { projects: z.array(ProjectMetaSchema) })
export const EventsPushSchema = push('events', {
  sessionId: z.string(),
  rows: z.array(EventRowSchema)
})
export const SessionsPushSchema = push('sessions', { sessions: z.array(SessionMetaSchema) })

export const LiveEditSchema = z.object({
  cwd: z.string(),
  sessionIds: z.array(z.string()),
  edit: z.object({
    path: z.string(),
    kind: z.enum(['changed', 'created', 'deleted']),
    adds: z.number().int().optional(),
    dels: z.number().int().optional(),
    diff: z.string().nullable(),
    bytes: z.number().int().optional(),
    burst: z.boolean().optional(),
    settled: z.boolean().optional(),
    ts: z.number().int()
  })
})
export const LiveEditsPushSchema = push('live-edits', { items: z.array(LiveEditSchema) })

export const BuildOutputSchema = z.object({
  path: z.string(),
  abs: z.string(),
  size: z.number().int(),
  mtimeMs: z.number(),
  fresh: z.boolean()
})
export const BuildRunSchema = z.object({
  id: z.string(),
  status: z.enum(['running', 'ok', 'failed', 'cancelled']),
  command: z.string(),
  cwd: z.string(),
  branch: z.string().nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().optional(),
  exitCode: z.number().int().optional(),
  outputs: z.array(BuildOutputSchema)
})
export const BuildUpdateSchema = z.object({
  projectId: z.string(),
  run: BuildRunSchema,
  lines: z.array(z.string()).optional()
})
export const BuildsPushSchema = push('builds', { items: z.array(BuildUpdateSchema) })
export const QueuePushSchema = push('queue', {
  sessionId: z.string(),
  items: z.array(QueuedMessageSchema)
})
/** A thread's notes as `session.notes.get` answers and the `notes` push carries (contract.ts ThreadNotesDoc). */
export const ThreadNotesDocSchema = z.object({
  text: z.string(),
  updatedAt: z.number().nullable(),
  path: z.string().nullable()
})
export const NotesPushSchema = push('notes', { sessionId: z.string(), doc: ThreadNotesDocSchema })
export const SessionRemovedPushSchema = push('session-removed', { sessionIds: z.array(z.string()) })
export const SessionMovedPushSchema = push('session-moved', { id: z.string(), sessionIds: z.array(z.string()), to: z.string() })
export const BootResumePushSchema = push('boot-resume', { count: z.number().int(), at: z.number().int() })
/** The whole accounts snapshot, to every socket, whenever it rebuilds (index.ts); headroom changes at most every 5 s. */
export const AccountsPushSchema = push('accounts', { snapshot: AccountsSnapshotSchema })
export const BatchPushSchema = push('batch', { state: BatchStateSchema })
export const ResourcesPushSchema = push('resources', {
  sessionId: z.string(),
  resources: z.array(ThreadResourceSchema)
})
export const HostDevicesPushSchema = push('host.devices', { report: HostDevicesReportSchema })
export const HostLogPushSchema = push('host-log', {
  job: HostJobSchema,
  append: z.string().optional(),
  reset: z.boolean().optional(),
  status: HostJobStatusSchema
})
export const MacBridgeHeldPushSchema = push('macBridge.held', { sessionId: z.string(), held: z.number().int() })
/** Work (contract-work.ts): the switch's state on the host, to every client. The phone reads it (milestone 46), and a pillar's pushes join the subset the same way. */
export const WorkPushSchema = push('work', { settings: WorkSettingsSchema })

// ── Work on the phone (milestone 46): the Outbox, Results, LifeOS's state and Away ──
export const UndoSpecSchema = z.object({ pillar: PillarIdSchema, verb: z.string(), args: z.unknown(), label: z.string().optional() })
export const WorkResultSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  rootId: z.string(),
  workspaceId: z.string().nullable(),
  kind: z.string(),
  summary: z.string(),
  account: z.string().nullable(),
  ref: z.unknown(),
  undo: UndoSpecSchema.nullable(),
  undoneAt: z.number().int().nullable(),
  createdAt: z.number().int()
})
export const OutboxGrantSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  kind: ActKindSchema,
  matcher: z.unknown(),
  label: z.string(),
  madeFrom: HeldRefSchema,
  routineId: z.string().nullable(),
  createdAt: z.number().int(),
  removedAt: z.number().int().nullable()
})
export const ToolRuleRowSchema = z.object({
  tool: z.string(),
  words: z.string(),
  description: z.string(),
  hints: ToolHintsSchema,
  suggested: z.enum(['runs', 'held']),
  rule: ToolRuleSchema.nullable(),
  changed: z.boolean()
})
export const ToolRulesCardSchema = z.object({
  addonId: z.string(),
  name: z.string(),
  workspaceId: z.string().nullable(),
  forWork: z.boolean(),
  lifeos: z.boolean(),
  unreviewed: z.number().int(),
  tools: z.array(ToolRuleRowSchema)
})
export const OutboxListSchema = z.object({ items: z.array(OutboxItemSchema), waiting: z.number().int() })
export const LifeosStatusSchema = z.object({ lifeos: LifeosStateSchema, keys: z.array(LifeosKeyStateSchema) })
export const AwaySnapshotSchema = z.object({ state: AwayStateSchema, decided: AwayDecidedSchema })
/** Something in the Outbox changed: how many wait, and the item that changed (no picture). To keys that can approve. */
export const WorkOutboxPushSchema = push('work.outbox', { waiting: z.number().int(), unreviewed: z.number().int(), failed: z.number().int().optional(), item: OutboxItemSchema.optional() })
/** A Result was made or undone. */
export const WorkOutboxResultPushSchema = push('work.outbox.result', { result: WorkResultSchema })
/** This host's LifeOS sign-in and its sector keys. */
export const WorkLifeosPushSchema = push('work.lifeos', { status: LifeosStatusSchema })
/** Away from computer: the state and the stretch's tally, on each change. */
export const AwayPushSchema = push('away', { state: AwayStateSchema, decided: AwayDecidedSchema })

// ── house rules (contract-work-rules.ts, milestone 39) on the phone ──
export const HouseRuleSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  text: z.string(),
  on: z.boolean(),
  proposalId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export const EditOpSchema = z.object({ op: z.enum(['=', '-', '+']), text: z.string() })
export const DraftEditSchema = z.object({ draftId: z.string(), to: z.string(), subject: z.string(), sentAt: z.number().int(), ops: z.array(EditOpSchema) })
export const RuleProposalSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  text: z.string(),
  line: z.string(),
  state: z.enum(['open', 'later', 'dismissed', 'added']),
  ruleId: z.string().nullable(),
  edits: z.array(DraftEditSchema),
  updatedAt: z.number().int()
})
export const RulesPageSchema = z.object({ rules: z.array(HouseRuleSchema), proposals: z.array(RuleProposalSchema) })
export const VoiceFactsSchema = z.object({ on: z.boolean(), count: z.number().int().nullable(), since: z.number().int().nullable(), from: z.array(z.string()), error: z.string().optional() })
/** A workspace's rules or proposals changed: a page on screen reads again. */
export const WorkRulesPushSchema = push('work.rules', { workspaceId: z.string() })

// ── guest links (contract-work-guests.ts, milestone 31) in the phone's Settings → Work ──
export const GuestLinkRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: GuestSourceSchema,
  title: z.string(),
  role: z.enum(GUEST_ROLES),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  revokedAt: z.number().int().nullable(),
  by: z.enum(['owner', 'agent']),
  lastOpenedAt: z.number().int().nullable(),
  open: z.number().int()
})
/** A host's guest links changed. */
export const WorkGuestsPushSchema = push('work.guests', {})
// ── Work on the phone, milestone 47: LifeOS's screens and a thread's items ──
// A phone view of a pillar's answer keeps only the fields the phone draws; its pin (`Reads`) holds
// that every one of them is still in the server's type, with the same meaning.
export const LifeosJwtAnswerSchema = z.object({
  ok: z.boolean(),
  jwt: z.string().optional(),
  expiresAt: z.number().int().optional(),
  url: z.string().optional(),
  state: z.string().optional()
})
export const MailSendAnswerSchema = z.object({ id: z.string(), via: z.enum(['hold', 'owner']) })
/** `video.open`'s answer, flat for the phone (its own union is tagged by a boolean): a stream and its ticket, or why not. */
export const VideoOpenWireSchema = z.object({
  ok: z.boolean(),
  stream: z.string().optional(),
  ticket: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fps: z.number().int().optional(),
  reason: z.enum(VIDEO_REFUSALS).optional()
})
/** `computer.sessions`: this host's service and every thread being driven on it, as the `computer` push carries them. */
export const ComputerSessionsAnswerSchema = z.object({ service: ComputerServiceStateSchema, sessions: z.array(ComputerSessionRowSchema) })
export const RulesForDraftSchema = z.object({ workspaceId: z.string().nullable(), proposals: z.array(RuleProposalSchema) })
export const WorkspaceWorkSettingsWireSchema = z.object({ mayUseDesktop: z.array(z.string()), model: z.string().optional(), reasoning: z.string().optional(), voice: z.boolean(), windowsVm: z.boolean().optional() })
export const GuestTicketSchema = z.object({ url: z.string(), expiresAt: z.number().int() })
export const GuestCreatedSchema = z.object({ link: GuestLinkRowSchema, url: z.string() })
export const CanvasItemsSchema = z.object({ items: z.array(CanvasItemSchema) })
/** A thread's open items changed: the whole list, in tab order; `opened` the one an open just showed. */
export const WorkCanvasPushSchema = push('work.canvas', { sessionId: z.string(), items: z.array(CanvasItemSchema), opened: z.string().optional() })
/** Bytes of a file the phone draws itself (a PDF, a deck's render), a frame at a time. */
export const FileBytesSchema = z.object({ data: z.string(), size: z.number(), rev: z.string() })
export const Base64DataSchema = z.object({ data: z.string() })
/** A slice of a media file by its token (`media.read`, admin): the phone's path to a proxy, an original or a picture. */
export const MediaRangeSchema = z.object({ dataBase64: z.string(), mime: z.string(), size: z.number(), mtimeMs: z.number() })
export const PdfPhoneViewSchema = z.object({ itemId: z.string(), name: z.string(), size: z.number(), rev: z.string(), missing: z.object({ asOf: z.number() }).optional() })
export const DeckPhoneViewSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  rev: z.string(),
  slides: z.array(
    z.object({
      key: z.string(),
      number: z.number().int().nullable(),
      title: z.string(),
      hidden: z.boolean(),
      from: z.enum(['file', 'proposed']),
      page: z.number().int(),
      change: z.string().nullable(),
      tint: z.enum(['add', 'del']).nullable()
    })
  ),
  changes: z.array(z.object({ id: z.string(), kind: z.enum(['changed', 'added', 'removed', 'moved']), slideId: z.number().int(), label: z.string() })),
  renders: z.object({ file: z.object({ rev: z.string(), size: z.number(), pages: z.number().int() }).nullable(), proposed: z.object({ rev: z.string(), size: z.number(), pages: z.number().int() }).nullable() }),
  renderError: z.string().optional()
})
export const MediaPlaySchema = z.discriminatedUnion('via', [
  z.object({ via: z.literal('original'), url: z.string(), mime: z.string(), table: FrameTableSchema }),
  z.object({ via: z.literal('proxy'), url: z.string(), table: FrameTableSchema, why: z.string() }),
  z.object({ via: z.literal('hls'), init: z.string(), segments: z.array(z.object({ start: z.number(), duration: z.number() })), ended: z.boolean(), mime: z.string(), table: FrameTableSchema, why: z.string() }),
  z.object({ via: z.literal('image'), url: z.string(), width: z.number(), height: z.number(), converted: z.string().optional() }),
  z.object({ via: z.literal('tiles'), preview: z.string(), width: z.number(), height: z.number(), tile: z.number(), overlap: z.number(), levels: z.number().int(), minLevel: z.number().int(), format: z.literal('jpg') })
])
export const MediaPhoneNoteSchema = z.object({
  id: z.string(),
  kind: z.enum(['comment', 'chapter']),
  anchor: z.object({ versionId: z.string(), frame: z.number().int().optional(), durationFrames: z.number().int().optional() }),
  body: z.string(),
  by: z.string(),
  state: z.enum(['kept', 'suggested']),
  resolved: z.boolean(),
  parentId: z.string().optional(),
  createdAt: z.number().int()
})
export const MediaPhoneViewSchema = z.object({
  itemId: z.string(),
  kind: z.enum(['video', 'image']),
  versions: z.array(
    z.object({
      id: z.string(),
      n: z.number().int(),
      name: z.string(),
      state: z.enum(['probing', 'preparing', 'ready', 'failed']),
      error: z.string().optional(),
      plays: z.array(MediaPlaySchema)
    })
  ),
  notes: z.array(MediaPhoneNoteSchema),
  rev: z.number().int()
})
export const MeetingPhoneSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  status: z.string(),
  error: z.string().optional(),
  durationSec: z.number(),
  speakers: z.array(z.object({ id: z.string(), label: z.string(), name: z.string().nullable() })),
  segments: z.array(z.object({ id: z.string(), speaker: z.string().nullable(), start: z.number(), end: z.number().nullable(), text: z.string() }))
})
export const MeetingAnswerSchema = z.object({ meeting: MeetingPhoneSchema.nullable() })
export const FormResponsesSchema = z.object({ rev: z.number().int(), columns: z.array(z.object({ id: z.string(), label: z.string() })), rows: z.array(z.array(z.string())), count: z.number().int(), cut: z.boolean() })
export const DashBlockPhoneSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('heading'), text: z.string() }),
  z.object({ id: z.string(), kind: z.literal('text'), text: z.string() }),
  z.object({ id: z.string(), kind: z.literal('figures'), figures: z.array(z.object({ id: z.string(), label: z.string(), sub: z.string().optional(), value: z.string().nullable() })) }),
  z.object({ id: z.string(), kind: z.literal('chart'), title: z.string(), bars: z.array(z.object({ label: z.string(), value: z.number() })) }),
  z.object({ id: z.string(), kind: z.literal('table'), title: z.string(), head: z.array(z.string()), rows: z.array(z.array(z.string())), numeric: z.array(z.boolean()) })
])
export const DashboardPhoneViewSchema = z.object({ itemId: z.string(), rev: z.number().int(), title: z.string(), blocks: z.array(DashBlockPhoneSchema), asOf: z.number().nullable(), stale: z.boolean(), failed: z.string().nullable() })
export const HistoryVersionsPhoneSchema = z.object({
  versions: z.array(z.object({ id: z.string(), at: z.number(), label: z.string().optional(), by: z.array(z.string()) })),
  shared: z.boolean(),
  names: z.record(z.string(), z.string())
})
const InlineOpWireSchema = z.object({ op: z.enum(['=', '-', '+']), text: z.string() })
export const HistoryComparePhoneSchema = z.object({
  diff: z.object({
    stats: z.object({ same: z.number().int(), added: z.number().int(), removed: z.number().int(), changed: z.number().int(), moved: z.number().int() }),
    rows: z.array(
      z.object({
        kind: z.enum(['added', 'removed', 'changed', 'moved']),
        id: z.string(),
        left: z.object({ text: z.string() }).optional(),
        right: z.object({ text: z.string() }).optional(),
        inline: z.array(InlineOpWireSchema).optional(),
        by: z.array(z.string()).optional()
      })
    )
  }),
  names: z.record(z.string(), z.string())
})
export const BrowserStateSchema = z.object({
  sessionId: z.string(),
  driver: z.enum(BROWSER_DRIVERS),
  needs: z.string().nullable(),
  site: z.object({ url: z.string(), name: z.string() }).nullable(),
  sources: z.array(PortalSourceSchema),
  since: z.number().int()
})
export const RoutinePhoneRowSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  kind: z.enum(ROUTINE_KINDS),
  name: z.string(),
  words: z.string(),
  ends: RoutineEndsSchema,
  enabled: z.boolean(),
  proposed: z.boolean(),
  nextAt: z.number().int().nullable(),
  lastAt: z.number().int().nullable(),
  running: z.boolean(),
  ended: z.boolean(),
  waiting: z.string().nullable()
})
export const RoutinesListSchema = z.object({ routines: z.array(RoutinePhoneRowSchema) })
/** A routine or watch changed on this host. */
export const WorkRoutinesPushSchema = push('work.routines', { workspaceId: z.string(), id: z.string() })

/** Computer use (contract-computer.ts): who is being driven on this host; the phone's Computers row reads it too. */
export const ComputerPushSchema = push('computer', {
  service: ComputerServiceStateSchema,
  sessions: z.array(ComputerSessionRowSchema)
})
/** The live preview (contract-computer.ts): to the Mac desktop's own socket, never a remote one. */
export const ComputerFramePushSchema = push('computer-frame', {
  preview: z.string(),
  seq: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  data: z.string()
})
export const ComputerClickPushSchema = push('computer-click', {
  preview: z.string(),
  at: z.array(z.number()),
  width: z.number().int(),
  height: z.number().int()
})
export const ComputerPreviewPushSchema = push('computer-preview', {
  preview: z.string(),
  state: z.enum(['live', 'ended']),
  reason: z.enum(PREVIEW_END_REASONS).optional(),
  app: z.string().optional(),
  window: z.string().nullable().optional(),
  target: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional()
})
/** The thread's computer history (contract-computer.ts): to the Mac desktop's own socket that read the key, never a remote one. */
export const ComputerHistoryPushSchema = push('computer-history', {
  key: z.string(),
  call: ComputerHistoryCallSchema.optional(),
  gone: z.literal(true).optional()
})

/**
 * Every push a remote connection can receive. Out by rule: the singular
 * `event`, `session`, `live-edit` and `build` frames (local sockets), the
 * peer-link pushes (`account`, `accounts-removed`, `memory.nudge`,
 * `release-available`, `live-work`, `peer.call`), the Mac's own renderer's
 * (`macBridge.request`, `macBridge.resolved`), `deploy-master`,
 * `file-event` and `sync`; a client that meets one keeps it as unknown.
 */
export const RemotePushSchema = z.discriminatedUnion('push', [
  HelloPushSchema,
  ResyncPushSchema,
  WorkspacesPushSchema,
  ProjectsPushSchema,
  EventsPushSchema,
  SessionsPushSchema,
  LiveEditsPushSchema,
  BuildsPushSchema,
  QueuePushSchema,
  NotesPushSchema,
  SessionRemovedPushSchema,
  SessionMovedPushSchema,
  BatchPushSchema,
  BootResumePushSchema,
  ResourcesPushSchema,
  AccountsPushSchema,
  HostDevicesPushSchema,
  HostLogPushSchema,
  MacBridgeHeldPushSchema,
  PresencePushSchema,
  WorkPushSchema,
  WorkOutboxPushSchema,
  WorkOutboxResultPushSchema,
  WorkLifeosPushSchema,
  AwayPushSchema,
  WorkRulesPushSchema,
  WorkGuestsPushSchema,
  WorkCanvasPushSchema,
  WorkRoutinesPushSchema,
  ComputerPushSchema
])

// ── the pins ────────────────────────────────────────────────────────────
// Each line fails the typecheck when the interface and the schema part.

type PushOf<P extends ServerPush['push']> = Extract<ServerPush, { push: P }>
export type WireSchemaPins = [
  Expect<Equal<z.infer<typeof ProviderIdSchema>, ProviderId>>,
  Expect<Equal<z.infer<typeof ReasoningSchema>, Reasoning>>,
  Expect<Equal<z.infer<typeof AgentTypeSchema>, AgentType>>,
  Expect<Equal<z.infer<typeof AccountProviderSchema>, AccountProvider>>,
  Expect<Mirror<typeof AccountPinsSchema, AccountPins>>,
  Expect<Mirror<typeof ModelInfoSchema, ModelInfo>>,
  Expect<Mirror<typeof ProviderInfoSchema, ProviderInfo>>,
  Expect<Equal<z.infer<typeof CapabilitySchema>, Capability>>,
  Expect<Mirror<typeof OmittedBodySchema, OmittedBody>>,
  Expect<Mirror<typeof WireToolPreviewSchema, WireToolPreview>>,
  Expect<Equal<WireAgentEvent['type'], AgentEvent['type']>>,
  Expect<AgentEvent extends WireAgentEvent ? true : false>,
  Expect<Mirror<typeof EventRowSchema, WireEventRow>>,
  Expect<Mirror<typeof EventsPageSchema, WireEventsPage>>,
  Expect<Mirror<typeof SessionMetaSchema, WireSessionMeta>>,
  Expect<Mirror<typeof SessionPageSchema, WireSessionPage>>,
  Expect<Mirror<typeof SessionChangesSchema, WireSessionChanges>>,
  Expect<Mirror<typeof RerouteAnswerSchema, RerouteAnswer>>,
  Expect<Mirror<typeof ReviewOverrideAnswerSchema, ReviewOverrideAnswer>>,
  Expect<Mirror<typeof WorkspaceMetaSchema, WorkspaceMeta>>,
  Expect<Mirror<typeof ProjectMetaSchema, ProjectMeta>>,
  Expect<Mirror<typeof WorkspaceIconSchema, WorkspaceIcon>>,
  Expect<Mirror<typeof SessionSearchHitSchema, SessionSearchHit>>,
  Expect<Mirror<typeof SessionSearchResultSchema, SessionSearchResult>>,
  Expect<Mirror<typeof ProjectSearchMatchSchema, ProjectSearchMatch>>,
  Expect<Mirror<typeof ProjectSearchResultSchema, ProjectSearchResult>>,
  Expect<Mirror<typeof NoteSearchHitSchema, NoteSearchHit>>,
  Expect<Mirror<typeof NoteSearchResultSchema, NoteSearchResult>>,
  Expect<Mirror<typeof GithubInboxAuthSchema, GithubInboxAuth>>,
  Expect<Mirror<typeof GithubInboxPersonSchema, GithubInboxPerson>>,
  Expect<Mirror<typeof GithubInboxItemSchema, GithubInboxItem>>,
  Expect<Mirror<typeof GithubInboxRepoSchema, GithubInboxRepo>>,
  Expect<Mirror<typeof GithubInboxSnapshotSchema, GithubInboxSnapshot>>,
  Expect<Mirror<typeof GitHubWorkItemDetailsSchema, GitHubWorkItemDetails>>,
  Expect<Mirror<typeof GitHubWorkItemCommentSchema, GitHubWorkItemComment>>,
  Expect<Mirror<typeof GitHubWorkItemThreadSchema, GitHubWorkItemThread>>,
  Expect<Mirror<typeof GitHubPrFileSchema, GitHubPrFile>>,
  Expect<Mirror<typeof GitHubPrDiffSchema, GitHubPrDiff>>,
  Expect<Equal<z.infer<typeof GithubInboxChecksSchema>, GithubInboxChecks>>,
  Expect<Equal<z.infer<typeof GithubInboxReviewDecisionSchema>, GithubInboxReviewDecision>>,
  Expect<Mirror<typeof FileChangeSchema, FileChange>>,
  Expect<Mirror<typeof QueuedMessageSchema, QueuedMessage>>,
  Expect<Equal<z.infer<typeof QueueAddResultSchema>, QueueAddResult>>,
  Expect<Mirror<typeof RemoteStatusSchema, RemoteStatus>>,
  Expect<Mirror<typeof PushStatusSchema, PushStatus>>,
  Expect<Mirror<typeof RemoteKeySchema, RemoteKey>>,
  Expect<Mirror<typeof RemotePairingSchema, RemotePairing>>,
  Expect<Mirror<typeof RemoteSessionSchema, RemoteSession>>,
  Expect<Mirror<typeof FsMediaSchema, FsMedia>>,
  Expect<Mirror<typeof BuildOutputSchema, BuildOutput>>,
  Expect<Equal<z.infer<typeof BuildRunSchema>['status'], BuildStatus>>,
  Expect<Mirror<typeof BuildRunSchema, BuildRun>>,
  Expect<Mirror<typeof HostPresenceSchema, HostPresence>>,
  Expect<Mirror<typeof HelloPushSchema, PushOf<'hello'>>>,
  Expect<Mirror<typeof ResyncPushSchema, PushOf<'resync'>>>,
  Expect<Mirror<typeof PresencePushSchema, PushOf<'presence'>>>,
  Expect<Mirror<typeof WorkspacesPushSchema, PushOf<'workspaces'>>>,
  Expect<Mirror<typeof ProjectsPushSchema, PushOf<'projects'>>>,
  Expect<
    Mirror<typeof EventsPushSchema, Flat<Omit<PushOf<'events'>, 'rows'> & { rows: WireEventRow[] }>>
  >,
  Expect<
    Mirror<
      typeof SessionsPushSchema,
      Flat<Omit<PushOf<'sessions'>, 'sessions'> & { sessions: WireSessionMeta[] }>
    >
  >,
  Expect<Mirror<typeof LiveEditsPushSchema, PushOf<'live-edits'>>>,
  Expect<Mirror<typeof BuildsPushSchema, PushOf<'builds'>>>,
  Expect<Mirror<typeof QueuePushSchema, PushOf<'queue'>>>,
  Expect<Mirror<typeof SessionRemovedPushSchema, PushOf<'session-removed'>>>,
  Expect<Mirror<typeof SessionMovedPushSchema, PushOf<'session-moved'>>>,
  // the 2026-10-21/22 features
  Expect<Equal<z.infer<typeof NoticeKindSchema>, NoticeKind>>,
  Expect<Mirror<typeof BuildFactsSchema, BuildFacts>>,
  Expect<Mirror<typeof SessionBatchResultSchema, SessionBatchResult>>,
  Expect<Mirror<typeof BatchChildrenSchema, { children: WireSessionMeta[] }>>,
  Expect<Mirror<typeof ThreadNotesDocSchema, ThreadNotesDoc>>,
  Expect<Equal<z.infer<typeof ReviewSettingsSchema>, ReviewSettings>>,
  Expect<Equal<z.infer<typeof PlanSettingsSchema>, PlanSettings>>,
  Expect<Equal<z.infer<typeof ThreadResourceKindSchema>, ThreadResourceKind>>,
  Expect<Mirror<typeof ThreadResourceSchema, ThreadResource>>,
  Expect<Mirror<typeof PortForwardInfoSchema, PortForwardInfo>>,
  Expect<Mirror<typeof ThreadResourceRemovalSchema, ThreadResourceRemoval>>,
  Expect<Mirror<typeof SessionBatchResultSchema, SessionBatchResult>>,
  Expect<Mirror<typeof ResourcesPushSchema, PushOf<'resources'>>>,
  // The account shapes are subsets of the desktop's (ProfileView carries
  // more), so the check is `extends`, as AgentEvent's is.
  Expect<AccountsSnapshot extends z.infer<typeof AccountsSnapshotSchema> ? true : false>,
  Expect<PushOf<'accounts'>['snapshot'] extends z.infer<typeof AccountsSnapshotSchema> ? true : false>,
  Expect<Mirror<typeof HostDevicesHostSchema, HostDevicesHost>>,
  Expect<Equal<z.infer<typeof HostJobPhaseSchema>, HostJobPhase>>,
  Expect<Mirror<typeof HostJobStatusSchema, HostJobStatus>>,
  Expect<Mirror<typeof DeployStatusSchema, DeployStatus>>,
  Expect<Mirror<typeof MacBridgeThreadStateSchema, MacBridgeThreadState>>,
  Expect<Mirror<typeof NotesPushSchema, PushOf<'notes'>>>,
  Expect<Mirror<typeof BatchPushSchema, PushOf<'batch'>>>,
  Expect<Mirror<typeof BootResumePushSchema, PushOf<'boot-resume'>>>,
  Expect<Mirror<typeof HostDevicesPushSchema, PushOf<'host.devices'>>>,
  Expect<Mirror<typeof HostLogPushSchema, PushOf<'host-log'>>>,
  Expect<Mirror<typeof MacBridgeHeldPushSchema, PushOf<'macBridge.held'>>>,
  Expect<Mirror<typeof WorkPushSchema, PushOf<'work'>>>,
  Expect<Mirror<typeof WorkOutboxPushSchema, PushOf<'work.outbox'>>>,
  Expect<Mirror<typeof WorkOutboxResultPushSchema, PushOf<'work.outbox.result'>>>,
  Expect<Mirror<typeof WorkLifeosPushSchema, PushOf<'work.lifeos'>>>,
  Expect<Mirror<typeof AwayPushSchema, PushOf<'away'>>>,
  Expect<Mirror<typeof WorkRulesPushSchema, PushOf<'work.rules'>>>,
  Expect<Mirror<typeof WorkGuestsPushSchema, PushOf<'work.guests'>>>,
  Expect<Mirror<typeof WorkCanvasPushSchema, PushOf<'work.canvas'>>>,
  Expect<Mirror<typeof WorkRoutinesPushSchema, PushOf<'work.routines'>>>,
  Expect<Mirror<typeof CanvasItemSchema, CanvasItem>>,
  Expect<Mirror<typeof MailSendAnswerSchema, MailSendAnswer>>,
  Expect<Mirror<typeof GuestCreatedSchema, GuestCreated>>,
  Expect<Mirror<typeof FormResponsesSchema, FormResponses>>,
  Expect<Mirror<typeof BrowserStateSchema, BrowserState>>,
  Expect<Mirror<typeof MediaRangeSchema, MediaRange>>,
  Expect<Reads<typeof LifeosJwtAnswerSchema, LifeosJwtAnswer>>,
  Expect<Reads<typeof VideoOpenWireSchema, VideoOpenAnswer>>,
  Expect<Mirror<typeof ComputerSessionsAnswerSchema, ComputerSessionsAnswer>>,
  Expect<Reads<typeof WorkspaceWorkSettingsWireSchema, WorkspaceWorkSettings>>,
  Expect<Reads<typeof PdfPhoneViewSchema, PdfView>>,
  Expect<Reads<typeof DeckPhoneViewSchema, DeckView>>,
  Expect<Reads<typeof MediaPhoneViewSchema, MediaView>>,
  Expect<Reads<typeof MeetingPhoneSchema, Meeting>>,
  Expect<Reads<typeof DashboardPhoneViewSchema, DashboardView>>,
  Expect<Reads<typeof HistoryVersionsPhoneSchema, HistoryVersions>>,
  Expect<Reads<typeof HistoryComparePhoneSchema, HistoryCompare>>,
  Expect<Reads<typeof RoutinePhoneRowSchema, RoutineRow>>,
  // what rules/store.ts proposalsForDraft answers (a draft with no row: no workspace)
  Expect<Mirror<typeof RulesForDraftSchema, { workspaceId: string | null; proposals: RuleProposal[] }>>,
  Expect<Mirror<typeof GuestLinkRowSchema, GuestLinkRow>>,
  Expect<Mirror<typeof HouseRuleSchema, HouseRule>>,
  Expect<Mirror<typeof EditOpSchema, EditOp>>,
  Expect<Mirror<typeof DraftEditSchema, DraftEdit>>,
  Expect<Mirror<typeof RuleProposalSchema, RuleProposal>>,
  Expect<Mirror<typeof RulesPageSchema, RulesPage>>,
  Expect<Mirror<typeof VoiceFactsSchema, VoiceFacts>>,
  Expect<Mirror<typeof WorkResultSchema, WorkResult>>,
  Expect<Mirror<typeof OutboxGrantSchema, OutboxGrant>>,
  Expect<Mirror<typeof OutboxItemSchema, OutboxItem>>,
  Expect<Mirror<typeof ToolRulesCardSchema, ToolRulesCard>>,
  Expect<Mirror<typeof LifeosStatusSchema, LifeosStatus>>,
  Expect<Mirror<typeof ComputerPushSchema, PushOf<'computer'>>>,
  Expect<Mirror<typeof ComputerFramePushSchema, PushOf<'computer-frame'>>>,
  Expect<Mirror<typeof ComputerClickPushSchema, PushOf<'computer-click'>>>,
  Expect<Mirror<typeof ComputerPreviewPushSchema, PushOf<'computer-preview'>>>,
  Expect<Mirror<typeof ComputerHistoryPushSchema, PushOf<'computer-history'>>>,
  Expect<Mirror<typeof HarnessEnvironmentStatusSchema, HarnessEnvironmentStatus>>,
  Expect<Mirror<typeof HarnessSyncStatusSchema, HarnessSyncStatus>>,
  Expect<Mirror<typeof MemoryEnvironmentStatusSchema, MemoryEnvironmentStatus>>,
  Expect<Mirror<typeof MemoryConflictSchema, MemoryConflict>>,
  Expect<Mirror<typeof MemorySyncStatusSchema, MemorySyncStatus>>,
  Expect<Mirror<typeof MacBridgeHeldSchema, MacBridgeHeld>>,
  Expect<Mirror<typeof MacBridgeLoadSchema, MacBridgeLoad>>,
  Expect<Mirror<typeof MacBridgeCallSchema, MacBridgeCall>>,
  Expect<Mirror<typeof MacBridgeActivityHostSchema, MacBridgeActivityHost>>,
  Expect<Mirror<typeof MacBridgeActivitySchema, MacBridgeActivity>>
]
