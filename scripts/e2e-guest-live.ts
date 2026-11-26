/**
 * The one live proof of a guest editing a document by an Edit link (plan F-live-guest, milestone 1, "Proof (one)";
 * docs/agents/work-guests.md). One isolated TempCode instance of the BUILT tree (its window under xvfb, CDP on a debug
 * port of its own) and one clean headless Chromium as the guest, on the box.
 *
 *   01 set-up       Work on, a Work workspace, a .tcdoc "Field trip plan" made as Files' New → Document makes it
 *                   (`work.files.make`), a few sentences typed in the window's editor, open in a thread's canvas; an
 *                   Edit link for "Dana Lee" made by `work.guests.create` as his window calls it
 *   02 both-type    the guest's words in the window and his on the guest's page within 2 s; each side's caret named
 *   03 faces        the guest's face in the window's canvas bar, his in the guest's line
 *   04 owner-closed the guest types with his document closed; he reopens it and the words are there; History has a
 *                   `guest-end` version under the guest's name (cut when the guest's socket closes: the tab is closed
 *                   with CDP `Page.close` and the link opened again in a new tab)
 *   05 reload       everything typed is back after a reload, and the editor has focus
 *   06 offline      the guest's line cut for 20 s at a TCP proxy (Chromium's offline mode leaves an open socket up):
 *                   the offline line within 3 s, gone once healed, and the words in his editor
 *   07 host-restart the whole instance stopped and started again with the page open: the page never ends, says it is
 *                   offline, comes back by itself, and the words typed in the gap reach the host; the seconds from the
 *                   Work service answering again to the page being live are printed
 *   08 revoke       `work.guests.revoke`: the page ends within 2 s and no `tempcode-guest:` database is left
 *
 * The guest reaches the Work service only through the proxy, so the instance starts with
 * TEMP_CODE_WORK_PUBLIC_ORIGIN naming the proxy: the link it makes is the proxy's address.
 *
 * Run (after `bunx electron-vite build`, which also builds out/hosted), on the box through the queue:
 *   /srv/agents/work/temp-code/.temp-code/bin/heavy --low env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-guest-live.ts
 *
 *   TC_PROOF_OUT=<dir>   pictures (NN-step-side.png), report.md, the instance's log on a failure
 *                        (default: the main checkout's .temp-code/plans/landed/F-live-guest/M1)
 *   TC_PROOF_DIR=<dir>   scratch (default /tmp/tc-guest-live), removed at the end
 *   TC_PROOF_KEEP=1      keep the scratch
 *
 * Later milestones slot in as named steps over the same set-up. `--restart` (milestone 2, into F-live-guest/M2): two
 * guests by two Edit links and his window in the one document; the whole instance restarted three times while
 * Dana Lee types a known string, one character about every 150 ms, right through each; at the end every character in
 * order at the host, in his editor and on both pages, and in the .tcdoc on disk (its preview.md) once every page and
 * his canvas are closed; how long each screen was away at each restart. `--sheet` is not built yet.
 *
 * Nothing here touches /Applications, a real HOME, the owner's data or the box's live host (127.0.0.1:7695 is never
 * named). Every process it starts is ended by pid or process group, the instance's last ones by its userData marker.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { findChromium } from '../src/main/server/work/browser/box/chromium'
import { Page } from '../src/main/server/work/guests/proofPage'
import { attach, freePort, proofRpc, skipSetupOffer, type Cdp } from './e2e-work-lib'
import { proofCleanup } from './lib/proofCleanup'
import { createProcScan, hasEnv } from './lib/procScan'

// ── flags: which run ─────────────────────────────────────────────────────
const FLAGS = process.argv.slice(2)
/** `--restart`: milestone 2's run (two guests, three restarts while one types), into F-live-guest/M2. */
const RESTART = FLAGS.includes('--restart')
/** `--sheet`: milestone 3's run (a .tcsheet, his desktop grid and a guest's), into F-live-guest/M3. */
const SHEET = FLAGS.includes('--sheet')
if (RESTART && SHEET) {
  console.error('e2e-guest-live: --restart and --sheet are separate runs')
  process.exit(2)
}

const REPO = resolve(import.meta.dir, '..')
const mainCheckout = (): string => {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()
  return common ? dirname(common) : REPO
}
const OUT = process.env.TC_PROOF_OUT ?? join(mainCheckout(), '.temp-code/plans/landed/F-live-guest', RESTART ? 'M2' : SHEET ? 'M3' : 'M1')
const SCRATCH = process.env.TC_PROOF_DIR ?? '/tmp/tc-guest-live'
const KEEP = process.env.TC_PROOF_KEEP === '1'
const OWNER = 'Landon Hale'
const GUEST = 'Dana Lee'
const GUEST2 = 'Riley Fox'
const TITLE = SHEET ? 'Field trip budget' : 'Field trip plan'
const OFFLINE_WORDS = 'Offline. Your edits are kept on this device until the connection is back.'
const ENDED_WORDS = 'This link no longer opens anything'
const SEED = ['The bus leaves the school at 8:15 and is back by 3:30.', 'Every student brings a packed lunch and a water bottle.', 'Two parents ride along on each bus.']
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

for (const need of ['out/main/index.js', 'out/hosted/guest/index.html'])
  if (!existsSync(join(REPO, need))) {
    console.error(`e2e-guest-live: ${need} is missing: run bunx electron-vite build first`)
    process.exit(2)
  }
const CHROME = findChromium()
if (!CHROME) {
  console.error("e2e-guest-live: no Chromium (the box's Playwright one: bunx playwright install chromium)")
  process.exit(2)
}

// ── the record: PASS/FAIL lines, times, pictures ─────────────────────────
mkdirSync(OUT, { recursive: true })
mkdirSync(SCRATCH, { recursive: true })
const root = realpathSync(mkdtempSync(join(SCRATCH, 'run-')))
const lines: string[] = []
const times: [string, string][] = []
let failures = 0
let step = '00'
const check = (label: string, ok: boolean, detail = ''): boolean => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${step} ${label}${detail ? ` (${detail.slice(0, 400)})` : ''}`
  lines.push(line)
  console.log(line)
  if (!ok) failures++
  return ok
}
const note = (text: string): void => {
  lines.push(`NOTE ${step} ${text}`)
  console.log(`      ${text}`)
}
const timed = (what: string, value: string): void => {
  times.push([what, value])
  console.log(`      ${what}: ${value}`)
}
const until = async (ms: number, test: () => Promise<boolean> | boolean, every = 100): Promise<boolean> => {
  const end = Date.now() + ms
  for (;;) {
    if (await Promise.resolve().then(test).catch(() => false)) return true
    if (Date.now() > end) return false
    await sleep(every)
  }
}
/** Waits for `test`, then reports how long it took and whether that was within `budget`. */
const within = async (label: string, budget: number, test: () => Promise<boolean> | boolean, wait = Math.max(budget * 5, 10_000)): Promise<boolean> => {
  const at = Date.now()
  const seen = await until(wait, test, 50)
  const ms = Date.now() - at
  timed(label, seen ? `${ms} ms` : `not seen in ${wait} ms`)
  return check(`${label} within ${budget / 1000} s`, seen && ms <= budget, seen ? `${ms} ms` : 'never')
}

// ── the instance ─────────────────────────────────────────────────────────
const data = join(root, 'data')
const home = join(root, 'home')
const workRoot = join(root, 'work-root')
const noVm = join(root, 'no-vm')
const appLog = join(root, 'instance.log')
for (const d of [data, home, workRoot, noVm, join(root, 'tmp'), join(home, '.claude')]) mkdirSync(d, { recursive: true })
const SEED_KEY = randomBytes(32).toString('hex')
const guard = proofCleanup(root)
const scan = createProcScan()
const ours = () => scan.processes().filter((row) => row.pid !== process.pid && hasEnv(row, `TEMP_CODE_USER_DATA=${data}`))

/** Holds the instance's ports across a restart: the guest's link names the proxy, and the proxy names the Work port. */
const ports = { debug: 0, work: 0 }
let proc: ChildProcess | null = null
let win: Cdp | null = null
let serverPort = 0
let host = ''

/** The Work service answers `/w/healthz` on the guest's line. */
const healthy = (origin: string): Promise<boolean> => fetch(`${origin}/w/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)

