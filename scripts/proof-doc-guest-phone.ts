/**
 * DOC8's hosted guest page at phone and tablet widths. Serve the real Work
 * service and the hosted Vite build, with dummy documents and a local LifeOS.
 *
 *   TEMP_CODE_HOSTED_OUT=<hosted build> DOC8_PLAYWRIGHT_CORE=<playwright-core>
 *   heavy bun scripts/proof-bun.ts scripts/proof-doc-guest-phone.ts
 *
 * DOC8_PHONE_SHOTS may name a different output folder for the pictures.
 *
 * Two documents. The first, one page long, holds the page's own checks (the
 * row, the fonts, the fit, a Bold tap). The second, a Word file three sheets
 * long, holds Pages (docs/agents/work-docs.md "Pages"): an Edit, Comment and
 * View link opens it in Flow under 640px (with no switch in the row) and as
 * sheets from 640px, the sheets fit the screen, a tap types on a sheet, an
 * open writes nothing, and there are as many sheets as the app's own pane
 * draws for the same file.
 *
 * That last number is measured by this script's other half, in an isolated
 * instance of the built tree (out/), which leaves the Word file and its count
 * for the run above to read (DOC8_DESKTOP names the folder; left out, it is
 * beside the pictures):
 *
 *   env -u ELECTRON_RUN_AS_NODE heavy bun scripts/proof-doc-guest-phone.ts --desktop --out <folder>
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { encodeStateAsUpdate, type Doc } from 'yjs'
import { DOCUMENT_FRAGMENT, DOCUMENT_SCHEMA, schemaOf } from 'work-kit/collab'
import { createCollabSigner, generateCollabKeys, readBlocks, TCDOC_STATE, TEMPCODE_COLLAB_AUDIENCE } from 'work-kit/collab-server'
import { DEFAULT_STYLES, defaultSetup } from 'work-kit/editor/page'
import { paraText } from 'work-kit/editor/para'
import { foldOrder, GROUP } from '../node_modules/work-kit/src/format/fold'
import { TEMPCODE_THEME } from 'work-kit/format/theme'
import { emptySidecar, type Block, type Inline } from 'work-kit/formats'
import { readDocx, writeDocx } from 'work-kit/formats/docx'
import { writeImportedTcdoc } from 'work-kit/formats/tcdoc'
import type { WorkCtx } from '../src/main/server/work/modules'
import type { FakeConvex } from '../src/main/server/work/service/fakeConvex'
import type { RunningService } from '../src/main/server/work/service/serve'

const TITLE = 'Spring LAN run of show'
const DOC = 'kdocphoneproof'
const HOST = 'env_box'
const BODY = 'Crew check-in opens at the north doors.'
const BODY_COLOR = '#3173AD'
const BODY_SIZE = 13
const ROLES = ['edit', 'comment', 'view'] as const
const ENGINES = ['webkit', 'chromium'] as const
const VIEWS = [
  { width: 390, height: 844, theme: 'light' },
  { width: 390, height: 844, theme: 'dark' },
  { width: 768, height: 1024, theme: 'light' }
] as const
/** The second document, for Pages: a Word file three sheets long, the same bytes behind the guest's links and in the app's own pane. */
const PAGES_TITLE = 'Fall LAN run of show'
const PAGES_DOC = 'kdocphonepages'
const TAP_LINE = 'Matches start on the hour, and the bracket moves on without a team that is not seated.'
const LAST_LINE = 'Round 28:'
const TYPED = 'Zq7'
/** Pages from this width, Flow under it (src/hosted/guest/opening.ts `PAGES_FROM`). */
const PAGES_FROM = 640
const PAGES_VIEWS = [
  { width: 390, height: 844, theme: 'light' },
  { width: 390, height: 844, theme: 'dark' },
  { width: 768, height: 1024, theme: 'light' },
  { width: 768, height: 1024, theme: 'dark' }
] as const
/** DOC8_ONLY=<pattern> runs only the pages whose name matches it ("edit.webkit.390", "^pages.view"): for a second look at one that failed. */
const only = process.env.DOC8_ONLY ? new RegExp(process.env.DOC8_ONLY) : null
const hosted = resolve(process.env.TEMP_CODE_HOSTED_OUT ?? 'out/hosted')
const shots = resolve(process.env.DOC8_PHONE_SHOTS ?? join(import.meta.dir, '../../../../.temp-code/plans/landed/DOC8-phone/shots'))
/** What the app's own pane drew: the Word file it was given and its count of sheets (this script's --desktop half writes both). */
const desktopDir = resolve(process.env.DOC8_DESKTOP ?? join(dirname(shots), 'desktop'))
const desktopFile = { docx: join(desktopDir, PAGES_TITLE + '.docx'), count: join(desktopDir, 'pages.json') }
interface DesktopCount { sha256: string; pages: number; canvas: number; sheetWidth: number; engine: string; at: string }
const playwrightPath = process.env.DOC8_PLAYWRIGHT_CORE ?? 'playwright-core'
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(homedir(), '.cache', 'ms-playwright')

const row = '[data-slot="format-row"]'
const overflow = '[data-slot="format-more"]'
const menu = '[data-slot="format-menu"]:visible'
const editor = '.bn-editor.ProseMirror'
const tapWords = { webkit: { light: 'Crew', dark: 'opens' }, chromium: { light: 'check-in', dark: 'doors' } } as const
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const safe = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/#k=[\w-]+/g, '#k=[hidden]')

