#!/usr/bin/env bun
/**
 * The released Windows installer, installed as a person would: in the rig (docs/agents/windows-vm.md),
 * as the standard user, never elevated. Run on the box.
 *
 *   bun scripts/e2e-win-install.ts --installer dist/temp-code-1.0.N-setup.exe   a build of ours, copied in
 *   bun scripts/e2e-win-install.ts --url https://github.com/…/temp-code-1.0.N-setup.exe   the guest downloads it
 *   --rig-up   the rig is up and yours: use it, leave it running
 *   --no-thread  skip the Claude turn (no sign-in is lent to the guest)
 *
 * What it checks: the installer runs silently with no admin and lands in %LOCALAPPDATA%\Programs\TempCode
 * (nothing under Program Files), with the Start menu shortcut; the app carries the win32 claude.exe (it
 * answers --version), node-pty's x64 prebuild with ConPTY, and tc-computer.exe (it answers `version`); the
 * app starts on the desktop, its data under %LOCALAPPDATA%\temp-code, its feed config naming GitHub; its
 * updater reads the real feed (strictly, for a released installer); a Claude thread runs one turn and
 * answers; and its computer call starts tc-computer.exe out of the install folder.
 *
 * The turn needs a sign-in: the box's Claude credentials go into the guest's ~/.claude with the refresh
 * token blanked (so nothing there can rotate the box's), as milestone 13 did, saved in the app's Accounts,
 * and deleted at the end with the app's data and its account store. Screenshots in /tmp/tc-win-install/shots.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { attach, REPO, sleep } from './lib/packagedApp'
import { rigConfig, rigPaths, STANDARD_USER } from '../src/main/server/work/winvm/machine/config'

const ROOT = '/tmp/tc-win-install'
const SHOTS = join(ROOT, 'shots')
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const installerPath = arg('--installer')
const url = arg('--url')
const rigUp = process.argv.includes('--rig-up')
const withThread = !process.argv.includes('--no-thread')
if (!installerPath === !url) {
  console.error('usage: bun scripts/e2e-win-install.ts (--installer FILE | --url URL) [--rig-up] [--no-thread]')
  process.exit(64)
}
const installerName = basename(installerPath ?? new URL(url!).pathname)
const version = /-(1\.0\.\d+)-setup\.exe$/.exec(installerName)?.[1]
if (!version) throw new Error(`${installerName} is not temp-code-1.0.N-setup.exe`)

const GUEST_HOME = `C:\\Users\\${STANDARD_USER}`
const GUEST_LOCAL = `${GUEST_HOME}\\AppData\\Local`
const APP_DIR = `${GUEST_LOCAL}\\Programs\\TempCode`
const APP_RES = `${APP_DIR}\\resources\\app`
/** Electron's own name for the app's folder, the package's name, moved under %LOCALAPPDATA% (windowFrame.ts `localUserData`). */
const DATA_DIR = `${GUEST_LOCAL}\\temp-code`
const GUEST_CDP = 9333
const CDP = 9338
const SERVER_LOCAL = 9339

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (msg: string): void => console.log(`[e2e-win-install ${new Date().toISOString().slice(11, 19)}] ${msg}`)

const rig = rigConfig()
const paths = rigPaths(rig)
const vm = (script: string): string => join(REPO, 'scripts', 'win-vm', `${script}.sh`)
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
async function waitFor(what: string, ms: number, probe: () => Promise<boolean>): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await probe()) return true
    await sleep(3000)
  }
  log(`timed out waiting for ${what}`)
  return false
}

/** One request on the app's local socket (the implicit admin), reached through the tunnel. */
async function rpc<T = unknown>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${SERVER_LOCAL}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => (ws.close(), fail(new Error(`no answer to ${method}`))), timeoutMs)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(frame.error))
    })
    ws.addEventListener('error', () => (clearTimeout(timer), fail(new Error(`socket error on ${method}`))))
  })
}

let tunnel: ReturnType<typeof Bun.spawn> | null = null
const extraTunnels: ReturnType<typeof Bun.spawn>[] = []
let startedRig = false
let lentCredentials = false