interface Started {
  /** the process spawned */
  at: number
  /** its window connected */
  connected: number
  /** when its Work service first answered `/w/healthz` (null: not within five minutes) */
  health: Promise<number | null>
}

/** Prints how long a start took to its window and to its Work service, once the service has answered. */
async function startTimes(label: string, s: Started, workOn?: number): Promise<number | null> {
  const health = await s.health
  timed(`${label}: process start to window connected`, `${((s.connected - s.at) / 1000).toFixed(1)} s`)
  timed(
    `${label}: process start to /w/healthz answering`,
    health === null ? 'never (5 min)' : `${((health - s.at) / 1000).toFixed(1)} s${workOn ? ` (Work turned on at ${((workOn - s.at) / 1000).toFixed(1)} s, so ${((health - workOn) / 1000).toFixed(1)} s after)` : ''}`
  )
  return health
}

async function startInstance(origin: string): Promise<Started> {
  const at = Date.now()
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !/^(TEMP_CODE_|CLAUDE|ANTHROPIC_)/.test(k) && k !== 'ELECTRON_RUN_AS_NODE')),
    HOME: home,
    TMPDIR: join(root, 'tmp'),
    WINVM_DIR: noVm,
    TEMP_CODE_USER_DATA: data,
    TEMP_CODE_HEADLESS: '0',
    TEMP_CODE_DEBUG_PORT: String(ports.debug),
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_WORK_PORT: String(ports.work),
    TEMP_CODE_WORK_PUBLIC_ORIGIN: origin,
    TEMP_CODE_WORK_ROOT: workRoot,
    TEMP_CODE_ALIAX_DATA_DIR: join(data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_APP_TOKEN_SEED: SEED_KEY,
    TEMP_CODE_WORK_TOKEN_SEED: SEED_KEY,
    // No model runs.
    TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  proc = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  guard.track(proc, true)
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(appLog, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(appLog, c))
  const health = until(300_000, () => healthy(origin), 100).then((ok) => (ok ? Date.now() : null))
  const connected = `window.__docket?.registry?.statusOf?.(window.__docket.registry.primaryEnvironmentId)?.transport === 'open'`
  const up = await until(180_000, async () => {
    win ??= await attach(ports.debug, 15_000)
    try {
      return await win.eval<boolean>(connected, 8000)
    } catch (error) {
      win.close()
      win = null
      throw error
    }
  }, 500)
  if (!up) throw new Error(`the instance never connected; its log: ${appLog}`)
  const connectedAt = Date.now()
  serverPort = (await win!.eval<number | null>('window.api.getServerPort()')) ?? 0
  if (!serverPort) throw new Error('the instance has no local server port')
  await win!.send('Page.enable')
  await win!.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await win!.eval(skipSetupOffer).catch(() => {})
  return { at, connected: connectedAt, health }
}

/** The whole instance down, as a deploy takes it: its process group, then anything left that carries its userData. */
async function stopInstance(): Promise<boolean> {
  win?.close()
  win = null
  const pid = proc?.pid
  const group = (sig: NodeJS.Signals): void => {
    try {
      if (pid) process.kill(-pid, sig)
    } catch {
      /* gone */
    }
  }
  group('SIGTERM')
  await until(10_000, () => ours().length === 0, 250)
  group('SIGKILL')
  for (const row of ours()) {
    try {
      process.kill(row.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  proc = null
  const gone = await until(10_000, () => ours().length === 0, 250)
  // The Work port is free again before anything starts on it.
  const closed = await until(10_000, () => new Promise<boolean>((ok) => {
    const s = connect(ports.work, '127.0.0.1')
    s.once('connect', () => (s.destroy(), ok(false)))
    s.once('error', () => ok(true))
  }), 250)
  return gone && closed
}

const call = <T>(method: string, params: unknown = {}, ms = 120_000): Promise<T> => proofRpc<T>(serverPort, method, params, ms)
const page = <T>(expression: string): Promise<T> => win!.eval<T>(expression)
const winShot = async (name: string): Promise<void> => {
  try {
    const { data: png } = (await win!.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(png, 'base64'))
  } catch (error) {
    note(`no picture ${name}: ${String(error)}`)
  }
}
let toolCalls = 0
/** A Work tool as a thread's bridge calls it (the run's own token seeds). */
const tool = async (sessionId: string, name: string, args: Record<string, unknown>): Promise<string> => {
  const token = createHmac('sha256', Buffer.from(SEED_KEY, 'hex')).update(sessionId).digest('base64url')
  const appToken = createHmac('sha256', Buffer.from(SEED_KEY, 'hex')).update(`app-bridge:${sessionId}`).digest('base64url')
  const r = await call<{ content?: { text?: string }[]; isError?: boolean }>('app.workCall', { sessionId, token, appToken, call: ++toolCalls, tool: name, args }, 60_000)
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n')
  if (r.isError) throw new Error(text)
  return text
}

// ── the window's editor ──────────────────────────────────────────────────
const WIN_EDITOR = `(document.querySelector('[data-doc-scroller] .ProseMirror') || document.querySelector('.bn-editor.ProseMirror, .bn-editor .ProseMirror'))`
/** An editor's words without the carets' name labels, which sit inside the text. */
const wordsJs = (editor: string) => `(() => { const ed = ${editor}; if (!ed) return ''; const c = ed.cloneNode(true); c.querySelectorAll('.bn-collaboration-cursor__base').forEach((e) => e.remove()); return c.textContent })()`
const winText = (): Promise<string> => page<string>(wordsJs(WIN_EDITOR))
/** The caret at the end of the paragraph holding `words` (the last paragraph when none does), focused. */
const caretJs = (editor: string, words: string | null) =>
  `(() => { const ed = ${editor}; if (!ed) return false; const ps = [...ed.querySelectorAll('p')]; const p = (${JSON.stringify(words)} === null ? null : ps.find((x) => x.innerText.includes(${JSON.stringify(words)}))) ?? ps.at(-1) ?? ed; const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); ed.focus(); return true })()`
const winType = async (text: string): Promise<void> => void (await win!.send('Input.insertText', { text }))
const winEnter = async (): Promise<void> => {
  for (const type of ['keyDown', 'keyUp']) await win!.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) })
}
const winCarets = (): Promise<string[]> => page<string[]>(`[...document.querySelectorAll('.bn-collaboration-cursor__label')].map((e) => e.textContent.trim())`)

// ── the guest's tab ──────────────────────────────────────────────────────
const EDITOR = `document.querySelector('.ProseMirror')`
const guestText = (p: Page): Promise<string> => p.eval<string>(wordsJs(EDITOR))
const bodyText = (p: Page): Promise<string> => p.eval<string>('document.body.innerText').catch(() => '')
const status = (p: Page): Promise<string | null> => p.eval<string | null>(`document.querySelector('[data-guest-status]')?.innerText?.trim() ?? null`).catch(() => null)
const ended = async (p: Page): Promise<boolean> => (await bodyText(p)).includes(ENDED_WORDS)
const guestShot = async (p: Page, name: string): Promise<void> => {
  try {
    await p.shot(name)
  } catch (error) {
    note(`no picture ${name}: ${String(error)}`)
  }
}
/** A tab really closed (CDP `Page.close`), so its document socket ends: proofPage's own close drops only the CDP socket. */
const closeTab = async (p: Page | null): Promise<void> => {
  if (!p) return
  void p.send('Page.close').catch(() => {})
  await sleep(300)
  p.close()
}

// ── the guest's line: a TCP proxy that can be cut ────────────────────────
interface Line {
  port: number
  cut(): void
  heal(): void
  close(): Promise<void>
}
function line(target: () => number): Promise<Line> {
  let down = false
  const live = new Set<Socket>()
  const server: Server = createServer((client) => {
    if (down) return void client.destroy()
    const upstream = connect(target(), '127.0.0.1')
    live.add(client).add(upstream)
    const end = (): void => {
      client.destroy()
      upstream.destroy()
      live.delete(client)
      live.delete(upstream)
    }
    client.pipe(upstream)
    upstream.pipe(client)
    for (const s of [client, upstream]) s.on('error', end).on('close', end)
  })
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () =>
      ok({
        port: (server.address() as { port: number }).port,
        cut: () => {
          down = true
          for (const s of live) s.destroy()
          live.clear()
        },
        heal: () => void (down = false),
        close: () => new Promise<void>((done) => {
          for (const s of live) s.destroy()
          server.close(() => done())
        })
      })
    )
  })
}

