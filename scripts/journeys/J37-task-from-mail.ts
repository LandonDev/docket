import { checkLink, evidence, mailMenuItem, MAIL_PANE, newThread, openMail, see, sendPrompt } from './lib/lifeosJourney'
import { SECTOR } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'

const SUBJECT = 'Spring LAN tables'
const TASK = SUBJECT
type Task = { _id: string; title: string; sector: string }
const tasks = new WeakMap<Context, Task>()

export default journey({
  id: 'J37', title: 'Make a task from mail and start a thread about the task', tier: 2, shapes: ['S'],
  steps: [
    step('Make the task from the reader and check the LifeOS mail link', async (context) => {
      const { pair } = context
      const mail = await openMail(context, SUBJECT)
      await pair.page.clickOn(MAIL_PANE + ' button', 'More')
      await pair.page.watchToasts()
      await mailMenuItem(pair.page, 'Make task')
      await pair.page.until('Task added toast', 5000, async () => (await pair.page.toasts(true)).some((line) => line.startsWith('Task added')))
      let task: Task | undefined
      await pair.page.until('the task from the mail in LifeOS', 10_000, async () =>
        (task = (await pair.sandbox!.query<Task[]>('tasks:list', { sector: SECTOR })).find((row) => row.title === TASK)))
      const got = await pair.sandbox!.query<{ mailThreadId: string }>('tasks:get', { id: task!._id })
      if (got.mailThreadId !== mail._id) throw new Error('The task does not point to its source mail')
      await pair.showWork(context.workspace, 'Tasks')
      await see(pair.page, '[role="region"][aria-label="Tasks"]', TASK)
      tasks.set(context, task!)
      evidence(context, 'task', { task, mail })
    }),
    step('end: the task opens its own thread and LifeOS links it', async (context) => {
      const { page } = context.pair
      await page.clickOn('[aria-label=' + JSON.stringify('Open ' + TASK) + ']')
      await page.clickOn('[role="dialog"] button', 'Start thread')
      await see(page, '[data-composer]', TASK)
      const id = await newThread(context, () => sendPrompt(page, 'Check the table count'))
      await see(page, '[data-sent-chips]', TASK)
      evidence(context, 'thread', await checkLink(context, 'tasks', tasks.get(context)!._id, id))
    })
  ]
})
