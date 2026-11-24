/**
 * The owner's case of 2026-11-23 on the DEPLOYED box (.temp-code/plans/landed/F-edits-lost.md "On the deployed box"):
 * one isolated windowed instance (its own HOME and userData, never his) of the tree in `--app <dir>` (the deployed
 * commit), paired to the real box with a client key minted for the run on the box's local socket and revoked at the
 * end, as his Mac's window reaches the box. By hand in that window, with real pointer and key events over CDP, in the
 * Purdue workspace's Files, in My OneDrive in the box's Windows VM (the one VM place this proof may write), dummy
 * files only, named "TempCode proof <stamp>":
 *  1. New → Deck, named in place; opened; words typed into a box on its slide; 3 s with the box still open: the file's
 *     bytes in the VM hold them (read by the box's own `work.files.read`, through the guest's helper). Then more words
 *     and the tab closed by its × at once: the file holds those too.
 *  2. New → Sheet, named in place; A1 typed, Return: the workbook in the VM holds the value.
 *  3. Delete on the deck: the question, Cancel focused; confirmed: the file is gone from the folder and Trash lists
 *     it; Undo puts it back; deleted again at the end, with the sheet.
 * Pictures of the header's line at each state and of the question go to `--out`.
 *
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-box-vm-edit.ts --app <built tree> --out <dir>
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { E2E_APP_TOKEN_SEED, withAppToken } from './lib/appToken'
import { attach, type Cdp } from './lib/packagedApp'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const APP = resolve(arg('--app') ?? '.')
const OUT = resolve(arg('--out') ?? join(tmpdir(), 'tc-box-vm-edit-shots'))
const WS = 'YfBTHVqGfj7M'
const BOX_URL = 'http://127.0.0.1:7677'
const STAMP = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
const DECK = `TempCode proof ${STAMP}`
const SHEET = `TempCode proof ${STAMP} sheet`
mkdirSync(OUT, { recursive: true })
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(300)
  }
  log(`timed out: ${label}`)
  return false
}

/** The real box's local socket, the implicit admin (tc-local). Never prints what it answers. */
function box<T>(method: string, params: unknown): T {
  const r = spawnSync('tc-local', [method, JSON.stringify(params)], { encoding: 'utf8', timeout: 180_000 })
  if (r.status !== 0) throw new Error(`${method}: ${(r.stderr || r.stdout).slice(0, 300)}`)
  return JSON.parse(r.stdout) as T
}
const boxId = box<{ environmentId: string }>('remote.status', {}).environmentId
const places = box<{ places: { id: string; name: string; vm?: boolean; kind: string; root: { path: string } }[] }>('work.files.places', { workspaceId: WS }).places
const oneDrive = places.find((p) => p.kind === 'onedrive' && p.vm)
if (!oneDrive) throw new Error('no OneDrive in the VM for the Purdue workspace')
const guest = (name: string): string => `${oneDrive.root.path}\\${name}`
/** The file's whole bytes where they lie in the VM, by the box's own read through the guest's helper. */
function bytesInVm(name: string): Buffer | null {
  try {
    const parts: Buffer[] = []
    for (let offset = 0; ; ) {
      const got = box<{ data: string; end: boolean }>('work.files.read', { workspaceId: WS, ref: { at: 'file', host: boxId, path: guest(name) }, offset, length: 4 * 1024 * 1024 })
      const b = Buffer.from(got.data, 'base64')
      parts.push(b)
      offset += b.length
      if (got.end || !b.length) break
    }
    return Buffer.concat(parts)
  } catch {
    return null
  }
}
const scratch = mkdtempSync(join(tmpdir(), 'tc-box-vm-edit-'))
function partOf(bytes: Buffer | null, part: string): string {
  if (!bytes) return ''
  const file = join(scratch, `f${Date.now()}.zip`)
  writeFileSync(file, bytes)
  return spawnSync('unzip', ['-p', file, part], { encoding: 'utf8' }).stdout ?? ''
}
const inVm = (name: string): boolean => (box<{ entries: { name: string }[] }>('work.files.list', { workspaceId: WS, at: { at: 'file', host: boxId, path: oneDrive.root.path } }).entries ?? []).some((e) => e.name === name)

