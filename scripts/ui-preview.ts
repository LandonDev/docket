/**
 * Run from the repo root:
 * bun scripts/ui-preview.ts path/to/component.tsx#Export --props '{"children":"Save"}'
 *
 * Writes /tmp/ui-preview/Export.html and Export.light.html (or under --out <dir>),
 * linked to each other. --shot also writes Export[.light].864.png and .400.png
 * through headless Chrome (TEMP_CODE_CHROME, else Playwright's cached
 * chrome-headless-shell), each page as tall as its content.
 * Separate documents keep html.theme-light and dark: selectors intact, without
 * iframes or CSS rewriting. Both embed out/renderer/assets/*.css when present;
 * --fresh compiles the app's own stylesheet from source in the built one's
 * place (about a second), so a class or a token newer than the build draws;
 * a page under src/hosted gets its own sheet (guest.css) compiled the same way.
 * Adjacent component.fixtures.tsx carries [{ name, props, prepare?, now? }] (the
 * export-specific array, then the default, `fixtures`, or the first array).
 * A fixture can open a state through a real control before capture. --props supplies shared defaults, fixtures override them.
 * Use "fn" for required callbacks (also within nested props); it becomes a noop.
 * A preview may export previewClock to hold Date.now during the capture.
 * The component renders with the client renderer into a jsdom document (the
 * stores' useSyncExternalStore reads need no server snapshot that way), then
 * its markup is written into a static page. A popup the render left open (a
 * menu, a select, a popover, a dialog, a sheet: `open` or `defaultOpen` in the
 * fixture) is drawn in place under its fixture. Events still need a DOM test.
 */
import { plugin } from 'bun'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { expandGlobs, GLOB_MODULES } from './lib/previewGlobs'

const root = resolve(import.meta.dirname, '..')

// Bun reads only the root tsconfig's paths; the renderer's own aliases
// (@renderer, @aliax, @server/shared, @shared) live in tsconfig.web.json, and a
// runtime plugin's onResolve never sees a bare specifier (Bun 1.4). So the
// script runs itself once more under that tsconfig, which resolves them all.
const CHILD = 'UI_PREVIEW_CHILD'
if (import.meta.main && !process.env[CHILD]) {
  const child = spawnSync(process.execPath, ['--tsconfig-override', join(root, 'tsconfig.web.json'), process.argv[1], ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, [CHILD]: '1' }
  })
  process.exit(child.status ?? 1)
}

plugin({
  name: 'ui-preview-css',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {}', loader: 'js' }))
    // A Vite worker import (`monaco…/editor.worker?worker`) is a constructor in
    // the app; a static render never starts one.
    build.onLoad({ filter: /\?worker$/ }, () => ({ contents: 'export default class Worker {}', loader: 'js' }))
    // Vite's import.meta.glob is the build's: Bun has none, and a page that reaches one died as it loaded.
    build.onLoad({ filter: new RegExp(`(${GLOB_MODULES.map((file) => file.replace(/[.\/]/g, '\\$&')).join('|')})$`) }, async ({ path }) => ({
      contents: expandGlobs(await readFile(path, 'utf8'), path),
      loader: path.endsWith('x') ? 'tsx' : 'ts'
    }))
  }
})

/** The stylesheet a target's page loads: a hosted page's own (src/hosted/guest/guest.css, which imports the app's
 *  and adds its folder's classes and rules), else the app's. */
export function stylesheetFor(modulePath: string): string {
  const dir = dirname(resolve(modulePath))
  const hosted = relative(join(root, 'src/hosted'), dir)
  if (hosted && !hosted.startsWith('..')) {
    const own = readdirSync(dir).filter((file) => file.endsWith('.css')).sort()[0]
    if (own) return join(dir, own)
  }
  return join(root, 'src/renderer/src/index.css')
}

/** A stylesheet (the app's index.css by default) compiled as the build compiles
 *  it (Tailwind over the renderer's sources and the sheet's own @source), in
 *  about a second, with its font files addressed where they lie. */
