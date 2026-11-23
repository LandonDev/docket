import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MANIFEST_FILE, parseManifest, sha256File, type CodeBase } from '../../src/main/codeChoice'
import { PACK_MANIFEST, PACK_TARBALL as OFFER_TARBALL } from '../../src/main/server/codeOffer'
import { PACK_TARBALL, entryFiles, packCode, packRefusal } from './codePack'

const BASE: CodeBase = { electron: '39.8.10', lock: 'l'.repeat(64), beside: 'b'.repeat(64), native: 'n'.repeat(64), boot: 'o'.repeat(64) }
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

let root: string

/** A built tree: out/ with its entries, a chunk, a source map and the bundle map. */
function makeOut(stamp: { sha: string; clean: boolean } | null = null, base: CodeBase | null = BASE): void {
  const out = join(root, 'out')
  rmSync(out, { recursive: true, force: true })
  for (const dir of ['main/chunks', 'preload', 'renderer/assets', 'hosted']) mkdirSync(join(out, dir), { recursive: true })
  writeFileSync(join(out, 'main/index.js'), '// index\n')
  writeFileSync(join(out, 'main/index.js.map'), '{}')
  writeFileSync(join(out, 'main/boot.js'), '// boot\n')
  writeFileSync(join(out, 'main/gateway.js'), '// gateway\n')
  writeFileSync(join(out, 'main/chunks/a.js'), '// chunk\n')
  writeFileSync(join(out, 'preload/index.js'), '// preload\n')
  writeFileSync(join(out, 'renderer/index.html'), '<html></html>')
  writeFileSync(join(out, 'renderer/assets/app.js'), '// app\n')
  writeFileSync(join(out, 'hosted/index.html'), '<html></html>')
  writeFileSync(join(out, 'bundle-map.json'), JSON.stringify({ chunks: {}, head: stamp }))
  if (base) writeFileSync(join(out, 'code-base.json'), JSON.stringify({ v: 1, ...base }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-code-pack-'))
  makeOut()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('packCode', () => {
  it('packs out/ with a manifest boot reads back, and leaves the maps behind', () => {
    const to = join(root, 'packs')
    const { dir, manifest } = packCode({ root, commit: A, release: 12, subject: 'A fix. More words.\nbody', to, trustOut: true, now: 5 })
    expect(dir).toBe(join(to, A))
    expect(parseManifest(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')))).toEqual(manifest)
    expect(manifest).toMatchObject({ v: 1, commit: A, release: 12, subject: 'A fix. More words.', builtAt: 5, base: BASE })
    expect(manifest.tar.sha256).toBe(sha256File(join(dir, PACK_TARBALL)))
    expect(Object.keys(manifest.entries).sort()).toEqual(['main/boot.js', 'main/gateway.js', 'main/index.js', 'preload/index.js', 'renderer/index.html'])
    expect(manifest.entries['main/index.js']).toBe(sha256File(join(root, 'out/main/index.js')))
    const names = execFileSync('tar', ['-tzf', join(dir, PACK_TARBALL)], { encoding: 'utf8' }).split('\n').filter(Boolean)
    expect(names.every((n) => n === 'out/' || n.startsWith('out/'))).toBe(true)
    expect(names).toContain('out/main/chunks/a.js')
    expect(names).toContain('out/hosted/index.html')
    expect(names).toContain('out/code-base.json')
    expect(names.some((n) => n.endsWith('.map'))).toBe(false)
    expect(names).not.toContain('out/bundle-map.json')
  })

  it('names its files as the host and boot look for them', () => {
    expect(PACK_MANIFEST).toBe(MANIFEST_FILE)
    expect(OFFER_TARBALL).toBe(PACK_TARBALL)
  })

  it('keeps only the newest pack', () => {
    const to = join(root, 'packs')
    packCode({ root, commit: A, release: 12, subject: 's', to, trustOut: true })
    packCode({ root, commit: B, release: 13, subject: 's', to, trustOut: true })
    expect(readdirSync(to)).toEqual([B])
  })

  it('counts the files of main/ and preload/ as entries, not their folders', () => {
    expect(entryFiles(join(root, 'out'))).toEqual(['main/boot.js', 'main/gateway.js', 'main/index.js', 'preload/index.js', 'renderer/index.html'])
  })

  it('refuses an out/ that is not the commit’s clean build, or has no stamp', () => {
    expect(packRefusal(root, A, BASE)).toBe(`out/ is not a clean build of ${A.slice(0, 7)} (it is unstamped)`)
    makeOut({ sha: B, clean: true })
    expect(packRefusal(root, A, BASE)).toBe(`out/ is not a clean build of ${A.slice(0, 7)} (it is ${B.slice(0, 7)})`)
    makeOut({ sha: A, clean: false })
    expect(packRefusal(root, A, BASE)).toBe(`out/ is not a clean build of ${A.slice(0, 7)} (it is ${A.slice(0, 7)}, dirty)`)
    makeOut({ sha: A, clean: true })
    expect(packRefusal(root, A, null)).toBe('out/code-base.json is missing: the build wrote no base stamp')
    // a stamped build in a folder that is no checkout: its base cannot be told again
    expect(packRefusal(root, A, BASE)).toBe("the tree's base moved since the build (no stamp)")
    expect(() => packCode({ root, commit: A, release: 12, subject: 's', to: join(root, 'packs') })).toThrow("the tree's base moved")
  })

  it('refuses a tree with no build, a bad commit and a bad release', () => {
    expect(() => packCode({ root, commit: 'abc', release: 12, subject: 's', to: root, trustOut: true })).toThrow('40 hex')
    expect(() => packCode({ root, commit: A, release: 0, subject: 's', to: root, trustOut: true })).toThrow('whole number')
    rmSync(join(root, 'out/main/index.js'))
    expect(() => packCode({ root, commit: A, release: 12, subject: 's', to: root, trustOut: true })).toThrow('missing out/main/index.js')
    makeOut(null, null)
    expect(() => packCode({ root, commit: A, release: 12, subject: 's', to: root, trustOut: true })).toThrow('no base stamp')
  })
})
