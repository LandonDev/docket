import type { PrepPage } from '../../src/shared/contract-work-prep'
import { checkLink, draftReply, evidence, heldMail, newThread, openMail, see } from './lib/lifeosJourney'
import { FIRST_MAIL, SECTOR } from './lib/lifeosSeed'
import { composeRow } from './lib/mailJourney'
import { journey, step, type Context } from './lib/record'
import { workTool } from './lib/thread'

const MEETING = 'Spring LAN setup'
const BRIEF = 'Check the spare adapters before doors open.'
const NOTES = 'Dana agreed to bring the room map.'
const TASK = 'Print the updated Spring LAN map'
const OTHER = 'Find a spare power strip'
const REPLY = 'Thanks for helping with setup. I will print the updated room map.'
const REGION = '[role="region"][aria-label="Meeting"]'
const state = new WeakMap<Context, { eventId: string; follow?: string }>()
const pageFrom = async ({ pair, workspace }: Context, eventId: string) =>
  (await pair.rpc<{ page: PrepPage }>(pair.box, 'work.prep.page', { workspaceId: workspace.id, eventId })).page

async function returnToMeeting(context: Context): Promise<void> {
  const { pair, workspace } = context
  if (await pair.page.centre(REGION)) return
  await pair.showWork(workspace, 'Agenda')
  const row = '[role="region"][aria-label="Agenda"] [role="listitem"] span'
  let point: { x: number; y: number } | null = null
  await pair.page.until(MEETING, 10_000, async () => (point = await pair.page.centre(row, MEETING)))
  await pair.page.click(point!, 1, 'right')
  await pair.page.press('menuitem', 'Prepare')
  await see(pair.page, REGION, MEETING)
}

export default journey({
  id: 'J42', title: 'Prepare a meeting, file only its ticked task, and hold a follow-up', tier: 2, shapes: ['S'],
  steps: [
    step('Prepare the meeting and record the brief through its thread', async (context) => {
      const { pair } = context
      const from = Date.now()
      const rows = await pair.sandbox!.query<{ _id: string; title: string }[]>('events:range', { sector: SECTOR, from, to: from + 7 * 86_400_000 })
      const event = rows.find(({ title }) => title === MEETING)
      if (!event) throw new Error('LifeOS has no Spring LAN setup meeting')
      state.set(context, { eventId: event._id })
      await returnToMeeting(context)
      const id = await newThread(context, () => pair.page.clickOn(REGION + ' button', 'Brief me'), (row) => row.title.includes(MEETING))
      await checkLink(context, 'events', event._id, id)
      const response = await workTool(pair, id, 'prep_write', { event: event._id, matters: [{ text: BRIEF }] })
      if (response.error) throw new Error(response.text)
      await returnToMeeting(context)
      await see(pair.page, REGION, BRIEF)
      const read = await pageFrom(context, event._id)
      if (!JSON.stringify(read).includes(BRIEF)) throw new Error('The host did not keep the brief')
      evidence(context, 'brief', { session: id, read })
    }),
    step('Add notes and follow up through the meeting’s own thread', async (context) => {
      const { pair } = context
      const event = state.get(context)!
      await pair.page.clickOn(REGION + ' button', 'More')
      await pair.page.press('menuitem', 'Add notes…')
      await pair.page.clickOn('[role="dialog"] textarea')
      await pair.page.typeKeys(NOTES)
      const follow = await newThread(context, () => pair.page.clickOn('[role="dialog"] button', 'Follow up'), (row) => row.title.includes(MEETING))
      event.follow = follow
      await checkLink(context, 'events', event.eventId, follow)
      const result = await workTool(pair, follow, 'prep_follow_up', { event: event.eventId, summary: [{ text: NOTES }], tasks: [{ title: TASK }, { title: OTHER }] })
      if (result.error) throw new Error(result.text)
      await returnToMeeting(context)
      await see(pair.page, '[data-task-state="proposed"]', TASK)
      const read = await pageFrom(context, event.eventId)
      if (![NOTES, TASK, OTHER].every((word) => JSON.stringify(read).includes(word))) throw new Error('The host did not keep the follow-up and both suggestions')
      evidence(context, 'follow-up', { follow, read })
    }),
    step('end: file only the ticked task and leave the follow-up mail held', async (context) => {
      const { pair } = context
      const { follow, eventId } = state.get(context)!
      await pair.page.clickOn(`[data-task-state="proposed"] [role="checkbox"][aria-label=${JSON.stringify(TASK)}]`)
      await pair.page.clickOn(REGION + ' button', 'Add 1 task')
      await see(pair.page, '[data-task-state="filed"]', TASK)
      await see(pair.page, '[data-task-state="proposed"]', OTHER)
      const tasks = await pair.sandbox!.query<{ _id: string; title: string }[]>('tasks:list', { sector: SECTOR })
      if (!tasks.some(({ title }) => title === TASK) || tasks.some(({ title }) => title === OTHER)) throw new Error('LifeOS did not file just the ticked task')
      const mail = await openMail(context, FIRST_MAIL)
      const reread = await workTool(pair, follow!, 'prep_read', { event: eventId })
      const before = await pageFrom(context, eventId)
      if (reread.error || before.drafts.length || before.problems.includes('drafts')) throw new Error('Prep could not confirm that no follow-up draft was waiting')
      const draft = await draftReply(context, follow!, mail._id, REPLY)
      await heldMail(context, draft, 'Dana Lee')
      await see(pair.page, '[data-outbox-detail]', REPLY)
      const row = await composeRow(context, draft)
      if (row.status !== 'draft' || row.sendAt !== undefined) throw new Error('The follow-up mail did not wait for a press')
      await returnToMeeting(context)
      await see(pair.page, REGION, 'Follow-up to Dana Lee')
      await see(pair.page, REGION, 'Waiting in the Outbox')
      const prep = await pageFrom(context, eventId)
      if (prep.drafts.length !== 1 || prep.drafts[0]?.outboxId !== draft) throw new Error('The meeting did not name the same held draft')
      await pair.page.shot(context.folder + '/filed-and-held.png')
      evidence(context, 'filed-and-held', { prep, row, task: tasks.find(({ title }) => title === TASK) })
    })
  ]
})
