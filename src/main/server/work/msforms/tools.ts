import { z } from 'zod'
import { MsQuestionSchema, type MsFormMake, type MsFormResponses } from '@shared/contract-work-msforms'
import { agentPrincipal, workText, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import { isOther, MSFORM_NEW_SETTINGS, questionWords, settingsWords, widens, type MsChange, type MsFormSettings, type MsQuestion } from '@shared/work/msforms'
import type { Caller, ToolCtx, WorkTool } from '../modules'
import { heldReceipt } from '../outbox/words'
import { responsesOf } from './answers/read'
import { CarrierRefused, CarrierStop, CarrierTakesAnswers, msCarrier, readPayload } from './carrier/types'
import { shortens } from './carrier/ops'
import { announce, authFor, carrierOrRefuse, formWords, holdPublish, setOpen, storeRead, suggestionOf, writeChanges } from './forms'
import { folderOf, libraryAt } from './place'
import { formReach, formsReached, jobOf, librariesFor, MsformsError, type Reached } from './reach'
import { MsformsStore, type MsFormRow } from './store'
import { answersWithheld, refuseWithheld } from './withhold'
import { MakerFromSchema, questionsFrom, type MakerFrom } from './makers'

/**
 * The tools a Work thread uses on Microsoft forms (docs/agents/work-msforms.md
 * "Agents"). Every one goes through the one reach check first: a thread
 * reaches its own job's forms alone. Making a form is held (`msform.make`),
 * collecting, widening who can answer and reopening are held
 * (`msform.publish`), and a change to a collecting form waits for his
 * Accept. The tools are the only hands an agent has on Forms: no generic
 * browser or computer step reaches a Forms page.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const callerOf = (ctx: ToolCtx): Caller => ({ kind: 'model', caps: [], sessionId: ctx.sessionId })
const form = z.string().min(1).max(200).describe("The form's id, from msform_list.")
const reached = (ctx: ToolCtx, formId: string): Reached => formReach(ctx, callerOf(ctx), { formId })
const run = async (body: () => Promise<WorkToolResult> | WorkToolResult): Promise<WorkToolResult> => {
  try {
    return await body()
  } catch (err) {
    return fail(errorText(err))
  }
}

const stateWords = (row: MsFormRow): string => (row.state === 'draft' ? 'a draft, not taking answers' : row.state === 'collecting' ? 'collecting responses' : 'closed')

function outline(row: MsFormRow, o: { link?: string | null } = {}): string {
  const lines = [`${row.title} (form ${row.formId}), ${stateWords(row)}${row.count ? `, ${row.count} response(s)` : ''}`]
  lines.push(`Folder: ${row.folder.label ?? row.folder.path}`)
  if (row.state !== 'draft') lines.push(`Link people answer at: ${o.link ?? `https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${row.formId}`}`)
  lines.push(`Who can answer: ${settingsWords(row.settings)}`)
  lines.push('', ...row.questions.map((q, i) => `${i + 1}. ${questionWords(q)}${isOther(q) ? ' (changed only in the Forms page)' : ''}`))
  if (row.workbook) lines.push('', `Answers are kept in ${row.workbook.name} in the form's folder; read them with msform_answers.`)
  else if (row.state !== 'draft') lines.push('', 'No answers have reached a workbook yet.')
  if (row.suggestions.length) lines.push('', `${row.suggestions.length} change(s) wait for the owner: ${row.suggestions.map((s) => s.words).join('; ')}.`)
  if (row.stopped) lines.push('', `The last change was not finished: ${row.stopped}`)
  return lines.join('\n')
}

/** Answers as tab-separated text: the header, then newest first. */
function answersText(title: string, got: MsFormResponses, rows: string[][]): string {
  const head = got.columns.map((c) => c.label).join('\t')
  const summary = `${title}: ${got.count} response(s)${got.cut ? ', the newest shown' : ''}${got.stale ? ' (as of the last read; the newest may be missing)' : ''}`
  return [summary, '', head, ...rows.map((r) => r.join('\t'))].join('\n')
}

// ── the questions an agent writes ────────────────────────────────────

const Question = MsQuestionSchema.omit({ ref: true }).describe('A question: title, type (text, choice, rating, date or section), required, and for choice its options; long for a long text answer, multiple for several answers, dropdown for a drop-down, scale 5 or 10 for a rating.')
const at = z.number().int().min(1).max(200).describe('The question\'s number as msform_read lists it, from 1.')
const Change = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), question: Question, after: z.number().int().min(0).max(200).optional().describe('The number of the question it follows; 0 puts it first; absent: at the end.') }),
  z.object({ op: z.literal('change'), question: at, to: Question }),
  z.object({ op: z.literal('remove'), question: at }),
  z.object({ op: z.literal('move'), question: at, to: at })
])
type ChangeIn = z.infer<typeof Change>

