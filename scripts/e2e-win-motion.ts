#!/usr/bin/env bun
/**
 * Motion on Windows, in the rig (docs/agents/windows-vm.md), on an installed build: the marks of work move
 * whatever Windows' animation effects say, and Settings → Appearance → Motion governs the large motion.
 * Run on the box with the rig up and the build installed (scripts/e2e-win-install.ts --rig-up does both):
 *
 *   bun scripts/e2e-win-motion.ts
 *
 * Four cases, each a fresh thread opened in the window and one streamed reply sampled every 100 ms:
 *   Windows' animation effects off, Motion Follow this computer → reduced: marks of work move, no rise
 *   Windows' animation effects on, Follow this computer → full: the same, and a block born mid-stream rises
 *   Windows on, Motion Reduced → reduced, the marks still moving
 *   Windows off, Motion Full → full
 * "Moving" is read from the page: a spinner, the working mark's dots and the shimmer's band holding running
 * Web Animations, and the stream's word spans running their CSS fade. The effects setting is
 * SPI_SETCLIENTAREAANIMATION in tcuser's session, as Settings → Accessibility → Visual effects sets it.
 * It lends the box's Claude sign-in (refresh token blanked) as e2e-win-install.ts does, and removes it and
 * the app's data at the end. Screenshots in /tmp/tc-win-motion.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { attach, REPO, sleep, type Cdp } from './lib/packagedApp'
import { rigConfig, rigPaths, STANDARD_USER } from '../src/main/server/work/winvm/machine/config'

const ROOT = '/tmp/tc-win-motion'
const GUEST_HOME = `C:\\Users\\${STANDARD_USER}`
const APP_DIR = `${GUEST_HOME}\\AppData\\Local\\Programs\\TempCode`
const DATA_DIR = `${GUEST_HOME}\\AppData\\Local\\temp-code`
const GUEST_CDP = 9333
const CDP = 9342
const SERVER_LOCAL = 9343

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (msg: string): void => console.log(`[e2e-win-motion ${new Date().toISOString().slice(11, 19)}] ${msg}`)

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

/** Windows' animation effects, set or read in tcuser's desktop session (the setting is per session). */
const SPI = `param([string]$set = '')
Add-Type -Namespace W -Name S -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, ref bool c, uint d);
[DllImport("user32.dll", EntryPoint="SystemParametersInfo")] public static extern bool SetInt(uint a, uint b, IntPtr c, uint d);
'@
if ($set -ne '') { [W.S]::SetInt(0x1043, 0, [IntPtr]([int]$set), 3) | Out-Null }
$v = $false; [W.S]::SystemParametersInfo(0x1042, 0, [ref]$v, 0) | Out-Null
"animation-effects=$v"
`
async function effects(on: boolean): Promise<string> {
  const r = await guest([vm('run-in-session'), '--wait', '--timeout', '60', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${GUEST_HOME}\\tc-spi.ps1`, on ? '1' : '0'], 120_000)
  return r.out.trim().split('\n').pop() ?? ''
}

async function rpc<T = unknown>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${SERVER_LOCAL}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => (ws.close(), fail(new Error(`no answer to ${method}`))), timeoutMs)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'motion', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'motion') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(frame.error))
    })
    ws.addEventListener('error', () => (clearTimeout(timer), fail(new Error(`socket error on ${method}`))))
  })
}

const tunnels: ReturnType<typeof Bun.spawn>[] = []
const openTunnel = (forward: string): void => {
  tunnels.push(
    Bun.spawn(
      ['ssh', '-N', '-L', forward, '-i', paths.key, '-p', String(rig.sshPort), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${paths.knownHosts}`, `${STANDARD_USER}@127.0.0.1`],
      { stdout: 'ignore', stderr: 'inherit', stdin: 'ignore' },
    ),
  )
}
let shotNo = 0
async function shot(name: string): Promise<void> {
  const file = join(ROOT, `${String(++shotNo).padStart(2, '0')}-${name}.png`)
  const r = await guest([vm('shot'), file], 30_000)
  log(r.code === 0 ? `screenshot ${file}` : `screenshot failed: ${r.out.slice(0, 200)}`)
}

