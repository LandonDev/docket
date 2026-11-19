#!/usr/bin/env bun
/**
 * The Windows build's own steps around electron-builder (scripts/lib/winRelease.ts has the rules;
 * docs/agents/windows-build.md the whole account). Runs on the Mac or the box.
 *
 *   bun scripts/win-stage.ts stage                      fetch the win32 Claude CLI into artifacts/win-stage
 *   bun scripts/win-stage.ts check-app [dir]            judge a packed app (default dist/win-unpacked)
 *   bun scripts/win-stage.ts check-files <dist> <1.0.N> judge the installer, blockmap, zip and latest.yml
 *
 * `stage` reads the version the installed SDK asks for and the checksum bun.lock holds for it,
 * downloads that tarball from the npm registry, refuses it on a checksum mismatch and unpacks it.
 * A stage that already holds that version is left alone. Each check prints its reasons and exits 1.
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  packedAppProblems,
  binaryKind,
  lockIntegrity,
  SDK_PACKAGE,
  STAGE_DIR,
  tarballUrl,
  WIN_CLI_PACKAGE,
  winFilesProblems,
  winReleaseFiles,
  type PackedApp
} from './lib/winRelease'

const REPO = resolve(import.meta.dir, '..')

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function head(file: string, bytes = 4096): Uint8Array | null {
  try {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0))
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

type Pkg = { version?: string; optionalDependencies?: Record<string, string>; bin?: unknown }

async function stage(): Promise<void> {
  const wants = readJson<Pkg>(join(REPO, 'node_modules', SDK_PACKAGE, 'package.json'))?.optionalDependencies?.[WIN_CLI_PACKAGE]
  if (!wants) throw new Error(`${SDK_PACKAGE} names no ${WIN_CLI_PACKAGE}: read its package.json and update scripts/lib/winRelease.ts`)
  const dir = join(REPO, STAGE_DIR, WIN_CLI_PACKAGE)
  const exe = join(dir, 'claude.exe')
  if (readJson<Pkg>(join(dir, 'package.json'))?.version === wants && existsSync(exe)) {
    console.log(`win-stage: ${WIN_CLI_PACKAGE} ${wants} is already staged`)
    return
  }
  const integrity = lockIntegrity(readFileSync(join(REPO, 'bun.lock'), 'utf8'), WIN_CLI_PACKAGE, wants)
  if (!integrity) throw new Error(`bun.lock holds no checksum for ${WIN_CLI_PACKAGE}@${wants}`)
  const url = tarballUrl(WIN_CLI_PACKAGE, wants)
  console.log(`win-stage: fetching ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const tarball = Buffer.from(await res.arrayBuffer())
  const got = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  if (got !== integrity) throw new Error(`${WIN_CLI_PACKAGE}@${wants} does not match bun.lock's checksum; nothing staged`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tgz = join(REPO, STAGE_DIR, '.claude-cli.tgz')
  writeFileSync(tgz, tarball)
  try {
    const tar = Bun.spawnSync(['tar', '-xzf', tgz, '-C', dir, '--strip-components=1'])
    if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString().trim()}`)
  } finally {
    rmSync(tgz, { force: true })
  }
  const kind = binaryKind(head(exe) ?? new Uint8Array())
  if (kind !== 'pe-x64') throw new Error(`the staged claude.exe is ${kind}, not a 64-bit Windows executable`)
  console.log(`win-stage: staged ${WIN_CLI_PACKAGE} ${wants} (${Math.round(statSync(exe).size / 1e6)} MB)`)
}

/** Package names under a node_modules folder, scopes opened. */
function packagesIn(nodeModules: string): string[] {
  const names: string[] = []
  for (const entry of existsSync(nodeModules) ? readdirSync(nodeModules) : []) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) for (const inner of readdirSync(join(nodeModules, entry))) names.push(`${entry}/${inner}`)
    else names.push(entry)
  }
  return names
}

function readPackedApp(appDir: string): PackedApp {
  const modules = join(appDir, 'node_modules')
  const sdk = readJson<Pkg>(join(modules, SDK_PACKAGE, 'package.json'))
  const native = join(appDir, 'resources', 'native')
  return {
    packages: packagesIn(modules),
    cliHead: head(join(modules, WIN_CLI_PACKAGE, 'claude.exe')),
    cliVersion: readJson<Pkg>(join(modules, WIN_CLI_PACKAGE, 'package.json'))?.version ?? null,
    sdkVersion: sdk?.version ?? null,
    sdkWants: sdk?.optionalDependencies?.[WIN_CLI_PACKAGE] ?? null,
    muse: readJson<Pkg>(join(modules, '@muse-code', 'sdk', 'package.json')),
    ptyPrebuild: existsSync(join(modules, 'node-pty', 'prebuilds', 'win32-x64')),
    foreignBinaries: (existsSync(native) ? readdirSync(native) : [])
      .map((name) => join(native, name))
      .filter((file) => statSync(file).isFile() && ['mach-o', 'elf'].includes(binaryKind(head(file) ?? new Uint8Array())))
  }
}

function report(what: string, problems: string[]): never {
  if (problems.length === 0) {
    console.log(`win-stage: ${what} passes`)
    process.exit(0)
  }
  for (const problem of problems) console.error(`win-stage: ${problem}`)
  process.exit(1)
}

const sha512 = (file: string): string => createHash('sha512').update(readFileSync(file)).digest('base64')

const [command, ...args] = process.argv.slice(2)
if (command === 'stage') {
  await stage()
} else if (command === 'check-app') {
  const dir = resolve(args[0] ?? join(REPO, 'dist', 'win-unpacked'))
  report(`the packed app at ${dir}`, packedAppProblems(readPackedApp(join(dir, 'resources', 'app'))))
} else if (command === 'check-files' && args.length === 2) {
  const [dist, version] = [resolve(args[0]), args[1]]
  const files = winReleaseFiles(version)
  const present: Parameters<typeof winFilesProblems>[1] = {}
  for (const name of Object.values(files)) {
    const file = join(dist, name)
    if (existsSync(file)) present[name] = { size: statSync(file).size, ...(name === files.installer ? { sha512: sha512(file) } : {}) }
  }
  const feed = join(dist, files.feed)
  report(`the Windows files of ${version}`, winFilesProblems(version, present, existsSync(feed) ? readFileSync(feed, 'utf8') : null))
} else {
  console.error('usage: win-stage.ts stage | check-app [dir] | check-files <dist> <1.0.N>')
  process.exit(2)
}
