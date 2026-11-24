import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renameField, tabMenu } from './lib/actions'
import { replaceText } from './lib/edit'
import { menuItems, notOffered, sameHolder, holderState } from './lib/far'
import { closeTab, openRow } from './lib/files'
import { fileAt, holderFolder, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'Practice list.txt'
const STEM = 'Revised practice list'
const RENAMED = STEM + '.txt'
const FIRST = 'Bring shoes'
const SECOND = 'Bring shoes and water'
const held = new WeakMap<object, Record<string, string>>()

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
      held.set(context, holderState(context))
    }),
    // B2: Rename is not offered in a library on a third computer reached through the box. That is honest as it stands;
    // offering it is the owner's ruling. The walk asserts Rename takes no press (the menu greys it out) and the holder keeps the file as it was.
    step('The open tab’s More menu offers no Rename in the far library', async (context) => {
      const { page } = context.pair
      await tabMenu(page, NAME)
      notOffered(await menuItems(page, { context, name: 'tab-menu' }), 'Rename', 'The open file’s menu')
    }, ['B2']),
    step('end: the far library keeps the file under its name with the edit', async (context) => {
      await closeTab(context.pair.page, NAME)
      sameHolder(context, held.get(context)!, 'end')
      if (readFileSync(fileAt(context, NAME), 'utf8') !== FIRST) throw new Error('The holder’s file lost the edit')
    }, ['B2']),
    step('Rename it from the open tab’s More menu', async (context) => {
      const { page } = context.pair
      await tabMenu(page, NAME)
      if (!await page.centre('[role="menuitem"]', 'Rename')) throw new Error('The open file’s menu does not allow Rename')
      await page.press('menuitem', 'Rename')
      await renameField(page, NAME, STEM)
      await page.until('the renamed file on the holder', 15_000, () => existsSync(fileAt(context, RENAMED)))
      await page.until('the same tab under the new name', 10_000, () => page.centre('button', 'More for ' + RENAMED))
    }, ['A']),
    step('Keep editing in the open tab, then close it', async ({ pair }) => {
      await replaceText(pair.page, SECOND)
      await closeTab(pair.page, RENAMED)
    }, ['A']),
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
    }, ['A'])
  ]
})