/** What moved during one reply, sampled in the page every 100 ms for `ms`. */
type Sample = {
  motion: string | null
  reduce: boolean
  spinnersTurning: number
  markMoving: number
  shimmerMoving: number
  stepsFading: number
  steps: number
  rises: string[]
  answered: boolean
}
const SAMPLER = (ms: number, word: string): string => `(async () => {
  const s = { motion: null, reduce: false, spinnersTurning: 0, markMoving: 0, shimmerMoving: 0, stepsFading: 0, steps: 0, rises: [], answered: false }
  const running = (el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length
  const until = performance.now() + ${ms}
  while (performance.now() < until) {
    s.motion = document.documentElement.dataset.motion ?? null
    s.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const el of document.querySelectorAll('[data-slot=spinner]')) if (running(el)) s.spinnersTurning++
    for (const el of document.querySelectorAll('[data-slot=working-mark]')) if (running(el)) s.markMoving++
    for (const el of document.querySelectorAll('[data-shimmer=band]')) if (running(el)) s.shimmerMoving++
    const steps = document.querySelectorAll('.stream-step')
    s.steps += steps.length
    for (const el of steps) if (el.getAnimations().some((a) => a.animationName === 'stream-step-in' && a.playState === 'running')) s.stepsFading++
    for (const el of document.querySelectorAll('.stream-rise')) s.rises.push(getComputedStyle(el).animationName)
    if (document.body.innerText.includes(${JSON.stringify(word)})) { s.answered = true; break }
    await new Promise((d) => setTimeout(d, 100))
  }
  s.rises = [...new Set(s.rises)]
  return s
})()`

async function oneCase(page: Cdp, label: string, windowsOn: boolean, choice: 'system' | 'full' | 'reduced', want: 'full' | 'reduced'): Promise<void> {
  log(`case: ${label}`)
  const said = await effects(windowsOn)
  await page.eval(`(() => { if (${JSON.stringify(choice)} === 'system') localStorage.removeItem('monocode.motion'); else localStorage.setItem('monocode.motion', ${JSON.stringify(choice)}); window.dispatchEvent(new Event('monocode:motionchange')) })()`)
  await sleep(1500)
  const title = `Motion ${shotNo + 1}`
  const meta = await rpc<{ id: string }>('session.create', { provider: 'claude', cwd: `${GUEST_HOME}\\tc-proof`, title, threadType: 'chat', permission: 'auto' })
  await sleep(1500)
  // Open the thread in the window: its row in the rail or the Chats list.
  // The innermost element holding the title; the click bubbles to its row.
  const opened = await page.eval<boolean>(`(() => {
    const holders = [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && el.textContent?.includes(${JSON.stringify(title)}))
    holders[0]?.click()
    return holders.length > 0
  })()`)
  await sleep(1500)
  const word = `DONE-${shotNo + 1}`
  const sampling = page.eval<Sample>(SAMPLER(90_000, word))
  await rpc('session.send', { sessionId: meta.id, text: `Write a numbered list of twelve plain sentences about rivers, one per line, then a short table of three rivers and their lengths, then the word ${word} alone on the last line.`, model: 'claude-sonnet-5-5', reasoning: 'low' })
  await sleep(6000)
  void shot(label.replace(/\W+/g, '-').toLowerCase())
  const s = await sampling
  log(`${label}: ${said}; ${JSON.stringify(s)}`)
  check(`${label}: the window reads ${want} motion`, s.motion === want, `data-motion=${s.motion}, reduce query=${s.reduce}, opened=${opened}`)
  check(`${label}: the reply streamed to the end`, s.answered && s.steps > 0, `steps sampled ${s.steps}`)
  check(`${label}: the working mark or the shimmer moved while it worked`, s.markMoving + s.shimmerMoving > 0, `mark ${s.markMoving}, shimmer ${s.shimmerMoving}, spinners ${s.spinnersTurning}`)
  check(`${label}: streamed words faded in`, s.stepsFading > 0, `${s.stepsFading} fading of ${s.steps}`)
  const rose = s.rises.some((names) => names.includes('stream-rise-in'))
  if (s.rises.length) check(`${label}: a block born mid-stream ${want === 'full' ? 'rises' : 'only fades'}`, want === 'full' ? rose : !rose, s.rises.join(' / '))
}

