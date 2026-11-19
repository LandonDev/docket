import { meetingTime, type MeetingAction } from '@shared/contract-work-meetings'
import type { SectorKey } from '@shared/work'
import type { WorkCtx } from '../modules'

/**
 * Filing a meeting's task in LifeOS once the owner accepts it
 * (docs/agents/work-meetings.md, "Tasks"). Nothing is filed before that.
 * The task goes to the sector of the thread's workspace, through the
 * host's own LifeOS session (`ctx.lifeos`, milestone 7), never through a
 * thread's tools.
 */

/** The LifeOS function a task is filed with, and its arguments: the one place that names it (`convex/tasks.ts` `create`). */
export const LIFEOS_CREATE_TASK = 'tasks:create'
/** The LifeOS query that reads one task by id (`convex/tasks.ts` `get`), for milestone 7 to confirm. */
export const LIFEOS_GET_TASK = 'tasks:get'
export interface LifeosTaskArgs {
  sector: SectorKey
  title: string
  description: string
  dueAt?: number
}

/** A due date as LifeOS takes it: a bare date means 9:00 that morning on this host's clock, as LifeOS reads a date with no time. */
export function dueAtOf(due: string | undefined): number | undefined {
  if (!due) return undefined
  const date = due.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const at = date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), 9, 0, 0).getTime() : Date.parse(due)
  return Number.isFinite(at) ? at : undefined
}

/** What the task says about where it came from: the meeting, the minute, and the words when the notes quote them. */
export function taskArgs(action: MeetingAction, meeting: { title: string; durationSec: number }, sector: SectorKey): LifeosTaskArgs {
  const where = action.at === null ? `From “${meeting.title}”.` : `From “${meeting.title}” at ${meetingTime(action.at, meeting.durationSec >= 3600)}.`
  const dueAt = dueAtOf(action.due)
  return { sector, title: action.text, description: action.quote ? `${where}\n“${action.quote}”` : where, ...(dueAt !== undefined ? { dueAt } : {}) }
}

/** Files one accepted task; answers the LifeOS task's id. Throws a sentence the canvas can show. */
export async function fileTask(ctx: WorkCtx, sessionId: string, action: MeetingAction, meeting: { title: string; durationSec: number }): Promise<string> {
  const sector = ctx.scopeOf(sessionId)?.sector ?? null
  if (!sector) throw new Error('This thread\'s workspace is not linked to a LifeOS sector, so there is nowhere to file the task.')
  if (!ctx.lifeos.connected()) throw new Error('LifeOS is not connected on this host.')
  const id = await ctx.lifeos.owner().mutation<string>(LIFEOS_CREATE_TASK, { ...taskArgs(action, meeting, sector) })
  if (typeof id !== 'string' || !id) throw new Error('LifeOS did not answer with the task it made.')
  return id
}

/** Whether LifeOS holds a task with this id. Any doubt (not connected, not built, an error) is no. */
export async function taskExists(ctx: WorkCtx, id: string): Promise<boolean> {
  try {
    if (!ctx.lifeos.connected()) return false
    const task = await ctx.lifeos.owner().query<unknown>(LIFEOS_GET_TASK, { id })
    return task !== null && task !== undefined
  } catch {
    return false
  }
}
