import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowMenu, tabMenu } from './lib/actions'
import { rowDrop } from './lib/drop'
import { replaceText } from './lib/edit'
import { openRow, rowAt } from './lib/files'
import { fileAt, holderFolder, selectFolderTab, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'

const NAME = 'Practice handout.txt'
const DRAG = 'First folder'
const MENU = 'Second folder'
const COPY = 'Across computers'
const FIRST = 'Take the path to the field'
const LAST = 'Take the path to the gym'
const DIALOG = '[data-files-move]'

function otherFolder(context: Context) {
  const parent = context.shape === 'A' ? join(context.pair.l1, context.workspace.name) : context.workspace.path
  return join(parent, COPY)
}

async function moved(context: Context, from: string, to: string, words: string) {
  await context.pair.page.until('the move on the holder', 16_000, () => !existsSync(from) && existsSync(to) && readFileSync(to, 'utf8') === words)
}

export default journey({
  id: 'J14',
  title: 'Move an open file by drag and menu, then copy across computers',
  tier: 1,
  shapes: ['A', 'B1'],
  steps: [
    step('Open the file and drag its row into the first folder', async (context) => {
      const { page } = context.pair
      writeFileSync(fileAt(context, NAME), FIRST)
      for (const folder of [DRAG, MENU]) mkdirSync(join(holderFolder(context), folder))
      mkdirSync(otherFolder(context), { recursive: true })
      await showPlace(context)
      await openRow(page, NAME)
      await selectFolderTab(context)
      await page.until('the drag rows', 12_000, async () => await rowAt(page, NAME) && await rowAt(page, DRAG))
      await rowDrop(page, (await rowAt(page, NAME))!, (await rowAt(page, DRAG))!)
      await moved(context, fileAt(context, NAME), join(holderFolder(context), DRAG, NAME), FIRST)
    }),
    step('Use the moved row’s Move to menu and go to the second folder', async (context) => {
      const { page } = context.pair
      await selectFolderTab(context)
      await openRow(page, DRAG)
      await rowMenu(page, NAME)
      await page.press('menuitem', 'Move to…')
      await page.clickOn(`${DIALOG} nav button`, context.workspace.name)
      await page.clickOn(`${DIALOG} [role="option"]`, MENU)
      await page.clickOn(`${DIALOG} button`, 'Move Here')
      await moved(context, join(holderFolder(context), DRAG, NAME), join(holderFolder(context), MENU, NAME), FIRST)
    }),
    step('Edit through the tab opened before either move', async (context) => {
      const { page } = context.pair
      await page.press('tab', NAME)
      await replaceText(page, LAST)
      const file = join(holderFolder(context), MENU, NAME)
      await page.until('the edit in the second folder', 16_000, () => readFileSync(file, 'utf8') === LAST)
    }),
    step('end: Copy to the other computer works if offered and preserves the moved file', async (context) => {
      const { page } = context.pair
      await tabMenu(page, NAME)
      const control = await page.centre('[role="menuitem"]', 'Copy to…')
      const copy = join(otherFolder(context), NAME)
      let outcome = 'Copy to… unavailable'
      if (control) {
        await page.click(control)
        await page.clickOn(`${DIALOG} button`, 'Places')
        const select = `${DIALOG} [role="option"]`
        const place = context.shape === 'A' ? 'Journey Teams L1, General' : context.workspace.name
        await page.clickOn(select, place)
        if (context.shape === 'A') await page.clickOn(select, context.workspace.name)
        await page.clickOn(select, COPY)
        const send = await page.centre(`${DIALOG} button`, 'Copy Here')
        outcome = send ? 'Copy Here was offered' : 'Copy Here unavailable: ' + await page.eval(`document.querySelector('${DIALOG}')?.innerText`)
        writeFileSync(join(context.folder, 'copy.txt'), outcome + '\n')
        if (send) {
          await page.click(send)
          await page.until('the edited copy on the other computer', 20_000, async () => {
            const share = await page.centre('[role="alertdialog"] button', 'Copy')
            if (share) await page.click(share)
            return existsSync(copy) && readFileSync(copy, 'utf8') === LAST
          })
          outcome = 'Copied to the other computer'
        }
      }
      writeFileSync(join(context.folder, 'copy.txt'), outcome + '\n')
      const source = join(holderFolder(context), MENU, NAME)
      if (readFileSync(source, 'utf8') !== LAST || existsSync(fileAt(context, NAME)) || existsSync(join(holderFolder(context), DRAG, NAME))) {
        throw new Error('The open tab did not keep editing only the moved file')
      }
    })
  ]
})
