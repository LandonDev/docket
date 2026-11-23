/**
 * DOC8's hosted guest page at phone and tablet widths. Serve the real Work
 * service and the hosted Vite build, with a dummy document and a local LifeOS.
 *
 *   TEMP_CODE_HOSTED_OUT=<hosted build> DOC8_PLAYWRIGHT_CORE=<playwright-core>
 *   heavy bun scripts/proof-bun.ts scripts/proof-doc-guest-phone.ts
 *
 * DOC8_PHONE_SHOTS may name a different output folder for the pictures.
 */
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { encodeStateAsUpdate, type Doc } from 'yjs'
import { DOCUMENT_FRAGMENT, DOCUMENT_SCHEMA, schemaOf } from 'work-kit/collab'
import { createCollabSigner, generateCollabKeys, readBlocks, TCDOC_STATE, TEMPCODE_COLLAB_AUDIENCE } from 'work-kit/collab-server'
import { DEFAULT_STYLES, defaultSetup } from 'work-kit/editor/page'
import { paraText } from 'work-kit/editor/para'
import { foldOrder, GROUP } from '../node_modules/work-kit/src/format/fold'
import { TEMPCODE_THEME } from 'work-kit/format/theme'
import { emptySidecar, type Block, type Inline } from 'work-kit/formats'
import { writeImportedTcdoc } from 'work-kit/formats/tcdoc'
import type { WorkCtx } from '../src/main/server/work/modules'
import { GuestRuntime } from '../src/main/server/work/guests/links'
import { ensureGuestTables } from '../src/main/server/work/guests/store'
import { servicePaths } from '../src/main/server/work/service/config'
import { startFakeConvex, type FakeConvex } from '../src/main/server/work/service/fakeConvex'
import { startWorkService, type RunningService } from '../src/main/server/work/service/serve'

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
const hosted = resolve(process.env.TEMP_CODE_HOSTED_OUT ?? 'out/hosted')
const shots = resolve(process.env.DOC8_PHONE_SHOTS ?? join(import.meta.dir, '../../../../.temp-code/plans/landed/DOC8-phone/shots'))
const playwrightPath = process.env.DOC8_PLAYWRIGHT_CORE ?? 'playwright-core'
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(homedir(), '.cache', 'ms-playwright')
const playwright = createRequire(import.meta.url)(playwrightPath)

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

const groups: Record<string, number> = {
  undo: GROUP.edits, redo: GROUP.edits, style: GROUP.style, font: GROUP.font, size: GROUP.font,
  bold: GROUP.character, italic: GROUP.character, underline: GROUP.character, colour: GROUP.character, highlight: GROUP.character,
  align: GROUP.cell, spacing: GROUP.cell, bulleted: GROUP.cell, numbered: GROUP.cell, checklist: GROUP.cell,
  indentLess: GROUP.cell, indentMore: GROUP.cell, insert: GROUP.insert
}
const always = ['style', 'bold', 'italic']
const foldedLabels: Record<string, string> = {
  font: 'Font', size: 'Font size', colour: 'Text colour', highlight: 'Highlight', spacing: 'Line spacing',
  align: 'Align', bulleted: 'Bulleted list', numbered: 'Numbered list', checklist: 'Check list',
  indentLess: 'Indent less', indentMore: 'Indent more', underline: 'Underline', redo: 'Redo', undo: 'Undo', insert: 'Insert'
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
        bar: bar && { x: bar.getBoundingClientRect().x, right: bar.getBoundingClientRect().right, width: bar.clientWidth, scroll: bar.scrollWidth, over: bar.dataset.over, more: !!bar.querySelector(overflowSelector) },
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
    { html: measured.pageWidth, viewport: measured.width, main: measured.mainWidth, mainScroll: measured.mainScroll, rowRight: measured.bar?.right, row: measured.bar?.width, rowScroll: measured.bar?.scroll })
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

async function main(): Promise<void> {
  if (!existsSync(join(hosted, 'guest', 'index.html'))) throw new Error(`No hosted guest build in ${hosted}`)
  const root = mkdtempSync(join(tmpdir(), 'doc8-phone-'))
  const db = new DatabaseSync(':memory:')
  let lifeos: FakeConvex | undefined
  let service: RunningService | undefined
  let guest: GuestRuntime | undefined
  try {
    const data = join(root, 'data')
    mkdirSync(data)
    mkdirSync(shots, { recursive: true })
    lifeos = await startFakeConvex()
    await seed(root, lifeos)
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
    const connection = await service.collab.hocuspocus.openDirectConnection(DOC, { principal: 'owner', role: 'edit', by: 'internal', exp: Infinity })
    try {
      const direct = connection.document!
      const blocks = serverContent(direct)
      check('dummy .tcdoc state opens on the Work service at schema 1', schemaOf(direct) === 1 && blocks.includes('check-in:paragraph') && blocks.includes('stations:table'), { schema: schemaOf(direct), blocks })
      check('the guests pillar made three live links and set the shared flag', links.size === 3 && lifeos.docs.get(DOC)?.shared === true)
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
        for (const engine of browsers.keys()) for (const { width, theme } of VIEWS) {
          const key = `${engine}.${width}.${theme}`
          const edit = fontByView.get(`edit.${key}`)
          for (const role of ['comment', 'view'] as const) {
            check(`${role}.${key} matches Edit body font and size`, !!edit && same(edit, fontByView.get(`${role}.${key}`)))
          }
        }
      } finally {
        await Promise.all([...browsers.values()].map((browser) => browser.close()))
      }
    } finally {
      await connection.disconnect({ unloadImmediately: false })
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

try {
  await main()
} catch (err) {
  check('proof completes', false, safe(err))
}
console.log(`TOTAL ${checks - failures} passed, ${failures} failed, ${checks} checks`)
process.exitCode = failures ? 1 : 0
