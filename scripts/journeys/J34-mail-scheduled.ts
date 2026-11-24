import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SECOND_MAIL } from './lib/lifeosSeed'
import { COMPOSE, mailToast, readReply, startReply, type MailRow } from './lib/mailJourney'
import { journey, step, type Context } from './lib/record'

const REPLY = 'I will bring a spare sign-in sheet.'
const ZONE = 'America/Chicago'
const list = ({ folder }: Context): string => join(folder, 'scheduled-outbox.json')
const SUBJECT = 'Re: ' + SECOND_MAIL

export function scheduledWords(line: string): boolean {
  return /Scheduled for [^\n]*\bCentral(?=\b|Undo)/.test(line) && !/\bSending\b/.test(line)
}

export default journey({
  id: 'J34',
  title: 'Schedule a reply in Central time and cancel it',
  tier: 2,
  shapes: ['S'],
  steps: [
    step('Reply and schedule from the Send later picker in Central time', async (context) => {
      const { page } = context.pair
      await startReply(context, SECOND_MAIL, REPLY)
      await readReply(context, SECOND_MAIL, REPLY, 'draft', 'draft')
      await page.clickOn(`${COMPOSE} button[aria-label="More ways to send"]`)
      await page.press('menuitem', 'Pick date and time…')
      await page.clickOn('[aria-label="Time zone"]')
      await page.clickOn('[role="option"]', 'Central')
      await page.watchToasts()
      await page.clickOn('[data-slot="popover-content"] button', 'Schedule')
      const row = await readReply(context, SECOND_MAIL, REPLY, 'scheduled', 'queued')
      if (!row.scheduled || row.sendZone !== ZONE || !row.sendAt || row.sendAt <= Date.now()) {
        throw new Error('LifeOS did not schedule the reply in Central time')
      }
      await mailToast(context, 'Scheduled for ')
      if (!(await page.toasts(true)).some(scheduledWords)) throw new Error('The schedule toast did not say Central time')
      await page.until('Mail’s scheduled reply card in Central time', 5000, async () => {
        const card = await page.eval<string | undefined>(`document.querySelector('[data-mail-pane] button[aria-label^="Scheduled for "]')?.getAttribute('aria-label')`)
        return card !== undefined && scheduledWords(card)
      })
    }),
    step('Read what Outbox shows for the scheduled reply', async (context) => {
      const { pair, folder } = context
      const { page } = pair
      await page.clickOn('nav [data-rail-row] > button > span.truncate', 'Outbox')
      await page.press('tab', 'Waiting')
      await page.until('Outbox to finish opening', 8000, () =>
        page.eval(`!!document.querySelector('[data-outbox-list] li, [data-outbox-empty]')`))
      const target = await page.centre('[data-outbox-list] [data-row-title]', 'Send to Sam Ortiz')
      if (target) await page.click(target)
      const detail = await page.eval<string>(`document.querySelector('[data-outbox-detail]')?.innerText ?? ''`)
      const rows = await page.eval<string[]>(`[...document.querySelectorAll('[data-outbox-list] li')].map((row) => row.innerText)`)
      const scheduled = await pair.sandbox!.query<MailRow[]>('compose:list', { view: 'scheduled' })
      const row = scheduled.find(({ message }) => message.subject === SUBJECT)
      if (!row) throw new Error('LifeOS does not list the reply as scheduled')
      const held = await pair.sandbox!.query<MailRow[]>('outboxHeld:held', { host: pair.box.host })
      const showed = detail.includes(SUBJECT) && scheduledWords(detail) && rows.some(scheduledWords)
      await page.shot(join(folder, 'scheduled-outbox.png'))
      writeFileSync(list(context), JSON.stringify({ row, detail, rows, inHostOutbox: held.some(({ _id }) => _id === row._id), showed }, null, 2))
    }),
    step('end: verify Outbox wording and return the scheduled reply to a draft', async (context) => {
      const { pair, workspace } = context
      const queued = await readReply(context, SECOND_MAIL, REPLY, 'before cancel', 'queued')
      await pair.showWork(workspace, 'Mail')
      await pair.page.clickOn(`[data-mail-list] [role="option"][aria-label*=${JSON.stringify(SECOND_MAIL)}]`)
      await pair.page.clickOn('[data-mail-pane] button', 'Cancel send')
      const draft = await readReply(context, SECOND_MAIL, REPLY, 'cancelled', 'draft')
      if (queued._id !== draft._id || draft.scheduled || draft.sendAt !== undefined) throw new Error('LifeOS kept the scheduled time or replaced the row')
      await pair.page.until('the scheduling card to leave the mail', 5000, () =>
        pair.page.eval(`!document.querySelector('[data-mail-pane] button[aria-label^="Scheduled for "]')`))
      const outbox = JSON.parse(readFileSync(list(context), 'utf8')) as { showed: boolean; inHostOutbox: boolean }
      if (!outbox.showed) throw new Error(`Outbox did not show Scheduled for in Central time. LifeOS included the row in box’s Outbox feed: ${outbox.inHostOutbox}.`)
    })
  ]
})
