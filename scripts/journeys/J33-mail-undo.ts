import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIRST_MAIL } from './lib/lifeosSeed'
import { COMPOSE, composeRow, mailToast, readReply, startReply, undoMail, type MailRow } from './lib/mailJourney'
import { journey, step, type Context } from './lib/record'

const REPLY = 'I can open the east room at noon.'
const read = (context: Context, phase: string, status: string) => readReply(context, FIRST_MAIL, REPLY, phase, status)

async function send(context: Context, phase: string): Promise<MailRow> {
  const { page } = context.pair
  await page.watchToasts()
  await page.clickOn(`${COMPOSE} button`, 'Send')
  await mailToast(context, 'Sending to Dana Lee')
  return read(context, phase, 'queued')
}

export function earlySent(toast: string, status: string): boolean {
  return /^(Sent|Already sent)(?:\b|$)/.test(toast) && status !== 'sent'
}

export default journey({
  id: 'J33',
  title: 'Read, reply, Send, Undo, and Send again',
  tier: 2,
  shapes: ['S'],
  steps: [
    step('Read Dana’s mail and let the reply save as a draft', async (context) => {
      await startReply(context, FIRST_MAIL, REPLY)
      await read(context, 'draft', 'draft')
    }),
    step('Send and press Undo inside the countdown', async (context) => {
      const { sendAt } = await send(context, 'send')
      if (!sendAt || sendAt <= Date.now()) throw new Error('LifeOS queued the reply without an undo time')
      await undoMail(context, sendAt)
      await read(context, 'undo', 'draft')
    }),
    step('end: Send again, the same row is queued, and no toast claims it went', async (context) => {
      await send(context, 'send again')
      const { pair, folder } = context
      const rows = readFileSync(join(folder, 'mail-rows.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as MailRow)
      if (rows.length !== 4 || new Set(rows.map(({ _id }) => _id)).size !== 1) throw new Error('The four transitions used different LifeOS rows')
      const { _id, sendAt } = rows.at(-1)!
      if (!sendAt || sendAt <= Date.now()) throw new Error('The second send has no undo time')
      await pair.page.until('the second send countdown to end', Math.max(5000, sendAt - Date.now() + 5000), async () => {
        const toasts = await pair.page.toasts()
        const row = await composeRow(context, _id)
        if (toasts.some((toast) => earlySent(toast, row.status))) {
          appendFileSync(join(folder, 'mail-rows.jsonl'), JSON.stringify({ phase: 'false toast', toasts, ...row }) + '\n')
          throw new Error(`The window says ${toasts.join(', ')} while LifeOS still says ${row.status}`)
        }
        return Date.now() >= sendAt + 1500 && row.status === 'queued'
      })
    })
  ]
})
