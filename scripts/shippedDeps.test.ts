// What the packaged app ships of node_modules (electron-builder.yml, docs/agents/releases.md):
// package.json's `dependencies` and their own, nothing else. The main and preload builds leave
// exactly those packages outside out/ (electron.vite.config.ts externalizeDepsPlugin) and compile
// in every other import, so a package main needs at run time but that sits in devDependencies is
// missing from the app, and a library moved back into `dependencies` puts thousands of files in
// front of the signer (36,467 files took 3m42s to sign in 1.0.363).
import { builtinModules } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, matchesGlob, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}
const shipped = new Set(Object.keys(pkg.dependencies))

/** Packages main imports that electron-vite compiles into out/main, and why that is safe. */
const COMPILED_IN: Record<string, string> = {
  'aliax-core': 'excluded from externalizing in electron.vite.config.ts',
  '@muse-code/sdk': 'excluded from externalizing in electron.vite.config.ts',
  'work-kit': 'private source, excluded from externalizing; its folder never ships',
  '@modelcontextprotocol/sdk': 'plain JS, bundled',
  convex: 'plain JS client, bundled',
  fflate: 'plain JS, bundled',
  yjs: 'plain JS, bundled',
  '@univerjs/core': 'plain JS, bundled into the sheet worker',
  '@univerjs/sheets-table': 'plain JS, bundled into the sheet worker'
}

/** Requires inside compiled-in code that sit in try/catch and work without the package. */
const OPTIONAL = new Set(['ajv', 'ajv-formats', 'utf-8-validate', 'bufferutil'])

/** The node_modules files counted below: 1,300 on 2026-11-23, 34,414 before in 1.0.363. Raise it only with a reason. */
const FILE_BUDGET = 1600

const builtin = (name: string): boolean =>
  name === 'electron' || name.startsWith('node:') || builtinModules.includes(name)
const packageOf = (spec: string): string =>
  spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, keep, out)
    else if (keep(path)) out.push(path)
  }
  return out
}

const sources = ['src/main', 'src/preload'].flatMap((dir) =>
  walk(join(root, dir), (f) => /\.(ts|mts|js|mjs)$/.test(f) && !/\.test\.|\.d\.ts$|\/fixtures\//.test(f))
).map((file) => ({ file: relative(root, file), text: readFileSync(file, 'utf8') }))
  // Test doubles that load under vitest alone.
  .filter(({ text }) => !/from ['"]vitest['"]/.test(text))

const IMPORT = /^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|(?<![.\w])import\(\s*['"]([^'"]+)['"]\s*\)|(?<![.\w])require\(\s*['"]([^'"]+)['"]\s*\)/gm
/** Every import, types too: its specifier names a module, not a file read at run time. */
const ANY_IMPORT = /^\s*(?:import|export)\b[^'"]*?from\s+['"][^'"]+['"]|(?<![.\w])import\(\s*['"][^'"]+['"]\s*\)/gm

describe('the packages the app ships', () => {
  it('cover every package main and preload import, or the import is compiled in', () => {
    const unshipped = new Set<string>()
    for (const { file, text } of sources) {
      for (const m of text.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
        if (/^[./]|^@(shared|server|renderer)\//.test(spec) || builtin(packageOf(spec))) continue
        const name = packageOf(spec)
        if (!shipped.has(name) && !(name in COMPILED_IN)) unshipped.add(`${name} (${file})`)
      }
    }
    expect([...unshipped]).toEqual([])
  })

  it('cover every package main reads a file of by path', () => {
    // require.resolve('pkg/bin/x.js'), req('pkg/manifest.json'), the `node-pty/prebuilds/…` paths:
    // a bundler leaves these as strings, so the package must be in node_modules at run time.
    const read = new Set<string>()
    for (const { text } of sources) {
      for (const m of text.replace(ANY_IMPORT, '').matchAll(/['"`]((?:@[\w.-]+\/)?[a-z][\w.-]*)\/[^'"`\s]*\.(?:js|json|node)['"`]/g)) {
        if (existsSync(join(root, 'node_modules', m[1], 'package.json'))) read.add(m[1])
      }
    }
    expect(read.size).toBeGreaterThan(0)
    expect([...read].filter((name) => !shipped.has(name))).toEqual([])
  })

  it.skipIf(!existsSync(join(root, 'out/main')))('cover every require left in the built main and preload', () => {
    const missing = new Set<string>()
    for (const file of ['out/main', 'out/preload'].flatMap((d) => walk(join(root, d), (f) => f.endsWith('.js')))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\b(?:require|__require)\(\s*"((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?:\/[^"]*)?"\s*\)/g)) {
        if (!builtin(m[1]) && !shipped.has(m[1]) && !OPTIONAL.has(m[1])) missing.add(m[1])
      }
    }
    expect([...missing]).toEqual([])
  })

  it(`hold the files copied from node_modules under ${FILE_BUDGET}`, () => {
    expect(shippedFiles().length).toBeLessThanOrEqual(FILE_BUDGET)
  })
})

/**
 * The files electron-builder copies from node_modules on the Mac: the production closure of
 * `dependencies` (optional ones left out, so the count is the same on every host), less its
 * default exclusions (app-builder-lib NodeModuleCopyHelper) and the negations in electron-builder.yml.
 */
function shippedFiles(): string[] {
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  const files = yml.slice(yml.indexOf('\nfiles:') + 1).split(/\n(?=[a-z])/)[0]
  const negations = [...files.matchAll(/^\s*-\s*'!([^']+)'/gm)].map((m) => m[1])
  const names = new Set(['.DS_Store', 'node_modules', 'CHANGELOG.md', 'ChangeLog', 'changelog.md', 'Changelog.md',
    'Changelog', 'binding.gyp', '.npmignore', 'node_gyp_bins', '.git', '.github', '.gitignore', '.gitattributes',
    '.eslintrc', '.travis.yml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml'])
  const topLevel = new Set(['README.md', 'readme.md', 'Readme.md', 'README', 'readme', 'readme.markdown',
    'test', 'tests', '__tests__', 'example', 'examples', '.bin', 'karma.conf.js', '.coveralls.yml'])
  const exts = ['iml', 'hprof', 'orig', 'pyc', 'pyo', 'rbc', 'swp', 'csproj', 'sln', 'suo', 'xproj', 'cc', 'd.ts',
    'mk', 'a', 'o', 'obj', 'forge-meta', 'pdb', 'dll', 'exe'].map((ext) => `.${ext}`)

  const dirs = new Map<string, string>()
  const visit = (name: string, from: string): void => {
    let dir = from
    for (;;) {
      const candidate = join(dir, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) break
      if (dir === root) return
      dir = dirname(dir)
    }
    const found = join(dir, 'node_modules', name)
    if (dirs.has(found)) return
    dirs.set(found, name)
    const own = JSON.parse(readFileSync(join(found, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    for (const dep of Object.keys(own.dependencies ?? {})) visit(dep, found)
  }
  for (const name of shipped) visit(name, root)

  const out: string[] = []
  for (const top of dirs.keys()) {
    const copy = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (names.has(entry.name) || entry.name.startsWith('._')) continue
        if (dir === top && topLevel.has(entry.name)) continue
        const rel = relative(root, path)
        if (negations.some((glob) => matchesGlob(rel, glob))) continue
        if (entry.isDirectory()) copy(path)
        else if (!exts.some((ext) => entry.name.endsWith(ext)) && statSync(path).isFile()) out.push(rel)
      }
    }
    copy(top)
  }
  return out
}
