/**
 * Capture from anywhere, end to end on the box (docs/agents/work-capture.md):
 * an isolated windowed instance of the built tree under xvfb, the real global
 * key pressed through XTest, the capture window driven over CDP, one capture
 * filed to the owner's LifeOS and taken back at once (`tasks:takeBack`, as if
 * never typed).
 *
 *   bun scripts/e2e-capture.ts        (electron-vite build first)
 *
 * It proves: no key and no window while Work is off; turning Work on holds the
 * key and makes the window, hidden; the key shows it focused on the field;
 * mod+7 picks Life and Return hides it and files a task from "Capture" in
 * Life; Escape hides it; turning Work off drops the window. Shots of the
 * shown window in dark and light go to TC_CAPTURE_SHOTS (default
 * /tmp/capture-e2e). LifeOS is signed in with a token minted for this run
 * ("F-capture proof") and signed out after, which revokes it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, REPO, sleep } from './lib/packagedApp'
import { freePort } from './lib/devInstance'

const SHOTS = process.env.TC_CAPTURE_SHOTS ?? '/tmp/capture-e2e'
const LIFEOS_CHECKOUT = process.env.TC_LIFEOS_CHECKOUT ?? '/srv/agents/work/lifeos'
let failed = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
  return ok
}
const until = async (ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(200)
  }
  return false
}

const root = mkdtempSync(join(tmpdir(), 'tc-capture-e2e-'))
const home = join(root, 'home')
const data = join(root, 'data')
for (const d of [home, data, join(root, 'tmp'), SHOTS]) mkdirSync(d, { recursive: true })
const debug = await freePort()
const displayFile = join(root, 'display')
const log = join(root, 'app.log')

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: home,
  TMPDIR: join(root, 'tmp'),
  TEMP_CODE_USER_DATA: data,
  TEMP_CODE_REMOTE_PORT: '0',
  TEMP_CODE_ALIAX_DATA_DIR: join(data, 'aliax'),
  TEMP_CODE_CLAIM_SHIM: '0',
  TEMP_CODE_HEADLESS: '0',
  TEMP_CODE_DEBUG_PORT: String(debug),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CODEX_HOME: join(home, '.codex'),
  NODE_ENV: 'production'
}
for (const key of Object.keys(env)) if (/^TEMP_CODE_(HUB|APNS)_/.test(key)) delete env[key]
delete env.ELECTRON_RUN_AS_NODE

const electron = join(REPO, 'node_modules', '.bin', 'electron')
const app: ChildProcess = spawn(
  'xvfb-run',
  ['-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', 'sh', '-c', `echo "$DISPLAY $XAUTHORITY" > ${displayFile}; exec dbus-run-session -- ${electron} .`],
  { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
)
app.stdout?.on('data', (c: Buffer) => appendFileSync(log, c))
app.stderr?.on('data', (c: Buffer) => appendFileSync(log, c))

/** Every process of this instance, by the marker its environment carries (the wrappers leave Electron behind). */
function stop(): void {
  for (const pid of spawnSync('pgrep', ['-u', String(process.getuid?.() ?? '')]).stdout.toString().split('\n').filter(Boolean)) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').includes(`TEMP_CODE_USER_DATA=${data}`)) process.kill(Number(pid), 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}

/** XTest key presses on the instance's display: a chord, held in order and let go in reverse. */
function press(...keysyms: string[]): void {
  const py = `
import ctypes, sys
x = ctypes.cdll.LoadLibrary('libX11.so.6'); t = ctypes.cdll.LoadLibrary('libXtst.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
x.XStringToKeysym.restype = ctypes.c_ulong
x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
t.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
x.XFlush.argtypes = [ctypes.c_void_p]
d = x.XOpenDisplay(None)
codes = [x.XKeysymToKeycode(d, x.XStringToKeysym(k.encode())) for k in sys.argv[1:]]
for c in codes: t.XTestFakeKeyEvent(d, c, 1, 0)
for c in reversed(codes): t.XTestFakeKeyEvent(d, c, 0, 0)
x.XFlush(d)
`
  const [display, xauth] = readFileSync(displayFile, 'utf8').trim().split(' ')
  const r = spawnSync('python3', ['-I', '-c', py, ...keysyms], { env: { ...process.env, DISPLAY: display, ...(xauth ? { XAUTHORITY: xauth } : {}) } })
  if (r.status !== 0) throw new Error(`xtest: ${r.stderr}`)
}

type Target = { type: string; url: string; webSocketDebuggerUrl?: string }
const targets = async (): Promise<Target[]> => (await (await fetch(`http://127.0.0.1:${debug}/json`)).json()) as Target[]
const targetOf = async (suffix: RegExp): Promise<Target | undefined> => (await targets().catch(() => [])).find((t) => t.type === 'page' && suffix.test(t.url))

let port = 0
async function rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`no answer to ${method}`)), 60_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok === false || frame.error) fail(new Error(String(frame.error)))
      else ok(frame.result as T)
    })
  })
}

async function lifeos<T>(kind: 'query' | 'mutation', path: string, args: unknown): Promise<T> {
  const auth = await rpc<{ ok: boolean; jwt: string; url: string }>('work.lifeos.jwt', {})
  if (!auth.ok) throw new Error('no LifeOS JWT')
  const res = await fetch(`${auth.url}/api/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.jwt}` }, body: JSON.stringify({ path, args, format: 'json' }) })
  const body = (await res.json()) as { status: string; value?: T; errorMessage?: string }
  if (body.status !== 'success') throw new Error(`${path}: ${body.errorMessage}`)
  return body.value as T
}

