import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeRow, type MailRow } from './lib/mailJourney'
import { journey, step, type Context } from './lib/record'

export function queuedAge(line: string): boolean {
  return /Queued in LifeOS for (?:<1m|\d+[mhd])/.test(line.replaceAll(/\s+/g, ' '))
}

const SUBJECT = 'Spring LAN room signs'
const BODY = 'We can leave the signs by the east door.'
const EDIT = 'Please leave the signs at the front desk.'
type Tool = { isError?: boolean; content: { text?: string }[] }

const draftId = (folder: string): string => readFileSync(join(folder, 'draft-id.txt'), 'utf8')

export default journey({
  id: 'J32',
  title: 'Edit and send a thread’s held mail from the Outbox',
  tier: 2,
  shapes: ['S'],
  steps: [
    step('Hold a draft through the LifeOS tool of a sandbox Work thread', async (context) => {
      const { pair, workspace, folder } = context
      const accounts = await pair.sandbox!.query<{ _id: string; address: string }[]>('mail:accounts')
      const account = accounts.find(({ address }) => address === 'spring-lan@example.org')
      if (!account) throw new Error('The sandbox has no Spring LAN mailbox')
      await pair.page.until('the workspace’s draft-only LifeOS tool', 20_000, async () => {
        const status = await pair.rpc<{ keys: { workspaceId: string; addonId?: string }[] }>(pair.box, 'work.lifeos.status')
        const addon = status.keys.find((key) => key.workspaceId === workspace.id)?.addonId
        if (!addon) return false
        const list = await pair.rpc<{ status: Record<string, { state: string }> }>(pair.box, 'addons.list')
        return list.status[addon]?.state === 'ready'
      })
      const session = await pair.rpc<{ id: string }>(pair.box, 'session.create', {
        provider: 'claude', workspaceId: workspace.id, threadType: 'chat', permission: 'auto', title: 'Spring LAN signs'
      })
      const result = await pair.rpc<Tool>(pair.box, 'app.addonCall', {
        sessionId: session.id, tool: 'lifeos__draft_mail',
        arguments: { account_id: account._id, to: [{ name: 'Dana Lee', address: 'dana@example.com' }],
          subject: SUBJECT, body: BODY, reason: 'Put the signs where Dana can find them' }
      }, 20_000)
      if (result.isError) throw new Error(result.content.map(({ text }) => text).join(' '))
      const { id } = JSON.parse(result.content[0]?.text ?? '{}') as { id?: string }
      if (!id) throw new Error('The LifeOS tool returned no draft id')
      const row = await composeRow(context, id)
      if (row?.status !== 'draft' || row.message.text !== BODY) throw new Error('LifeOS did not hold the draft')
      writeFileSync(join(folder, 'draft-id.txt'), id)
    }),
    step('Open the held draft in Outbox, edit it and press Send', async (context) => {
      const { pair, folder } = context
      const { page } = pair
      await page.clickOn('nav [data-rail-row] > button > span.truncate', 'Outbox')
      await page.clickOn('[data-outbox-list] [data-summary-act]', 'Send to Dana Lee')
      await page.until('the held mail subject in Outbox', 5000, () =>
        page.eval(`document.querySelector('[data-outbox-detail]')?.innerText.includes(${JSON.stringify(SUBJECT)})`))
      await page.clickOn('[data-outbox-detail] button', 'Edit')
      await page.clickOn('[role="dialog"] textarea')
      await page.key('Control+a')
      await page.typeKeys(EDIT)
      await page.clickOn('[role="dialog"] button', 'Save')
      await page.until('the revised words in Outbox', 5000, () =>
        page.eval(`document.querySelector('[data-outbox-detail]')?.innerText.includes(${JSON.stringify(EDIT)})`))
      const row = await composeRow(context, draftId(folder))
      if (row.status !== 'draft') throw new Error('Editing the Outbox item changed the LifeOS draft status')
      await page.watchToasts()
      await page.clickOn('[data-outbox-detail] button', 'Send')
    }),
    step('end: LifeOS queued the edited mail and Outbox gives its age', async (context: Context) => {
      const { pair, folder } = context
      const { page } = pair
      const id = draftId(folder)
      let row: MailRow | undefined
      await page.until('the edited LifeOS row queued', 8000, async () => {
        row = await composeRow(context, id)
        return row.status === 'queued' && row.message.text.trim() === EDIT
      })
      await page.press('tab', 'Sent')
      await page.clickOn('[data-outbox-list] [data-summary-act]', 'Send to Dana Lee')
      let words: string[] = []
      await page.until('the same Outbox item’s queued wording and age', 8000, async () => {
        const detail = await page.eval<string>(`document.querySelector('[data-outbox-detail]')?.innerText ?? ''`)
        words = await page.eval<string[]>(`[...document.querySelectorAll('[data-outbox-list] button[aria-current="true"]')].map((row) => row.innerText)`)
        return detail.includes(SUBJECT) && detail.includes(EDIT) && queuedAge(detail) && words.some(queuedAge)
      })
      await page.shot(join(folder, 'queued.png'))
      writeFileSync(join(folder, 'queued.json'), JSON.stringify({ row, words, toasts: await page.toasts(true),
        note: 'Sent could not be reached. No sandbox delivery worker claims this queue.' }, null, 2))
    })
  ]
})
