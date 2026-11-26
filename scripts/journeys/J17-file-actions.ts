import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowMenu, tabMenu } from './lib/actions'
import { closeTab, openRow, rowAt } from './lib/files'
import { fileAt, goPlace, holderFolder, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { words } from './lib/shape'

const NAME = 'Practice handout.txt'
const DATA = 'Equipment goes in the blue bin.\n'
const CONTROLS = ['Download', 'Show in Its Folder', 'Open in its app', 'Copy to…'] as const
const MENU = '[role="menuitem"]'
type Control = typeof CONTROLS[number]
type Surface = 'tab' | 'row'
type Outcome = { screen: Surface; control: Control; outcome: string; error?: string }

async function useControl(context: Context, screen: Surface, control: Control): Promise<string> {
  const { page } = context.pair
  if (!await page.tabClosed(NAME)) {
    if (!await page.centre('[data-files-tab][aria-selected="true"]', NAME)) await page.press('tab', NAME)
    await closeTab(page, NAME)
    await page.until('the file tab to close', 5000, () => page.tabClosed(NAME))
  }
  if (screen === 'row' && control === 'Show in Its Folder') {
    // The earlier tab actions opened this file, so its Recent row already exists.
    await page.clickOn('[data-files-sidebar] button', 'Recent')
  } else {
    await goPlace(context)
    if (screen === 'tab') {
      await openRow(page, NAME)
      await page.until('the file header to load', 15_000, () => page.saveLine())
    }
  }

  if (control === 'Show in Its Folder') {
    if (screen === 'tab') {
      const link = await page.centre('[data-files-save-line] button')
      if (!link) return 'not offered'
      await page.click(link)
    } else {
      // Show in Its Folder takes a row in a lens back to its own folder.
      await rowMenu(page, NAME)
      const item = await page.centre(MENU, control)
      if (!item) {
        await page.key('Escape')
        return 'not offered'
      }
      await page.click(item)
    }
    await page.until('the file in its folder', 12_000, async () =>
      await rowAt(page, NAME) && await page.eval(`!!document.querySelector('[data-files-bar] [aria-current]') &&
        document.querySelector('[data-files-bar] [aria-current]').textContent.trim() === ${JSON.stringify(context.workspace.name)}`))
    return 'showed the folder'
  }

  if (screen === 'tab') await tabMenu(page, NAME)
  else await rowMenu(page, NAME)
  const at = await page.centre(MENU, control)
  if (!at) {
    await page.key('Escape')
    return 'not offered'
  }
  if (control === 'Download') {
    await page.catchExports()
    await page.click(at)
    const data = await page.downloaded(NAME)
    writeFileSync(join(context.folder, screen + '-download.txt'), data)
    if (!data.equals(Buffer.from(DATA))) throw new Error('The downloaded bytes differ from the file')
    return 'downloaded the bytes under its own name'
  }
  if (control === 'Open in its app') {
    await page.watchToasts()
    page.appOpen.watch(fileAt(context, NAME))
    await page.click(at)
    await page.until('an answer from the file’s app', 7000, async () => {
      const toast = (await page.toasts(true)).find((line) => /did not open|opens in its app/i.test(line))
      const answer = page.appOpen.answer
      if (toast || answer?.opened === false) throw new Error(toast ?? answer?.error ?? 'The holder did not open the file')
      return answer?.opened === true
    })
    return 'opened in its app'
  }

  const target = screen === 'tab' ? 'Tab copies' : 'Row copies'
  await page.click(at)
  await page.clickOn('[data-files-move] [role="option"]', target)
  const dialog = await page.eval<string>(`document.querySelector('[data-files-move]')?.innerText ?? ''`)
  if (!await page.centre('[data-files-move] button', 'Copy Here')) throw new Error(dialog)
  await page.clickOn('[data-files-move] button', 'Copy Here')
  const copy = join(holderFolder(context), target, NAME)
  await page.until('the copy in ' + target, 15_000, () => existsSync(copy) && readFileSync(copy, 'utf8') === DATA)
  if (readFileSync(fileAt(context, NAME), 'utf8') !== DATA) throw new Error('Copy changed the original')
  return 'copied the bytes to ' + target
}

export default journey({
  id: 'J17',
  title: 'Use Download, Show in Its Folder, Open in its app and Copy to from Files',
  tier: 1,
  shapes: ['A', 'B1', 'B2'],
  steps: [
    step('Put a file and two destination folders in the place', async (context) => {
      writeFileSync(fileAt(context, NAME), DATA)
      for (const name of ['Row copies', 'Tab copies']) mkdirSync(join(holderFolder(context), name))
      await showPlace(context)
    }),
    ...(['tab', 'row'] as const).flatMap((screen) => CONTROLS.map((control, index) =>
      step(`Try ${control} from the ${screen}`, async (context) => {
        const { page } = context.pair
        const errors = context.pair.hostErrors.length
        let result: Outcome
        try {
          result = { screen, control, outcome: await useControl(context, screen, control) }
        } catch (error) {
          result = { screen, control, outcome: 'failed', error: words(error) }
          await page.shot(join(context.folder, `${screen}-${index + 1}.png`))
        }
        appendFileSync(join(context.folder, 'actions.jsonl'), JSON.stringify({
          ...result, toasts: await page.toasts(), saveLine: await page.saveLine(), hostErrors: context.pair.hostErrors.slice(errors)
        }) + '\n')
        if (result.error) {
          await page.dismissPopups()
        }
      }))),
    step('end: every offered action did what its control said', ({ folder }) => {
      const results = readFileSync(join(folder, 'actions.jsonl'), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as Outcome)
      const failures = results.filter(({ error }) => error)
      if (failures.length) throw new Error(failures.map(({ screen, control, error }) => `${screen} ${control}: ${error}`).join(' | '))
    })
  ]
})
