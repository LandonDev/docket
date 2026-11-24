import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { openRow, unzip } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step } from './lib/record'
import { a1Point, cellValue, shownA1 } from './lib/sheet'
import { Window } from './lib/window'

const NAME = 'Practice totals.xlsx'
const VALUE = 'Practice tally'
const PICK_CELL = 'iframe[name="frameEditor"]'

export default journey({
  id: 'J22',
  title: 'Edit a workbook through the Full editor from the window’s computer',
  tier: 1,
  shapes: ['A'],
  steps: [
    step('Open a workbook with a pivot table on box', async (context) => {
      copyFileSync(join(context.pair.repo, 'src/main/server/work/sheets/fullEditor/fixtures/pivot-chart.xlsx'), fileAt(context, NAME))
      await showPlace(context)
      const { page } = context.pair
      await openRow(page, NAME)
      await page.until('the TempCode grid', 45_000, () => a1Point(page))
    }),
    step('Switch to Full editor, edit A1 and close its window', async ({ pair, folder }) => {
      const { page } = pair
      await page.press('tab', 'Full editor')
      const editor = await Window.attach(pair.win.debug!, pair.abort.signal, (url) => /^http:\/\/127\.0\.0\.1:\d+\/w\/full\/[a-f\d]{64}\/$/.test(url))
      try {
        let point: { x: number; y: number } | null = null
        await editor.until('the Full editor cell-name field', 95_000, async () => (point = await editor.eval(`(() => {
          const frame = document.querySelector(${JSON.stringify(PICK_CELL)});
          const field = frame?.contentDocument?.querySelector('#ce-cell-name');
          const inside = field?.getBoundingClientRect();
          if (!inside?.width) return null;
          const outside = frame.getBoundingClientRect();
          return { x: outside.x + inside.x + inside.width / 2, y: outside.y + inside.y + inside.height / 2 };
        })()`)))
        await editor.click(point!)
        await editor.key('Control+a')
        await editor.typeKeys('A1')
        await editor.key('Enter')
        await editor.typeKeys(VALUE)
        await editor.key('Enter')
        await editor.shot(join(folder, 'full-editor.png'))
      } finally {
        try {
          await editor.closePage()
        } finally {
          editor.close()
        }
      }
    }),
    step('end: the TempCode grid and the workbook both hold the Full editor edit', async (context) => {
      const { page } = context.pair
      const file = fileAt(context, NAME)
      await page.press('tab', 'TempCode')
      await page.until('A1 on disk and back in the TempCode grid', 90_000, async () =>
        cellValue(unzip(file, 'xl/worksheets/sheet1.xml'), unzip(file, 'xl/sharedStrings.xml'), 'A1') === VALUE &&
          await shownA1(page) === VALUE)
    })
  ]
})