const NONCE = `Capture proof ${Date.now().toString(36)}`
let signedIn = false
try {
  const main = await until(90_000, async () => !!(await targetOf(/\/index\.html/)))
  if (!check('the instance opened its window', main)) throw new Error(`no window; log ${log}`)
  const page = await Cdp.connect((await targetOf(/\/index\.html/))!.webSocketDebuggerUrl!)
  await until(60_000, async () => (port = (await page.eval<number | null>('window.api?.getServerPort?.() ?? null')) ?? 0) > 0)
  check('the host answers', port > 0, String(port))

  press('Alt_L', 'Shift_L', 'space')
  await sleep(800)
  check('with Work off, the key opens nothing', !(await targetOf(/capture\.html/)))

  await rpc('work.set', { enabled: true })
  check('turning Work on makes the capture window, a little later', await until(30_000, async () => !!(await targetOf(/capture\.html\?place=work/))))
  const capture = await Cdp.connect((await targetOf(/capture\.html/))!.webSocketDebuggerUrl!)
  await until(20_000, () => capture.eval<boolean>('!!document.querySelector("[data-capture]")'))
  check('it waits unshown, already painted', !(await capture.eval<boolean>('document.hasFocus()')) && (await capture.eval<boolean>('!!document.querySelector("textarea")')))

  // A Work workspace for Life (its folder under this instance's HOME) and LifeOS signed in with a token minted for this run.
  await rpc('workspace.create', { kind: 'work', name: 'Life', sector: 'life' }).catch((e: Error) => console.log(`(workspace: ${e.message})`))
  const mint = spawnSync('sudo', ['/usr/local/bin/lifeos-deploy', 'run', LIFEOS_CHECKOUT, 'auth:mint', JSON.stringify({ ownerId: 'landon', name: 'F-capture proof' })], { encoding: 'utf8' })
  const token = /"?(lo_[A-Za-z0-9_-]+)"?/.exec(mint.stdout)?.[1]
  if (!check('a LifeOS token was minted for the run', !!token)) throw new Error('no token')
  await rpc('work.lifeos.setToken', { token })
  signedIn = true
  check('LifeOS connects', await until(30_000, async () => (await rpc<{ lifeos: { state: string } }>('work.lifeos.status', {})).lifeos.state === 'connected'))

  press('Alt_L', 'Shift_L', 'space')
  check('the key shows the window', await until(5_000, async () => (await capture.eval<string>('document.visibilityState')) === 'visible'))
  check('the field has the keyboard', await capture.eval<boolean>('document.activeElement?.tagName === "TEXTAREA"'))

  for (const scheme of ['dark', 'light'] as const) {
    await page.eval(`localStorage.setItem("monocode.colorScheme.work", "${scheme}")`)
    await sleep(300)
    const shot = (await capture.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync(join(SHOTS, `capture.${scheme}.png`), Buffer.from(shot.data, 'base64'))
  }
  await page.eval('localStorage.removeItem("monocode.colorScheme.work")')

  await capture.send('Input.insertText', { text: NONCE })
  await capture.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, modifiers: 2 })
  await capture.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, modifiers: 2 })
  check('mod+7 picks Life', (await capture.eval<string>('[...document.querySelectorAll("[aria-pressed=true]")].map((b) => b.textContent).join()')) === 'Life')
  const shot = (await capture.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(join(SHOTS, 'capture.typed.png'), Buffer.from(shot.data, 'base64'))
  await capture.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await capture.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  check('Return hides the window at once', await until(2_000, async () => (await capture.eval<string>('document.visibilityState')) === 'hidden'))

  type Task = { _id: string; title: string; sector: string; source?: { channel?: string; messageId?: string } }
  let found: Task | undefined
  await until(20_000, async () => !!(found = (await lifeos<Task[]>('query', 'tasks:search', { text: NONCE })).find((t) => t.title === NONCE)))
  check('the capture is a task in Life from Capture', found?.sector === 'life' && found.source?.channel === 'Capture', JSON.stringify(found && { sector: found.sector, channel: found.source?.channel }))
  check('the draft cleared once the host had it', await until(5_000, () => capture.eval<boolean>('document.querySelector("textarea").value === ""')))
  if (found?.source?.messageId) {
    await lifeos('mutation', 'tasks:takeBack', { key: found.source.messageId })
    check('the proof task is taken back', !(await lifeos<Task[]>('query', 'tasks:search', { text: NONCE })).some((t) => t.title === NONCE))
  }

  press('Alt_L', 'Shift_L', 'space')
  await until(5_000, async () => (await capture.eval<string>('document.visibilityState')) === 'visible')
  await capture.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check('Escape hides it', await until(2_000, async () => (await capture.eval<string>('document.visibilityState')) === 'hidden'))

  await rpc('work.set', { enabled: false })
  check('turning Work off drops the window', await until(10_000, async () => !(await targetOf(/capture\.html/))))
} catch (err) {
  check('the run', false, err instanceof Error ? err.message : String(err))
} finally {
  if (signedIn) await rpc('work.lifeos.signOut', {}).catch(() => undefined)
  stop()
  try {
    app.kill('SIGKILL')
  } catch {
    /* gone */
  }
  if (!process.env.TC_CAPTURE_KEEP) rmSync(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
