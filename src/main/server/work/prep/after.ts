import { PREP_DISMISSED_MAX, PREP_TASKS_MAX, PREP_UNANSWERED_MAX, type PrepSuggestion } from '@shared/contract-work-prep'
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

type Suggested = Omit<PrepSuggestion, 'id' | 'state' | 'lifeosTaskId' | 'tried'>

const titleKey = (title: string) => foldTitle(title) || title.normalize('NFKC').trim().toLowerCase()

const sameWords = (a: Suggested, b: Suggested): boolean =>
  a.title === b.title && (a.who ?? '') === (b.who ?? '') && a.due === b.due && (a.quote ?? '') === (b.quote ?? '')
const sameSuggestion = (a: Suggested, b: PrepSuggestion): boolean => sameWords(a, b)

/**
 * Take the thread’s new suggestions and keep any decisions the owner already made. A suggestion he dismissed stays
 * dismissed though a rewrite between left it out (its folded title is kept in `dismissed`). One that waits for his
 * tick and comes back unchanged keeps its id, so a filing LifeOS took but never answered keeps its key on Retry; an
 * edited one is a new suggestion with a new id. One whose filing went unanswered and that a rewrite leaves out is
 * kept aside (`unanswered`), so it keeps its id however many rewrites pass before it is suggested again.
 */
export function rewriteTasks(input: Suggested[], prior: PrepSuggestion[], sequence: number, dismissedBefore: readonly string[] = [], unansweredBefore: readonly PrepSuggestion[] = []): { tasks: PrepSuggestion[]; suggestionSeq: number; dismissed: string[]; unanswered: PrepSuggestion[] } {
  let suggestionSeq = Math.max(sequence, ...[...prior, ...unansweredBefore].map((task) => Number(/^s(\d+)$/.exec(task.id)?.[1] ?? 0)))
  const settled = prior.filter((task) => task.state !== 'proposed')
  // Oldest first: the ones set aside before, then the page's own, so a cap drops the oldest key, never the newest.
  const waiting = [...unansweredBefore, ...prior.filter((task) => task.state === 'proposed')]
  const dismissed = new Set(dismissedBefore)
  const kept = new Set<string>()
  const tasks: PrepSuggestion[] = []
  // A suggestion said twice word for word is one task: two ids would be two filing keys, and one Add would make it twice
  // in LifeOS. It collapses before any id is given, so the one left keeps a key an earlier filing used.
  const once = input.filter((task, i) => input.findIndex((other) => sameWords(other, task)) === i)
  for (const task of once) {
    const before = settled.find((item) => titleKey(item.title) === titleKey(task.title))
    if (before) {
      if (kept.has(before.id)) continue
      kept.add(before.id)
      tasks.push(before)
      continue
    }
    if (dismissed.has(titleKey(task.title))) continue
    const same = waiting.find((item) => !kept.has(item.id) && sameSuggestion(task, item))
    if (same) {
      kept.add(same.id)
      tasks.push(same)
    } else {
      tasks.push({ ...task, id: `s${++suggestionSeq}`, state: 'proposed' })
    }
  }
  for (const task of settled) {
    if (kept.has(task.id)) continue
    if (task.state === 'filed') tasks.push(task)
    else dismissed.add(titleKey(task.title))
  }
  const unanswered = waiting.filter((task) => task.tried && !kept.has(task.id)).slice(-PREP_UNANSWERED_MAX)
  if (tasks.length > PREP_TASKS_MAX) throw new Error(`The page keeps its filed tasks. Suggest fewer tasks so the page has at most ${PREP_TASKS_MAX}.`)
  // A title the page still lists as dismissed is said there; the newest of the rest are kept.
  const listed = new Set(tasks.filter((task) => task.state === 'rejected').map((task) => titleKey(task.title)))
  return { tasks, suggestionSeq, dismissed: [...dismissed].filter((key) => !listed.has(key)).slice(-PREP_DISMISSED_MAX), unanswered }
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
    // Each write changes the tasks alone, on the row as it stands then: a filing waits on LifeOS, and a rename of
    // the notes document in Files meanwhile is kept.
    const setTask = (id: string, change: (task: PrepSuggestion) => PrepSuggestion) =>
      writePage(ctx, workspaceId, event, last, (doc) => (doc.after ? { ...doc, after: { ...doc.after, tasks: doc.after.tasks.map((t) => (t.id === id ? change(t) : t)) } } : doc), Date.now())
    if (picked.length && decision === 'reject') {
      writePage(ctx, workspaceId, event, last, (doc) => (doc.after ? { ...doc, after: { ...doc.after, tasks: doc.after.tasks.map((task): PrepSuggestion => task.state === 'proposed' && selected.has(task.id) ? { ...task, state: 'rejected' } : task) } } : doc), Date.now())
    } else if (decision === 'accept') {
      // Each filing is marked tried before LifeOS is asked: LifeOS may make the task and the answer be lost, or this
      // host stop before it comes, and the key must then outlive any rewrite (`unanswered`). One write for them all.
      const untried = new Set(picked.filter((task) => !task.tried).map((task) => task.id))
      if (untried.size) writePage(ctx, workspaceId, event, last, (doc) => (doc.after ? { ...doc, after: { ...doc.after, tasks: doc.after.tasks.map((t) => (untried.has(t.id) ? { ...t, tried: true } : t)) } } : doc), Date.now())
      for (const task of picked) {
        let lifeosTaskId: string
        try {
          // The current calendar facts may differ from the page’s last write.
          lifeosTaskId = await fileTask(ctx, sector, { id: row.id, title: event.title, startsAt: event.startsAt }, task)
        } catch (err) {
          // It stays tried: LifeOS may have made it and lost the answer, and its key outlives any rewrite.
          failed.push({ id: task.id, error: lifeosWords(err) })
          continue
        }
        // Filed: the key is settled, and the mark goes.
        const kept = setTask(task.id, ({ tried: _settled, ...t }) => ({ ...t, state: 'filed', lifeosTaskId }))
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
