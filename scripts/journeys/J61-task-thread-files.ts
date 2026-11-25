import { hostRows } from './lib/thread'
import { evidence, newThread, see, sendPrompt } from './lib/lifeosJourney'
import { SECTOR } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'

/** A task of the seeded Spring LAN project (lib/lifeosSeed.ts). */
const PROJECT = 'Spring LAN'
const TASK = 'Count the spare cables'
type Filed = { project_id: string | null; lifeos_project_id: string | null; workspace_id: string | null }
const threads = new WeakMap<Context, string>()

export default journey({
  id: 'J61', title: 'Start thread on a project task files the thread under the project', tier: 2, shapes: ['S'],
  steps: [
    step('Start a thread from the task in Tasks and check its host row sits under the project mirror', async (context) => {
      const { pair, workspace } = context
      const { page } = pair
      const project = (await pair.sandbox!.query<{ _id: string; name: string }[]>('projects:list', { sector: SECTOR })).find((p) => p.name === PROJECT)
      if (!project) throw new Error('The sandbox has no Spring LAN project')
      await pair.showWork(workspace, 'Tasks')
      await see(page, '[role="region"][aria-label="Tasks"]', TASK)
      await page.clickOn('[aria-label=' + JSON.stringify('Open ' + TASK) + ']')
      await page.clickOn('[role="dialog"] button', 'Start thread')
      await see(page, '[data-composer]', TASK)
      const id = await newThread(context, () => sendPrompt(page, 'Count what we have left'))
      threads.set(context, id)
      const [row] = await hostRows<Filed>(pair, 'SELECT s.project_id, p.lifeos_project_id, p.workspace_id FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?', id)
      evidence(context, 'thread', { id, row, lifeosProjectId: project._id })
      if (row?.lifeos_project_id !== project._id || row.workspace_id !== workspace.id) throw new Error('The thread is not filed under the Spring LAN mirror: ' + JSON.stringify(row))
      await see(page, '[data-project-row]', PROJECT)
    }),
    step('end: the project page shows the thread on its task', async (context) => {
      const { pair, workspace } = context
      const { page } = pair
      // The column's project row opens the project's page (its Projects heading opens the list).
      await pair.showWork(workspace, 'Tasks')
      await page.clickOn('[data-project-row]', PROJECT)
      const mark = '[aria-label=' + JSON.stringify('Open the thread on ' + TASK) + ']'
      await page.until('the thread mark on the task', 12_000, () => page.eval(`!!document.querySelector(${JSON.stringify(mark)})`))
      evidence(context, 'page', { thread: threads.get(context), mark: true })
    })
  ]
})
