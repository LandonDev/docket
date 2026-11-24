#!/usr/bin/env bun
/**
 * The Windows files of a release, made from an out/ already built: the unsigned one-click
 * installer with its blockmap, the zip and latest.yml, the feed file a Windows install reads
 * (docs/agents/windows-build.md). The same steps on the Mac (scripts/release-publish-win.sh, run
 * by every publish once the Mac's release is live) and on the box (by hand, for the rig):
 *
 *   1. the tools: cargo-xwin for tc-computer.exe; on Linux a `wine` stand-in (below)
 *   2. the win32 Claude CLI staged (scripts/win-stage.ts stage, checked against bun.lock)
 *   3. tc-computer.exe cross-built (scripts/build-tc-computer-win.ts)
 *   4. one electron-builder call on the Windows config, nsis and zip for x64
 *   5. the packed app checked (win-stage.ts check-app), its feed config read, the four files
 *      checked against latest.yml (win-stage.ts check-files)
 *
 *   bun scripts/release-win.ts [--dist DIR] [--sha SHA] [--log FILE]
 *
 * Exits 0 with the four files in DIST (default dist/). Else exits 1, and the last line on stderr
 * says in one line which step failed; the steps' whole output is in the log.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { WIN_CONFIG, winBuilderConfig, winFeedProblems } from './lib/winRelease'

const REPO = resolve(import.meta.dir, '..')

/**
 * electron-builder writes the uninstaller by running the half-built installer once. On a Mac it
 * reads it out of the file instead, in JavaScript (`UninstallerReader`); on Linux it wants wine,
 * which the box does not have (its own bundled wine does not start here either). So a Linux
 * build is handed a `wine` that does what the Mac's build does: the same reader, on the same file.
 * Returns the folder to put first on PATH.
 */
export function wineStandIn(bin: string): string {
  mkdirSync(bin, { recursive: true })
  const reader = join(bin, 'write-uninstaller.cjs')
  writeFileSync(
    reader,
    [
      "const path = require('node:path')",
      `const { UninstallerReader } = require(${JSON.stringify(join(REPO, 'node_modules/app-builder-lib/out/targets/nsis/nsisUtil.js'))})`,
      'const installer = process.argv[2]',
      "if (!installer || !installer.endsWith('.exe')) { console.error('wine stand-in: expected the installer, got ' + process.argv.slice(2).join(' ')); process.exit(2) }",
      "// The name electron-builder's NsisTarget expects (UNINSTALLER_OUT_FILE).",
      "const out = path.join(path.dirname(installer), path.basename(installer, 'exe') + '__uninstaller.exe')",
      'UninstallerReader.exec(installer, out).catch((error) => { console.error(String(error)); process.exit(1) })'
    ].join('\n')
  )
  writeFileSync(join(bin, 'wine'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(reader)} "$@"\n`, { mode: 0o755 })
  return bin
}

if (import.meta.main) {
  const arg = (name: string): string | undefined => {
    const at = process.argv.indexOf(name)
    return at >= 0 ? process.argv[at + 1] : undefined
  }
  const dist = resolve(arg('--dist') ?? join(REPO, 'dist'))
  const sha = arg('--sha') ?? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()
  const scratch = join(tmpdir(), `tc-release-win-${process.pid}`)
  const logFile = resolve(arg('--log') ?? join(scratch, 'release-win.log'))
  mkdirSync(scratch, { recursive: true })
  mkdirSync(dirname(logFile), { recursive: true })
  appendFileSync(logFile, `== release-win ${new Date().toISOString()}\n`)
  const version = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version

  const fail = (why: string): never => {
    appendFileSync(logFile, `\n${why}\n`)
    console.error(why)
    process.exit(1)
  }
  const path = [join(homedir(), '.cargo', 'bin'), ...(process.platform === 'linux' ? [wineStandIn(join(scratch, 'bin'))] : []), process.env.PATH ?? ''].join(delimiter)
  const env = { ...process.env, PATH: path }
  /** One step, its output to the log; false when it failed. */
  const step = (what: string, cmd: string[]): boolean => {
    appendFileSync(logFile, `\n== ${what}: ${cmd.join(' ')}\n`)
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: REPO, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    appendFileSync(logFile, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}\n== exit ${r.status}\n`)
    return r.status === 0
  }
  const lastLine = (): string =>
    readFileSync(logFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('== '))
      .slice(-1)[0] ?? ''

  if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) fail('out/ is not built: run electron-vite build first')
  if (!step('cargo-xwin', ['cargo', 'xwin', '--version']))
    fail('cargo-xwin is missing: install rustup, the x86_64-pc-windows-msvc target and cargo-xwin (docs/agents/windows-build.md "The tools")')
  if (!step('stage', ['bun', 'scripts/win-stage.ts', 'stage'])) fail(`the win32 Claude CLI was not staged: ${lastLine()}`)
  if (!step('tc-computer.exe', ['bun', 'scripts/build-tc-computer-win.ts'])) fail(`tc-computer.exe did not build: ${lastLine()}`)

  const config = join(scratch, 'builder-win.json')
  const configText = JSON.stringify(winBuilderConfig(join(REPO, WIN_CONFIG), dist, sha), null, 2)
  writeFileSync(config, configText)
  appendFileSync(logFile, `\n== config ${config}\n${configText}\n`)
  if (!step('pack', ['bunx', 'electron-builder', '--win', '--x64', '--publish', 'never', '--projectDir', REPO, '--config', config]))
    fail(`electron-builder failed: ${lastLine()}`)
  const app = join(dist, 'win-unpacked')
  if (!step('check-app', ['bun', 'scripts/win-stage.ts', 'check-app', app])) fail(`the Windows app is not fit to ship: ${lastLine()}`)
  const feedFile = join(app, 'resources', 'app-update.yml')
  const feedProblems = winFeedProblems(existsSync(feedFile) ? readFileSync(feedFile, 'utf8') : null)
  if (feedProblems.length) fail(`resources/app-update.yml: ${feedProblems.join('; ')}`)
  if (!step('check-files', ['bun', 'scripts/win-stage.ts', 'check-files', dist, version])) fail(`the Windows files are not all there: ${lastLine()}`)
  console.log(`windows: ${version} built and checked in ${dist}`)
}
