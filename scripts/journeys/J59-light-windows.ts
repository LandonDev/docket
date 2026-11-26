import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GuestCreated, GuestSource } from '../../src/shared/contract-work-guests'
import { browser, phone } from './lib/browser'
import { openCapture } from './lib/capture'
import { focusDocument } from './lib/edit'
import { openRow } from './lib/files'
import { fileAt } from './lib/place'
import { previewFormat } from './lib/preview'
import { journey, step, type Context } from './lib/record'
import { settings } from './lib/settings'
import { words } from './lib/shape'
import { json, shown } from './lib/tierThree'
import { Window } from './lib/window'
import { revealView } from './lib/more'

const KEY = 'docket.colorScheme.work'
const DECK = 'Practice theme.pptx'
const SHEET = 'Practice theme.xlsx'
const DOC = 'Practice print.tcdoc'
type Theme = { marker: string | null; className: string; backgrounds: string[]; rgba: number[] }
type Check = { surface: string; result: 'PASS' | 'FAIL' | 'not walked'; reason?: string; theme?: Theme; picture: string }

export function wearsLight(theme: Theme): boolean {
  const [red = 0, green = 0, blue = 0, alpha = 0] = theme.rgba
  return (theme.marker === 'light' || theme.className.split(/\s+/).includes('theme-light')) &&
    alpha === 255 && (0.2126 * red + 0.7152 * green + 0.0722 * blue) > 190
}

/** Dark pixels with no light marker: the slideshow's audience window, pinned dark on purpose. */
export function wearsDark(theme: Theme): boolean {
  const [red = 0, green = 0, blue = 0, alpha = 0] = theme.rgba
  return theme.marker !== 'light' && !theme.className.split(/\s+/).includes('theme-light') &&
    alpha === 255 && (0.2126 * red + 0.7152 * green + 0.0722 * blue) < 64
}

/**
 * What each surface promises under Work's Light. The audience window stays dark whatever the theme
 * (work/slides/show/places.ts `themeOf`: the room sees the slides on black), so it is checked dark. In shape U the
 * phone's /ui has no Capture window and no Full editor (it cannot carry the editor's own loopback origin): those two
 * are expected "not walked", with the reason in surfaces.json.
 */
export function expected(surface: string, shape: string): 'light' | 'dark' | 'not walked' {
  if (surface === 'slideshow') return 'dark'
  if (shape === 'U' && (surface === 'capture' || surface === 'full-editor')) return 'not walked'
  return 'light'
}

/** The checks that broke a promise: a surface not as `expected` says. */
export function broken(results: readonly Check[], shape: string): Check[] {
  return results.filter(({ surface, result }) => (expected(surface, shape) === 'not walked' ? result !== 'not walked' && result !== 'PASS' : result !== 'PASS'))
}

async function readTheme(page: Window, selector: string, frame?: string): Promise<Theme> {
  return page.eval(`(() => {
    const doc = ${frame ? `document.querySelector(${JSON.stringify(frame)})?.contentDocument` : 'document'};
    const root = doc.documentElement;
    const surface = doc.querySelector(${JSON.stringify(selector)});
    const canvas = doc.createElement('canvas');
    canvas.width = canvas.height = 1;
    const paint = canvas.getContext('2d');
    const backgrounds = [];
    const marker = surface.closest('[data-theme], [data-theme-id]') ?? root;
    const classNames = [root.className, doc.body.className, surface.className];
    for (let node = surface; node; node = node.parentElement) {
      backgrounds.push(doc.defaultView.getComputedStyle(node).backgroundColor);
    }
    for (const color of [...backgrounds].reverse()) {
      paint.fillStyle = color;
      paint.fillRect(0, 0, 1, 1);
    }
    return { marker: marker.getAttribute('data-theme') ?? marker.getAttribute('data-theme-id'),
      className: classNames.join(' '), backgrounds, rgba: [...paint.getImageData(0, 0, 1, 1).data] };
  })()`)
}

async function file(context: Context, page: Window, name: string): Promise<void> {
  const rail = 'nav [data-rail-path] button'
  await page.dismissPopups()
  if (!await page.centre(rail + '[aria-current="true"]', context.workspace.name)) await page.clickOn(rail, context.workspace.name)
  if (!await page.centre('[data-files-view]')) {
    await revealView(page, 'button, a, [role="link"]', 'Files')
    await page.clickOn('button, a, [role="link"]', 'Files')
  }
  await page.clickOn('[data-files-sidebar] button', context.workspace.name)
  await openRow(page, name)
}

