import { z } from 'zod'
import type { MethodCapability } from './capabilities'
import type { PillarId } from './work/ids'
import type { WorkSettings } from './work/scope'
import { request, type CapsOf } from './work/wire'
import { OUTBOX_CAPS, OUTBOX_RELAY, OutboxRequestSchemas, type OutboxPush } from './contract-work-outbox'
import { CANVAS_CAPS, CANVAS_RELAY, CanvasRequestSchemas, type CanvasPush } from './contract-work-canvas'
import { LIFEOS_CAPS, LIFEOS_RELAY, LifeosRequestSchemas, type LifeosPush } from './contract-work-lifeos'
import { ROUTINES_CAPS, ROUTINES_RELAY, RoutinesRequestSchemas, type RoutinesPush } from './contract-work-routines'
import { RULES_CAPS, RULES_RELAY, RulesRequestSchemas, type RulesPush } from './contract-work-rules'
import { MAIL_CAPS, MAIL_RELAY, MailRequestSchemas, type MailPush } from './contract-work-mail'
import { TASKS_CAPS, TASKS_RELAY, TasksRequestSchemas, type TasksPush } from './contract-work-tasks'
import { AGENDA_CAPS, AGENDA_RELAY, AgendaRequestSchemas, type AgendaPush } from './contract-work-agenda'
import { DOCS_CAPS, DOCS_RELAY, DocsRequestSchemas, type DocsPush } from './contract-work-docs'
import { HISTORY_CAPS, HISTORY_RELAY, HistoryRequestSchemas, type HistoryPush } from './contract-work-history'
import { FORMATS_CAPS, FORMATS_RELAY, FormatsRequestSchemas, type FormatsPush } from './contract-work-formats'
import { SHEETS_CAPS, SHEETS_RELAY, SheetsRequestSchemas, type SheetsPush } from './contract-work-sheets'
import { OFFICE_CAPS, OFFICE_RELAY, OfficeRequestSchemas, type OfficePush } from './contract-work-office'
import { GOOGLE_CAPS, GOOGLE_RELAY, GoogleRequestSchemas, type GooglePush } from './contract-work-google'
import { GUESTS_CAPS, GUESTS_RELAY, GuestsRequestSchemas, type GuestsPush } from './contract-work-guests'
import { PDF_CAPS, PDF_RELAY, PdfRequestSchemas, type PdfPush } from './contract-work-pdf'
import { SLIDES_CAPS, SLIDES_RELAY, SlidesRequestSchemas, type SlidesPush } from './contract-work-slides'
import { MEDIA_CAPS, MEDIA_RELAY, MediaRequestSchemas, type MediaPush } from './contract-work-media'
import { FRAMEIO_CAPS, FRAMEIO_RELAY, FrameioRequestSchemas, type FrameioPush } from './contract-work-frameio'
import { MEETINGS_CAPS, MEETINGS_RELAY, MeetingsRequestSchemas, type MeetingsPush } from './contract-work-meetings'
import { FORMS_CAPS, FORMS_RELAY, FormsRequestSchemas, type FormsPush } from './contract-work-forms'
import { DASHBOARDS_CAPS, DASHBOARDS_RELAY, DashboardsRequestSchemas, type DashboardsPush } from './contract-work-dashboards'
import { BROWSER_CAPS, BROWSER_RELAY, BrowserRequestSchemas, type BrowserPush } from './contract-work-browser'
import { PROJECTS_CAPS, PROJECTS_RELAY, ProjectsRequestSchemas, type ProjectsPush } from './contract-work-projects'
import { WINVM_CAPS, WINVM_RELAY, WinvmRequestSchemas, type WinvmPush } from './contract-work-winvm'
import { CAPTURE_CAPS, CAPTURE_RELAY, CaptureRequestSchemas, type CapturePush } from './contract-work-capture'
import { FILES_CAPS, FILES_RELAY, FilesRequestSchemas, type FilesPush } from './contract-work-files'
import { PREP_CAPS, PREP_RELAY, PrepRequestSchemas, type PrepPush } from './contract-work-prep'
import { MONEY_CAPS, MONEY_RELAY, MoneyRequestSchemas, type MoneyPush } from './contract-work-money'
import { SEARCH_CAPS, SEARCH_RELAY, SearchRequestSchemas, type SearchPush } from './contract-work-search'
import { REVIEW_CAPS, REVIEW_RELAY, ReviewRequestSchemas, type ReviewPush } from './contract-work-review'
import { CLASHES_CAPS, CLASHES_RELAY, ClashesRequestSchemas, type ClashesPush } from './contract-work-clashes'
import { TEMPLATES_CAPS, TEMPLATES_RELAY, TemplatesRequestSchemas, type TemplatesPush } from './contract-work-templates'

