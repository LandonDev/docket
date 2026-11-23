import { z } from 'zod'
import {
  PREP_LINES_MAX,
  PREP_MATTERS_MAX,
  PREP_PEOPLE_MAX,
  PREP_TASKS_MAX,
  PrepAddedPersonSchema,
  PrepFileRefSchema,
  PrepLineSchema,
  PrepSuggestionSchema
} from '@shared/contract-work-prep'
import { errorText, workText, type WorkScope } from '@shared/work'
import type { ToolCtx, WorkTool } from '../modules'
import { rewriteTasks } from './after'
import { eventOf, gather, standing, startDoc, upcoming } from './gather'
import { writePage } from './page'
import { pageWords } from './prompts'
import { changeInOrder } from './serial'
import { personKey } from './series'
import { PrepStore } from './store'
import { workspaceSector } from './workspace'

const eventArg = { event: z.string().trim().min(1).max(200).optional() }
const lines = z.array(PrepLineSchema).max(PREP_LINES_MAX).optional()
const people = PrepAddedPersonSchema.pick({ name: true, address: true })
const file = PrepFileRefSchema.pick({ title: true }).extend({ url: z.url({ protocol: /^https?$/ }).max(2000) })
const suggestion = PrepSuggestionSchema.pick({ title: true, who: true, quote: true }).extend({
  due: z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]).optional()
})

// A date without a time is due at 9 a.m. on this host, as in Meetings.
const dueAt = (due: string): number => Date.parse(due.length === 10 ? `${due}T09:00:00` : due)

function toolWorkspace(ctx: ToolCtx) {
  const { workspaceId, sector } = ctx.scope
  if (!workspaceId || !sector || workspaceSector(ctx, workspaceId) !== sector) throw new Error('This thread needs a Work workspace linked to its LifeOS sector.')
  return { workspaceId, sector }
}

async function toolEvent(ctx: ToolCtx, event?: string): Promise<string> {
  if (event) return event
  const newest = (await ctx.links.forThread(ctx.sessionId))
    .filter((link) => link.entity.table === 'events')
    .sort((a, b) => b.at - a.at)[0]
  if (newest) return newest.entity.id
  throw new Error('This thread has no linked meeting. Pass its LifeOS event id as event.')
}

function tool<T extends z.ZodType>(name: string, description: string, input: T, run: (args: z.output<T>, ctx: ToolCtx) => ReturnType<WorkTool['run']>, readOnly = false): WorkTool {
  return {
    name, description, input, readOnly,
    async run(args, ctx) {
      try {
        return await run(input.parse(args), ctx)
      } catch (err) {
        return { ...workText(errorText(err)), isError: true }
      }
    }
  }
}

const read = tool('prep_read', 'Read a meeting’s page. Pass its LifeOS event id or use the meeting linked to this thread.', z.object(eventArg), async ({ event }, ctx) => {
  const eventId = await toolEvent(ctx, event)
  const { workspaceId } = toolWorkspace(ctx)
  return workText(pageWords((await gather(ctx, workspaceId, eventId)).page))
}, true)

const today = tool('prep_today', 'List the upcoming meetings in this workspace that need a brief, with their facts and event ids.', z.object({}), async (_args, ctx) => {
  const scope = toolWorkspace(ctx)
  const now = Date.now()
  const until = now + 16 * 3_600_000
  const meetings = (await upcoming(ctx, now, until, now, scope))
    .filter((meeting) => meeting.state === 'none' && meeting.startsAt >= now && meeting.startsAt < until)
    .slice(0, 8)
  const { workspaceId } = toolWorkspace(ctx)
  const pages = await Promise.all(meetings.map(async (meeting) => (await gather(ctx, workspaceId, meeting.eventId, now)).page))
  return workText(pages.filter((page) => page.state === 'none').map(pageWords).join('\n\n') || 'No meetings today need a brief.')
}, true)

const write = tool(
  'prep_write',
  'Write the brief for a meeting: up to five things the owner should know or decide walking in, one line each. It replaces the brief whole. A line may name the mail thread, task or document it is about in ref. Pass the event id or use this thread’s linked meeting.',
  z.object({ ...eventArg, matters: z.array(PrepLineSchema).min(1).max(PREP_MATTERS_MAX), agreed: lines, files: z.array(file).max(PREP_LINES_MAX).optional(), people: z.array(people).max(PREP_PEOPLE_MAX).optional() }),
  async (args, ctx) => {
    const { workspaceId } = toolWorkspace(ctx)
    const eventId = await toolEvent(ctx, args.event)
    return changeInOrder(ctx, [workspaceId, eventId], async () => {
      const { sector } = toolWorkspace(ctx)
      const event = await eventOf(ctx, sector, eventId)
      const { row, last } = standing(new PrepStore(ctx.db), workspaceId, event)
      const doc = row?.doc ?? startDoc(last)
      const added = new Map(doc.people.map((person) => [personKey(person), person]))
      for (const person of args.people ?? []) {
        const key = personKey(person)
        if (!added.has(key)) added.set(key, person)
      }
      if (added.size > PREP_PEOPLE_MAX) throw new Error(`The page can keep at most ${PREP_PEOPLE_MAX} added people.`)
      const at = Date.now()
      const brief = { matters: args.matters, agreed: args.agreed ?? [], files: args.files ?? [], at, by: ctx.sessionId }
      writePage(ctx, workspaceId, event, last, { ...doc, people: [...added.values()], brief }, at)
      return workText(`Kept the brief for “${event.title}” (${args.matters.length} ${args.matters.length === 1 ? 'thing' : 'things'}). It is on the meeting’s page.`)
    })
  }
)

const followUp = tool(
  'prep_follow_up',
  'Keep the outcome of a meeting: what was decided, what is still open, and the tasks that came of it. The tasks are suggestions that wait for the owner to tick them; nothing is filed by you. A rewrite keeps what he already accepted or rejected. Pass the event id or use this thread’s linked meeting.',
  z.object({ ...eventArg, summary: lines, decisions: lines, questions: lines, tasks: z.array(suggestion).max(PREP_TASKS_MAX).optional() }),
  async (args, ctx) => {
    const { workspaceId } = toolWorkspace(ctx)
    const eventId = await toolEvent(ctx, args.event)
    return changeInOrder(ctx, [workspaceId, eventId], async () => {
      const { sector } = toolWorkspace(ctx)
      const event = await eventOf(ctx, sector, eventId)
      const { row, last } = standing(new PrepStore(ctx.db), workspaceId, event)
      const doc = row?.doc ?? startDoc(last)
      const input = (args.tasks ?? []).map(({ due, ...task }) => ({ ...task, ...(due ? { due: dueAt(due) } : {}) }))
      const { tasks, suggestionSeq } = rewriteTasks(input, doc.after?.tasks ?? [], row?.suggestionSeq ?? 0)
      const at = Date.now()
      const after = { summary: args.summary ?? [], decisions: args.decisions ?? [], questions: args.questions ?? [], tasks, at }
      writePage(ctx, workspaceId, event, last, { ...doc, after }, at, { suggestionSeq })
      return workText(`Kept the outcome for “${event.title}”. Suggested tasks wait for the owner on the meeting’s page.`)
    })
  }
)

export function prepTools(scope: WorkScope): WorkTool[] {
  return scope.workspaceId && scope.sector ? [read, today, write, followUp] : []
}

export function prepPreamble(scope: WorkScope): string | null {
  if (!scope.workspaceId || !scope.sector) return null
  return 'For a meeting, put its tasks in prep_follow_up and leave them for the owner. Never use add_task for them.\nUse draft_mail for a follow-up mail. Never send it.'
}