async function run(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  const installed = await ps(`Test-Path '${APP_DIR}\\TempCode.exe'`)
  if (installed.out.trim() !== 'True') throw new Error('TempCode is not installed in the rig: run scripts/e2e-win-install.ts --rig-up first')
  writeFileSync(join(ROOT, 'tc-spi.ps1'), SPI)
  await guest([vm('scp'), join(ROOT, 'tc-spi.ps1'), 'guest:tc-spi.ps1'], 60_000)

  const credsFile = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(credsFile)) throw new Error(`no ${credsFile} on the box`)
  const creds = JSON.parse(readFileSync(credsFile, 'utf8')) as { claudeAiOauth?: Record<string, unknown> }
  if (creds.claudeAiOauth) creds.claudeAiOauth.refreshToken = ''
  const lent = join(ROOT, '.credentials.json')
  writeFileSync(lent, JSON.stringify(creds), { mode: 0o600 })
  await ps(`New-Item -ItemType Directory -Force "$env:USERPROFILE\\.claude", "$env:USERPROFILE\\tc-proof" | Out-Null`)
  const sent = await guest([vm('scp'), lent, 'guest:.claude/.credentials.json'], 60_000)
  rmSync(lent, { force: true })
  if (!check('a Claude sign-in is lent to the guest', sent.code === 0, sent.out.slice(0, 120))) return

  await ps(`[Environment]::SetEnvironmentVariable('TEMP_CODE_DEBUG_PORT', '${GUEST_CDP}', 'User'); Get-Process TempCode -EA 0 | Stop-Process -Force -EA 0; Start-Sleep 3`)
  const start = async (): Promise<Cdp> => {
    await guest([vm('run-in-session'), `${APP_DIR}\\TempCode.exe`], 120_000)
    await sleep(4000)
    const page = await attach(CDP, 180_000)
    await sleep(4000)
    // A fresh install offers a setup link first.
    await page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip')?.click()`)
    return page
  }
  openTunnel(`${CDP}:127.0.0.1:${GUEST_CDP}`)
  let page = await start()
  const captured = await page.eval<{ ok?: boolean; error?: string }>("window.aliax.capture('claude-code')").catch((e: Error) => ({ ok: false, error: e.message }))
  check('the lent account is saved in the app', captured?.ok !== false, JSON.stringify(captured).slice(0, 160))
  await ps('Get-Process TempCode -EA 0 | Stop-Process -Force -EA 0; Start-Sleep 4')
  page = await start()
  const port = await page.eval<number>('window.api.getServerPort()')
  openTunnel(`${SERVER_LOCAL}:127.0.0.1:${port}`)
  await sleep(3000)

  await oneCase(page, 'Windows animations off, Follow this computer', false, 'system', 'reduced')
  await oneCase(page, 'Windows animations on, Follow this computer', true, 'system', 'full')
  await oneCase(page, 'Windows animations on, Motion Reduced', true, 'reduced', 'reduced')
  await oneCase(page, 'Windows animations off, Motion Full', false, 'full', 'full')
}

try {
  await run()
} catch (error) {
  check('the run finished', false, String(error))
} finally {
  await effects(true).catch(() => null)
  const gone = await ps(
    `Get-Process TempCode,claude,tc-computer -EA 0 | Stop-Process -Force -EA 0; Start-Sleep 3; Remove-Item -Force "$env:USERPROFILE\\.claude\\.credentials.json" -EA 0; Remove-Item -Recurse -Force '${DATA_DIR}', "$env:USERPROFILE\\.aliax" -EA 0; Test-Path "$env:USERPROFILE\\.claude\\.credentials.json"`,
  )
  check('the lent sign-in and the app data are gone from the guest', gone.out.trim().split('\n').pop() === 'False', gone.out.slice(-80))
  await ps(`[Environment]::SetEnvironmentVariable('TEMP_CODE_DEBUG_PORT', $null, 'User')`).catch(() => null)
  for (const t of tunnels) t.kill()
}
console.log(failures === 0 ? 'E2E WIN MOTION: PASS' : `E2E WIN MOTION: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
