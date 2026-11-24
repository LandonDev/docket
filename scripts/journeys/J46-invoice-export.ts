import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { unzip } from './lib/files'
import { fileAt } from './lib/place'
import { pdfFacts } from './lib/preview'
import { journey, step } from './lib/record'
import { enterField } from './lib/settings'
import { field, json, shown } from './lib/tierThree'

const CLIENT = 'Practice Hall'
const LINE = 'Room hire'
const YEAR = new Date().getFullYear()

export default journey({
  id: 'J46',
  title: 'Create and print an invoice and export the year',
  tier: 3,
  shapes: ['A'],
  steps: [
    step('Fill in an invoice addressed to a dummy client', async (context) => {
      const { pair, workspace } = context
      const { page } = pair
      await pair.showWork(workspace, 'Money')
      await page.press('button', 'Add')
      await page.press('menuitem', 'Invoice…')
      await page.until('the invoice fields', 18_000, () => page.centre('[role="dialog"] input[aria-label="What, line 1"]'))
      await field(page, 'To', CLIENT)
      await field(page, 'Business name', 'Practice Workshop')
      await enterField(page, '[aria-label="What, line 1"]', LINE)
      await enterField(page, '[aria-label="Rate, line 1"]', '21.50')
      await page.until('the invoice total on screen', 12_000, () => shown(page, '[role="dialog"]', '$21.50'))
      if (existsSync(fileAt(context, 'Money/Invoices'))) throw new Error('The invoice folder exists before Create')
    }),
    step('Create the invoice and read the PDF that Work prints', async (context) => {
      const { page } = context.pair
      const directory = fileAt(context, 'Money/Invoices')
      await page.clickOn('[role="dialog"] button', 'Create')
      const pdfs = () => existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.pdf')) : []
      await page.until('the created invoice PDF and its Money entry', 90_000, async () =>
        pdfs().length === 1 && await shown(page, '[data-money-row]', CLIENT))
      const path = join(directory, pdfs()[0]!)
      const facts = await pdfFacts(readFileSync(path))
      json(context, 'invoice', { path, ...facts })
      if (facts.pages.length !== 1 || !unzip(fileAt(context, 'Money/Ledger.tcsheet'), 'ops.json').includes(CLIENT)) {
        throw new Error('The invoice must print one page and reach the job’s ledger')
      }
    }),
    step('end: Export shows success and writes this year’s CSV, Excel and PDF', async (context) => {
      const { page } = context.pair
      await page.press('button', 'More')
      await page.press('menuitem', 'Export…')
      await page.clickOn('[role="dialog"] [role="combobox"]', 'Year')
      await page.clickOn('[role="option"]', String(YEAR))
      await page.clickOn('[role="dialog"] button', 'Export')
      const tax = fileAt(context, 'Money/Tax ' + YEAR)
      const csv = join(tax, 'Ledger ' + YEAR + '.csv')
      const xlsx = join(tax, 'Ledger ' + YEAR + '.xlsx')
      const pdf = join(tax, 'Summary ' + YEAR + '.pdf')
      await page.until('the export toast and all three year files', 120_000, async () =>
        existsSync(csv) && existsSync(xlsx) && existsSync(pdf) &&
        (await page.toasts()).some(text => text.includes('Exported ' + YEAR + ' for tax time')))
      const rows = readFileSync(csv, 'utf8')
      const facts = await pdfFacts(readFileSync(pdf))
      json(context, 'year', { files: readdirSync(tax), rows, ...facts })
      if (!rows.includes(CLIENT) || !rows.includes('Invoice 1001') || !rows.includes('21.50') || !facts.pages.length ||
        !unzip(xlsx, 'xl/worksheets/sheet1.xml')) throw new Error('The year export lacks its invoice or an Excel or PDF page')
    })
  ]
})