let checks = 0
let failures = 0
function check(what: string, ok: boolean, detail?: unknown): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail === undefined ? '' : ' — ' + safe(typeof detail === 'string' ? detail : JSON.stringify(detail))}`)
}

const run = (text: string, styles: Record<string, string> = {}): Inline => ({ type: 'text', text, styles })
const line = (id: string, text: string, type = 'paragraph', props: Block['props'] = {}): Block => ({
  id, type, props, content: [run(text)], children: []
})
const cell = (text: string) => ({ type: 'tableCell' as const, props: {}, content: [run(text)] })
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** The Pages document as a styled Word file: a title, three headings, a list, a table and 28 paragraphs, with a header and a page number on every sheet. */
async function pagesDocx(): Promise<Uint8Array> {
  const body = line('setup', '')
  body.content = [run('Setup starts at 8:00 AM. '), run('Every station needs power and a wired line', { bold: true } as never), run(' before the first team checks in at 9:30.', { fontFamily: 'Calibri', fontSize: '12', color: '#0F4761' })]
  const blocks: Block[] = [
    line('title', PAGES_TITLE, 'paragraph', { para: paraText({ style: 'Title' }) }),
    line('sub', 'Dummy esports club, Saturday October 17, Ballroom B', 'paragraph', { para: paraText({ style: 'Subtitle' }) }),
    line('before', 'Before doors', 'heading', { level: 1 }),
    body,
    line('rows', 'Forty stations in four rows', 'bulletListItem'),
    line('desk', "Casters' desk on the riser, facing the stage", 'bulletListItem'),
    line('spare', 'Spare headsets in the green room', 'bulletListItem'),
    line('match', 'Match day', 'heading', { level: 1 }),
    line('hour', TAP_LINE),
    {
      id: 'stations', type: 'table', props: {}, children: [],
      content: { type: 'tableContent', columnWidths: [160, 120], headerRows: 1, rows: [{ cells: [cell('Station'), cell('Time')] }, { cells: [cell('Check-in'), cell('9:00 AM')] }, { cells: [cell('Finals'), cell('6:00 PM')] }] }
    } as unknown as Block,
    line('rounds', 'The rounds', 'heading', { level: 1 }),
    ...Array.from({ length: 28 }, (_, i) => line(`fill${i}`, `Round ${i + 1}: the bracket moves on the hour, the casters call the stage match, and the crew resets the stations between maps while the next teams check in at the front table.`))
  ]
  return writeDocx(blocks, {
    ...emptySidecar(),
    document: {
      schema: 1,
      styles: Object.fromEntries(DEFAULT_STYLES.map((style) => [style.name, style])),
      theme: TEMPCODE_THEME,
      setup: { ...defaultSetup(), header: true, footer: true },
      header: { start: [{ text: PAGES_TITLE }], center: [], end: [] },
      footer: { start: [], center: [{ text: 'Page ' }, { field: 'page' }, { text: ' of ' }, { field: 'pages' }], end: [] }
    }
  } as never, { title: PAGES_TITLE })
}

/**
 * The other half (--desktop): the same Word file in the app's own document pane, in an isolated
 * instance of the built tree, on a canvas wide enough for a sheet at true size. It leaves the file
 * and the pane's count of sheets where the phone's run reads them.
 */
async function desktop(): Promise<never> {
  const { Run, sleep } = await import('./e2e-work-lib')
  const job = new Run('doc-guest-phone-desktop')
  const WIDTH = 1760
  try {
    await job.start()
    const thread = await job.thread(null, `E2E-DOC ${PAGES_TITLE}`, { firstMessage: 'Look over the run of show.' })
    const docx = await pagesDocx()
    // Wide before the item first opens: 1760 leaves the canvas about 940px beside the thread, and the width as it opens decides.
    await job.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(1200)
    const imported = await job.call<{ itemId?: string }>('work.formats.import', { sessionId: thread, from: { at: 'bytes', name: `${PAGES_TITLE}.docx`, data: Buffer.from(docx).toString('base64') } }, 300_000)
    job.check('the Word file imports into the canvas', !!imported.itemId)
    await job.show(thread)
    const read = () => job.page<{ sheets: number; sheetWidth: number; canvas: number; fact: string; last: boolean }>(`(() => {
      const scroller = document.querySelector('[data-doc-scroller]')
      const all = [...(scroller?.querySelectorAll('.te-pages-stage .te-page-sheet') ?? [])]
      return { sheets: all.length, sheetWidth: all[0]?.getBoundingClientRect().width ?? 0, canvas: scroller?.clientWidth ?? 0,
        fact: document.querySelector('[data-canvas-bar] [data-doc-page]')?.textContent ?? '', last: (document.querySelector('.bn-editor')?.textContent ?? '').includes(${JSON.stringify(LAST_LINE)}) }
    })()`)
    let seen = { sheets: 0, at: Date.now() }
    // Settled: the same count for two seconds, the last paragraph drawn and the bar saying that count.
    const drew = await job.until('the sheets', 90_000, async () => {
      const now = await read()
      if (now.sheets !== seen.sheets) seen = { sheets: now.sheets, at: Date.now() }
      return now.last && now.sheets > 1 && now.fact === `Page 1 of ${now.sheets}` && Date.now() - seen.at >= 2000
    })
    const pane = await read()
    job.check(`the app's pane draws the file as sheets at true size on a ${pane.canvas}px canvas: ${pane.sheets} sheets, "${pane.fact}"`, drew && Math.abs(pane.sheetWidth - 816) < 1, JSON.stringify(pane))
    for (const scheme of ['dark', 'light'] as const) {
      await job.page(`(document.documentElement.classList.toggle('theme-light', ${scheme === 'light'}), window.dispatchEvent(new CustomEvent('monocode:schemechange', { detail: ${JSON.stringify(scheme)} })))`)
      await sleep(700)
      const { data } = (await job.send('Page.captureScreenshot', { format: 'png', clip: { x: 460, y: 0, width: WIDTH - 460, height: 900, scale: 1 } })) as { data: string }
      writeFileSync(join(job.out, `desktop-pane.${scheme}.png`), Buffer.from(data, 'base64'))
    }
    if (drew) {
      mkdirSync(desktopDir, { recursive: true })
      writeFileSync(desktopFile.docx, docx)
      const count: DesktopCount = { sha256: sha256(docx), pages: pane.sheets, canvas: pane.canvas, sheetWidth: pane.sheetWidth, engine: await job.page<string>('navigator.userAgent'), at: new Date().toISOString() }
      writeFileSync(desktopFile.count, JSON.stringify(count, null, 2) + '\n')
      job.note(`wrote ${desktopFile.count}`)
    }
    return await job.finish()
  } catch (err) {
    return await job.finish(err)
  }
}