export async function freshStylesheet(path = join(root, 'src/renderer/src/index.css')): Promise<string> {
  const { compile } = await import('@tailwindcss/node')
  const { Scanner } = await import('@tailwindcss/oxide')
  const compiler = await compile(await readFile(path, 'utf8'), { base: dirname(path), onDependency: () => {} })
  const css = compiler.build(new Scanner({ sources: [{ base: join(root, 'src/renderer'), pattern: '**/*', negated: false }, ...compiler.sources] }).scan())
  return css.replace(/url\("(?:\.\.\/)*(?:\.\/)?(?:renderer\/src\/)?assets\/fonts\//g, `url("${pathToFileURL(join(root, 'src/renderer/src/assets/fonts')).href}/`)
}

type Props = Record<string, unknown>
type Fixture = {
  name: string
  props: Props
  prepare?: (container: HTMLElement) => void | Promise<void>
  now?: number
}
const noop = (): void => {}

// Only plain objects and arrays are walked: a fixture's Set, Map or element passes as it is.
function stubCallbacks(value: unknown): unknown {
  if (value === 'fn') return noop
  if (Array.isArray(value)) return value.map(stubCallbacks)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && !('$$typeof' in value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stubCallbacks(item)]))
  }
  return value
}

/** The fixtures a module beside a component carries: those named for the
 *  selected export (`fixturesByExport[name]`, or an exported `<name>Fixtures`)
 *  when several components share a module, else its default export, else
 *  `fixtures`, else the first exported array of `{ name, props }`. */
function fixturesOf(module: Record<string, unknown>, name: string): unknown {
  if (isProps(module.fixturesByExport)) return module.fixturesByExport[name] ?? [{ name, props: {} }]
  const named = module[`${name}Fixtures`]
  if (Array.isArray(named)) return named
  if (Array.isArray(module.default)) return module.default
  if (Array.isArray(module.fixtures)) return module.fixtures
  return Object.values(module).find((value) => Array.isArray(value) && value.every((item) => isProps(item) && 'name' in item && 'props' in item))
}

/** One jsdom document for the whole run, its globals installed once: React's
 *  scheduler and the stores keep running between renders, so nothing is torn
 *  down until the child process exits. */
let page: JSDOM | null = null
function documentWindow(): JSDOM['window'] {
  if (page) return page.window
  page = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
  const { window } = page
  const target = globalThis as Record<string, unknown>
  for (const key of ['window', 'document', 'navigator', 'scrollX', 'scrollY', 'innerWidth', 'innerHeight', 'HTMLElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'localStorage', 'AbortController', 'AbortSignal', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'DOMRect', 'SVGElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLBRElement', 'customElements', 'HTMLDivElement', 'HTMLSpanElement', 'HTMLCanvasElement', 'DocumentFragment', 'Range', 'Selection', 'getSelection', 'self', 'location', 'FocusEvent', 'UIEvent', 'WheelEvent', 'Text', 'NodeFilter', 'ShadowRoot', 'HTMLButtonElement']) {
    const value = (window as unknown as Record<string, unknown>)[key]
    // Bun's own event constructors produce a different realm's events.
    // A renderer control may dispatch to jsdom from its own event handler.
    if (value !== undefined && (target[key] === undefined || key.endsWith('Event') || key.startsWith('Abort'))) target[key] = value
  }
  // Bun has a Worker, but the markdown worker never answers under it, and the
  // row waited 8 s on it (lib/markdownParse.ts), so every markdown page drew
  // blank. That one fails at its first message instead, and the row parses on
  // the main thread at once; any other worker is Bun's own.
  const BunWorker = target.Worker as (new (url: string | URL, options?: object) => object) | undefined
  if (BunWorker && !(BunWorker as { previewStub?: boolean }).previewStub) {
    class FailingWorker {
      onmessage: unknown = null
      onerror: ((event: Event) => void) | null = null
      postMessage(): void { queueMicrotask(() => this.onerror?.(new window.Event('error'))) }
      terminate(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    target.Worker = Object.assign(function Worker(url: string | URL, options?: object) {
      return /markdown\.worker/.test(String(url)) ? new FailingWorker() : new BunWorker(url, options)
    }, { previewStub: true })
  }
  if (target.ResizeObserver === undefined) target.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  if (target.matchMedia === undefined) target.matchMedia = matchMedia
  window.matchMedia ??= matchMedia as unknown as typeof window.matchMedia
  // jsdom has neither: a tab strip escapes its ids and scrolls its active tab into view.
  if (target.CSS === undefined) target.CSS = { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`), supports: () => false }
  window.Element.prototype.scrollIntoView ??= function scrollIntoView() {}
  window.Element.prototype.getAnimations ??= () => []
  // Monaco probes the clipboard commands as it loads.
  window.document.queryCommandSupported ??= () => false
  // The transcript's virtual list parks when its viewport has no height.
  // Give it a viewport while jsdom mounts the rows. Chrome lays them out.
  const clientHeight = Object.getOwnPropertyDescriptor(window.Element.prototype, 'clientHeight')
  if (clientHeight?.get) Object.defineProperty(window.Element.prototype, 'clientHeight', {
    ...clientHeight,
    get(this: Element) { return this.classList.contains('agent-transcript') ? 560 : clientHeight.get!.call(this) },
  })
  return window
}