/**
 * Work over the wire (docs/agents/work.md): the core's own methods, then
 * one contract file per pillar. This is the only place a pillar's contract
 * is mounted: `contract.ts` spreads `WorkRequestSchemas` and unions
 * `WorkPush`, `capabilities.ts` spreads `WORK_CAPS`. A pillar fills its own
 * `contract-work-<pillar>.ts` and edits nothing here.
 */

/** The bridge's own MCP request id, as `app.computer` carries it. */
const BridgeCallSchema = z.union([z.string(), z.number()])

export const WorkCoreRequestSchemas = [
  /** → WorkSettings: the Work switch on this host */
  z.object({ id: z.string(), method: z.literal('work.get'), params: z.object({}).optional() }),
  /** → WorkSettings: sets it, on this host alone; a client writes it to every host it is linked to */
  request('work.set', z.object({ enabled: z.boolean() })),
  /** → WorkspaceWorkSettings: a workspace's own Work settings (`workspaces.work_settings`) */
  request('work.workspace.get', z.object({ workspaceId: z.string() })),
  /** → WorkspaceWorkSettings: changes them on the workspace's host; what the patch leaves out stays */
  request(
    'work.workspace.set',
    z.object({
      workspaceId: z.string(),
      patch: z.object({ mayUseDesktop: z.array(z.string()).optional(), model: z.string().nullable().optional(), reasoning: z.string().nullable().optional(), voice: z.boolean().optional(), windowsVm: z.boolean().optional() })
    })
  ),
  /** → ProjectMeta: the project that holds a Work workspace's threads about one LifeOS project, made at the first ask. The host asks LifeOS for the project and its name; `name` is what an older client still sends, and is not read. */
  request('work.project.open', z.object({ workspaceId: z.string(), lifeosProjectId: z.string().min(1), name: z.string().max(200).optional(), forSettings: z.boolean().optional() })),
  /** → HealthReport: every connection Work leans on, as this host's pillars answer for them now (docs/agents/work-connections.md); checks that change nothing */
  request('work.health', z.object({}).optional()),
  /** → Lapse[]: what ends on this host and when, read from what it holds, soonest first */
  request('work.lapses', z.object({}).optional()),
  // The codex and Muse bridge (scripts/app-mcp-bridge.mjs): `token` is the
  // thread's own, so one thread's bridge never lists or calls as another.
  /** → AppWorkToolsAnswer: the Work tools of the thread's scope, as the bridge lists them */
  request('app.workTools', z.object({ sessionId: z.string(), token: z.string() })),
  /** → WorkToolResult */
  request('app.workCall', z.object({ sessionId: z.string(), token: z.string(), call: BridgeCallSchema, tool: z.string(), args: z.record(z.string(), z.unknown()) })),
  /** → null: the harness gave the call up; the tool's signal aborts */
  request('app.workCancel', z.object({ sessionId: z.string(), token: z.string(), call: BridgeCallSchema }))
] as const

/** The switch changed on this host: to every client socket. */
export type WorkSettingsPush = { push: 'work'; settings: WorkSettings }

export const WORK_CORE_CAPS = {
  'work.get': 'read',
  'work.set': 'admin',
  'work.workspace.get': 'read',
  'work.workspace.set': 'admin',
  'work.project.open': 'operate',
  'work.health': 'read',
  'work.lapses': 'read',
  'app.workTools': 'local',
  'app.workCall': 'local',
  'app.workCancel': 'local'
} satisfies CapsOf<typeof WorkCoreRequestSchemas>

