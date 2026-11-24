import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeTab, dummyPdf, openRow } from './lib/files'
import { PDF_FIRST, selectPdfLine } from './lib/pdf'
import { fileAt, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'Practice plan.pdf'
const MARK = `${PDF_FIRST} [data-pdf-mark][aria-label="Highlight: Practice plan - page 1"]`

export default journey({
  id: 'J08',
  title: 'Highlight a PDF and reopen it',
  tier: 1,
  shapes: ['A', 'B1', 'B2'],
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
    // A highlight has no note by design (docs/agents/work-pdf.md "Selection": a press on one offers Ask and Remove
    // highlight): its tools are kept as evidence, and the end checks the highlight alone.
    step('Look at the highlight’s tools', async ({ pair, folder }) => {
      const { page } = pair
      await page.clickOn(MARK)
      await page.until('the highlight’s tools', 5000, () => page.centre('button', 'Remove highlight'))
      await page.shot(join(folder, 'highlight-tools.png'))
      await page.key('Escape')
    }),
    step('end: the reopened PDF still shows the highlight', async ({ pair }) => {
      const { page } = pair
      await closeTab(page, NAME)
      await page.until('the PDF tab to close', 10_000, () => page.tabClosed(NAME))
      await openRow(page, NAME)
      await page.until('the reopened PDF to draw', 30_000, () => page.eval(`!!document.querySelector('${PDF_FIRST} canvas')?.width`))
      try {
        await page.until('the reopened highlight', 4000, () => page.centre(MARK))
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('Timed out')) throw error
        throw new Error('The highlight is gone after reopening')
      }
    })
  ]
})
