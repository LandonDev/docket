import { copyFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { focusDocument } from './lib/edit'
import { openRow, unzip } from './lib/files'
import { fileAt, holderFolder, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { words } from './lib/shape'

const ORIGINAL = 'TempCode proof agenda.docx'
const STEM = 'TempCode proof agenda copy'
const DIALOG = '[data-save-as]'
/** The copy, and any second one a retry made beside it ("… copy 2.docx"). */
const copies = (context: Context): string[] => readdirSync(holderFolder(context)).filter((n) => n.startsWith(STEM) && n.endsWith('.docx')).sort()

/**
 * Save As… of a Word file of the library into its own folder on the computer that holds it (audit "Save As's false
 * failure", J23 B1's Word step): the file is made there, the sheet closes with no "Not saved", and a second press
 * after a failure makes no "copy 2".
 */
async function saveAsHere(context: Context): Promise<{ toasts: string[]; retried: boolean }> {
  const { page } = context.pair
  await page.watchToasts()
  await page.clickOn('[data-canvas-bar] button', 'Save As…')
  await page.clickOn('#save-as-name')
  await page.key('Control+a')
  await page.typeKeys(STEM)
  // The sheet opens in the file's own folder; a build that opens on the places is walked there.
  const general = await page.centre(DIALOG + ' [role="option"]', 'General')
  if (general) {
    await page.click(general)
    await page.clickOn(DIALOG + ' [role="option"]', context.workspace.name)
  }
  await page.clickOn(DIALOG + ' button', 'Save')
  let retried = false
  await page.until('the Save As sheet to close', 25_000, async () => {
    if (await page.eval('!document.querySelector("[data-save-as]")')) return true
    // He reads "Not saved" and presses Save again, as anyone would.
    if (!retried && (await page.toasts(true)).some((t) => t.startsWith('Not saved'))) {
      retried = true
      await page.clickOn(DIALOG + ' button', 'Save')
    }
    return false
  })
  return { toasts: await page.toasts(true), retried }
}

export default journey({
  id: 'J72',
  title: 'Save As a Word file into its own library folder',
  tier: 1,
  shapes: ['B1'],
  steps: [
    step('Open a Word file in the library', async (context) => {
      const { page, repo } = context.pair
      copyFileSync(join(repo, 'src/main/server/work/templates/fixtures/split.docx'), fileAt(context, ORIGINAL))
      await showPlace(context)
      await openRow(page, ORIGINAL)
      await focusDocument(page)
    }),
    step('end: Save As… into its folder made one file, with no Not saved', async (context) => {
      const { page } = context.pair
      const before = copies(context)
      const got = await saveAsHere(context).catch(async (error: unknown) => {
        await page.shot(join(context.folder, 'save-as.png'))
        throw error
      })
      const made = copies(context).filter((n) => !before.includes(n))
      writeFileSync(join(context.folder, 'save-as.json'), JSON.stringify({ ...got, made }, null, 2))
      const failed = got.toasts.find((t) => t.startsWith('Not saved'))
      if (failed) throw new Error(`Save As said "${words(failed)}" though the holder has ${made.join(', ') || 'nothing'}`)
      if (made.length !== 1 || made[0] !== STEM + '.docx') throw new Error(`The holder has ${made.join(', ') || 'no copy'}, not one ${STEM}.docx`)
      if (!unzip(join(holderFolder(context), made[0]), 'word/document.xml').includes('<w:body')) throw new Error(`${made[0]} is not a Word document`)
    })
  ]
})