type Surface = { page: Window; selector: string; frame?: string; ready?: () => Promise<boolean>; cleanup?: () => Promise<void> }

async function show(context: Context, page: Window, surface: 'audience' | 'presenter'): Promise<Surface> {
  await file(context, page, DECK)
  const selector = `[data-show="${surface}"]`
  if (surface === 'presenter') {
    await page.press('button', 'Ways to present')
    await page.clickOn('[role="menuitem"] span', 'Presenter view')
  } else {
    await page.press('button', 'Present')
  }
  if (context.shape === 'U') {
    const frame = `iframe[data-show-frame="${surface}"]`
    const cleanup = async () => {
      await page.eval(`document.querySelector(${JSON.stringify(frame)})?.contentDocument?.querySelector(${JSON.stringify(selector)})?.focus()`)
      await page.key('Escape')
      await page.until('the show frame to close', 12_000, () => page.eval(`!document.querySelector(${JSON.stringify(frame)})`))
    }
    return { page, selector, frame, cleanup }
  }
  const { pair } = context
  const popup = await Window.attach(pair.win.debug!, pair.abort.signal, url => url === 'about:blank', 1280, 800, 20_000)
  const cleanup = async () => {
    await popup.closePage().catch(() => undefined)
    popup.close()
  }
  pair.later(cleanup)
  return { page: popup, selector, cleanup }
}

