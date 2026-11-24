import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FilesListing } from '../../src/shared/contract-work-files'
import { rowAt } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { createThread, workTool } from './lib/thread'

const STEM = 'Practice list from a thread'
const NAME = STEM + '.md'
const THREAD = 'Practice file maker'
const CHIP = '[data-chip="file"] button'
const sessions = new WeakMap<Context, string>()

export default journey({
  id: 'J31',
  title: 'Find a file made by a thread and open its chip',
  tier: 1,
  shapes: ['A'],
  steps: [
    step('Make a file through the Work tool and find it under Made by threads', async (context) => {
      const { pair, workspace, folder } = context
      await showPlace(context)
      const { id } = await createThread(pair, workspace.id, THREAD)
      sessions.set(context, id)
      const result = await workTool(pair, id, 'files_make', { place: 'folder', kind: 'text', name: STEM })
      writeFileSync(join(folder, 'tool.json'), JSON.stringify(result, null, 2))
      if (result.error || !existsSync(fileAt(context, NAME))) throw new Error('The thread did not make the file: ' + result.text)
      const listing = await pair.rpc<FilesListing>(pair.box, 'work.files.list', { workspaceId: workspace.id, at: { at: 'place', id: 'made' } })
      if (!listing.entries.some((entry) => entry.name === NAME && entry.fresh)) throw new Error('The host did not mark the new file')
      await pair.page.clickOn('[data-files-sidebar] button', 'Made by threads')
      await pair.page.until('the thread-made row', 15_000, () => rowAt(pair.page, NAME))
    }),
    step('Mention the file in its maker thread and open the sent chip', async (context) => {
      const { pair } = context
      await pair.page.eval(`window.__monocode.open(${JSON.stringify(sessions.get(context))})`)
      await pair.page.until('the maker thread to take the window', 15_000, () =>
        pair.page.eval(`document.body.innerText.includes(${JSON.stringify(THREAD)})`))
      await pair.page.clickOn('[data-composer-input]')
      await pair.page.typeKeys('@Practice')
      await pair.page.until('the file highlighted in the Work mention list', 20_000, () => pair.page.eval(
        `document.querySelector('[data-command-popover] [role="option"][aria-selected="true"]')?.innerText.includes(${JSON.stringify(NAME)})`
      ))
      await pair.page.key('Enter')
      await pair.page.until('the picked file chip', 12_000, () => pair.page.centre('[data-composer] [data-chip="file"]'))
      await pair.page.clickOn('[data-composer-input]')
      await pair.page.typeKeys('Keep this practice file handy')
      await pair.page.clickOn('[data-composer] button', 'Send')
      await pair.page.clickOn('[data-sent-chips] ' + CHIP, NAME)
    }),
    step('end: the thread’s chip opens the same file in a selected file tab', async (context) => {
      const { page } = context.pair
      // A press that is refused says so in a toast: keep its words for the record.
      const said = new Set<string>()
      await page.until('the chip’s selected file tab', 15_000, async () => {
        for (const toast of await page.toasts()) said.add(toast)
        return page.centre('[data-files-tab][aria-selected="true"]', NAME)
      }).catch(async (err: unknown) => {
        // What the host and the window hold at the failure: was the tab made, and which screen shows.
        const tabs = await context.pair.rpc(context.pair.box, 'work.files.tabs', { workspaceId: context.workspace.id }).catch((e: unknown) => String(e))
        const screen = await page.eval(`({ files: !!document.querySelector('[data-files-sidebar]'), tabs: [...document.querySelectorAll('[data-files-tab]')].map(e => e.textContent + ':' + e.getAttribute('aria-selected')), chips: [...document.querySelectorAll('[data-sent-chips] [data-chip]')].map(e => e.outerHTML.slice(0, 200)) })`)
        writeFileSync(join(context.folder, 'chip-press.json'), JSON.stringify({ tabs, screen }, null, 2))
        throw new Error((err instanceof Error ? err.message : String(err)) + (said.size ? ' Toasts while waiting: ' + [...said].join(' / ') : ' No toast while waiting.'))
      })
      if (!existsSync(fileAt(context, NAME))) throw new Error('The made file is gone from the workspace folder')
    })
  ]
})
