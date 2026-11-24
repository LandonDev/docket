import { writeFileSync } from 'node:fs'
import { rowMenu } from './lib/actions'
import { closeTab, openRow, rowAt } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'Practice checklist.txt'

export default journey({
  id: 'J19',
  title: 'Find a starred and recently opened file after reloading',
  tier: 1,
  shapes: ['A', 'B2'],
  steps: [
    step('Star the file, open it and close its tab', async (context) => {
      writeFileSync(fileAt(context, NAME), 'Bring a water bottle')
      await showPlace(context)
      const { page } = context.pair
      await rowMenu(page, NAME)
      await page.press('menuitem', 'Star')
      await openRow(page, NAME)
      await page.until('the file tab to open', 10_000, async () => !await page.tabClosed(NAME))
      await closeTab(page, NAME)
      await page.until('the file tab to close', 5000, () => page.tabClosed(NAME))
    }),
    step('Reload the window', ({ pair }) => pair.page.reload()),
    step('end: Starred and Recent both show the file after reload', async ({ pair }) => {
      const { page } = pair
      for (const lens of ['Starred', 'Recent']) {
        await page.clickOn('[data-files-sidebar] button', lens)
        await page.until(NAME + ' under ' + lens, 15_000, () => rowAt(page, NAME))
      }
    })
  ]
})
