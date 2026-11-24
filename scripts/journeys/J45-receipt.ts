import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktopDrop } from './lib/drop'
import { unzip } from './lib/files'
import { fileAt } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { hostRows } from './lib/thread'
import { field, json, shown } from './lib/tierThree'

const NAME = 'Practice receipt.png'
const REVIEW = 'Review Blue Heron Coffee'
const WHO = 'Practice Cafe'
const AMOUNT = '12.50'
const LEDGER = 'Money/Ledger.tcsheet'
type Receipt = { state: string; name: string; file: string | null; ref: string | null }
const inbox = async ({ pair, workspace }: Context) => (await hostRows<Receipt>(pair,
  'SELECT state, name, file, ref FROM work_money_inbox WHERE workspace_id = ?', workspace.id))[0]

export function ledgerHasReceipt(ops: string, ref: string, who: string, dollars: number): boolean {
  const written = JSON.parse(ops) as { mutations?: { params?: { cellValue?: Record<string, Record<string, ({ v?: unknown } | null)>> } }[] }[]
  return written.some(op => op.mutations?.some(({ params }) => Object.values(params?.cellValue ?? {}).some(row => {
    const values = Object.values(row).map(cell => cell?.v)
    return values.includes(ref) && values.includes(who) && values.includes(dollars)
  })))
}

export default journey({
  id: 'J45',
  title: 'Review a dummy receipt and save it to the ledger',
  tier: 3,
  shapes: ['A'],
  steps: [
    step('Drop the receipt into Money and see it waiting for review', async (context) => {
      const { pair, workspace } = context
      await pair.showWork(workspace, 'Money')
      await pair.page.until('the Money view', 15_000, () => pair.page.centre('[data-money-view]'))
      const bytes = readFileSync(join(pair.repo, 'src/main/server/work/money/fixtures/coffee.png'))
      await desktopDrop(pair.page, '[data-money-view]', NAME, 'image/png', bytes)
      await pair.page.until('the receipt review button and pending inbox row', 45_000, async () =>
        !!await pair.page.centre('button', REVIEW) && (await inbox(context))?.state === 'ready')
      const row = (await inbox(context))!
      json(context, 'before-save', row)
      if (row.ref || existsSync(fileAt(context, LEDGER))) throw new Error('The receipt reached the ledger before Save')
    }),
    step('Check the picture and fill the dummy receipt fields before Save', async (context) => {
      const { page } = context.pair
      await page.press('button', REVIEW)
      await field(page, 'Who', WHO)
      await field(page, 'Amount', AMOUNT)
      await page.until('the receipt picture in the review', 25_000, () => page.eval(
        `[...document.querySelectorAll('[role="dialog"] img')].some(img => img.complete && img.naturalWidth > 0)`))
      if ((await inbox(context))?.state !== 'ready' || existsSync(fileAt(context, LEDGER))) throw new Error('Review alone changed the ledger')
    }),
    step('end: Save writes one receipt entry in Money and in Ledger.tcsheet', async (context) => {
      const { page } = context.pair
      await page.clickOn('[role="dialog"] button', 'Save')
      await page.until('the filed receipt row and kept ledger', 40_000, async () =>
        (await inbox(context))?.state === 'filed' && existsSync(fileAt(context, LEDGER)))
      const row = (await inbox(context))!
      const ops = unzip(fileAt(context, LEDGER), 'ops.json')
      json(context, 'filed', { row, ops: JSON.parse(ops) })
      const ref = row.ref ? (JSON.parse(row.ref) as { ref?: string }).ref : undefined
      if (!ref || !ledgerHasReceipt(ops, ref, WHO, Number(AMOUNT))) throw new Error('The receipt’s figures and Ref do not share a ledger row')
      await page.until('the saved entry in Money', 15_000, async () =>
        await shown(page, '[data-money-row]', WHO) && await shown(page, '[data-money-row]', '$' + AMOUNT))
    })
  ]
})
