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
  it('bundles from the stub into workService.js', async () => {
    // The entry alone, through the bundler the app's build uses, in the shape electron-vite gives the main bundle (CommonJS, `<entry>.js`).
    const dir = join(out, 'main')
    await viteBuild({ configFile: false, logLevel: 'warn', build: { ssr: true, outDir: dir, emptyOutDir: true, rollupOptions: { input: { workService: MAIN_INPUTS.workService }, output: { format: 'cjs', entryFileNames: '[name].js' } } } })
    expect(readdirSync(dir)).toEqual(['workService.js'])
    expect(readFileSync(join(dir, 'workService.js'), 'utf8')).toContain('not built: the Work service (milestone 18)')
  }, 120_000)
  it('is a stub that says so and serves nothing', () => {
    const source = readFileSync(MAIN_INPUTS.workService, 'utf8')
    expect(source).toContain("console.error('not built: the Work service (milestone 18)')")
    expect(source).toContain('process.exit(1)')
    expect(source).not.toMatch(/\bimport\b/)
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
  it('build from the stubs: one page per entry, each saying which milestone builds it, none loading a script', async () => {
    const plugin = hostedPages(join(out, 'hosted'))
    expect(plugin.apply).toBe('build')
    await (plugin.closeBundle as () => Promise<void>).call({})
    expect(readdirSync(join(out, 'hosted')).sort()).toEqual(['form', 'guest', 'index.html', 'item'])
    const pages = { 'index.html': 18, 'item/index.html': 31, 'guest/index.html': 31, 'form/index.html': 36 }
    for (const [page, milestone] of Object.entries(pages)) {
      const html = readFileSync(join(out, 'hosted', page), 'utf8')
      expect(html, page).toContain(`(milestone ${milestone})`)
      expect(html, page).toContain('Not built: ')
      expect(html, page).not.toContain('<script')
      expect(html, page).toContain("default-src 'none'")
    }
  }, 120_000)
})
