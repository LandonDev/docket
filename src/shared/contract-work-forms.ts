import { z } from 'zod'
import type { HeldRef } from './work/acts'
import type { CanvasSource } from './work/canvas'
import type { Principal } from './work/ids'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The forms pillar's wire (docs/agents/work-forms.md): a form in the canvas
 * pane, its questions, then its responses. Its methods are
 * `work.forms.<verb>` and its push `work.forms`; src/shared/work/wire.ts has
 * the helpers and the rules.
 *
 * A form is the host's row. Publishing it shares a link, so it is held
 * (`form.publish`) until the owner presses; closing and reopening are not.
 * Answers come in through the Work service at `/f/<publicId>` and are
 * written as rows of a sheet, which is where responses live.
 */

// ── a form ───────────────────────────────────────────────────────────

/** `section` is a heading between questions; it takes no answer. */
export const FORM_QUESTION_TYPES = ['short', 'long', 'choice', 'dropdown', 'section'] as const
export type FormQuestionType = (typeof FORM_QUESTION_TYPES)[number]

export const FORM_QUESTIONS_MAX = 100
export const FORM_OPTIONS_MAX = 50
/** The longest answer the public page takes: a short answer, then a long one. */
export const FORM_ANSWER_MAX = { short: 500, long: 5000 } as const

const qid = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)
export const FormQuestionSchema = z.object({
  id: qid,
  label: z.string().trim().min(1).max(300),
  type: z.enum(FORM_QUESTION_TYPES),
  required: z.boolean().default(false),
  /** a choice's or a dropdown's answers, in order */
  options: z.array(z.string().trim().min(1).max(200)).max(FORM_OPTIONS_MAX).optional()
})
export type FormQuestion = z.infer<typeof FormQuestionSchema>

export const FormBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(''),
  questions: z.array(FormQuestionSchema).max(FORM_QUESTIONS_MAX)
})
export type FormBody = z.infer<typeof FormBodySchema>

/** An agent's change waiting for the owner: a question added after `after` (null: first), changed to `question`, or removed. */
export interface FormSuggestion {
  id: string
  op: 'add' | 'change' | 'remove'
  question: FormQuestion
  after?: string | null
  reason?: string
  by: Principal
  at: number
}

export type FormMode = 'suggests' | 'writes'
export type FormState = 'draft' | 'open' | 'closed'

export interface FormView {
  itemId: string
  rev: number
  body: FormBody
  state: FormState
  /** what an agent's change does before the form is published; once published every change waits */
  mode: FormMode
  suggestions: FormSuggestion[]
  /** the public page, once published */
  link: string | null
  publishedAt: number | null
  closedAt: number | null
  /** a publish waiting for his press, and the rev it was held at */
  held: { ref: HeldRef; rev: number } | null
  /** where the answers are written, to open as a sheet */
  sheet: CanvasSource | null
  /** what an agent last wrote directly, for the line in the stepper's place */
  written: { text: string; at: number } | null
}

/** The answers as the canvas shows them: one row each, newest first, in the order of `columns`. */
export interface FormResponses {
  rev: number
  /** question ids, then `submitted` */
  columns: { id: string; label: string }[]
  rows: string[][]
  count: number
  /** true when more rows are in the sheet than were read */
  cut: boolean
}

/** What the public page reads: the published form and whether it takes answers. */
export interface PublicForm {
  title: string
  description: string
  questions: FormQuestion[]
  open: boolean
}

/**
 * What main writes for the Work service to serve (`<work-service>/forms/<publicId>.json`):
 * the form as it was last published or saved by the owner, and where answers go.
 */
export interface PublishedForm extends PublicForm {
  publicId: string
  /** the responses sheet, as the service's sheet host names it */
  sheet: { lifeos: string } | { tcsheet: string }
  /** the sheet's columns after A (Submitted), by question id */
  columns: string[]
}

export const FORM_PUBLIC_ID = /^[A-Za-z0-9_-]{16}$/
/** The responses sheet's column A, filled on every answer. */
export const FORM_SUBMITTED = 'Submitted'

// ── methods ──────────────────────────────────────────────────────────

const itemId = z.string().min(1).max(100)

export const FormsRequestSchemas = [
  /** The form, its state and what waits; then the `work.forms` push. */
  request('work.forms.open', z.object({ itemId })),
  /** The owner's own edit: the whole form at the rev he edited. A published form's page changes at once. */
  request('work.forms.save', z.object({ itemId, rev: z.number().int().min(0), body: FormBodySchema })),
  /** Accept or reject waiting changes, by id or all. */
  request('work.forms.review', z.object({ itemId, which: z.union([z.object({ ids: z.array(z.string().max(100)).min(1).max(200) }), z.literal('all')]), verdict: z.enum(['accept', 'reject']) })),
  request('work.forms.mode', z.object({ itemId, mode: z.enum(['suggests', 'writes']) })),
  /** Holds the publish; the press is `work.outbox.send` on the answer's `held.ref`. */
  request('work.forms.publish', z.object({ itemId })),
  /** Close (open: false) or reopen the published form. Not held: it stops or restarts answers on his own form. */
  request('work.forms.close', z.object({ itemId, open: z.boolean() })),
  /** The answers, read from the sheet; `{ same: true }` when the sheet is still at `rev`. */
  request('work.forms.responses', z.object({ itemId, rev: z.number().int().min(0).optional() }))
] as const

export type FormsPush = { push: 'work.forms'; sessionId: string; itemId: string; view: FormView }

export const FORMS_CAPS = {
  'work.forms.open': 'read',
  'work.forms.save': 'operate',
  'work.forms.review': 'operate',
  'work.forms.mode': 'operate',
  'work.forms.publish': 'operate',
  'work.forms.close': 'operate',
  'work.forms.responses': 'read'
} satisfies CapsOf<typeof FormsRequestSchemas>
export const FORMS_RELAY = {} satisfies RelayOf<typeof FormsRequestSchemas>

/** What `form.publish` holds: exactly the form at the rev he saw. */
export const FormPublishSchema = z.object({ itemId, title: z.string().max(200), rev: z.number().int().min(0), questions: z.number().int().min(0) })
export type FormPublish = z.infer<typeof FormPublishSchema>