/** The component's markup after a client render: one mount into a fresh
 *  container, one flush, the container's innerHTML. */
async function clientMarkup(component: ComponentType<Props>, props: Props, fixture: Fixture): Promise<string> {
  const window = documentWindow()
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const container = window.document.createElement('div')
  const before = new Set(window.document.body.children)
  window.document.body.appendChild(container)
  const root = createRoot(container)
  const readNow = Date.now
  if (fixture.now !== undefined) Date.now = () => fixture.now!
  try {
    flushSync(() => root.render(createElement(component, props)))
    // Effects and short animations (a count ticking up, a morph) land after the
    // first render: read the markup until two reads 50ms apart agree, at most
    // 400ms, so a fixture shows what the component settles on.
    await new Promise((done) => setTimeout(done, 0))
    await fixture.prepare?.(container)
    const currentPortals = () => [...window.document.body.children].filter((element) => element !== container && !before.has(element))
    const snapshot = () => container.innerHTML + currentPortals().map((element) => element.outerHTML).join('')
    let last = snapshot()
    for (let waited = 0; waited < 400; waited += 50) {
      await new Promise((done) => setTimeout(done, 50))
      const next = snapshot()
      if (waited >= 50 && next === last) break
      last = next
    }
    for (const part of [container, ...currentPortals()]) await wakeBones(part)
    let html = container.innerHTML
    const portals = portalMarkup(currentPortals())
    const stage = container.querySelector('[data-preview-stage]')
    if (stage && portals) {
      stage.insertAdjacentHTML('beforeend', portals)
      html = container.innerHTML
    } else {
      html += portals
    }
    return html
  } finally {
    root.unmount()
    container.remove()
    Date.now = readNow
  }
}

/** Bones in a still page (components/bones.tsx): a region still in its hold is shown, and each drawing is followed
 *  by the engine's script, which measures it and draws its bones in the page as Skullet's own server render does.
 *  The sweep runs there too; a shot catches it where it stands. */
async function wakeBones(root: Element): Promise<void> {
  if (!root.querySelector('[skullet-loading]')) return
  const { bonesPreviewScript, bonesReady } = await import('../src/renderer/src/components/bones')
  await bonesReady()
  for (const region of root.querySelectorAll('[data-bones="held"]')) region.setAttribute('data-bones', 'shown')
  const script = bonesPreviewScript().replace(/<\/script/gi, '<\\/script')
  for (const drawing of root.querySelectorAll('[skullet-loading]')) drawing.insertAdjacentHTML('afterend', `<script>${script}</script>`)
}

