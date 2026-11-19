#!/usr/bin/env bun
/**
 * The Windows build, end to end, in the rig (docs/agents/windows-vm.md): a
 * silent install with no admin, the Windows frame, Ctrl keys, the bundled
 * Claude CLI, and an update from 1.0.N-1 to 1.0.N off a local feed. Run on
 * the box, through `bun scripts/e2e-updater.ts --win`.
 *
 *   bun scripts/e2e-updater.ts --win              build both copies, start the rig, drive, stop it
 *   bun scripts/e2e-updater.ts --win --reuse      keep the builds under ROOT, redrive
 *   bun scripts/e2e-updater.ts --win --rig-up     the rig is up and yours: use it, leave it running
 *   bun scripts/e2e-updater.ts --win --busy       restart with the bundled claude.exe running out of the install folder
 *   bun scripts/e2e-updater.ts --win --build-only build and check both copies, leave the rig alone
 *   bun scripts/e2e-updater.ts --win --no-vite    out/ is already built: pack it as it is
 *
 * What it does:
 *   1. Builds out/ (electron-vite), stages the win32 Claude CLI (scripts/win-stage.ts), and packs
 *      the tree twice with electron-builder on the Windows config, unsigned: once at 1.0.N-1 ("old")
 *      and once at 1.0.N ("new"). Both carry app id dev.landon.tempcode.e2e, product name
 *      TempCodeE2E and a `tempcodeHarness` block (src/main/harness.ts) naming their userData, CDP
 *      port and feed, so the app the installer starts again comes up isolated too. Each packed app
 *      passes the release check (`win-stage.ts check-app`).
 *   2. Serves latest.yml, the new installer and its blockmap from 127.0.0.1:9231 on the box. One
 *      SSH connection carries that port into the guest (-R) and the guest's CDP port out (-L):
 *      the guest's firewall keeps the box's loopback shut, and Chromium's debug port listens on
 *      the guest's own loopback, where QEMU's forward does not reach.
 *   3. As tcuser, the standard user: copies the old installer in and runs it with /S over SSH,
 *      in session 0, where no UAC prompt could be answered. Then starts the app on the desktop.
 *   4. Over CDP: the platform is win32, the bar leaves the caption room and draws no controls of
 *      ours, Ctrl+, opens Settings and its key list reads Ctrl with no ⌘ anywhere; the bundled
 *      claude.exe answers --version; then check → download → restart.
 *   5. Asserts: the old app quit, the folder holds 1.0.N, the relaunched app answers 1.0.N with
 *      no pending update and no failure, and with --busy that the children alive before the
 *      restart are gone.
 *
 * Everything it writes on the box lives under ROOT; in the guest, under %LOCALAPPDATA%
 * (Programs\TempCodeE2E, tc-e2e, temp-code-harness-updater) of a throwaway overlay.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attach, type Cdp, prepareEnv, readPackage, REPO, sh, sleep, waitForReleaseTrain } from './lib/packagedApp'
import { parseFeed, WIN_CONFIG, winReleaseFiles } from './lib/winRelease'
import { rigConfig, rigPaths, STANDARD_USER } from './win-vm/config'

const ROOT = '/tmp/tc-updater-e2e-win'
const APP_ID = 'dev.landon.tempcode.e2e'
const PRODUCT = 'TempCodeE2E'
/**
 * Each copy's CDP port in the guest, and where the tunnel brings it on the box. Two, because the
 * installer the old copy starts inherits its listening debug socket (a Windows child inherits every
 * inheritable handle, and Chromium's is one) and holds it until it exits, after it has started the
 * new copy: on the same port the new copy would come up with no CDP at all.
 */
const GUEST_CDP_PORT = { old: 9333, new: 9335 } as const
const CDP_PORT = { old: 9334, new: 9336 } as const
const FEED_PORT = 9231
const FEED_URL = `http://127.0.0.1:${FEED_PORT}/`
/** In the guest. `%LOCALAPPDATA%` is spelled out: the block is read before any shell could expand it. */
const GUEST_LOCAL = `C:\\Users\\${STANDARD_USER}\\AppData\\Local`
const GUEST_USER_DATA = `${GUEST_LOCAL}\\tc-e2e\\userData`
const GUEST_APP_DIR = `${GUEST_LOCAL}\\Programs\\${PRODUCT}`
const GUEST_EXE = `${GUEST_APP_DIR}\\${PRODUCT}.exe`
const GUEST_CLI = `${GUEST_APP_DIR}\\resources\\app\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe`
const FEED_DIR = join(ROOT, 'feed')
const SHOTS = join(ROOT, 'shots')

