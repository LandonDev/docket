import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { browser } from './lib/browser'
import { focusDocument } from './lib/edit'
import { openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'

const NAME = 'Practice invitation.tcdoc'
const WORDS = 'Practice starts at noon'
const COMMENT = 'Can we meet by the side door?'
const GUEST = 'Robin Vale'
const visits = new WeakMap<Context, Awaited<ReturnType<typeof browser>>>()

export default journey({
  id: 'J20',
  title: 'Share a file, comment as a guest, and revoke the link',
  tier: 1,
  shapes: ['A', 'U'],
  steps: [
    step('Open a dummy document from the workspace folder', async (context) => {
      const { page, repo } = context.pair
      copyFileSync(join(repo, 'resources/work-files/blank/blank.tcdoc'), fileAt(context, NAME))
      await showPlace(context)
      await openRow(page, NAME)
      await focusDocument(page)
      await page.typeKeys(WORDS)
    }),
    step('Use Share to make a comment link for the guest', async ({ pair }) => {
      const { page } = pair
      await page.press('button', 'Share')
      await page.press('button', 'New guest link…')
      await page.clickOn('[role="dialog"] input')
      await page.typeKeys(GUEST)
      await page.clickOn('[role="dialog"] button', 'Comment')
      await page.press('button', 'Create link')
    }),
    step('Open the reachable address and post a guest comment', async (context) => {
      const { pair, folder } = context
      const shown = `[...document.querySelectorAll('[role="dialog"] span')].map(e => e.textContent.trim()).find(v => v.startsWith('http') && v.includes('/g/'))`
      let address: string | undefined
      await pair.page.until('the guest address in its dialog', 12_000, async () => (address = await pair.page.eval<string>(shown)))
      if (!address) throw new Error('The link dialog holds no address')
      const url = new URL(address)
      if (url.origin !== pair.guestOrigin || !url.pathname.startsWith('/g/')) throw new Error('The guest address does not name this journey’s box')
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('The window made a loopback guest address')
      const visit = await browser(pair, join(folder, 'guest-profile'), url)
      visits.set(context, visit)
      const { page } = visit
      await page.until('the guest to see the document', 20_000, () => page.eval(`document.body.innerText.includes(${JSON.stringify(WORDS)})`))
      await page.eval(`(() => { const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) { const start = node.textContent.indexOf(${JSON.stringify(WORDS)});
          if (start < 0) continue; const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + ${WORDS.length});
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); break;
        } })()`)
      await page.press('button', 'Comment')
      await page.clickOn('textarea')
      await page.typeKeys(COMMENT)
      await page.clickOn('button[type="submit"]', 'Comment')
      await page.until('the posted guest comment', 15_000, () => page.eval(`document.body.innerText.includes(${JSON.stringify(COMMENT)})`))
    }),
    step('Revoke the link from Share', async ({ pair }) => {
      await pair.page.press('button', 'Done')
      await pair.page.press('button', 'Share')
      await pair.page.press('button', 'Revoke')
      const confirm = await pair.page.centre('[role="alertdialog"] button', 'Revoke')
      if (confirm) await pair.page.click(confirm)
    }),
    step('end: the guest sees gone and the host has no live link for the guest', async (context) => {
      const { pair } = context
      const visit = visits.get(context)!
      await visit.page.reload()
      await visit.page.until('the revoked address to show gone', 15_000, () => visit.page.eval('document.body.innerText.includes("This link no longer opens anything")'))
      const links = await pair.rpc<{ name: string; revokedAt?: number }[]>(pair.box, 'work.guests.list')
      if (links.some((link) => link.name === GUEST && !link.revokedAt)) throw new Error('The guest link is still live on box')
      await visit.stop()
    })
  ]
})
