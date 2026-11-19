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
    expect(Object.keys(MAIN_INPUTS)).toEqual(['index', 'boot', 'gateway', 'statsWorker', 'execBroker', 'addonHost', 'workService'])
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
    expect(readdirSync(join(out, 'hosted')).sort()).toEqual(['assets', 'form', 'guest', 'index.html', 'item'])
    const pages = { 'item/index.html': 31, 'guest/index.html': 31 }
    for (const [page, milestone] of Object.entries(pages)) {
      const html = readFileSync(join(out, 'hosted', page), 'utf8')
      expect(html, page).toContain(`(milestone ${milestone})`)
      expect(html, page).toContain('Not built: ')
      expect(html, page).not.toContain('<script')
      expect(html, page).toContain("default-src 'none'")
    }
    // The form page (milestone 36) is built: its script and stylesheet only, from the assets, under a CSP of its own origin.
    const form = readFileSync(join(out, 'hosted', 'form', 'index.html'), 'utf8')
    const loads = [...form.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    expect(loads.length).toBeGreaterThanOrEqual(2)
    for (const url of loads) expect(url.startsWith(`${HOSTED_BASE}assets/`), url).toBe(true)
    for (const url of loads) expect(existsSync(join(out, 'hosted', url.slice(HOSTED_BASE.length))), url).toBe(true)
    expect(form).toContain("script-src 'self'")
    expect(form).not.toContain('Not built')
    // The index is the service's own (milestone 18): a plain page that runs nothing.
    const index = readFileSync(join(out, 'hosted', 'index.html'), 'utf8')
    expect(index).not.toContain('<script')
    expect(index).not.toContain('Not built')
    expect(index).toContain("default-src 'none'")
  }, 120_000)
})
