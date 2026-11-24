import type { TeamsLibrary } from '@shared/contract-work-office'
import { FenceError } from '../../remote/fence'
import { vmFor, workspaceHere, type WorkspaceRow } from '../files/policy'
import { librariesHere, vmLibrariesHere } from '../files/places/libraries'
import type { Caller, WorkCtx } from '../modules'
import { MsformsStore, type MsFormRow } from './store'

/**
 * The one reach check (docs/agents/work-msforms.md "The one reach check").
 * Every method, tool, search source, People and dashboard read asks it before
 * any lookup, fetch or cache use. A thread's job is the host's to say, from
 * its session; a thread with no job (a Work Chat, a code thread) is refused
 * before any form is looked up. The form must be the workspace's on this host,
 * made in the workspace's current sector, in a library this host still reaches.
 * A refusal names no other job or form.
 */

export class MsformsError extends Error {}

/** What a model caller is told whenever the reach fails, whatever the cause. */
export const NOT_THIS_JOB = "refused: a Microsoft form's answers are read only from a thread of the form's own job; nothing was read."
export const NO_FORM = 'That Microsoft form is not in this job.'
export const NOT_A_JOB = 'That job is not on this computer.'
export const LIBRARY_GONE = "The folder that form was made in is not one this computer reaches now."

export type FormReachCtx = Pick<WorkCtx, 'db' | 'host' | 'scopeOf' | 'settings' | 'reaches'>

/** The job a caller asks in: a thread's own, from its session (never what it named); his own as asked. */
export function jobOf(ctx: FormReachCtx, by: Caller, asked?: string | null): WorkspaceRow {
  if (by.kind === 'model') {
    const scope = by.sessionId ? ctx.scopeOf(by.sessionId) : null
    if (!scope?.workspaceId || (asked && asked !== scope.workspaceId)) throw new MsformsError(NOT_THIS_JOB)
    const ws = workspaceHere(ctx.db, scope.workspaceId)
    if (!ws) throw new MsformsError(NOT_THIS_JOB)
    return ws
  }
  if (!asked) throw new MsformsError(NOT_A_JOB)
  const ws = workspaceHere(ctx.db, asked)
  if (!ws) throw new MsformsError(NOT_A_JOB)
  if (by.kind === 'remote' && !by.peer && !ctx.reaches(by, ws.path)) throw new FenceError('work.msforms')
  return ws
}

/** The libraries a caller may use on this host: the disk's, and the VM's where the caller may use the VM. */
export function librariesFor(ctx: FormReachCtx, by: Caller): TeamsLibrary[] {
  return [...librariesHere(ctx), ...(vmFor(ctx, by) ? vmLibrariesHere(ctx) : [])]
}

export interface Reached {
  workspace: WorkspaceRow
  row: MsFormRow
  library: TeamsLibrary
}

/**
 * The form a caller may reach, or a refusal. `ask.workspaceId` is what an
 * owner's call named; a thread's is ignored but must not name another job.
 */
export function formReach(ctx: FormReachCtx, by: Caller, ask: { workspaceId?: string | null; formId: string }): Reached {
  const model = by.kind === 'model'
  const fail = (words: string): never => {
    throw new MsformsError(model ? NOT_THIS_JOB : words)
  }
  const workspace = jobOf(ctx, by, ask.workspaceId)
  const row = new MsformsStore(ctx.db).get(workspace.id, ask.formId)
  if (!row) return fail(NO_FORM)
  if ((row.sector ?? null) !== (workspace.sector ?? null)) return fail(NO_FORM)
  const library = librariesFor(ctx, by).find((l) => l.id === row.folder.libraryId)
  if (!library) return fail(LIBRARY_GONE)
  return { workspace, row, library }
}

/**
 * The one reach check's own tests of a form row, for a place that has no caller's job to ask about (Search's cached
 * answers, `@`, a routine's trigger and job): made in the job's current sector, in a library still reached here.
 * `by`, when there is one, narrows the libraries to the caller's (the VM's only where it may use the VM).
 */
export function formAdmitted(ctx: Pick<WorkCtx, 'db' | 'host'>, row: Pick<MsFormRow, 'sector' | 'folder'>, jobSector: string | null, by?: Caller): boolean {
  if ((row.sector ?? null) !== (jobSector ?? null)) return false
  // (with a caller, `ctx` is a whole context: the VM's libraries are the caller's only where it may use the VM)
  const libraries = by ? librariesFor(ctx as FormReachCtx, by) : [...librariesHere(ctx), ...vmLibrariesHere(ctx)]
  return libraries.some((l) => l.id === row.folder.libraryId)
}

/** The forms of the caller's job it may reach, newest first: a list never names a form `formReach` would refuse. */
export function formsReached(ctx: FormReachCtx, by: Caller, workspaceId?: string | null): { workspace: WorkspaceRow; rows: MsFormRow[] } {
  const workspace = jobOf(ctx, by, workspaceId)
  const libraries = new Set(librariesFor(ctx, by).map((l) => l.id))
  const rows = new MsformsStore(ctx.db).list(workspace.id).filter((r) => (r.sector ?? null) === (workspace.sector ?? null) && libraries.has(r.folder.libraryId))
  return { workspace, rows }
}
