/**
 * The Windows release, as rules (scripts/win-stage.ts runs them; docs/agents/windows-build.md).
 *
 * The Claude Agent SDK ships its CLI as one optional package per platform
 * (`@anthropic-ai/claude-agent-sdk-<os>-<cpu>`), and a package manager installs
 * only the builder's own. With `npmRebuild: false` and `asar: false` a Windows
 * build made on a Mac or the box would carry that machine's `claude` and no
 * `claude.exe`. So the win32 package is fetched by the version and checksum
 * bun.lock already holds, laid into the Windows pack by build/electron-builder.win.yml,
 * and the packed app is checked before anything is uploaded.
 */

/** The platform package the Windows build needs. */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const WIN_CLI_PACKAGE = '@anthropic-ai/claude-agent-sdk-win32-x64'
export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
/** Where scripts/win-stage.ts lays it; build/electron-builder.win.yml maps this folder onto node_modules. */
export const WIN_CONFIG = 'build/electron-builder.win.yml'
export const STAGE_DIR = 'artifacts/win-stage/node_modules'

/** A name like `@scope/pkg-darwin-arm64`: the platform it was built for, null for an ordinary package. */
export function platformOfPackage(name: string): 'darwin' | 'linux' | 'win32' | null {
  const m = /-(darwin|linux|win32)-(?:x64|arm64|ia32)(?:-(?:musl|gnu|msvc))?$/.exec(name)
  return m ? (m[1] as 'darwin' | 'linux' | 'win32') : null
}

/** The npm registry's tarball of a package version. */
export function tarballUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`
}

/** bun.lock's `sha512-…` for one package version; null when the lock does not name it. */
export function lockIntegrity(lockText: string, name: string, version: string): string | null {
  const at = lockText.indexOf(`"${name}@${version}"`)
  if (at < 0) return null
  const line = lockText.slice(at, lockText.indexOf('\n', at) < 0 ? undefined : lockText.indexOf('\n', at))
  return /"(sha512-[A-Za-z0-9+/=]+)"/.exec(line)?.[1] ?? null
}

export type Binary = 'pe-x64' | 'pe-arm64' | 'pe-other' | 'mach-o' | 'elf' | 'other'

/** What kind of executable a file's first bytes say it is. A PE's machine sits behind the offset at 0x3c. */
export function binaryKind(head: Uint8Array): Binary {
  const u32 = (at: number): number => (head[at] | (head[at + 1] << 8) | (head[at + 2] << 16) | (head[at + 3] << 24)) >>> 0
  if (head.length >= 4) {
    if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'elf'
    const magic = u32(0)
    // thin Mach-O (either byte order, 32 and 64 bit) and the fat header
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) return 'mach-o'
  }
  if (head.length >= 0x40 && head[0] === 0x4d && head[1] === 0x5a) {
    const pe = u32(0x3c)
    if (head.length >= pe + 6 && head[pe] === 0x50 && head[pe + 1] === 0x45 && head[pe + 2] === 0 && head[pe + 3] === 0) {
      const machine = head[pe + 4] | (head[pe + 5] << 8)
      return machine === 0x8664 ? 'pe-x64' : machine === 0xaa64 ? 'pe-arm64' : 'pe-other'
    }
    return 'pe-other'
  }
  return 'other'
}

/** What the check reads of a packed Windows app (`dist/win-unpacked/resources/app`). */
export interface PackedApp {
  /** package names under node_modules (`@scope/name` or `name`) */
  packages: string[]
  /** the staged CLI's first bytes, null when the file is missing */
  cliHead: Uint8Array | null
  /** the staged package's version, null when it has no package.json */
  cliVersion: string | null
  /** the SDK's own version and the win32 package version it asks for */
  sdkVersion: string | null
  sdkWants: string | null
  /** `@muse-code/sdk`'s package.json, null when the app does not carry it */
  muse: { optionalDependencies?: Record<string, string>; bin?: unknown } | null
  /** node-pty's win32-x64 prebuild is there */
  ptyPrebuild: boolean
  /** Mach-O or ELF helpers under resources/native (the Mac's own), as paths */
  foreignBinaries: string[]
}

/**
 * Every reason a packed Windows app must not be released; empty when it may.
 * The CLI: there, a 64-bit Windows executable, the version the SDK's own
 * package.json asks for. No other platform's package of any family. Muse: the
 * SDK is plain JavaScript today (the `muse` binary is the person's own install)
 * and the check fails the day it gains a platform package, so someone stages it.
 */
export function packedAppProblems(app: PackedApp): string[] {
  const problems: string[] = []
  if (!app.cliHead) problems.push(`${WIN_CLI_PACKAGE}/claude.exe is missing: run \`bun scripts/win-stage.ts stage\` before the Windows pack`)
  else if (binaryKind(app.cliHead) !== 'pe-x64') problems.push(`${WIN_CLI_PACKAGE}/claude.exe is not a 64-bit Windows executable (${binaryKind(app.cliHead)})`)
  if (app.cliHead && (!app.cliVersion || !app.sdkWants || app.cliVersion !== app.sdkWants)) {
    problems.push(`the staged Claude CLI is ${app.cliVersion ?? 'unversioned'}; ${SDK_PACKAGE} ${app.sdkVersion ?? '(missing)'} wants ${app.sdkWants ?? 'none'}`)
  }
  for (const name of app.packages) {
    const platform = platformOfPackage(name)
    if (platform && platform !== 'win32') problems.push(`${name} is a ${platform} package in a Windows build`)
  }
  if (app.muse && (Object.keys(app.muse.optionalDependencies ?? {}).length > 0 || app.muse.bin)) {
    problems.push('@muse-code/sdk now ships platform packages or a binary: stage its win32 one as the Claude CLI is staged')
  }
  if (!app.ptyPrebuild) problems.push('node-pty has no win32-x64 prebuild in the app')
  for (const file of app.foreignBinaries) problems.push(`${file} is not a Windows binary`)
  return problems
}