// ── the guest's browser ──────────────────────────────────────────────────
let chrome: ChildProcess | null = null
let chromeExit: Promise<void> | null = null
async function startChrome(): Promise<number> {
  const profile = join(root, 'chrome')
  mkdirSync(profile, { recursive: true })
  chrome = spawn(CHROME!, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { env: { ...process.env, HOME: join(root, 'chrome-home') }, stdio: ['ignore', 'ignore', 'pipe'] })
  guard.track(chrome)
  chromeExit = new Promise((done) => chrome!.once('exit', () => done()))
  return new Promise<number>((ok, fail) => {
    let err = ''
    const timer = setTimeout(() => fail(new Error(`Chromium gave no debug port: ${err.slice(-400)}`)), 30_000)
    chrome!.stderr!.on('data', (c: Buffer) => {
      err += c.toString()
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)
      if (m) {
        clearTimeout(timer)
        ok(Number(m[1]))
      }
    })
    void chromeExit!.then(() => fail(new Error(`Chromium exited: ${err.slice(-400)}`)))
  })
}
async function stopChrome(): Promise<void> {
  if (!chrome || chrome.exitCode !== null || chrome.signalCode) return
  chrome.kill('SIGTERM')
  if (!(await Promise.race([chromeExit!.then(() => true), sleep(5000).then(() => false)]))) {
    chrome.kill('SIGKILL')
    await chromeExit
  }
}

// ── the shared set-up every step reads ───────────────────────────────────
interface Rig {
  line: Line
  origin: string
  debug: number
  workspaceId: string
  sessionId: string
  itemId: string
  source: { at: 'file'; host: string; path: string }
  linkId: string
  url: string
  guest: Page | null
  /** `--restart`: the second guest's link and tab */
  url2: string
  guest2: Page | null
}
const rig = {} as Rig
let serial = 0
const mark = (what: string): string => `${what}-${++serial}${randomBytes(2).toString('hex')}`
const openGuest = async (url = rig.url): Promise<Page> => {
  const p = await Page.open(rig.debug)
  await p.go(url)
  if (SHEET) await p.until('the guest grid', `!!document.querySelector('canvas') && ${FIND_GRID}`, 60_000)
  else await p.until('the guest editor', `!!${EDITOR} && ${EDITOR}.isContentEditable && ${EDITOR}.innerText.length > 0`, 60_000)
  return p
}
const guestType = async (text: string, after: string | null = null): Promise<void> => {
  await rig.guest!.eval(caretJs(EDITOR, after))
  await rig.guest!.type(text)
}
const showThread = async (): Promise<boolean> => {
  await page(`window.__docket.open(${JSON.stringify(rig.sessionId)})`)
  return until(60_000, () => page<boolean>(SHEET ? `!!document.querySelector('canvas') && ${FIND_GRID}` : `!!${WIN_EDITOR} && ${WIN_EDITOR}.isContentEditable`), 250)
}
/** What the host's document holds, read through the host's own document read (`doc_read`, as a thread reads it). */
const hostText = (): Promise<string> => tool(rig.sessionId, 'doc_read', { item: rig.itemId })

interface Step {
  n: string
  id: string
  title: string
  run(): Promise<void>
  /** a step whose failure leaves nothing for the next to stand on */
  fatal?: boolean
}

