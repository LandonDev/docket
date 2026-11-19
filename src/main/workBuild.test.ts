import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { build as viteBuild } from 'vite'
import config, { HOSTED_BASE, HOSTED_PAGES, MAIN_INPUTS, hostedBuildConfig, hostedPages } from '../../electron.vite.config'

/**
 * Work's two build entries (docs/agents/work.md): the Work service's bundle
 * beside the other utility processes, and the hosted pages' own build. Both
 * stand on stubs, so the milestones that fill them edit no build config.
 */

const out = mkdtempSync(join(tmpdir(), 'tc-hosted-'))
afterAll(() => rmSync(out, { recursive: true, force: true }))

describe('the Work service entry', () => {
  it('is an input of the main bundle, beside the gateway and the add-on host, and its file exists', () => {
    expect(Object.keys(MAIN_INPUTS)).toEqual(['index', 'boot', 'gateway', 'statsWorker', 'execBroker', 'addonHost', 'workService', 'sheetWorker'])
    expect(MAIN_INPUTS.workService).toBe(resolve('src/main/workServiceProcess.ts'))
    for (const file of Object.values(MAIN_INPUTS)) expect(existsSync(file), file).toBe(true)
    const main = (config as { main: { build: { rollupOptions: { input: unknown } } } }).main
    expect(main.build.rollupOptions.input).toBe(MAIN_INPUTS)
  })
  it('bundles into workService.js', async () => {
    // The entry alone, through the bundler the app's build uses, in the shape electron-vite gives the main bundle (CommonJS, `<entry>.js`).
    const dir = join(out, 'main')
    await viteBuild({ configFile: false, logLevel: 'warn', build: { ssr: true, outDir: dir, emptyOutDir: true, rollupOptions: { input: { workService: MAIN_INPUTS.workService }, output: { format: 'cjs', entryFileNames: '[name].js' } } } })
    expect(readdirSync(dir)).toEqual(['workService.js'])
    expect(readFileSync(join(dir, 'workService.js'), 'utf8')).toContain('the Work service runs only as a utility process')
  }, 120_000)
  it('builds the sheet worker as its own entry, which the server finds at run time (no bundler-specific import)', async () => {
    expect(MAIN_INPUTS.sheetWorker).toBe(resolve('src/main/server/work/sheets/worker.ts'))
    const dir = join(out, 'sheet')
    await viteBuild({ configFile: false, logLevel: 'warn', resolve: { alias: { '@shared': resolve('src/shared') } }, build: { ssr: true, outDir: dir, emptyOutDir: true, rollupOptions: { external: (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('@shared') && !id.includes('/src/'), input: { sheetWorker: MAIN_INPUTS.sheetWorker }, output: { format: 'cjs', entryFileNames: '[name].js' } } } })
    expect(readdirSync(dir)).toContain('sheetWorker.js')
    expect(readFileSync(join(dir, 'sheetWorker.js'), 'utf8')).toContain('the sheet worker runs only as a utility process')
    const spawn = readFileSync(resolve('src/main/server/work/sheets/spawnWorker.ts'), 'utf8')
    expect(spawn).toContain("'sheetWorker.js'")
    expect(spawn).not.toMatch(/\?(modulePath|worker|url|raw|asset)['"]/)
  }, 120_000)
  it('is the service itself (milestone 18): what it may import is held by work/service/boundary.test.ts', () => {
    const source = readFileSync(MAIN_INPUTS.workService, 'utf8')
    expect(source).toContain("from './server/work/service/serve'")
    expect(source).not.toContain('not built')
  })
})

describe('the hosted pages', () => {
  it('are a closed list of entries, each a file that exists, built apart from the window', () => {
    expect([...HOSTED_PAGES]).toEqual(['index', 'item', 'guest', 'form'])
    const build = hostedBuildConfig(out)
    expect(build.root).toBe(resolve('src/hosted'))
    expect(build.base).toBe(HOSTED_BASE)
    expect(build.configFile).toBe(false)
    const input = build.build!.rollupOptions!.input as Record<string, string>
    expect(Object.keys(input)).toEqual([...HOSTED_PAGES])
    for (const file of Object.values(input)) expect(existsSync(file), file).toBe(true)
    const renderer = (config as { renderer: { plugins: { name?: string }[] } }).renderer
    expect(renderer.plugins.flat().map((p) => p?.name)).toContain('temp-code-hosted-pages')
  })
  it('build one page per entry: the stubs say which milestone builds them and load no script; a built page loads its own from the shared assets', async () => {
    const plugin = hostedPages(join(out, 'hosted'))
    expect(plugin.apply).toBe('build')
    await (plugin.closeBundle as () => Promise<void>).call({})
    // `assets` is Vite's one folder for every page's scripts and styles, served under HOSTED_BASE on the page's own origin.
    // `scheme.js` is the guest page's one script outside them (src/hosted/public): it runs before the stylesheet.
    expect(readdirSync(join(out, 'hosted')).sort()).toEqual(['assets', 'form', 'guest', 'index.html', 'item', 'scheme.js'])
    // The form page (milestone 36) and the guest page (milestone 31, also the owner's /w/open) are built:
    // their scripts and stylesheets only, from the assets, under a CSP of their own origin.
    for (const page of ['form', 'guest']) {
      const html = readFileSync(join(out, 'hosted', page, 'index.html'), 'utf8')
      const loads = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
      expect(loads.length, page).toBeGreaterThanOrEqual(page === 'form' ? 2 : 1)
      for (const url of loads) expect(url.startsWith(`${HOSTED_BASE}assets/`) || (page === 'guest' && url === `${HOSTED_BASE}scheme.js`), url).toBe(true)
      for (const url of loads) expect(existsSync(join(out, 'hosted', url.slice(HOSTED_BASE.length))), url).toBe(true)
      expect(html, page).toContain("script-src 'self'")
      expect(html, page).not.toContain('Not built')
    }
    // A light viewer never starts dark: the guest page's scheme script is a plain one, so it runs
    // before the stylesheet paints, and it sets the light class from the viewer's system alone.
    const guest = readFileSync(join(out, 'hosted', 'guest', 'index.html'), 'utf8')
    const early = guest.indexOf(`<script src="${HOSTED_BASE}scheme.js"></script>`)
    expect(early).toBeGreaterThan(-1)
    expect(early).toBeLessThan(guest.indexOf('rel="stylesheet"'))
    expect(early).toBeLessThan(guest.indexOf('type="module"'))
    const html = { classList: new Set<string>() }
    const run = (dark: boolean): boolean => {
      html.classList.clear()
      new Function('window', 'document', readFileSync(join(out, 'hosted', 'scheme.js'), 'utf8'))(
        { matchMedia: (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && dark }) },
        { documentElement: { classList: { add: (name: string) => html.classList.add(name) } } }
      )
      return html.classList.has('theme-light')
    }
    expect(run(false)).toBe(true)
    expect(run(true)).toBe(false)
    // The item entry stays a plain page: /w/open serves the guest page, which reads its own address.
    const item = readFileSync(join(out, 'hosted', 'item', 'index.html'), 'utf8')
    expect(item).not.toContain('<script')
    expect(item).not.toContain('Not built')
    expect(item).toContain("default-src 'none'")
    // The index is the service's own (milestone 18): a plain page that runs nothing.
    const index = readFileSync(join(out, 'hosted', 'index.html'), 'utf8')
    expect(index).not.toContain('<script')
    expect(index).not.toContain('Not built')
    expect(index).toContain("default-src 'none'")
  }, 120_000)
})
