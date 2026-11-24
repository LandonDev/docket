import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SECTOR } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'

const title = ({ workspace }: Context) => `Check the Spring LAN doors ${workspace.name}`
const dateInput = '[role="dialog"] input[type="date"]'

type TaskRow = { _id: string; title: string; sector: string; status: string; dueAt?: number }

export function taskMatches(row: TaskRow | undefined, status: string, dueAt: number, id?: string): boolean {
  return row?.status === status && row.dueAt === dueAt && row.sector === SECTOR && (id === undefined || row._id === id)
}

async function readTask(context: Context, phase: string, status: string): Promise<TaskRow> {
  const { pair, folder } = context
  const dueAt = await pair.page.eval<number>('new Date(new Date().setHours(9, 0, 0, 0)).getTime()')
  const file = join(folder, 'task-rows.jsonl')
  const created = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!) as TaskRow : undefined
  let row: TaskRow | undefined
  await pair.page.until(`the sandbox task row ${status}, due today at 9`, 5000, async () => {
    const rows = await pair.sandbox!.query<TaskRow[]>('tasks:list', { sector: SECTOR, statuses: ['todo', 'done'] })
    row = rows.find((r) => r.title === title(context))
    return taskMatches(row, status, dueAt, created?._id)
  })
  appendFileSync(file, JSON.stringify({ phase, ...row }) + '\n')
  return row!
}

async function seeToday(context: Context, present: boolean): Promise<void> {
  const { page } = context.pair
  if (!await page.centre('[data-work-place="today"]')) await page.clickOn('nav button', 'Today')
  await page.until(`the task ${present ? 'on' : 'off'} Today`, 8000, () => page.eval(`(() => {
    const today = document.querySelector('[data-today]');
    return !!today && [...today.querySelectorAll('[data-today-row]')].some(
      (row) => row.innerText.includes(${JSON.stringify(title(context))})
    ) === ${present};
  })()`))
}

export default journey({
  id: 'J40',
  title: 'Give a new task a day, finish it, and undo on Today',
  tier: 2,
  shapes: ['S'],
  steps: [
    step('Add a task due today and check the open LifeOS row', async (context) => {
      const { pair, workspace } = context
      const { page } = pair
      await pair.showWork(workspace, 'Tasks')
      await page.press('button', 'New task')
      await page.clickOn('[role="dialog"] input[placeholder="Book the ballroom"]')
      await page.typeKeys(title(context))
      const [year, month, day] = await page.eval<string[]>(`new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date()).split('-')`)
      await page.clickOn('[role="dialog"] input[placeholder="Book the ballroom"]')
      await page.key('Tab')
      for (const digits of [month!, day!, year!]) await page.typeKeys(digits)
      await page.until('the date field holding today', 2000, () =>
        page.eval(`document.querySelector(${JSON.stringify(dateInput)})?.value === ${JSON.stringify([year, month, day].join('-'))}`))
      await page.clickOn('[role="dialog"] button', 'Add')
      await readTask(context, 'add', 'todo')
      await seeToday(context, true)
    }),
    step('Finish it on Today and check the completed LifeOS row', async (context) => {
      const { pair } = context
      const row = await readTask(context, 'before done', 'todo')
      const target = await pair.page.eval<string>(`[...document.querySelectorAll('[data-today-row]')]
        .find((node) => node.innerText.includes(${JSON.stringify(row.title)}))?.dataset.todayRow`)
      if (!target) throw new Error('Today has no row for the open task')
      await pair.page.watchToasts()
      await pair.page.clickOn(`[data-today-row=${JSON.stringify(target)}] [role="checkbox"], [data-today-row=${JSON.stringify(target)}] button[aria-label^="Mark"]`)
      await readTask(context, 'done', 'done')
      await seeToday(context, false)
    }),
    step('end: Undo reopens the same LifeOS task and shows it again on Today', async (context) => {
      await context.pair.page.clickOn('[data-sonner-toast] button', 'Undo')
      await readTask(context, 'undo', 'todo')
      await seeToday(context, true)
    })
  ]
})
