import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ShowLive } from '../../src/shared/contract-work-slides'
import { phone } from './lib/browser'
import { openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { Window } from './lib/window'
import { revealView } from './lib/more'

const NAME = 'Practice show.pptx'
const visits = new WeakMap<Context, { show: Window; phone: Window; id: string }>()

async function states({ pair }: Context): Promise<ShowLive[]> {
  return (await pair.rpc<{ shows: ShowLive[] }>(pair.box, 'work.slides.show.state')).shows
}

async function clicker(context: Context, kind: 'owner' | 'read') {
  const { pair, folder, workspace } = context
  const visit = await phone(pair, join(folder, kind + '-profile'), kind)
  const { page } = visit
  context.evidencePage = page
  await page.clickOn('nav [data-rail-path] button', workspace.name)
  await revealView(page, 'button, a, [role="link"]', 'Files')
  await page.clickOn('button, a, [role="link"]', 'Files')
  const row = await page.centre('[data-files-sidebar] button', workspace.name)
  if (row) await page.click(row)
  const tab = await pair.page.eval<string>(`document.querySelector('[data-files-tab][data-tab-kind="file"][aria-selected="true"]')?.getAttribute('data-files-tab')`)
  if (!tab) throw new Error('The show has no open Files tab')
  await page.clickOn('[data-files-tab=' + JSON.stringify(tab) + ']')
  await page.resize(390)
  await page.until(kind + ' clicker', 20_000, () => page.centre('[data-clicker]'))
  context.evidencePage = undefined
  return visit
}

async function press(context: Context, name: string, slide: number, blank = false): Promise<void> {
  const visit = visits.get(context)!
  const previous = (await states(context)).find((show) => show.showId === visit.id)
  if (!previous) throw new Error('The host has no running show')
  await visit.phone.clickOn('[data-clicker] button', name)
  await visit.phone.until('the host to publish slide ' + slide, 15_000, async () =>
    (await states(context)).some((show) => show.showId === visit.id && show.rev > previous.rev && show.slide === slide && show.blank === blank))
  await visit.show.until('the audience page to show slide ' + slide, 15_000, () => visit.show.eval(`(() => {
    const show = document.querySelector('[data-show="audience"]');
    const place = show?.querySelector('[data-show-place]')?.textContent?.trim();
    const picture = show?.querySelector('[data-show-picture]');
    return !!show && place?.startsWith(${JSON.stringify(slide + '/')}) && Boolean(picture) === ${!blank};
  })()`))
}

export default journey({
  id: 'J27',
  title: 'Drive a separate slideshow from a phone and watch with a read key',
  tier: 1,
  shapes: ['A', 'U'],
  steps: [
    step('Present the deck and find the audience page target', async (context) => {
      const { pair } = context
      copyFileSync(join(pair.repo, 'src/main/server/work/slides/fixtures/steps-talk.pptx'), fileAt(context, NAME))
      await showPlace(context)
      await openRow(pair.page, NAME)
      await pair.page.press('button', 'Present')
      const start = await pair.page.centre('[role^="menuitem"]', 'From Beginning')
      if (start) await pair.page.click(start)
      const show = await Window.attach(pair.win.debug!, pair.abort.signal, (url) => url === 'about:blank')
      pair.later(async () => {
        await show.closePage().catch(() => undefined)
        show.close()
      })
      await show.until('the separate audience page', 15_000, () => show.eval('!!document.querySelector(\'[data-show="audience"]\')'))
      const itemId = await pair.page.eval<string>(`document.querySelector('[data-files-file] [data-canvas-pane]')?.getAttribute('data-item-id') ?? ''`)
      let state: ShowLive | undefined
      await pair.page.until('the host’s first slide', 20_000, async () => (state = (await states(context)).find((live) => live.slide === 1 && (live.itemId === itemId || live.title.startsWith('Practice show')))))
      const owner = await clicker(context, 'owner')
      visits.set(context, { id: state!.showId, phone: owner.page, show })
    }),
    step('Watch the slide from /ui using a read key', async (context) => {
      const { page, stop } = await clicker(context, 'read')
      context.evidencePage = page
      await page.until('the watch-only line and slide one', 15_000, () => page.eval(`(() => {
        const root = document.querySelector('[data-clicker]');
        return root?.textContent.includes('This device can only watch the show.') &&
          root.querySelector('[data-clicker-place]')?.textContent.trim().startsWith('1/') &&
          !root.querySelector('button, [role="button"]');
      })()`))
      await page.shot(join(context.folder, 'read-clicker.png'))
      context.evidencePage = undefined
      await stop()
    }),
    step('Next goes to slide two', async (context) => {
      const { phone } = visits.get(context)!
      const label = await phone.eval<string>(`document.querySelector('[data-clicker-next]')?.getAttribute('aria-label')`)
      await press(context, label, 2)
    }),
    step('Previous goes back to slide one', (context) => press(context, 'Previous', 1)),
    step('Blank blacks the audience page', (context) => press(context, 'Blank', 1, true)),
    step('end: End closes the audience page and the host forgets the show', async (context) => {
      const { phone, id } = visits.get(context)!
      await phone.clickOn('[data-clicker] button', 'End')
      await phone.until('the host to forget the show', 15_000, async () => !(await states(context)).some((show) => show.showId === id))
      await phone.until('the audience page target to close', 15_000, async () => {
        const targets = await (await fetch('http://127.0.0.1:' + context.pair.win.debug + '/json/list')).json() as { type: string; url: string }[]
        return !targets.some(({ type, url }) => type === 'page' && url === 'about:blank')
      })
    })
  ]
})
