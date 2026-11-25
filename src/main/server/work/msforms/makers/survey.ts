import type { ContextChip } from '@shared/work'
import type { Caller, WorkCtx } from '../../modules'
import { hisZone } from '../../clock'
import { eventOf, type LifeEvent } from '../../prep/gather'
import { jobOf, MsformsError } from '../reach'

/**
 * A meeting's follow-up survey (docs/agents/work-msforms.md "The makers"): his press on "Make a follow-up survey" in
 * a meeting's page starts a Work thread about the event, told to draft the questions with `msform_create`
 * (`collect: true`), and once he has pressed that, to `draft_mail` the link to the attendees. Both wait for his
 * press (the make, then the mail LifeOS holds); nothing is sent here.
 */

export const surveyTitle = (title: string): string => `Follow-up survey: ${title}`.slice(0, 120)

/** The event's day and time in his zone, as a thread reads it. */
const whenOf = (event: Pick<LifeEvent, 'startsAt' | 'allDay'>, zone: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric', ...(event.allDay ? {} : { hour: 'numeric', minute: '2-digit' }) }).format(event.startsAt)

/** The thread's first message: the meeting by name and time, who was on it, and the two steps, each held for his press. */
export function surveyMessage(event: Pick<LifeEvent, 'title' | 'startsAt' | 'allDay' | 'attendees' | 'description'>, zone: string): string {
  const people = (event.attendees ?? []).filter((a) => a.address && a.response !== 'declined')
  const who = people.length ? people.map((a) => (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address)).join(', ') : 'nobody listed on the event'
  return [
    `Make a follow-up survey for the meeting “${event.title}” on ${whenOf(event, zone)}.`,
    `Attendees: ${who}.`,
    event.description?.trim() ? `The event says: ${event.description.trim().slice(0, 2000)}` : null,
    '',
    'Draft a few short questions about how the meeting went and what should happen next (no more than eight; a rating, a choice or a short answer each). Then call msform_create with them and `collect: true`, in a Teams or OneDrive folder of this job; ask me which folder if you do not know. The make waits for my press.',
    'Once I have pressed it and the form is collecting, call draft_mail to the attendees above with its link and one line on why. LifeOS keeps the mail as a draft for me to send; never send it yourself, and do not share the link any other way.'
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

/**
 * The meeting from LifeOS, its failures said in our own sentences: an id LifeOS does not take or holds no row for is no
 * such event, and anything else is LifeOS not answering. Its own error text (a Convex trace) never reaches the window.
 */
async function meetingOf(ctx: WorkCtx, sector: Parameters<typeof eventOf>[1], eventId: string): Promise<LifeEvent> {
  try {
    return await eventOf(ctx, sector, eventId)
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    if (err instanceof MsformsError) throw err
    if (/^(LifeOS has no such event\.|That event is not in )/.test(text)) throw new MsformsError(text)
    if (/ArgumentValidationError|not found/i.test(text)) throw new MsformsError('LifeOS has no such event.')
    throw new MsformsError('LifeOS did not answer about that meeting. Try again in a moment.')
  }
}

/** His press: the thread starts in the meeting's job, about the event; the event must be in the job's sector. */
export async function startSurvey(ctx: WorkCtx, by: Caller, workspaceId: string, eventId: string): Promise<{ sessionId: string }> {
  const workspace = jobOf(ctx, by, workspaceId)
  if (!workspace.sector) throw new MsformsError('This job is not linked to a LifeOS sector, so it has no meetings.')
  const event = await meetingOf(ctx, workspace.sector as never, eventId)
  const about: ContextChip = { kind: 'event', label: event.title, ref: { at: 'lifeos', table: 'events', id: event._id } }
  const sessionId = await ctx.threads.start({ workspaceId: workspace.id, title: surveyTitle(event.title), about, text: surveyMessage(event, hisZone(ctx)), by })
  return { sessionId }
}
