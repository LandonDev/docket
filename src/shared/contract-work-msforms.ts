import { z } from 'zod'
import type { HeldRef } from './work/acts'
import type { Principal } from './work/ids'
import { MSFORM_CHECKS, MS_QUESTION_TYPES, type MsAnyQuestion, type MsChange, type MsFormCheck, type MsFormSettings } from './work/msforms'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The Microsoft Forms pillar's wire (docs/agents/work-msforms.md): a real
 * Microsoft form made, opened, collected and read from Work. Its methods are
 * `work.msforms.<verb>` and its push `work.msforms`. The form, its sign-in
 * and its answers workbook stay Microsoft's; the host keeps one row a form
 * (no answer, name or address in it) and drives the page only through its
 * carrier on the box browser.
 */

// ── a form ───────────────────────────────────────────────────────────

const formId = z.string().regex(/^[A-Za-z0-9_.-]{20,200}$/)
const workspaceId = z.string().min(1).max(100)

export const MsQuestionSchema = z.object({
  ref: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
  title: z.string().trim().min(1).max(500),
  type: z.enum(MS_QUESTION_TYPES),
  long: z.boolean().optional(),
  multiple: z.boolean().optional(),
  dropdown: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  required: z.boolean().default(false),
  scale: z.union([z.literal(5), z.literal(10)]).optional()
})

export const MsChangeSchema: z.ZodType<MsChange> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), question: MsQuestionSchema, after: z.number().int().min(-1).max(200).nullable().optional() }),
  z.object({ op: z.literal('change'), at: z.number().int().min(0).max(200), question: MsQuestionSchema }),
  z.object({ op: z.literal('remove'), at: z.number().int().min(0).max(200) }),
  z.object({ op: z.literal('move'), at: z.number().int().min(0).max(200), to: z.number().int().min(0).max(200) })
]) as z.ZodType<MsChange>

/** The Teams or OneDrive library folder a form was made in, as Files names it. */
export interface MsFormFolder {
  libraryId: string
  /** the folder's path inside the library, `/`-joined, '' for its top */
  path: string
  /** the SharePoint site the library is in: `https://<tenant>.sharepoint.com/sites/<site>` or a personal site */
  siteUrl: string
  /** the folder's name for his eyes: the library then the folder */
  label?: string
}
export const MsFormFolderSchema = z.object({ libraryId: z.string().min(1).max(200), path: z.string().max(1000) })

/** The workbook Forms keeps the answers in, once "Open results in Excel" made it. */
export interface MsFormWorkbook {
  libraryId: string
  path: string
  siteUrl: string
  uniqueId: string
  parentId: string
  name: string
}

export type MsFormState = 'draft' | 'collecting' | 'closed'
export type MsFormMode = 'suggests' | 'writes'

/** An agent's change waiting for his Accept, in words. */
export interface MsSuggestion {
  id: string
  change: MsChange
  words: string
  reason?: string
  by: Principal
  at: number
}

/** A form as the canvas, the Forms view and the tools see it. */
export interface MsFormView {
  workspaceId: string
  formId: string
  tenant: string
  title: string
  folder: MsFormFolder
  workbook: MsFormWorkbook | null
  state: MsFormState
  mode: MsFormMode
  settings: MsFormSettings
  questions: MsAnyQuestion[]
  rev: number
  /** the last page read */
  readAt: number | null
  /** the last full read of the workbook */
  answersReadAt: number | null
  count: number
  lastAnswerAt: number | null
  check: MsFormCheck
  suggestions: MsSuggestion[]
  /** a held collect, audience or reopen and the rev it was held at */
  held: { ref: HeldRef; rev: number } | null
  /** the link people answer at, once collecting */
  link: string | null
  madeBy: Principal
  signedInAs: string | null
  updatedAt: number
  /** answers came in he has not looked at since */
  unseen: number
  /** what the carrier last could not finish, in words, until the next pass that did */
  stopped: string | null
  /** when it last stopped taking answers */
  closedAt: number | null
}

/** One row of the Forms view: ours and Microsoft's alike. */
export interface FormListRow {
  kind: 'ms' | 'ours'
  /** `ms`: the form id; `ours`: the canvas item id */
  id: string
  title: string
  state: string
  count: number
  lastAnswerAt: number | null
  updatedAt: number
}

/** The answers as the Responses half draws them (our forms' `FormResponses` shape), newest first. */
export interface MsFormResponses {
  rev: number
  columns: { id: string; label: string }[]
  rows: string[][]
  count: number
  cut: boolean
  /** when the rows were read from the workbook; null: never */
  at: number | null
  /** the last read could not finish: these are older rows */
  stale: boolean
  /** no workbook yet: answers have not reached one */
  none: boolean
}

// ── methods ──────────────────────────────────────────────────────────

const both = { workspaceId, formId }

