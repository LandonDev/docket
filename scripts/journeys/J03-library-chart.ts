import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openRow, unzip } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { pdfFacts, previewFormat } from './lib/preview'
import { journey, step } from './lib/record'
import { a1Point, cellValue } from './lib/sheet'

const NAME = 'Practice counts.xlsx'
const COUNTS = ['7', '4', '9']

export default journey({
  id: 'J03',
  title: 'Insert a chart in a library workbook and export its PDF',
  tier: 1,
  shapes: ['B1', 'B2'],
  steps: [
    step('Open a blank workbook seeded on the library holder', async (context) => {
      copyFileSync(join(context.pair.repo, 'resources/work-files/blank/blank.xlsx'), fileAt(context, NAME))
      await showPlace(context)
      await openRow(context.pair.page, NAME)
    }),
    step('Type three counts and select them', async (context) => {
      const { page } = context.pair
      await page.until('the workbook grid and its toolbar', 45_000, async () =>
        await a1Point(page) && await page.centre('[data-slot="format-row"]'))
      await page.click((await a1Point(page))!)
      for (const [i, value] of COUNTS.entries()) {
        await page.typeKeys(value)
        await page.key('Enter')
        await page.key('ArrowUp')
        if (i < COUNTS.length - 1) await page.key('ArrowRight')
      }
      await page.click((await a1Point(page))!)
      await page.key('Shift+ArrowRight')
      await page.key('Shift+ArrowRight')
      await page.until('the three counts on the holder', 20_000, () => {
        const file = fileAt(context, NAME)
        const sheet = unzip(file, 'xl/worksheets/sheet1.xml')
        const strings = unzip(file, 'xl/sharedStrings.xml')
        return COUNTS.every((value, i) => {
          const ref = 'ABC'[i] + '1'
          const tag = sheet.match(new RegExp('<c\\b[^>]*\\br="' + ref + '"[^>]*>'))?.[0]
          return tag && !/\bt="(?:s|str|inlineStr)"/.test(tag) && cellValue(sheet, strings, ref) === value
        })
      })
    }),
    step('Insert a chart from the selection', async ({ pair }) => {
      const { page } = pair
      const insert = await page.centre('[data-slot="format-row"] button', 'Insert')
      if (insert) await page.click(insert)
      else {
        await page.clickOn('[data-slot="format-row"] button', 'More formatting')
        await page.press('menuitem', 'Insert')
      }
      await page.press('menuitem', 'Chart')
    }),
    step('Open Preview and export PDF', async ({ pair, folder }) => {
      const { page } = pair
      if (!await page.eval<boolean>("window.api.debug.menuClick('export')")) throw new Error('The File menu did not open Preview')
      await previewFormat(page, 'pdf', 'PDF')
      await page.catchExports()
      await page.press('button', 'Export')
      writeFileSync(join(folder, 'export.pdf'), await page.exported('application/pdf'))
    }),
    step('end: the holder has a chart and the export is a PDF with several streams', async (context) => {
      const facts = await pdfFacts(readFileSync(join(context.folder, 'export.pdf')))
      const parts = Bun.spawnSync(['unzip', '-Z1', fileAt(context, NAME)]).stdout.toString().trim().split('\n')
      const charts = parts.filter((part) => /^xl\/charts\/[^/]+\.xml$/.test(part))
      writeFileSync(join(context.folder, 'export.json'), JSON.stringify({ ...facts, pages: facts.pages.length, charts }, null, 2))
      if (!charts.length || facts.streams < 2 || !facts.pages.length) throw new Error('The workbook has no chart part or the export has fewer than two PDF streams or no pages')
    })
  ]
})
