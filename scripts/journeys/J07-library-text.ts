import { readFileSync, writeFileSync } from 'node:fs'
import { replaceText } from './lib/edit'
import { closeTab, openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'Practice notes.txt'
const WORDS = 'Meet at the side door'

export default journey({
  id: 'J07',
  title: 'Edit a text file from a library and close it',
  tier: 1,
  shapes: ['B1', 'B2'],
  steps: [
    step('Open the library text file', async (context) => {
      writeFileSync(fileAt(context, NAME), 'Practice on Tuesday')
      await showPlace(context)
      await openRow(context.pair.page, NAME)
    }),
    step('Replace its words and close by the tab ×', async ({ pair }) => {
      await replaceText(pair.page, WORDS)
      await closeTab(pair.page, NAME)
    }),
    step('end: the holder’s text file has the new words', async (context) => {
      const { page } = context.pair
      await page.until('the text on the holder', 20_000, () => readFileSync(fileAt(context, NAME), 'utf8') === WORDS)
      await page.until('the text tab to close', 5000, () => page.tabClosed(NAME))
    })
  ]
})
