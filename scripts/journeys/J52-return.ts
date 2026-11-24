import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { hostRows } from './lib/thread'

const NAME = 'Practice return.txt'
const WORDS = 'The first draft stays here'
const DRAFT = 'Ask about the practice notes'
const INPUT = '[data-files-dock] [data-composer-input]'
const RAIL = 'nav [data-rail-path] button'

async function returned(context: Context, label: string) {
  const { pair, folder, workspace } = context
  const { page } = pair
  await page.until(label + ' restores Files, the selected tab and the dock draft', 25_000, () => page.eval(`(() => {
    const file = document.querySelector('[data-files-view] [data-files-tab][data-tab-kind="file"][aria-selected="true"]');
    const input = document.querySelector(${JSON.stringify(INPUT)});
    return file?.textContent.includes(${JSON.stringify(NAME)}) && input?.innerText.trim() === ${JSON.stringify(DRAFT)} &&
      document.querySelector('[data-files-file] .cm-content')?.textContent === ${JSON.stringify(WORDS)};
  })()`))
  const tabs = await hostRows<{ id: string; page: string }>(pair, 'SELECT id, page FROM work_files_tabs WHERE workspace_id = ? AND kind = ?', workspace.id, 'file')
  if (tabs.filter(({ page }) => page.includes(NAME)).length !== 1 || readFileSync(fileAt(context, NAME), 'utf8') !== WORDS) {
    throw new Error('The file tab or the original words are missing on box')
  }
  await page.shot(join(folder, label + '.png'))
}

export default journey({
  id: 'J52',
  title: 'Restore Files, its file tab and Ask draft across a switch, reload and relaunch',
  tier: 1,
  shapes: ['A'],
  steps: [
    step('Open a workspace text file and leave a draft in Ask', async (context) => {
      const { pair } = context
      writeFileSync(fileAt(context, NAME), WORDS)
      await showPlace(context)
      await openRow(pair.page, NAME)
      await pair.page.clickOn('[data-files-header] button', 'Ask')
      await pair.page.clickOn(INPUT)
      await pair.page.typeKeys(DRAFT)
      await returned(context, 'before')
    }),
    step('Switch workspaces and come back to the same Files view and draft', async (context) => {
      const { pair, workspace } = context
      const other = await pair.workspace(workspace.name + ' elsewhere')
      await pair.page.clickOn(RAIL, other.name)
      await pair.page.until('the other workspace to take the rail', 12_000, () => pair.page.centre(RAIL + '[aria-current="true"]', other.name))
      await pair.page.clickOn(RAIL, workspace.name)
      await returned(context, 'switch')
    }),
    step('Reload the window and check the same view, file and draft', async (context) => {
      await context.pair.page.reload()
      await returned(context, 'reload')
    }),
    step('end: a stopped and relaunched win restores the same view, file and draft', async (context) => {
      const { pair } = context
      pair.later(async () => { if (!pair.abort.signal.aborted) await pair.restart(pair.win) })
      await pair.halt(pair.win)
      await pair.restart(pair.win)
      await returned(context, 'relaunch')
    })
  ]
})
