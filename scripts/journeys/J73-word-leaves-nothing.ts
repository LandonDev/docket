import { copyFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { focusDocument } from './lib/edit'
import { closeSelectedFile, holds, openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { hostRows } from './lib/thread'
import { waitForWordRevision } from './J04-library-word'

const NAME = 'TempCode proof notes.docx'
const WORDS = 'TempCode proof line for the store'

/** Every file and folder under the workspace's own folder, as relative paths: what he would see there. */
function everything(dir: string, under = ''): string[] {
  return readdirSync(join(dir, under), { withFileTypes: true }).flatMap((e) => {
    const rel = under ? join(under, e.name) : e.name
    return e.isDirectory() ? [rel + '/', ...everything(dir, rel)] : [rel]
  }).sort()
}
const inside = (path: string, dir: string): boolean => {
  const r = relative(dir, path)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}
const before = new WeakMap<Context, string[]>()

/**
 * The plan's decision 3: a Word file of a Teams library opened, typed into and saved to Teams leaves nothing in the
 * workspace's folder. Its document and the "before TempCode saved it" copy live in the host's hidden Word store.
 */
export default journey({
  id: 'J73',
  title: 'A Teams Word file leaves nothing in his folder',
  tier: 1,
  shapes: ['B1'],
  steps: [
    step('Open a Word file of the library, type into it and save it to Teams', async (context) => {
      const { page, repo } = context.pair
      copyFileSync(join(repo, 'src/main/server/work/templates/fixtures/split.docx'), fileAt(context, NAME))
      before.set(context, everything(context.workspace.path))
      await showPlace(context)
      await openRow(page, NAME)
      await focusDocument(page)
      await waitForWordRevision(context, NAME)
      await page.typeKeys(WORDS)
      // The first time a Word file holds edits not in it, the window may ask once how to save it; the header's press
      // saves it either way, over a file TempCode never wrote, so its "before" copy is kept first.
      const press = 'Save to Teams as Word'
      await page.until('the header press or the first-time question', 25_000, async () =>
        !!(await page.centre('button', 'Ask me each time')) || !!(await page.centre('button', press)))
      if (await page.centre('button', 'Ask me each time')) await page.press('button', 'Ask me each time')
      await page.press('button', press)
      await page.press('button', 'Replace')
      await page.until('the typed line in the Word file on its holder', 40_000, () => holds(fileAt(context, NAME), WORDS))
    }),
    step('end: closed, the workspace folder holds no new file; the document and the backup are in the Word store', async (context) => {
      const { pair, workspace } = context
      const { page } = pair
      await closeSelectedFile(page)
      const after = everything(workspace.path)
      const [row] = await hostRows<{ doc: string | null; original: string | null }>(pair,
        'SELECT doc, original FROM work_files_word WHERE workspace_id = ? AND path = ?', workspace.id, fileAt(context, NAME))
      const store = join(pair.box.data, 'work-files', 'word')
      writeFileSync(join(context.folder, 'word-store.json'), JSON.stringify({ before: before.get(context), after, row, store }, null, 2))
      const failures: string[] = []
      const added = after.filter((n) => !before.get(context)!.includes(n))
      if (added.length) failures.push(`The workspace folder gained ${added.join(', ')}`)
      if (!row?.doc || !inside(row.doc, store)) failures.push(`The document is not in the Word store: ${row?.doc ?? 'no record'}`)
      if (!row?.original || !inside(row.original, store)) failures.push(`The backup is not in the Word store: ${row?.original ?? 'none made'}`)
      if (failures.length) throw new Error(failures.join('. '))
    })
  ]
})