/** What the render put outside its container: an open menu, select,
 *  popover, tooltip, dialog or sheet lives in a portal on the body. Each is
 *  drawn in place under its fixture, in a box that stands in for the window:
 *  a positioner loses the coordinates Floating UI gave it (jsdom measures
 *  nothing, so they are all the top left corner) and lies in the flow, a
 *  dialog, which is fixed to the window, is fixed to the box, and a side sheet
 *  stands at its edge in the box's flow, as tall as its rows (in a fixture's
 *  stage, fixed to the stage as a dialog is). */
export function portalMarkup(portals: Element[]): string {
  let html = ''
  for (const portal of portals) {
    if (!portal.innerHTML.trim()) continue
    const sheet = portal.querySelector('[data-slot="sheet-content"]')
    const positioners = [portal, ...portal.querySelectorAll('[data-side]')].filter((element) =>
      element !== sheet && element.matches('[data-side]'))
    for (const element of positioners) element.removeAttribute('style')
    // Sheets use data-side to choose an edge, but are fixed like dialogs.
    const modal = sheet !== null || positioners.length === 0
    html += `<div class="preview-portal"${modal ? ' data-preview-window=""' : ''}>${portal.outerHTML}</div>`
  }
  return html
}

function isProps(value: unknown): value is Props {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      props: { type: 'string' },
      width: { type: 'string', default: '480' },
      'shot-widths': { type: 'string' },
      out: { type: 'string', default: '/tmp/ui-preview' },
      shot: { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false }
    }
  })
  const [target] = positionals
  const match = target?.match(/^(.+)#([^#]+)$/)
  if (positionals.length !== 1 || !match) {
    throw new Error('Usage: bun scripts/ui-preview.ts <module>#<export> [--props \'<json>\'] [--width 480] [--out <dir>] [--shot] [--shot-widths 864,400] [--fresh]')
  }
  const width = Number(values.width)
  if (!Number.isSafeInteger(width) || width <= 0) throw new Error('--width must be a positive integer')
  const shotWidths = values['shot-widths']?.split(',').map(Number) ?? SHOT_WIDTHS
  if (shotWidths.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('--shot-widths must be comma-separated positive integers')
  }
  const props: unknown = JSON.parse(values.props ?? '{}')
  if (!isProps(props)) throw new Error('--props must be a JSON object')

  const modulePath = resolve(match[1])
  const exportName = match[2]
  // Some modules read window or document as they load (Monaco's setup among them).
  documentWindow()
  // Skullet rides a chunk of its own: in hand before the first render, so a region draws its bones in it.
  await (await import('../src/renderer/src/components/bones')).bonesReady()
  const module = await import(pathToFileURL(modulePath).href)
  if (typeof module.previewClock === 'number') {
    const clock = module.previewClock
    Date.now = () => clock
  }
  const component = module[exportName] as ComponentType<Props>
  if (!component) throw new Error(`No export "${exportName}" in ${match[1]}`)
  const fixturesPath = join(dirname(modulePath), `${basename(modulePath, extname(modulePath))}.fixtures.tsx`)
  const fixtures: unknown = existsSync(fixturesPath)
    ? fixturesOf(await import(pathToFileURL(fixturesPath).href), exportName)
    : (modulePath.endsWith('.fixtures.tsx') ? fixturesOf(module, exportName) : undefined) ?? [{ name: exportName, props: {} }]
  if (!Array.isArray(fixtures) || !fixtures.every((item): item is Fixture =>
    isProps(item) && typeof item.name === 'string' && isProps(item.props) && (item.prepare === undefined || typeof item.prepare === 'function') && (item.now === undefined || typeof item.now === 'number'))) {
    throw new Error(`${fixturesPath} must default-export [{ name, props }]`)
  }

  const assets = resolve('out/renderer/assets')
  const cssFiles = existsSync(assets) ? (await readdir(assets)).filter((file) => file.endsWith('.css')).sort() : []
  // --fresh: the app's own sheet compiled from source in the built one's
  // place, so a class or a token written since the last build draws; the
  // build's other sheets (the editors', Work's) are kept as they are.
  const fresh = values.fresh
  const sheets = await Promise.all(cssFiles.filter((file) => !(fresh && /^index-/.test(file))).map((file) => readFile(join(assets, file), 'utf8')))
  const css = [...(fresh ? [await freshStylesheet(stylesheetFor(modulePath))] : []), ...sheets].join('\n')
  if (!cssFiles.length && !fresh) console.log('No built stylesheet at out/renderer/assets/*.css; writing previews without it.')

  const markup = new Map<string, string>()
  for (const fixture of fixtures) markup.set(fixture.name, await clientMarkup(component, stubCallbacks({ ...props, ...fixture.props }) as Props, fixture))

  const name = (exportName === 'default' ? basename(modulePath, extname(modulePath)) : exportName)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
  const output = resolve(values.out)
  await mkdir(output, { recursive: true })
  const chrome = values.shot ? chromePath() : null
  if (values.shot && !chrome) throw new Error('--shot needs headless Chrome: set TEMP_CODE_CHROME or install Playwright\'s chrome-headless-shell')
  for (const light of [false, true]) {
    const filename = `${name}${light ? '.light' : ''}.html`
    const other = `${name}${light ? '' : '.light'}.html`
    const page = createElement('html', { lang: 'en', className: light ? 'theme-light' : undefined },
      createElement('head', null,
        createElement('meta', { charSet: 'utf-8' }),
        createElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
        createElement('title', null, `${exportName}: ${light ? 'light' : 'dark'} theme`),
        createElement('base', { href: pathToFileURL(`${assets}/`).href }),
        createElement('style', { dangerouslySetInnerHTML: { __html: css } }),
        createElement('style', null, `
          html, body { position: static; inset: auto; width: auto; height: auto; overflow: visible; }
          html { color-scheme: ${light ? 'light' : 'dark'}; }
          body { margin: 0; padding: 24px; background: var(--background, Canvas); color: var(--foreground, CanvasText); font: 13px var(--font-sans, system-ui); }
          main { width: ${width}px; }
          .preview-themes { display: flex; gap: 8px; margin-bottom: 24px; font-size: 12px; }
          .preview-themes a { color: var(--muted-foreground, GrayText); }
          .preview-shot main { width: auto; }
          /* A still is the settled state: Chrome shoots the first frame, so a mark caught growing in (glyph-in) read as a pale ring. */
          .preview-shot *, .preview-shot *::before, .preview-shot *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition: none !important; }
          .preview-fixture + .preview-fixture { margin-top: 24px; }
          .preview-label { margin-bottom: 8px; color: var(--muted-foreground, GrayText); font-size: 11px; }
          /* A portal drawn in place (portalMarkup): the transform makes the box what a fixed panel is fixed to. */
          .preview-portal { position: relative; transform: translate(0, 0); margin-top: 8px; }
          .preview-portal:not([data-preview-window]) { width: fit-content; max-width: 100%; }
          .preview-portal[data-preview-window] { min-height: 640px; overflow: hidden; }
          [data-preview-stage] { position: relative; transform: translate(0, 0); }
          [data-preview-stage] > .preview-portal[data-preview-window] { position: absolute; inset: 0; z-index: var(--layer-dialog); min-height: 0; margin: 0; }
          [data-preview-dialog-grid] { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 12px; }
          [data-preview-dialog-grid] > :not(.preview-portal) { display: none; }
          [data-preview-dialog-grid] > .preview-portal[data-preview-window] { position: relative; min-height: 460px; }
          /* A side sheet open in a picture: at its edge and width, 12px in as in the window, and as tall as its rows, so the window
             grows to hold it (in the app it is the window's height and its body scrolls); no stand-in stage is needed. In a stage
             (data-preview-stage, a window of the fixture's own height) it stays fixed to that window. */
          .preview-portal:not([data-preview-stage] > *) [data-slot="sheet-content"]:is([data-side="left"], [data-side="right"]) { position: relative; inset: auto; height: auto; margin: 12px; }
          .preview-portal:not([data-preview-stage] > *) [data-slot="sheet-content"][data-side="right"] { margin-inline-start: auto; }
        `)),
      createElement('body', null,
        createElement('main', null,
          createElement('nav', { className: 'preview-themes', 'aria-label': 'Theme' },
            createElement('h1', { className: 'preview-theme', style: { font: 'inherit', margin: 0 } }, `${light ? 'Light' : 'Dark'} theme`),
            createElement('a', { href: pathToFileURL(join(output, other)).href }, `Open the ${light ? 'dark' : 'light'} theme`)),
          ...fixtures.map((fixture) => createElement('section', { className: 'preview-fixture', key: fixture.name },
            createElement('div', { className: 'preview-label' }, fixture.name),
            createElement('div', { dangerouslySetInnerHTML: { __html: markup.get(fixture.name) ?? '' } }))))))
    const path = join(output, filename)
    const document = renderToStaticMarkup(page)
    const measure = [...markup.values()].some((html) => html.includes('agent-transcript') || html.includes('task-cursor') || html.includes('data-slot="panel-sections"') || html.includes('data-sonner-toaster'))
    const html = `<!doctype html>${measure ? document.replace('</body>', '<script>(' + positionPreviewDetails.toString() + ')()</script></body>') : document}\n`
    await writeFile(path, html)
    console.log(path)
    if (chrome) for (const shot of await screenshots(chrome, html, join(output, `${name}${light ? '.light' : ''}`), shotWidths)) console.log(shot)
  }
}

