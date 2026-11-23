import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILD_HEAP_ENV, BUILD_HEAP_MB, heapRerunArgs, type HeapProcess } from './buildHeap'

const GB = 1024 * 1024 * 1024
const build = (over: Partial<HeapProcess> = {}): HeapProcess => ({
  argv: ['/usr/bin/node', '/repo/node_modules/electron-vite/bin/electron-vite.js', 'build'],
  execArgv: [],
  env: {},
  heapLimit: 4 * GB,
  bun: false,
  ...over
})

describe("the build's heap", () => {
  it('gives the renderer twice what it was measured to need', () => {
    expect(BUILD_HEAP_MB).toBeGreaterThanOrEqual(8192)
  })

  it('runs a build under the default heap again with the limit, keeping its arguments', () => {
    expect(heapRerunArgs(build({ argv: ['node', '/r/node_modules/.bin/electron-vite', 'build', '--mode', 'production'] }))).toEqual([
      `--max-old-space-size=${BUILD_HEAP_MB}`,
      '/r/node_modules/.bin/electron-vite',
      'build',
      '--mode',
      'production'
    ])
  })

  it("replaces a smaller limit the caller passed and keeps node's other flags", () => {
    expect(heapRerunArgs(build({ execArgv: ['--max-old-space-size=2048', '--enable-source-maps'] }))?.slice(0, 2)).toEqual([
      '--enable-source-maps',
      `--max-old-space-size=${BUILD_HEAP_MB}`
    ])
  })

  it('leaves a process that already has the room, the rerun itself, bun, dev and anything not electron-vite alone', () => {
    expect(heapRerunArgs(build({ heapLimit: 12 * GB }))).toBeNull()
    expect(heapRerunArgs(build({ env: { [BUILD_HEAP_ENV]: '8192' } }))).toBeNull()
    expect(heapRerunArgs(build({ bun: true }))).toBeNull()
    expect(heapRerunArgs(build({ argv: ['node', '/r/node_modules/electron-vite/bin/electron-vite.js', 'dev'] }))).toBeNull()
    expect(heapRerunArgs(build({ argv: ['node', '/r/node_modules/vitest/vitest.mjs', 'build'] }))).toBeNull()
  })

  // Every caller (bun run build, the gate, release-publish.sh, box-update, the Windows build, the proofs)
  // starts electron-vite on this config; the limit holds only while the config asks first.
  it('is asked by the config every build loads, before its own export', () => {
    expect(readFileSync('electron.vite.config.ts', 'utf8')).toMatch(/^export default buildHeapHold\(\(\) => buildHosted\(\)\) \?\? defineConfig\(\{/m)
  })

  it("leaves the hosted pages to the rerun's parent, so they never build beside the renderer's memory", async () => {
    const { hostedPages } = await import('../../electron.vite.config')
    const close = hostedPages().closeBundle as () => unknown
    process.env[BUILD_HEAP_ENV] = String(BUILD_HEAP_MB)
    try {
      expect(close()).toBeUndefined()
    } finally {
      delete process.env[BUILD_HEAP_ENV]
    }
  })

  it('reaches every caller: none starts electron-vite build on another config', () => {
    const callers = ['package.json', 'scripts/gate.ts', 'scripts/release-publish.sh', 'scripts/box/box-update-lib.sh', 'scripts/e2e-updater-win.ts']
    for (const file of callers) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).toMatch(/electron-vite['",]*\s*\[?['"]?build/)
      expect(text, file).not.toMatch(/electron-vite['",]*\s*\[?['"]?build['"]?,?\s*['"]?(-c|--config)\b/)
    }
  })
})
