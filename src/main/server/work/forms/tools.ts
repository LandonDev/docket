import { z } from 'zod'
import { FORM_OPTIONS_MAX, FORM_QUESTION_TYPES, FORM_QUESTIONS_MAX, FormBodySchema, type FormQuestion, type FormSuggestion } from '@shared/contract-work-forms'
import { agentPrincipal, workText, type CanvasItem, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ToolCtx, WorkTool } from '../modules'
import { agentChange, FormError, formItem, hold, responses, rowOf, setOpen, viewOf } from './forms'
import { FormsStore, newQuestionId, tidyQuestion } from './store'

/**
 * The tools a Work thread makes and runs a form with
 * (docs/agents/work-forms.md "The tools"). Publishing is held for the
 * owner's press; closing and reopening are not.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const item = z.string().describe("The id of a form in this thread's canvas (from `form_create` or `canvas_open`).")
const type = z.enum(FORM_QUESTION_TYPES).describe('short, long, choice (one of the options), dropdown, or section (a heading that takes no answer)')
const options = z.array(z.string().min(1).max(200)).max(FORM_OPTIONS_MAX).optional().describe('For choice and dropdown: the answers, in order.')
const NewQuestion = z.object({ label: z.string().min(1).max(300), type: type.default('short'), required: z.boolean().default(false), options })

function paneForm(ctx: ToolCtx, id: string): CanvasItem {
  const it = formItem(ctx, id)
  if (it.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new FormError(`This thread has no form ${id}.`)
  return it
}

const asQuestion = (q: z.infer<typeof NewQuestion>, id = newQuestionId()): FormQuestion => tidyQuestion({ id, label: q.label, type: q.type, required: q.required, options: q.options })

function outline(ctx: ToolCtx, it: CanvasItem): string {
  const row = rowOf(ctx, it)
  const view = viewOf(ctx, row)
  const lines = [
    `${row.body.title} (form ${it.id}), ${row.state === 'draft' ? (row.held ? 'held for his press to publish' : 'not published') : row.state === 'open' ? `published at ${view.link}` : 'closed'}`,
    ...(row.body.description ? [row.body.description] : []),
    '',
    ...row.body.questions.map((q) =>
      q.type === 'section' ? `## ${q.label}  [${q.id}]` : `- ${q.label}  [${q.id}, ${q.type}${q.required ? ', required' : ''}${q.options ? `: ${q.options.join(' | ')}` : ''}]`
    )
  ]
  if (row.suggestions.length) lines.push('', `${row.suggestions.length} change(s) wait for the owner.`)
  if (row.sheet) lines.push('', `Answers are written to the sheet ${row.sheet.at === 'lifeos' ? `LifeOS sheets ${row.sheet.id}` : row.sheet.at === 'file' ? row.sheet.path : ''} (row 1 is the header; column A is when each came in). Read it with sheet_read.`)
  return lines.join('\n')
}

const Change = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), question: NewQuestion, after: z.string().nullable().optional().describe('The id of the question it follows; null or absent: at the end.') }),
  z.object({ op: z.literal('change'), id: z.string(), label: z.string().min(1).max(300).optional(), type: type.optional(), required: z.boolean().optional(), options }),
  z.object({ op: z.literal('remove'), id: z.string() })
])

export const formsTools: WorkTool[] = [
  {
    name: 'form_create',
    description:
      'Makes a form and opens it in the canvas: a title, a line about it, and its questions. Publishing it is a separate step the owner presses (`form_publish` holds it for him).',
    input: z.object({
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      questions: z.array(NewQuestion).min(1).max(FORM_QUESTIONS_MAX)
    }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { title: string; description?: string; questions: z.infer<typeof NewQuestion>[] }
      try {
        const body = FormBodySchema.parse({ title: a.title, description: a.description ?? '', questions: a.questions.map((q) => asQuestion(q)) })
        const it = ctx.canvas.open(ctx.canvas.paneOf(ctx.sessionId), 'form', { at: 'thread' }, body.title)
        new FormsStore(ctx.db).create(it.id, it.sessionId, body)
        return { ...workText(outline(ctx, it)), structuredContent: { item: it.id } }
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'form_read',
    description: "Reads a form: its questions with their ids, whether it is published and where, what waits for the owner, and its newest answers (up to 50; the sheet has them all).",
    input: z.object({ item }),
    readOnly: true,
    run: async (args, ctx) => {
      try {
        const it = paneForm(ctx, (args as { item: string }).item)
        let text = outline(ctx, it)
        const got = await responses(ctx, it).catch(() => null)
        if (got && 'rows' in got) {
          const head = got.columns.map((c) => c.label).join(' | ')
          text += `\n\n${got.count} answer(s)${got.cut ? ' read, more in the sheet' : ''}.${got.rows.length ? `\n${head}\n${got.rows.slice(0, 50).map((r) => r.join(' | ')).join('\n')}` : ''}`
        }
        return workText(text)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'form_edit',
    description:
      'Changes a form\'s questions: add, change or remove, naming questions by id (from form_read). On a published form every change waits for the owner; before then the form\'s mode decides. Say in `reason` why, in one line he reads beside the change.',
    input: z.object({ item, changes: z.array(Change).min(1).max(50), reason: z.string().max(300).optional() }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; changes: z.infer<typeof Change>[]; reason?: string }
      try {
        const it = paneForm(ctx, a.item)
        const row = rowOf(ctx, it)
        const by = agentPrincipal(ctx.host, ctx.sessionId)
        const made: Omit<FormSuggestion, 'id' | 'at'>[] = a.changes.map((c) => {
          if (c.op === 'add') return { op: 'add', question: asQuestion(c.question), after: c.after ?? row.body.questions.at(-1)?.id ?? null, reason: a.reason, by }
          const was = row.body.questions.find((q) => q.id === c.id)
          if (!was) throw new FormError(`There is no question ${c.id} in the form.`)
          if (c.op === 'remove') return { op: 'remove', question: was, reason: a.reason, by }
          return { op: 'change', question: tidyQuestion({ ...was, ...Object.fromEntries(Object.entries(c).filter(([k, v]) => k !== 'op' && k !== 'id' && v !== undefined)) }), reason: a.reason, by }
        })
        let n = 0
        const { waiting } = await agentChange(ctx, it, made, () => `s${Date.now().toString(36)}${n++}`)
        return workText(waiting ? `${made.length} change(s) wait for the owner to accept in the canvas.` : `Changed the form.\n\n${outline(ctx, it)}`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'form_publish',
    description:
      'Asks to publish a form: it is held, and the link goes live only when the owner presses Publish. Anyone with the link can then answer, and each answer becomes a row of a sheet.',
    input: z.object({ item }),
    readOnly: false,
    run: async (args, ctx) => {
      try {
        const it = paneForm(ctx, (args as { item: string }).item)
        const { held } = hold(ctx, it)
        if (held && held.state !== 'held') return workText(`Published ${it.title}.`)
        return workText(`Held: Publish ${it.title}. The link goes live when he presses Publish; until then nobody can answer.`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  },
  {
    name: 'form_close',
    description: 'Closes a published form so it takes no more answers (`open: false`), or reopens it (`open: true`). The answers already in stay.',
    input: z.object({ item, open: z.boolean() }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; open: boolean }
      try {
        const it = paneForm(ctx, a.item)
        const view = setOpen(ctx, it, a.open)
        return workText(view.state === 'open' ? `${it.title} takes answers again at ${view.link}.` : `${it.title} is closed; it takes no more answers.`)
      } catch (err) {
        return fail(errorText(err))
      }
    }
  }
]