const STEPS: Step[] = [
  {
    n: '01',
    id: 'setup',
    title: 'set-up',
    fatal: true,
    async run() {
      ports.debug = await freePort()
      ports.work = await freePort()
      rig.line = await line(() => ports.work)
      rig.origin = `http://127.0.0.1:${rig.line.port}`
      const first = await startInstance(rig.origin)
      check('the instance is up, its window connected', true)
      host = (await call<{ environmentId: string }>('remote.status')).environmentId
      // His name, as the host learns it from LifeOS (lifeos/ctx.ts `learnOwnerName`; Settings → Work): this run has no
      // LifeOS, so it is written into the instance's own settings, before Work is turned on, since the Work service
      // reads it when it is forked.
      const db = new Database(join(data, 'temp-code.db'))
      try {
        db.exec('PRAGMA busy_timeout = 10000')
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('work.ownerName', OWNER)
      } finally {
        db.close()
      }
      const workOn = Date.now()
      await call('work.set', { enabled: true })
      const answered = await startTimes('first start', first, workOn)
      check('the Work service answers through the guest line (/w/healthz)', answered !== null)
      const ws = await call<{ id: string; path: string }>('workspace.create', { kind: 'work', sector: 'dummy', name: 'E2E guest live' })
      rig.workspaceId = ws.id
      check('a Work workspace with a folder', !!ws.id && existsSync(ws.path), ws.path)
      const made = await call<{ entries: { ref: { at: string; host?: string; path?: string } | null; name: string }[]; refused: { text: string }[] }>('work.files.make', {
        workspaceId: ws.id,
        at: { at: 'file', host, path: ws.path },
        kind: SHEET ? 'sheet' : 'document',
        name: TITLE,
        op: `e2e-guest-live-make-${randomBytes(4).toString('hex')}`
      })
      const path = made.entries[0]?.ref?.path ?? ''
      const ext = SHEET ? '.tcsheet' : '.tcdoc'
      if (!check(`"${TITLE}" made as a ${ext} in the workspace's folder (work.files.make)`, path.endsWith(ext) && existsSync(path), made.refused.map((r) => r.text).join('; ') || path)) throw new Error('no item to share')
      rig.source = { at: 'file', host, path }
      const thread = await call<{ id: string; scope?: string }>('session.create', { provider: 'claude', workspaceId: ws.id, threadType: 'chat', permission: 'auto', title: TITLE })
      rig.sessionId = thread.id
      check('a Work thread to hold it', thread.scope === 'work', thread.scope)
      const kind = SHEET ? 'sheet' : 'document'
      const item = await call<{ id: string; kind: string }>('work.canvas.open', { sessionId: thread.id, kind, source: rig.source, title: TITLE })
      rig.itemId = item.id
      if (!check(`the ${kind} open in the window's canvas`, (await showThread()) && item.kind === kind, item.kind)) throw new Error('nothing open in the window')
      if (SHEET) return sheetSetUp()
      await page(caretJs(WIN_EDITOR, null))
      for (const [i, sentence] of SEED.entries()) {
        if (i > 0) await winEnter()
        await winType(sentence)
      }
      let held = ''
      const typed = await until(15_000, async () => {
        held = await hostText()
        return SEED.every((s) => held.includes(s))
      }, 250)
      check('a few sentences typed in his editor reach the host', typed, held.slice(0, 200))
      const created = await call<{ link: { id: string }; url: string }>('work.guests.create', { source: rig.source, title: TITLE, name: GUEST, role: 'edit', expiresAt: Date.now() + 7 * 24 * 3600_000 })
      rig.linkId = created.link.id
      rig.url = created.url
      check("an Edit link for Dana Lee, at the guest line's address", created.url.startsWith(`${rig.origin}/g/${created.link.id}#`), new URL(created.url).origin)
      rig.debug = await startChrome()
      Page.shots = OUT
      rig.guest = await openGuest()
      const shown = await guestText(rig.guest)
      check("the guest's page opens the document with his sentences", SEED.every((s) => shown.includes(s)), shown.slice(0, 200))
      if (RESTART) {
        const second = await call<{ link: { id: string }; url: string }>('work.guests.create', { source: rig.source, title: TITLE, name: GUEST2, role: 'edit', expiresAt: Date.now() + 7 * 24 * 3600_000 })
        rig.url2 = second.url
        rig.guest2 = await openGuest(second.url)
        check(`a second Edit link, for ${GUEST2}, open in a second tab`, (await guestText(rig.guest2)).includes(SEED[0]!))
      }
      await winShot('01-setup-window')
      await guestShot(rig.guest, '01-setup-guest')
    }
  },
  {
    n: '02',
    id: 'both-type',
    title: 'both type and see each other, with names',
    async run() {
      const g = ` Guest says ${mark('G')}.`
      await guestType(g, SEED[0]!)
      await within("the guest's sentence in his window", 2000, async () => (await winText()).includes(g.trim()))
      const o = ` Owner says ${mark('O')}.`
      await page(caretJs(WIN_EDITOR, SEED[2]!))
      await winType(o)
      await within("his sentence on the guest's page", 2000, async () => (await guestText(rig.guest!)).includes(o.trim()))
      const guestSees = await rig.guest!.eval<string[]>(`[...document.querySelectorAll('.bn-collaboration-cursor__label')].map((e) => e.textContent.trim())`)
      check(`the guest's page shows his caret named "${OWNER}"`, guestSees.includes(OWNER), JSON.stringify(guestSees))
      const ok = await until(5000, async () => (await winCarets()).includes(GUEST))
      check(`his window shows a caret named "${GUEST}"`, ok, JSON.stringify(await winCarets()))
      await winShot('02-both-type-window')
      await guestShot(rig.guest!, '02-both-type-guest')
    }
  },
  {
    n: '03',
    id: 'faces',
    title: 'faces',
    async run() {
      const inBar = await until(5000, () => page<boolean>(`[...document.querySelectorAll('[data-canvas-bar] [data-person]')].some((e) => e.textContent.trim() === 'D' && (e.closest('[role=group]')?.getAttribute('aria-label') ?? '').includes(${JSON.stringify(GUEST)}))`))
      check(`the guest's face ("D", ${GUEST}) in his canvas bar`, inBar, JSON.stringify(await page(`[...document.querySelectorAll('[data-canvas-bar] [data-person]')].map((e) => [e.textContent, e.closest('[role=group]')?.getAttribute('aria-label')])`)))
      const inLine = await until(5000, () => rig.guest!.eval<boolean>(`[...document.querySelectorAll('[data-guest-faces] [data-person]')].some((e) => e.title === ${JSON.stringify(OWNER)})`))
      check(`his face (titled ${OWNER}) in the guest's line`, inLine, JSON.stringify(await rig.guest!.eval(`[...document.querySelectorAll('[data-guest-faces] [data-person]')].map((e) => e.title)`)))
      await winShot('03-faces-window')
      await guestShot(rig.guest!, '03-faces-guest')
    }
  },
  {
    n: '04',
    id: 'owner-closed',
    title: "the guest types with his document closed",
    async run() {
      await call('work.canvas.close', { itemId: rig.itemId })
      check('his document closed in the window', await until(15_000, () => page<boolean>(`!${WIN_EDITOR}`), 250))
      const left = await until(15_000, () => rig.guest!.eval<boolean>(`!document.querySelector('[data-guest-faces] [data-person]')`), 250)
      note(left ? "his face left the guest's line" : "his face is still in the guest's line 15 s after he closed the document")
      const g = ` Written alone ${mark('ALONE')}.`
      await guestType(g, SEED[1]!)
      await sleep(1500)
      await winShot('04-owner-closed-window')
      await guestShot(rig.guest!, '04-owner-closed-guest')
      await call('work.canvas.open', { sessionId: rig.sessionId, itemId: rig.itemId })
      const back = (await showThread()) && (await until(15_000, async () => (await winText()).includes(g.trim()), 250))
      check('he reopens it: the sentence is there', back, (await winText()).slice(-200))
      // The guest-end version is cut when the guest's socket closes: the tab closed for real, then the link opened again.
      await closeTab(rig.guest)
      rig.guest = null
      await sleep(2000)
      rig.guest = await openGuest()
      type Versions = { versions: { id: string; cause: string; by: string[] }[]; names: Record<string, string> }
      let seen: Versions = { versions: [], names: {} }
      const cut = await until(30_000, async () => {
        seen = await call<Versions>('work.history.versions', { source: rig.source })
        return seen.versions.some((v) => v.cause === 'guest-end' && v.by.some((b) => seen.names[b] === GUEST))
      }, 500)
      check(`History lists a version under ${GUEST}'s name (guest-end)`, cut, JSON.stringify(seen.versions.slice(0, 5).map((v) => [v.cause, v.by.map((b) => seen.names[b] ?? b)])))
      await winShot('04-history-window')
      await guestShot(rig.guest, '04-reopened-guest')
    }
  },
  {
    n: '05',
    id: 'reload',
    title: 'a reload',
    async run() {
      const g = ` Just before the reload ${mark('RELOAD')}.`
      await guestType(g, SEED[2]!)
      const before = await guestText(rig.guest!)
      const at = Date.now()
      await rig.guest!.send('Page.reload', { ignoreCache: false })
      await sleep(300)
      await rig.guest!.until('the guest editor after the reload', `!!${EDITOR} && ${EDITOR}.isContentEditable && ${EDITOR}.innerText.includes(${JSON.stringify(g.trim())})`, 30_000).catch(() => {})
      timed('reload to the document back', `${Date.now() - at} ms`)
      const after = await guestText(rig.guest!)
      const marks = before.match(/[A-Z]+-\d+[0-9a-f]{4}/g) ?? []
      check('the document is back with everything typed', marks.length > 0 && marks.every((m) => after.includes(m)) && SEED.every((s) => after.includes(s)), `${marks.filter((m) => !after.includes(m)).join(', ') || 'all'} of ${marks.length} marks`)
      const focused = await until(5000, () => rig.guest!.eval<boolean>(`!!${EDITOR} && !!document.activeElement && ${EDITOR}.contains(document.activeElement)`))
      check('the editor has focus after the reload', focused, await rig.guest!.eval<string>(`document.activeElement?.tagName + '.' + (document.activeElement?.className ?? '')`))
      await winShot('05-reload-window')
      await guestShot(rig.guest!, '05-reload-guest')
    }
  },
  {
    n: '06',
    id: 'offline',
    title: '20 s offline',
    async run() {
      await rig.guest!.eval(caretJs(EDITOR, SEED[0]!))
      rig.line.cut()
      const cutAt = Date.now()
      const g = ` Typed offline ${mark('OFFLINE')}.`
      await rig.guest!.type(g)
      const shown = await within('the offline line after the cut', 3000, async () => (await status(rig.guest!)) === OFFLINE_WORDS)
      if (!shown) note(`the status line said: ${JSON.stringify(await status(rig.guest!))}`)
      await guestShot(rig.guest!, '06-offline-guest')
      await winShot('06-offline-window')
      check('his window did not get the words while the line was cut', !(await winText()).includes(g.trim()))
      await sleep(Math.max(0, 20_000 - (Date.now() - cutAt)))
      rig.line.heal()
      const healAt = Date.now()
      const gone = await until(60_000, async () => (await status(rig.guest!)) === null, 100)
      timed('heal to the status line gone', gone ? `${Date.now() - healAt} ms` : 'never (60 s)')
      check('healed: the status line goes', gone)
      const merged = await until(30_000, async () => (await winText()).includes(g.trim()), 100)
      timed('heal to the words in his editor', merged ? `${Date.now() - healAt} ms` : 'never (30 s)')
      check('healed: the sentence is in his editor', merged)
      await winShot('06-healed-window')
      await guestShot(rig.guest!, '06-healed-guest')
    }
  },
  {
    n: '07',
    id: 'host-restart',
    title: 'the host restarted with the page open',
    async run() {
      let endedSeen = false
      let watching = true
      const watch = (async () => {
        while (watching) {
          if (rig.guest && (await ended(rig.guest))) endedSeen = true
          await sleep(200)
        }
      })()
      try {
        const downAt = Date.now()
        check('the whole instance stopped (its group, then its userData marker)', await stopInstance())
        const g = ` Typed while the host was down ${mark('GAP')}.`
        await guestType(g, SEED[1]!)
        const shown = await until(5000, async () => (await status(rig.guest!)) === OFFLINE_WORDS)
        check('the page shows the offline line while the host is down', shown, JSON.stringify(await status(rig.guest!)))
        await guestShot(rig.guest!, '07-host-down-guest')
        const again = await startInstance(rig.origin)
        const upAt = await startTimes('restart', again)
        if (!check('the Work service answers again (/w/healthz)', upAt !== null)) return
        const cleared = await until(180_000, async () => (await status(rig.guest!)) === null && !(await ended(rig.guest!)), 100)
        const clearedAt = Date.now()
        timed('service answering to the status line gone', cleared ? `${((clearedAt - upAt!) / 1000).toFixed(1)} s` : 'never (180 s)')
        const probe = ` ${mark('LIVE')}`
        let arrived = false
        if (cleared) {
          await guestType(probe, SEED[2]!)
          arrived = await until(120_000, async () => (await hostText()).includes(probe.trim()), 250)
        }
        const liveAt = Date.now()
        timed('the restart gap: service answering to the page live again (line gone, a new word at the host)', arrived ? `${((liveAt - upAt!) / 1000).toFixed(1)} s` : 'never')
        timed('the page away in all: the instance stopped to the page live again', arrived ? `${((liveAt - downAt) / 1000).toFixed(1)} s` : 'never')
        check('the page comes back by itself: the line goes and a new word reaches the host', cleared && arrived)
        check('it is live within about 15 s of the service answering', arrived && liveAt - upAt! <= 15_000, `${((liveAt - upAt!) / 1000).toFixed(1)} s`)
        const read = await hostText().catch((e: Error) => e.message)
        check('the sentence typed in the gap is in the document after the restart', read.includes(g.trim()), read.slice(0, 300))
      } finally {
        watching = false
        await watch
      }
      check(`the page never ended ("${ENDED_WORDS}")`, !endedSeen)
      await showThread()
      await winShot('07-host-restart-window')
      await guestShot(rig.guest!, '07-host-restart-guest')
    }
  },
  {
    n: '08',
    id: 'revoke',
    title: 'revoke ends the page',
    async run() {
      const before = await rig.guest!.eval<string[]>(`indexedDB.databases().then((d) => d.map((x) => x.name))`).catch(() => [])
      note(`databases before the revoke: ${JSON.stringify(before)}`)
      await call('work.guests.revoke', { linkId: rig.linkId })
      await within('the page ends after the revoke', 2000, () => ended(rig.guest!))
      let names: string[] = []
      const wiped = await until(5000, async () => {
        names = await rig.guest!.eval<string[]>(`indexedDB.databases().then((d) => d.map((x) => x.name))`)
        return !names.some((n) => n.startsWith('tempcode-guest:'))
      }, 200)
      check('no tempcode-guest: database is left in the tab', wiped, JSON.stringify(names))
      await winShot('08-revoke-window')
      await guestShot(rig.guest!, '08-revoke-guest')
    }
  }
]

