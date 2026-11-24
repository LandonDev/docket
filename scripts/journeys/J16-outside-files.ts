import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktopDrop } from './lib/drop'
import { TEXT_EDITOR } from './lib/edit'
import { closeTab, dummyPdf, openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { words } from './lib/shape'

const DROP = 'Dropped practice notes.txt'
const PICK = 'Picked practice plan.pdf'
const DROPPED = 'The dropped note says blue'
const PICKED = dummyPdf()

function shows(context: Context, text: string) {
  return context.pair.page.eval(`[...document.querySelectorAll(${JSON.stringify(TEXT_EDITOR + ', [data-canvas-item] .cm-content')})].some((node) => (node.value ?? node.textContent).trim() === ${JSON.stringify(text)})`)
}

function pdfDrawn(context: Context) {
  return context.pair.page.eval(`!!document.querySelector('[data-pdf-page="1"] canvas')?.width`)
}

export default journey({
  id: 'J16',
  title: 'Bring a desktop drop and a picked file into the workspace folder',
  tier: 1,
  shapes: ['A'],
  steps: [
    step('Drop a desktop File in the folder and open the resulting row', async (context) => {
      const { page } = context.pair
      await showPlace(context)
      try {
        await desktopDrop(page, '[data-files-page] [data-files-body]', DROP, 'text/plain', Buffer.from(DROPPED))
        const file = fileAt(context, DROP)
        await page.until('the dropped bytes in the workspace folder', 16_000, () => existsSync(file) && readFileSync(file, 'utf8') === DROPPED)
        await openRow(page, DROP)
        await page.until('the dropped file in its text editor', 12_000, () => shows(context, DROPPED))
        await closeTab(page, DROP)
        await page.until('the dropped file tab to close', 12_000, () => page.tabClosed(DROP))
      } catch (error) {
        writeFileSync(join(context.folder, 'drop-error.txt'), words(error))
        await page.shot(join(context.folder, 'drop.png'))
      }
    }),
    step('Choose a file through File → Open File…', async (context) => {
      const { page } = context.pair
      const path = join(context.folder, PICK)
      writeFileSync(path, PICKED)
      // TEMP_CODE_DIALOG_ANSWER is for yes/no prompts. The dev picker hook answers dialog:open.
      const clicked = await page.eval<boolean>(`(async () => {
        await window.api.debug.nextPick([${JSON.stringify(path)}]);
        return window.api.debug.menuClick('open_file');
      })()`)
      if (!clicked) throw new Error('The native menu refused Open File…')
    }),
    step('end: the files open in their kind and their bytes lie in the folder', async (context) => {
      const { page } = context.pair
      const file = fileAt(context, PICK)
      const failures: string[] = []
      const drop = join(context.folder, 'drop-error.txt')
      if (existsSync(drop)) failures.push(readFileSync(drop, 'utf8'))
      try {
        await page.until('the picked PDF open and its bytes in the workspace folder', 20_000, async () =>
          await pdfDrawn(context) && existsSync(file) && readFileSync(file, 'utf8') === PICKED)
      } catch (error) {
        failures.push(words(error))
        writeFileSync(join(context.folder, 'picker.json'), JSON.stringify({
          fileInFolder: existsSync(file), bytesMatch: existsSync(file) && readFileSync(file, 'utf8') === PICKED, pdfDrawn: await pdfDrawn(context)
        }))
      }
      if (failures.length) throw new Error(failures.join('. '))
    })
  ]
})
