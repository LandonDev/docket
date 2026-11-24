import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { replaceText } from './lib/edit'
import { openRow } from './lib/files'
import { fileAt, selectFolderTab, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'Desk practice.txt'
const BEFORE = 'Meet at noon'
const AFTER = 'Meet at the side door'

export default journey({
  id: 'J24',
  title: 'Keep writing in a library copy while its desktop is away',
  tier: 1,
  shapes: ['B2'],
  steps: [
    step('Open a text file held on desk', async (context) => {
      writeFileSync(fileAt(context, NAME), BEFORE)
      await showPlace(context)
      await openRow(context.pair.page, NAME)
    }),
    step('Stop desk and read the folder’s away notice and Retry', async (context) => {
      const { pair, folder } = context
      pair.later(async () => { if (!pair.abort.signal.aborted) await pair.restart(pair.desk!) })
      await pair.halt(pair.desk!)
      await selectFolderTab(context)
      await pair.page.until('the folder’s away notice and Retry', 25_000, async () => {
        const line = await pair.page.eval<string>('document.body.innerText')
        if (!/away|out of reach|did not answer|not online/i.test(line) || !await pair.page.centre('button', 'Retry')) return false
        writeFileSync(join(folder, 'away.txt'), line)
        return true
      })
    }),
    step('Edit the open copy while it says it waits', async (context) => {
      const { pair, folder } = context
      await pair.page.press('tab', NAME)
      await replaceText(pair.page, AFTER)
      await pair.page.until('the copy to say it waits for the holder', 20_000, async () => /wait|offline|away/i.test(await pair.page.saveLine() ?? ''))
      await pair.page.shot(join(folder, 'waiting.png'))
      if (readFileSync(fileAt(context, NAME), 'utf8') !== BEFORE) throw new Error('Desk’s file changed while desk was stopped')
    }),
    step('Start desk again with the same data', async ({ pair }) => {
      await pair.restart(pair.desk!)
    }),
    step('end: the waiting copy has been sent and desk holds the words', async (context) => {
      await context.pair.page.until('the new text on desk', 45_000, () => readFileSync(fileAt(context, NAME), 'utf8') === AFTER)
    })
  ]
})
