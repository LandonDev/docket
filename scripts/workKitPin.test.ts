// The work-kit pin (docs/agents/work-kit.md): one commit in the one form bun can
// fetch from a private repo, a lock fit to host the shared code, its source kept
// out of the public app, and the interface version this tree was built for.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WORK_KIT_API } from 'work-kit/api'
import { lockProblems, pinnedCommit } from 'work-kit/guards'
import { KitProbe } from 'work-kit/ui/kit-probe'

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
    expect(WORK_KIT_API).toBe(1)
  })

  it('pins the same commit in the phone app when the phone app pins it', () => {
    const project = read('ios/TempCode/project.yml')
    const revision = /work-kit[\s\S]*?revision:\s*"?([0-9a-f]{40})/i.exec(project)?.[1]
    if (revision) expect(revision).toBe(pinnedCommit(spec))
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

describe('the renderer', () => {
  it('has Tailwind read the package, which it skips under node_modules', () => {
    expect(read('src/renderer/src/index.css')).toContain('@source "../../../node_modules/work-kit/src";\n')
  })

  it('renders a component from work-kit/ui', () => {
    const html = renderToStaticMarkup(createElement(KitProbe, { label: 'Pinned' }))
    expect(html).toContain('data-slot="kit-probe"')
    expect(html).toContain('Pinned')
  })
})
