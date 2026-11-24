import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeTab, dummyPdf, openRow } from './lib/files'
import { PDF_FIRST, selectPdfLine } from './lib/pdf'
import { fileAt, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'Practice plan.pdf'
const NOTE = 'Check the practice time'
const MARK = `${PDF_FIRST} [data-pdf-mark][aria-label="Highlight: Practice plan - page 1"]`

export default journey({
  id: 'J08',
  title: 'Highlight a PDF, add a note and reopen it',
  tier: 1,
  shapes: ['A', 'B2'],
  steps: [
    step('Open the PDF and highlight the text on page 1', async (context) => {
      writeFileSync(fileAt(context, NAME), dummyPdf())
      await showPlace(context)
      const { page } = context.pair
      await openRow(page, NAME)
      await selectPdfLine(page)
      await page.press('button', 'Highlight')
      await page.until('the highlight on page 1', 15_000, () => page.centre(MARK))
    }),
    step('Look for Add note on the highlight', async ({ pair, folder }) => {
      const { page } = pair
      await page.clickOn(MARK)
      await page.until('the highlight’s tools', 5000, () => page.centre('button', 'Remove highlight'))
      await page.shot(join(folder, 'highlight-tools.png'))
      if (!await page.centre('button', 'Add note')) {
        writeFileSync(join(folder, 'note-unavailable.txt'), 'The highlight offers Remove highlight. It offers no Add note control.\n')
        return
      }
      await page.press('button', 'Add note')
      await page.clickOn('textarea, [role="textbox"]', 'Note')
      await page.typeKeys(NOTE)
      await page.press('button', 'Save note')
    }),
    step('end: the reopened PDF still shows the highlight and its note', async ({ pair, folder }) => {
      const { page } = pair
      await closeTab(page, NAME)
      await page.until('the PDF tab to close', 10_000, () => page.tabClosed(NAME))
      await openRow(page, NAME)
      await page.until('the reopened PDF to draw', 30_000, () => page.eval(`!!document.querySelector('${PDF_FIRST} canvas')?.width`))
      const failures: string[] = []
      try {
        await page.until('the reopened highlight', 4000, () => page.centre(MARK))
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('Timed out')) throw error
        failures.push('The highlight is gone after reopening')
      }
      const missing = join(folder, 'note-unavailable.txt')
      if (existsSync(missing)) failures.push(readFileSync(missing, 'utf8').trim())
      else if (await page.centre(MARK)) {
        await page.clickOn(MARK)
        if (!await page.centre('p, span, textarea', NOTE)) failures.push('The note is gone after reopening')
      }
      if (failures.length) throw new Error(failures.join(' '))
    })
  ]
})
