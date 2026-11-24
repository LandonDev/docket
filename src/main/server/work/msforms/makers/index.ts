import { z } from 'zod'
import { CanvasSourceSchema, type CanvasSource, type WorkScope } from '@shared/work'
import { fromOurQuestion, type MsQuestion } from '@shared/work/msforms'
import { locate, workspaceHere, type WorkspaceRow } from '../../files/policy'
import { readOnlyOf } from '../../files/readOnly'
import { FormsStore } from '../../forms/store'
import type { Caller, ToolCtx, WorkCtx } from '../../modules'
import { MsformsError, NOT_A_JOB } from '../reach'
import { paragraphsOfMarkdown, questionsOfDocument } from './document'
import { markdownOfFile } from './read'
import { questionsOfSheet, rowsOfCells, SHEET_RANGE } from './sheet'
import { questionsOfTemplate } from './template'

/**
 * Where a Microsoft form's questions come from besides his words (docs/agents/work-msforms.md "The makers"): our
 * own form, a document, a sheet's header row, or a form template. Every read goes through the caller's own reach:
 * a thread reads only its own job's forms and files, through the readers and fences the forms, files, docs and
 * sheets pillars already use. What comes back is questions alone: nothing is made here.
 */

export const MakerFromSchema = z.union([
  z.object({ form: z.string().min(1).max(200).describe("Our form's canvas item id: its title and questions, made a Microsoft form.") }).strict(),
  z.object({ document: CanvasSourceSchema.describe('A Word document or a .tcdoc in this job, or a LifeOS document: each numbered or heading paragraph a question, a list under it its options.') }).strict(),
  z.object({ sheet: CanvasSourceSchema.describe('A sheet file in this job: each header cell a question.'), row: z.number().int().min(1).max(200).optional().describe('The header row, 1 for the first.') }).strict(),
  z.object({ template: z.string().min(1).max(300).describe("A form template in the job's Templates, by name or id."), fields: z.record(z.string().max(40), z.string().max(2000)).optional() }).strict()
])
export type MakerFrom = z.infer<typeof MakerFromSchema>

/** A tool's context, or the host's own with no thread (his window's press). */
export type MakerCtx = WorkCtx & Partial<Pick<ToolCtx, 'sessionId' | 'scope' | 'signal'>>

export interface MadeQuestions {
  title?: string
  description?: string
  questions: MsQuestion[]
}

export const NOT_YOUR_JOB = "refused: a thread makes a form only from its own job's forms and files; nothing was read."
export const NO_QUESTIONS = 'No questions were found there: number each question, with its options as a list under it.'
const NO_FORM = 'There is no such form of ours in this job.'
const FROM_A_THREAD = 'That is read from a thread of the job.'

/** The job the read is in: a thread's own, from its session; his own as asked. */
function jobFor(ctx: MakerCtx, by: Caller, asked: string | null | undefined): WorkspaceRow {
  if (by.kind === 'model') {
    const scope = by.sessionId ? ctx.scopeOf(by.sessionId) : null
    if (!scope?.workspaceId || (asked && asked !== scope.workspaceId)) throw new MsformsError(NOT_YOUR_JOB)
    const ws = workspaceHere(ctx.db, scope.workspaceId)
    if (!ws) throw new MsformsError(NOT_YOUR_JOB)
    return ws
  }
  const ws = asked ? workspaceHere(ctx.db, asked) : null
  if (!ws) throw new MsformsError(NOT_A_JOB)
  return ws
}

/** A thread's own tool context, for the readers that need one (the docs and sheets pillars'). */
function threadCtx(ctx: MakerCtx, by: Caller): ToolCtx {
  if (by.kind !== 'model' || !ctx.sessionId || !ctx.scope) throw new MsformsError(FROM_A_THREAD)
  return { ...ctx, sessionId: ctx.sessionId, scope: ctx.scope as WorkScope, signal: ctx.signal ?? new AbortController().signal }
}

