import type { DatabaseSync } from 'node:sqlite'
import { MSFORM_WITHHELD_WORDS } from '@shared/work/msforms'
import type { Trigger, TriggerRange, TriggerSource } from '@shared/work'
import type { RoutineJob, RoutineJobAt, WorkCtx } from '../modules'
import { workspaceHere } from '../files/policy'
import { onNewAnswers } from './events'
import { formAdmitted } from './reach'
import { MsformsStore, type MsFormRow } from './store'
import { routineWithheld } from './withhold'

/**
 * A Microsoft form's answers as a routine's trigger and job (docs/agents/work-msforms.md "Answers as data in
 * Work", docs/agents/work-routines.md "A Microsoft form's answers"). The trigger fires on the answers read's
 * new-answers event with an opaque range; the job `msforms.tasks` files one LifeOS task per new answer, with no
 * model. Neither carries an answer, a name or an address: a cause and a task say a count and the form's title.
 */

export const MSFORM_TASKS_JOB = 'msforms.tasks'
/** The most tasks one run files; the rest wait for the next run, from the checkpoint. */
export const MSFORM_TASKS_MOST = 100

/** The form a trigger watches, or null for any other trigger. */
export function formOf(t: Trigger | undefined | null): { workspaceId: string; formId: string } | null {
  return t?.on === 'file' && t.source.at === 'msform' ? { workspaceId: t.source.workspaceId, formId: t.source.formId } : null
}

/** "2 new responses to Sign-up": a count and the title, never who answered. */
export const answersCause = (title: string, added: number): string => `${added} new ${added === 1 ? 'response' : 'responses'} to ${title}`

/** The range a firing carries: Forms' workbook `Id`s, both ends included. */
export interface AnswersRange {
  formId: string
  fromId: number
  toId: number
}

/** A range a job was handed, read back; null when it is not this form's or not a range at all. */
export function rangeOf(range: TriggerRange | undefined, formId: string): AnswersRange | null {
  const r = range as Partial<AnswersRange> | undefined
  if (!r || r.formId !== formId || !Number.isInteger(r.fromId) || !Number.isInteger(r.toId) || r.fromId! < 1 || r.toId! < r.fromId!) return null
  return { formId, fromId: r.fromId!, toId: r.toId! }
}

/** The host while the pillar runs: a trigger's words and firing ask whether its form is still reached here (none while Work is off: no title). */
let reachHere: Pick<WorkCtx, 'db' | 'host'> | null = null
export function setTriggerReach(ctx: Pick<WorkCtx, 'db' | 'host'> | null): void {
  reachHere = ctx
}

/**
 * The form a trigger names, only while it passes the one reach check's own tests on its workspace (the sector it was
 * made in, its library still reached here: reach.ts `formAdmitted`); null otherwise, or while the pillar does not run.
 */
function admittedForm(t: Trigger): MsFormRow | null {
  const form = formOf(t)
  const ctx = reachHere
  if (!form || !ctx) return null
  const row = new MsformsStore(ctx.db).get(form.workspaceId, form.formId)
  const job = workspaceHere(ctx.db, form.workspaceId)
  return row && job && formAdmitted(ctx, row, job.sector) ? row : null
}

/**
 * "When someone answers <form>": armed on the answers read's event for one form, it fires once per new range (a
 * read that tells the same answers again fires nothing) with the cause "2 new responses to <form>".
 */
export const msformTrigger: TriggerSource = {
  on: 'file',
  at: 'msform',
  words(t) {
    // the title only of a form still reached (`admittedForm`); else no title at all
    const title = admittedForm(t)?.title
    return `When someone answers ${title ?? 'the form'}`
  },
  arm(t, fire) {
    const form = formOf(t)
    if (!form) return () => {}
    let last = 0
    return onNewAnswers((e) => {
      if (e.workspaceId !== form.workspaceId || e.formId !== form.formId || e.added <= 0 || e.toId <= last) return
      // checked again at each firing: a form whose library left reach, or whose job changed sector, starts nothing
      if (!admittedForm(t)) return
      last = e.toId
      const range: AnswersRange = { formId: form.formId, fromId: Math.max(e.fromId, 1), toId: e.toId }
      fire(answersCause(e.title, e.added), range as unknown as TriggerRange)
    })
  }
}

// ── the job's checkpoint ─────────────────────────────────────────────