export const WorkRequestSchemas = [
  ...WorkCoreRequestSchemas,
  ...OutboxRequestSchemas,
  ...CanvasRequestSchemas,
  ...LifeosRequestSchemas,
  ...RoutinesRequestSchemas,
  ...RulesRequestSchemas,
  ...MailRequestSchemas,
  ...TasksRequestSchemas,
  ...AgendaRequestSchemas,
  ...DocsRequestSchemas,
  ...HistoryRequestSchemas,
  ...FormatsRequestSchemas,
  ...SheetsRequestSchemas,
  ...OfficeRequestSchemas,
  ...GoogleRequestSchemas,
  ...GuestsRequestSchemas,
  ...PdfRequestSchemas,
  ...SlidesRequestSchemas,
  ...MediaRequestSchemas,
  ...FrameioRequestSchemas,
  ...MeetingsRequestSchemas,
  ...FormsRequestSchemas,
  ...DashboardsRequestSchemas,
  ...BrowserRequestSchemas,
  ...ProjectsRequestSchemas,
  ...WinvmRequestSchemas,
  ...CaptureRequestSchemas,
  ...FilesRequestSchemas,
  ...PrepRequestSchemas,
  ...MoneyRequestSchemas,
  ...SearchRequestSchemas,
  ...ReviewRequestSchemas,
  ...ClashesRequestSchemas,
  ...TemplatesRequestSchemas
] as const

export type WorkPush =
  | WorkSettingsPush
  | OutboxPush
  | CanvasPush
  | LifeosPush
  | RoutinesPush
  | RulesPush
  | MailPush
  | TasksPush
  | AgendaPush
  | DocsPush
  | HistoryPush
  | FormatsPush
  | SheetsPush
  | OfficePush
  | GooglePush
  | GuestsPush
  | PdfPush
  | SlidesPush
  | MediaPush
  | FrameioPush
  | MeetingsPush
  | FormsPush
  | DashboardsPush
  | BrowserPush
  | ProjectsPush
  | WinvmPush
  | CapturePush
  | FilesPush
  | PrepPush
  | MoneyPush
  | SearchPush
  | ReviewPush
  | ClashesPush
  | TemplatesPush

export const WORK_CAPS = {
  ...WORK_CORE_CAPS,
  ...OUTBOX_CAPS,
  ...CANVAS_CAPS,
  ...LIFEOS_CAPS,
  ...ROUTINES_CAPS,
  ...RULES_CAPS,
  ...MAIL_CAPS,
  ...TASKS_CAPS,
  ...AGENDA_CAPS,
  ...DOCS_CAPS,
  ...HISTORY_CAPS,
  ...FORMATS_CAPS,
  ...SHEETS_CAPS,
  ...OFFICE_CAPS,
  ...GOOGLE_CAPS,
  ...GUESTS_CAPS,
  ...PDF_CAPS,
  ...SLIDES_CAPS,
  ...MEDIA_CAPS,
  ...FRAMEIO_CAPS,
  ...MEETINGS_CAPS,
  ...FORMS_CAPS,
  ...DASHBOARDS_CAPS,
  ...BROWSER_CAPS,
  ...PROJECTS_CAPS,
  ...WINVM_CAPS,
  ...CAPTURE_CAPS,
  ...FILES_CAPS,
  ...PREP_CAPS,
  ...MONEY_CAPS,
  ...SEARCH_CAPS,
  ...REVIEW_CAPS,
  ...CLASHES_CAPS,
  ...TEMPLATES_CAPS
}