async function fullEditor(context: Context, page: Window): Promise<Surface> {
  if (context.shape === 'U') throw new Error('Full editor needs the desktop app to carry the editor on its own loopback origin')
  await file(context, page, SHEET)
  if (!await page.centre('[role="tab"]', 'Full editor')) {
    await page.until('the workbook’s Full editor tab', 15_000, () => page.centre('[role="tab"]', 'Full editor'))
  }
  await page.press('tab', 'Full editor')
  const popup = await Window.attach(context.pair.win.debug!, context.pair.abort.signal, url => /\/w\/full\/[a-f\d]{64}\//.test(url), 1280, 800, 25_000)
  const cleanup = async () => {
    await popup.closePage().catch(() => undefined)
    popup.close()
  }
  context.pair.later(cleanup)
  return { page: popup, selector: '#editor_sdk', frame: 'iframe[name="frameEditor"]', ready: () =>
    popup.eval(`/^[A-Z]+\\d+$/.test(document.querySelector('iframe[name="frameEditor"]')?.contentDocument?.querySelector('#ce-cell-name')?.value ?? '')`),
    cleanup }
}

async function print(context: Context, page: Window): Promise<Surface> {
  await file(context, page, DOC)
  await focusDocument(page)
  await page.until('the document editor and print command', 25_000, () => page.centre('[data-editor-answers~=print]'))
  if (context.shape === 'A') {
    if (!await page.eval<boolean>("window.api.debug.menuClick('print')")) throw new Error('File offers no Print command')
  } else {
    await page.press('button', 'Preview')
  }
  await previewFormat(page, 'print', 'Print')
  await page.until('the print preview paper', 25_000, () => page.centre('[data-preview=print] [data-paged-page]'))
  return { page, selector: '[data-preview=print]', cleanup: async () => { await page.clickOn('[data-preview] button', 'Edit') } }
}

async function guest(context: Context): Promise<Surface> {
  const { pair } = context
  if (!pair.guestOrigin || !pair.sandbox) throw new Error('No guest address for the isolated LifeOS host')
  const title = 'Practice theme invitation ' + context.shape
  const { source } = await pair.rpc<{ source: GuestSource }>(pair.box, 'work.docs.create', { title, sector: 'ref' })
  const { link, url } = await pair.rpc<GuestCreated>(pair.box, 'work.guests.create', {
    source, title, name: 'Practice Reader', role: 'view', expiresAt: Date.now() + 86_400_000
  })
  const visit = await browser(pair, join(context.folder, 'guest-profile'), new URL(url), 1000)
  await visit.page.until('the guest document title', 25_000, () => shown(visit.page, 'body', title))
  const links = await pair.rpc<{ id: string; revokedAt: number | null }[]>(pair.box, 'work.guests.list')
  if (!links.some(row => row.id === link.id && row.revokedAt === null)) throw new Error('The guest document has no live link on box')
  return { page: visit.page, selector: 'body', cleanup: visit.stop }
}

async function check(context: Context, page: Window, surface: string, open: () => Promise<Surface>): Promise<Check> {
  const picture = surface + '.png'
  const hostStart = context.pair.hostErrors.length
  let visit: Surface | undefined
  try {
    visit = await open()
    const { page: target, selector, frame } = visit
    if (frame) {
      await target.until('the page inside ' + frame, 35_000, () => target.eval(
        `!!document.querySelector(${JSON.stringify(frame)})?.contentDocument?.querySelector(${JSON.stringify(selector)})`))
    } else {
      await target.until('the ' + surface + ' surface', 20_000, () => target.centre(selector))
    }
    if (visit.ready) await target.until('the workbook loaded in its editor', 95_000, visit.ready)
    const theme = await readTheme(target, selector, frame)
    await target.shot(join(context.folder, picture))
    const want = expected(surface, context.shape)
    if (want === 'dark' ? wearsDark(theme) : wearsLight(theme)) return { surface, result: 'PASS', picture, theme }
    const reason = want === 'dark' ? 'This surface does not stay dark' : 'This surface does not wear light'
    json(context, surface + '-failure', { reason, theme, toasts: await target.toasts(), saveLine: await target.saveLine(),
      hostErrors: [...context.pair.hostErrors.slice(hostStart), ...target.hostErrors] })
    return { surface, result: 'FAIL', reason, picture, theme }
  } catch (error) {
    const target = visit?.page ?? page
    await target.shot(join(context.folder, picture))
    const reason = words(error)
    json(context, surface + '-failure', { reason, toasts: await target.toasts(), saveLine: await target.saveLine(),
      hostErrors: [...context.pair.hostErrors.slice(hostStart), ...target.hostErrors] })
    return { surface, result: 'not walked', reason, picture }
  } finally {
    await visit?.cleanup?.()
    await page.dismissPopups()
  }
}

const checks = new WeakMap<Context, Check[]>()

export default journey({
  id: 'J59',
  title: 'Set Work to Light and check the surfaces it opens, the audience window dark',
  tier: 3,
  shapes: ['A', 'U'],
  steps: [
    step('Set Work to Light from Appearance and take a picture of each surface', async (context) => {
      const { pair, folder, workspace } = context
      const visit = context.shape === 'U' ? await phone(pair, join(folder, 'ui-profile'), 'owner') : null
      const page = visit?.page ?? pair.page
      context.evidencePage = page
      for (const [name, fixture] of [
        [DECK, 'src/main/server/work/slides/fixtures/steps-talk.pptx'],
        [SHEET, 'src/main/server/work/sheets/fullEditor/fixtures/pivot-chart.xlsx'],
        [DOC, 'resources/work-files/blank/blank.tcdoc']
      ] as const) copyFileSync(join(pair.repo, fixture), fileAt(context, name))
      await pair.showWork(workspace, 'Files', page)
      await settings(page, 'Appearance')
      await page.clickOn('[role="combobox"]', 'Work')
      await page.clickOn('[role="option"]', 'Light')
      await page.until('Light selected and saved by Appearance', 15_000, () => page.eval(
        `document.querySelector('[role="combobox"][aria-label="Work"]')?.textContent.trim() === 'Light' && localStorage.getItem(${JSON.stringify(KEY)}) === 'light'`))
      await page.shot(join(folder, 'appearance.png'))
      await page.press('button', 'Back')
      const surfaces: [string, () => Promise<Surface>][] = [
        ['slideshow', () => show(context, page, 'audience')],
        ['presenter', () => show(context, page, 'presenter')],
        ['capture', async () => {
          if (context.shape === 'U') throw new Error('The /ui client has no native Capture shortcut or window')
          const popup = await openCapture(pair)
          return { page: popup, selector: '[data-capture]', cleanup: async () => { await popup.key('Escape') } }
        }],
        ['full-editor', () => fullEditor(context, page)],
        ['print', () => print(context, page)],
        ['guest', () => guest(context)]
      ]
      const results: Check[] = []
      for (const [name, open] of surfaces) {
        results.push(await check(context, page, name, open))
        json(context, 'surfaces', results)
      }
      checks.set(context, results)
    }),
    step('end: the audience window stays dark and every other surface wears light', async context => {
      const results = checks.get(context)!
      const failures = broken(results, context.shape)
      if (failures.length) throw new Error(failures.map(row => row.surface + ' ' + row.result + ' (' + row.reason + ')').join(' | '))
      if (results.length !== 6 || !readFileSync(fileAt(context, DECK)).length) throw new Error('The themed walk lacks a surface or source file')
    })
  ]
})
