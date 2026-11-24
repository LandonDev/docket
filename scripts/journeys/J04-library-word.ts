import { appendFileSync, copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOC_EDITOR, documentHas, focusDocument } from './lib/edit'
import { closeSelectedFile, holds, openRow } from './lib/files'
import { fileAt, holderFolder, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { words } from './lib/shape'
import { hostRows } from './lib/thread'

const STEM = 'Practice instructions'
const NAME = STEM + '.docx'
const LOOK = 'Read only visit.docx'
const FIRST = 'Practice starts at nine'
const LAST = 'Bring a green notebook'

function listings(context: Context) {
  return { workspace: readdirSync(context.workspace.path).sort(), library: readdirSync(holderFolder(context)).sort() }
}

async function readSave(context: Context, moment: string) {
  const line = await context.pair.page.saveLine()
  const file = fileAt(context, NAME)
  const first = holds(file, FIRST)
  const last = holds(file, LAST)
  appendFileSync(join(context.folder, 'save-lines.jsonl'), JSON.stringify({ at: new Date().toISOString(), moment, line, first, last }) + '\n')
  return { line, first, last }
}

export async function waitForWordRevision(context: Context, name: string): Promise<void> {
  const { pair, workspace } = context
  const file = fileAt(context, name)
  await pair.page.until('the host to see the Word document’s initial revision', 15_000, async () => {
    const [row] = await hostRows<{ base_rev: string | null }>(pair,
      'SELECT base_rev FROM work_files_word WHERE workspace_id = ? AND path = ?', workspace.id, file)
    return row?.base_rev
  })
}

export default journey({
  id: 'J04',
  title: 'Make and reopen a Teams Word document, then visit another without editing',
  tier: 1,
  shapes: ['B1'],
  steps: [
    step('Use New Document in Teams and check the .docx on its holder', async (context) => {
      const { page, repo } = context.pair
      copyFileSync(join(repo, 'src/main/server/work/templates/fixtures/split.docx'), fileAt(context, LOOK))
      await showPlace(context)
      await page.press('button', 'New')
      await page.press('menuitem', 'Document')
      await page.until('the new document name field', 20_000, () => page.eval('document.activeElement?.matches("[data-files-row] input")'))
      await page.typeKeys(STEM)
      await page.key('Enter')
      await page.until('the Word package on the library holder', 12_000, () => existsSync(fileAt(context, NAME)))
      await openRow(page, NAME)
      await focusDocument(page)
      await waitForWordRevision(context, NAME)
      await readSave(context, 'opened')
    }),
    step('Type two paragraphs and compare the save line with the holder', async (context) => {
      const { page } = context.pair
      await page.typeKeys(FIRST)
      const first = await readSave(context, 'first paragraph')
      await page.typeKeys('\n' + LAST)
      const last = await readSave(context, 'second paragraph')
      const saved = /^(?:Saved\b|In Teams\b)/
      const failures: string[] = []
      if (saved.test(first.line ?? '') && !first.first || saved.test(last.line ?? '') && !last.last) {
        failures.push('The header claimed the latest words were saved while the Word file still lacked them')
      }
      try {
        await page.until('both paragraphs in the Word file', 35_000, async () => {
          const reading = await readSave(context, 'waiting for the holder')
          if (saved.test(reading.line ?? '') && !reading.last && !failures.length) failures.push('A saved line preceded the new words on the holder')
          return reading.first && reading.last
        })
      } catch (error) {
        failures.push(words(error))
      }
      await readSave(context, 'after waiting for the holder')
      if (failures.length) {
        await page.shot(join(context.folder, 'word-save.png'))
        writeFileSync(join(context.folder, 'word-save-error.json'), JSON.stringify({
          failures, toasts: await page.toasts(), saveLine: await page.saveLine(), hostErrors: context.pair.hostErrors
        }))
      }
    }),
    step('Close and reopen the same Word document', async (context) => {
      const { page } = context.pair
      await closeSelectedFile(page)
      await openRow(page, NAME)
      await page.until('the same document with both paragraphs', 35_000, () => documentHas(page, FIRST, LAST))
      await readSave(context, 'reopened')
      await closeSelectedFile(page)
    }),
    step('end: a Word file only opened has no saving claim or extra file left behind', async (context) => {
      const { page } = context.pair
      const before = listings(context)
      await openRow(page, LOOK)
      await page.until('the untouched Word editor', 35_000, () => page.centre(DOC_EDITOR))
      // The Files docs say a never-edited copy goes with its tab once the host has seen its initial revision.
      await waitForWordRevision(context, LOOK)
      const line = (await readSave(context, 'untouched Word file open')).line
      const during = listings(context)
      await closeSelectedFile(page)
      let after = listings(context)
      try {
        await page.until('both folders to match their original listings', 12_000, () => {
          after = listings(context)
          return JSON.stringify(before) === JSON.stringify(after)
        })
      } finally {
        writeFileSync(join(context.folder, 'word-folders.json'), JSON.stringify({ before, during, after, line }, null, 2))
      }
      const failures: string[] = []
      const save = join(context.folder, 'word-save-error.json')
      if (existsSync(save)) failures.push(...(JSON.parse(readFileSync(save, 'utf8')).failures as string[]))
      if (/^(?:Saving|Saved|In Teams)\b/i.test(line ?? '')) failures.push(`An untouched Word file says “${line}”`)
      if (failures.length) throw new Error(failures.join('. '))
    })
  ]
})