/** Each pillar's own requests, capability rows and relay rows, for the guards (contract-work.test.ts) and the router. */
export const WORK_PILLAR_CONTRACTS: Record<PillarId, { requests: readonly z.ZodType[]; caps: Record<string, MethodCapability>; relay: Record<string, 'screen' | 'never'> }> = {
  outbox: { requests: OutboxRequestSchemas, caps: OUTBOX_CAPS, relay: OUTBOX_RELAY },
  canvas: { requests: CanvasRequestSchemas, caps: CANVAS_CAPS, relay: CANVAS_RELAY },
  lifeos: { requests: LifeosRequestSchemas, caps: LIFEOS_CAPS, relay: LIFEOS_RELAY },
  routines: { requests: RoutinesRequestSchemas, caps: ROUTINES_CAPS, relay: ROUTINES_RELAY },
  rules: { requests: RulesRequestSchemas, caps: RULES_CAPS, relay: RULES_RELAY },
  mail: { requests: MailRequestSchemas, caps: MAIL_CAPS, relay: MAIL_RELAY },
  tasks: { requests: TasksRequestSchemas, caps: TASKS_CAPS, relay: TASKS_RELAY },
  agenda: { requests: AgendaRequestSchemas, caps: AGENDA_CAPS, relay: AGENDA_RELAY },
  docs: { requests: DocsRequestSchemas, caps: DOCS_CAPS, relay: DOCS_RELAY },
  history: { requests: HistoryRequestSchemas, caps: HISTORY_CAPS, relay: HISTORY_RELAY },
  formats: { requests: FormatsRequestSchemas, caps: FORMATS_CAPS, relay: FORMATS_RELAY },
  sheets: { requests: SheetsRequestSchemas, caps: SHEETS_CAPS, relay: SHEETS_RELAY },
  office: { requests: OfficeRequestSchemas, caps: OFFICE_CAPS, relay: OFFICE_RELAY },
  google: { requests: GoogleRequestSchemas, caps: GOOGLE_CAPS, relay: GOOGLE_RELAY },
  guests: { requests: GuestsRequestSchemas, caps: GUESTS_CAPS, relay: GUESTS_RELAY },
  pdf: { requests: PdfRequestSchemas, caps: PDF_CAPS, relay: PDF_RELAY },
  slides: { requests: SlidesRequestSchemas, caps: SLIDES_CAPS, relay: SLIDES_RELAY },
  media: { requests: MediaRequestSchemas, caps: MEDIA_CAPS, relay: MEDIA_RELAY },
  frameio: { requests: FrameioRequestSchemas, caps: FRAMEIO_CAPS, relay: FRAMEIO_RELAY },
  meetings: { requests: MeetingsRequestSchemas, caps: MEETINGS_CAPS, relay: MEETINGS_RELAY },
  forms: { requests: FormsRequestSchemas, caps: FORMS_CAPS, relay: FORMS_RELAY },
  dashboards: { requests: DashboardsRequestSchemas, caps: DASHBOARDS_CAPS, relay: DASHBOARDS_RELAY },
  browser: { requests: BrowserRequestSchemas, caps: BROWSER_CAPS, relay: BROWSER_RELAY },
  projects: { requests: ProjectsRequestSchemas, caps: PROJECTS_CAPS, relay: PROJECTS_RELAY },
  winvm: { requests: WinvmRequestSchemas, caps: WINVM_CAPS, relay: WINVM_RELAY },
  capture: { requests: CaptureRequestSchemas, caps: CAPTURE_CAPS, relay: CAPTURE_RELAY },
  files: { requests: FilesRequestSchemas, caps: FILES_CAPS, relay: FILES_RELAY },
  prep: { requests: PrepRequestSchemas, caps: PREP_CAPS, relay: PREP_RELAY },
  money: { requests: MoneyRequestSchemas, caps: MONEY_CAPS, relay: MONEY_RELAY },
  search: { requests: SearchRequestSchemas, caps: SEARCH_CAPS, relay: SEARCH_RELAY },
  review: { requests: ReviewRequestSchemas, caps: REVIEW_CAPS, relay: REVIEW_RELAY },
  clashes: { requests: ClashesRequestSchemas, caps: CLASHES_CAPS, relay: CLASHES_RELAY },
  templates: { requests: TemplatesRequestSchemas, caps: TEMPLATES_CAPS, relay: TEMPLATES_RELAY }
}

/**
 * What a relayed lane does with a Work method (contract-relay.ts spreads
 * both): every one a key can hold is carried to the host the lane names, so
 * the phone reaches a workspace that lives on the Mac, and writes the
 * switch there, through the box. A pillar's relay row narrows that:
 * `'screen'` carries it only while that host is unlocked, `'never'` keeps
 * it on this host. Both hosts gate the capability. A `local` method never
 * crosses.
 */
const relayRows: Record<string, 'screen' | 'never'> = Object.assign({}, ...Object.values(WORK_PILLAR_CONTRACTS).map((c) => c.relay))
const remoteMethods = Object.entries(WORK_CAPS as Record<string, MethodCapability>)
  .filter(([, cap]) => cap !== 'local')
  .map(([method]) => method)
export const WORK_RELAY: Partial<Record<keyof typeof WORK_CAPS, 'link' | 'screen'>> = Object.fromEntries(
  remoteMethods.filter((method) => relayRows[method] !== 'never').map((method) => [method, relayRows[method] === 'screen' ? ('screen' as const) : ('link' as const)])
)
export const WORK_NOT_CARRIED = remoteMethods.filter((method) => relayRows[method] === 'never') as (keyof typeof WORK_CAPS)[]
