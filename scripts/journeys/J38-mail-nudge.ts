import { composeRow } from './lib/mailJourney'
import { checkLink, draftReply, evidence, heldMail, mailbox, MAIL_LIST, newThread, PAGE, see } from './lib/lifeosJourney'
import { SECTOR } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'

const SUBJECT = 'Spring LAN unanswered room request'
const REPLY = 'Can you still hold the east room for Spring LAN? Please let me know when you can.'
const waits = new WeakMap<Context, { mail: string; session: string }>()

export default journey({
  id: 'J38', title: 'Nudge an unanswered sent mail and leave the draft waiting', tier: 2, shapes: ['S'],
  steps: [
    step('Find the unanswered mail in Waiting on and press Draft a nudge', async (context) => {
      const { pair, workspace } = context
      const { page } = pair
      await pair.showWork(workspace, 'Mail')
      await mailbox(page, 'Waiting on')
      await see(page, MAIL_LIST, SUBJECT)
      const rows = await pair.sandbox!.query<{ page: { _id: string; subject: string; waiting: unknown }[] }>('mailWaits:list', { sector: SECTOR, paginationOpts: PAGE })
      const row = rows.page.find((row) => row.subject === SUBJECT && row.waiting)
      if (!row) throw new Error('LifeOS has no due wait on the unanswered mail')
      const option = `${MAIL_LIST} [role="option"][aria-label*=${JSON.stringify(SUBJECT)}]`
      const point = await page.centre(option)
      if (!point) throw new Error('Waiting on did not draw the selected mail')
      const session = await newThread(context, async () => {
        await page.click(point, 1, 'right')
        await page.press('menuitem', 'Draft a nudge')
      })
      await see(page, 'body', 'Draft a short follow-up to the mail')
      evidence(context, 'wait', { row, links: await checkLink(context, 'mailThreads', row._id, session) })
      waits.set(context, { mail: row._id, session })
    }),
    step('end: the nudge reply is held in Outbox and the wait still stands', async (context) => {
      const { mail, session } = waits.get(context)!
      const id = await draftReply(context, session, mail, REPLY)
      const row = await composeRow(context, id)
      if (row.status !== 'draft' || row.message.text !== REPLY || row.sendAt !== undefined) throw new Error('The nudge did not stay in Drafts')
      await heldMail(context, id, 'Sam Ortiz')
      await see(context.pair.page, '[data-outbox-detail]', REPLY)
      const wait = await context.pair.sandbox!.query('mailWaits:get', { threadId: mail })
      if (!wait) throw new Error('Drafting the nudge cleared the wait')
      evidence(context, 'held', { row, wait })
    })
  ]
})