export const MsformsRequestSchemas = [
  /** The job's Microsoft forms, newest first. */
  request('work.msforms.list', z.object({ workspaceId })),
  request('work.msforms.get', z.object(both)),
  /** What the window asks a Forms ticket with: the tenant and id, never an address. */
  request('work.msforms.page', z.object(both)),
  /** His New → Microsoft form in a Teams folder: the carrier makes it at once. */
  request('work.msforms.make', z.object({ workspaceId, folder: MsFormFolderSchema, title: z.string().trim().min(1).max(90) })),
  /** Holds Collect responses (`msform.publish`); the press is `work.outbox.send` on the answer's `ref`. */
  request('work.msforms.publish', z.object(both)),
  /** His close (open: false) or reopen. Not held: his own form. */
  request('work.msforms.close', z.object({ ...both, open: z.boolean() })),
  request('work.msforms.mode', z.object({ ...both, mode: z.enum(['suggests', 'writes']) })),
  request('work.msforms.check', z.object({ ...both, every: z.enum(MSFORM_CHECKS) })),
  /** Accept or reject waiting changes by id. */
  request('work.msforms.review', z.object({ ...both, accept: z.array(z.string().max(100)).max(200), reject: z.array(z.string().max(100)).max(200) })),
  /** The answers as last read, read again first when older than two minutes. */
  request('work.msforms.responses', z.object(both)),
  /** Read the form and its answers now (Refresh); presses Open results in Excel the first time. */
  request('work.msforms.refresh', z.object(both)),
  /** His Responses half was shown: what was new is seen. */
  request('work.msforms.seen', z.object(both)),
  /** The changes of the question list kept per rev. */
  request('work.msforms.history', z.object(both)),
  /** The forms each address answered, from what was read (People's Answered). */
  request('work.msforms.byPerson', z.object({ workspaceId, emails: z.array(z.string().max(320)).min(1).max(50) })),
  /** A meeting's follow-up survey: starts a Work thread about the event. */
  request('work.msforms.survey', z.object({ workspaceId, event: z.string().min(1).max(200) })),
  /** A prefilled link for the values he typed, read from Forms' own Get Pre-filled URL. */
  request('work.msforms.prefill', z.object({ ...both, values: z.record(z.string().max(80), z.string().max(500)) }))
] as const

export type MsformsPush = { push: 'work.msforms'; workspaceId: string; formId: string; view: MsFormView | null }

/** The owner's methods: a thread's own call is refused, it goes through the tools where the hold applies. */
export const MSFORMS_OWNER_ONLY: ReadonlySet<string> = new Set([
  'work.msforms.make',
  'work.msforms.publish',
  'work.msforms.close',
  'work.msforms.mode',
  'work.msforms.check',
  'work.msforms.review',
  'work.msforms.refresh',
  'work.msforms.seen',
  'work.msforms.survey',
  'work.msforms.prefill'
])

export const MSFORMS_CAPS = {
  'work.msforms.list': 'read',
  'work.msforms.get': 'read',
  'work.msforms.page': 'read',
  'work.msforms.make': 'operate',
  'work.msforms.publish': 'approve',
  'work.msforms.close': 'operate',
  'work.msforms.mode': 'operate',
  'work.msforms.check': 'operate',
  'work.msforms.review': 'operate',
  'work.msforms.responses': 'read',
  'work.msforms.refresh': 'operate',
  'work.msforms.seen': 'operate',
  'work.msforms.history': 'read',
  'work.msforms.byPerson': 'read',
  'work.msforms.survey': 'operate',
  'work.msforms.prefill': 'operate'
} satisfies CapsOf<typeof MsformsRequestSchemas>
export const MSFORMS_RELAY = {} satisfies RelayOf<typeof MsformsRequestSchemas>

export interface MsFormHistoryRow {
  rev: number
  at: number
  by: Principal | 'page'
  words: string[]
}

// ── the two held kinds ───────────────────────────────────────────────

const SettingsSchema = z.object({
  accepting: z.boolean(),
  orgOnly: z.boolean(),
  recordName: z.boolean(),
  onePerPerson: z.boolean(),
  startDate: z.string().max(40).optional(),
  endDate: z.string().max(40).optional()
})

/** `msform.publish`: collect responses, change who can answer, or reopen, exactly as held. */
export const MsFormPublishSchema = z.object({
  workspaceId,
  formId,
  rev: z.number().int().min(0),
  title: z.string().max(200),
  act: z.enum(['collect', 'audience', 'reopen']),
  settings: SettingsSchema,
  /** the form in words as people will see it */
  content: z.string().max(60_000)
})
export type MsFormPublish = z.infer<typeof MsFormPublishSchema>

/** `msform.make`: an agent's new form, in a Team or his OneDrive; `collect` also collects at the same press. */
export const MsFormMakeSchema = z.object({
  workspaceId,
  /** the asking thread, for the results row */
  sessionId: z.string().max(100).nullable(),
  folder: MsFormFolderSchema.extend({ siteUrl: z.string().max(1000), label: z.string().max(500).optional() }),
  title: z.string().trim().min(1).max(90),
  description: z.string().max(1000).default(''),
  questions: z.array(MsQuestionSchema).max(100),
  settings: SettingsSchema,
  collect: z.boolean().default(false),
  content: z.string().max(60_000)
})
export type MsFormMake = z.infer<typeof MsFormMakeSchema>
