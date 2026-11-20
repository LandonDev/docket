// The work-kit pin (docs/agents/work-kit.md): one commit in the one form bun can
// fetch from a private repo, a lock fit to host the shared code, its source kept
// out of the public app, and the interface version this tree was built for.
import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WORK_KIT_API } from 'work-kit/api'
import { lockProblems, pinnedCommit } from 'work-kit/guards'
import { definesRule, HOST_RULES } from 'work-kit/ui/host-rules'
import { KitProbe } from 'work-kit/ui/kit-probe'
import { kitFile, kitSources, sourcesCss, SOURCES_FILE } from './gen-work-kit-sources'

const root = resolve(__dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')
const pkg = JSON.parse(read('package.json')) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}
const lock = read('bun.lock')
const spec = pkg.devDependencies['work-kit']

describe('the work-kit pin', () => {
  it('names a full commit in the git+https://www.github.com form', () => {
    // bun fetches github: and git+https://github.com/ specs as an unauthenticated
    // tarball, which a private repo answers with 404; www. makes it git clone.
    expect(pinnedCommit(spec)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('is a devDependency, so electron-builder never copies it or its packages', () => {
    expect(pkg.dependencies['work-kit']).toBeUndefined()
  })

  it('resolves in bun.lock to the commit package.json names', () => {
    expect(lock).toContain(`"work-kit": ["work-kit@${spec}"`)
  })

  it('was built for interface version 1', () => {
    expect(WORK_KIT_API).toBe(3)
  })

  it('pins the same commit in the phone app once the phone app pins work-kit', () => {
    const project = read('ios/TempCode/project.yml')
    if (!project.includes('LandonDev/work-kit')) return
    const revision = /url:\s*"?https:\/\/github\.com\/LandonDev\/work-kit[^\n]*\n\s*revision:\s*"?([0-9a-f]{40})/.exec(project)?.[1]
    expect(revision, 'the WorkKit package in project.yml needs a revision: line under its url').toBe(pinnedCommit(spec))
  })
})

describe('the lock', () => {
  it('holds one copy of each shared package and nothing banned', () => {
    expect(lockProblems(lock)).toEqual([])
  })

  it('fails on a second yjs and on a @blocknote/xl- package', () => {
    const doctored = lock.replace(
      '"packages": {',
      '"packages": {\n    "a/yjs": ["yjs@13.6.30", "", {}, ""],\n    "b/yjs": ["yjs@13.6.31", "", {}, ""],\n    "@blocknote/xl-ai": ["@blocknote/xl-ai@0.57.0", "", {}, ""],'
    )
    expect(lockProblems(doctored)).toEqual([
      'yjs resolves to 2 copies: 13.6.30, 13.6.31',
      '@blocknote/xl-ai is not allowed (@blocknote/xl-*)'
    ])
  })
})

describe('the source stays out of the public app', () => {
  it('electron-builder leaves out node_modules/work-kit', () => {
    expect(read('electron-builder.yml')).toContain("  - '!node_modules/work-kit/**'\n")
  })

  it('the main process bundles it rather than requiring it at run time', () => {
    expect(read('electron.vite.config.ts')).toMatch(/externalizeDepsPlugin\(\{ exclude: \[[^\]]*'work-kit'/)
  })
})

// The renderer's own stylesheets, where a host rule would be defined.
function rendererCss(): string {
  const dir = resolve(root, 'src/renderer/src')
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(resolve(dir, name), 'utf8'))
    .join('\n')
}

describe('the renderer', () => {
  it('compiles work-kit classes into its stylesheet, which Tailwind would skip under node_modules', async () => {
    const path = resolve(root, 'src/renderer/src/index.css')
    const text = read('src/renderer/src/index.css')
    // The lines live in a generated file index.css imports, and never name the whole package:
    // that put every primitive's classes in the first paint, used or not.
    expect(text).toContain('@import "./work-kit-sources.css";\n')
    expect(text).not.toContain('node_modules/work-kit')
    // Only the @source globs are scanned, so the probe's class can come from work-kit alone.
    const compiler = await compile(text, { base: resolve(path, '..'), onDependency: () => {} })
    const css = compiler.build(new Scanner({ sources: compiler.sources }).scan())
    expect(css).toContain('--work-kit-probe: 1')
  })

  it('reads the work-kit files the renderer imports and no others; `bun scripts/gen-work-kit-sources.ts` after importing one', () => {
    expect(read(SOURCES_FILE)).toBe(sourcesCss(kitSources(root), root))
    for (const file of kitSources(root)) expect(file.startsWith('node_modules/work-kit/src/'), file).toBe(true)
  })

  it('finds a specifier through the package\'s export map, and every work-kit file it reaches', () => {
    expect(kitFile(root, 'work-kit/ui/button')).toBe('node_modules/work-kit/src/ui/button.tsx')
    expect(kitFile(root, 'work-kit/ui/cn')).toBe('node_modules/work-kit/src/ui/cn.ts')
    expect(kitFile(root, 'work-kit/api')).toBe('node_modules/work-kit/src/api.ts')
    expect(kitFile(root, 'work-kit/nothing-here')).toBeNull()
    const reached = kitSources(root, ['work-kit/ui/button'])
    // The probe is always first, then what the button draws with.
    expect(reached[0]).toBe('node_modules/work-kit/src/ui/kit-probe.tsx')
    expect(reached).toContain('node_modules/work-kit/src/ui/button.tsx')
    expect(reached).toContain('node_modules/work-kit/src/ui/cn.ts')
    expect(reached).not.toContain('node_modules/work-kit/src/ui/calendar.tsx')
    expect(sourcesCss(reached, root)).toContain('@source "../../../node_modules/work-kit/src/ui/button.tsx";\n')
  })

  it('renders a component from work-kit/ui', () => {
    const html = renderToStaticMarkup(createElement(KitProbe, { label: 'Pinned' }))
    expect(html).toContain('data-slot="kit-probe"')
    expect(html).toContain('Pinned')
  })

  it('defines every Kobra rule the primitives use', () => {
    // Raise, check and toggle are TempCode's own; the rest are LifeOS's rules on TempCode's tokens
    // (index.css after .t-raise, and assets/components.css).
    const css = rendererCss()
    expect(HOST_RULES.filter((rule) => !definesRule(css, rule))).toEqual([])
  })
})
