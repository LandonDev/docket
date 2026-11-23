/**
 * The base stamp of a tree (docs/agents/code-only-updates.md): what the built
 * `out/` needs under it and cannot carry. The build writes it to
 * `out/code-base.json` (electron.vite.config.ts), so every bundle knows its
 * own, and scripts/code-pack.ts puts the same stamp in a code-only update's
 * manifest. The Mac takes the update only when the two are equal part by
 * part (src/main/codeChoice.ts); a part that differs names the reason a full
 * release is needed.
 *
 * - `electron`: the version in node_modules/electron.
 * - `lock`: bun.lock, which is node_modules.
 * - `beside`: what the bundle ships outside `out/` and the code reads at run
 *   time: every tracked file under resources/, the .mjs and .cjs under
 *   scripts/ (electron-builder.yml leaves the .ts, .sh and .swift out),
 *   the files that shape the bundle itself (electron-builder.yml: what
 *   ships, the Info.plist keys, the fuses; the entitlements), and the
 *   package.json fields Electron itself reads (the name, the entry). Its
 *   version and its script table change with no release needed, and its
 *   dependencies are `lock`.
 * - `native`: the tc-computer Swift package and what builds it. The
 *   appshot-helper's source lies under resources/ and counts as `beside`.
 * - `boot`: the sources of out/main/boot.js, which only a full release
 *   replaces.
 *
 * Files are read as git tracks them, by path and bytes, so a Mac and the box
 * agree on one commit. A tree with no git has no stamp, and a build without
 * a stamp takes no code-only update.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodeBase } from '../../src/main/codeChoice'

/** The files out/main/boot.js is made of. scripts/lib/codeBase.test.ts holds this list to boot.ts's own imports. */
export const BOOT_SOURCES = ['src/main/boot.ts', 'src/main/codeChoice.ts', 'src/main/compileCache.ts'] as const

/** What shapes the signed bundle itself: the packer's rules (what ships, the Info.plist keys, the fuses) and the entitlements. */
export const BUNDLE_SHAPE = ['electron-builder.yml', 'build/entitlements.mac.plist'] as const

/** The package.json fields the stamp holds: what Electron reads to name the app and find its entry. */
const PACKAGE_FIELDS = ['name', 'productName', 'main', 'type'] as const

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/** One hash for a list of files: each path with the hash of its bytes, in path order. */
export function hashFiles(root: string, paths: readonly string[], read: (path: string) => Buffer = readFileSync): string {
  const lines = [...paths].sort().map((path) => `${sha256(read(join(root, path)))}  ${path}`)
  return sha256(lines.join('\n'))
}

/** package.json as the stamp sees it: PACKAGE_FIELDS alone. */
export function stablePackage(text: string): string {
  const pkg = JSON.parse(text) as Record<string, unknown>
  return JSON.stringify(PACKAGE_FIELDS.map((field) => [field, pkg[field] ?? null]))
}

export const isBesideScript = (path: string): boolean => /^scripts\/.+\.(mjs|cjs)$/.test(path) && !path.startsWith('scripts/.out/')

function tracked(root: string, ...paths: string[]): string[] {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...paths], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter(Boolean)
}

/** The stamp of the tree at `root`, or null when it cannot be told (no git, no node_modules). */
export function codeBase(root: string): CodeBase | null {
  try {
    const electron = (JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')) as { version: string }).version
    const beside = [...tracked(root, 'resources'), ...tracked(root, 'scripts').filter(isBesideScript), ...BUNDLE_SHAPE]
    const native = [...tracked(root, 'native/tc-computer'), 'scripts/lib/tcComputerBuild.ts']
    if (typeof electron !== 'string' || beside.length === 0 || native.length < 2) return null
    return {
      electron,
      lock: sha256(readFileSync(join(root, 'bun.lock'))),
      beside: sha256(`${hashFiles(root, beside)}\n${sha256(stablePackage(readFileSync(join(root, 'package.json'), 'utf8')))}`),
      native: hashFiles(root, native),
      boot: hashFiles(root, BOOT_SOURCES)
    }
  } catch {
    return null
  }
}