export function ensureMsformJobs(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_msforms_jobs (
    workspace_id TEXT NOT NULL,
    form_id TEXT NOT NULL,
    done_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, form_id)
  )`)
}

/** The highest answer `Id` LifeOS has confirmed a task for; null before the job's first run on the form. */
export function checkpointOf(db: DatabaseSync, workspaceId: string, formId: string): number | null {
  const row = db.prepare('SELECT done_id FROM work_msforms_jobs WHERE workspace_id = ? AND form_id = ?').get(workspaceId, formId) as { done_id: number } | undefined
  return row ? Number(row.done_id) : null
}

function setCheckpoint(db: DatabaseSync, workspaceId: string, formId: string, doneId: number, at: number): void {
  db.prepare(
    'INSERT INTO work_msforms_jobs (workspace_id, form_id, done_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, form_id) DO UPDATE SET done_id = MAX(done_id, excluded.done_id), at = excluded.at'
  ).run(workspaceId, formId, doneId, at)
}

export function removeMsformJobs(db: DatabaseSync, workspaceId: string): void {
  db.prepare('DELETE FROM work_msforms_jobs WHERE workspace_id = ?').run(workspaceId)
}

/** A task's key per answer: LifeOS files a key once, so a retry or a restart files none twice. */
export const answerTaskKey = (formId: string, id: number): string => `msforms:${formId}:${id}`

/** A new answer's task: the form's title, never who answered or what. */
export const answerTaskTitle = (title: string): string => `New answer to ${title}`

const NOT_A_FORM = "This job runs on a Microsoft form's answers: pick the form in the routine's trigger."
const NO_SECTOR = "This job's workspace is not linked to a LifeOS sector, so there is nowhere to file the tasks."
const NO_FORM = 'That Microsoft form is not in this job.'

/**
 * `msforms.tasks`: one LifeOS task per answer past the checkpoint, up to the highest `Id` seen (the range's end, or
 * the form's own last `Id`). Before its first run on a form the checkpoint is the range's start, or for Run now the
 * form's last `Id` (nothing filed: answers from before the routine are not new to it). Each task's write moves the
 * checkpoint only once LifeOS answers with the task it made; a failure stops the run there, and the next run files
 * from it. A gap in the workbook's `Id`s (an answer deleted in Forms) still gets its task.
 */
export async function fileAnswerTasks(ctx: Pick<WorkCtx, 'db' | 'host' | 'lifeos'>, at: RoutineJobAt, now: () => number = Date.now): Promise<{ words: string; open?: { place: string; item: string } }> {
  const form = formOf(at.trigger)
  if (!form) throw new Error(NOT_A_FORM)
  if (form.workspaceId !== at.workspaceId) throw new Error(NO_FORM)
  const row = new MsformsStore(ctx.db).get(form.workspaceId, form.formId)
  // the form's answers stay in the sector it was made in: a job moved to another sector files nothing (reach.ts)
  const job = workspaceHere(ctx.db, form.workspaceId)
  if (!row || !job || !formAdmitted(ctx, row, job.sector)) throw new Error(NO_FORM)
  if (!row.sector) throw new Error(NO_SECTOR)
  const open = { place: 'forms', item: row.formId }
  const range = rangeOf(at.range, row.formId)
  const top = Math.max(range?.toId ?? 0, row.lastId)
  const saved = checkpointOf(ctx.db, row.workspaceId, row.formId)
  const done = saved ?? (range ? range.fromId - 1 : top)
  if (saved === null) setCheckpoint(ctx.db, row.workspaceId, row.formId, done, now())
  const last = Math.min(top, done + MSFORM_TASKS_MOST)
  if (last <= done) return { words: 'No new answers', open }
  if (!ctx.lifeos.connected()) throw new Error('LifeOS is not connected on this host.')
  const owner = ctx.lifeos.owner()
  let filed = 0
  for (let id = done + 1; id <= last; id++) {
    const key = answerTaskKey(row.formId, id)
    let made: unknown
    try {
      made = await owner.mutation<string>('tasks:create', {
        sector: row.sector,
        title: answerTaskTitle(row.title),
        description: `Answer ${id} of “${row.title}”. Read it in Work: the form's Responses.`,
        key,
        // LifeOS takes a key only as a quick add's own, as capture's and prep's filing do.
        source: { kind: 'manual', container: 'quick-add', channel: 'Microsoft Forms', messageId: key, sentAt: now() }
      })
    } catch (err) {
      throw new Error(`${filed ? `Filed ${filed} ${filed === 1 ? 'task' : 'tasks'}, then ` : ''}LifeOS did not file the next: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (typeof made !== 'string' || !made) throw new Error(`${filed ? `Filed ${filed}, then ` : ''}LifeOS did not answer with the task it made.`)
    setCheckpoint(ctx.db, row.workspaceId, row.formId, id, now())
    filed++
  }
  const more = top - last
  return { words: `Filed ${filed} ${filed === 1 ? 'task' : 'tasks'} for new answers to ${row.title}${more > 0 ? `; ${more} more on the next run` : ''}`, open }
}

export const msformTasksJob: RoutineJob = {
  id: MSFORM_TASKS_JOB,
  name: 'Files a task for each new answer',
  run: (ctx, at) => fileAnswerTasks(ctx, at)
}

// ── saving a routine on a form ───────────────────────────────────────

export const FORM_NOT_IN_WORKSPACE = "refused: a routine on a Microsoft form's answers belongs to the form's own job; pick one of this job's forms"
export const JOB_NEEDS_FORM = "refused: “File a task for each answer” runs on a Microsoft form's answers; choose the form it watches"
/** What saving a Purdue form's routine that starts a thread answers: the withhold's words and the job it may run instead. */
export const WITHHELD_ROUTINE = `${MSFORM_WITHHELD_WORDS} Choose “File a task for each answer” to have this routine run with no thread.`

/**
 * The msforms pillar's say on saving a routine whose trigger is a Microsoft form's answers: the form must be in the
 * routine's own workspace, and a form of a withheld sector (Purdue) takes only a routine that starts no thread;
 * `msforms.tasks` runs only on a form. Null when it may be saved.
 */
export function msformRoutineRefusal(ctx: Pick<WorkCtx, 'db' | 'host'>, ask: { workspaceId: string; trigger: Trigger; job: string | null }): string | null {
  const form = formOf(ask.trigger)
  if (!form) return ask.job === MSFORM_TASKS_JOB ? JOB_NEEDS_FORM : null
  if (form.workspaceId !== ask.workspaceId) return FORM_NOT_IN_WORKSPACE
  const row = new MsformsStore(ctx.db).get(form.workspaceId, form.formId)
  const job = workspaceHere(ctx.db, form.workspaceId)
  // the one reach check's own tests: the sector it was made in, its library still reached
  if (!row || !job || !formAdmitted(ctx, row, job.sector)) return FORM_NOT_IN_WORKSPACE
  // a routine with no job starts a thread
  return routineWithheld(row.sector, !ask.job) ? WITHHELD_ROUTINE : null
}