async function seed(dir: string, lifeos: FakeConvex): Promise<void> {
  const body = line('check-in', BODY)
  body.content = [run(BODY, { fontFamily: 'Calibri', fontSize: String(BODY_SIZE), color: BODY_COLOR })]
  const blocks: Block[] = [
    line('title', TITLE, 'paragraph', { para: paraText({ style: 'Title' }) }),
    line('morning', 'Morning setup', 'heading', { level: 1 }),
    body,
    line('badges', 'Set out guest badges.', 'bulletListItem'),
    line('signs', 'Put signs by the north doors.', 'bulletListItem'),
    line('afternoon', 'Afternoon handoff', 'heading', { level: 1 }),
    line('room', 'Check each station before the afternoon handoff.'),
    {
      id: 'stations', type: 'table', props: {}, children: [],
      content: {
        type: 'tableContent', columnWidths: [120, 144], headerRows: 1,
        rows: [
          { cells: [cell('Station'), cell('Time')] },
          { cells: [cell('Check-in'), cell('9:00 AM')] },
          { cells: [cell('Handoff'), cell('2:00 PM')] }
        ]
      }
    }
  ]
  const path = join(dir, TITLE + '.tcdoc')
  await writeImportedTcdoc(path, {
    blocks,
    sidecar: {
      ...emptySidecar(),
      document: {
        schema: DOCUMENT_SCHEMA,
        styles: Object.fromEntries(DEFAULT_STYLES.map((style) => [style.name, style])),
        theme: TEMPCODE_THEME,
        setup: defaultSetup(),
        header: { start: [], center: [], end: [] },
        footer: { start: [], center: [], end: [] }
      }
    }
  })

  // Guest links name LifeOS documents. Give LifeOS the same bytes as the dummy file.
  const state = unzipSync(readFileSync(path))[TCDOC_STATE]
  if (!state) throw new Error('the dummy file has no document state')
  lifeos.files.set('phone-fixture', state)
  lifeos.docs.set(DOC, { _id: DOC, sector: 'dummy', seq: 0, title: TITLE, shared: false, markdown: '', plain: '', stateFile: 'phone-fixture' })
}

/** The Pages document behind LifeOS: the very file the app's pane was given when the other half has run, read as the service's own import reads it (formats/importer.ts). */
async function seedPages(dir: string, lifeos: FakeConvex): Promise<DesktopCount | null> {
  let desktop: DesktopCount | null = null
  let docx: Uint8Array
  if (existsSync(desktopFile.docx) && existsSync(desktopFile.count)) {
    docx = new Uint8Array(readFileSync(desktopFile.docx))
    const count = JSON.parse(readFileSync(desktopFile.count, 'utf8')) as DesktopCount
    if (count.sha256 === sha256(docx)) desktop = count
  } else docx = await pagesDocx()
  const imported = readDocx(docx)
  imported.sidecar.source = { name: PAGES_TITLE + '.docx', format: 'docx', importedAt: Date.now() }
  const path = join(dir, PAGES_TITLE + '.tcdoc')
  await writeImportedTcdoc(path, imported, { principal: 'owner' })
  const state = unzipSync(readFileSync(path))[TCDOC_STATE]
  if (!state) throw new Error('the Pages file has no document state')
  lifeos.files.set('phone-pages-fixture', state)
  lifeos.docs.set(PAGES_DOC, { _id: PAGES_DOC, sector: 'dummy', seq: 0, title: PAGES_TITLE, shared: false, markdown: '', plain: '', stateFile: 'phone-pages-fixture' })
  return desktop
}

const groups: Record<string, number> = {
  undo: GROUP.edits, redo: GROUP.edits, style: GROUP.style, font: GROUP.font, size: GROUP.font,
  bold: GROUP.character, italic: GROUP.character, underline: GROUP.character, colour: GROUP.character, highlight: GROUP.character,
  align: GROUP.cell, spacing: GROUP.cell, bulleted: GROUP.cell, numbered: GROUP.cell, checklist: GROUP.cell,
  indentLess: GROUP.cell, indentMore: GROUP.cell, insert: GROUP.insert,
  // A styled document's own two: Page set-up beside Insert, and the zoom after the view switch while sheets are drawn.
  pageSetup: GROUP.insert, zoom: GROUP.insert
}
const always = ['style', 'bold', 'italic']
const foldedLabels: Record<string, string> = {
  font: 'Font', size: 'Font size', colour: 'Text colour', highlight: 'Highlight', spacing: 'Line spacing',
  align: 'Align', bulleted: 'Bulleted list', numbered: 'Numbered list', checklist: 'Check list',
  indentLess: 'Indent less', indentMore: 'Indent more', underline: 'Underline', redo: 'Redo', undo: 'Undo', insert: 'Insert',
  pageSetup: 'Page set-up', zoom: 'Fit width'
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const fontByView = new Map<string, { paragraph: string; size: string; family: string; textSize: string; colour: string }>()

function serverContent(doc: Doc): string[] {
  return readBlocks(doc.getXmlFragment(DOCUMENT_FRAGMENT)).map((block) => block.id + ':' + block.type)
}

function hasBold(serviceDoc: Doc, word: string): boolean {
  return readBlocks(serviceDoc.getXmlFragment(DOCUMENT_FRAGMENT)).some((block) =>
    Array.isArray(block.content) && block.content.some((piece) =>
      piece.type === 'text' && piece.styles.bold === true && piece.text === word
    )
  )
}

async function until(test: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() >= end) return false
    await delay(50)
  }
  return true
}

