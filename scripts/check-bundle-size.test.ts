import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { badJsxTags, checkBundle, scanAssets } from './check-bundle-size'
import type { BundleMap } from './bundle-map'

describe('badJsxTags', () => {
  it('names a lowercase component binding inlined into a JSX tag', () => {
    expect(badJsxTags('jsx("current", { ...props })')).toEqual(['current'])
    expect(badJsxTags('jsxs("current", {})')).toEqual(['current'])
    expect(badJsxTags('React.createElement("current", null)')).toEqual(['current'])
  })

  it('passes HTML, SVG in any case, custom elements and component references', () => {
    const source = [
      'jsx("div", {})',
      'jsxs("svg", {})',
      'jsx("foreignObject", {})',
      'jsx("linearGradient", {})',
      'jsx("my-widget", {})',
      'jsx(Current, {})',
      'createElement("documentmock", NS.HTML, [])',
    ].join(';')
    expect(badJsxTags(source)).toEqual([])
  })

  it('names each bad tag once', () => {
    expect(badJsxTags('jsx("current");jsx("current");jsx("lazy")')).toEqual(['current', 'lazy'])
  })
})

describe('checkBundle', () => {
  const map: BundleMap = {
    chunks: {
      'assets/index-a.js': { type: 'chunk', entry: true, bytes: 1024, imports: [], dynamicImports: [], modules: {} },
    },
  }

  it('fails a bundle whose chunk renders a bad tag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-bundle-'))
    try {
      writeFileSync(join(dir, 'index-a.js'), 'jsx("current", {})')
      writeFileSync(join(dir, 'other-b.js'), 'jsx("div", {})')
      const verdict = checkBundle(map, 4096, scanAssets(dir))
      expect(verdict.ok).toBe(false)
      expect(verdict.badTags).toEqual(['index-a.js: current'])
      expect(verdict.lines.at(-1)).toContain('renders "current" as a DOM tag')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes a clean bundle', () => {
    expect(checkBundle(map, 4096, []).ok).toBe(true)
  })

  const withModule = (id: string): BundleMap => ({
    chunks: { 'assets/index-a.js': { type: 'chunk', entry: true, bytes: 1024, imports: ['assets/shared-b.js'], dynamicImports: ['assets/work-canvas-c.js'], modules: {} }, 'assets/shared-b.js': { type: 'chunk', entry: false, bytes: 10, imports: [], dynamicImports: [], modules: { [id]: 10 } } },
  })

  it('fails when a lazy surface is in the first paint', () => {
    const verdict = checkBundle(withModule('/repo/src/renderer/src/surfaces/SettingsView.tsx'), 4096, [])
    expect(verdict.ok).toBe(false)
    expect(verdict.leaked).toEqual(['src/renderer/src/surfaces/SettingsView.tsx (in assets/shared-b.js)'])
  })

  it('fails when anything of Work is in the first paint', () => {
    for (const id of [
      '/repo/src/renderer/src/work/canvas/CanvasPane.tsx',
      '/repo/src/shared/work/canvas.ts',
      '/repo/src/shared/contract-work.ts',
      '/repo/src/shared/contract-work-mail.ts',
      '/repo/node_modules/work-kit/src/ui/button.tsx',
    ]) {
      const verdict = checkBundle(withModule(id), 4096, [])
      expect(verdict.ok, id).toBe(false)
      expect(verdict.leaked[0], id).toContain(id.slice('/repo/'.length))
    }
  })

  it('lets Work ride a lazy chunk', () => {
    const map = withModule('/repo/src/renderer/src/lib/session.ts')
    map.chunks['assets/work-canvas-c.js'] = { type: 'chunk', entry: false, bytes: 10, imports: [], dynamicImports: [], modules: { '/repo/src/renderer/src/work/canvas/CanvasPane.tsx': 10 } }
    expect(checkBundle(map, 4096, []).ok).toBe(true)
  })
})