// ── --sheet: milestone 3's run ───────────────────────────────────────────
/** Finds the grid's SheetHandle (the format row's `sheet` prop, on his window and on the guest's page alike) as `window.__h`. */
const FIND_GRID = `(() => { for (const el of document.querySelectorAll('*')) { const k = Object.keys(el).find((k) => k.startsWith('__reactFiber$')); if (!k) continue; let f = el[k]; while (f) { const s = f.memoizedProps && f.memoizedProps.sheet; if (s && s.api) { window.__h = s; return true } f = f.return } } return false })()`
const ACTIVE = `(${FIND_GRID}, window.__h.api.getActiveWorkbook().getActiveSheet())`
const SHEET_OFFLINE = 'Offline. Your edits are kept on this device until the sheet is back.'
const ROWS = 20
const COLS = 12
/** A1 from zero-based row and column (the run stays within A–Z). */
const a1 = (r: number, c: number): string => `${String.fromCharCode(65 + c)}${r + 1}`

/** One grid: his window's or the guest's page, driven alike. */
interface Grid {
  side: 'window' | 'guest'
  eval<T>(js: string): Promise<T>
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
}
const winGrid: Grid = { side: 'window', eval: (js) => page(js), send: (m, p = {}) => win!.send(m, p) }
const guestGrid = (): Grid => ({ side: 'guest', eval: (js) => rig.guest!.eval(js), send: (m, p = {}) => rig.guest!.send(m, p) })
/** What a cell shows (a formula's value). */
const shows = (g: Grid, r: number, c: number): Promise<string> => g.eval<string>(`(() => { const v = ${ACTIVE}.getRange(${r}, ${c}).getDisplayValue(); return v == null ? '' : String(v) })()`)
/** The first ROWS × COLS cells as the grid shows them. */
const area = (g: Grid): Promise<string[][]> =>
  g.eval<string[][]>(`(() => { const s = ${ACTIVE}; const out = []; for (let r = 0; r < ${ROWS}; r++) { const row = []; for (let c = 0; c < ${COLS}; c++) { const v = s.getRange(r, c).getDisplayValue(); row.push(v == null ? '' : String(v)) } out.push(row) } return out })()`)
/** His selection, or the guest's, on one cell (the grid tells its line, as a click does). */
const select = (g: Grid, r: number, c: number): Promise<boolean> =>
  g.eval<boolean>(`(() => { const s = ${ACTIVE}; const x = s.getRange(${r}, ${c}); if (x.activate) x.activate(); else s.setActiveRange(x); return true })()`)
let viaApi = 0
/**
 * Types into a cell as a person does: a click in the grid gives it the keys, the cell is made the active one, the
 * first character starts the cell's editor and Enter ends it. Where the keys did not reach the cell (a rig fault, not
 * the sheet's), the value goes through the grid's own API instead, so the edit still travels the grid's own path; the
 * run says how often.
 */
