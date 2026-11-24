import { z } from 'zod'
import {
  PREP_LINES_MAX,
  PREP_MATTERS_MAX,
  PREP_PEOPLE_MAX,
  PREP_TASKS_MAX,
  PREP_WRITERS_MAX,
  PrepAddedPersonSchema,
  PrepFileRefSchema,
  PrepLineSchema,
  PrepSuggestionSchema
} from '@shared/contract-work-prep'
import { errorText, workText, type SectorKey, type WorkScope } from '@shared/work'
import type { ToolCtx, WorkTool } from '../modules'
import { rewriteTasks } from './after'
import { draftsOf, eventOf, gather, meetingOf, ownAdditions, standing, startDoc, upcoming } from './gather'
import { writePage } from './page'
import { notesDocWords } from './docWords'
import { pageWords } from './prompts'
import { changeInOrder } from './serial'
import { personKey } from './series'
import { PrepStore, supersededOn, type PageRow } from './store'
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

/** How often, and for how long, `prep_read` looks for a recording that is still on its way to the page's follow-up thread. */
export const fileWait = { everyMs: 1000, forMs: 8 * 60_000 }

/**
 * A recording goes up after its follow-up thread starts (an upload needs a thread to go to), so that thread's first
 * read can come before the file. It waits here, in one tool call, until the meetings pillar has the file, the page
 * has let go of it (it never arrived), or the time is up: never a model turn a look.
 */
async function awaitRecording(ctx: ToolCtx, workspaceId: string, eventId: string): Promise<'none' | 'here' | 'dropped' | 'late'> {
  const store = new PrepStore(ctx.db)
  const first = store.get(workspaceId, eventId)
  const itemId = first?.doc.notes?.meetingItemId
  if (!first || !itemId || first.followSessionId !== ctx.sessionId) return 'none'
  const end = Date.now() + fileWait.forMs
  for (;;) {
    const status = (await meetingOf(ctx, itemId))?.status
    if (status && status !== 'empty') return 'here'
    const now = store.get(workspaceId, eventId)
    if (now?.doc.notes?.meetingItemId !== itemId || now.followSessionId !== ctx.sessionId) return 'dropped'
    if (ctx.signal.aborted || Date.now() >= end) return 'late'
    await new Promise((resolve) => setTimeout(resolve, fileWait.everyMs))
  }
}

/**
 * A brief or an outcome from a thread a later press put another in the place of is not kept: his newer ask stands
 * (a late answer would replace the newer thread's result and its suggestions). A thread the page never named, as
 * Prepare ahead's routine thread, writes as before.
 */
function refuseReplaced(row: PageRow | null, kind: 'brief' | 'follow', sessionId: string): void {
  if (supersededOn(row, kind, sessionId)) throw new Error(`A newer ${kind === 'brief' ? 'brief' : 'follow-up'} thread was started for this meeting, so this one's ${kind === 'brief' ? 'brief' : 'outcome'} is not kept. Stop here: write nothing more and draft no mail.`)
}

/**
 * An outcome from the follow-up thread's older turn, after he changed his notes and the host told the thread so
 * (`notesOwed`): that turn read the old notes, and its outcome and suggestions would stand as the new ones. It is
 * refused until the thread writes with the version it was told.
 */
function refuseOldNotes(row: PageRow | null, sessionId: string, version: number | undefined): void {
  if (row?.notesOwed == null || row.followSessionId !== sessionId || version === row.notesOwed) return
  throw new Error(`His notes changed after you read them, so this outcome is not kept. You are told the new notes when this turn ends: write nothing more now and draft no mail.`)
}

/**
 * The threads an outcome names after this write, oldest first: every one that wrote it, so the mail an earlier one
 * drafted stays on the page. Past the page's limit, the oldest that left no mail waiting go first; one whose mail
 * could not be read is kept as if it had.
 */
async function writersOf(ctx: ToolCtx, sector: SectorKey, before: readonly string[], sessionId: string): Promise<string[]> {
  const by = [...before.filter((id) => id !== sessionId), sessionId]
  if (by.length <= PREP_WRITERS_MAX) return by
  const client = ctx.lifeos.owner()
  const holds = await Promise.all(by.slice(0, -1).map((id) => draftsOf(client, sector, id).then((drafts) => drafts.length > 0, () => true)))
  let over = by.length - PREP_WRITERS_MAX
  const kept = by.filter((_id, i) => i === by.length - 1 || holds[i] || over-- <= 0)
  return kept.slice(-PREP_WRITERS_MAX)
}

