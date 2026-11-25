import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { editShape } from './lib/edit'
import { closeTab, openRow, unzip } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'TempCode proof Escape.pptx'
const TITLE = 'Fall tryout dates'

export default journey({
  id: 'J74',
  title: 'Escape keeps a slide’s words',
  tier: 1,
  shapes: ['A', 'B1'],
  steps: [
    step('Open the deck from its library', async (context) => {
      copyFileSync(join(context.pair.repo, 'src/main/server/work/slides/fixtures/steps-talk.pptx'), fileAt(context, NAME))
      await showPlace(context)
      await openRow(context.pair.page, NAME)
    }),
    step('Type a new first slide title, press Escape, and close by its ×', async ({ pair }) => {
      await editShape(pair.page, '[data-shape][aria-label$=": Spring season"]')
      await pair.page.key('Control+a')
      await pair.page.typeKeys(TITLE)
      // Before the 2 s pause that keeps a box's words on its own: only Escape leaves the box.
      await pair.page.key('Escape')
      await pair.page.until('the typing box to be left', 5000, () =>
        pair.page.eval(`document.querySelector('[data-slide-typing]')?.getAttribute('data-phase') !== 'typing'`))
      await closeTab(pair.page, NAME)
    }),
    step('end: the holder’s slide XML has the title typed before Escape', async (context) => {
      await context.pair.page.until('the typed title in the holder’s first slide', 20_000, () => {
        const xml = unzip(fileAt(context, NAME), 'ppt/slides/slide1.xml')
        return [...xml.matchAll(/<p:sp[ >][\s\S]*?<\/p:sp>/g)].some(([shape]) =>
          /<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(shape) &&
          [...shape.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((part) => part[1]).join('') === TITLE)
      })
      await context.pair.page.until('the deck tab to close', 5000, () => context.pair.page.tabClosed(NAME))
    })
  ]
})
