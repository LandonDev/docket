import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openRow } from './lib/files'
import { fileAt, holderFolder, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'Practice checklist.txt'
const WORDS = 'Bring a water bottle'
const ASK = 'Check the practice list'
const DOCK = '[data-files-dock]'

export default journey({
  id: 'J12',
  title: 'Open one library file from Files and a sent file chip',
  tier: 1,
  shapes: ['B1'],
  steps: [
    step('Open the file from its Files row', async (context) => {
      writeFileSync(fileAt(context, NAME), WORDS)
      await showPlace(context)
      await openRow(context.pair.page, NAME)
    }),
    step('Send a message from Ask with the file chip', async ({ pair, workspace }) => {
      const { page } = pair
      await page.clickOn('[data-files-header] button', 'Ask')
      await page.until('the file chip in the draft', 15_000, () => page.eval(
        `document.querySelector('${DOCK} [data-chip="file"]')?.textContent.includes(${JSON.stringify(NAME)})`
      ))
      await page.clickOn(`${DOCK} [data-composer-input]`)
      await page.typeKeys(ASK)
      await page.clickOn(`${DOCK} button`, 'Send')
      const { Database } = await import('bun:sqlite')
      const db = new Database(join(pair.box.data, 'temp-code.db'), { readonly: true })
      try {
        const sent = db.query<{ payload: string }, [string]>(
          'SELECT events.payload FROM events JOIN sessions ON events.session_id = sessions.id WHERE sessions.workspace_id = ?'
        )
        await page.until('the sent file chip in the thread on box', 20_000, () => sent.all(workspace.id).some(({ payload }) => {
          const event = JSON.parse(payload) as { type?: string; text?: string }
          return event.type === 'user-text' && event.text?.includes(ASK) && event.text.includes('About this file: ' + NAME)
        }))
        await page.until('a request to the loopback fake provider', 15_000, () => pair.fakeMessages > 0)
      } finally {
        db.close()
      }
    }),
    step('Open the sent file chip', async ({ pair, folder }) => {
      const { page } = pair
      const chip = '[data-sent-chips] [data-chip="file"]'
      await page.until('the sent file chip', 15_000, () => page.centre(chip))
      let tag = await page.eval<string>(`document.querySelector('${chip}')?.firstElementChild?.tagName`)
      if (tag !== 'BUTTON') {
        await page.press('button', 'Open in its own tab')
        await page.until('the sent message in the thread tab', 12_000, () => page.centre(chip))
        tag = await page.eval<string>(`[...document.querySelectorAll('${chip}')].find((el) => el.getClientRects().length)?.firstElementChild?.tagName`)
      }
      writeFileSync(join(folder, 'sent-chip.json'), JSON.stringify({ tag }))
      if (tag !== 'BUTTON') throw new Error('The sent file chip has no Open action')
      await page.clickOn(chip + ' button', NAME)
    }),
    step('end: the chip takes the same tab and only one copy is on disk', async (context) => {
      const { page } = context.pair
      await page.until('the file in its selected tab', 12_000, () => page.centre('[data-files-tab][aria-selected="true"]', NAME))
      const tabs = await page.eval<number>(`[...document.querySelectorAll('[data-files-tab-close]')].filter((tab) => tab.getAttribute('aria-label') === ${JSON.stringify('Close ' + NAME)}).length`)
      const workspace = readdirSync(context.workspace.path).sort()
      const library = readdirSync(holderFolder(context)).sort()
      const copies = [context.workspace.path, holderFolder(context)].flatMap((folder) =>
        readdirSync(folder, { withFileTypes: true }).filter((file) => file.isFile() && readFileSync(join(folder, file.name), 'utf8') === WORDS).map((file) => join(folder, file.name)))
      writeFileSync(join(context.folder, 'copies.json'), JSON.stringify({ tabs, workspace, library, copies }, null, 2))
      if (tabs !== 1 || copies.length !== 1 || copies[0] !== fileAt(context, NAME)) throw new Error(`Found ${tabs} tabs and ${copies.length} copies of the file`)
    })
  ]
})