const read = tool('prep_read', 'Read a meeting’s page. Pass its LifeOS event id or use the meeting linked to this thread. For the follow-up thread of a recording that is still being sent, it waits for the file.', z.object(eventArg), async ({ event }, ctx) => {
  const eventId = await toolEvent(ctx, event)
  const { workspaceId, sector } = toolWorkspace(ctx)
  // The fence first: nothing is waited on for an event of another sector.
  await eventOf(ctx, sector, eventId)
  const recording = await awaitRecording(ctx, workspaceId, eventId)
  const page = (await gather(ctx, workspaceId, eventId)).page
  const words = pageWords(page, { docWords: await notesDocWords(ctx, page) })
  if (recording === 'dropped') return workText(`${words}\n\nThe recording this thread was started for never arrived, and the page no longer waits for it. Stop here: write no outcome and draft no mail.`)
  if (recording === 'late') return workText(`${words}\n\nThe recording is still on its way. Call prep_read again to keep waiting for it.`)
  return workText(words)
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
  return workText(pages.filter((page) => page.state === 'none').map((page) => pageWords(page)).join('\n\n') || 'No meetings today need a brief.')
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
      refuseReplaced(row, 'brief', ctx.sessionId)
      const doc = row?.doc ?? startDoc(last)
      const added = new Map(doc.people.map((person) => [personKey(person), person]))
      // Someone the calendar lists is not kept as an addition, as his own Add people keeps none.
      for (const person of ownAdditions(event, args.people ?? [])) {
        const key = personKey(person)
        if (!added.has(key)) added.set(key, person)
      }
      if (added.size > PREP_PEOPLE_MAX) throw new Error(`The page can keep at most ${PREP_PEOPLE_MAX} added people.`)
      const at = Date.now()
      const brief = { matters: args.matters, agreed: args.agreed ?? [], files: args.files ?? [], at, by: ctx.sessionId }
      writePage(ctx, workspaceId, event, last, (current) => ({ ...current, people: [...added.values()], brief }), at)
      return workText(`Kept the brief for “${event.title}” (${args.matters.length} ${args.matters.length === 1 ? 'thing' : 'things'}). It is on the meeting’s page.`)
    })
  }
)

const followUp = tool(
  'prep_follow_up',
  'Keep the outcome of a meeting: what was decided, what is still open, and the tasks that came of it. The tasks are suggestions that wait for the owner to tick them; nothing is filed by you. A rewrite keeps what he already accepted or rejected. Pass the event id or use this thread’s linked meeting. When you were told his notes changed and given a notes version, pass it as notes.',
  z.object({ ...eventArg, summary: lines, decisions: lines, questions: lines, tasks: z.array(suggestion).max(PREP_TASKS_MAX).optional(), notes: z.number().int().nonnegative().optional() }),
  async (args, ctx) => {
    const { workspaceId } = toolWorkspace(ctx)
    const eventId = await toolEvent(ctx, args.event)
    return changeInOrder(ctx, [workspaceId, eventId], async () => {
      const { sector } = toolWorkspace(ctx)
      const event = await eventOf(ctx, sector, eventId)
      const { row, last } = standing(new PrepStore(ctx.db), workspaceId, event)
      refuseReplaced(row, 'follow', ctx.sessionId)
      refuseOldNotes(row, ctx.sessionId, args.notes)
      const doc = row?.doc ?? startDoc(last)
      const input = (args.tasks ?? []).map(({ due, ...task }) => ({ ...task, ...(due ? { due: dueAt(due) } : {}) }))
      const { tasks, suggestionSeq, dismissed, unanswered } = rewriteTasks(input, doc.after?.tasks ?? [], row?.suggestionSeq ?? 0, doc.after?.dismissed ?? [], doc.after?.unanswered ?? [])
      const by = await writersOf(ctx, sector, doc.after?.by ?? [], ctx.sessionId)
      const at = Date.now()
      const after = { summary: args.summary ?? [], decisions: args.decisions ?? [], questions: args.questions ?? [], tasks, at, by, ...(dismissed.length ? { dismissed } : {}), ...(unanswered.length ? { unanswered } : {}) }
      // Only the outcome changes, on the row as it stands after the reads above; the version owed is paid.
      writePage(ctx, workspaceId, event, last, (current) => ({ ...current, after }), at, { suggestionSeq, ...(row?.notesOwed != null ? { notesOwed: null } : {}) })
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
