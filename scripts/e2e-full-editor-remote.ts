/**
 * The box's full editor opened from another computer's window (docs/agents/work-sheets.md "The full editor"; the
 * owner's words of 2026-11-24, "going from TempCode to full editor errors saying The full editor has no address of its
 * own on the box").
 *
 * Two isolated instances of the BUILT tree under xvfb, set up as his Mac and his box are: "box" is headless, runs
 * ONLYOFFICE from the box's installed tools (linked, never written) and hosts a scratch Work workspace with a dummy
 * workbook; "mac" is windowed and reaches box over a saved link with a client key minted for the run (revoked at the
 * end). Between them stands a stand-in tunnel that adds Cloudflare's headers, as the real one does, and box names it
 * as its public origin. Then:
 *  1. mac's window shows the thread's sheet; the switch "Full editor" is offered there, and pressed by a real click
 *  2. mac's app carries the page on a loopback origin of its own and opens it (a stand-in xdg-open on its PATH takes
 *     the address): never the tunnel's origin
 *  3. the page's token straight through the tunnel, as a browser on the remote UI's origin would ask it, is refused
 *  4. headless Chromium opens the carried page, types a value into a cell of the full editor and leaves; box's file
 *     holds the value once the editor saves it back
 * Pictures go to the out folder. Dummy files only.
 *
 * Run (repo root, after `bunx electron-vite build`; on the box through the heavy queue):
 *   FULL_EDITOR_PLAYWRIGHT=<playwright-core> env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-full-editor-remote.ts [--out <dir>]
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as httpServer, request as httpRequest } from 'node:http'
import { connect, createServer, type Socket } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { E2E_APP_TOKEN_SEED, withAppToken } from './lib/appToken'
import { attach, type Cdp } from './lib/packagedApp'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_E2E_KEEP === '1'
const TOOLS = process.env.FULL_EDITOR_TOOLS ?? '/srv/agents/temp-code-data/work-tools'
const CHROME = process.env.FULL_EDITOR_CHROME ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome')
const outArg = process.argv.indexOf('--out')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
if (!existsSync(join(REPO, 'out', 'renderer', 'index.html'))) {
  console.error('out/ is missing: run electron-vite build first')
  process.exit(2)
}
if (!existsSync(join(TOOLS, 'onlyoffice'))) {
  console.error(`ONLYOFFICE is not installed under ${TOOLS}`)
  process.exit(2)
}
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

const root = Bun.spawnSync(['realpath', mkdtempSync(join(tmpdir(), 'tc-full-remote-'))]).stdout.toString().trim()
const out = outArg > 0 ? resolve(process.argv[outArg + 1]!) : join(root, 'shots')
mkdirSync(out, { recursive: true })
type Inst = { name: string; home: string; data: string; tmp: string; work: string; remote: number; debug: number; log: string; proc?: ChildProcess }
const mk = async (name: string): Promise<Inst> => {
  const home = join(root, `${name}-home`)
  const inst = { name, home, data: join(root, `${name}-data`), tmp: join(root, `${name}-tmp`), work: join(home, 'work'), remote: await freePort(), debug: await freePort(), log: join(root, `${name}.log`) }
  for (const d of [inst.home, inst.data, inst.tmp, inst.work]) mkdirSync(d, { recursive: true })
  return inst
}
const mac = await mk('mac')
const box = await mk('box')
const boxWork = await freePort()
const tunnelPort = await freePort()
const tunnel = `http://127.0.0.1:${tunnelPort}`

// box runs the installed ONLYOFFICE, linked; its own state names that tool alone.
{
  const mine = join(box.data, 'work-tools')
  mkdirSync(mine, { recursive: true })
  const state = JSON.parse(readFileSync(join(TOOLS, 'state.json'), 'utf8')) as { platform: string; tools: Record<string, unknown> }
  writeFileSync(join(mine, 'state.json'), JSON.stringify({ platform: state.platform, at: 1, tools: { onlyoffice: state.tools.onlyoffice } }))
  symlinkSync(join(TOOLS, 'onlyoffice'), join(mine, 'onlyoffice'))
}
// mac opens what its app hands the system browser with this: the address goes to a file the run reads.
const opened = join(root, 'opened.txt')
const bin = join(root, 'mac-bin')
mkdirSync(bin)
writeFileSync(join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`)
chmodSync(join(bin, 'xdg-open'), 0o755)

// The stand-in tunnel: box's Work port behind Cloudflare's headers, as cloudflared delivers the remote UI's hostname.
const CF = { 'cf-ray': 'e2e-ray', 'cf-connecting-ip': '203.0.113.9' }
const tunnelServer = httpServer((req, res) => {
  const up = httpRequest({ host: '127.0.0.1', port: boxWork, path: req.url, method: req.method, headers: { ...req.headers, ...CF } }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers)
    answer.pipe(res)
  })
  up.on('error', () => res.writeHead(502).end())
  req.pipe(up)
})
tunnelServer.on('upgrade', (req, socket: Socket, head: Buffer) => {
  const up = connect(boxWork, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [k, v] of Object.entries({ ...req.headers, ...CF })) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`)
    up.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  })
  up.on('error', () => socket.destroy())
  socket.on('error', () => up.destroy())
})
await new Promise<void>((r) => tunnelServer.listen(tunnelPort, '127.0.0.1', () => r()))

function launch(inst: Inst, windowed: boolean, extra: Record<string, string>): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_APP_TOKEN_SEED: E2E_APP_TOKEN_SEED,
    TEMP_CODE_HEADLESS: windowed ? '0' : '1',
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
    TEMP_CODE_WORK_ROOT: inst.work,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ...extra
  }
  for (const key of Object.keys(env)) if (/^TEMP_CODE_(HUB|APNS)_/.test(key)) delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  if (windowed) env.TEMP_CODE_DEBUG_PORT = String(inst.debug)
  else delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv = ['xvfb-run', '-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
  const proc = spawn(argv[0]!, argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  inst.proc = proc
}
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(250)
  }
  log(`timed out: ${label}`)
  return false
}
const ports = new Map<string, number>()
const portOf = (inst: Inst): number => ports.get(inst.name) ?? (JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }).port
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => (ws.close(), fail(new Error(`${inst.name}: no answer to ${method}`))), timeoutMs)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params: withAppToken(method, params) })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(frame.error))
    })
    ws.addEventListener('error', () => (clearTimeout(timer), fail(new Error(`${inst.name}: socket error on ${method}`))))
  })
}

let cdp: Cdp | null = null
const ev = <T>(js: string): Promise<T> => cdp!.eval<T>(js)
async function shot(name: string): Promise<void> {
  const r = (await cdp!.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(join(out, `${name}.png`), Buffer.from(r.data, 'base64'))
}
async function click(x: number, y: number): Promise<void> {
  await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (const type of ['mousePressed', 'mouseReleased']) await cdp!.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
}
const unzip = (file: string, part: string): string => Bun.spawnSync(['unzip', '-p', file, part]).stdout.toString()
const holds = (file: string, value: string): boolean => ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/sharedStrings.xml'].some((p) => unzip(file, p).replace(/<[^>]+>/g, ' ').split(/\s+/).includes(value))

function stop(inst: Inst): void {
  for (const sig of ['SIGTERM', 'SIGKILL'] as const)
    try {
      if (inst.proc?.pid) process.kill(-inst.proc.pid, sig)
    } catch {
      /* gone */
    }
}
let keyId: string | null = null
const cleanup = async (): Promise<void> => {
  cdp?.close()
  if (keyId) await rpc(box, 'remote.keys.revoke', { id: keyId }).then(() => log('the minted key is revoked'), () => log('the key could not be revoked: the instance and its data are deleted below'))
  for (const inst of [mac, box]) if (inst.proc?.pid) process.kill(-inst.proc.pid, 'SIGTERM')
  await sleep(1500)
  for (const inst of [mac, box]) stop(inst)
  tunnelServer.close()
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

launch(mac, true, { PATH: `${bin}:${process.env.PATH ?? ''}` })
launch(box, false, { TEMP_CODE_WORK_PORT: String(boxWork), TEMP_CODE_WORK_PUBLIC_ORIGIN: tunnel })
try {
  cdp = await attach(mac.debug, 180_000)
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  ports.set('mac', (await cdp.eval<number | null>('window.api.getServerPort()')) ?? 0)
  const up = ports.get('mac')! > 0 && (await until('box up', 120_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both instances are up', up)) throw new Error(`no local port; logs ${mac.log} ${box.log}`)
  const boxId = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  log(`box ${boxId}; logs ${mac.log} ${box.log}; pictures ${out}`)
  await rpc(mac, 'work.set', { enabled: true })
  await rpc(box, 'work.set', { enabled: true })
  const ws = await rpc<{ id: string; path: string }>(box, 'workspace.create', { kind: 'work', sector: 'dummy', name: 'Proof full editor' })
  const thread = await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', workspaceId: ws.id, threadType: 'chat', permission: 'auto', title: 'Proof full editor thread' })
  mkdirSync(ws.path, { recursive: true })
  const book = join(ws.path, 'Dummy pivot.xlsx')
  copyFileSync(join(REPO, 'src/main/server/work/sheets/fullEditor/fixtures/pivot-chart.xlsx'), book)
  const item = await rpc<{ id: string }>(box, 'work.canvas.open', { sessionId: thread.id, kind: 'sheet', source: { at: 'file', host: boxId, path: book }, title: 'Dummy pivot.xlsx' })

  const key = await rpc<{ token: string; id?: string; key?: { id: string } }>(box, 'remote.keys.create', { name: 'full editor remote (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  keyId = key.id ?? key.key?.id ?? null
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  await cdp.eval('window.__monocode.loadSavedEnvironments()')
  const linked = await until('window reaches box', 90_000, () => ev<boolean>(`window.__monocode.registry.has(${JSON.stringify(boxId)}) && window.__monocode.registry.statusOf(${JSON.stringify(boxId)}).transport === 'open'`))
  if (!check("mac's window reaches box by the minted admin key", linked)) throw new Error('no link')
  const fromWindow = <T>(method: string, params: unknown): Promise<T> => ev<T>(`window.__monocode.registry.linkOf(${JSON.stringify(boxId)}).request(${JSON.stringify(method)}, ${JSON.stringify(params)})`)
  const view = await fromWindow<{ reach?: { to: string; carried?: boolean; parts: string[] } }>('work.sheets.open', { itemId: item.id })
  check('box offers the full editor to another computer', view.reach?.to === 'full' && view.reach.carried === true, JSON.stringify(view.reach))

  // 1. The thread in mac's window, and the switch pressed by a real click.
  await until('the thread is listed', 60_000, () => ev<boolean>(`window.__monocode.sessionStore.getSnapshot().some((s) => s.id === ${JSON.stringify(thread.id)})`))
  await ev(`window.__monocode.open(${JSON.stringify(thread.id)})`)
  const trigger = (): Promise<{ x: number; y: number } | null> =>
    ev(`(() => { const el = [...document.querySelectorAll('[role="tab"]')].find((e) => e.textContent.trim() === 'Full editor' && e.getClientRects().length); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const offered = await until('the switch', 90_000, async () => !!(await trigger()))
  check("mac's window draws the switch, TempCode | Full editor", offered)
  await sleep(1500)
  await shot('1-the-switch-in-macs-window')
  if (!offered) throw new Error('no switch')
  const at = (await trigger())!
  await click(at.x, at.y)

  // 2. The carried page's address, as mac's app hands it to the system browser.
  const got = await until('the page is opened', 180_000, () => existsSync(opened) && readFileSync(opened, 'utf8').trim().length > 0)
  const url = got ? readFileSync(opened, 'utf8').trim().split('\n')[0]! : ''
  check('the press opens the page on a loopback origin of mac\'s own', /^http:\/\/127\.0\.0\.1:\d+\/w\/full\/[0-9a-f]{64}\/$/.test(url) && !url.startsWith(tunnel), url.replace(/[0-9a-f]{64}/, '<token>'))
  if (!url) throw new Error('no page')
  const token = /\/w\/full\/([0-9a-f]{64})\//.exec(url)![1]!
  // 3. The same token straight through the tunnel, as a browser on the remote UI's origin would ask it.
  const straight = await fetch(`${tunnel}/w/full/${token}/`)
  check('the page itself is refused through the tunnel without the carrier', straight.status === 404, String(straight.status))
  const api = await fetch(`${tunnel}/w/full/${token}/web-apps/apps/api/documents/api.js`)
  check("and so is ONLYOFFICE's code", api.status === 404, String(api.status))

  // 4. The full editor in a browser, an edit, and the save back.
  const pw = (await import(/* @vite-ignore */ process.env.FULL_EDITOR_PLAYWRIGHT ?? 'playwright-core')) as {
    chromium: { launch(o: { executablePath: string }): Promise<{ newPage(o: object): Promise<Page>; close(): Promise<void> }> }
  }
  type Page = {
    goto(u: string): Promise<unknown>
    on(e: string, f: (x: { message?: string; url(): string; status(): number; failure?(): { errorText: string } | null }) => void): void
    frameLocator(s: string): { locator(s: string): { waitFor(o: object): Promise<void>; click(o?: object): Promise<void>; fill(v: string): Promise<void>; press(k: string): Promise<void> } }
    keyboard: { type(t: string): Promise<void>; press(k: string): Promise<void> }
    waitForTimeout(ms: number): Promise<void>
    screenshot(o: { path: string }): Promise<unknown>
    close(): Promise<void>
  }
  const browser = await pw.chromium.launch({ executablePath: CHROME })
  const value = String(4000 + (Date.now() % 900))
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    const errors: string[] = []
    const foreign: string[] = []
    page.on('pageerror', (e) => errors.push(e.message ?? ''))
    page.on('response', (r) => {
      if (!r.url().startsWith(new URL(url).origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url().replace(/[0-9a-f]{64}/, '<token>'))
      if (r.status() >= 400) log(`HTTP ${r.status()} ${r.url().replace(/[0-9a-f]{64}/, '<token>')}`)
    })
    await page.goto(url)
    const box = page.frameLocator('iframe[name="frameEditor"]').locator('#ce-cell-name')
    const ready = await box.waitFor({ timeout: 180_000 }).then(() => true, () => false)
    check('the full editor loads through the carrier, its frames and its socket on that origin', ready)
    await page.waitForTimeout(3000)
    await page.screenshot({ path: join(out, '2-full-editor-carried.png') })
    if (ready) {
      await box.click({ timeout: 30_000 })
      await box.fill('Data!F2')
      await box.press('Enter')
      await page.waitForTimeout(500)
      await page.keyboard.type(value)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(3000)
      await page.screenshot({ path: join(out, '3-value-typed.png') })
    }
    check('nothing the page loaded came from another origin', foreign.length === 0, foreign.slice(0, 3).join(', '))
    check('the page threw nothing', errors.length === 0, errors.slice(0, 2).join(' | '))
    await page.close()
  } finally {
    await browser.close()
  }
  // When everyone has left, the docservice saves through its callback into box's file.
  check("box's workbook holds the value typed in the full editor", await until('the save lands', 120_000, () => holds(book, value)), value)
  await sleep(2000)
  await shot('4-macs-window-after-the-save')
} catch (err) {
  check('the run', false, (err as Error).message)
} finally {
  await cleanup()
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