async function typeCell(g: Grid, r: number, c: number, text: string, fallback = true): Promise<number> {
  const box = await g.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0].getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height } })()`)
  const x = box.x + Math.min(box.w - 20, 46 + 88 * 10 + 40)
  const y = box.y + Math.min(box.h - 20, 20 + 24 * 16 + 10)
  for (const type of ['mousePressed', 'mouseReleased']) await g.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  await sleep(120)
  await select(g, r, c)
  await sleep(250)
  const first = text[0]!
  await g.send('Input.dispatchKeyEvent', { type: 'keyDown', key: first, text: first, windowsVirtualKeyCode: first.toUpperCase().charCodeAt(0) })
  await g.send('Input.dispatchKeyEvent', { type: 'keyUp', key: first, windowsVirtualKeyCode: first.toUpperCase().charCodeAt(0) })
  if (text.length > 1) await g.send('Input.insertText', { text: text.slice(1) })
  await sleep(80)
  const enteredAt = Date.now()
  await g.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await g.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const took = await until(2000, async () => {
    const f = await g.eval<string>(`${ACTIVE}.getRange(${r}, ${c}).getFormula() || ''`)
    return text.startsWith('=') ? f.replace(/\s/g, '').toUpperCase() === text.replace(/\s/g, '').toUpperCase() : (await shows(g, r, c)) === text
  }, 50)
  // Beside a concurrent row change the cell may have moved before it was looked at: no second write there.
  if (took || !fallback) return enteredAt
  viaApi++
  note(`the keys did not reach ${a1(r, c)} on the ${g.side}'s grid; set through the grid's API`)
  const setAt = Date.now()
  await g.eval(`(${ACTIVE}.getRange(${r}, ${c}).setValue(${JSON.stringify(/^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text)}), true)`)
  return setAt
}
/** Seen on the other side within `budget` of the edit's Enter. */
async function seenWithin(label: string, budget: number, from: number, test: () => Promise<boolean>): Promise<boolean> {
  const seen = await until(Math.max(budget * 10, 10_000), test, 25)
  const ms = Date.now() - from
  timed(label, seen ? `${ms} ms` : 'never')
  return check(`${label} within ${budget / 1000} s`, seen && ms <= budget, seen ? `${ms} ms` : 'never')
}
const insertRow = (g: Grid, at: number): Promise<unknown> => g.eval(`(${ACTIVE}.insertRowBefore(${at}), true)`)
const labels = (g: Grid): Promise<string[]> => g.eval<string[]>(`[...document.querySelectorAll('[data-slot=sheet-presence]')].map((e) => e.textContent.trim())`)
const sheetLine = (sel: string): Promise<string | null> => rig.guest!.eval<string | null>(`document.querySelector('${sel}')?.innerText?.trim() ?? null`).catch(() => null)

/** The stored sheet, read through the host's own read (`sheet_read`, as a thread reads it): A1 → what the cell holds (a formula's value). */
async function stored(range = `A1:${a1(ROWS - 1, COLS - 1)}`): Promise<Map<string, string>> {
  const text = await tool(rig.sessionId, 'sheet_read', { item: rig.itemId, range })
  const out = new Map<string, string>()
  for (const part of text.split('\n').flatMap((l) => l.split('  |  '))) {
    const m = /^([A-Z]+\d+) (.*)$/.exec(part.trim())
    if (!m) continue
    let rest = m[2]!.replace(/ note ".*"$/, '')
    if (rest.startsWith('note ')) continue
    if (rest.startsWith('=')) rest = rest.includes(' = ') ? rest.slice(rest.lastIndexOf(' = ') + 3) : '""'
    let v: unknown = rest
    try {
      v = JSON.parse(rest)
    } catch {
      /* as it is */
    }
    out.set(m[1]!, v === null || v === undefined ? '' : String(v))
  }
  return out
}
const storedArea = async (): Promise<string[][]> => {
  const got = await stored()
  return Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => got.get(a1(r, c)) ?? ''))
}
/** The cells where two areas differ, as "A3: x | y". */
const differ = (a: string[][], b: string[][]): string[] => a.flatMap((row, r) => row.flatMap((v, c) => (v === (b[r]?.[c] ?? '') ? [] : [`${a1(r, c)}: ${JSON.stringify(v)} | ${JSON.stringify(b[r]?.[c] ?? '')}`])))
const shotsOf = async (name: string): Promise<void> => {
  await winShot(`${step}-${name}-window`)
  if (rig.guest) await guestShot(rig.guest, `${step}-${name}-guest`)
}

/** The text frames the guest's tab receives on its sockets from now, over a CDP session of its own; `stop` ends it and hands them back. */
async function socketFrames(debug: number): Promise<{ stop(): string[] }> {
  const targets = (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[]
  const tab = targets.find((t) => t.type === 'page' && t.url.includes('/g/') && t.webSocketDebuggerUrl)
  const got: string[] = []
  if (!tab) return { stop: () => got }
  const ws = new WebSocket(tab.webSocketDebuggerUrl!)
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { method?: string; params?: { response?: { payloadData?: string } } }
    if (m.method === 'Network.webSocketFrameReceived' && m.params?.response?.payloadData) got.push(m.params.response.payloadData.slice(0, 400))
  }
  ws.send(JSON.stringify({ id: 1, method: 'Network.enable', params: {} }))
  await sleep(200)
  return {
    stop: () => {
      ws.close()
      return got
    }
  }
}

/** The set-up's end for a sheet: the guest's link and page. */
async function sheetSetUp(): Promise<void> {
  const created = await call<{ link: { id: string }; url: string }>('work.guests.create', { source: rig.source, title: TITLE, name: GUEST, role: 'edit', expiresAt: Date.now() + 7 * 24 * 3600_000 })
  rig.linkId = created.link.id
  rig.url = created.url
  check(`an Edit link for ${GUEST}, at the guest line's address`, created.url.startsWith(`${rig.origin}/g/${created.link.id}#`), new URL(created.url).origin)
  rig.debug = await startChrome()
  Page.shots = OUT
  rig.guest = await openGuest()
  check("the guest's page opens the sheet's grid, editable", await rig.guest.eval<boolean>(`!!document.querySelector('[data-slot=sheet-toolbar], [role=toolbar]') || ${FIND_GRID}`))
  await shotsOf('setup')
}

