import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { holds, openRow, unzip } from './lib/files'
import { journey, step } from './lib/record'
import type { Window } from './lib/window'

const TITLE = 'Practice schedule'
const BODY = 'Practice starts at noon.'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const FORMATS = [
  ['docx', 'Word', '[data-paged-page] canvas'],
  ['odt', 'OpenDocument', '[data-paged-page] canvas'],
  ['rtf', 'Rich Text', '[data-paged-page] canvas'],
  ['md', 'Markdown', '[data-preview-text]'],
  ['html', 'Web page', 'iframe[srcdoc]'],
  ['print', 'Print', '[data-paged-page] canvas'],
  ['pdf', 'PDF', '[data-paged-page] canvas']
] as const

async function preview(page: Window, [id, label, drawn]: typeof FORMATS[number]): Promise<void> {
  const format = `[data-preview="${id}"]`
  const selector = `${format} ${drawn}`
  if (!(await page.eval(`!!document.querySelector(${JSON.stringify(format)})`))) {
    if (await page.centre('[data-preview-format] [role="tab"]', label)) {
      await page.clickOn('[data-preview-format] [role="tab"]', label)
    } else {
      await page.clickOn('[data-preview-format] button[aria-label^="Format:"]')
      await page.clickOn(`[role="menuitemcheckbox"][data-menu-row="${id}"]`)
    }
  }
  await page.until(`${label} to draw`, 60_000, () => page.eval(`(() => {
    const frame = document.querySelector(${JSON.stringify(format)});
    const error = frame?.querySelector('[data-preview-failed], [data-paged-page-failed]');
    if (error) throw new Error(error.innerText);
    const picture = frame && document.querySelector(${JSON.stringify(selector)});
    return !!picture?.getBoundingClientRect().width;
  })()`))
}

export function wordBodyLayout(styles: string): { font: boolean; spacing: boolean } {
  // A heading's own style cannot supply the default font and spacing of the body.
  const defaults = styles.match(/<w:docDefaults\b[\s\S]*?<\/w:docDefaults>/)?.[0] ?? ''
  const normal = styles.match(/<w:style\b[^>]*\bw:styleId="Normal"[^>]*>[\s\S]*?<\/w:style>/)?.[0] ?? ''
  const bodyStyle = defaults + normal
  return {
    font: /<w:rFonts\b[^>]*\bw:(?:ascii|hAnsi)="[^"]+"/.test(bodyStyle),
    spacing: /<w:spacing\b[^>]*\bw:(?:after|before)="[1-9]\d*"/.test(bodyStyle)
  }
}

export default journey({
  id: 'J05',
  title: 'Make a document, preview it and export it',
  tier: 1,
  shapes: ['A'],
  steps: [
    step('New document in the workspace folder', async ({ pair, workspace }) => {
      const page = pair.page
      await page.clickOn('button, a, [role="link"], [role="treeitem"], div', workspace.name)
      await page.clickOn('button, a, [role="link"], div', 'Files')
      await page.press('button', 'New')
      await page.press('menuitem', 'Document')
      await page.until('the new document name field', 20_000, () => page.eval('document.activeElement?.matches("[data-files-row] input")'))
      await page.typeKeys(workspace.name)
      await page.key('Enter')
      await openRow(page, workspace.name + '.tcdoc')
    }),
    step('Type a heading and two paragraphs', async ({ pair, workspace }) => {
      const page = pair.page
      const editor = '[data-doc-scroller] [contenteditable="true"]'
      await page.until('the editor to take focus', 30_000, async () => {
        const at = await page.centre(editor)
        if (!at) return false
        await page.click(at)
        return page.eval(`!!document.activeElement?.closest(${JSON.stringify(editor)})`)
      })
      await page.typeKeys(TITLE)
      await page.clickOn('[aria-label="Paragraph style"]')
      await page.clickOn('[role="menuitemradio"]', 'Heading 1')
      await page.until('the heading and its caret', 10_000, () => page.eval(`(() => {
        const heading = document.querySelector('${editor} h1');
        return heading?.textContent === ${JSON.stringify(TITLE)} && heading.contains(getSelection()?.anchorNode);
      })()`))
      await page.typeKeys('\n' + BODY + '\nBring a notebook.')
      const file = join(workspace.path, workspace.name + '.tcdoc')
      await page.until('the heading and text to save on box', 30_000, () => holds(file, '# ' + TITLE) && holds(file, BODY))
    }),
    step('Open Preview', async ({ pair }) => {
      await pair.page.press('button', 'Preview')
      await pair.page.until('Preview to open', 20_000, () => pair.page.eval('!!document.querySelector("[data-preview]")'))
    }),
    ...FORMATS.map((format) => step(`Preview ${format[1]}`, ({ pair }) => preview(pair.page, format))),
    step('Export PDF', async ({ pair, folder }) => {
      await pair.page.catchExports()
      await pair.page.press('button', 'Export')
      const pdf = await pair.page.exported('application/pdf')
      writeFileSync(join(folder, 'export.pdf'), pdf)
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('The exported file has no PDF header')
    }),
    step('Export Word', async ({ pair, folder }) => {
      await preview(pair.page, FORMATS[0])
      await pair.page.catchExports()
      await pair.page.press('button', 'Export')
      writeFileSync(join(folder, 'export.docx'), await pair.page.exported(DOCX))
    }),
    step('end: Word keeps the heading, font and paragraph spacing', ({ folder }) => {
      const file = join(folder, 'export.docx')
      if (!holds(file, TITLE) || !holds(file, BODY)) throw new Error('The Word export lost the heading or text')
      const document = unzip(file, 'word/document.xml')
      const heading = [...document.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].some(([line]) =>
        line.includes('w:val="Heading1"') && line.replace(/<[^>]+>/g, '').includes(TITLE))
      if (!heading) throw new Error('The Word export lost the heading style')
      const { font, spacing } = wordBodyLayout(unzip(file, 'word/styles.xml'))
      if (!font || !spacing) throw new Error(`word/styles.xml: default font ${font ? 'present' : 'missing'}, paragraph spacing ${spacing ? 'present' : 'missing'}`)
    })
  ]
})
