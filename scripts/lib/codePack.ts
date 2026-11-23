/**
 * Pack a built `out/` as a code-only update
 * (docs/agents/code-only-updates.md): `<to>/<commit>/code.tar.gz` and
 * `code-manifest.json` beside it. The manifest names the commit `out/` was
 * built from, the release that commit became, the tarball's size and
 * sha256, the sha256 of every entry file (what boot checks at each launch)
 * and the tree's base stamp, read from `out/code-base.json` as the build
 * wrote it. Nothing is built here: the gate's own `out/` is packed, and a
 * tree that is not that commit's clean build is refused.
 *
 * Source maps and the bundle map stay behind, as electron-builder leaves
 * them out of the bundle. Only the newest pack is kept under `to`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE_FILE, INDEX_ENTRY, MANIFEST_FILE, baseDifference, parseBase, parseManifest, type CodeBase, type CodeManifest } from '../../src/main/codeChoice'
import { codeBase } from './codeBase'
import { readBuildStamp } from './gateBuild'

export const PACK_TARBALL = 'code.tar.gz'
/** The folders whose own files are entries; out/renderer adds its index.html. */
const ENTRY_DIRS = ['main', 'preload'] as const
const REQUIRED = [INDEX_ENTRY, 'main/boot.js', 'main/gateway.js', 'preload/index.js', 'renderer/index.html'] as const

export interface PackOptions {
  /** The checkout whose `out/` is packed. */
  root: string
  /** The commit `out/` was built from. */
  commit: string
  /** The release that commit became. */
  release: number
  subject: string
  /** Where packs live: this one goes to `<to>/<commit>/`. */
  to: string
  /** A proof packs a tree it changed by hand: skip the checks that `out/` is `commit`'s clean build on this tree's base. */
  trustOut?: boolean
  now?: number
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** The entry files of an `out/`: every file directly in main/ and preload/ (the maps are not packed), and the renderer's page. */
export function entryFiles(out: string): string[] {
  const files: string[] = []
  for (const dir of ENTRY_DIRS) {
    for (const name of readdirSync(join(out, dir)).sort()) if (!name.endsWith('.map') && statSync(join(out, dir, name)).isFile()) files.push(`${dir}/${name}`)
  }
  files.push('renderer/index.html')
  return files
}

/** Why `out/` under `root` may not be packed as `commit`, or null. */
export function packRefusal(root: string, commit: string, base: CodeBase | null): string | null {
  const stamp = readBuildStamp(root)
  if (!stamp || stamp.sha !== commit || !stamp.clean) {
    return `out/ is not a clean build of ${commit.slice(0, 7)} (it is ${stamp?.sha ? `${stamp.sha.slice(0, 7)}${stamp.clean ? '' : ', dirty'}` : 'unstamped'})`
  }
  if (!base) return `out/${BASE_FILE} is missing: the build wrote no base stamp`
  const now = codeBase(root)
  const part = now ? baseDifference(base, now) : null
  if (!now || part) return `the tree's base moved since the build (${part ?? 'no stamp'})`
  return null
}

export function packCode(opts: PackOptions): { dir: string; manifest: CodeManifest } {
  if (!/^[0-9a-f]{40}$/.test(opts.commit)) throw new Error('the commit must be 40 hex characters')
  if (!Number.isInteger(opts.release) || opts.release < 1) throw new Error('the release must be a whole number')
  const out = join(opts.root, 'out')
  for (const file of REQUIRED) if (!existsSync(join(out, file))) throw new Error(`missing out/${file}: run electron-vite build first`)
  const base = parseBase(JSON.parse(existsSync(join(out, BASE_FILE)) ? readFileSync(join(out, BASE_FILE), 'utf8') : 'null'))
  if (!opts.trustOut) {
    const refusal = packRefusal(opts.root, opts.commit, base)
    if (refusal) throw new Error(refusal)
  }
  if (!base) throw new Error(`out/${BASE_FILE} is missing: the build wrote no base stamp`)

  const dir = join(opts.to, opts.commit)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tarball = join(dir, PACK_TARBALL)
  // COPYFILE_DISABLE keeps macOS from adding ._ resource forks.
  execFileSync('tar', ['-czf', tarball, '--exclude=*.map', '--exclude=out/bundle-map.json', '-C', opts.root, 'out'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  })
  const manifest: CodeManifest = {
    v: 1,
    commit: opts.commit,
    release: opts.release,
    subject: opts.subject.split('\n')[0].slice(0, 2000),
    builtAt: opts.now ?? Date.now(),
    base,
    tar: { bytes: statSync(tarball).size, sha256: sha256(tarball) },
    entries: Object.fromEntries(entryFiles(out).map((path) => [path, sha256(join(out, path))]))
  }
  if (!parseManifest(manifest)) throw new Error('the manifest does not read back')
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  // Only the newest pack is kept.
  for (const name of readdirSync(opts.to)) if (name !== opts.commit) rmSync(join(opts.to, name), { recursive: true, force: true })
  return { dir, manifest }
}