const reuse = process.argv.includes('--reuse')
const rigUp = process.argv.includes('--rig-up')
const busy = process.argv.includes('--busy')
const buildOnly = process.argv.includes('--build-only')

prepareEnv()

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (msg: string): void => console.log(`[e2e-updater-win ${new Date().toISOString().slice(11, 19)}] ${msg}`)

// ── The rig ────────────────────────────────────────────────────────────────

const rig = rigConfig()
const paths = rigPaths(rig)
const vm = (script: string): string => join(REPO, 'scripts', 'win-vm', `${script}.sh`)

/** One rig command; its output and exit code, never a throw. */
async function guest(cmd: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd: REPO, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { code, out: `${out}${err}`.trim() }
}
const ps = (script: string, timeoutMs?: number): Promise<{ code: number; out: string }> => guest([vm('ssh'), '--ps', script], timeoutMs)

let shotNo = 0
async function shot(name: string): Promise<void> {
  const file = join(SHOTS, `${String(++shotNo).padStart(2, '0')}-${name}.png`)
  const r = await guest([vm('shot'), file], 30_000)
  log(r.code === 0 ? `screenshot ${file}` : `screenshot failed: ${r.out.slice(0, 200)}`)
}

// ── Preflight ──────────────────────────────────────────────────────────────

