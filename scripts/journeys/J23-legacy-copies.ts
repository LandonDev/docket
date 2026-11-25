import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { editShape, focusDocument } from './lib/edit'
import { closeSelectedFile, holds, openRow } from './lib/files'
import { fixtureTool } from './lib/fixtures'
import { fileAt, goPlace, holderFolder, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { a1Point, shownA1 } from './lib/sheet'
import { words } from './lib/shape'

const KINDS = ['xls', 'csv', 'ppt', 'doc'] as const
type Kind = typeof KINDS[number]
const STEM = 'Practice register'
const EDIT = 'Updated practice count'
const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

async function saveWordCopy(context: Context, stem: string, replace = false): Promise<void> {
  const { page } = context.pair
  const dialog = '[data-save-as]'
  await page.clickOn('[data-canvas-bar] button', 'Save As…')
  await page.clickOn('#save-as-name')
  await page.key('Control+a')
  await page.typeKeys(stem)
  // The sheet opens in the original's own folder, where the copy goes; a build that opens on the places is walked there.
  const place = context.shape === 'A' ? context.workspace.name : 'General'
  const onPlaces = !replace && await page.centre(dialog + ' [role="option"]', place)
  if (onPlaces) {
    await page.click(onPlaces)
    if (context.shape === 'B1') await page.clickOn(dialog + ' [role="option"]', context.workspace.name)
  }
  await page.clickOn(dialog + ' [role="checkbox"]')
  await page.clickOn(dialog + ' button', 'Save')
  if (replace) await page.clickOn('[role="alertdialog"] button, [role="dialog"] button', 'Replace')
  await page.until('the Word Save As dialog to close', 25_000, () => page.eval('!document.querySelector("[data-save-as]")'))
}

async function visit(context: Context, kind: Kind): Promise<void> {
  const { page } = context.pair
  const name = STEM + '.' + kind
  const original = fileAt(context, name)
  const before = hash(original)
  const copyFolder = kind === 'ppt' ? context.workspace.path : holderFolder(context)
  const entries = readdirSync(copyFolder)
  const errorsStart = context.pair.hostErrors.length
  const details: { before: string; after?: string; line?: string; copy?: string; error?: string } = { before }
  try {
    await goPlace(context)
    await openRow(page, name)
    const sheet = kind === 'xls' || kind === 'csv'
    const pane = sheet ? '[data-canvas-pane][data-kind="sheet"]' : kind === 'ppt' ? '[data-canvas-pane][data-kind="slides"]' : '[data-canvas-pane][data-kind="document"]'
    const lineSelector = '[data-sheet-import], [data-slide-notice], [data-canvas-state], [data-files-save-line]'
    await page.until('the imported ' + kind + ' editor', 55_000, () => page.centre(pane))
    if (sheet) await page.until('the imported grid', 45_000, () => a1Point(page))
    if (kind === 'ppt') await page.until('the import notice', 45_000, () => page.eval('!!document.querySelector("[data-slide-notice]")'))
    details.line = await page.eval(`[...document.querySelectorAll(${JSON.stringify(lineSelector)})].map((x) => x.innerText).join(' / ')`)
    if (kind === 'xls' && !/Excel copy/i.test(details.line) || kind === 'ppt' && !/read only/i.test(details.line)) {
      throw new Error(`The .${kind} import did not state how the original and copy stand`)
    }
    const action = await page.centre('button', 'Make a copy to edit')
    if (action) await page.click(action)
    else if (sheet) {
      const printed = await page.centre('button', 'Save as Excel')
      if (printed) await page.click(printed)
      else {
        if (!await page.eval<boolean>("window.api.debug.menuClick('export')")) throw new Error('The sheet offers no way to make an Excel copy')
        const { previewFormat } = await import('./lib/preview')
        await previewFormat(page, 'xlsx', 'Excel')
        await page.catchExports()
        await page.press('button', kind === 'xls' ? 'Save a copy' : 'Export')
        const bytes = await page.exported('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        // The download is captured by the harness. Put that same copy where Files can open it.
        writeFileSync(fileAt(context, STEM + ' ' + kind + ' copy.xlsx'), bytes)
        await page.clickOn('[data-preview] button', 'Edit')
      }
    } else {
      await saveWordCopy(context, STEM + ' Word copy')
    }
    const extension = sheet ? '.xlsx' : kind === 'ppt' ? '.pptx' : '.docx'
    let copy = ''
    await page.until('an editable copy on the holder', 20_000, () => (
      copy = readdirSync(copyFolder).find((file) => file.endsWith(extension) && !entries.includes(file)) ?? ''
    ))
    details.copy = copy
    if (kind === 'ppt') {
      await page.until('the copy open in the original seat', 15_000, () => page.centre('[data-files-tab][aria-selected="true"]', copy))
    } else {
      await goPlace(context)
      await openRow(page, copy)
    }
    if (sheet) {
      await page.until('the copy’s selected tab and grid', 40_000, async () =>
        await page.centre('[data-files-tab][aria-selected="true"]', copy) && await a1Point(page) && await shownA1(page) != null)
      await page.click((await a1Point(page))!)
    } else if (kind === 'ppt') {
      await editShape(page, '[data-shape][aria-label$=": Spring season"]')
      await page.key('Control+a')
    } else {
      await focusDocument(page)
    }
    await page.typeKeys(EDIT)
    if (sheet) {
      await page.key('Enter')
      await page.until('the edit in the copy’s A1', 10_000, async () => await shownA1(page) === EDIT)
    }
    if (kind === 'doc') {
      // A Word copy from Teams asks how to save only on its first Save to Teams, never as he types: the edit keeps to
      // the explicit Save As path.
      // The editor holds a Word file's live text in a TempCode document. Save the changed copy as Word.
      await saveWordCopy(context, copy.slice(0, -'.docx'.length), true)
    }
    await page.until('the edit in the copy on its holder', 22_000, () => holds(join(copyFolder, copy), EDIT))
    await closeSelectedFile(page)
  } catch (error) {
    details.error = words(error)
    Object.assign(details, { toasts: await page.toasts(), saveLine: await page.saveLine(), hostErrors: context.pair.hostErrors.slice(errorsStart) })
    await page.shot(join(context.folder, kind + '.png'))
    await page.dismissPopups()
  } finally {
    details.after = hash(original)
    writeFileSync(join(context.folder, kind + '.json'), JSON.stringify(details, null, 2))
  }
}

export default journey({
  id: 'J23',
  title: 'Make editable copies of legacy files while keeping the originals',
  tier: 1,
  shapes: ['A', 'B1'],
  steps: [
    step('Prepare .xls, .csv, .ppt and .doc files', async (context) => {
      const { repo } = context.pair
      copyFileSync(join(repo, 'src/main/server/work/sheets/harness/corpus/formats-in/ledger.xls'), fileAt(context, STEM + '.xls'))
      writeFileSync(fileAt(context, STEM + '.csv'), 'Name,Count\nBlue,5\nGreen,9\n')
      const profile = '-env:UserInstallation=' + new URL('file://' + join(context.folder, 'office')).href
      for (const [kind, fixture, filter] of [
        ['ppt', 'src/main/server/work/slides/fixtures/steps-talk.pptx', 'ppt:MS PowerPoint 97'],
        ['doc', 'resources/work-files/blank/blank.docx', 'doc:MS Word 97']
      ]) {
        const input = join(context.folder, STEM + (kind === 'ppt' ? '.pptx' : '.docx'))
        copyFileSync(join(repo, fixture!), input)
        fixtureTool(context.folder, 'libreoffice', [profile, '--headless', '--convert-to', filter!, '--outdir', holderFolder(context), input])
        if (!existsSync(fileAt(context, STEM + '.' + kind))) throw new Error('LibreOffice did not produce .' + kind)
      }
      await showPlace(context)
    }),
    ...KINDS.map((kind) => step(`Open and edit a copy of the .${kind} file`, (context) => visit(context, kind))),
    step('end: every copy held the edit and all four originals keep their hashes', ({ folder }) => {
      const failures = KINDS.flatMap((kind) => {
        const details = JSON.parse(readFileSync(join(folder, kind + '.json'), 'utf8'))
        return [details.error && `.${kind}: ${details.error}`, details.before !== details.after && `.${kind} original changed`].filter(Boolean)
      })
      if (failures.length) throw new Error(failures.join(' | '))
    })
  ]
})
