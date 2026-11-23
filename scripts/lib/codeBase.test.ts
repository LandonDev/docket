import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_PARTS } from '../../src/main/codeChoice'
import { BOOT_SOURCES, BUNDLE_SHAPE, codeBase, hashFiles, isBesideScript, stablePackage } from './codeBase'

const ROOT = resolve(__dirname, '../..')

/** Every local module a file imports, followed to the end. */
function closure(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen
  seen.add(entry)
  const text = readFileSync(join(ROOT, entry), 'utf8')
  for (const m of text.matchAll(/from '(\.[^']+)'/g)) closure(join(dirname(entry), `${m[1]}.ts`), seen)
  return seen
}

describe('the base stamp', () => {
  it('the boot part is made of exactly what boot.ts imports', () => {
    expect([...closure('src/main/boot.ts')].sort()).toEqual([...BOOT_SOURCES].sort())
  })

  it('boot.ts imports nothing but Electron, node and its own files', () => {
    for (const file of BOOT_SOURCES) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      const from = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1])
      for (const spec of from) expect(spec === 'electron' || spec.startsWith('node:') || spec.startsWith('./'), `${file} imports ${spec}`).toBe(true)
    }
  })

  it('holds the package.json fields Electron reads, and none a release or a new script changes', () => {
    const pkg = { name: 'temp-code', version: '1.0.1', main: './out/main/boot.js', scripts: { a: 'b' }, dependencies: { x: '1' } }
    const same = { ...pkg, version: '1.0.2', scripts: { a: 'b', c: 'd' }, dependencies: { x: '2' }, tempcodeBuild: { sha: 'x' }, tempcodeHarness: {} }
    expect(stablePackage(JSON.stringify(same))).toBe(stablePackage(JSON.stringify(pkg)))
    expect(stablePackage(JSON.stringify({ ...pkg, main: './out/main/index.js' }))).not.toBe(stablePackage(JSON.stringify(pkg)))
    expect(stablePackage(JSON.stringify({ ...pkg, name: 'other' }))).not.toBe(stablePackage(JSON.stringify(pkg)))
  })

  it('hashes a list of files by path and bytes, in any order', () => {
    const files: Record<string, string> = { '/r/a': 'one', '/r/b': 'two' }
    const read = (path: string): Buffer => Buffer.from(files[path])
    const first = hashFiles('/r', ['a', 'b'], read)
    expect(hashFiles('/r', ['b', 'a'], read)).toBe(first)
    files['/r/b'] = 'changed'
    expect(hashFiles('/r', ['a', 'b'], read)).not.toBe(first)
    // the same bytes under another name are another tree
    files['/r/b'] = 'two'
    files['/r/c'] = 'two'
    expect(hashFiles('/r', ['a', 'c'], read)).not.toBe(first)
  })

  it('counts the scripts the bundle ships and the code can run', () => {
    expect(isBesideScript('scripts/app-mcp-bridge.mjs')).toBe(true)
    expect(isBesideScript('scripts/box/tc-local.mjs')).toBe(true)
    expect(isBesideScript('scripts/lib/skillsDriversNetwork.cjs')).toBe(true)
    expect(isBesideScript('scripts/release.ts')).toBe(false)
    expect(isBesideScript('scripts/release-publish.sh')).toBe(false)
    expect(isBesideScript('scripts/.out/e2e.mjs')).toBe(false)
  })

  it('stamps this tree with every part, the same twice', () => {
    const base = codeBase(ROOT)
    expect(base).not.toBeNull()
    expect(Object.keys(base!).sort()).toEqual([...BASE_PARTS].sort())
    expect(base!.electron).toMatch(/^\d+\.\d+\.\d+/)
    for (const part of ['lock', 'beside', 'native', 'boot'] as const) expect(base![part]).toMatch(/^[0-9a-f]{64}$/)
    expect(codeBase(ROOT)).toEqual(base)
  })

  it('holds the files that shape the signed bundle', () => {
    expect([...BUNDLE_SHAPE]).toEqual(['electron-builder.yml', 'build/entitlements.mac.plist'])
    for (const file of BUNDLE_SHAPE) expect(readFileSync(join(ROOT, file), 'utf8').length).toBeGreaterThan(0)
  })

  it('a tree with no git has no stamp', () => {
    expect(codeBase('/nonexistent-tree')).toBeNull()
  })
})