async function provePage(
  browser: any, engine: (typeof ENGINES)[number], role: (typeof ROLES)[number], view: (typeof VIEWS)[number],
  url: string, direct: Doc
): Promise<void> {
  const { width, height, theme } = view
  const label = `${role}.${engine}.${width}.${theme}`
  if (only && !only.test(label)) return
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 3, colorScheme: theme, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  const errors: string[] = []
  let phase = 'opening'
  const original = encodeStateAsUpdate(direct)
  const originalBlocks = serverContent(direct)
  let savedShot = false
  page.on('console', (message: { type(): string; text(): string }) => { if (message.type() === 'error') errors.push(phase + ' ' + safe(message.text())) })
  page.on('pageerror', (err: Error) => errors.push(phase + ' ' + safe(err)))
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.locator(editor).waitFor({ timeout: 12_000 })
    const loadedBody = await page.waitForFunction(({ selector, body }: { selector: string; body: string }) =>
      [...document.querySelectorAll(selector + ' p')].some((p) => p.textContent === body && p.getClientRects().length > 0),
    { selector: editor, body: BODY }, { timeout: 8000 }).then(() => true, () => false)
    // The editor registers its font faces through a lazy module.
    if (loadedBody) await page.waitForFunction(() => [...document.fonts].some((face) => face.family.replace(/['"]/g, '') === 'Carlito' && face.status === 'loaded'),
      undefined, { timeout: 8000 }).catch(() => {})
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    const measured = await page.evaluate(({ editorSelector, rowSelector, overflowSelector, body, title }: { editorSelector: string; rowSelector: string; overflowSelector: string; body: string; title: string }) => {
      const doc = document.querySelector<HTMLElement>(editorSelector)!
      const paragraph = [...doc.querySelectorAll('p')].find((p) => p.textContent === body)
      const inline = paragraph && (document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode()?.parentElement ?? paragraph)
      const storedColour = paragraph?.querySelector('[data-style-type="color"]')?.getAttribute('data-value')
      const font = paragraph && getComputedStyle(paragraph)
      const textFont = inline && getComputedStyle(inline)
      const bar = document.querySelector<HTMLElement>(rowSelector)
      const rects = (els: HTMLElement[]) => els.filter((el) => el.getClientRects().length).map((el) => {
        const { x, right, width, height } = el.getBoundingClientRect()
        const round = (n: number) => Math.round(n * 10) / 10
        return { name: el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName, x: round(x), right: round(right), width: round(width), height: round(height) }
      })
      const items = bar ? [...bar.querySelectorAll<HTMLElement>('[data-format-item]')].map((el) => ({ id: el.dataset.formatItem!, folded: el.hidden })) : []
      return {
        width: innerWidth, height: innerHeight, scale: devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches,
        lightPage: document.documentElement.classList.contains('theme-light'), title: doc.querySelector('[data-style="Title"]')?.textContent,
        coarse: matchMedia('(pointer: coarse)').matches,
        hostedTitles: [...document.querySelectorAll('header :is(span, h1), main h1')].filter((el) => el.textContent === title).length,
        widgetResize: document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content.includes('interactive-widget=resizes-content') === true,
        keyboardAPI: 'virtualKeyboard' in navigator,
        pageWidth: document.documentElement.scrollWidth, mainWidth: document.querySelector('main')?.clientWidth, mainScroll: document.querySelector('main')?.scrollWidth, edit: doc.isContentEditable,
        bodyPresent: !!paragraph, editorText: paragraph ? undefined : doc.textContent,
        paragraphs: font && textFont ? { paragraph: font.fontFamily, size: font.fontSize, family: textFont.fontFamily, textSize: textFont.fontSize, colour: textFont.color } : null,
        storedColour, checkFont: !!textFont && document.fonts.check(textFont.fontSize + ' Carlito'),
        loadedFont: [...document.fonts].some((face) => face.family.replace(/['"]/g, '') === 'Carlito' && face.status === 'loaded'),
        headings: [...doc.querySelectorAll('h1')].map((h) => h.textContent),
        list: !!doc.querySelector('[data-content-type="bulletListItem"]'), table: !!doc.querySelector('table'),
        bar: bar && { x: bar.getBoundingClientRect().x, right: bar.getBoundingClientRect().right, width: bar.clientWidth, scroll: bar.scrollWidth, over: bar.dataset.over, more: !!bar.querySelector(overflowSelector),
          pad: getComputedStyle(bar).paddingInline, parts: ([...bar.children] as HTMLElement[]).filter((part) => part.getClientRects().length).map((part) => `${part.dataset.formatItem ?? part.dataset.formatEnd ?? part.dataset.slot ?? '-'} ${Math.round(part.getBoundingClientRect().x)}..${Math.round(part.getBoundingClientRect().right)}`) },
        items, controls: bar ? rects([...bar.querySelectorAll<HTMLElement>('button, input, [role="combobox"]')]) : []
      }
    }, { editorSelector: editor, rowSelector: row, overflowSelector: overflow, body: BODY, title: TITLE })
    check(`${label} viewport and theme`, measured.width === width && measured.height === height && measured.scale === 3 && measured.dark === (theme === 'dark') && measured.lightPage === (theme === 'light'), {
      width: measured.width, height: measured.height, dpr: measured.scale, dark: measured.dark, lightPage: measured.lightPage
    })
    check(`${label} role and format row`, measured.edit === (role === 'edit') && !!measured.bar === (role === 'edit'))
    check(`${label} guest title shown once`, measured.hostedTitles === 1, measured.hostedTitles)
    check(`${label} viewport keyboard directive matches the browser`, measured.widgetResize === measured.keyboardAPI,
      { resizesContent: measured.widgetResize, virtualKeyboard: measured.keyboardAPI })
    check(`${label} document content`, measured.bodyPresent && measured.title === TITLE && measured.headings.includes('Morning setup') && measured.headings.includes('Afternoon handoff') && measured.list && measured.table, { title: measured.title, headings: measured.headings, list: measured.list, table: measured.table, editorText: measured.editorText })
    check(`${label} fits viewport`, measured.pageWidth <= measured.width && measured.mainScroll <= measured.mainWidth && (!measured.bar || measured.bar.scroll <= measured.bar.width && measured.bar.right <= measured.width + 0.2 && measured.bar.x >= 0 &&
      measured.controls.every((control: { x: number; right: number }) => control.x >= measured.bar.x - 0.2 && control.right <= measured.bar.right + 0.2)),
    { html: measured.pageWidth, viewport: measured.width, main: measured.mainWidth, mainScroll: measured.mainScroll, rowRight: measured.bar?.right, row: measured.bar?.width, rowScroll: measured.bar?.scroll, rowPad: measured.bar?.pad, rowParts: measured.bar?.parts })
    if (measured.paragraphs) fontByView.set(label, measured.paragraphs)
    check(`${label} styled and loaded body font`, !!measured.paragraphs && /Calibri|Carlito/.test(measured.paragraphs.paragraph) && /Calibri|Carlito/.test(measured.paragraphs.family) &&
      Math.abs(parseFloat(measured.paragraphs.textSize) - BODY_SIZE * 4 / 3) < 0.15 && measured.storedColour === BODY_COLOR &&
      measured.checkFont && measured.loadedFont, {
      ...measured.paragraphs, storedColour: measured.storedColour, fontCheck: measured.checkFont, loadedCarlito: measured.loadedFont
    })
    await page.screenshot({ path: join(shots, label + '.png'), animations: 'disabled' })
    savedShot = true

    if (role === 'edit') {
      const openedBlocks = serverContent(direct)
      check(`${label} preserves server state on open`, same(originalBlocks, openedBlocks) && Buffer.from(original).equals(encodeStateAsUpdate(direct)), openedBlocks)
      const folded: string[] = measured.items.filter((item: { folded: boolean }) => item.folded).map((item: { id: string }) => item.id)
      const visible: string[] = measured.items.filter((item: { folded: boolean }) => !item.folded).map((item: { id: string }) => item.id)
      const order = foldOrder(measured.items.map(({ id }: { id: string }) => ({ id, group: groups[id]!, keep: always.includes(id), width: 0 })))
      check(`${label} measured fold order`, always.every((id) => visible.includes(id)) && same(order.slice(0, folded.length).sort(), [...folded].sort()) &&
        !!measured.bar?.more === (folded.length > 0) && (!measured.bar?.over) && (width !== 390 || folded.length > 0), { visible, folded })
      if (width === 390) {
        const small = measured.controls.filter(({ width, height }: { width: number; height: number }) => width < 44 || height < 44)
        check(`${label} 44×44 CSS px row controls`, measured.coarse && small.length === 0,
          { coarse: measured.coarse, controls: measured.controls, smaller: small.map(({ name }: { name: string }) => name) })
      }
      if (folded.length) {
        phase = 'More'
        await page.locator(row).locator(overflow).tap({ timeout: 8000 })
        const open = page.locator(menu)
        await open.waitFor({ timeout: 8000 })
        const words: string = await open.innerText()
        check(`${label} More opens with folded controls`, folded.every((id) => !foldedLabels[id] || words.includes(foldedLabels[id]!)), words.split('\n').join(' | '))
        await page.screenshot({ path: join(shots, label + '.more.png'), animations: 'disabled' })
        await page.keyboard.press('Escape')
        await open.waitFor({ state: 'hidden', timeout: 8000 })
      }
      if (width === 390 && !measured.bodyPresent) {
        check(`${label} tapped Bold reaches the Work service`, false, 'The body paragraph did not open')
      } else if (width === 390) {
        phase = 'Bold'
        const phoneWord = tapWords[engine][theme]
        const selected = await page.evaluate(({ editorSelector, body, word }: { editorSelector: string; body: string; word: string }) => {
          const doc = document.querySelector<HTMLElement>(editorSelector)!
          const p = [...doc.querySelectorAll('p')].find((p) => p.textContent === body)!
          const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = node.textContent?.indexOf(word) ?? -1
            if (at < 0) continue
            doc.focus({ preventScroll: true })
            const range = document.createRange()
            range.setStart(node, at)
            range.setEnd(node, at + word.length)
            const selected = getSelection()!
            selected.removeAllRanges()
            selected.addRange(range)
            return selected.toString()
          }
          return ''
        }, { editorSelector: editor, body: BODY, word: phoneWord })
        check(`${label} word selected before tap`, selected === phoneWord, selected)
        await page.locator(row).getByRole('button', { name: 'Bold', exact: true }).tap({ timeout: 8000 })
        check(`${label} tapped Bold reaches the Work service`, await until(() => hasBold(direct, phoneWord)), phoneWord)
      }
    }
  } catch (err) {
    const text = await page.locator(editor).allTextContents().catch(() => [])
    check(`${label} browser steps`, false, { error: safe(err), editorText: text })
    if (!savedShot) await page.screenshot({ path: join(shots, label + '.png'), animations: 'disabled', timeout: 5000 }).catch(() => {})
  } finally {
    check(`${label} console errors`, errors.length === 0, errors)
    await context.close()
    const blocks = serverContent(direct)
    check(`${label} keeps the server document`, same(originalBlocks, blocks) &&
      (phase === 'Bold' || Buffer.from(original).equals(encodeStateAsUpdate(direct))), blocks)
  }
}

/** The words of each block as the Work service holds them. */
function serverWords(doc: Doc): string[] {
  return readBlocks(doc.getXmlFragment(DOCUMENT_FRAGMENT)).map((block) =>
    Array.isArray(block.content) ? block.content.map((piece) => (piece.type === 'text' ? piece.text : '')).join('') : '')
}

/** Flow or Pages as the page draws it now: the stage against the page, each sheet, the text's column, the row's switch. */
interface Drawn {
  width: number; html: number; main: number; mainScroll: number; mainGround: string; columnPad: string
  stage: { left: number; width: number; client: number; scroll: number; ground: string; pad: string } | null
  sheets: { x: number; right: number; width: number; height: number }[]
  text: { x: number; right: number; width: number } | null
  line: { x: number; right: number; size: string } | null
  last: boolean; view: string | null; bands: number; editable: boolean; caretOnSheet: boolean
}
const drawn = (page: any): Promise<Drawn> =>
  page.evaluate(({ editorSelector, tapLine, lastLine }: { editorSelector: string; tapLine: string; lastLine: string }) => {
    const round = (n: number) => Math.round(n * 10) / 10
    const box = (el: Element | null | undefined) => {
      if (!el) return null
      const { x, right, width, height } = el.getBoundingClientRect()
      return { x: round(x), right: round(right), width: round(width), height: round(height) }
    }
    const main = document.querySelector<HTMLElement>('main')!
    const stage = main.querySelector<HTMLElement>('.te-pages-stage')
    const doc = document.querySelector<HTMLElement>(editorSelector)
    const tap = doc && [...doc.querySelectorAll('p')].find((p) => p.textContent === tapLine)
    const caret = getSelection()?.anchorNode
    return {
      width: innerWidth, html: document.documentElement.scrollWidth, main: main.clientWidth, mainScroll: main.scrollWidth,
      mainGround: getComputedStyle(main).backgroundColor, columnPad: getComputedStyle(document.querySelector('[data-guest-document]')!).padding,
      stage: stage && { left: round(stage.getBoundingClientRect().left), width: round(stage.getBoundingClientRect().width), client: stage.clientWidth, scroll: stage.scrollWidth, ground: getComputedStyle(stage).backgroundColor, pad: getComputedStyle(stage).padding },
      sheets: stage ? [...stage.querySelectorAll('.te-page-sheet')].map((sheet) => box(sheet)!) : [],
      text: box(doc),
      line: tap ? { x: box(tap)!.x, right: box(tap)!.right, size: getComputedStyle(tap).fontSize } : null,
      last: !!doc?.textContent?.includes(lastLine),
      // The switch as drawn: null where there is none to see.
      view: (() => {
        const on = document.querySelector<HTMLElement>('[data-format-end="view"] [role="radio"][aria-checked="true"]')
        return on && on.getClientRects().length ? (on.getAttribute('aria-label') ?? on.textContent?.trim() ?? null) : null
      })(),
      bands: stage ? stage.querySelectorAll('.te-band').length : 0,
      editable: !!doc?.isContentEditable,
      caretOnSheet: !!caret && !!(caret.nodeType === 1 ? (caret as Element) : caret.parentElement)?.closest('.te-pages .bn-editor')
    }
  }, { editorSelector: editor, tapLine: TAP_LINE, lastLine: LAST_LINE })

/** Waits for the layout to stand still: the same sheets and the same height of text for half a second. */
async function settled(page: any): Promise<Drawn> {
  let was = ''
  let since = Date.now()
  const end = Date.now() + 10_000
  for (;;) {
    const now = await drawn(page)
    const key = JSON.stringify([now.sheets.length, now.text, now.stage?.scroll])
    if (key !== was) { was = key; since = Date.now() }
    if ((now.last && Date.now() - since >= 500) || Date.now() >= end) return now
    await delay(100)
  }
}

/** The sheets against the screen: every one inside it, fitted to the stage's width, the stage edge to edge on its own ground. */
function sheetsFit(now: Drawn): { ok: boolean; detail: unknown } {
  const stage = now.stage
  const side = !stage ? 0 : stage.client < PAGES_FROM ? 12 : 24
  const fitted = !stage ? 0 : stage.client - side * 2
  const ok = !!stage && now.sheets.length > 0 && now.html <= now.width && now.mainScroll <= now.main && stage.scroll <= stage.client &&
    Math.abs(stage.left) < 0.6 && Math.abs(stage.width - now.main) < 0.6 && stage.ground === now.mainGround && now.columnPad === '0px' &&
    now.sheets.every((sheet) => sheet.x >= 0 && sheet.right <= now.width + 0.2 && Math.abs(sheet.width - fitted) < 1 && Math.abs(sheet.x - side) < 1) &&
    !!now.text && now.text.x >= now.sheets[0]!.x && now.text.right <= now.sheets[0]!.right + 0.2
  return { ok, detail: { viewport: now.width, html: now.html, main: now.main, mainScroll: now.mainScroll, stage, column: now.columnPad, sheets: now.sheets.length, sheet: now.sheets[0], text: now.text } }
}

/** One page of the Pages document: Flow under 640px and sheets from it, fitted, counted, typed on, with nothing written by the open. */
async function provePages(
  browser: any, engine: (typeof ENGINES)[number], role: (typeof ROLES)[number], view: (typeof PAGES_VIEWS)[number],
  url: string, direct: Doc, desktop: DesktopCount | null, counts: Map<string, number>
): Promise<void> {
  const { width, height, theme } = view
  const label = `pages.${role}.${engine}.${width}.${theme}`
  if (only && !only.test(label)) return
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 3, colorScheme: theme, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  const errors: string[] = []
  let phase = 'opening'
  const original = encodeStateAsUpdate(direct)
  const words = serverWords(direct)
  const wide = width >= PAGES_FROM
  const count = (n: number, where: string) => {
    counts.set(`${label}${where}`, n)
    check(`${label}${where} has the app's own number of sheets`, !!desktop && n === desktop.pages, desktop ? { here: n, desktop: desktop.pages } : `${n} here; the app's pane was not measured (run --desktop first)`)
  }
  /** A tap in the line, three letters, and three Backspaces: each must reach the service, and the caret must be where he tapped. */
  const typeOn = async (where: string): Promise<void> => {
    const at = words.indexOf(TAP_LINE)
    await page.locator(editor).locator('p', { hasText: TAP_LINE }).tap({ timeout: 8000 })
    await page.keyboard.type(TYPED)
    const typed = await until(() => serverWords(direct)[at]?.replace(TYPED, '') === TAP_LINE && serverWords(direct)[at] !== TAP_LINE)
    const now = await drawn(page)
    check(`${label}${where} a tap types on a sheet, and the words reach the Work service`, typed && now.caretOnSheet && now.sheets.length > 0, { served: serverWords(direct)[at], caretOnSheet: now.caretOnSheet })
    for (const _ of TYPED) await page.keyboard.press('Backspace')
    check(`${label}${where} Backspace takes them out again`, await until(() => same(serverWords(direct), words)), serverWords(direct)[at])
  }
  try {
    page.on('console', (message: { type(): string; text(): string }) => { if (message.type() === 'error') errors.push(phase + ' ' + safe(message.text())) })
    page.on('pageerror', (err: Error) => errors.push(phase + ' ' + safe(err)))
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.locator(editor).waitFor({ timeout: 12_000 })
    await page.waitForFunction(({ selector, last }: { selector: string; last: string }) => !!document.querySelector(selector)?.textContent?.includes(last), { selector: editor, last: LAST_LINE }, { timeout: 12_000 }).catch(() => {})
    await page.waitForFunction(() => [...document.fonts].some((face) => face.family.replace(/['"]/g, '') === 'Carlito' && face.status === 'loaded'), undefined, { timeout: 8000 }).catch(() => {})
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const open = await settled(page)
    // The Flow | Pages switch is an Edit link's, and only where sheets have room.
    check(`${label} draws the whole document, the switch for Edit alone from ${PAGES_FROM}px`, open.last && open.editable === (role === 'edit') && (open.view !== null) === (role === 'edit' && wide), { last: open.last, editable: open.editable, view: open.view })
    check(`${label} an open writes nothing to the Work service`, Buffer.from(original).equals(encodeStateAsUpdate(direct)))
    if (wide) {
      check(`${label} opens as sheets (${width}px, from ${PAGES_FROM}px)`, !!open.stage && open.sheets.length > 1 && (role !== 'edit' || open.view === 'Pages'), { stage: !!open.stage, sheets: open.sheets.length, view: open.view })
      const fit = sheetsFit(open)
      check(`${label} the sheets fit the screen: no sideways scroll, the stage edge to edge`, fit.ok, fit.detail)
      check(`${label} a header and a footer stand on every sheet`, open.bands === open.sheets.length * 2, { bands: open.bands, sheets: open.sheets.length })
      count(open.sheets.length, '')
    } else {
      check(`${label} opens in Flow (${width}px, under ${PAGES_FROM}px)`, !open.stage && open.sheets.length === 0, { stage: !!open.stage, view: open.view })
      check(`${label} the text fits the screen in its column`, open.html <= open.width && open.mainScroll <= open.main && !!open.text && open.text.x >= 0 && open.text.right <= open.width && !!open.line && open.line.right <= open.width,
        { viewport: open.width, html: open.html, main: open.main, mainScroll: open.mainScroll, text: open.text, line: open.line })
    }
    await page.screenshot({ path: join(shots, label + '.png'), animations: 'disabled' })

    if (role === 'edit' && wide) {
      phase = 'typing'
      await typeOn('')
    }
    if (role === 'edit' && wide) {
      // His switch in the row: Flow puts the text in its column, Pages draws the same sheets again.
      phase = 'switch'
      await page.locator('[data-format-end="view"]').getByRole('radio', { name: 'Flow', exact: true }).tap({ timeout: 8000 })
      const left = await page.locator('.te-pages-stage').waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false)
      const flow = await settled(page)
      check(`${label} Flow in the row puts the text back in its column`, left && !flow.stage && flow.view === 'Flow' && flow.mainScroll <= flow.main && !!flow.text && flow.text.width <= 672.5, { stage: !!flow.stage, view: flow.view, text: flow.text })
      await page.locator('[data-format-end="view"]').getByRole('radio', { name: 'Pages', exact: true }).tap({ timeout: 8000 })
      await page.locator('.te-pages-stage .te-page-sheet').first().waitFor({ timeout: 8000 })
      const again = await settled(page)
      check(`${label} and Pages draws the same sheets again, with nothing written`, again.sheets.length === open.sheets.length && again.view === 'Pages' && same(serverWords(direct), words), { sheets: again.sheets.length, view: again.view })
    }
    if (wide) {
      // The last sheet: the page scrolls down to it, never sideways.
      phase = 'last sheet'
      await page.evaluate(() => { const main = document.querySelector('main')!; main.scrollTop = main.scrollHeight })
      await delay(300)
      const foot = await drawn(page)
      check(`${label} scrolled to the last sheet, the page still fits`, foot.html <= foot.width && foot.mainScroll <= foot.main && !!foot.stage && foot.stage.scroll <= foot.stage.client, { html: foot.html, mainScroll: foot.mainScroll })
      await page.screenshot({ path: join(shots, label + '.last.png'), animations: 'disabled' })
    }
  } catch (err) {
    check(`${label} browser steps (${phase})`, false, safe(err))
    await page.screenshot({ path: join(shots, label + '.failed.png'), animations: 'disabled', timeout: 5000 }).catch(() => {})
  } finally {
    check(`${label} console errors`, errors.length === 0, errors)
    await context.close()
    check(`${label} leaves the document's words as they were`, same(serverWords(direct), words) && (role === 'edit' || Buffer.from(original).equals(encodeStateAsUpdate(direct))))
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(hosted, 'guest', 'index.html'))) throw new Error(`No hosted guest build in ${hosted}`)
  // The service's own modules, loaded here: the other half runs under a Bun with no node:sqlite and no stand-in for electron.
  const { DatabaseSync } = await import('node:sqlite')
  const { GuestRuntime } = await import('../src/main/server/work/guests/links')
  const { ensureGuestTables } = await import('../src/main/server/work/guests/store')
  const { servicePaths } = await import('../src/main/server/work/service/config')
  const { startFakeConvex } = await import('../src/main/server/work/service/fakeConvex')
  const { startWorkService } = await import('../src/main/server/work/service/serve')
  const playwright = createRequire(import.meta.url)(playwrightPath)
  const root = mkdtempSync(join(tmpdir(), 'doc8-phone-'))
  const db = new DatabaseSync(':memory:')
  let lifeos: FakeConvex | undefined
  let service: RunningService | undefined
  let guest: InstanceType<typeof GuestRuntime> | undefined
  try {
    const data = join(root, 'data')
    mkdirSync(data)
    mkdirSync(shots, { recursive: true })
    lifeos = await startFakeConvex()
    await seed(root, lifeos)
    const desktop = await seedPages(root, lifeos)
    const keys = await generateCollabKeys('phone-proof')
    const signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:' + HOST })
    service = await startWorkService({
      port: 0, socketPath: servicePaths(data).socketPath, secret: 's'.repeat(43),
      dataDir: join(data, 'work-service'), hostedDir: hosted, host: HOST,
      lifeos: { here: true, url: lifeos.url },
      trusted: [{ by: 'host', iss: 'tempcode:' + HOST, aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }], links: []
    }, { jwt: async () => 'owner-jwt', log: () => {} })
    const base = `http://127.0.0.1:${service.port}`
    process.env.TEMP_CODE_WORK_PUBLIC_ORIGIN = base
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('work.ownerName', 'Sam Dummy')
    ensureGuestTables(db)
    const serviceNow = service
    const lifeosNow = lifeos
    const ctx = {
      db, host: HOST, log: () => {}, push: () => {},
      service: { url: (route: string) => base + route, token: async () => 'local proof', internal: async () => ({ seen: {} }) },
      lifeos: { owner: () => ({
        query: async (fn: string, { id }: { id: string }) => fn === 'docs:get' ? lifeosNow.docs.get(id) : null,
        mutation: async (fn: string, { id, shared }: { id: string; shared: boolean }) => {
          if (fn !== 'docs:setShared' || !lifeosNow.docs.has(id)) throw new Error('unexpected guest mutation')
          lifeosNow.docs.get(id)!.shared = shared
          return null
        }
      }) }
    } as unknown as WorkCtx
    guest = new GuestRuntime(ctx, () => ({ tokenSigner: () => signer, setLinks: (links) => serviceNow.setLinks(links), setProject: (id, project) => serviceNow.setProject(id, project) }))
    const links = new Map()
    for (const role of ROLES) links.set(role, await guest.create({
      source: { at: 'lifeos', table: 'docs', id: DOC }, title: TITLE, name: `Dummy ${role}`, role, expiresAt: Date.now() + 2 * 3600_000, bySession: null
    }))
    const pagesLinks = new Map()
    for (const role of ROLES) pagesLinks.set(role, await guest.create({
      source: { at: 'lifeos', table: 'docs', id: PAGES_DOC }, title: PAGES_TITLE, name: `Dummy ${role}`, role, expiresAt: Date.now() + 2 * 3600_000, bySession: null
    }))
    const connection = await service.collab.hocuspocus.openDirectConnection(DOC, { principal: 'owner', role: 'edit', by: 'internal', exp: Infinity })
    const pagesConnection = await service.collab.hocuspocus.openDirectConnection(PAGES_DOC, { principal: 'owner', role: 'edit', by: 'internal', exp: Infinity })
    try {
      const direct = connection.document!
      const pagesDirect = pagesConnection.document!
      const blocks = serverContent(direct)
      check('dummy .tcdoc state opens on the Work service at schema 1', schemaOf(direct) === 1 && blocks.includes('check-in:paragraph') && blocks.includes('stations:table'), { schema: schemaOf(direct), blocks })
      check('the guests pillar made three live links and set the shared flag', links.size === 3 && lifeos.docs.get(DOC)?.shared === true)
      check('the Pages file opens on the Work service as a styled document, whole', schemaOf(pagesDirect) >= 1 && serverWords(pagesDirect).includes(TAP_LINE) && serverWords(pagesDirect).some((words) => words.startsWith(LAST_LINE)) && pagesLinks.size === 3,
        { schema: schemaOf(pagesDirect), blocks: serverWords(pagesDirect).length })
      check(`the app's own pane was measured on this very file`, !!desktop, desktop ? { pages: desktop.pages, canvas: desktop.canvas, sheet: desktop.sheetWidth, engine: desktop.engine.match(/Chrome\/[\d.]+/)?.[0], at: desktop.at } : `no count for this file in ${desktopDir}: run this script with --desktop first`)
      const counts = new Map<string, number>()
      const browsers = new Map<(typeof ENGINES)[number], any>()
      try {
        for (const engine of ENGINES) {
          try {
            const browser = await playwright[engine].launch({ headless: true, timeout: 30_000 })
            browsers.set(engine, browser)
            console.log(`INFO ${engine} ${browser.version()}`)
          } catch (err) {
            check(`${engine} launches`, false, safe(err))
          }
        }
        // Read the original for each read-only role before exercising changes through Edit.
        for (const role of ['comment', 'view', 'edit'] as const) {
          for (const [engine, browser] of browsers) {
            if (!browser.isConnected()) continue
            try {
              for (const view of VIEWS) await provePage(browser, engine, role, view, links.get(role)!.url, direct)
            } catch (err) {
              check(`${role}.${engine} completes its viewport matrix`, false, safe(err))
              await browser.close()
            }
          }
        }
        for (const engine of only ? [] : browsers.keys()) for (const { width, theme } of VIEWS) {
          const key = `${engine}.${width}.${theme}`
          const edit = fontByView.get(`edit.${key}`)
          for (const role of ['comment', 'view'] as const) {
            check(`${role}.${key} matches Edit body font and size`, !!edit && same(edit, fontByView.get(`${role}.${key}`)))
          }
        }
        // Pages: the three-sheet file, read before it is typed on through Edit.
        for (const role of ['comment', 'view', 'edit'] as const) {
          for (const [engine, browser] of browsers) {
            if (!browser.isConnected()) continue
            try {
              for (const view of PAGES_VIEWS) await provePages(browser, engine, role, view, pagesLinks.get(role)!.url, pagesDirect, desktop, counts)
            } catch (err) {
              check(`pages.${role}.${engine} completes its viewport matrix`, false, safe(err))
              await browser.close()
            }
          }
        }
        const seen = [...new Set(counts.values())]
        if (!only) check('every engine, link and theme draws the same number of sheets', counts.size === browsers.size * ROLES.length * 2 && seen.length === 1, { pages: seen, drawn: counts.size })
      } finally {
        await Promise.all([...browsers.values()].map((browser) => browser.close()))
      }
    } finally {
      await connection.disconnect({ unloadImmediately: false })
      await pagesConnection.disconnect({ unloadImmediately: false })
    }
  } finally {
    guest?.stop()
    try {
      await service?.stop()
    } finally {
      await lifeos?.close()
      db.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}

if (process.argv.includes('--desktop')) await desktop()
try {
  await main()
} catch (err) {
  check('proof completes', false, safe(err))
}
console.log(`TOTAL ${checks - failures} passed, ${failures} failed, ${checks} checks`)
process.exitCode = failures ? 1 : 0
