import { PREP_TASKS_MAX, type PrepSuggestion } from '@shared/contract-work-prep'
import { errorText } from '@shared/work'
import type { WorkCtx } from '../modules'
import { fileTask } from './filing'
import { eventOf, gather, standing } from './gather'
import { writePage } from './page'
import { foldTitle } from './series'
import { PrepStore } from './store'
import { workspaceSector } from './workspace'

/** A LifeOS refusal in its own words: a ConvexError's data, else the error's message with Convex's wrapping cut. */
export function lifeosWords(err: unknown): string {
  const data = (err as { data?: unknown } | null)?.data
  if (typeof data === 'string' && data) return data
  const words = errorText(err).replace(/^[\s\S]*?ConvexError:\s*/, '').replace(/^\[CONVEX [^\]]*\]\s*(\[Request ID: [^\]]*\]\s*)?(Server Error\s*)?/, '').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'LifeOS did not take it'
}

type Suggested = Omit<PrepSuggestion, 'id' | 'state' | 'lifeosTaskId'>

const titleKey = (title: string) => foldTitle(title) || title.normalize('NFKC').trim().toLowerCase()

/** Take the thread’s new suggestions and keep any decisions the owner already made. */
export function rewriteTasks(input: Suggested[], prior: PrepSuggestion[], sequence: number): { tasks: PrepSuggestion[]; suggestionSeq: number } {
  let suggestionSeq = Math.max(sequence, ...prior.map((task) => Number(/^s(\d+)$/.exec(task.id)?.[1] ?? 0)))
  const settled = prior.filter((task) => task.state !== 'proposed')
  const kept = new Set<string>()
  const tasks: PrepSuggestion[] = []
  for (const task of input) {
    const before = settled.find((item) => titleKey(item.title) === titleKey(task.title))
    if (before) {
      if (kept.has(before.id)) continue
      kept.add(before.id)
      tasks.push(before)
    } else {
      tasks.push({ ...task, id: `s${++suggestionSeq}`, state: 'proposed' })
    }
  }
  for (const task of settled) {
    if (task.state === 'filed' && !kept.has(task.id)) tasks.push(task)
  }
  if (tasks.length > PREP_TASKS_MAX) throw new Error(`The page keeps its filed tasks. Suggest fewer tasks so the page has at most ${PREP_TASKS_MAX}.`)
  return { tasks, suggestionSeq }
}

/** File or reject only proposed tasks. Keep each successful filing before trying the next one. */
export async function decideTasks(ctx: WorkCtx, workspaceId: string, eventId: string, taskIds: string[], decision: 'accept' | 'reject') {
  const sector = workspaceSector(ctx, workspaceId)
  const event = await eventOf(ctx, sector, eventId)
  const { row, last } = standing(new PrepStore(ctx.db), workspaceId, event)
  const after = row?.doc.after
  const failed: { id: string; error: string }[] = []
  if (row && after) {
    const selected = new Set(taskIds)
    const picked = after.tasks.filter((task) => task.state === 'proposed' && selected.has(task.id))
    if (picked.length && decision === 'reject') {
      const tasks = after.tasks.map((task): PrepSuggestion => task.state === 'proposed' && selected.has(task.id) ? { ...task, state: 'rejected' } : task)
      writePage(ctx, workspaceId, event, last, { ...row.doc, after: { ...after, tasks } }, Date.now())
    } else if (decision === 'accept') {
      let tasks = after.tasks
      for (const task of picked) {
        let lifeosTaskId: string
        try {
          // The current calendar facts may differ from the page’s last write.
          lifeosTaskId = await fileTask(ctx, sector, { id: row.id, title: event.title, startsAt: event.startsAt }, task)
        } catch (err) {
          failed.push({ id: task.id, error: lifeosWords(err) })
          continue
        }
        tasks = tasks.map((item) => item.id === task.id ? { ...item, state: 'filed', lifeosTaskId } : item)
        const kept = writePage(ctx, workspaceId, event, last, { ...row.doc, after: { ...after, tasks } }, Date.now())
        const sessionId = kept.followSessionId
        if (sessionId && ctx.scopeOf(sessionId)) {
          try {
            ctx.results.add({ sessionId, kind: 'prep.task.filed', summary: `Filed the task “${task.title}”`, ref: { at: 'lifeos', table: 'tasks', id: lifeosTaskId } })
          } catch (err) {
            ctx.log(`prep: could not record the filed task as a result: ${errorText(err)}`)
          }
        }
      }
    }
  }
  return { page: (await gather(ctx, workspaceId, eventId)).page, failed }
}