/** A file in the caller's reach on this host's own disk: the workspace's folder or a library synced here, never the VM's. */
function localPath(ctx: MakerCtx, by: Caller, workspace: WorkspaceRow, source: CanvasSource): string {
  let at: ReturnType<typeof locate>
  try {
    at = locate(ctx, by, workspace.id, source as never, 'msforms.from')
  } catch (err) {
    if (by.kind === 'model') throw new MsformsError(NOT_YOUR_JOB)
    throw err
  }
  if (at.in === 'folder') return at.path
  if (at.in === 'library' && !at.library.vm) return at.path
  throw new MsformsError('That file is not on this computer’s disk: open it in Files, then make the form from a copy.')
}

/** Questions from where an agent or his press named, in the caller's reach. `opts.workspaceId` names his own job; a thread's is its session's. */
export async function questionsFrom(ctx: MakerCtx, by: Caller, from: MakerFrom, opts: { workspaceId?: string } = {}): Promise<MadeQuestions> {
  const made = await read(ctx, by, from, opts)
  if (!made.questions.length) throw new MsformsError(NO_QUESTIONS)
  return made
}

async function read(ctx: MakerCtx, by: Caller, from: MakerFrom, opts: { workspaceId?: string }): Promise<MadeQuestions> {
  if ('form' in from) {
    const item = ctx.canvas.get(from.form)
    if (!item || item.kind !== 'form') throw new MsformsError(by.kind === 'model' ? NOT_YOUR_JOB : NO_FORM)
    const workspace = jobFor(ctx, by, opts.workspaceId ?? item.workspaceId)
    if (item.workspaceId !== workspace.id) throw new MsformsError(by.kind === 'model' ? NOT_YOUR_JOB : NO_FORM)
    const row = new FormsStore(ctx.db).get(item.id)
    if (!row) throw new MsformsError(NO_FORM)
    const { title, description, questions } = row.body
    return { title: title.slice(0, 90), ...(description.trim() ? { description: description.slice(0, 1000) } : {}), questions: questions.slice(0, 100).map(fromOurQuestion) }
  }
  const workspace = jobFor(ctx, by, opts.workspaceId)
  if ('template' in from) {
    const { unfilled: _unfilled, ...form } = await questionsOfTemplate(ctx, workspace, from.template, from.fields)
    return form
  }
  if ('document' in from) {
    const source = from.document
    if (source.at === 'lifeos') {
      if (source.table !== 'docs') throw new MsformsError('A form is made from a document, not that.')
      const { readDocMarkdown } = await import('../../docs/tools')
      const { markdown } = await readDocMarkdown(threadCtx(ctx, by), { doc: source.id })
      return questionsOfDocument(paragraphsOfMarkdown(markdown))
    }
    if (source.at !== 'file') throw new MsformsError('A form is made from a document in this job’s folder, a library it uses, or LifeOS.')
    return questionsOfDocument(paragraphsOfMarkdown(await markdownOfFile(localPath(ctx, by, workspace, source))))
  }
  const source = from.sheet
  if (source.at !== 'file' || !/\.(xlsx|xlsm|csv|tcsheet)$/i.test(source.path)) throw new MsformsError('A form is made from an .xlsx, .xlsm, .csv or .tcsheet file in this job.')
  const path = localPath(ctx, by, workspace, source)
  // A Microsoft form's answers workbook is no maker input: its repeated answers would become a form's choices.
  const shut = readOnlyOf(ctx, { host: ctx.host, path })?.readRefused ?? readOnlyOf(ctx, { host: source.host, path: source.path })?.readRefused
  if (shut) throw new MsformsError(shut)
  const { readSheetCells } = await import('../../sheets/tools')
  const cells = await readSheetCells(threadCtx(ctx, by), { file: path }, SHEET_RANGE)
  return { questions: questionsOfSheet(rowsOfCells(cells), (from.row ?? 1) - 1) }
}
