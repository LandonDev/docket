import { unzip, closeTab, openRow } from './lib/files'
import { SLIDE_TEXT, waitForFocus } from './lib/edit'
import { fileAt, showPlace } from './lib/place'
import type { Window } from './lib/window'
import { journey, step } from './lib/record'

const STEM = 'Practice deck'
const NAME = STEM + '.pptx'
const WORDS = 'Practice sched'

async function insert(page: Window, what: string): Promise<void> {
  const bar = '[data-format-row] button'
  await page.until('the deck toolbar', 30_000, async () =>
    await page.centre(bar, 'Insert') || await page.centre(bar, 'More formatting'))
  const direct = await page.centre(bar, 'Insert')
  if (direct) await page.click(direct)
  else {
    await page.clickOn(bar, 'More formatting')
    await page.press('menuitem', 'Insert')
  }
  await page.press('menuitem', what)
}

export default journey({
  id: 'J06',
  title: 'Make a deck, add a slide and close while typing',
  tier: 1,
  shapes: ['A', 'B2'],
  steps: [
    step('Make a deck from New and open it', async (context) => {
      fileAt(context, NAME)
      await showPlace(context)
      const { page } = context.pair
      await page.until('the destination folder’s listing', 15_000, () => page.eval(`(() => {
        const folder = document.querySelector('[data-files-page]');
        return folder?.querySelector('[aria-current="page"]')?.textContent.trim() === ${JSON.stringify(context.workspace.name)} &&
          !folder.querySelector('[aria-busy="true"]');
      })()`))
      if (!await page.centre('[data-files-new]')) throw new Error('The library folder offers no New control')
      await page.clickOn('[data-files-new]')
      await page.press('menuitem', 'Deck')
      await page.until('the new deck name field', 20_000, () => page.eval('document.activeElement?.matches("[data-files-row] input")'))
      await page.typeKeys(STEM)
      await page.key('Enter')
      await openRow(page, NAME)
    }),
    step('Add a slide, insert a text box and close mid-word', async ({ pair }) => {
      const { page } = pair
      await insert(page, 'New slide')
      await page.until('slide 2 selected', 20_000, () => page.eval(`!!document.querySelector('[aria-label^="Slide 2:"][aria-selected="true"]')`))
      await insert(page, 'Text box')
      await waitForFocus(page, SLIDE_TEXT)
      await page.key('Control+a')
      await page.typeKeys(WORDS)
      await closeTab(page, NAME)
    }),
    step('end: the holder’s added slide contains the unfinished words', async (context) => {
      const { page } = context.pair
      await page.until('the words in slide 2 on the holder', 20_000, () => {
        const xml = unzip(fileAt(context, NAME), 'ppt/slides/slide2.xml')
        return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((part) => part[1]).join('').includes(WORDS)
      })
      await page.until('the deck tab to close', 5000, () => page.tabClosed(NAME))
    })
  ]
})
