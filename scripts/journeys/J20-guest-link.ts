import { join } from 'node:path'
import type { GuestLinkRow, GuestSource } from '../../src/shared/contract-work-guests'
import { browser } from './lib/browser'
import { openRow } from './lib/files'
import { evidence, PAGE, see, wordsIn } from './lib/lifeosJourney'
import { GUEST_DOC, GUEST_WORDS, SECTOR } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'

const QUOTE = 'north doors'
const GONE = 'This link no longer opens anything'
const EDITOR = '.tiptap'
const guestName = (context: Context) => 'Robin Vale ' + context.shape
const comment = (context: Context) => 'Can we put a sign by those doors? ' + context.shape
type Visit = Awaited<ReturnType<typeof browser>>
const states = new WeakMap<Context, { source: GuestSource; link?: GuestLinkRow; visit?: Visit }>()
const links = ({ pair }: Context) => pair.rpc<GuestLinkRow[]>(pair.box, 'work.guests.list')

export function guestAddress(url: URL, origin: string, id: string): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin &&
    !url.username && !url.password && url.pathname === '/g/' + id && url.hash.startsWith('#k=')
}

export default journey({
  id: 'J20',
  title: 'Share a LifeOS document, comment as a guest, and revoke the link',
  tier: 1,
  shapes: ['S', 'U'],
  steps: [
    step('Open the seeded LifeOS document and find Share', async (context) => {
      const { pair, workspace } = context
      const { page } = pair
      const { page: rows } = await pair.sandbox!.query<{ page: { _id: string; title: string }[] }>('docs:list', {
        sector: SECTOR, paginationOpts: PAGE
      })
      const doc = rows.find(({ title }) => title === GUEST_DOC)
      if (!doc) throw new Error('The sandbox has no practice invitation document')
      const source: GuestSource = { at: 'lifeos', table: 'docs', id: doc._id }
      const row = await pair.sandbox!.query<{ markdown: string }>('docs:get', { id: doc._id })
      if (!row.markdown.includes(GUEST_WORDS)) throw new Error('The document does not hold the practice invitation')
      states.set(context, { source })
      await pair.showWork(workspace, 'Files')
      await page.clickOn('[data-files-sidebar] button', 'LifeOS')
      await openRow(page, GUEST_DOC)
      await see(page, EDITOR, GUEST_WORDS)
      await page.until('Share on the LifeOS document', 10_000, () => page.centre('button', 'Share'))
      evidence(context, 'document', { source, title: GUEST_DOC, words: row.markdown })
    }),
    step('Make the comment link in Share and open it in a fresh guest profile', async (context) => {
      const { pair, folder } = context
      const state = states.get(context)!
      const { page } = pair
      await page.press('button', 'Share')
      await page.press('button', 'New guest link…')
      await page.clickOn('[role="dialog"] input[placeholder="Name"]')
      await page.typeKeys(guestName(context))
      await page.clickOn('[role="dialog"] button', 'Comment')
      await page.press('button', 'Create link')
      let address: string | undefined
      await page.until('the guest address in its dialog', 15_000, async () => (address = await page.eval<string>(
        `[...document.querySelectorAll('[role="dialog"] span')].map(e => e.textContent.trim()).find(v => /^https?:/.test(v) && v.includes('/g/'))`)))
      const url = new URL(address!)
      const link = (await links(context)).find((row) => row.source.id === state.source.id && row.name === guestName(context))
      if (!link || link.role !== 'comment' || link.revokedAt !== null) throw new Error('The host does not have the live comment link')
      const origin = pair.guestOrigin ?? 'http://127.0.0.1:' + pair.box.workPort
      if (!guestAddress(url, origin, link.id)) throw new Error('Share used ' + url.origin + ' instead of the sandbox host origin ' + origin)
      state.link = link
      await page.press('button', 'Done')
      const visit = state.visit = await browser(pair, join(folder, 'guest-profile'), url, 1000)
      context.evidencePage = visit.page
      await see(visit.page, EDITOR, GUEST_WORDS)
      await see(visit.page, 'header', 'Can comment')
      context.evidencePage = undefined
      evidence(context, 'link', { origin: url.origin, configuredOrigin: pair.guestOrigin, link })
    }),
    step('Select the words as the guest and see the same comment in LifeOS', async (context) => {
      const { pair } = context
      const { source, visit, link } = states.get(context)!
      const page = context.evidencePage = visit!.page
      const selected = await page.eval<string>(`(() => {
        const w = document.createTreeWalker(document.querySelector(${JSON.stringify(EDITOR)}), NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const i = n.data.indexOf(${JSON.stringify(QUOTE)});
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i); r.setEnd(n, i + ${QUOTE.length});
          const selection = document.getSelection();
          selection.removeAllRanges();
          selection.addRange(r);
          return selection.toString();
        }
        return '';
      })()`)
      if (selected !== QUOTE) throw new Error('The guest did not select the intended quotation')
      await page.press('button', 'Comment')
      await page.clickOn('textarea[aria-label="Comment"]')
      await page.typeKeys(comment(context))
      await page.clickOn('button[type="submit"]', 'Comment')
      await see(page, 'body', comment(context))
      type Thread = { thread: { quote?: string }; comments: { author: string; body: string }[] }
      let row: Thread | undefined
      await page.until('the guest quotation and comment in LifeOS', 12_000, async () => {
        const rows = await pair.sandbox!.query<Thread[]>('docs:threads', { docId: source.id })
        row = rows.find(({ thread, comments }) => thread.quote === QUOTE &&
          comments.some(({ author, body }) => author === 'guest:' + link!.id && body.includes(comment(context))))
        return row
      })
      evidence(context, 'comment', row)
      await page.shot(join(context.folder, 'guest-comment.png'))
      context.evidencePage = undefined
    }),
    step('See the guest comment in the owner’s document and revoke its link', async (context) => {
      const { pair } = context
      const { page } = pair
      const { link } = states.get(context)!
      if (!(await wordsIn(page, 'body')).includes(comment(context))) await page.clickOn('button.te-threads-button')
      await see(page, 'body', comment(context))
      await page.shot(join(context.folder, 'owner-comment.png'))
      await page.press('button', 'Share')
      const button = '[aria-label=' + JSON.stringify("Revoke " + guestName(context) + "'s link") + ']'
      let point: { x: number; y: number } | null = null
      await page.until('the guest row in Share', 10_000, async () => (point =
        await page.centre('[data-slot="popover-content"] [class~="group/row"] span', guestName(context))))
      await page.hover(point!)
      await page.clickOn(button)
      await page.until('this link revoked on box', 15_000, async () => (await links(context)).some((row) => row.id === link!.id && row.revokedAt))
    }),
    step('end: the open guest page stops answering and LifeOS clears the share', async (context) => {
      const { pair, folder } = context
      const { visit, link, source } = states.get(context)!
      context.evidencePage = visit!.page
      let row: GuestLinkRow | undefined
      let doc: { shared: boolean } | undefined
      await visit!.page.until('LifeOS to clear the share and the guest socket to close', 12_000, async () => {
        row = (await links(context)).find(({ id }) => id === link!.id)
        doc = await pair.sandbox!.query('docs:get', { id: source.id })
        return row?.revokedAt && row.open === 0 && doc?.shared === false
      })
      const liveEnded = await see(visit!.page, 'body', GONE).then(() => true, () => false)
      pair.abort.signal.throwIfAborted()
      if (!liveEnded) {
        await visit!.page.shot(join(folder, 'guest-still-open.png'))
        await visit!.page.reload()
        await see(visit!.page, 'body', GONE)
      }
      await visit!.page.shot(join(folder, 'guest-revoked.png'))
      evidence(context, 'revoked', { link: row, shared: doc!.shared, liveEnded })
      if (!liveEnded) throw new Error('The open comment page still showed the document after the link and socket closed. Reload was refused.')
      context.evidencePage = undefined
      await visit!.stop()
    })
  ]
})