const asChange = (c: ChangeIn): MsChange =>
  c.op === 'add'
    ? { op: 'add', question: c.question as MsQuestion, ...(c.after !== undefined ? { after: c.after - 1 } : {}) }
    : c.op === 'change'
      ? { op: 'change', at: c.question - 1, question: c.to as MsQuestion }
      : c.op === 'remove'
        ? { op: 'remove', at: c.question - 1 }
        : { op: 'move', at: c.question - 1, to: c.to - 1 }

/** Why "Agent writes" held a change for his Accept, in the words the thread and his canvas say. */
export const WRITES_HELD = {
  answers: 'The form takes answers, so Agent writes holds its changes for your Accept, as for any file others can open. Turn off Accept responses and the next change goes straight in.',
  collecting: 'The form is collecting answers, so its changes wait for your Accept.',
  unattended: 'A thread a routine started does not write Purdue forms by itself: its changes wait for your Accept.'
} as const

/**
 * An agent's changes. Under "Agent writes" (the mode read at each change, so his switch counts from the next one) a
 * change to his own draft is written now, in one visit whose first step reads Settings: a form that takes answers by
 * that read stops before any change (`CarrierTakesAnswers`) and is held as an `office.edit` is for a file others can
 * open (work-outbox.md), and so is a Purdue form for a thread a routine started (`answersWithheld`'s line): those wait
 * for his Accept and say why. A change that waits opens the form's builder in the box browser for his Accept (`warm`).
 */
async function agentChanges(ctx: ToolCtx, at: Reached, changes: MsChange[], reason?: string): Promise<{ wrote: boolean; row: MsFormRow; held?: string }> {
  const { row } = at
  const by = agentPrincipal(ctx.host, ctx.sessionId)
  const store = new MsformsStore(ctx.db)
  let held: string | undefined
  let now = row
  if (row.mode === 'writes') {
    if (row.state !== 'draft') held = WRITES_HELD.collecting
    else if (answersWithheld(ctx, callerOf(ctx), row.sector)) held = WRITES_HELD.unattended
    else {
      try {
        const next = await writeChanges(ctx, row, changes, 'pillar', by)
        announce(ctx, next)
        return { wrote: true, row: next }
      } catch (err) {
        if (!(err instanceof CarrierTakesAnswers)) throw err
        // the settings as that read saw them: his canvas says the form takes answers
        if (err.read) now = storeRead(ctx, row, err.read, { by: 'page' })
        held = WRITES_HELD.answers
      }
    }
  }
  const waiting = [...now.suggestions, ...changes.map((c) => ({ ...suggestionOf(c, now.questions, by, reason), ...(held ? { held } : {}) }))]
  const next = store.update(now.workspaceId, now.formId, { suggestions: waiting })
  announce(ctx, next)
  // his Accept finds the builder open: a read grant, nothing pressed, kept a few minutes (carrier/wire.ts)
  void msCarrier()?.warm(authFor(ctx, next, 'read', 'pillar', readPayload(next.formId)), next.formId).catch(() => {})
  return { wrote: false, row: next, ...(held ? { held } : {}) }
}

// ── the folder a new form goes in ────────────────────────────────────

const Folder = z.string().min(1).max(2000).describe('The folder to make it in: a Teams or OneDrive library folder of this job, by its path as files_list shows it.')

function folderFor(ctx: ToolCtx, path: string): MsFormMake['folder'] {
  jobOf(ctx, callerOf(ctx))
  const found = libraryAt(librariesFor(ctx, callerOf(ctx)), path)
  const folder = found ? folderOf(found.library, found.inside) : null
  if (!folder) throw new MsformsError('refused: a Microsoft form is made in a Teams or OneDrive library folder this job reaches; nothing was held. Name one by its path as files_list shows it.')
  return { libraryId: folder.libraryId, path: folder.path, siteUrl: folder.siteUrl, ...(folder.label ? { label: folder.label } : {}) }
}