async function run(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  if (!rigUp) {
    log('starting the rig (a fresh overlay)')
    const up = await guest([vm('up')], 900_000)
    if (up.code !== 0) throw new Error(`the rig did not start: ${up.out.slice(-400)}`)
    startedRig = true
  }
  const who = await guest([vm('ssh'), 'winver'], 60_000)
  check('the guest answers as the standard user, not elevated', /tcuser \(elevated: False\)/i.test(who.out), who.out.split('\n')[0])

  // ── the installer in ──
  const before = Date.now()
  if (url) {
    const got = await ps(`$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing '${url}' -OutFile "$env:USERPROFILE\\Downloads\\${installerName}"; (Get-Item "$env:USERPROFILE\\Downloads\\${installerName}").Length`, 1_200_000)
    check(`the guest downloads ${installerName} from GitHub`, got.code === 0 && Number(got.out.trim().split('\n').pop()) > 100e6, `${got.out.slice(-80)} in ${((Date.now() - before) / 1000).toFixed(0)}s`)
  } else {
    const copied = await guest([vm('scp'), resolve(installerPath!), 'guest:Downloads/'], 900_000)
    if (copied.code !== 0) throw new Error(`scp failed: ${copied.out.slice(-300)}`)
  }

  // ── install, silently, in session 0 where no UAC prompt could be answered ──
  const t0 = Date.now()
  const installed = await guest([vm('ssh'), `Downloads\\${installerName} /S`], 1_800_000)
  check('the installer runs silently as the standard user and exits 0', installed.code === 0, `${((Date.now() - t0) / 1000).toFixed(0)}s ${installed.out.slice(0, 200)}`)
  const installedVersion = async (): Promise<string> => (await ps(`(Get-Content -Raw '${APP_RES}\\package.json' | ConvertFrom-Json).version`)).out.trim()
  check(`it installs ${version} into %LOCALAPPDATA%\\Programs\\TempCode`, await waitFor('the install', 600_000, async () => (await installedVersion()) === version), await installedVersion())
  const machineWide = await ps(`Test-Path 'C:\\Program Files\\TempCode'; Test-Path 'C:\\Program Files (x86)\\TempCode'`)
  check('nothing was written under Program Files', machineWide.out.trim().split(/\s+/).every((l) => l === 'False'), machineWide.out)
  const shortcut = await ps(`Test-Path "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\TempCode.lnk"`)
  check('the Start menu has its TempCode shortcut', shortcut.out.trim() === 'True', shortcut.out)

  // ── what the app carries ──
  const cli = await guest([vm('ssh'), `"${APP_RES}\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe" --version`], 120_000)
  check('the bundled win32 claude.exe answers --version', cli.code === 0 && /\d+\.\d+\.\d+/.test(cli.out), cli.out.split('\n')[0])
  const pty = await ps(`'pty.node','conpty.node','conpty\\conpty.dll','conpty\\OpenConsole.exe' | ForEach-Object { Test-Path "${APP_RES}\\node_modules\\node-pty\\prebuilds\\win32-x64\\$_" }`)
  check("node-pty's win32-x64 prebuild is there with ConPTY", pty.out.trim().split(/\s+/).every((l) => l === 'True'), pty.out.replace(/\s+/g, ' '))
  const service = await guest([vm('run-in-session'), '--wait', '--timeout', '60', `${APP_RES}\\resources\\native\\tc-computer.exe`, 'version'], 120_000)
  check('tc-computer.exe is inside and answers its version on the desktop', service.code === 0 && /^\d+\.\d+\.\d+/m.test(service.out), service.out.slice(0, 80))
  const feed = await ps(`Get-Content -Raw '${APP_DIR}\\resources\\app-update.yml'`)
  check('the feed config names github LandonDev/temp-code', ['provider: github', 'owner: LandonDev', 'repo: temp-code'].every((l) => feed.out.includes(l)), feed.out.replace(/\s+/g, ' '))

  // ── a sign-in lent for one turn ──
  if (withThread) {
    const credsFile = join(homedir(), '.claude', '.credentials.json')
    if (!existsSync(credsFile)) throw new Error(`no ${credsFile} on the box: run with --no-thread`)
    const creds = JSON.parse(readFileSync(credsFile, 'utf8')) as { claudeAiOauth?: Record<string, unknown> }
    if (creds.claudeAiOauth) creds.claudeAiOauth.refreshToken = ''
    const lent = join(ROOT, '.credentials.json')
    writeFileSync(lent, JSON.stringify(creds), { mode: 0o600 })
    await ps(`New-Item -ItemType Directory -Force "$env:USERPROFILE\\.claude", "$env:USERPROFILE\\tc-proof" | Out-Null`)
    const sent = await guest([vm('scp'), lent, 'guest:.claude/.credentials.json'], 60_000)
    rmSync(lent, { force: true })
    lentCredentials = sent.code === 0
    check('a Claude sign-in is lent to the guest for the turn', lentCredentials, sent.out.slice(0, 120))
  }

  // ── the app on the desktop, with a debug port of its own ──
  await ps(`[Environment]::SetEnvironmentVariable('TEMP_CODE_DEBUG_PORT', '${GUEST_CDP}', 'User')`)
  const started = await guest([vm('run-in-session'), `${APP_DIR}\\TempCode.exe`], 120_000)
  check("the app starts on the standard user's desktop", started.code === 0, started.out.slice(0, 200))
  const openTunnel = (forwards: string[]): ReturnType<typeof Bun.spawn> =>
    Bun.spawn(
      [
        'ssh', '-N', ...forwards.flatMap((f) => ['-L', f]),
        '-i', paths.key, '-p', String(rig.sshPort),
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
        '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${paths.knownHosts}`,
        `${STANDARD_USER}@127.0.0.1`
      ],
      { stdout: 'ignore', stderr: 'inherit', stdin: 'ignore' }
    )
  tunnel = openTunnel([`${CDP}:127.0.0.1:${GUEST_CDP}`])
  await sleep(3000)
  const cdp = await attach(CDP, 180_000)
  await sleep(5000)
  await shot('started')
  const platform = await cdp.eval<string>('window.api.platform')
  check('the window is the Windows build', platform === 'win32', platform)
  const db = await ps(`Test-Path '${DATA_DIR}\\temp-code.db'; Test-Path "$env:APPDATA\\temp-code\\temp-code.db"`)
  check('its database is under %LOCALAPPDATA%\\temp-code, not the roaming profile', db.out.trim().split(/\s+/).join(' ') === 'True False', db.out.replace(/\s+/g, ' '))
  const port = await cdp.eval<number | null>('window.api.getServerPort()')
  check("the app's server is up", typeof port === 'number' && port > 0, String(port))
  extraTunnels.push(openTunnel([`${SERVER_LOCAL}:127.0.0.1:${port}`]))
  await sleep(3000)

  // ── the updater reads the real feed ──
  type Status = { current: string; latest: string | null; phase: string; error?: string }
  await cdp.eval('window.api.updates.check()').catch(() => null)
  let status: Status | null = null
  await waitFor('the update check', 90_000, async () => {
    status = await cdp.eval<Status>('window.api.updates.get()')
    // A check that found nothing newer ends idle with latest null; checked says it ran.
    return (status as Status & { checked?: boolean }).checked === true && status.phase !== 'checking'
  })
  const s = status as Status | null
  // A build of ours before its release has Windows files reads a feed with no latest.yml yet: only the
  // installer downloaded from a release (--url) is held to a clean check.
  if (url) check(`the updater reads GitHub's latest.yml without an error (current ${version})`, !!s && s.current === version && s.phase !== 'error', JSON.stringify(s))
  else log(`the updater's check: ${JSON.stringify(s)}`)

  // ── a thread runs one turn ──
  if (withThread && lentCredentials) {
    // The gateway runs a turn only on an account the app saved (Accounts, or this call).
    const captured = await cdp.eval<{ ok?: boolean; error?: string }>("window.aliax.capture('claude-code')").catch((e: Error) => ({ ok: false, error: e.message }))
    check('the lent account is saved in the app (Accounts)', captured?.ok !== false, JSON.stringify(captured).slice(0, 160))
    // The gateway reads the saved accounts when it starts: start the app again so it holds this one.
    await ps('Get-Process TempCode -EA 0 | Stop-Process -Force -EA 0; Start-Sleep 4')
    for (const t of extraTunnels.splice(0)) t.kill()
    const again = await guest([vm('run-in-session'), `${APP_DIR}\\TempCode.exe`], 120_000)
    check('the app starts again with the account saved', again.code === 0, again.out.slice(0, 120))
    const restarted = await attach(CDP, 180_000)
    await sleep(5000)
    const nextPort = await restarted.eval<number | null>('window.api.getServerPort()')
    extraTunnels.push(openTunnel([`${SERVER_LOCAL}:127.0.0.1:${nextPort}`]))
    await sleep(3000)
    const meta = await rpc<{ id: string }>('session.create', { provider: 'claude', cwd: `${GUEST_HOME}\\tc-proof`, title: 'Windows install proof', threadType: 'chat', permission: 'auto' })
    await rpc('session.send', { sessionId: meta.id, text: 'Reply with exactly WIN-INSTALL-OK and nothing else.', model: 'claude-sonnet-5-5', reasoning: 'low' })
    type Ev = { seq: number; event: { type: string; text?: string; message?: string } }
    let said = ''
    const answered = await waitFor('the answer', 300_000, async () => {
      const events = await rpc<Ev[]>('session.events', { sessionId: meta.id, afterSeq: 0 })
      said = events.map((e) => `${e.event.type}:${(e.event.text ?? e.event.message ?? '').slice(0, 120)}`).slice(-6).join(' | ')
      return events.some((e) => (e.event.text ?? '').includes('WIN-INSTALL-OK') && !/user/i.test(e.event.type))
    })
    await shot('thread')
    check('a Claude thread runs one turn and answers', answered, said)

    // ── computer use: the app starts tc-computer.exe for a thread's first computer call ──
    await rpc('session.send', { sessionId: meta.id, text: 'Call the computer_apps tool once (it only reads which apps are open), then reply with exactly WIN-COMPUTER-OK.', model: 'claude-sonnet-5-5', reasoning: 'low' })
    const served = await waitFor('tc-computer.exe', 240_000, async () => (await ps(`@(Get-Process tc-computer -EA 0).Count`)).out.trim() !== '0')
    const events = await rpc<Ev[]>('session.events', { sessionId: meta.id, afterSeq: 0 })
    const tail = events.map((e) => `${e.event.type}:${(e.event.text ?? e.event.message ?? '').slice(0, 100)}`).slice(-6).join(' | ')
    await shot('computer')
    check('a computer call starts tc-computer.exe from the install folder', served, tail)
  } else {
    const state = await rpc<unknown>('computer.service.retry').catch((e: Error) => ({ error: e.message }))
    const procs = await waitFor('tc-computer.exe', 60_000, async () => (await ps(`@(Get-Process tc-computer -EA 0).Count`)).out.trim() !== '0')
    check('the computer-use service starts (a tc-computer.exe process)', procs, JSON.stringify(state).slice(0, 200))
  }
}

try {
  await run()
} catch (error) {
  check('the run finished', false, String(error))
} finally {
  {
    const gone = await ps(
      `Get-Process TempCode,claude,tc-computer -EA 0 | Stop-Process -Force -EA 0; Start-Sleep 3; Remove-Item -Force "$env:USERPROFILE\\.claude\\.credentials.json" -EA 0; Remove-Item -Recurse -Force '${DATA_DIR}', "$env:USERPROFILE\\.aliax" -EA 0; Test-Path "$env:USERPROFILE\\.claude\\.credentials.json"`
    )
    check('the lent sign-in and the app data are gone from the guest', gone.out.trim().split('\n').pop() === 'False', gone.out.slice(-80))
  }
  await ps(`[Environment]::SetEnvironmentVariable('TEMP_CODE_DEBUG_PORT', $null, 'User')`).catch(() => null)
  tunnel?.kill()
  for (const t of extraTunnels) t.kill()
  if (startedRig) await guest([vm('down')], 300_000)
}
console.log(failures === 0 ? 'E2E WIN INSTALL: PASS' : `E2E WIN INSTALL: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
