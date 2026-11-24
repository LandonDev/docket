import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renameField, tabMenu } from './lib/actions'
import { replaceText } from './lib/edit'
import { closeTab, openRow } from './lib/files'
import { fileAt, holderFolder, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'Practice list.txt'
const STEM = 'Revised practice list'
const RENAMED = STEM + '.txt'
const FIRST = 'Bring shoes'
const SECOND = 'Bring shoes and water'

export default journey({
  id: 'J13',
  title: 'Rename an open file and keep editing',
  tier: 1,
  shapes: ['A', 'B2'],
  steps: [
    step('Open the file and edit it', async (context) => {
      writeFileSync(fileAt(context, NAME), 'Practice on Tuesday')
      await showPlace(context)
      const { page } = context.pair
      await openRow(page, NAME)
      await replaceText(page, FIRST)
      await page.until('the first edit on the holder', 20_000, () => readFileSync(fileAt(context, NAME), 'utf8') === FIRST)
    }),
    // B2 as A: a library on a third computer reached through the box is renamed there, through the box, and the open
    // tab's copy follows it (files/across.ts `changeElsewhere`, acts.ts `copiesFollow`).
    step('Rename it from the open tab’s More menu', async (context) => {
      const { page } = context.pair
      await tabMenu(page, NAME)
      if (!await page.centre('[role="menuitem"]', 'Rename')) throw new Error('The open file’s menu does not allow Rename')
      await page.press('menuitem', 'Rename')
      await renameField(page, NAME, STEM)
      await page.until('the renamed file on the holder', 15_000, () => existsSync(fileAt(context, RENAMED)))
      await page.until('the same tab under the new name', 10_000, () => page.centre('button', 'More for ' + RENAMED))
    }, ['A', 'B2']),
    step('Keep editing in the open tab, then close it', async ({ pair }) => {
      await replaceText(pair.page, SECOND)
      await closeTab(pair.page, RENAMED)
    }, ['A', 'B2']),
    step('end: the renamed file is the only file and holds the last edit', async (context) => {
      const { page } = context.pair
      const file = fileAt(context, RENAMED)
      try {
        await page.until('the last edit in the renamed file and the tab to close', 15_000, async () =>
          existsSync(file) && readFileSync(file, 'utf8') === SECOND && await page.tabClosed(RENAMED))
      } finally {
        const files = readdirSync(holderFolder(context))
        const kept = Object.fromEntries(files.map((name) => [name, readFileSync(join(holderFolder(context), name), 'utf8')]))
        writeFileSync(join(context.folder, 'holder-files.json'), JSON.stringify(kept, null, 2))
      }
      const files = readdirSync(holderFolder(context))
      if (files.length !== 1 || files[0] !== RENAMED) throw new Error(`The holder’s folder contains ${files.join(', ')}`)
    }, ['A', 'B2'])
  ]
})