const SHEET_STEPS: Step[] = [
  {
    n: '01',
    id: 'both-type',
    title: "both type and see each other's cells, with names on the selections",
    async run() {
      const g = guestGrid()
      const sent = await typeCell(g, 1, 1, 'guest-hello')
      await seenWithin("the guest's cell B2 in his grid", 1000, sent, async () => (await shows(winGrid, 1, 1)) === 'guest-hello')
      const his = await typeCell(winGrid, 1, 2, 'owner-hello')
      await seenWithin("his cell C2 on the guest's grid", 1000, his, async () => (await shows(g, 1, 2)) === 'owner-hello')
      await select(g, 4, 1)
      await select(winGrid, 4, 3)
      const named = await until(5000, async () => (await labels(winGrid)).includes(GUEST))
      check(`his grid draws the guest's selection named "${GUEST}"`, named, JSON.stringify(await labels(winGrid)))
      const hisNamed = await until(5000, async () => (await labels(g)).includes(OWNER))
      check(`the guest's grid draws his selection named "${OWNER}"`, hisNamed, JSON.stringify(await labels(g)))
      const inBar = await until(5000, () => page<boolean>(`[...document.querySelectorAll('[data-canvas-bar] [data-person]')].some((e) => e.textContent.trim() === 'D' && (e.closest('[role=group]')?.getAttribute('aria-label') ?? '').includes(${JSON.stringify(GUEST)}))`))
      check(`the guest's face ("D", ${GUEST}) in his canvas bar`, inBar)
      const inLine = await until(5000, () => rig.guest!.eval<boolean>(`[...document.querySelectorAll('[data-guest-faces] [data-person]')].some((e) => e.title === ${JSON.stringify(OWNER)})`))
      check(`his face (titled ${OWNER}) in the guest's line`, inLine)
      await shotsOf('both-type')
    }
  },
  {
    n: '02',
    id: 'insert-while-typing',
    title: 'a row inserted while the other types below it, both orders',
    async run() {
      const g = guestGrid()
      // He inserts a row above while the guest types below it.
      await Promise.all([typeCell(g, 9, 0, 'below-a', false), sleep(200).then(() => insertRow(winGrid, 1))])
      await sleep(3000)
      // The guest inserts a row above while he types below it.
      await Promise.all([typeCell(winGrid, 12, 0, 'below-b', false), sleep(200).then(() => insertRow(g, 1))])
      let last = { guest: [] as string[][], window: [] as string[][], kept: [] as string[][] }
      const same = await until(20_000, async () => {
        last = { guest: await area(g), window: await area(winGrid), kept: await storedArea() }
        return differ(last.guest, last.window).length === 0 && differ(last.window, last.kept).length === 0
      }, 500)
      const where = (word: string, a: string[][]): string[] => a.flatMap((row, r) => row.flatMap((v, c) => (v === word ? [a1(r, c)] : [])))
      check(
        'the two grids and the stored sheet are equal cell for cell',
        same,
        same ? `below-a at ${where('below-a', last.kept).join(',')}, below-b at ${where('below-b', last.kept).join(',')}` : `guest|window: ${differ(last.guest, last.window).slice(0, 6).join('; ')}; window|stored: ${differ(last.window, last.kept).slice(0, 6).join('; ')}`
      )
      check('each typed word is there once', ['below-a', 'below-b'].every((w) => where(w, last.kept).length === 1), JSON.stringify({ a: where('below-a', last.kept), b: where('below-b', last.kept) }))
      await shotsOf('insert')
    }
  },
  {
    n: '03',
    id: 'formula',
    title: 'a formula on one side follows an input changed on the other',
    async run() {
      const g = guestGrid()
      for (const [r, v] of [[1, '1'], [2, '2'], [3, '3']] as const) await typeCell(winGrid, r, 7, v)
      await until(5000, async () => (await shows(g, 3, 7)) === '3')
      await typeCell(g, 5, 7, '=SUM(H2:H4)')
      const six = await until(5000, async () => (await shows(g, 5, 7)) === '6' && (await shows(winGrid, 5, 7)) === '6')
      check("the guest's =SUM(H2:H4) reads 6 on both grids", six, `${await shows(g, 5, 7)} | ${await shows(winGrid, 5, 7)}`)
      const changed = await typeCell(winGrid, 2, 7, '10')
      await seenWithin("the guest's formula follows his input (14 on the guest's grid)", 1000, changed, async () => (await shows(g, 5, 7)) === '14')
      const kept = await until(10_000, async () => (await stored(`H6:H6`)).get('H6') === '14')
      check('the stored sheet holds 14 in H6', kept, JSON.stringify([...(await stored('H6:H6')).entries()]))
      check('his grid shows 14 in H6', (await shows(winGrid, 5, 7)) === '14')
      await shotsOf('formula')
    }
  },
  {
    n: '04',
    id: 'offline',
    title: '20 s cut: three edits kept and sent',
    async run() {
      const g = guestGrid()
      rig.line.cut()
      const cutAt = Date.now()
      const words = ['off-1', 'off-2', 'off-3']
      try {
        const shown = within('the offline line after the cut', 3000, async () => (await sheetLine('[data-sheet-offline]')) === SHEET_OFFLINE)
        await sleep(400)
        for (const [i, w] of words.entries()) await typeCell(g, 1 + i, 9, w)
        await shown
        check("the guest's grid holds the three edits while cut off", (await Promise.all(words.map((_, i) => shows(g, 1 + i, 9)))).join() === words.join())
        await shotsOf('offline')
        await sleep(Math.max(0, 20_000 - (Date.now() - cutAt)))
      } finally {
        // Whatever happened, the line is healed: the steps after it need it.
        rig.line.heal()
      }
      const healAt = Date.now()
      const gone = await until(60_000, async () => (await sheetLine('[data-sheet-offline]')) === null, 100)
      timed('heal to the offline line gone', gone ? `${Date.now() - healAt} ms` : 'never (60 s)')
      check('healed: the offline line goes', gone)
      const inGrid = await until(30_000, async () => (await Promise.all(words.map((_, i) => shows(winGrid, 1 + i, 9)))).join() === words.join(), 100)
      timed('heal to the three in his grid', inGrid ? `${Date.now() - healAt} ms` : 'never (30 s)')
      check('healed: the three edits are in his grid', inGrid)
      const kept = await until(15_000, async () => {
        const got = await stored('J2:J4')
        return words.every((w, i) => got.get(`J${2 + i}`) === w)
      }, 250)
      check('healed: the three edits are in the stored sheet', kept, JSON.stringify([...(await stored('J2:J4')).entries()]))
      check('no edit was said to be lost', (await sheetLine('[data-sheet-dropped]')) === null, (await sheetLine('[data-sheet-dropped]')) ?? '')
      await shotsOf('healed')
    }
  },
  {
    n: '05',
    id: 'host-restart',
    title: 'the host restarted with the page open',
    async run() {
      const g = guestGrid()
      let endedSeen = false
      let watching = true
      const watch = (async () => {
        while (watching) {
          if (rig.guest && (await ended(rig.guest))) endedSeen = true
          await sleep(200)
        }
      })()
      try {
        const downAt = Date.now()
        check('the whole instance stopped (its group, then its userData marker)', await stopInstance())
        const gap = mark('gap').toLowerCase()
        await typeCell(g, 1, 10, gap)
        const shown = await until(5000, async () => (await sheetLine('[data-sheet-offline]')) === SHEET_OFFLINE)
        check('the page shows the offline line while the host is down', shown, JSON.stringify(await sheetLine('[data-sheet-offline]')))
        await guestShot(rig.guest!, '05-host-down-guest')
        const again = await startInstance(rig.origin)
        const upAt = await startTimes('restart', again)
        if (!check('the Work service answers again (/w/healthz)', upAt !== null)) return
        const cleared = await until(180_000, async () => (await sheetLine('[data-sheet-offline]')) === null && !(await ended(rig.guest!)), 100)
        timed('service answering to the offline line gone', cleared ? `${((Date.now() - upAt!) / 1000).toFixed(1)} s` : 'never (180 s)')
        const probe = mark('live').toLowerCase()
        let arrived = false
        if (cleared) {
          await typeCell(g, 2, 10, probe)
          arrived = await until(120_000, async () => (await stored('K3:K3')).get('K3') === probe, 250)
        }
        const liveAt = Date.now()
        timed('the restart gap: service answering to the page live again (line gone, a new edit stored)', arrived ? `${((liveAt - upAt!) / 1000).toFixed(1)} s` : 'never')
        timed('the page away in all: the instance stopped to the page live again', arrived ? `${((liveAt - downAt) / 1000).toFixed(1)} s` : 'never')
        check('the page comes back by itself: the line goes and a new edit is stored', cleared && arrived)
        check('it is live within about 15 s of the service answering', arrived && liveAt - upAt! <= 15_000, `${((liveAt - upAt!) / 1000).toFixed(1)} s`)
        const kept = await stored('K2:K2')
        check('the edit typed in the gap landed', kept.get('K2') === gap, JSON.stringify([...kept.entries()]))
      } finally {
        watching = false
        await watch
      }
      check(`the page never ended ("${ENDED_WORDS}")`, !endedSeen)
      await showThread()
      await shotsOf('host-restart')
    }
  },
  {
    n: '06',
    id: 'refused',
    title: 'a refused act said in words',
    async run() {
      // A guest may not add a tab: the grid's own command makes the mutation, the page's session sends it, the service refuses it.
      // What the service answers is read off the page's own socket (a second CDP session on the guest's tab).
      const frames = await socketFrames(rig.debug)
      const err = await rig.guest!.eval<string | null>(`(() => { try { ${FIND_GRID}; window.__h.api.getActiveWorkbook().insertSheet('Guest tab'); return null } catch (e) { return String(e).slice(0, 200) } })()`)
      if (err) note(`the grid threw on insertSheet: ${err}`)
      let said: string | null = null
      const refused = await until(10_000, async () => (said = await sheetLine('[data-sheet-refused]')) !== null && said.includes('Edit not saved'), 100)
      check('the page says "Edit not saved"', refused, said ?? 'nothing')
      await sleep(500)
      const answers = frames.stop().filter((f) => f.includes('"refused"'))
      note(`the service answered: ${answers.join(' ') || '(no refused frame seen)'}`)
      check('…and why, in plain words', !!said && said.replace('Edit not saved', '').trim().length > 0 && !/sheet\.mutation|insert sheet/i.test(said), said ?? '')
      const tabs = await until(10_000, async () => (await rig.guest!.eval<number>(`(${FIND_GRID}, window.__h.api.getActiveWorkbook().getSheets().length)`)) === 1, 250)
      check("the guest's grid is back to the sheet's one tab", tabs)
      const kept = await storedArea()
      const off = differ(await area(guestGrid()), kept)
      check('the page goes on: not ended, its grid equal to the stored sheet', !(await ended(rig.guest!)) && off.length === 0, off.slice(0, 4).join('; '))
      await shotsOf('refused')
    }
  },
  {
    n: '07',
    id: 'history',
    title: "History names the guest's edits",
    async run() {
      type Got = { revisions: { rev: number; by: string; label: string }[]; names: Record<string, string> }
      let got: Got = { revisions: [], names: {} }
      const named = await until(15_000, async () => {
        got = await call<Got>('work.sheets.history', { itemId: rig.itemId })
        return got.revisions.some((r) => got.names[r.by] === GUEST)
      }, 500)
      const mine = got.revisions.filter((r) => got.names[r.by] === GUEST)
      check(`History lists the guest's edits under "${GUEST}"`, named, `${mine.length} of ${got.revisions.length} revisions: ${mine.slice(0, 3).map((r) => r.label).join('; ')}`)
      check('…and none under a bare principal', !got.revisions.some((r) => r.by.startsWith('guest:') && !got.names[r.by]), JSON.stringify(got.revisions.filter((r) => r.by.startsWith('guest:')).slice(0, 2)))
      await shotsOf('history')
    }
  },
  {
    n: '08',
    id: 'revoke',
    title: 'revoke ends the page',
    async run() {
      const before = await rig.guest!.eval<string[]>(`indexedDB.databases().then((d) => d.map((x) => x.name))`).catch(() => [])
      note(`databases before the revoke: ${JSON.stringify(before)}`)
      await call('work.guests.revoke', { linkId: rig.linkId })
      await within('the page ends after the revoke', 2000, () => ended(rig.guest!))
      let names: string[] = []
      const wiped = await until(5000, async () => {
        names = await rig.guest!.eval<string[]>(`indexedDB.databases().then((d) => d.map((x) => x.name))`)
        return !names.some((n) => n.startsWith('tempcode-guest:'))
      }, 200)
      check('no tempcode-guest: database is left in the tab', wiped, JSON.stringify(names))
      await shotsOf('revoke')
    }
  }
]

