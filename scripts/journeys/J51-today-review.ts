import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { MoneyActed, MoneyOwed } from '../../src/shared/contract-work-money'
import type { ReviewReady } from '../../src/shared/contract-work-review'
import type { RoutineRow, RoutineRun } from '../../src/shared/contract-work-routines'
import { today as ledgerDay } from '../../src/shared/work/money'
import { composeRow } from './lib/mailJourney'
import { addon, evidence, PAGE, see } from './lib/lifeosJourney'
import { SECTOR, seedDay, ZONE } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'
import { createThread } from './lib/thread'

const HELD = 'Spring LAN volunteer times'
const TASK = 'Print the room map'
const EVENT = 'Spring LAN equipment check'
const WAIT = 'Spring LAN unanswered room request'
const CHAT = 'Spring LAN volunteers'
const CHAT_TEXT = 'Can you confirm the volunteer desk?'
type Row = { _id: string; title: string; status?: string }
const slippedTask = new WeakMap<Context, string>()

export function todayOpen(key: string): string {
  return `[data-today-row=${JSON.stringify(key)}] [data-row-open]`
}

async function today(context: Context): Promise<void> {
  const { page } = context.pair
  await page.dismissPopups()
  if (!await page.centre('[data-work-place="today"]')) await page.clickOn('nav button', 'Today')
  await see(page, '[data-work-place="today"]', 'Today')
}

async function correctWorkspace(context: Context): Promise<void> {
  await context.pair.page.until('the correct workspace selected', 8000, () =>
    context.pair.page.centre('nav [data-rail-path] button[aria-current="true"]', context.workspace.name))
}