const SettingsIn = z.object({
  orgOnly: z.boolean().optional().describe('Only people in the organization can answer, signed in. True unless the owner asked otherwise.'),
  recordName: z.boolean().optional().describe("Record each person's name with the answer."),
  onePerPerson: z.boolean().optional().describe('One answer each.'),
  startDate: z.string().max(40).optional().describe('When it starts taking answers, as Forms shows a date (11/30/2026).'),
  endDate: z.string().max(40).optional().describe('When it stops taking answers.')
})

/** The `from` makers (makers/index.ts): our own form, a document, a sheet's header row or a template, each read within the thread's own job. */
async function fromMaker(ctx: ToolCtx, from: MakerFrom): Promise<{ title?: string; description?: string; questions: MsQuestion[] }> {
  return questionsFrom(ctx, callerOf(ctx), from)
}

/** One tool, its arguments typed by its input (the mount has parsed them against it). */
function defineTool<S extends z.ZodTypeAny>(t: { name: string; description: string; input: S; readOnly: boolean; run(args: z.infer<S>, ctx: ToolCtx): Promise<WorkToolResult> }): WorkTool {
  return { ...t, run: (args, ctx) => t.run(args as z.infer<S>, ctx) }
}

export const msformsTools: WorkTool[] = [
  defineTool({
    name: 'msform_list',
    description: "The job's Microsoft forms: each one's id, title, state, how many answered, the last answer, and its folder.",
    input: z.object({}),
    readOnly: true,
    run: (_args, ctx) =>
      run(() => {
        const { rows } = formsReached(ctx, callerOf(ctx))
        if (!rows.length) return workText('This job has no Microsoft forms yet.')
        return workText(rows.map((r) => `${r.formId}: ${r.title}, ${stateWords(r)}, ${r.count} response(s)${r.lastAnswerAt ? `, the last ${new Date(r.lastAnswerAt).toISOString()}` : ''}, in ${r.folder.label ?? r.folder.path}`).join('\n'))
      })
  }),
  defineTool({
    name: 'msform_read',
    description: 'Reads a Microsoft form from its page now: title, every question numbered, who can answer, its state and link, where its answers are kept, and what waits for the owner. Question numbers are what msform_edit takes.',
    input: z.object({ form }),
    readOnly: true,
    run: (args, ctx) =>
      run(async () => {
        const at = reached(ctx, args.form)
        const carrier = carrierOrRefuse()
        const read = await carrier.read(authFor(ctx, at.row, 'read', 'pillar', readPayload(at.row.formId)), at.row.formId)
        const row = storeRead(ctx, at.row, read)
        announce(ctx, row)
        return workText(outline(row, { link: read.link }))
      })
  }),
  defineTool({
    name: 'msform_answers',
    description: "A Microsoft form's answers, read from the workbook Forms keeps (read again first when older than two minutes): newest first, at most 200, as tab-separated rows under a header.",
    input: z.object({ form, since: z.string().max(40).optional().describe('Only answers completed after this time (ISO 8601).'), limit: z.number().int().min(1).max(200).optional() }),
    readOnly: true,
    run: (args, ctx) =>
      run(async () => {
        const at = reached(ctx, args.form)
        refuseWithheld(ctx, callerOf(ctx), at.row.sector)
        const got = await responsesOf(ctx, at, callerOf(ctx))
        if (got.none || !got.count) return workText(`${at.row.title} has no answers yet.`)
        const time = got.columns.findIndex((c) => c.label.trim().toLowerCase() === 'completion time')
        const after = args.since ? Date.parse(args.since) : null
        const rows = got.rows.filter((r) => after === null || time < 0 || Date.parse((r[time] ?? '').replace(' ', 'T')) > after).slice(0, args.limit ?? 200)
        return workText(answersText(at.row.title, got, rows))
      })
  }),
  defineTool({
    name: 'msform_find',
    description: 'Finds what people said: the answers in the job\'s Microsoft forms (or one form) whose text holds all the words, each with its form, question and who answered.',
    input: z.object({ text: z.string().trim().min(1).max(200), form: form.optional() }),
    readOnly: true,
    run: (args, ctx) =>
      run(async () => {
        const by = callerOf(ctx)
        const rows = args.form ? [reached(ctx, args.form).row] : formsReached(ctx, by).rows.filter((r) => r.state !== 'draft').slice(0, 10)
        const words = args.text.toLowerCase().split(/\s+/).filter(Boolean)
        const hits: string[] = []
        for (const row of rows) {
          refuseWithheld(ctx, by, row.sector)
          const got = await responsesOf(ctx, formReach(ctx, by, { formId: row.formId }), by)
          const who = got.columns.findIndex((c) => c.label.trim().toLowerCase() === 'name')
          const mail = got.columns.findIndex((c) => c.label.trim().toLowerCase() === 'email')
          for (const r of got.rows)
            r.forEach((cell, i) => {
              const fixed = ['id', 'start time', 'completion time', 'email', 'name'].includes(got.columns[i]?.label.trim().toLowerCase() ?? '')
              if (fixed || !words.every((w) => cell.toLowerCase().includes(w))) return
              const person = r[who] || r[mail] || 'someone'
              if (hits.length < 50) hits.push(`${row.title} · ${got.columns[i]!.label}: ${cell} (${person})`)
            })
        }
        return workText(hits.length ? hits.join('\n') : `No answer holds "${args.text}".`)
      })
  }),
  defineTool({
    name: 'msform_create',
    description:
      "Makes a real Microsoft form in a Teams or OneDrive folder of this job: a title, a line about it, its questions (or `from` one of ours, a document, a sheet's header row or a template) and who can answer. It is held for the owner's press, since a form made in a Team shows to its members at once; with `collect: true` his one press also starts collecting responses. Nothing is made before he presses.",
    input: z.object({
      title: z.string().trim().min(1).max(90),
      description: z.string().max(1000).optional(),
      questions: z.array(Question).max(100).optional(),
      folder: Folder,
      from: MakerFromSchema.optional().describe('Instead of questions: {form: <our form item>}, {document: <file ref>}, {sheet: <file ref>, row?}, or {template: <id>, fields?}.'),
      settings: SettingsIn.optional(),
      collect: z.boolean().optional()
    }),
    readOnly: false,
    run: (args, ctx) =>
      run(async () => {
        const job = jobOf(ctx, callerOf(ctx))
        const folder = folderFor(ctx, args.folder)
        const made = args.from ? await fromMaker(ctx, args.from) : { questions: (args.questions ?? []) as MsQuestion[] }
        const questions = args.questions?.length ? (args.questions as MsQuestion[]) : made.questions
        const settings: MsFormSettings = { ...MSFORM_NEW_SETTINGS, ...args.settings, accepting: false }
        const description = args.description ?? made.description ?? ''
        const payload: MsFormMake = { workspaceId: job.id, sessionId: ctx.sessionId, folder, title: args.title, description, questions, settings, collect: args.collect ?? false, content: `${formWords(args.title, questions, settings, description)}\n\nMade in ${folder.label ?? folder.path}. In a Team's folder its members can see the form as soon as it is made.` }
        const item = ctx.held.create({ kind: 'msform.make', sessionId: ctx.sessionId, payload })
        return workText(heldReceipt(item, `Nothing was made in Forms yet: the form is made${args.collect ? ' and starts collecting responses' : ''} when he presses.`))
      })
  }),
  defineTool({
    name: 'msform_edit',
    description:
      "Changes a Microsoft form's questions: add, change, remove or move, by question number from msform_read. On a draft in Agent writes the change is written in Forms now; otherwise, and always on a form taking answers, each change waits for the owner's Accept.",
    input: z.object({ form, changes: z.array(Change).min(1).max(50), reason: z.string().max(300).optional() }),
    readOnly: false,
    run: (args, ctx) =>
      run(async () => {
        const at = reached(ctx, args.form)
        try {
          const { wrote, row, held } = await agentChanges(ctx, at, args.changes.map(asChange), args.reason)
          return workText(wrote ? `Written in Forms.\n\n${outline(row)}` : `${args.changes.length === 1 ? 'The change waits' : `${args.changes.length} changes wait`} for the owner's Accept; nothing in Forms changed yet.${held ? ` ${held}` : ''}`)
        } catch (err) {
          // A carrier stop says what it had done; the form holds that much.
          if (err instanceof MsformsError) return fail(err.message)
          throw err
        }
      })
  }),
  defineTool({
    name: 'msform_settings',
    description:
      "Changes who can answer and when: org only, record names, one answer each, start and end dates. On a draft in Agent writes the narrowing and the dates are set now; who can answer on a form taking answers, a wider audience anywhere, and a start date that would reopen it are held for the owner's press. An end date that closes it is set now.",
    input: SettingsIn.extend({ form }),
    readOnly: false,
    run: (args, ctx) =>
      run(async () => {
        const at = reached(ctx, args.form)
        const { form: _f, ...patch } = args
        const { row } = at
        const audience = patch.orgOnly !== undefined || patch.recordName !== undefined || patch.onePerPerson !== undefined
        const reopening = row.state === 'closed' && (patch.startDate !== undefined || (patch.endDate !== undefined && !shortens(row.settings.endDate, patch.endDate)))
        // On a form taking answers an agent's end date only shortens the window; a later one, or none, is held.
        const extending = row.state === 'collecting' && patch.endDate !== undefined && !shortens(row.settings.endDate, patch.endDate)
        const wider = widens(row.settings, patch)
        // Held: who can answer on a form taking answers, any widening, a reopening date.
        if (reopening || extending || wider || (audience && row.state !== 'draft') || (row.state === 'draft' && row.mode === 'suggests' && (audience || patch.startDate !== undefined))) {
          const settings = { ...row.settings, ...patch }
          const { held } = holdPublish(ctx, at, reopening ? 'reopen' : 'audience', settings, ctx.sessionId)
          return workText(held ? heldReceipt(held, 'No one can answer differently yet: it changes when he presses.') : 'That change already waits for the owner.')
        }
        const carrier = carrierOrRefuse()
        try {
          const { read } = await carrier.settings(authFor(ctx, row, 'settings', 'pillar', patch), row.formId, patch)
          const next = storeRead(ctx, row, read, { by: agentPrincipal(ctx.host, ctx.sessionId) })
          announce(ctx, next)
          return workText(`Set in Forms. Who can answer: ${settingsWords(next.settings)}.`)
        } catch (err) {
          if (err instanceof CarrierStop || err instanceof CarrierRefused) return fail(err.message)
          throw err
        }
      })
  }),
  defineTool({
    name: 'msform_publish',
    description: 'Holds Collect responses for the owner\'s press: the form starts taking answers, with who can answer as it stands. Nothing is sent: the link reaches people only on his own press.',
    input: z.object({ form }),
    readOnly: false,
    run: (args, ctx) =>
      run(() => {
        const at = reached(ctx, args.form)
        const { held } = holdPublish(ctx, at, 'collect', { ...at.row.settings, accepting: true }, ctx.sessionId)
        return workText(held ? heldReceipt(held, 'No one can answer yet: the form takes answers when he presses.') : 'Collect responses already waits for the owner.')
      })
  }),
  defineTool({
    name: 'msform_close',
    description: 'Closes a Microsoft form (open: false): it stops taking answers now. A reopen (open: true) is held for the owner\'s press.',
    input: z.object({ form, open: z.boolean() }),
    readOnly: false,
    run: (args, ctx) =>
      run(async () => {
        const at = reached(ctx, args.form)
        if (args.open) {
          const { held } = holdPublish(ctx, at, 'reopen', { ...at.row.settings, accepting: true }, ctx.sessionId)
          return workText(held ? heldReceipt(held, 'No one can answer yet: it reopens when he presses.') : 'A reopen already waits for the owner.')
        }
        const view = await setOpen(ctx, at, false, 'pillar', agentPrincipal(ctx.host, ctx.sessionId))
        return workText(`${view.title} is closed: it takes no more answers.`)
      })
  })
]

export const MSFORMS_PREAMBLE =
  "A Microsoft form is reached only through the msform tools: msform_list and msform_read to see one, msform_answers and msform_find to read what people said, msform_create to make one (held for the owner's press), msform_edit and msform_settings to change it, msform_publish to hold Collect responses, msform_close to close it. No browser or computer step reaches a Forms page. A change to a form taking answers waits for his Accept; the link goes out only on his press."