// ── --restart: milestone 2's run ─────────────────────────────────────────
/** What the typing guest types, one character about every 150 ms: 3,120 characters, about eight minutes, long enough to type right through three restarts. */
const KNOWN = 'abcdefghijklmnopqrstuvwxyz'.repeat(120)
const KNOWN_HEAD = 'Known:'
const holds = (text: string, n: number): boolean => text.includes(KNOWN_HEAD + KNOWN.slice(0, n))
/** The .tcdoc's own words on disk (its `preview.md`, written with every store: work-kit collab-server/stores.ts). */
const storedWords = (): string => spawnSync('unzip', ['-p', rig.source.path, 'preview.md'], { encoding: 'utf8' }).stdout ?? ''
/** When `test` first held, or null. */
const whenHeld = async (test: () => Promise<boolean>, ms = 180_000): Promise<number | null> => ((await until(ms, test, 200)) ? Date.now() : null)
const secs = (from: number, to: number | null): string => (to === null ? 'never' : `${((to - from) / 1000).toFixed(1)} s`)

const RESTART_STEP: Step = {
  n: '02',
  id: 'three-restarts',
  title: 'three restarts while one guest types without stopping',
  async run() {
    const a = rig.guest!
    const b = rig.guest2!
    await a.eval(caretJs(EDITOR, SEED[2]!))
    await a.type(` ${KNOWN_HEAD}`)
    let typed = 0
    let typing = true
    let misses = 0
    const typer = (async () => {
      while (typed < KNOWN.length && misses < 400) {
        // The caret is put back at the end of the typer's own paragraph before each character: a page that drew its editor again keeps the order.
        const placed = await a.eval<boolean>(caretJs(EDITOR, KNOWN_HEAD)).catch(() => false)
        if (placed && (await a.type(KNOWN[typed]!).then(() => true, () => false))) {
          typed++
          misses = 0
        } else misses++
        await sleep(150)
      }
      typing = false
    })()
    const endedOn = new Set<string>()
    let watching = true
    const watch = (async () => {
      while (watching) {
        for (const [who, p] of [[GUEST, a], [GUEST2, b]] as const) if (await ended(p)) endedOn.add(who)
        await sleep(200)
      }
    })()
    try {
      await until(120_000, () => typed >= 100, 200)
      for (let r = 1; r <= 3; r++) {
        if (!check(`restart ${r}: ${GUEST} is still typing as it begins`, typing, `${typed} of ${KNOWN.length} typed`)) break
        const downAt = Date.now()
        check(`restart ${r}: the whole instance stopped (its group, then its userData marker)`, await stopInstance())
        const s = await startInstance(rig.origin)
        const upAt = await startTimes(`restart ${r}`, s)
        if (!check(`restart ${r}: the Work service answers again`, upAt !== null)) break
        // A screen is live again once it holds a character typed after the service answered.
        const k = typed + 1
        const [atA, atB, atW] = await Promise.all([
          whenHeld(async () => (await status(a)) === null && holds(await hostText(), k)),
          whenHeld(async () => holds(await guestText(b), k)),
          (async () => ((await showThread()) ? whenHeld(async () => holds(await winText(), k)) : null))()
        ])
        for (const [who, at] of [[`${GUEST}'s page (typing; its words at the host)`, atA], [`${GUEST2}'s page`, atB], ["his window's editor", atW]] as const)
          timed(`restart ${r}: ${who} away`, `${secs(downAt, at)} from the stop, ${secs(upAt!, at)} from the service answering`)
        check(`restart ${r}: all three screens live again`, atA !== null && atB !== null && atW !== null)
        await sleep(10_000)
      }
      await typer
      check(`${GUEST} typed the whole string through the three restarts`, typed === KNOWN.length, `${typed} of ${KNOWN.length}`)
      const whole = async (read: () => Promise<string>): Promise<boolean> => until(120_000, async () => holds(await read(), KNOWN.length), 500)
      check('every character, in order as typed, at the host (doc_read)', await whole(hostText))
      check("…in his window's editor", await whole(winText))
      check(`…on ${GUEST}'s page`, await whole(() => guestText(a)))
      check(`…on ${GUEST2}'s page`, await whole(() => guestText(b)))
    } finally {
      watching = false
      await watch
      typing = false
    }
    check('neither page ended', endedOn.size === 0, [...endedOn].join(', '))
    await winShot('02-restart-window')
    await guestShot(a, '02-restart-guest-dana')
    await guestShot(b, '02-restart-guest-riley')
    // The store: every page and his canvas closed, the file on disk read back once the last store has written it.
    await closeTab(rig.guest)
    rig.guest = null
    await closeTab(rig.guest2)
    rig.guest2 = null
    await call('work.canvas.close', { itemId: rig.itemId })
    const closedAt = Date.now()
    const stored = await until(60_000, () => holds(storedWords(), KNOWN.length), 500)
    timed('every page closed to the whole string in the .tcdoc on disk', stored ? secs(closedAt, Date.now()) : 'never (60 s)')
    check("the store holds it: the .tcdoc's preview.md on disk has every character in order", stored, storedWords().slice(-200))
  }
}

// ── the run ──────────────────────────────────────────────────────────────
const PLAN: Step[] = RESTART ? [STEPS[0]!, RESTART_STEP] : SHEET ? [{ ...STEPS[0]!, n: '00' }, ...SHEET_STEPS] : STEPS
const startedAt = new Date()
try {
  for (const s of PLAN) {
    step = s.n
    console.log(`\n── ${s.n} ${s.title}`)
    try {
      await s.run()
    } catch (error) {
      check(`${s.title}: the step ran to its end`, false, error instanceof Error ? error.message : String(error))
      if (s.fatal) break
    }
  }
} finally {
  step = '99'
  if (SHEET) note(`edits set through the grid's API because the keys did not reach the cell: ${viaApi}`)
  await closeTab(rig.guest)
  await closeTab(rig.guest2)
  await stopChrome().catch((e: unknown) => check('Chromium stopped', false, String(e)))
  check('the instance stopped and left nothing behind', await stopInstance())
  await rig.line?.close()
  if (failures && existsSync(appLog)) copyFileSync(appLog, join(OUT, 'instance.log'))
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length
  const pictures = readdirSync(OUT).filter((f) => /^\d\d-.*\.png$/.test(f)).sort()
  const report = [
    `# Live editing by guest link: the milestone ${RESTART ? '2' : SHEET ? '3' : '1'} proof${RESTART ? ' (--restart)' : SHEET ? ' (--sheet)' : ''}`,
    '',
    `Run ${startedAt.toISOString()} on the box: \`bun scripts/e2e-guest-live.ts${FLAGS.length ? ` ${FLAGS.join(' ')}` : ''}\` in \`${REPO}\`, the built tree of ${commit}${dirty ? ` with ${dirty} files changed beside it` : ''}. One windowed instance under xvfb, one headless Chromium (${CHROME}) as the guest, through a TCP proxy that can be cut.`,
    '',
    `**${failures ? `${failures} FAILED` : 'ALL PASS'}**`,
    '',
    '## Checks',
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    '## Times',
    '',
    '| What | Measured |',
    '|---|---|',
    ...times.map(([what, v]) => `| ${what} | ${v} |`),
    '',
    '## Pictures',
    '',
    ...pictures.map((p) => `- ${p}`),
    ...(failures ? ['', 'The instance\'s log: `instance.log`.'] : []),
    ''
  ].join('\n')
  writeFileSync(join(OUT, 'report.md'), report)
  if (!KEEP) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    try {
      if (readdirSync(SCRATCH).length === 0) rmSync(SCRATCH, { recursive: true, force: true })
    } catch {
      /* someone else's */
    }
  } else console.log(`      scratch kept: ${root}`)
  console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASS'}; report: ${join(OUT, 'report.md')}`)
}
process.exit(failures ? 1 : 0)
