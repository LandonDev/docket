import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { focusDocument } from './lib/edit'
import { closeTab, holds, openRow, unzip } from './lib/files'
import { fileAt, selectFolderTab, showPlace } from './lib/place'
import { pdfFacts, previewFormat } from './lib/preview'
import { letterPaper, printViewer } from './lib/print'
import { journey, step, type Context } from './lib/record'
import { words } from './lib/shape'
import type { Window } from './lib/window'

const FIXTURES = [
  { kind: 'document', name: 'Letter practice.tcdoc', source: 'resources/work-files/blank/blank.tcdoc', pages: 1 },
  { kind: 'sheet', name: 'Letter practice.xlsx', source: 'src/main/server/work/sheets/harness/corpus/print/chart-print.xlsx', pages: 1 },
  { kind: 'deck', name: 'Letter practice.pptx', source: 'src/main/server/work/slides/fixtures/steps-talk.pptx', pages: 6 }
] as const

async function setDeckLetter(page: Window): Promise<void> {
  const layout = 'button[aria-label^="Layout:"]'
  await page.until('the deck’s page settings', 20_000, async () =>
    await page.centre(layout) || await page.centre('[data-preview] button', 'Page'))
  if (!await page.centre(layout)) await page.clickOn('[data-preview] button', 'Page')
  await page.clickOn(layout, 'Layout: Slides')
  await page.clickOn('[role="menuitemcheckbox"], [role="menuitem"]', 'Notes pages')
  await page.until('the deck’s paper control', 15_000, () => page.centre('button[aria-label^="Paper:"]'))
  if (!await page.centre('button', 'Paper: Letter')) {
    await page.clickOn('button[aria-label^="Paper:"]')
    await page.clickOn('[role="menuitemcheckbox"], [role="menuitem"]', 'Letter')
  }
  const settings = await page.centre('[data-preview] button[aria-expanded="true"]', 'Page')
  if (settings) await page.click(settings)
}

async function print(context: Context, fixture: typeof FIXTURES[number]): Promise<void> {
  const { page, root } = context.pair
  const viewer = join(root, 'print-viewer.log')
  const handedOff = () => existsSync(viewer) ? readFileSync(viewer, 'utf8').trim().split('\n') : []
  const before = handedOff().length
  const errorsStart = context.pair.hostErrors.length
  let evidence: object = {}
  try {
    await selectFolderTab(context)
    await openRow(page, fixture.name)
    if (fixture.kind === 'document') {
      await focusDocument(page)
      await page.typeKeys('Practice starts at noon')
      await page.until('the document text on box', 20_000, () => holds(fileAt(context, fixture.name), 'Practice starts at noon'))
    }
    if (fixture.kind === 'sheet' && !/<pageSetup\b[^>]*\bpaperSize="1"/.test(unzip(fileAt(context, fixture.name), 'xl/worksheets/sheet1.xml'))) {
      throw new Error('The print fixture does not name Letter paper')
    }
    if (fixture.kind === 'deck') {
      await page.clickOn('[data-slides-strip] [aria-selected="true"]')
    }
    await page.until('the active editor to answer Print', 20_000,
      () => page.eval('!!document.querySelector("[data-files-file] [data-editor-answers~=print]")'))
    if (!await page.eval<boolean>("window.api.debug.menuClick('print')")) throw new Error('The File menu did not offer Print…')
    await page.until('the Print view', 20_000, () => page.eval('!!document.querySelector("[data-preview=print]")'))
    await previewFormat(page, 'print', 'Print')
    if (fixture.kind === 'deck') await setDeckLetter(page)
    await previewFormat(page, 'print', 'Print')
    const paper = await page.eval<string>(`document.querySelector('[aria-label^="Paper:"]')?.getAttribute('aria-label') ?? ''`)
    const count = await page.eval<string>(`document.querySelector('[data-preview-count]')?.textContent.trim() ?? ''`)
    const ratio = await page.eval<number>(`(() => {
      const r = document.querySelector('[data-preview=print] [data-paged-page="1"]')?.getBoundingClientRect();
      return r?.width && r.height ? Math.min(r.width, r.height) / Math.max(r.width, r.height) : 0;
    })()`)
    evidence = { paper, count, ratio }
    await page.shot(join(context.folder, fixture.kind + '-preview.png'))
    await page.press('button', 'Print…')
    await page.until('Electron to hand the PDF to xdg-open', 30_000, () => handedOff().length > before)
    const bytes = readFileSync(handedOff()[before]!)
    writeFileSync(join(context.folder, fixture.kind + '.pdf'), bytes)
    const facts = await pdfFacts(bytes)
    evidence = { paper, count, ratio, ...facts }
    if (!count.endsWith(' of ' + fixture.pages) || Math.abs(ratio - 612 / 792) > 0.015 || facts.pages.length !== fixture.pages || !letterPaper(facts.pages)) {
      throw new Error(`Expected ${fixture.pages} Letter pages. Preview said “${count}”; Electron sent ${JSON.stringify(facts.pages)}`)
    }
    await page.clickOn('[data-preview] button', 'Edit')
    await closeTab(page, fixture.name)
    await page.until('the printed file tab to close', 12_000, () => page.tabClosed(fixture.name))
  } catch (error) {
    evidence = { ...evidence, error: words(error), toasts: await page.toasts(), saveLine: await page.saveLine(), hostErrors: context.pair.hostErrors.slice(errorsStart) }
    await page.shot(join(context.folder, fixture.kind + '.png'))
    await page.dismissPopups()
  } finally {
    writeFileSync(join(context.folder, fixture.kind + '.json'), JSON.stringify(evidence, null, 2))
  }
}

export default journey({
  id: 'J26',
  title: 'Print a document, workbook and deck on Letter through Electron',
  tier: 1,
  shapes: ['A'],
  steps: [
    step('Put three dummy files in the folder and stand in for the print viewer', async (context) => {
      for (const fixture of FIXTURES) copyFileSync(join(context.pair.repo, fixture.source), fileAt(context, fixture.name))
      printViewer(join(context.pair.root, 'bin'))
      await showPlace(context)
    }),
    ...FIXTURES.map((fixture) => step(`Print the ${fixture.kind} from its editor`, (context) => print(context, fixture))),
    step('end: every preview and Electron print has the expected Letter pages', ({ folder }) => {
      const failures = FIXTURES.flatMap(({ kind }) => {
        const { error } = JSON.parse(readFileSync(join(folder, kind + '.json'), 'utf8')) as { error?: string }
        return error ? [`${kind}: ${error}`] : []
      })
      if (failures.length) throw new Error(failures.join(' | '))
    })
  ]
})
