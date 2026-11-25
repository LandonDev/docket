import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeTab, openRow, unzip } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { a1Point, cellOf, shownA1 } from './lib/sheet'
import { finishWorkbookClose } from './J02-workbook-close'

const NAME = 'TempCode proof numbers.xlsx'
/** Typed into A1 to D1 (decision 15): two numbers, words that only look like one, and a formula reading A1. */
const TYPED = ['42', '3.5', '007', '=A1*2']

/** The holder's A1 to D1 as Excel reads them. */
function held(context: Context) {
  const file = fileAt(context, NAME)
  const sheet = unzip(file, 'xl/worksheets/sheet1.xml')
  const strings = unzip(file, 'xl/sharedStrings.xml')
  return Object.fromEntries(['A1', 'B1', 'C1', 'D1'].map((at) => [at, cellOf(sheet, strings, at) ?? null]))
}

const number = (t: string | null) => t === null || t === 'n'
const text = (t: string | null) => t === 's' || t === 'str' || t === 'inlineStr'

export default journey({
  id: 'J71',
  title: 'Numbers typed into a workbook stay numbers',
  tier: 1,
  shapes: ['A', 'B1'],
  steps: [
    step('Open a workbook', async (context) => {
      copyFileSync(join(context.pair.repo, 'src/main/server/work/sheets/harness/corpus/formulas.xlsx'), fileAt(context, NAME))
      await showPlace(context)
      await openRow(context.pair.page, NAME)
      // The grid's live workbook, not only a canvas: a first paint draws one before keys can reach a cell.
      await context.pair.page.until('the worksheet, live', 60_000, async () => await a1Point(context.pair.page) && await shownA1(context.pair.page) === 'Amount')
    }),
    step('Type 42, 3.5, 007 and =A1*2 across A1 to D1, then close the tab', async (context) => {
      const { page } = context.pair
      await page.click((await a1Point(page))!)
      for (const [i, words] of TYPED.entries()) {
        await page.typeKeys(words)
        await page.key(i < TYPED.length - 1 ? 'Tab' : 'Enter')
      }
      // What the grid took and the save line, before the close: a holder with no edit then says whether typing or saving missed.
      await page.until('the grid to hold 42 in A1', 10_000, async () => await shownA1(page) === 42).catch(() => undefined)
      writeFileSync(join(context.folder, 'typed.json'), JSON.stringify({ gridA1: await shownA1(page), line: await page.saveLine() }))
      await page.shot(join(context.folder, 'typed.png'))
      await closeTab(page, NAME)
      await finishWorkbookClose(page, NAME)
    }),
    step('end: the holder’s workbook holds 42 and 3.5 as numbers, 007 as text and the formula as one', async (context) => {
      const failures: string[] = []
      let cells = held(context)
      await context.pair.page.until('the holder’s workbook to have the typed row', 20_000, async () => {
        cells = held(context)
        return cells.A1?.value === '42' && cells.C1?.value === '007' && !!cells.D1?.formula
      }).catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.startsWith('Timed out')) throw error
      })
      writeFileSync(join(context.folder, 'cells.json'), JSON.stringify(cells, null, 2))
      const { A1, B1, C1, D1 } = cells
      if (!A1 || A1.value !== '42' || !number(A1.t)) failures.push(`A1 is ${JSON.stringify(A1)}, not the number 42`)
      if (!B1 || B1.value !== '3.5' || !number(B1.t)) failures.push(`B1 is ${JSON.stringify(B1)}, not the number 3.5`)
      if (!C1 || C1.value !== '007' || !text(C1.t)) failures.push(`C1 is ${JSON.stringify(C1)}, not the text 007`)
      if (!D1 || D1.formula !== 'A1*2') failures.push(`D1 is ${JSON.stringify(D1)}, not the formula =A1*2`)
      if (failures.length) throw new Error(failures.join('. '))
    })
  ]
})