const N = readPackage().n
const OLD = `1.0.${N - 1}`
const NEW = `1.0.${N}`
const files = winReleaseFiles(NEW)
log(`old ${OLD} → new ${NEW}, root ${ROOT}`)
if (!reuse) rmSync(ROOT, { recursive: true, force: true })
rmSync(FEED_DIR, { recursive: true, force: true })
rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(FEED_DIR, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

await waitForReleaseTrain(log)

// ── Build ──────────────────────────────────────────────────────────────────

const outDir = (which: 'old' | 'new'): string => join(ROOT, `build-${which}`)
const installerOf = (which: 'old' | 'new'): string => join(outDir(which), winReleaseFiles(which === 'old' ? OLD : NEW).installer)

/**
 * electron-builder writes the uninstaller by running the half-built installer once. On a Mac it
 * reads it out of the file instead, in JavaScript (`UninstallerReader`); on Linux it wants wine,
 * which the box does not have (its own bundled wine does not start here either). So a Linux
 * build is handed a `wine` that does what the Mac's build does: the same reader, on the same file.
 * Returns the folder to put first on PATH.
 */
function wineStandIn(): string {
  const bin = join(ROOT, 'bin')
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

async function pack(version: string, which: 'old' | 'new'): Promise<void> {
  log(`packing ${version} → ${outDir(which)}`)
  // A config of the run's own, on top of the Windows one: `--config <file>` and `-c.key=value` do not mix.
  const config = join(ROOT, `builder-${which}.json`)
  writeFileSync(
    config,
    JSON.stringify(
      {
        extends: `./${WIN_CONFIG}`,
        appId: APP_ID,
        productName: PRODUCT,
        directories: { output: outDir(which) },
        extraMetadata: {
          tempcodeHarness: {
            TEMP_CODE_USER_DATA: GUEST_USER_DATA,
            TEMP_CODE_DEBUG_PORT: String(GUEST_CDP_PORT[which]),
            TEMP_CODE_UPDATE_FEED: FEED_URL
          }
        }
      },
      null,
      2
    )
  )
  const pkg = readPackage()
  writeFileSync(pkg.path, pkg.text.replace(/^ {2}"version": "1\.0\.\d+",$/m, `  "version": "${version}",`))
  try {
    await sh(['bunx', 'electron-builder', '--win', 'nsis', '--x64', '--publish', 'never', '--config', config], {
      quiet: true,
      env: process.platform === 'linux' ? { PATH: `${wineStandIn()}:${process.env.PATH ?? ''}` } : {}
    })
  } finally {
    writeFileSync(pkg.path, pkg.text)
  }
  const app = join(outDir(which), 'win-unpacked')
  const built = JSON.parse(readFileSync(join(app, 'resources', 'app', 'package.json'), 'utf8')) as {
    version: string
    tempcodeHarness?: Record<string, string>
  }
  check(
    `${which} app is ${version} with the harness block`,
    built.version === version && built.tempcodeHarness?.TEMP_CODE_USER_DATA === GUEST_USER_DATA,
    JSON.stringify(built.tempcodeHarness)
  )
  const judged = await guest(['bun', 'scripts/win-stage.ts', 'check-app', app], 60_000)
  check(`${which} app passes the release check`, judged.code === 0, judged.out.split('\n').slice(0, 4).join(' | '))
  check(`${which} installer was made`, existsSync(installerOf(which)), installerOf(which))
}

if (!reuse) {
  if (process.argv.includes('--no-vite')) log('out/ taken as built (--no-vite)')
  else {
    log('electron-vite build')
    await sh(['bunx', 'electron-vite', 'build'], { quiet: true })
  }
  log('staging the win32 Claude CLI')
  await sh(['bun', 'scripts/win-stage.ts', 'stage'], { quiet: true })
  await pack(OLD, 'old')
  await pack(NEW, 'new')
} else {
  for (const which of ['old', 'new'] as const) if (!existsSync(installerOf(which))) throw new Error(`--reuse: ${installerOf(which)} missing`)
}

if (buildOnly) {
  console.log(failures === 0 ? 'E2E UPDATER (WINDOWS): BUILT' : `E2E UPDATER (WINDOWS): ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

// ── Feed ───────────────────────────────────────────────────────────────────

for (const name of [files.installer, files.blockmap, files.feed]) copyFileSync(join(outDir('new'), name), join(FEED_DIR, name))
const feed = parseFeed(readFileSync(join(FEED_DIR, files.feed), 'utf8'))
const installerSha = createHash('sha512').update(readFileSync(join(FEED_DIR, files.installer))).digest('base64')
check(
  `latest.yml names ${files.installer} at ${NEW} with its checksum`,
  feed.version === NEW && feed.path === files.installer && feed.sha512 === installerSha && feed.size === statSync(join(FEED_DIR, files.installer)).size,
  JSON.stringify({ version: feed.version, path: feed.path, size: feed.size })
)
const feedLog: string[] = []
const server = Bun.serve({
  port: FEED_PORT,
  hostname: '127.0.0.1',
  async fetch(req: Request) {
    const name = decodeURIComponent(new URL(req.url).pathname).split('/').pop() ?? ''
    const file = Bun.file(join(FEED_DIR, name))
    if (!name || !(await file.exists())) return new Response('not found', { status: 404 })
    feedLog.push(name)
    return new Response(file)
  }
})
log(`feed on 127.0.0.1:${FEED_PORT}`)

// ── Drive ──────────────────────────────────────────────────────────────────

type Status = {
  current: string
  latest: string | null
  phase: string
  percent?: number
  error?: string
  installFailure?: { version: string; reason: string }
}

let tunnel: ReturnType<typeof Bun.spawn> | null = null
let startedRig = false

/** The app's processes in the guest, and everything running out of its folder: `pid exe` lines. */
async function appProcesses(): Promise<string[]> {
  // Get-Process, not CIM: over SSH a standard user's CIM query of a desktop process answers "Access denied".
  const r = await ps(
    `Get-Process -EA 0 | Where-Object { $_.Path -like '${GUEST_APP_DIR}\\*' } | ForEach-Object { "$($_.Id) $($_.Path)" }`
  )
  return r.out.split('\n').map((l) => l.trim()).filter(Boolean)
}

async function installedVersion(): Promise<string> {
  const r = await ps(`(Get-Content -Raw '${GUEST_APP_DIR}\\resources\\app\\package.json' | ConvertFrom-Json).version`)
  return r.code === 0 ? r.out.trim() : ''
}

async function waitFor(what: string, ms: number, probe: () => Promise<boolean>): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await probe()) return true
    await sleep(2000)
  }
  log(`timed out waiting for ${what}`)
  return false
}

/** The app's light or dark theme, switched as lib/appearance.ts `applyThemePreference` does. */
async function scheme(cdp: Cdp, to: 'light' | 'dark'): Promise<void> {
  await cdp.eval(
    `(() => { document.documentElement.classList.toggle('theme-light', ${to === 'light'}); window.dispatchEvent(new CustomEvent('monocode:schemechange', { detail: '${to}' })); })()`
  )
  await sleep(1200)
}

async function key(cdp: Cdp, k: { key: string; code: string; vk: number }, modifiers: number): Promise<void> {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk })
  }
}

async function drive(): Promise<void> {
  if (!rigUp) {
    log('starting the rig (a fresh overlay)')
    const up = await guest([vm('up')], 600_000)
    if (up.code !== 0) throw new Error(`the rig did not start: ${up.out.slice(-400)}`)
    startedRig = true
  }
  const who = await guest([vm('ssh'), 'winver'], 60_000)
  check('the guest answers as the standard user, not elevated', /tcuser \(elevated: False\)/i.test(who.out), who.out.split('\n')[0])

  tunnel = Bun.spawn(
    [
      'ssh', '-N',
      '-L', `${CDP_PORT.old}:127.0.0.1:${GUEST_CDP_PORT.old}`,
      '-L', `${CDP_PORT.new}:127.0.0.1:${GUEST_CDP_PORT.new}`,
      '-R', `${FEED_PORT}:127.0.0.1:${FEED_PORT}`,
      '-i', paths.key, '-p', String(rig.sshPort),
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${paths.knownHosts}`,
      `${STANDARD_USER}@127.0.0.1`
    ],
    { stdout: 'ignore', stderr: 'inherit', stdin: 'ignore' }
  )
  await sleep(3000)
  const feedSeen = await ps(`(Invoke-WebRequest -UseBasicParsing ${FEED_URL}${files.feed}).Content`, 60_000)
  check('the guest reads the feed through the tunnel', feedSeen.out.includes(`version: ${NEW}`), feedSeen.out.slice(0, 120))

  // ── install ──
  const oldInstaller = winReleaseFiles(OLD).installer
  log(`copying ${oldInstaller} in (${Math.round(statSync(installerOf('old')).size / 1e6)} MB)`)
  const copied = await guest([vm('scp'), installerOf('old'), 'guest:Downloads/'], 900_000)
  if (copied.code !== 0) throw new Error(`scp failed: ${copied.out.slice(-300)}`)
  const before = Date.now()
  // Over SSH, in session 0: no desktop, so a UAC prompt could not be answered and would fail the install.
  const installed = await guest([vm('ssh'), `Downloads\\${oldInstaller} /S`], 1_200_000)
  check('the installer runs silently as the standard user and exits 0', installed.code === 0, `${((Date.now() - before) / 1000).toFixed(0)}s ${installed.out.slice(0, 200)}`)
  const landed = await waitFor('the install', 600_000, async () => (await installedVersion()) === OLD)
  check(`it installs ${OLD} into %LOCALAPPDATA%\\Programs\\${PRODUCT}`, landed, await installedVersion())
  const machineWide = await ps(`Test-Path 'C:\\Program Files\\${PRODUCT}'`)
  check('nothing was written under Program Files', machineWide.out.trim() === 'False', machineWide.out)
  const shortcut = await ps(`Test-Path "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\${PRODUCT}.lnk"`)
  check('the Start menu has its shortcut', shortcut.out.trim() === 'True', shortcut.out)

  const cli = await guest([vm('ssh'), `"${GUEST_CLI}" --version`], 120_000)
  check('the bundled Claude CLI is the win32 one and answers --version', cli.code === 0 && /\d+\.\d+\.\d+/.test(cli.out), cli.out.split('\n')[0])

  // ── the app on the desktop ──
  const started = await guest([vm('run-in-session'), GUEST_EXE], 120_000)
  check('the app starts on the standard user\'s desktop', started.code === 0, started.out.slice(0, 200))
  const cdp = await attach(CDP_PORT.old, 180_000)
  await sleep(4000)
  await shot('installed')
  const booted = await cdp.eval<Status>('window.api.updates.get()')
  check(`the app reports current ${OLD}`, booted.current === OLD, JSON.stringify(booted))
  const data = await ps(`Test-Path '${GUEST_USER_DATA}\\temp-code.db'`)
  check('its database is under %LOCALAPPDATA%', data.out.trim() === 'True', data.out)

  // ── frame ──
  const frame = await cdp.eval<{ platform: string; space: number; drawn: number; bar: number; themeColor: string | null }>(
    `(() => ({
      platform: window.api.platform,
      space: Math.round(document.querySelector('[data-caption-space]')?.getBoundingClientRect().width ?? 0),
      drawn: document.querySelectorAll('button[aria-label="Close window"], button[aria-label="Minimize window"]').length,
      bar: Math.round(document.querySelector('header[data-tauri-drag-region]')?.getBoundingClientRect().height ?? 0),
      themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null
    }))()`
  )
  check('the window is a Windows one: caption room at the bar\'s end, no controls of ours', frame.platform === 'win32' && frame.space >= 100 && frame.drawn === 0, JSON.stringify(frame))
  const overlay = await cdp.eval<boolean>('navigator.windowControlsOverlay?.visible === true')
  check("Windows draws its own caption buttons over the page (the title bar overlay is on)", overlay === true)
  // The caption glyphs follow the app's theme through theme-color (chrome/WindowControls.tsx): the shots show both.
  await scheme(cdp, 'light')
  const light = await cdp.eval<string | null>(`document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null`)
  check('the page tells main its light theme colour', !!light && light !== frame.themeColor, `${frame.themeColor} → ${light}`)
  await shot('frame-light')
  await scheme(cdp, 'dark')
  await shot('frame-dark')
  // Alt shows no menu bar: the window has none to reveal.
  await key(cdp, { key: 'Alt', code: 'AltLeft', vk: 18 }, 0)
  await sleep(800)
  await shot('after-alt')
  await key(cdp, { key: 'Escape', code: 'Escape', vk: 27 }, 0)

  // ── keys ──
  const settingsShut = await cdp.eval<boolean>(`!document.querySelector('[data-app-settings]')`)
  await key(cdp, { key: ',', code: 'Comma', vk: 188 }, 2)
  const settingsOpen = await waitFor('Settings', 15_000, () => cdp.eval<boolean>(`!!document.querySelector('[data-app-settings]')`))
  await sleep(1000)
  await shot('settings-by-ctrl-comma')
  check('Ctrl+, opens Settings', settingsShut && settingsOpen)
  // The key list: every hint in Windows' words.
  await cdp.eval(
    `(() => { const e = [...document.querySelectorAll('body *')].find((n) => n.children.length === 0 && n.textContent?.trim() === 'Keybindings'); (e?.closest('button,a,[role],[tabindex]') ?? e)?.click() })()`
  )
  await sleep(1500)
  const hints = await cdp.eval<{ kbd: string[]; glyph: boolean }>(
    `(() => ({ kbd: [...document.querySelectorAll('kbd')].map((k) => k.textContent ?? '').slice(0, 40), glyph: /[⌘⌥⇧⌃]/.test(document.body.innerText) }))()`
  )
  await shot('keybindings')
  check('the key list reads Ctrl', hints.kbd.some((k) => /Ctrl/.test(k)), hints.kbd.slice(0, 12).join(' '))
  check('no hint on the page shows a Mac glyph', !hints.glyph, hints.kbd.join(' '))
  await key(cdp, { key: 'Escape', code: 'Escape', vk: 27 }, 0)

  // ── update ──
  const checked = await cdp.eval<Status>('window.api.updates.check()')
  check(`check sees ${NEW} on the feed`, checked.latest === NEW && checked.phase !== 'error', JSON.stringify(checked))
  let status = await cdp.eval<Status>('window.api.updates.apply()')
  check('apply starts the download', status.phase === 'downloading' || status.phase === 'ready', JSON.stringify(status))
  const downloadUntil = Date.now() + 900_000
  while (status.phase !== 'ready' && status.phase !== 'error' && Date.now() < downloadUntil) {
    await sleep(2000)
    status = await cdp.eval<Status>('window.api.updates.get()')
  }
  check('download reaches ready', status.phase === 'ready', JSON.stringify(status))
  if (status.phase !== 'ready') throw new Error('download did not reach ready')
  check('the installer came off the feed', feedLog.includes(files.installer), [...new Set(feedLog)].join(', '))

  let childrenBefore: string[] = []
  if (busy) {
    // The bundled CLI running out of the install folder, which holds claude.exe open: what a warm harness
    // leaves, and a file the installer cannot replace. Started on the desktop, not through a terminal (a
    // terminal on Windows waits for milestone 13's shells), so it is the sweep's install-folder rule that
    // must end it; its walk down the app's own tree is unit-tested (updateInstall.test.ts).
    const cli = await guest([vm('run-in-session'), GUEST_CLI], 120_000)
    log(`bundled CLI on the desktop: ${cli.out.slice(0, 160)}`)
    await waitFor('the bundled CLI', 60_000, async () => (await appProcesses()).some((l) => /claude\.exe$/i.test(l)))
    childrenBefore = (await appProcesses()).filter((l) => !l.toLowerCase().endsWith(`${PRODUCT.toLowerCase()}.exe`))
    check('a bundled claude.exe runs out of the install folder before the restart', childrenBefore.some((l) => /claude\.exe$/i.test(l)), childrenBefore.join(' | '))
    await shot('busy-before-restart')
  }

  log(`apply again: restart to update${busy ? ' (busy)' : ''}`)
  const restartAt = Date.now()
  await cdp.eval<Status>('window.api.updates.apply()').catch((e) => log(`apply (restart) threw: ${(e as Error).message}`))
  cdp.close()
  await sleep(6000)
  await shot('installing')
  const swapped = await waitFor(`the folder to hold ${NEW}`, 900_000, async () => (await installedVersion()) === NEW)
  check(`the installed folder holds ${NEW}`, swapped, `${await installedVersion()} ${((Date.now() - restartAt) / 1000).toFixed(0)}s after restart`)
  // What runs while the installer works, until the app is back with its CDP port: the log says how long each part took.
  const back = await waitFor('the app to come back', 1_200_000, async () => {
    const r = await ps(
      `$p = @(Get-Process -EA 0 | Where-Object { $_.Path -like '${GUEST_APP_DIR}\\*' -or $_.Name -like '*setup*' -or $_.Name -like 'Un_*' } | ForEach-Object { "$($_.Name):$($_.Id)" }) -join ' '; $l = [bool]((netstat -ano | Out-String) -match ':${GUEST_CDP_PORT.new} .*LISTEN'); "$l $p"`
    )
    log(`+${((Date.now() - restartAt) / 1000).toFixed(0)}s ${r.out.replace(/\s+/g, ' ').slice(0, 300)}`)
    if ((Date.now() - restartAt) % 60_000 < 12_000) await shot('installing')
    return r.out.startsWith('True')
  })
  check('the installer started the app again, with its CDP port', back, `${((Date.now() - restartAt) / 1000).toFixed(0)}s after restart`)

  const relaunched = await attach(CDP_PORT.new, 120_000).catch((e) => {
    check('the installer started the app again', false, (e as Error).message)
    return null
  })
  if (relaunched) {
    const version = await relaunched.eval<string>('window.api.app.version()')
    check(`the relaunched app answers ${NEW}`, version === NEW, version)
    const after = await relaunched.eval<Status>('window.api.updates.get()')
    check('it reports no pending update and no failure', after.current === NEW && after.phase !== 'error' && !after.installFailure, JSON.stringify(after))
    const record = await ps(`Test-Path '${GUEST_USER_DATA}\\update-attempt.json'`)
    check('the attempt record was cleared after the install', record.out.trim() === 'False', record.out)
    await sleep(3000)
    await shot('updated')
    if (busy) {
      const now = await appProcesses()
      const survivors = childrenBefore.map((l) => l.split(' ')[0]).filter((pid) => now.some((l) => l.startsWith(`${pid} `)))
      check('the children alive before the restart are gone', survivors.length === 0, survivors.join(' '))
    }
    relaunched.close()
  }
}

try {
  await drive()
} catch (e) {
  check('e2e run', false, (e as Error).message)
  await shot('failed').catch(() => undefined)
} finally {
  tunnel?.kill()
  server.stop(true)
  if (startedRig) {
    log('stopping the rig')
    await guest([vm('down')], 300_000)
  }
}

log(`artifacts under ${ROOT}; screenshots in ${SHOTS}`)
console.log(failures === 0 ? 'E2E UPDATER (WINDOWS): PASS' : `E2E UPDATER (WINDOWS): ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
