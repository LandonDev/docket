import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEXT_EDITOR } from './lib/edit'
import { closeTab, openRow, rowAt } from './lib/files'
import { fileAt, goPlace, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { explainsMissingContent, filesReading, FILES_FIELD, typeQuery, workReading, WORK_FIELD, WORK_HIT } from './lib/search'
import { words } from './lib/shape'

const nameOf = ({ workspace }: Context): string => `Lantern ${workspace.name}.txt`
const contentOf = ({ workspace }: Context): string => 'quartz' + workspace.name.replace(/\W/g, '').toLowerCase()

type SearchResult = { surface: 'Files' | 'Work'; query: 'name' | 'content'; found: boolean; opened: boolean; openedAsTyped?: boolean; lines: string[]; error?: string }

async function checkOpened(context: Context): Promise<void> {
  const { page } = context.pair
  const name = nameOf(context)
  await page.until('the search hit open in Files with its words', 12_000, async () =>
    !await page.tabClosed(name) && await page.eval(`document.querySelector(${JSON.stringify(TEXT_EDITOR)})?.textContent?.trim() === ${JSON.stringify(contentOf(context))}`))
  await closeTab(page, name)
  await page.until('the result tab to close', 5000, () => page.tabClosed(name))
}

async function search(context: Context, surface: SearchResult['surface'], by: SearchResult['query']): Promise<void> {
  const { page } = context.pair
  const query = by === 'name' ? 'Lantern ' + context.workspace.name : contentOf(context)
  const name = nameOf(context)
  const result: SearchResult = { surface, query: by, found: false, opened: false, lines: [] }
  const label = surface.toLowerCase() + '-' + by
  const log = (phase: string, reading: Awaited<ReturnType<typeof filesReading>>): void =>
    appendFileSync(join(context.folder, 'search.jsonl'), JSON.stringify({ at: new Date().toISOString(), surface, by, query, phase, ...reading }) + '\n')
  try {
    if (surface === 'Files') {
      await goPlace(context)
      if (!await page.centre(FILES_FIELD)) await page.clickOn('[data-files-bar] button', 'Search')
      await typeQuery(page, FILES_FIELD, query)
      const asTyped = !!await rowAt(page, name)
      log('as typed', await filesReading(page))
      await page.key('Enter')
      await page.until('Files search results', 25_000, () => page.eval(`(() => {
        const panel = document.querySelector('[data-files-page]');
        return panel?.querySelector('button[aria-label="Search"], [data-files-search]') &&
          panel.querySelector('[data-files-filters]') && !panel.querySelector('[aria-label="Loading"][aria-busy="true"]');
      })()`))
      const reading = await filesReading(page)
      log('every place', reading)
      result.lines = reading.lines
      result.found = !!await rowAt(page, name)
      await page.shot(join(context.folder, label + '.png'))
      if (result.found) {
        await openRow(page, name)
        await checkOpened(context)
        result.opened = true
      } else if (asTyped) {
        if (await page.centre(FILES_FIELD)) await page.key('Escape')
        await goPlace(context)
        await page.clickOn('[data-files-bar] button', 'Search')
        await typeQuery(page, FILES_FIELD, query)
        await openRow(page, name)
        await checkOpened(context)
        result.openedAsTyped = true
      }
    } else {
      await page.key('Control+Shift+k')
      await typeQuery(page, WORK_FIELD, query)
      const settled = () => page.until('Work search to finish', 25_000, () => page.eval(`(() => {
        const panel = document.querySelector('[data-work-search]');
        return panel?.querySelector('[data-work-search-told]') && !panel.querySelector('[data-out="true"]') &&
          !!panel.querySelector('[data-work-search-list], [data-work-search-causes]');
      })()`))
      await settled()
      const quick = await workReading(page)
      log('all types', quick)
      let reading = quick
      const all = await page.centre('[data-work-search] [role="option"]', `All files for “${query}”`)
      if (all) {
        await page.click(all)
        await settled()
        reading = await workReading(page)
        log('all files', reading)
      }
      result.lines = [...new Set([...quick.lines, ...reading.lines])]
      const hit = await page.eval<string | null>(`(() => {
        const row = [...document.querySelectorAll(${JSON.stringify(WORK_HIT)})].find((el) =>
          [...el.querySelectorAll('span')].some((span) => span.textContent.trim() === ${JSON.stringify(name)}));
        return row?.dataset.row ?? null;
      })()`)
      await page.shot(join(context.folder, label + '.png'))
      result.found = !!hit
      if (hit) {
        await page.clickOn(`${WORK_HIT}[data-row=${JSON.stringify(hit)}]`)
        await checkOpened(context)
        result.opened = true
      }
    }
  } catch (error) {
    result.error = words(error)
    await page.shot(join(context.folder, label + '-error.png'))
  }
  if (await page.centre(WORK_FIELD)) {
    await page.key('Escape')
    if (await page.centre(WORK_FIELD)) await page.key('Escape')
  }
  if (await page.centre(FILES_FIELD)) await page.key('Escape')
  appendFileSync(join(context.folder, 'search-outcomes.jsonl'), JSON.stringify(result) + '\n')
}

export default journey({
  id: 'J18',
  title: 'Find and open a file by name and content in Files and Work search',
  tier: 1,
  shapes: ['A', 'B1', 'B2'],
  steps: [
    step('Seed a file with a name and a separate word inside', async (context) => {
      writeFileSync(fileAt(context, nameOf(context)), contentOf(context))
      await showPlace(context)
      await context.pair.page.until('the file to be listed', 15_000, () => rowAt(context.pair.page, nameOf(context)))
    }),
    ...(['Files', 'Work'] as const).flatMap((surface) => (['name', 'content'] as const).map((by) =>
      step(`Search ${surface} by ${by} and open the hit`, (context) => search(context, surface, by)))),
    step('end: name hits open and content hits open or their scope is stated', ({ shape, folder }) => {
      const results = readFileSync(join(folder, 'search-outcomes.jsonl'), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as SearchResult)
      const failures = results.flatMap(({ surface, query, found, opened, lines, error }) => {
        const label = `${surface} by ${query}`
        if (error) return [`${label}: ${error}`]
        if (opened) return []
        if (found || query === 'name' || shape === 'A') return [`${label}: no open file (${lines.join(' / ') || 'no search line'})`]
        return explainsMissingContent(lines) ? [] : [`${label}: no hit or line about content scope (${lines.join(' / ') || 'no search line'})`]
      })
      if (failures.length) throw new Error(failures.join(' | '))
    })
  ]
})
