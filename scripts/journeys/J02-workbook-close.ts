import { appendFileSync, copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeTab, openRow, unzip } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { a1Point, cellValue, falseSaveLine, shownA1 } from './lib/sheet'

const NAME = 'Practice roster.xlsx'
const VALUE = 'Blue team'

function held(context: Context): string | undefined {
  const file = fileAt(context, NAME)
  return cellValue(unzip(file, 'xl/worksheets/sheet1.xml'), unzip(file, 'xl/sharedStrings.xml'), 'A1')
}

async function readLine(context: Context, moment: string, committed: boolean): Promise<void> {
  const line = await context.pair.page.saveLine()
  const at = new Date().toISOString()
  const onDisk = held(context)
  appendFileSync(join(context.folder, 'save-lines.jsonl'), JSON.stringify({
    at, moment, line, holderA1: onDisk, false: falseSaveLine(line, committed, onDisk === VALUE)
  }) + '\n')
}

export async function finishWorkbookClose(page: Context['pair']['page'], name: string): Promise<void> {
  // DESIGN.md, The Files place: a copy still sending can ask once. Keep trying closes the tab and preserves the edit.
  const dialog = '[role="alertdialog"], [role="dialog"]'
  const answer = '[role="alertdialog"] button, [role="dialog"] button'
  let needsChoice = false
  await page.until('the workbook tab to close or ask to keep trying', 10_000, async () => {
    if (await page.tabClosed(name)) return true
    needsChoice = await page.eval(`[...document.querySelectorAll(${JSON.stringify(dialog)})].some((el) =>
      el.innerText.includes(${JSON.stringify('Changes to ' + name + ' have not reached ')}))`) &&
      !!await page.centre(answer, 'Keep trying')
    return needsChoice
  })
  if (needsChoice) await page.clickOn(answer, 'Keep trying')
  await page.until('the workbook tab to close', 10_000, () => page.tabClosed(name))
}

export default journey({
  id: 'J02',
  title: 'Close a workbook at once and check its save line and cell',
  tier: 1,
  shapes: ['B1', 'B2'],
  steps: [
    step('Open the workbook and read its save line', async (context) => {
      copyFileSync(join(context.pair.repo, 'src/main/server/work/sheets/harness/corpus/formulas.xlsx'), fileAt(context, NAME))
      await showPlace(context)
      await openRow(context.pair.page, NAME)
      await context.pair.page.until('the worksheet and its header', 60_000, async () => await a1Point(context.pair.page) && await context.pair.page.eval('!!document.querySelector("[data-files-save-line]")'))
      await readLine(context, 'opened', false)
    }),
    step('Type A1, commit the cell and press the tab × at once', async (context) => {
      const { page } = context.pair
      await page.click((await a1Point(page))!)
      await page.typeKeys(VALUE)
      await readLine(context, 'while typing', false)
      await page.key('Enter')
      const reading = readLine(context, 'after Enter, before close', true)
      await closeTab(page, NAME)
      await reading
      await readLine(context, 'after pressing ×', true)
    }),
    step('end: the reopened sheet and its holder have A1 and the save lines were true', async (context) => {
      const { page } = context.pair
      await finishWorkbookClose(page, NAME)
      await openRow(page, NAME)
      await page.until('the reopened worksheet', 45_000, () => a1Point(page))
      await readLine(context, 'reopened', true)
      const failures: string[] = []
      await page.until('A1 in the reopened grid and holder’s workbook', 12_000, async () =>
        await shownA1(page) === VALUE && held(context) === VALUE
      ).catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.startsWith('Timed out')) throw error
        failures.push('The reopened grid or the holder’s A1 lost the cell')
      })
      await readLine(context, 'end', true)
      const readings = readFileSync(join(context.folder, 'save-lines.jsonl'), 'utf8').trim().split('\n')
        .map((row) => JSON.parse(row) as { false: boolean; moment: string; line: string })
      for (const row of readings.filter((reading) => reading.false)) failures.push(`${row.moment}: “${row.line}” while the holder still had the old cell`)
      if (failures.length) throw new Error(failures.join('. '))
    })
  ]
})
