import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowMenu, tabMenu } from './lib/actions'
import { holderState, menuItems, notOffered, sameHolder } from './lib/far'
import { replaceText, TEXT_EDITOR } from './lib/edit'
import { openRow, rowAt } from './lib/files'
import { fileAt, goPlace, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { words } from './lib/shape'
import type { Window } from './lib/window'

const CLEAN = 'Practice times.txt'
const DIRTY = 'Practice changes.txt'
const BEFORE = 'Practice at noon'
const DRAFT = 'Practice at dusk'
const DIALOG = '[role="alertdialog"], [role="dialog"]'
const far = new WeakMap<object, Record<string, string>>()

async function confirmDelete(page: Window, file: string): Promise<string | null> {
  let dialog: string | null = null
  await page.until('a delete question or the file to leave its folder', 12_000, async () => {
    dialog = await page.eval(`document.querySelector(${JSON.stringify(DIALOG)})?.innerText ?? null`)
    return dialog || !existsSync(file)
  })
  if (dialog) await page.clickOn(`[role="alertdialog"] button, [role="dialog"] button`, 'Delete')
  return dialog
}

async function noteFailure(context: Context, name: string, error: unknown): Promise<void> {
  const { pair, folder } = context
  await pair.page.shot(join(folder, name + '.png'))
  writeFileSync(join(folder, name + '.json'), JSON.stringify({
    error: words(error), toasts: await pair.page.toasts(), saveLine: await pair.page.saveLine(), hostErrors: pair.hostErrors
  }, null, 2))
  await pair.page.key('Escape')
}

export default journey({
  id: 'J15',
  title: 'Restore from Trash and delete a file with unsent words',
  tier: 1,
  shapes: ['A', 'B2'],
  steps: [
    step('Delete the first file and look for it in Trash', async (context) => {
      const { page } = context.pair
      const clean = fileAt(context, CLEAN)
      writeFileSync(clean, BEFORE)
      writeFileSync(fileAt(context, DIRTY), BEFORE)
      await showPlace(context)
      try {
        await rowMenu(page, CLEAN)
        if (!await page.centre('[role="menuitem"]', 'Delete')) throw new Error('The row menu does not allow Delete')
        await page.press('menuitem', 'Delete')
        await confirmDelete(page, clean)
        await page.until('the first file to leave its folder', 15_000, () => !existsSync(clean))
        await page.clickOn('[data-files-sidebar] button', 'Trash')
      } catch (error) {
        await noteFailure(context, 'clean-delete', error)
      }
    }, ['A']),
    step('Put the first file back from Trash', async (context) => {
      const { page } = context.pair
      if (existsSync(join(context.folder, 'clean-delete.json'))) return
      try {
        await rowMenu(page, CLEAN)
        await page.press('menuitem', 'Put Back')
        const clean = fileAt(context, CLEAN)
        await page.until('the first file and its bytes back in their folder', 12_000, () => existsSync(clean) && readFileSync(clean, 'utf8') === BEFORE)
      } catch (error) {
        await noteFailure(context, 'put-back', error)
      }
    }, ['A']),
    step('Type in the second file and delete before its words reach the holder', async (context) => {
      const { page } = context.pair
      await goPlace(context)
      await openRow(page, DIRTY)
      await page.until('the text file’s original words', 15_000, () => page.eval(`document.querySelector(${JSON.stringify(TEXT_EDITOR)})?.textContent?.trim() === ${JSON.stringify(BEFORE)}`))
      await replaceText(page, DRAFT)
      await tabMenu(page, DIRTY)
      const file = fileAt(context, DIRTY)
      const line = await page.saveLine()
      const holderBeforeDelete = readFileSync(file, 'utf8')
      try {
        if (!await page.centre('[role="menuitem"]', 'Delete')) throw new Error('The open file’s menu does not allow Delete')
        await page.press('menuitem', 'Delete')
        const question = await confirmDelete(page, file)
        writeFileSync(join(context.folder, 'dirty-delete.json'), JSON.stringify({ line, holderBeforeDelete, question }, null, 2))
      } catch (error) {
        await noteFailure(context, 'dirty-delete-refused', error)
      }
    }, ['A']),
    step('end: Trash restores the first file and deletion keeps or warns about the typed words', async (context) => {
      const { pair, folder } = context
      const failures: string[] = []
      if (existsSync(join(folder, 'clean-delete.json'))) failures.push('The first file could not be deleted from its row')
      if (existsSync(join(folder, 'put-back.json'))) failures.push('The first file did not come back from Trash')
      if (existsSync(join(folder, 'dirty-delete-refused.json'))) {
        failures.push('The open file could not be deleted with words waiting')
        throw new Error(failures.join('. '))
      }
      const { question, holderBeforeDelete } = JSON.parse(readFileSync(join(folder, 'dirty-delete.json'), 'utf8')) as {
        question: string | null; holderBeforeDelete: string
      }
      if (holderBeforeDelete === DRAFT) failures.push('Harness could not reach Delete before the words were saved')
      const file = fileAt(context, DIRTY)
      await pair.page.until('the second file to reach Trash', 12_000, () => !existsSync(file))
      await pair.page.until('the deleted file’s tab to close', 5000, () => pair.page.tabClosed(DIRTY))
      const bin = readdirSync(pair.root).filter((name) => name.startsWith('trash.')).map((name) => join(pair.root, name, DIRTY))
      const warning = /changes.*(?:lost|discard)|(?:lost|discard).*changes/is
      if (!bin.some((path) => existsSync(path) && readFileSync(path, 'utf8') === DRAFT) && !warning.test(question ?? '')) {
        // The workspace's own Trash is restorable. Read the restored file to see whether it kept the draft.
        await pair.page.clickOn('[data-files-sidebar] button', 'Trash')
        if (await rowAt(pair.page, DIRTY) || context.shape === 'A') {
          await rowMenu(pair.page, DIRTY)
          await pair.page.press('menuitem', 'Put Back')
          await pair.page.until('the second file restored from Trash', 10_000, () => existsSync(file))
        }
        if (!existsSync(file) || readFileSync(file, 'utf8') !== DRAFT) failures.push('Delete lost the typed words without warning')
      }
      if (failures.length) throw new Error(failures.join('. '))
    }, ['A']),
    // B2: Delete is not offered in a library on a third computer reached through the box, neither on a row nor on an open
    // file's tab. That is honest as it stands; offering it is the owner's ruling. The walk asserts Delete takes no press
    // in either menu (both grey it out) and nothing on the holder changed.
    step('The far library’s row menu offers no Delete', async (context) => {
      const { page } = context.pair
      writeFileSync(fileAt(context, CLEAN), BEFORE)
      writeFileSync(fileAt(context, DIRTY), BEFORE)
      far.set(context, holderState(context))
      await showPlace(context)
      await rowMenu(page, CLEAN)
      notOffered(await menuItems(page, { context, name: 'row-menu' }), 'Delete', 'The row menu')
    }, ['B2']),
    step('end: the open file’s menu offers no Delete and the holder is as it was', async (context) => {
      const { page } = context.pair
      await openRow(page, DIRTY)
      await page.until('the text file’s original words', 15_000, () => page.eval(`document.querySelector(${JSON.stringify(TEXT_EDITOR)})?.textContent?.trim() === ${JSON.stringify(BEFORE)}`))
      await tabMenu(page, DIRTY)
      notOffered(await menuItems(page, { context, name: 'tab-menu' }), 'Delete', 'The open file’s menu')
      sameHolder(context, far.get(context)!, 'end')
    }, ['B2'])
  ]
})
