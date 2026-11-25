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
if (FLAGS.includes('--sheet')) {
  console.error("e2e-guest-live: --sheet is a later milestone's run and is not built yet")
  process.exit(2)
}
/** `--restart`: milestone 2's run (two guests, three restarts while one types), into F-live-guest/M2. */
const RESTART = FLAGS.includes('--restart')

const REPO = resolve(import.meta.dir, '..')
const mainCheckout = (): string => {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()
  return common ? dirname(common) : REPO
}
const OUT = process.env.TC_PROOF_OUT ?? join(mainCheckout(), '.temp-code/plans/landed/F-live-guest', RESTART ? 'M2' : 'M1')
const SCRATCH = process.env.TC_PROOF_DIR ?? '/tmp/tc-guest-live'
const KEEP = process.env.TC_PROOF_KEEP === '1'
const OWNER = 'Landon Hale'
const GUEST = 'Dana Lee'
const GUEST2 = 'Riley Fox'
const TITLE = 'Field trip plan'
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
  const connected = `window.__monocode?.registry?.statusOf?.(window.__monocode.registry.primaryEnvironmentId)?.transport === 'open'`
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
  await p.until('the guest editor', `!!${EDITOR} && ${EDITOR}.isContentEditable && ${EDITOR}.innerText.length > 0`, 60_000)
  return p
}
const guestType = async (text: string, after: string | null = null): Promise<void> => {
  await rig.guest!.eval(caretJs(EDITOR, after))
  await rig.guest!.type(text)
}
const showThread = async (): Promise<boolean> => {
  await page(`window.__monocode.open(${JSON.stringify(rig.sessionId)})`)
  return until(60_000, () => page<boolean>(`!!${WIN_EDITOR} && ${WIN_EDITOR}.isContentEditable`), 250)
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
        kind: 'document',
        name: TITLE,
        op: `e2e-guest-live-make-${randomBytes(4).toString('hex')}`
      })
      const path = made.entries[0]?.ref?.path ?? ''
      if (!check(`"${TITLE}" made as a .tcdoc in the workspace's folder (work.files.make)`, path.endsWith('.tcdoc') && existsSync(path), made.refused.map((r) => r.text).join('; ') || path)) throw new Error('no document')
      rig.source = { at: 'file', host, path }
      const thread = await call<{ id: string; scope?: string }>('session.create', { provider: 'claude', workspaceId: ws.id, threadType: 'chat', permission: 'auto', title: TITLE })
      rig.sessionId = thread.id
      check('a Work thread to hold it', thread.scope === 'work', thread.scope)
      const item = await call<{ id: string; kind: string }>('work.canvas.open', { sessionId: thread.id, kind: 'document', source: rig.source, title: TITLE })
      rig.itemId = item.id
      if (!check("the document open in the window's canvas, editable", (await showThread()) && item.kind === 'document', item.kind)) throw new Error('no editor in the window')
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
const PLAN: Step[] = RESTART ? [STEPS[0]!, RESTART_STEP] : STEPS
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
    `# Live editing by guest link: the milestone ${RESTART ? '2' : '1'} proof${RESTART ? ' (--restart)' : ''}`,
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