// ── the window ────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'tc-box-vm-window-'))
const home = join(root, 'home')
const data = join(root, 'data')
for (const d of [home, data, join(root, 'tmp')]) mkdirSync(d, { recursive: true })
const debug = await freePort()
let proc: ChildProcess | undefined
let cdp: Cdp | null = null
let keyId: string | null = null
function launch(): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    TMPDIR: join(root, 'tmp'),
    TEMP_CODE_USER_DATA: data,
    TEMP_CODE_APP_TOKEN_SEED: E2E_APP_TOKEN_SEED,
    TEMP_CODE_HEADLESS: '0',
    TEMP_CODE_DEBUG_PORT: String(debug),
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_ALIAX_DATA_DIR: join(data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
    TEMP_CODE_WORK_ROOT: join(home, 'work'),
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
  for (const key of Object.keys(env)) if (/^TEMP_CODE_(HUB|APNS)_/.test(key)) delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  const electron = join(APP, 'node_modules', '.bin', 'electron')
  proc = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(join(root, 'app.log'), c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(join(root, 'app.log'), c))
}
const ev = <T>(js: string): Promise<T> => cdp!.eval<T>(js)
async function shot(name: string): Promise<void> {
  const r = (await cdp!.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
}
async function click(x: number, y: number, count = 1, button: 'left' | 'right' = 'left'): Promise<void> {
  await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (let c = 1; c <= count; c++) {
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: c })
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: c })
  }
}
const centre = (selector: string, text?: string, starts = false): Promise<{ x: number; y: number } | null> =>
  ev(
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].reverse().find((e) => ${text === undefined ? 'true' : starts ? `e.textContent.trim().startsWith(${JSON.stringify(text)})` : `e.textContent.trim() === ${JSON.stringify(text)}`} && e.getClientRects().length); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) return null; return { x: Math.round(r.x + Math.min(r.width / 2, 160)), y: Math.round(r.y + r.height / 2) }; })()`
  )
async function press(selector: string, text?: string, o: { count?: number; ms?: number; starts?: boolean; button?: 'left' | 'right' } = {}): Promise<boolean> {
  let at: { x: number; y: number } | null = null
  await until(`${selector} ${text ?? ''}`, o.ms ?? 20_000, async () => !!(at = await centre(selector, text, o.starts)))
  if (!at) return false
  // Measured again once a scroll into view has settled.
  await sleep(400)
  at = (await centre(selector, text, o.starts)) ?? at
  await click(at.x, at.y, o.count ?? 1, o.button)
  return true
}
const rowAt = (name: string): Promise<{ x: number; y: number } | null> =>
  ev(`(() => { const el = [...document.querySelectorAll('[data-files-row]')].find((e) => e.getClientRects().length && [...e.querySelectorAll('*')].some((c) => c.childElementCount === 0 && c.textContent.trim() === ${JSON.stringify(name)})); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.right - 70), y: Math.round(r.y + r.height / 2) }; })()`)
async function pressRow(name: string, count = 2, button: 'left' | 'right' = 'left'): Promise<boolean> {
  let at: { x: number; y: number } | null = null
  await until(`the row ${name}`, 60_000, async () => !!(at = await rowAt(name)))
  if (!at) return false
  // A name just typed in place is left first: a press on the row's far side opens it, never its name field.
  if (await ev<boolean>(`document.activeElement?.tagName === 'INPUT'`)) await key('Escape')
  await sleep(300)
  at = (await rowAt(name)) ?? at
  await click(at.x, at.y, count, button)
  return true
}
async function typeKeys(text: string): Promise<void> {
  for (const ch of text) {
    const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : ch === ' ' ? 'Space' : ''
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
  }
}
async function key(name: 'Enter' | 'Delete' | 'Escape'): Promise<void> {
  const codes = { Enter: 13, Delete: 46, Escape: 27 }
  await cdp!.send('Input.dispatchKeyEvent', { type: name === 'Enter' ? 'keyDown' : 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: codes[name], ...(name === 'Enter' ? { text: '\r' } : {}) })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: codes[name] })
}
const saveLine = (): Promise<string> => ev(`(() => { const p = [...document.querySelectorAll('[data-files-save-line]')].find((e) => e.getClientRects().length); return p ? p.dataset.filesSaveLine + ' | ' + p.textContent : '(none)' })()`)
const toasts = (): Promise<string[]> => ev(`[...document.querySelectorAll('[data-sonner-toast], li[role="status"], [role="status"]')].map((t) => t.textContent.trim()).filter(Boolean)`)
const tabsOfWs = (): { id: string; name: string; kind: string }[] => box<{ tabs: { id: string; name: string; kind: string }[] }>('work.files.tabs', { workspaceId: WS }).tabs
const before = new Set(tabsOfWs().map((t) => t.id))
async function closeTabByX(name: string): Promise<void> {
  await ev(`document.querySelector('[data-files-tab-close][aria-label=${JSON.stringify(`Close ${name}`)}]')?.click()`)
}
/** New → kind in the shown folder, named in place: answers whether the file is in the VM under its name. */
async function make(kind: 'Deck' | 'Sheet', stem: string, ext: string): Promise<boolean> {
  if (!(await press('button', 'New'))) return false
  if (!(await press('[role="menuitem"]', kind))) return false
  await until('the name field', 60_000, () => ev<boolean>(`document.activeElement?.tagName === 'INPUT'`))
  await sleep(500)
  await typeKeys(stem)
  await key('Enter')
  return until(`${stem}${ext} in the VM`, 90_000, () => inVm(`${stem}${ext}`))
}
async function pickAndOpenBox(): Promise<boolean> {
  for (const [fx, fy] of [[0.5, 0.3], [0.5, 0.45], [0.5, 0.6], [0.3, 0.2]] as const) {
    const b = await ev<{ x: number; y: number; w: number; h: number } | null>(`(() => { const l = document.querySelector('[data-slides-shapes]'); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`)
    if (!b) return false
    await click(Math.round(b.x + b.w * fx), Math.round(b.y + b.h * fy))
    if (!(await until('a shape is picked', 2_000, () => ev<boolean>(`!!document.querySelector('[data-shape][aria-pressed="true"]')`)))) continue
    await key('Enter')
    if (await until('the box opens', 3_000, () => ev<boolean>(`!!document.querySelector('[data-slide-typing][data-phase="typing"]')`))) return true
  }
  return false
}

const WORD = `TempCode proof ${STAMP} word`
const SOCKET = arg('--socket') ?? '/tmp/tc-vm-probe.sock'
/** One call to the guest's helper through this run's own forward (as office/vm/link.ts makes one), for a dummy file alone. */
function guestCall(verb: string, args: Record<string, unknown>): Promise<unknown> {
  const token = readFileSync('/srv/agents/temp-code-data/winvm/token', 'utf8').trim()
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET)
    let buf = ''
    const timer = setTimeout(() => (sock.destroy(), reject(new Error(`no answer to ${verb}`))), 120_000)
    sock.on('connect', () => sock.write(`${token}\n`))
    sock.on('data', (d) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const f = JSON.parse(line) as { event?: string; id?: number; ok?: boolean; value?: unknown; error?: { message?: string } }
        if (f.event === 'ready') sock.write(JSON.stringify({ id: 1, verb, args }) + '\n')
        else if (f.id === 1) {
          clearTimeout(timer)
          sock.destroy()
          if (f.ok) resolve(f.value)
          else reject(new Error(f.error?.message ?? 'the helper failed'))
        }
      }
    })
    sock.on('error', (err) => (clearTimeout(timer), reject(err)))
  })
}
const docText = async (): Promise<string> => ev(`(() => { const e = document.querySelector('[data-files-file] [contenteditable="true"]'); return e ? e.textContent : '' })()`)
let forward: ChildProcess | null = null
/** This run's own forward to the helper, as the admin over the standing machine's SSH: opened once the VM is awake. */
async function openForward(): Promise<boolean> {
  rmSync(SOCKET, { force: true })
  forward = spawn('ssh', ['-i', '/srv/agents/win-vm/keys/id_ed25519', '-p', '22230', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'UserKnownHostsFile=/srv/agents/win-vm/standing/known_hosts', '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `${SOCKET}:127.0.0.1:47801`, 'tcadmin@127.0.0.1'], { stdio: 'ignore' })
  return until('the forward', 30_000, () => spawnSync('test', ['-S', SOCKET]).status === 0)
}
async function wordCase(): Promise<void> {
  const name = `${WORD}.docx`
  if (!check("this run's forward to the VM's helper opens (the VM is awake)", await openForward())) return
  await guestCall('files.write', { dir: oneDrive!.root.path, name, data: readFileSync(join(import.meta.dir, '..', 'resources', 'work-files', 'blank', 'blank.docx')).toString('base64'), op: crypto.randomUUID() })
  check('a dummy Word file lies in My OneDrive in the VM', inVm(name))
  await sleep(6000)
  // The folder read again: away to Home and back, as he would.
  await press('button, a, [role="button"], [role="link"], div', 'Home')
  await sleep(1500)
  await press('button, a, [role="button"], [role="link"], div', 'My OneDrive')
  if (!check('it opens from its row', await pressRow(name))) return
  const editor = await until('the document', 180_000, async () => !!(await centre('[data-files-file] [contenteditable="true"]')))
  await until('the line', 20_000, async () => (await saveLine()).includes('Word file'))
  const opened = await saveLine()
  await shot('8-word-opened')
  check('it opens as a document, and the header says the Word file has not changed', editor && opened.includes('The Word file in OneDrive has not changed'), opened)
  const where = (): { path?: string } | undefined => {
    const tab = box<{ tabs: { name: string; itemId?: string; key?: string }[] }>('work.files.tabs', { workspaceId: WS }).tabs.find((t) => t.key?.endsWith(name))
    return box<{ items: { id: string; source: { path?: string } }[] }>('work.canvas.list', { sessionId: `filespane_${WS}` }).items.find((i) => i.id === tab?.itemId)?.source
  }
  log(`document: ${JSON.stringify(where())}`)
  const ed = (await centre('[data-files-file] [contenteditable="true"]'))!
  await click(ed.x, ed.y)
  const words = `Agenda ${STAMP.slice(-4)} doors open`
  await typeKeys(words)
  await sleep(4000)
  await shot('9-word-typed')
  const kept = where()?.path ?? ''
  await closeTabByX(name)
  await until('the tab goes', 15_000, async () => !(await centre(`[data-files-tab-close][aria-label=${JSON.stringify(`Close ${name}`)}]`)))
  await sleep(4000)
  check('closed, the document he edited is kept in the workspace folder', kept.startsWith('/srv/agents/work/Work/Purdue/') && box<{ entries: { name: string }[] }>('work.files.list', { workspaceId: WS, at: { at: 'file', host: boxId, path: '/srv/agents/work/Work/Purdue' } }).entries.some((e) => kept.endsWith(`/${e.name}`)), kept)
  check('it opens from its row again', await pressRow(name))
  const again = await until('the same document with his words', 120_000, async () => (await docText()).includes(words))
  check('opened again: the same document, with his words', again && where()?.path === kept, `${where()?.path}`)
  // Save to OneDrive as Word: the question, then Replace.
  check('the header offers Save to OneDrive as Word', await press('button', 'Save to OneDrive as Word'))
  const asked = await until('the question', 10_000, () => ev<boolean>(`!!document.querySelector('[role="alertdialog"]')`))
  const said = asked ? await ev<string>(`document.querySelector('[role="alertdialog"]').textContent`) : ''
  await shot('10-word-save-question')
  check('it asks first, naming what Word may change', asked && said.includes(`Replace ${name} in OneDrive?`) && said.includes('nested tables'), said)
  await press('[role="alertdialog"] button', 'Replace')
  const written = await until('the Word file in the VM holds his words', 120_000, () => partOf(bytesInVm(name), 'word/document.xml').includes(words.split(' ')[0]!) && partOf(bytesInVm(name), 'word/document.xml').includes('doors'))
  await until('saved as Word', 20_000, async () => (await saveLine()).includes('Saved to OneDrive as Word'))
  await shot('11-word-saved')
  check('Replace writes the Word file in the VM: its bytes hold his words, the header says saved as Word', written, await saveLine())
  // The file changed behind his back, then more words and Save again: never over it, Keep Both beside it.
  const now = (await guestCall('files.read', { path: guest(name), offset: 0, length: 1, version: true })) as { version: string }
  await guestCall('files.write', { path: guest(name), data: readFileSync(join(import.meta.dir, '..', 'resources', 'work-files', 'blank', 'blank.docx')).toString('base64'), expect: now.version, op: crypto.randomUUID() })
  const ed2 = (await centre('[data-files-file] [contenteditable="true"]'))!
  await click(ed2.x, ed2.y)
  await typeKeys(' again')
  await sleep(4000)
  await press('button', 'Save to OneDrive as Word', { ms: 20_000 })
  await until('the question', 10_000, () => ev<boolean>(`!!document.querySelector('[role="alertdialog"]')`))
  await press('[role="alertdialog"] button', 'Replace')
  const clash = await until('the second question', 60_000, async () => (await ev<string>(`document.querySelector('[role="alertdialog"]')?.textContent ?? ''`)).includes('changed in OneDrive'))
  await shot('12-word-changed-there')
  check('over a file that changed there it never writes, and offers Keep Both', clash && !partOf(bytesInVm(name), 'word/document.xml').includes('doors'))
  await press('[role="alertdialog"] button', 'Keep Both')
  const mine = `${WORD} (mine).docx`
  const both = await until('his version beside it', 120_000, () => inVm(mine) && partOf(bytesInVm(mine), 'word/document.xml').includes('doors'))
  check(`Keep Both puts his version beside it as "${mine}"`, both)
  await closeTabByX(name)
  await sleep(2000)
  keptDocs.push(kept)
}
const keptDocs: string[] = []

const cleanup = async (): Promise<void> => {
  forward?.kill()
  // Every tab this run opened in his workspace goes; anything it made in the VM goes to its Recycle Bin.
  try {
    for (const t of tabsOfWs()) if (!before.has(t.id)) box('work.files.tabClose', { workspaceId: WS, tabId: t.id })
  } catch (err) {
    log(`tabs left: ${err}`)
  }
  for (const doc of keptDocs) {
    try {
      // The run's own document, removed outright: nothing of it is left in his workspace's folder or its Trash.
      if (doc.startsWith('/srv/agents/work/Work/Purdue/TempCode proof ')) rmSync(doc, { force: true })
    } catch (err) {
      log(`could not delete ${doc}: ${String(err).slice(0, 200)}`)
    }
  }
  for (const name of [`${DECK}.pptx`, `${SHEET}.xlsx`, `${WORD}.docx`, `${WORD} (mine).docx`]) {
    try {
      if (inVm(name)) box('work.files.trash', { workspaceId: WS, refs: [{ at: 'file', host: boxId, path: guest(name) }], op: crypto.randomUUID(), asked: true })
    } catch (err) {
      log(`could not delete ${name}: ${String(err).slice(0, 200)}`)
    }
  }
  if (keyId) {
    try {
      box('remote.keys.revoke', { id: keyId })
      log('the run key is revoked')
    } catch {
      log('could not revoke the run key')
    }
  }
  cdp?.close()
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      if (proc?.pid) process.kill(-proc.pid, sig)
    } catch {
      /* gone */
    }
    await sleep(1500)
  }
  rmSync(scratch, { recursive: true, force: true })
  log(`window's folder: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

launch()
try {
  cdp = await attach(debug, 180_000)
  await cdp.send('Page.enable')
  const port = await cdp.eval<number | null>('window.api.getServerPort()')
  const local = async <T>(method: string, params: unknown): Promise<T> =>
    new Promise<T>((ok, fail) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'p', method, params: withAppToken(method, params) })))
      ws.addEventListener('message', (e) => {
        const f = JSON.parse(String(e.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
        if (f.id !== 'p') return
        ws.close()
        if (f.ok) ok(f.result as T)
        else fail(new Error(f.error))
      })
    })
  await local('work.set', { enabled: true })
  const minted = box<{ token: string; id?: string; key?: { id: string } }>('remote.keys.create', { name: 'edits-lost proof window', audience: 'client', caps: ['read', 'operate', 'approve'] })
  keyId = minted.id ?? minted.key?.id ?? null
  await local('remote.environments.add', { url: BOX_URL, key: minted.token, name: 'box' })
  await cdp.eval('window.__monocode.loadSavedEnvironments()')
  const linked = await until('window reaches the box', 60_000, () => cdp!.eval<boolean>(`window.__monocode.registry.has(${JSON.stringify(boxId)}) && window.__monocode.registry.statusOf(${JSON.stringify(boxId)}).transport === 'open'`))
  if (!check("the window reaches the deployed box over a minted key, as his Mac's does", linked)) throw new Error('no link')

  const opened = await press('button, a, [role="button"], [role="treeitem"], [role="link"], div', 'Purdue', { ms: 60_000 })
  await sleep(1500)
  await shot('0-rail')
  check("the rail's Purdue workspace opens", opened && (await until('its column', 20_000, async () => !!(await centre('button, a, [role="button"], [role="link"], div', 'Files')))))
  check('its Files view opens', await press('button, a, [role="button"], [role="link"], div', 'Files'))
  // A page tab of this run's own: his tabs are never moved.
  const tabsBefore = await ev<number>(`document.querySelectorAll('[role="tab"]').length`)
  check('a page tab of its own opens', (await press('button[aria-label="New Tab"]')) && (await until('the new tab', 15_000, async () => (await ev<number>(`document.querySelectorAll('[role="tab"]').length`)) > tabsBefore)))
  await sleep(1000)
  await press('button, a, [role="button"], [role="link"], div', 'My OneDrive', { ms: 60_000 })
  const shown = await until('My OneDrive is the page', 300_000, async () => !!(await centre('button', 'New')) && (await ev<string>(`[...document.querySelectorAll('[aria-current="page"], nav [data-crumb], h2, h1')].map((e) => e.textContent).join(' ')`)).includes('My OneDrive'))
  check('My OneDrive in the Windows VM opens in it (woken if asleep)', shown || !!(await centre('button', 'New')))
  await shot('0-my-onedrive')

  // 1. A deck made there, words typed into a box, 3 s with the box open.
  if (process.env.SKIP_DECK_TYPING === '1') {
    check(`New → Deck named "${DECK}" lies in the VM`, await make('Deck', DECK, '.pptx'))
  } else if (check(`New → Deck named "${DECK}" lies in the VM`, await make('Deck', DECK, '.pptx'))) {
    check('it opens from its row', await pressRow(`${DECK}.pptx`))
    const drawn = await until('the deck draws', 180_000, () => ev<boolean>(`!!document.querySelector('[data-slides-shapes] [data-shape]')`))
    await shot('1-deck-opened')
    check('the deck draws', drawn, await saveLine())
    log(`header at open: ${await saveLine()}`)
    if (check('a box on its slide opens for his words', await pickAndOpenBox())) {
      const one = `Esports kickoff ${STAMP.slice(-4)}`
      await typeKeys(one)
      await sleep(300)
      const typing = await saveLine()
      await shot('2-deck-typing-saving')
      check('while his words wait in the box the header says saving, never saved', typing.startsWith('saving'), typing)
      await sleep(3000)
      const kept = await until('the VM file holds the words', 30_000, () => partOf(bytesInVm(`${DECK}.pptx`), 'ppt/slides/slide1.xml').includes(one))
      check('3 s later, box still open, the file in the VM holds the typed words', kept, `box open: ${await ev<boolean>(`!!document.querySelector('[data-slide-typing][data-phase="typing"]')`)}; header "${await saveLine()}"`)
      await until('saved line', 20_000, async () => (await saveLine()).startsWith('saved'))
      await shot('3-deck-saved')
      check('the header then says saved to the VM with the time', /^saved \| Saved to .*\d/.test(await saveLine()), await saveLine())
      const two = ` day ${STAMP.slice(-3)}`
      await typeKeys(two)
      await closeTabByX(`${DECK}.pptx`)
      const closed = await until("the VM file holds the words typed just before the ×", 60_000, () => partOf(bytesInVm(`${DECK}.pptx`), 'ppt/slides/slide1.xml').includes(`${one}${two}`))
      check('more words, then the tab closed by its × at once: the file in the VM holds them', closed, `toasts ${JSON.stringify(await toasts())}`)
    }
  }

  // 2. A workbook made there, A1 typed.
  await until('the folder', 20_000, async () => !!(await centre('[data-files-row]')))
  if (check(`New → Sheet named "${SHEET}" lies in the VM`, await make('Sheet', SHEET, '.xlsx'))) {
    check('it opens from its row', await pressRow(`${SHEET}.xlsx`))
    const a1 = async (): Promise<{ x: number; y: number } | null> =>
      ev(`(() => { const c = [...document.querySelectorAll('[data-sheet-item] canvas')].find((e) => e.getBoundingClientRect().width > 100); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + 78), y: Math.round(r.y + 30) }; })()`)
    const drew = await until('the sheet', 180_000, async () => !!(await a1()))
    try {
      const tab = box<{ tabs: { name: string; itemId?: string }[] }>('work.files.tabs', { workspaceId: WS }).tabs.find((t) => t.name.startsWith(SHEET))
      const items = box<{ items: { id: string; kind: string; source: { path?: string } }[] }>('work.canvas.list', { sessionId: `filespane_${WS}` }).items
      log(`sheet item: ${JSON.stringify(items.find((i) => i.id === tab?.itemId)?.source)}`)
    } catch (err) {
      log(`sheet item not read: ${String(err).slice(0, 200)}`)
    }
    if (check('the sheet draws', drew)) {
      await sleep(1500)
      const at = (await a1())!
      await click(at.x, at.y)
      await sleep(300)
      const value = `Proof ${STAMP.slice(-4)}`
      await typeKeys(value)
      await key('Enter')
      await sleep(150)
      const right = await saveLine()
      await shot('4-sheet-saving')
      log(`header just after Return: ${right}`)
      const kept = await until('the VM workbook holds the value', 60_000, () => {
        const b = bytesInVm(`${SHEET}.xlsx`)
        return partOf(b, '*').includes(value)
      })
      await until('saved line', 20_000, async () => (await saveLine()).startsWith('saved'))
      await shot('4-sheet-saved')
      if (!kept) {
        const b = bytesInVm(`${SHEET}.xlsx`)
        const file = join(scratch, 'sheet-now.xlsx')
        if (b) writeFileSync(file, b)
        log(`the workbook in the VM now: ${b ? `${b.length} bytes; parts ${spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' }).stdout.replace(/\n/g, ' ')}` : 'not read'}; the copy here: ${spawnSync('unzip', ['-p', box<{ items: { id: string; source: { path?: string } }[] }>('work.canvas.list', { sessionId: `filespane_${WS}` }).items.find((i) => i.source.path?.includes(SHEET))?.source.path ?? '/none'], { encoding: 'utf8' }).stdout.includes(value) ? 'holds the value' : 'lacks the value'}`)
      }
      check('A1 typed and Return: the workbook in the VM holds the value, the header says saved', kept, await saveLine())
      // A second cell, and the tab closed by its × at once.
      await click(at.x, at.y + 22)
      await sleep(300)
      const second = `Second ${STAMP.slice(-3)}`
      await typeKeys(second)
      await key('Enter')
      await closeTabByX(`${SHEET}.xlsx`)
      const closed = await until('the VM workbook holds the second value', 60_000, () => {
        const b = bytesInVm(`${SHEET}.xlsx`)
        return partOf(b, '*').includes(second)
      })
      check('a second cell, then the tab closed by its × at once: the workbook in the VM holds it', closed)
    }
  }

  // 4. A Word file: a dummy .docx put in the folder by the guest's own helper (New offers no Word file in the VM).
  if (process.env.WORD !== '0') await wordCase()

  // 3. Delete on the deck: the question, Cancel focused; confirmed, Trash; Undo puts it back.
  if (process.env.SKIP_DELETE !== '1') {
  await until('the folder', 20_000, async () => !!(await centre('[data-files-row]')))
  if (await rowAt(`${DECK}.pptx`)) {
    await pressRow(`${DECK}.pptx`, 1)
    await key('Delete')
    let asked = await until('the question', 10_000, () => ev<boolean>(`!!document.querySelector('[role="alertdialog"]')`))
    if (!asked) {
      await pressRow(`${DECK}.pptx`, 1, 'right')
      await press('[role="menuitem"]', 'Delete', { starts: true, ms: 5_000 })
      asked = await until('the question', 10_000, () => ev<boolean>(`!!document.querySelector('[role="alertdialog"]')`))
    }
    const words = asked ? await ev<string>(`document.querySelector('[role="alertdialog"]').textContent`) : ''
    const focused = asked ? await ev<string>(`(document.activeElement?.textContent ?? '').trim()`) : ''
    await shot('5-delete-question')
    check('Delete asks first, with Cancel focused', asked && focused === 'Cancel', `"${words}"; focused "${focused}"`)
    if (asked) {
      const verb = await ev<string>(`[...document.querySelectorAll('[role="alertdialog"] button')].map((b) => b.textContent.trim()).filter((t) => t !== 'Cancel').pop() ?? ''`)
      await press('[role="alertdialog"] button', verb)
      // The toast that says it is done carries Undo, pressed while it shows.
      const told = await until('Deleted …', 60_000, async () => !!(await centre('button', 'Undo')))
      await shot('6-deleted-toast')
      const gone = !inVm(`${DECK}.pptx`)
      const trash = box<{ entries: { name: string }[] }>('work.files.list', { workspaceId: WS, at: { at: 'place', id: 'trash' } }).entries ?? []
      check("confirmed, the deck leaves the folder and Trash lists it (the VM's Recycle Bin)", told && gone && trash.some((e) => e.name === `${DECK}.pptx`), `trash rows: ${trash.filter((e) => e.name.startsWith('TempCode proof')).map((e) => e.name).join(', ')}`)
      const undone = (await press('button', 'Undo', { ms: 5_000 })) && (await until('the deck comes back', 90_000, () => inVm(`${DECK}.pptx`)))
      await shot('7-undo')
      check('Undo puts it back where it was', undone, JSON.stringify(await toasts()))
    }
  }
}
} catch (err) {
  check('the run finished', false, String((err as Error).stack ?? err))
  await shot('z-failed').catch(() => undefined)
} finally {
  await cleanup()
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