/** Restore positions that the static DOM could only measure as zero. */
export function positionPreviewDetails(): void {
  const position = () => {
    // The client render only had row height estimates. Reflow each mounted
    // row at the browser's width, where its text and code can wrap.
    const transcriptRows = new Map<HTMLElement, HTMLElement[]>()
    for (const row of document.querySelectorAll<HTMLElement>('.agent-transcript [data-row][style]')) {
      const column = row.parentElement
      if (!column || !row.style.top) continue
      const rows = transcriptRows.get(column) ?? []
      rows.push(row)
      transcriptRows.set(column, rows)
    }
    for (const [column, rows] of transcriptRows) {
      let top = Number.parseFloat(rows[0].style.top)
      for (const row of rows) {
        row.style.top = top + 'px'
        top += row.getBoundingClientRect().height
      }
      column.style.height = top + 'px'
    }
    for (const cursor of document.querySelectorAll<HTMLElement>('.task-cursor')) {
      const list = cursor.parentElement
      const mark = list?.querySelector('.task-mark[data-state="active"]')
      if (!list || !mark) continue
      const box = list.getBoundingClientRect()
      const active = mark.getBoundingClientRect()
      const y = active.top - box.top - list.clientTop
      cursor.style.translate = `${active.left - box.left - list.clientLeft}px ${y}px`
      const share = list.querySelector<HTMLElement>('.task-share')
      if (share) share.style.translate = `0 ${y - 3}px`
    }
    for (const frame of document.querySelectorAll('[data-preview-toast-frame]')) {
      const stack = frame.querySelector<HTMLElement>('[data-sonner-toaster]')
      if (!stack) continue
      const box = frame.getBoundingClientRect()
      const anchor = frame.querySelector('[data-toast-anchor]')?.getBoundingClientRect()
      // A waiting card over the footer seats the stack above itself (components/ui/toaster.tsx seatRect).
      const card = anchor ? frame.querySelector('[data-toast-seat]')?.getBoundingClientRect() : undefined
      const top = anchor && card && card.height > 0 && card.top < anchor.top ? card.top : anchor?.top
      const bottom = Math.max(16, anchor && top !== undefined ? box.bottom - top + 8 : 16)
      const right = Math.max(16, anchor ? box.right - anchor.right + 16 : 16)
      const width = Math.max(0, Math.min(340, (anchor?.width ?? box.width) - 32))
      for (const viewport of ['', 'mobile-']) {
        stack.style.setProperty('--' + viewport + 'offset-bottom', bottom + 'px')
        stack.style.setProperty('--' + viewport + 'offset-right', right + 'px')
      }
      stack.style.setProperty('--width', width + 'px')
    }
    for (const indicator of document.querySelectorAll<HTMLElement>('[data-slot="panel-sections"] [data-slot="tabs-indicator"]')) {
      const tab = indicator.parentElement?.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!tab) continue
      indicator.hidden = false
      indicator.style.setProperty('--active-tab-top', tab.offsetTop + 'px')
      indicator.style.setProperty('--active-tab-left', tab.offsetLeft + 'px')
      indicator.style.setProperty('--active-tab-width', tab.offsetWidth + 'px')
      indicator.style.setProperty('--active-tab-height', tab.offsetHeight + 'px')
    }
  }
  position()
  void document.fonts?.ready.then(position)
  window.addEventListener('resize', position)
}