/** The files a Windows release adds to the GitHub release, by name. The feed (`latest.yml`) names the installer. */
export function winReleaseFiles(version: string): { installer: string; blockmap: string; zip: string; feed: string } {
  const installer = `temp-code-${version}-setup.exe`
  return { installer, blockmap: `${installer}.blockmap`, zip: `TempCode-${version}-win-x64.zip`, feed: 'latest.yml' }
}

/** What `latest.yml` says: its version and the installer it names with its checksum and size. */
export function parseFeed(yml: string): { version: string | null; path: string | null; sha512: string | null; size: number | null } {
  const top = (key: string): string | null => new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(yml)?.[1]?.replace(/^['"]|['"]$/g, '') ?? null
  const size = /^\s+size:\s*(\d+)\s*$/m.exec(yml)?.[1]
  return { version: top('version'), path: top('path'), sha512: top('sha512'), size: size ? Number(size) : null }
}

/** Every reason the Windows files in `dist/` must not be uploaded; empty when they may. */
export function winFilesProblems(
  version: string,
  present: Record<string, { size: number; sha512?: string } | undefined>,
  feedYml: string | null
): string[] {
  const files = winReleaseFiles(version)
  const problems: string[] = []
  for (const name of Object.values(files)) {
    if (!present[name]) problems.push(`${name} is missing`)
    else if (present[name]!.size === 0) problems.push(`${name} is empty`)
  }
  if (feedYml !== null) {
    const feed = parseFeed(feedYml)
    if (feed.version !== version) problems.push(`latest.yml says version ${feed.version ?? '(none)'}, not ${version}`)
    if (feed.path !== files.installer) problems.push(`latest.yml names ${feed.path ?? '(nothing)'}, not ${files.installer}`)
    const installer = present[files.installer]
    if (installer && feed.size !== null && feed.size !== installer.size) problems.push(`latest.yml gives the installer ${feed.size} bytes; it has ${installer.size}`)
    if (installer?.sha512 && feed.sha512 !== installer.sha512) problems.push('latest.yml carries another checksum than the installer has')
  }
  return problems
}

/** Every package name under a node_modules, nested ones included (a darwin binary can hide a level down). */
export function packagesIn(nodeModules: string): string[] {
  const names: string[] = []
  const add = (name: string): void => {
    names.push(name)
    names.push(...packagesIn(join(nodeModules, name, 'node_modules')))
  }
  for (const entry of existsSync(nodeModules) ? readdirSync(nodeModules) : []) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) for (const inner of readdirSync(join(nodeModules, entry))) add(`${entry}/${inner}`)
    else add(entry)
  }
  return names
}
