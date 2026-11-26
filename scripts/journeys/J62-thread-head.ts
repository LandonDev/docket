import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ThreadRecord } from '../../src/shared/work/threadRecord'
import { composeRow } from './lib/mailJourney'
import { addon, evidence, see, sendPrompt } from './lib/lifeosJourney'
import { journey, step, type Context } from './lib/record'
import { createThread } from './lib/thread'

const SUBJECT = 'Spring LAN switches'
const HEAD = '[data-work-head]'
const threads = new WeakMap<Context, { session: string; draft: string }>()

const record = (context: Context): Promise<ThreadRecord> =>
  context.pair.rpc<ThreadRecord>(context.pair.box, 'work.threads.record', { sessionId: threads.get(context)!.session })

export default journey({
  id: 'J62',
  title: 'A thread holds a mail, its head shows it, and Send from the head’s sheet clears it',
  tier: 2,
  shapes: ['S'],
  steps: [
    step('A sandbox Work thread is asked for a mail and holds it in LifeOS', async (context) => {
      const { pair, workspace } = context
      const accounts = await pair.sandbox!.query<{ _id: string; address: string }[]>('mail:accounts')
      const account = accounts.find(({ address }) => address === 'spring-lan@example.org')
      if (!account) throw new Error('The sandbox has no Spring LAN mailbox')
      const session = await createThread(pair, workspace.id, 'Spring LAN switches')
      await pair.page.eval(`window.__docket.open(${JSON.stringify(session.id)})`)
      await sendPrompt(pair.page, 'Ask Dana for two switches for the LAN.')
      const { id } = await addon<{ id: string }>(context, session.id, 'draft_mail', {
        account_id: account._id, to: [{ name: 'Dana Lee', address: 'dana@example.com' }],
        subject: SUBJECT, body: 'Could we borrow two switches for the spring LAN?', reason: 'Ready for the owner to check'
      })
      threads.set(context, { session: session.id, draft: id })
      let got: ThreadRecord | undefined
      await pair.page.until('the thread’s record to hold the mail', 15_000, async () => {
        got = await record(context)
        return got.waits.some((w) => w.kind === 'held' && w.item.ref.id === id) && got.outcome?.words === '1 mail to send'
      })
      evidence(context, 'record-held', got)
    }),
    step('The thread’s head names the held mail over its first message, muted', async (context) => {
      const { page } = context.pair
      await see(page, HEAD, 'Send to Dana Lee')
      const amber = await page.eval<boolean>(`!!document.querySelector(${JSON.stringify(HEAD)})?.innerHTML.match(/warning/)`)
      if (amber) throw new Error('The held row took the question’s amber')
      await page.shot(join(context.folder, 'head.png'))
    }),
    step('end: Send from the head’s sheet queues the mail in LifeOS and the head lets it go', async (context) => {
      const { pair, folder } = context
      const { page } = pair
      // The held row is named by its press (WorkHead.tsx `Open ${act}`).
      await page.clickOn(`${HEAD} [data-head-row]`, 'Open Send to Dana Lee')
      await see(page, '[data-work-head-held]', SUBJECT)
      await page.clickOn('[data-work-head-held] button', 'Send')
      const draft = threads.get(context)!.draft
      await page.until('the LifeOS mail row queued', 10_000, async () => (await composeRow(context, draft)).status === 'queued')
      let after: ThreadRecord | undefined
      await page.until('the record and the head without the held mail', 15_000, async () => {
        after = await record(context)
        const shown = await page.eval<boolean>(`!!document.querySelector(${JSON.stringify(HEAD)})?.innerText.includes('Send to Dana Lee')`)
        return !after.waits.some((w) => w.kind === 'held') && !shown
      })
      writeFileSync(join(folder, 'record-after.json'), JSON.stringify(after, null, 2))
    })
  ]
})