export default journey({
  id: 'J51', title: 'Open the Today rows in their job and settle a slipped task in Review', tier: 2, shapes: ['S'],
  steps: [
    step('Open the held draft in Today’s review sheet', async (context) => {
      const { pair, workspace } = context
      const accounts = await pair.sandbox!.query<{ _id: string; address: string }[]>('mail:accounts')
      const account = accounts.find(({ address }) => address === 'spring-lan@example.org')
      if (!account) throw new Error('The sandbox has no Spring LAN mailbox')
      const session = await createThread(pair, workspace.id, 'Spring LAN volunteer draft')
      const { id } = await addon<{ id: string }>(context, session.id, 'draft_mail', {
        account_id: account._id, to: [{ name: 'Dana Lee', address: 'dana@example.com' }],
        subject: HELD, body: 'Please check these volunteer times.', reason: 'Ready for the owner to check'
      })
      await today(context)
      await pair.page.clickOn(todayOpen(`held:${pair.box.host}:lifeos:${id}`))
      await see(pair.page, '[data-today-held]', HELD)
      const held = await composeRow(context, id)
      if (held.status !== 'draft') throw new Error('Opening Today’s sheet changed the held row')
      evidence(context, 'held', held)
      await pair.page.key('Escape')
    }),
    step('Open a meeting and a due task from their own Today rows', async (context) => {
      const { pair } = context
      const now = new Date()
      const events = await pair.sandbox!.query<Row[]>('events:range', { sector: SECTOR, from: seedDay(now, 0, 0), to: seedDay(now, 1, 0) })
      const event = events.find(({ title }) => title === EVENT)
      if (!event) throw new Error('The Today event is absent from LifeOS')
      await today(context)
      await pair.page.clickOn(todayOpen('event:' + event._id))
      await correctWorkspace(context)
      await see(pair.page, '[role="region"][aria-label="Agenda"]', EVENT)
      const tasks = await pair.sandbox!.query<Row[]>('tasks:list', { sector: SECTOR })
      const task = tasks.find(({ title }) => title === TASK)
      if (!task) throw new Error('The due task is absent from LifeOS')
      slippedTask.set(context, task._id)
      await today(context)
      await pair.page.clickOn(todayOpen('task:' + task._id))
      await correctWorkspace(context)
      await see(pair.page, '[role="dialog"]', TASK)
      evidence(context, 'event-and-task', { event, task })
      await pair.page.key('Escape')
    }),
    step('Open a waiting mail and an unanswered conversation in the right job', async (context) => {
      const { pair } = context
      const waits = await pair.sandbox!.query<{ page: { _id: string; subject: string }[] }>('mailWaits:list', { sector: SECTOR, paginationOpts: PAGE })
      const mail = waits.page.find(({ subject }) => subject === WAIT)
      if (!mail) throw new Error('The unanswered mail is absent from LifeOS')
      await today(context)
      await pair.page.clickOn(todayOpen('mail:' + mail._id))
      await correctWorkspace(context)
      await see(pair.page, '[data-mail-pane] h2', WAIT)
      const chats = await pair.sandbox!.query<{ page: { _id: string; name: string }[] }>('chats:list', { sector: SECTOR, paginationOpts: PAGE })
      const chat = chats.page.find(({ name }) => name === CHAT)
      if (!chat) throw new Error('The volunteer conversation is absent from LifeOS')
      await today(context)
      await pair.page.clickOn(`[data-today-row^=${JSON.stringify('chat:' + chat._id + ':')}] [data-row-open]`)
      await correctWorkspace(context)
      await see(pair.page, '[data-conversation]', CHAT_TEXT)
      evidence(context, 'mail-and-chat', { mail, chat })
    }),
    step('Follow an owed row to the job’s Money view and check its ledger', async (context) => {
      const { pair, workspace } = context
      const args = { workspaceId: workspace.id }
      const who = 'Spring LAN banner desk'
      const date = ledgerDay()
      const acted = await pair.rpc<MoneyActed>(pair.box, 'work.money.entry', {
        ...args, fields: { date, who, what: 'Banner deposit', way: 'in', amount: 2400, status: 'Unpaid' }
      })
      if (!('ok' in acted) || acted.suggested) throw new Error('The fixture was not entered in the ledger')
      const { rows } = await pair.rpc<MoneyOwed>(pair.box, 'work.money.owed', args)
      const row = rows.find((row) => row.row === acted.row && row.who === who && row.amount === 2400 && row.way === 'toHim')
      const path = join(workspace.path, 'Money', 'Ledger.tcsheet')
      if (!row || statSync(path).size === 0) throw new Error('No matching open debt in the workspace ledger')
      await today(context)
      await pair.page.clickOn(todayOpen(`money:${pair.box.host}:${workspace.id}:${row.row}:${row.way}`))
      await correctWorkspace(context)
      await see(pair.page, '[data-money-row=' + JSON.stringify(String(row.row)) + ']', who)
      evidence(context, 'owed', { row, bytes: statSync(path).size })
    }),
    step('Open the review’s ready row and check the host marks the week seen', async (context) => {
      const { pair, workspace } = context
      // A prior walk may have deleted the job that held the host's first weekly routine.
      const routine = await pair.rpc<RoutineRow>(pair.box, 'work.routines.save', {
        workspaceId: workspace.id, name: 'Spring LAN weekly review', prompt: '', job: 'review.make',
        trigger: { on: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0', tz: ZONE },
        ends: { kind: 'never' }
      })
      const started = await pair.rpc<RoutineRun>(pair.box, 'work.routines.runNow', { id: routine.id }, 30_000)
      let ready: ReviewReady = null
      await pair.page.until('the host’s made week to be ready', 15_000, async () =>
        (ready = await pair.rpc<ReviewReady>(pair.box, 'work.review.ready')))
      let run: RoutineRun | undefined
      await pair.page.until('the routine to record the same ready week', 10_000, async () => {
        const { runs } = await pair.rpc<{ runs: RoutineRun[] }>(pair.box, 'work.routines.runs', { id: routine.id })
        run = runs.find(({ id }) => id === started.id)
        return run?.open?.place === 'review' && run.open.at === ready!.from
      })
      await today(context)
      await pair.page.clickOn(todayOpen('review:' + ready!.from))
      await see(pair.page, '[data-review-page]', TASK)
      await pair.page.until('the same review marked seen', 8000, async () => (await pair.rpc<ReviewReady>(pair.box, 'work.review.ready')) === null)
      evidence(context, 'review-ready', { ready, run })
    }),
    step('end: Review settles the slipped task and the same LifeOS row reads done', async (context) => {
      const { pair } = context
      const { page } = pair
      const task = slippedTask.get(context)!
      await see(page, '[data-review-page]', TASK)
      const open = await page.centre(`[data-review-row] button[aria-label=${JSON.stringify('Open ' + TASK)}]`)
      if (!open) throw new Error('Review did not list the slipped task')
      await page.hover(open)
      await page.clickOn('[data-review-row] button', 'Done: ' + TASK)
      let read: { task: Row } | undefined
      await page.until('the LifeOS task settled and the slipped row gone', 10_000, async () => {
        read = await pair.sandbox!.query('tasks:get', { id: task })
        return read?.task.status === 'done' && !await page.centre('[data-review-row] button', 'Open ' + TASK)
      })
      evidence(context, 'review-settled', { task: read?.task, toasts: await page.toasts() })
    })
  ]
})
