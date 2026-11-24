import { writeFileSync } from 'node:fs'
import { rowMenu, tabMenu } from './lib/actions'
import { openRow } from './lib/files'
import { fileAt, selectFolderTab, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'

const FIRST = 'Practice plan.txt'
const SECOND = 'Practice list.txt'
const THIRD = 'Practice roster.txt'
const DRAFT = 'Keep this draft in place'
const INPUT = '[data-files-dock] [data-composer-input]'

async function openSide(context: Context, name: string) {
  const { page } = context.pair
  await selectFolderTab(context)
  await rowMenu(page, name)
  await page.press('menuitem', 'Open to the Side')
  await page.until(name + ' at the side', 16_000, () => page.centre(`[data-files-side][aria-label=${JSON.stringify(name)}]`))
}

export default journey({
  id: 'J11',
  title: 'Keep the draft beside the first file while opening and closing side files',
  tier: 1,
  // A only: a file on another computer is not put at a tab's side (docs/agents/work-files.md "Two files in one tab"),
  // so the B1 walk asked for what the product does not promise.
  shapes: ['A'],
  steps: [
    step('Open the first file and type a draft in Ask', async (context) => {
      for (const name of [FIRST, SECOND, THIRD]) writeFileSync(fileAt(context, name), name)
      await showPlace(context)
      const { page } = context.pair
      await openRow(page, FIRST)
      await page.clickOn('[data-files-header] button', 'Ask')
      await page.clickOn(INPUT)
      await page.typeKeys(DRAFT)
    }),
    step('Open the second file at the side and close it by ×', async (context) => {
      const { page } = context.pair
      await openSide(context, SECOND)
      await page.clickOn('[data-files-side-close]', 'Close ' + SECOND)
      await page.until('the chat to take the side back with its draft', 10_000, () => page.eval(`!document.querySelector('[data-files-side]') &&
        document.querySelector(${JSON.stringify(INPUT)})?.textContent.trim() === ${JSON.stringify(DRAFT)}`))
    }),
    step('Open the third file at the side and close it with the menu key', async (context) => {
      const { page } = context.pair
      await openSide(context, THIRD)
      await tabMenu(page, FIRST)
      const shortcut = await page.eval<string>(`[...document.querySelectorAll('[role="menuitem"]')].find((m) => m.innerText.startsWith('Close Tab'))?.textContent ?? ''`)
      if (!/(Ctrl\+W|⌘W)/i.test(shortcut)) throw new Error(`Close Tab shows no recognized shortcut: ${shortcut}`)
      await page.key('Escape')
      await page.clickOn('[data-files-side] .cm-content')
      await page.key(shortcut.includes('⌘') ? 'Meta+w' : 'Control+w')
    }),
    step('end: both extra files are closed, and the first file and its draft are visible', async ({ pair }) => {
      const { page } = pair
      await page.until('the first file beside its original draft', 12_000, () => page.eval(`(() => {
        const input = document.querySelector(${JSON.stringify(INPUT)});
        const file = document.querySelector('[data-files-file] .cm-content');
        return !document.querySelector('[data-files-side]') && file?.textContent === ${JSON.stringify(FIRST)} &&
          input?.textContent.trim() === ${JSON.stringify(DRAFT)} && !!input.closest('[data-files-dock-seat="beside"]');
      })()`))
    })
  ]
})
