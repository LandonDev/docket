import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { documentHas, focusDocument } from './lib/edit'
import { holds, openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step } from './lib/record'
import { createThread, workTool } from './lib/thread'

const NAME = 'Private practice.tcdoc'
const OLD = 'Practice on Tuesday'
const NEW = 'Practice on Thursday'

export default journey({
  id: 'J30',
  title: 'Write privately through a thread tool and undo from the window',
  tier: 1,
  shapes: ['A'],
  steps: [
    step('Open a private document and give it its first words', async (context) => {
      const { pair } = context
      copyFileSync(join(pair.repo, 'resources/work-files/blank/blank.tcdoc'), fileAt(context, NAME))
      await showPlace(context)
      await openRow(pair.page, NAME)
      await focusDocument(pair.page)
      await pair.page.typeKeys(OLD)
      await pair.page.until('the original words on box', 20_000, () => holds(fileAt(context, NAME), OLD))
    }),
    step('Rewrite through the thread’s tool and check the file before any press', async (context) => {
      const { pair, folder, workspace } = context
      const file = fileAt(context, NAME)
      const { id } = await createThread(pair, workspace.id, 'Practice day change')
      const read = await workTool(pair, id, 'doc_read', { file })
      const revision = read.text.match(/Revision ([a-z0-9]+):/)?.[1]
      if (read.error || !revision) throw new Error(read.text)
      const wrote = await workTool(pair, id, 'doc_write', { file, revision, markdown: NEW, because: 'own' })
      writeFileSync(join(folder, 'write.json'), JSON.stringify(wrote, null, 2))
      if (wrote.error) throw new Error(wrote.text)
      await pair.page.until('the new words on box without a press', 20_000, () => holds(file, NEW) && !holds(file, OLD))
      await pair.page.until('the new words in the window', 15_000, () => documentHas(pair.page, NEW))
    }),
    step('Press the document’s Undo for the thread’s write', async ({ pair }) => {
      await pair.page.press('button', 'Undo')
    }),
    step('end: the window and the real file have the old words again', async (context) => {
      const { page } = context.pair
      await page.until('the old words restored on box and in the editor', 20_000, async () =>
        holds(fileAt(context, NAME), OLD) && !holds(fileAt(context, NAME), NEW) && await documentHas(page, OLD))
    })
  ]
})
