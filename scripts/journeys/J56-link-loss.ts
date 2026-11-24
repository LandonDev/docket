import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { replaceText } from './lib/edit'
import { openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'Practice reconnect.txt'
const FIRST = 'First practice note'
const LAST = FIRST + ' and the note typed while away'

export default journey({
  id: 'J56',
  title: 'Keep the text typed before and during a cut to box',
  tier: 1,
  shapes: ['A', 'B1'],
  steps: [
    step('Open the text file and begin writing', async (context) => {
      writeFileSync(fileAt(context, NAME), 'Original')
      await showPlace(context)
      const { page } = context.pair
      await openRow(page, NAME)
      await replaceText(page, FIRST)
    }),
    step('Cut only win’s link to box, then continue typing', async ({ pair, folder }) => {
      const { page } = pair
      pair.later(async () => pair.cutWindowLink(false))
      pair.cutWindowLink(true)
      await page.until('the window to lose the link while box stays up', 15_000, async () => {
        await pair.rpc(pair.box, 'work.get')
        return page.eval(`window.__monocode.registry.statusOf(${JSON.stringify(pair.box.host)}).transport !== 'open'`)
      })
      await page.key('Control+End')
      await page.typeKeys(LAST.slice(FIRST.length))
      await page.until('all the typed words while the save line says it waits', 22_000, async () =>
        /wait|offline|reconnect|away/i.test(await page.saveLine() ?? '') &&
        await page.eval(`document.querySelector('[data-files-file] .cm-content')?.textContent === ${JSON.stringify(LAST)}`))
      await page.shot(join(folder, 'offline-edit.png'))
    }),
    step('Restore only the cut link', async ({ pair }) => {
      pair.cutWindowLink(false)
      await pair.page.until('a fresh Work answer through the restored link', 22_000, async () => {
        const open = await pair.page.eval<boolean>(
          `window.__monocode.registry.statusOf(${JSON.stringify(pair.box.host)}).transport === 'open'`
        )
        return open && (await pair.fromWindow('work.get')).ok
      })
    }),
    step('end: the holder has every word typed before and during the cut', async (context) => {
      const file = fileAt(context, NAME)
      try {
        await context.pair.page.until('all the text on the holder', 30_000, () => readFileSync(file, 'utf8') === LAST)
      } finally {
        writeFileSync(join(context.folder, 'holder.txt'), readFileSync(file))
      }
    })
  ]
})
