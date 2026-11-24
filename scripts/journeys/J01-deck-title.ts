import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { editShape } from './lib/edit'
import { closeTab, openRow, unzip } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const NAME = 'Season briefing.pptx'
const TITLE = 'Spring practice dates'

export default journey({
  id: 'J01',
  title: 'Change a slide title and close the deck',
  tier: 1,
  shapes: ['B1', 'B2'],
  steps: [
    step('Open the deck from its library', async (context) => {
      copyFileSync(join(context.pair.repo, 'src/main/server/work/slides/fixtures/steps-talk.pptx'), fileAt(context, NAME))
      await showPlace(context)
      await openRow(context.pair.page, NAME)
    }),
    step('Replace the first slide title and close by its ×', async ({ pair }) => {
      await editShape(pair.page, '[data-shape][aria-label$=": Spring season"]')
      await pair.page.key('Control+a')
      await pair.page.typeKeys(TITLE)
      await closeTab(pair.page, NAME)
    }),
    step('end: the holder’s slide XML has the new title', async (context) => {
      await context.pair.page.until('the new title in the holder’s first slide', 20_000, () => {
        const xml = unzip(fileAt(context, NAME), 'ppt/slides/slide1.xml')
        return [...xml.matchAll(/<p:sp[ >][\s\S]*?<\/p:sp>/g)].some(([shape]) =>
          /<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(shape) &&
          [...shape.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((part) => part[1]).join('') === TITLE)
      })
      await context.pair.page.until('the deck tab to close', 5000, () => context.pair.page.tabClosed(NAME))
    })
  ]
})
