import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { documentHas, focusDocument } from './lib/edit'
import { closeTab, holds, openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'

const NAME = 'Practice revision.tcdoc'
const OLD = 'Practice is on Tuesday'
const NEW = 'Practice is on Thursday'
const VERSION = '[role="checkbox"][aria-label^="Pick the "]'

async function versions({ pair, ...context }: Context) {
  const path = fileAt({ pair, ...context }, NAME)
  return pair.rpc<{ versions: { id: string }[] }>(pair.box, 'work.history.versions', {
    source: { at: 'file', host: pair.box.host, path }
  })
}

async function saveVersion(context: Context, line: string, minimum: number) {
  const { page } = context.pair
  const path = fileAt(context, NAME)
  await focusDocument(page)
  await page.key('Control+a')
  await page.typeKeys(line)
  await page.until('the edit in the document on box', 20_000, () => holds(path, line))
  // The last connection leaving the document cuts the same idle version as a ten-minute wait.
  await closeTab(page, NAME)
  await page.until('the document tab closed and its version on box', 30_000, async () =>
    await page.tabClosed(NAME) && (await versions(context)).versions.length >= minimum)
}

export default journey({
  id: 'J25',
  title: 'Compare two saved document versions and restore the older words',
  tier: 1,
  shapes: ['A'],
  steps: [
    step('Type the first version and wait for History to keep it', async (context) => {
      copyFileSync(join(context.pair.repo, 'resources/work-files/blank/blank.tcdoc'), fileAt(context, NAME))
      await showPlace(context)
      await openRow(context.pair.page, NAME)
      await saveVersion(context, OLD, 1)
    }),
    step('Type a second version and open History', async (context) => {
      const { page } = context.pair
      const first = (await versions(context)).versions[0]!.id
      await openRow(page, NAME)
      await saveVersion(context, NEW, 2)
      const second = (await versions(context)).versions[0]!.id
      if (first === second) throw new Error('History kept no separate version for the second edit')
      writeFileSync(join(context.folder, 'versions.json'), JSON.stringify({ first, second }))
      await openRow(page, NAME)
      await page.clickOn('[data-canvas-bar] button', 'History')
      const { Database } = await import('bun:sqlite')
      const db = new Database(join(context.pair.box.data, 'temp-code.db'), { readonly: true })
      try {
        const items = db.query<{ id: string }, [string]>("SELECT id FROM work_canvas_items WHERE kind = ? AND state = 'open'")
        await page.until('the History item to open on box or appear in the window', 10_000, async () =>
          items.all('history').length || await page.centre('[data-canvas-pane][data-kind="history"]'))
        writeFileSync(join(context.folder, 'history-items.json'), JSON.stringify(items.all('history')))
      } finally {
        db.close()
      }
    }),
    step('Pick the two versions and check the changed words are marked', async ({ pair, folder }) => {
      const { page } = pair
      for (const index of [0, 1]) {
        let point: { x: number; y: number } | null = null
        await page.until('a version checkbox', 12_000, async () => (point = await page.eval(`(() => {
          const el = document.querySelectorAll(${JSON.stringify(VERSION)})[${index}];
          const r = el?.getBoundingClientRect();
          return r?.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        })()`)))
        await page.click(point!)
      }
      await page.clickOn('[data-canvas-bar] button', 'Compare')
      await page.until('Tuesday marked as removed and Thursday marked as added', 18_000, () => page.eval(`(() => {
        const marked = (color, term) => [...document.querySelectorAll('[data-row] [class]')]
          .some((node) => node.className.includes(color) && term.includes(node.textContent.trim()) && node.textContent.trim());
        return marked('--del-bg', 'Tuesday') && marked('--add-bg', 'Thursday');
      })()`))
      await page.shot(join(folder, 'compare.png'))
    }),
    step('Restore the older version', async ({ pair }) => {
      const { page } = pair
      await page.clickOn('[data-canvas-bar] button', 'History')
      const older = await page.eval<{ x: number; y: number } | null>(`(() => {
        const row = document.querySelectorAll(${JSON.stringify(VERSION)})[1]?.closest('[aria-selected]');
        const button = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Restore');
        const r = button?.getBoundingClientRect();
        return r?.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      })()`)
      if (!older) throw new Error('The older version offers no Restore')
      await page.click(older)
    }),
    step('end: the live document reads as before and History still keeps the newer edit', async (context) => {
      const { second } = JSON.parse(readFileSync(join(context.folder, 'versions.json'), 'utf8')) as { second: string }
      const { page } = context.pair
      const path = fileAt(context, NAME)
      await page.until('the restored words on box', 25_000, () => holds(path, OLD) && !holds(path, NEW))
      await page.press('tab', NAME)
      await page.until('the restored words in the editor', 25_000, async () =>
        await documentHas(page, OLD) && !await documentHas(page, NEW))
      if (!(await versions(context)).versions.some(({ id }) => id === second)) throw new Error('Restore removed the newer version from History')
    })
  ]
})