const SHOT_WIDTHS = [864, 400]
const MAX_SHOT_HEIGHT = 16_000

/** TEMP_CODE_CHROME, else the newest chrome-headless-shell Playwright cached. */
export function chromePath(env: NodeJS.ProcessEnv = process.env, cache = join(homedir(), '.cache/ms-playwright')): string | null {
  if (env.TEMP_CODE_CHROME) return existsSync(env.TEMP_CODE_CHROME) ? env.TEMP_CODE_CHROME : null
  if (!existsSync(cache)) return null
  const builds = readdirSync(cache).filter((dir) => dir.startsWith('chromium_headless_shell-')).sort().reverse()
  for (const build of builds) {
    const binary = join(cache, build, 'chrome-headless-shell-linux64/chrome-headless-shell')
    if (existsSync(binary)) return binary
  }
  return null
}

/** One PNG per width, each as tall as the page's content: a first load with a
 *  script that writes the content height into the DOM it dumps, then the shot. */
export async function screenshots(chrome: string, html: string, stem: string, widths: number[]): Promise<string[]> {
  const shotPage = html.replace('<body>', '<body class="preview-shot">')
  const pagePath = `${stem}.shot.html`
  const measurePath = `${stem}.measure.html`
  await writeFile(pagePath, shotPage)
  await writeFile(measurePath, shotPage.replace('</body>', '<script>document.body.dataset.height = String(Math.ceil(document.documentElement.scrollHeight))</script></body>'))
  const flags = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars']
  const shots: string[] = []
  for (const width of widths) {
    const dump = spawnSync(chrome, [...flags, '--dump-dom', '--virtual-time-budget=2000', `--window-size=${width},800`, pathToFileURL(measurePath).href], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
    // A page's markup can pass spawnSync's 1 MiB default: the height was then never read and every tall page was cut at 800.
    const height = Math.min(MAX_SHOT_HEIGHT, Number(dump.stdout.match(/data-height="(\d+)"/)?.[1] ?? 800))
    const png = `${stem}.${width}.png`
    const shot = spawnSync(chrome, [...flags, `--screenshot=${png}`, `--window-size=${width},${height}`, pathToFileURL(pagePath).href], { encoding: 'utf8', timeout: 60_000 })
    if (shot.status !== 0 || !existsSync(png)) throw new Error(`Chrome could not shoot ${png}: ${shot.stderr.trim().split('\n').at(-1) ?? ''}`)
    shots.push(png)
  }
  await rm(measurePath, { force: true })
  return shots
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
