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
 *  2. New → Sheet, named in place; A1 typed, Return: the workbook in the VM holds the value, judged by the words of its
 *     cells with the markup taken out (Univer gives the first key typed its own text run: `<t>P</t>…<t>roof …</t>`).
 *     A second cell, then the tab closed by its × at once: it holds that too. Opened again (now an existing
 *     workbook), A3 typed: it holds all three.
 *  3. Delete on the deck: the question, Cancel focused; confirmed: the file is gone from the folder and Trash lists
 *     it; Undo puts it back; deleted again at the end, with the sheet.
 * Pictures of the header's line at each state and of the question go to `--out`.
 *
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-box-vm-edit.ts --app <built tree> --out <dir>
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
/** A part's words with its markup taken out: a value written as rich text runs is one string again. */
const textOf = (xml: string): string => xml.replace(/<[^>]+>/g, '')
/** Whether the proof's workbook in the VM holds a value, as words in a cell (a value typed may be split in rich text runs). */
const sheetHolds = (value: string): boolean => {
  const b = bytesInVm(`${SHEET}.xlsx`)
  return textOf(partOf(b, 'xl/sharedStrings.xml')).includes(value) || textOf(partOf(b, 'xl/worksheets/sheet1.xml')).includes(value)
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
    // a folder of the run's own: this instance never holds the real Windows VM (db1d2366f)
    WINVM_DIR: `${data}/no-vm`,
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
/** The tab's ×, by its own name: a Word file's tab is named for its document, with no .docx. Answers whether one was pressed. */
async function closeTabByX(name: string): Promise<boolean> {
  const labels = [`Close ${name}`, `Close ${name.replace(/\.docx$/, '')}`]
  return ev<boolean>(`(() => { const b = ${JSON.stringify(labels)}.map((l) => document.querySelector('[data-files-tab-close][aria-label="' + l + '"]')).find(Boolean); b?.click(); return !!b })()`)
}
/** Back to My OneDrive's list: a closed tab leaves the view on a neighbour. */
async function toOneDrive(): Promise<void> {
  await press('button, a, [role="button"], [role="link"], div', 'Home')
  await sleep(1500)
  await press('button, a, [role="button"], [role="link"], div', 'My OneDrive')
  await sleep(1500)
}
/** Whether the file shown is this run's own: nothing is typed into any other. */
const oursShown = (): Promise<boolean> => ev<boolean>(`[...document.querySelectorAll('[data-files-file]')].some((e) => e.getClientRects().length && e.textContent.includes(${JSON.stringify(STAMP)}))`)
/** New → kind in the shown folder, named in place: answers whether the file is in the VM under its name. */
async function make(kind: 'Deck' | 'Sheet' | 'Document' | 'Folder', stem: string, ext: string): Promise<boolean> {
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
/** A saved line, as 1.0.370 says it or as a build that tells the upload says it ("Saved, uploading…", "In OneDrive 4:10 AM"). */
const savedLine = (line: string): boolean => /Saved to OneDrive|In OneDrive \d|Saved, uploading to OneDrive|Saved on the Windows VM; OneDrive uploads it/.test(line)

/**
 * OneDrive's own record of the file in the VM, as the sync client last heard it from the server: its eTag
 * ("{id},N", N the server's version) and the server's size (SyncEngineDatabase.db, copied out as the admin; the
 * dummy's row alone is read). Null where it is not there yet.
 */
function webSide(name: string): { etag: string; version: number; size: number } | null {
  const db = join(scratch, `se-${Date.now()}.db`)
  const got = spawnSync('scp', ['-q', '-i', '/srv/agents/win-vm/keys/id_ed25519', '-P', '22230', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'UserKnownHostsFile=/srv/agents/win-vm/standing/known_hosts', 'tcadmin@127.0.0.1:C:/Users/tcuser/AppData/Local/Microsoft/OneDrive/settings/Business1/SyncEngineDatabase.db', db], { timeout: 60_000 })
  if (got.status !== 0) return null
  const row = spawnSync('sqlite3', ['-separator', '|', db, `SELECT eTag, serverSize FROM od_ClientFile_Records WHERE fileName = '${name.replaceAll("'", "''")}'`], { encoding: 'utf8' }).stdout.trim()
  rmSync(db, { force: true })
  const [etag, size] = row.split('|')
  return etag ? { etag, version: Number(/,(\d+)"?$/.exec(etag)?.[1] ?? 0), size: Number(size) } : null
}

/**
 * Saved is not uploaded (work-files.md): on a build that tells it, the header goes from "Saved, uploading to OneDrive…" to
 * "In OneDrive <time>" once OneDrive in the VM has the file, the tab's `cloud` says uploaded, and the web side holds the
 * bytes written: the server's version moved and its size is the file's.
 */
async function uploadCase(name: string): Promise<void> {
  const tab = (): { cloud?: { is: string } } | undefined => box<{ tabs: { key?: string; cloud?: { is: string } }[] }>('work.files.tabs', { workspaceId: WS }).tabs.find((t) => t.key?.endsWith(name.replace(/\.docx$/, '')) || t.key?.endsWith(name))
  if (!tab()?.cloud && !(await saveLine()).includes('uploading') && !/In OneDrive \d/.test(await saveLine())) return log('this build does not tell the upload: skipped')
  const before = webSide(name)
  const local = bytesInVm(name)?.length ?? 0
  const t0 = Date.now()
  const told = await until('In OneDrive', 120_000, async () => /In OneDrive \d/.test(await saveLine()))
  const took = Date.now() - t0
  await shot('11b-word-in-onedrive')
  check(`the header says In OneDrive once OneDrive in the VM has uploaded it (${(took / 1000).toFixed(1)} s after Saved)`, told && tab()?.cloud?.is === 'uploaded', `${await saveLine()} | cloud ${JSON.stringify(tab()?.cloud)}`)
  const web = await until('the web side', 60_000, () => {
    const now = webSide(name)
    return !!now && (!before || now.version > before.version) && now.size === local
  })
  check('the web side holds the bytes written: the server\'s version moved and its size is the file\'s', web, JSON.stringify({ before, after: webSide(name), local }))
}

async function wordCase(): Promise<void> {
  const name = `${WORD}.docx`
  if (!check("this run's forward to the VM's helper opens (the VM is awake)", await openForward())) return
  // A dummy Word file of someone's (a starter template, not our blank): it asks once before saving by itself.
  const sample = readFileSync(join(import.meta.dir, '..', 'resources', 'work-templates', 'ref', 'Incident report.docx'))
  await guestCall('files.write', { dir: oneDrive!.root.path, name, data: sample.toString('base64'), op: crypto.randomUUID() })
  check('a dummy Word file lies in My OneDrive in the VM', await until('the dummy listed', 30_000, () => inVm(name)))
  await sleep(6000)
  await press('button, a, [role="button"], [role="link"], div', 'Home')
  await sleep(1500)
  await press('button, a, [role="button"], [role="link"], div', 'My OneDrive')
  if (!check('it opens from its row', await pressRow(name))) return
  const editor = await until('the document', 180_000, async () => !!(await centre('[data-files-file] [contenteditable="true"]')))
  await until('the Word line', 30_000, async () => (await saveLine()).includes('Word file'))
  const opened = await saveLine()
  await shot('8-word-opened')
  check('it opens as a document; the header says the Word file has not changed', editor && opened.includes('The Word file in OneDrive has not changed'), opened)
  const where = (n: string): string => {
    const tab = box<{ tabs: { itemId?: string; key?: string }[] }>('work.files.tabs', { workspaceId: WS }).tabs.find((t) => t.key?.endsWith(n))
    return box<{ items: { id: string; source: { path?: string } }[] }>('work.canvas.list', { sessionId: `filespane_${WS}` }).items.find((i) => i.id === tab?.itemId)?.source.path ?? ''
  }
  keptDocs.push(where(name))
  const typeIn = async (words: string): Promise<void> => {
    if (!(await oursShown())) throw new Error('the file shown is not this run\'s dummy: nothing typed')
    const ed = (await centre('[data-files-file] [contenteditable="true"]'))!
    await click(ed.x, ed.y)
    await ev(`(() => { const e = document.querySelector('[data-files-file] [contenteditable="true"]'); const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`)
    await typeKeys(words)
  }
  const wordsIn = (n: string): string => partOf(bytesInVm(n), 'word/document.xml')
  const one = `Agenda ${STAMP.slice(-4)} doors`
  // One letter, then the notice the first change brings; his words after it is answered.
  await typeIn('A')
  const asked = await until('the notice', 60_000, () => ev<boolean>(`!!document.querySelector('[role="alertdialog"]')`))
  const said = asked ? await ev<string>(`document.querySelector('[role="alertdialog"]').textContent`) : ''
  await shot('9-word-first-notice')
  check('the first time, one notice names what Word may change, with Save automatically and Ask me each time', asked && said.includes('Save automatically') && said.includes('Ask me each time') && said.includes('nested tables'), said)
  await press('[role="alertdialog"] button', 'Save automatically', { starts: true })
  await until('the notice goes', 10_000, async () => !(await ev<boolean>(`!!document.querySelector('[role="alertdialog"]')`)))
  await typeIn(` ${one}`)
  const saving = await until('Saving to OneDrive…', 20_000, async () => (await saveLine()).includes('Saving to OneDrive'))
  await shot('10-word-saving')
  const landed = await until('the words in the VM', 120_000, () => wordsIn(name).includes('doors'))
  if (!landed) log(`the Word file in the VM: ${bytesInVm(name)?.length ?? 'not read'} bytes; its text holds: ${JSON.stringify(wordsIn(name).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(-200))}`)
  await until('Saved to OneDrive', 30_000, async () => savedLine(await saveLine()))
  await shot('11-word-saved')
  check('with no press the header says Saving to OneDrive… then saved, and the Word file in the VM holds his words', saving && landed && savedLine(await saveLine()), await saveLine())
  await uploadCase(name)
  check('its tab closes by its ×', await closeTabByX(name))
  await sleep(3000)
  await toOneDrive()
  check('closed and opened again: the same document, with his words', (await pressRow(name)) && (await until('his words', 120_000, async () => (await docText()).includes(one))))
  // The notice was asked once: his answer is kept on the host, and more words ask nothing.
  await typeIn(' again')
  const twice = await until('a second notice', 10_000, () => ev<boolean>(`!!document.querySelector('[role="alertdialog"]')`))
  check('the notice is asked once per file: opened again and typed into, it does not come back', !twice)
  await until('saved again', 60_000, () => wordsIn(name).includes('again'))
  // The file changed in the VM behind his back: his next words stop there, never over it.
  const now = (await guestCall('files.read', { path: guest(name), offset: 0, length: 1, version: true })) as { version: string }
  await guestCall('files.write', { path: guest(name), data: sample.toString('base64'), expect: now.version, op: crypto.randomUUID() })
  await sleep(2000)
  const two = ` kickoff ${STAMP.slice(-3)}`
  await typeIn(two)
  const stopped = await until('the stop', 90_000, async () => (await saveLine()).includes('This file changed in OneDrive'))
  await shot('12-word-stopped')
  check('a change made there stops autosave: the header says so with Keep Both and Replace, and nothing is written over it', stopped && !!(await centre('button', 'Keep Both')) && !!(await centre('button', 'Replace')) && !wordsIn(name).includes('kickoff'), await saveLine())
  await press('button', 'Replace')
  const replaced = await until('the Word file holds his words again', 120_000, () => wordsIn(name).includes('kickoff'))
  await until('Saved to OneDrive', 30_000, async () => savedLine(await saveLine()))
  await shot('13-word-replaced')
  check('Replace on his press writes his document over it: the VM file holds his newest words', replaced && savedLine(await saveLine()), await saveLine())
  // Words typed and the tab closed at once: they reach the file, and the document opens again with them (2b0c7f9d6).
  const late = ` late ${STAMP.slice(-3)}`
  await typeIn(late)
  const shut = await closeTabByX(name)
  const kept = await until('the late words in the VM', 120_000, () => wordsIn(name).includes('late'))
  check('typed and closed at once: the words reach the Word file in the VM', shut && kept)
  await sleep(2000)
  await toOneDrive()
  check('opened again: the document holds them', (await pressRow(name)) && (await until('late words', 120_000, async () => (await docText()).includes(late.trim()))))
  // Save as Word to… a folder he picks: a new Word file there, never over anything.
  await press(`button[aria-label=${JSON.stringify(`More for ${name.replace(/\.docx$/, '')}`)}], button[aria-label=${JSON.stringify(`More for ${name}`)}]`, undefined)
  const offered = await press('[role="menuitem"]', 'Save as Word to…', { ms: 5_000 })
  await shot('15-save-as-word-picker')
  // A build with Save As… in its place (226b881f2) has its own sheet and proof: this step is skipped there.
  if (!offered) {
    log('the file menu has no Save as Word to… on this build (Save As… took its place): skipped')
    await key('Escape')
  } else {
    await press('[role="dialog"] button, [role="dialog"] [role="button"], [role="dialog"] div', 'My OneDrive', { ms: 15_000 })
    await sleep(1500)
    const saved = await press('[role="dialog"] button', 'Save Here', { ms: 15_000 })
    const told = await until('the toast', 60_000, async () => (await ev<string>('document.body.textContent')).includes('Saved as Word in'))
    await shot('16-saved-as-word')
    const made = box<{ entries: { name: string }[] }>('work.files.list', { workspaceId: WS, at: { at: 'file', host: boxId, path: oneDrive!.root.path } }).entries.map((e) => e.name).filter((n) => n.startsWith(WORD) && n !== name && !n.includes(' new') && !n.includes('(mine)'))
    keptExtra.push(...made)
    check('Save Here writes a new Word file in the folder with his words, and says so', saved && told && made.length === 1 && wordsIn(made[0]!).includes('late'), made.join(', '))
  }
  await closeTabByX(name)
  await sleep(2000)
  await toOneDrive()
}
const keptExtra: string[] = []

/** New → Document in a Teams library: in a "TempCode proof" folder made for the run and removed after. */
/** A file's whole bytes at a path in the VM, by the box's own read through the guest's helper. */
function bytesAt(path: string): Buffer | null {
  try {
    const parts: Buffer[] = []
    for (let offset = 0; ; ) {
      const got = box<{ data: string; end: boolean }>('work.files.read', { workspaceId: WS, ref: { at: 'file', host: boxId, path }, offset, length: 4 * 1024 * 1024 })
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
/** The part names of an Office file's bytes. */
function partsOf(bytes: Buffer | null): string[] {
  if (!bytes) return []
  const file = join(scratch, `l${Date.now()}.zip`)
  writeFileSync(file, bytes)
  return (spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' }).stdout ?? '').split('\n').filter(Boolean)
}
/** SharePoint's own parts in a file it took in (its columns as custom XML): its rewrite after the upload came down. */
const rewritten = (path: string): boolean => partsOf(bytesAt(path)).some((n) => n.startsWith('customXml/'))

/** Every header line the window shows, with when it showed (a page interval, 100 ms). */
async function traceLines(): Promise<void> {
  await ev(`(() => { window.__lines = []; clearInterval(window.__linesTimer); window.__linesTimer = setInterval(() => { const p = [...document.querySelectorAll('[data-files-save-line]')].find((e) => e.getClientRects().length); const t = p ? p.dataset.filesSaveLine + ' | ' + p.textContent : '(none)'; if (window.__lines.at(-1)?.t !== t) window.__lines.push({ at: Date.now(), t }); }, 100); })()`)
}
const linesSeen = (): Promise<{ at: number; t: string }[]> => ev(`window.__lines ?? []`)

/** The helper's own `sync` mark on a file, looked at every 300 ms by this run's forward: each change with when. */
function traceSync(path: string): { marks: { at: number; sync: string }[]; stop(): void } {
  const marks: { at: number; sync: string }[] = []
  let on = true
  void (async () => {
    while (on) {
      try {
        const e = (await guestCall('files.stat', { path })) as { synced?: boolean }
        const sync = e.synced === undefined ? '(none)' : e.synced ? 'in' : 'pending'
        if (marks.at(-1)?.sync !== sync) marks.push({ at: Date.now(), sync })
      } catch {
        /* the file is being replaced: the next look */
      }
      await sleep(300)
    }
  })()
  return { marks, stop: () => (on = false) }
}
const hms = (at: number): string => new Date(at).toISOString().slice(11, 23)

/** A PowerShell script run as tcuser on the VM's desktop (a task with his interactive token, made by the admin); its output. */
function asUser(ps: string): string {
  const name = `tc-proof-${process.pid}-${Date.now()}`
  const local = join(scratch, `${name}.ps1`)
  writeFileSync(local, ps)
  const opts = ['-i', '/srv/agents/win-vm/keys/id_ed25519', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'UserKnownHostsFile=/srv/agents/win-vm/standing/known_hosts']
  if (spawnSync('scp', ['-q', ...opts, '-P', '22230', local, `tcadmin@127.0.0.1:C:/Users/Public/${name}.ps1`], { timeout: 60_000 }).status !== 0) return 'not copied'
  const out = `C:\\Users\\Public\\${name}.out`
  const reg = `$ErrorActionPreference='Stop'
$svc = New-Object -ComObject Schedule.Service; $svc.Connect(); $root = $svc.GetFolder('\\')
$def = $svc.NewTask(0); $def.Principal.UserId = 'tcuser'; $def.Principal.LogonType = 3; $def.Settings.ExecutionTimeLimit = 'PT5M'
$a = $def.Actions.Create(0); $a.Path = 'powershell.exe'
$a.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& ''C:\\Users\\Public\\${name}.ps1'' *> ''${out}''"'
$t = $root.RegisterTaskDefinition('${name}', $def, 6, $null, $null, 3)
$t.Run($null) | Out-Null
$end = (Get-Date).AddSeconds(240)
do { Start-Sleep 1; $s = $root.GetTask('${name}').State } while ($s -eq 4 -and (Get-Date) -lt $end)
$root.DeleteTask('${name}', 0)
if (Test-Path '${out}') { Get-Content '${out}'; Remove-Item '${out}' }
Remove-Item 'C:\\Users\\Public\\${name}.ps1'`
  const encoded = Buffer.from(reg, 'utf16le').toString('base64')
  const r = spawnSync('ssh', [...opts, '-p', '22230', 'tcadmin@127.0.0.1', `powershell -NoProfile -EncodedCommand ${encoded}`], { encoding: 'utf8', timeout: 300_000 })
  return (r.stdout ?? '').split('\n').filter((l) => !l.startsWith('#< CLIXML') && !l.startsWith('<Objs')).join('\n').trim()
}
/** OneDrive in the VM, stopped for the proof's late upload and started again after (never left stopped: `cleanup`). */
let oneDriveExe: string | null = null
function stopOneDrive(): boolean {
  const said = asUser(`$p = Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { 'not running'; return }
$exe = $p.Path; & $exe /shutdown; Start-Sleep 5
'exe=' + $exe; 'running=' + [bool](Get-Process OneDrive -ErrorAction SilentlyContinue)`)
  oneDriveExe = /exe=(.+)/.exec(said)?.[1]?.trim() ?? null
  log(`OneDrive stopped: ${said.replace(/\n/g, '; ')}`)
  return said.includes('running=False')
}
function startOneDrive(): boolean {
  if (!oneDriveExe) return true
  const said = asUser(`Start-Process -FilePath '${oneDriveExe.replaceAll("'", "''")}' -ArgumentList '/background'; Start-Sleep 8; 'running=' + [bool](Get-Process OneDrive -ErrorAction SilentlyContinue)`)
  log(`OneDrive started again: ${said.replace(/\n/g, '; ')}`)
  const ok = said.includes('running=True')
  if (ok) oneDriveExe = null
  return ok
}

/** The file's version as the helper writes by it, and a write over it there: a change made in the VM, not by TempCode. */
async function changeThere(path: string, data: Buffer): Promise<void> {
  const now = (await guestCall('files.read', { path, offset: 0, length: 1, version: true })) as { version: string }
  await guestCall('files.write', { path, data: data.toString('base64'), expect: now.version, op: crypto.randomUUID() })
}

/**
 * A Teams library (1.0.371): in a "TempCode proof" folder made in Team RecWell, a document, a deck and a workbook each
 * saved again after OneDrive uploaded them and SharePoint wrote its own parts into them, never stopped by that, and
 * stopped by a real change made in the VM. The header's stages are traced against the helper's own `sync` mark, and
 * OneDrive stopped for one save shows the late line.
 */
async function teamsDocumentCase(): Promise<void> {
  const channel = places.find((p) => p.kind === 'teams' && p.vm && p.name === 'Team RecWell')
  if (!check('a Teams library place in the VM is listed (Team RecWell)', !!channel)) return
  await press('button, a, [role="button"], [role="link"], div', 'RecWell')
  await sleep(1500)
  if (!check('its channel opens', await pressRow('Team RecWell'))) return
  await until('the channel', 60_000, async () => !!(await centre('button', 'New')))
  const folder = `TempCode proof ${STAMP} folder`
  await press('button', 'New')
  await press('[role="menuitem"]', 'Folder')
  await until('the name field', 30_000, () => ev<boolean>(`document.activeElement?.tagName === 'INPUT'`))
  await sleep(500)
  await typeKeys(folder)
  await key('Enter')
  const dir = `${channel!.root.path}\\${folder}`
  proofFolder = dir
  const listed = (path: string): string[] => box<{ entries: { name: string }[] }>('work.files.list', { workspaceId: WS, at: { at: 'file', host: boxId, path } }).entries.map((e) => e.name)
  if (!check('a "TempCode proof" folder is made in the Teams library', await until('the folder', 60_000, () => listed(channel!.root.path).includes(folder)))) return
  const heading = (): Promise<string> => ev<string>(`[...document.querySelectorAll('[aria-current="page"], nav [data-crumb], h1, h2')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()).join(' / ')`)
  let toFolderTries = 0
  const toFolder = async (): Promise<boolean> => {
    // A closed file tab leaves the view on a neighbour: the folder's own page when it is the one shown.
    if ((await heading()).includes(folder) && (await centre('button', 'New'))) return true
    await press('button, a, [role="button"], [role="link"], div', 'RecWell')
    await sleep(1500)
    const channel = await pressRow('Team RecWell')
    if (!channel) {
      // Why the place did not show its channel: what the view shows, as a picture and in words.
      await shot(`27-recwell-row-${++toFolderTries}`)
      log(`the RecWell place did not list Team RecWell: heading "${await heading()}"; rows ${JSON.stringify(await ev<string[]>(`[...document.querySelectorAll('[data-files-row]')].slice(0, 8).map((e) => e.textContent.trim().slice(0, 40))`))}; line "${await saveLine()}"`)
    }
    await until('the channel', 60_000, async () => !!(await centre('button', 'New')))
    const ok = await pressRow(folder)
    await until('the folder page', 30_000, async () => !!(await centre('button', 'New')))
    return ok
  }
  if (!check('it opens', await toFolder())) return
  // The helper the deploy made: its entries say OneDrive's own mark.
  const probe = (await guestCall('files.list', { dir })) as unknown
  log(`the helper lists the folder: ${JSON.stringify(probe).slice(0, 200)}`)
  const inTeams = (line: string): boolean => /In Teams \d/.test(line)
  const stopped = (line: string): boolean => /changed (in Teams|on the Windows VM)/.test(line)

  // ── the document ──
  const stem = `${WORD} teams`
  await press('button', 'New')
  const offered = await press('[role="menuitem"]', 'Document', { ms: 5_000 })
  await shot('20-teams-new')
  if (!check('New offers a Document in the Teams library', offered)) return
  await until('the name field', 30_000, () => ev<boolean>(`document.activeElement?.tagName === 'INPUT'`))
  await sleep(500)
  await typeKeys(stem)
  await key('Enter')
  const name = `${stem}.docx`
  const path = `${dir}\\${name}`
  if (check('a Word file is made there', await until('the Word file', 60_000, () => listed(dir).includes(name))) && check('it opens from its row', await pressRow(name))) {
    await until('the document', 180_000, async () => !!(await centre('[data-files-file] [contenteditable="true"]')))
    const tab = box<{ tabs: { itemId?: string; key?: string }[] }>('work.files.tabs', { workspaceId: WS }).tabs.find((t) => t.key?.endsWith(name))
    keptDocs.push(box<{ items: { id: string; source: { path?: string } }[] }>('work.canvas.list', { sessionId: `filespane_${WS}` }).items.find((i) => i.id === tab?.itemId)?.source.path ?? '')
    if (check('the shown file is the Teams document', await oursShown())) {
      const words = (): string => textOf(partOf(bytesAt(path), 'word/document.xml'))
      const typeIn = async (text: string): Promise<void> => {
        if (!(await oursShown())) throw new Error("the file shown is not this run's dummy: nothing typed")
        const ed = (await centre('[data-files-file] [contenteditable="true"]'))!
        await click(ed.x, ed.y)
        await ev(`(() => { const e = document.querySelector('[data-files-file] [contenteditable="true"]'); const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`)
        await typeKeys(text)
      }
      const sync = traceSync(path)
      await traceLines()
      const rounds = [`Bracket ${STAMP.slice(-4)} finals`, ' round two', ' round three']
      const typedAt: number[] = []
      for (const [i, text] of rounds.entries()) {
        await typeIn(text)
        typedAt.push(Date.now())
        const word = text.trim().split(' ').at(-1)!
        const landed = await until(`save ${i + 1} in the Teams file`, 120_000, () => words().includes(word))
        const told = await until('In Teams', 90_000, async () => inTeams(await saveLine()))
        // His last keystroke to the header's Saved (uploading or In Teams), from the window's own trace.
        const savedAt = (await linesSeen()).find((l) => l.at > typedAt[i]! && /Saved, uploading to Teams|In Teams \d/.test(l.t))?.at
        log(`save ${i + 1}: keystroke to Saved ${savedAt ? ((savedAt - typedAt[i]!) / 1000).toFixed(1) + ' s' : 'never'}`)
        if (i === 0) await shot('21-teams-doc-in-teams')
        // SharePoint writes its own parts into it about half a second after the upload, and they come down.
        const back = await until('SharePoint\'s rewrite comes down', 30_000, () => rewritten(path))
        await sleep(4000)
        check(`save ${i + 1} of ${rounds.length}: his words reach the Teams file by themselves, the header says In Teams, and SharePoint's rewrite (${back ? 'seen' : 'not seen'}) stops nothing`, landed && told && !stopped(await saveLine()), await saveLine())
      }
      // The stages, read against the helper's own mark.
      const lines = await linesSeen()
      const uploading = lines.filter((l) => l.t.includes('Saved, uploading to Teams'))
      const inT = lines.filter((l) => inTeams(l.t))
      const ins = sync.marks.filter((m) => m.sync === 'in')
      const pend = sync.marks.filter((m) => m.sync === 'pending')
      log(`header lines: ${lines.map((l) => `${hms(l.at)} ${l.t}`).join(' / ')}`)
      log(`helper sync marks: ${sync.marks.map((m) => `${hms(m.at)} ${m.sync}`).join(' / ')}`)
      const firstIn = inT[0]?.at ?? 0
      const markBefore = ins.filter((m) => m.at <= firstIn + 2500).at(-1)
      check('the header said "Saved, uploading to Teams…" and only then "In Teams <time>", after the helper\'s mark said in sync', uploading.length > 0 && inT.length > 0 && uploading[0]!.at < firstIn && !!markBefore && pend.length > 0, `uploading at ${uploading.map((l) => hms(l.at)).join(',')}; In Teams first at ${hms(firstIn)}; helper in-sync marks ${ins.map((m) => hms(m.at)).join(',')}; pending marks ${pend.map((m) => hms(m.at)).join(',')}`)
      // OneDrive stopped: the save reaches the VM, the upload does not, and after a minute the header says so.
      if (process.env.SKIP_PAUSE !== '1') {
        if (check('OneDrive in the VM stops for one save (started again after)', stopOneDrive())) {
          await traceLines()
          await typeIn(' paused')
          const local = await until('the paused save in the VM', 120_000, () => words().includes('paused'))
          const late = await until('Not uploaded yet', 150_000, async () => (await saveLine()).includes('Not uploaded to Teams yet'))
          await shot('22-teams-not-uploaded')
          const paused = await linesSeen()
          check('the save reaches the VM, the header says "Saved, uploading to Teams…", and a minute on "Not uploaded to Teams yet." with what to do', local && late && paused.some((l) => l.t.includes('Saved, uploading to Teams')), (await saveLine()))
          const again = startOneDrive()
          const up = await until('In Teams again', 150_000, async () => inTeams(await saveLine()))
          await shot('23-teams-in-teams-again')
          check('OneDrive started again: it uploads, and the header says In Teams', again && up, await saveLine())
          await until('SharePoint\'s rewrite comes down', 30_000, () => rewritten(path))
          await sleep(4000)
        }
      }
      sync.stop()
      // A real change made in the VM: autosave stops, and nothing is written over it.
      const theirs = readFileSync(join(import.meta.dir, '..', 'resources', 'work-templates', 'ref', 'Incident report.docx'))
      await changeThere(path, theirs)
      await sleep(2000)
      await typeIn(' kickoff')
      const halted = await until('the stop', 60_000, async () => stopped(await saveLine()))
      await sleep(6000)
      await shot('24-teams-doc-stopped')
      // (SharePoint may write its parts into their file too: its document part is theirs either way)
      check('a real change made in the VM still stops it: "This file changed in Teams", and the file keeps the change', halted && !words().includes('kickoff') && words() === textOf(partOf(theirs, 'word/document.xml')), await saveLine())
    }
    await closeTabByX(name)
    await sleep(2000)
  }

  // ── a deck and a workbook copy, two sends each ──
  const copyCase = async (kind: 'Deck' | 'Sheet', stemOf: string, ext: string, edit: (n: number) => Promise<void>, holds: (bytes: Buffer | null, n: number) => boolean, shots: string): Promise<void> => {
    if (!(await toFolder())) return
    const n = `${stemOf}${ext}`
    const p = `${dir}\\${n}`
    await press('button', 'New')
    if (!(await press('[role="menuitem"]', kind))) return void check(`New → ${kind} in the Teams folder`, false)
    await until('the name field', 60_000, () => ev<boolean>(`document.activeElement?.tagName === 'INPUT'`))
    await sleep(500)
    await typeKeys(stemOf)
    await key('Enter')
    if (!check(`New → ${kind} makes ${n} in the Teams folder`, await until(n, 90_000, () => listed(dir).includes(n)))) return
    if (!check('it opens from its row', await pressRow(n))) return
    await traceLines()
    let firstSend: Buffer | null = null
    for (const i of [1, 2]) {
      await edit(i)
      const landed = await until(`send ${i}`, 120_000, () => holds(bytesAt(p), i))
      if (i === 1) firstSend = bytesAt(p)
      const told = await until('In Teams', 90_000, async () => inTeams(await saveLine()))
      await shot(`${shots}-${i}`)
      const back = await until('SharePoint\'s rewrite comes down', 30_000, () => rewritten(p))
      await sleep(4000)
      check(`send ${i} of 2: the ${kind === 'Deck' ? 'deck' : 'workbook'} in the Teams folder holds it, the header says In Teams, and SharePoint's rewrite (${back ? 'seen' : 'not seen'}) stops nothing`, landed && told && !stopped(await saveLine()), await saveLine())
    }
    const lines = await linesSeen()
    log(`${kind} header lines: ${lines.map((l) => `${hms(l.at)} ${l.t}`).join(' / ')}`)
    if (firstSend) {
      await changeThere(p, firstSend)
      await sleep(2000)
      await edit(3)
      const halted = await until('the stop', 90_000, async () => stopped(await saveLine()))
      await shot(`${shots}-stopped`)
      check(`a real change made in the VM still stops the ${kind === 'Deck' ? 'deck' : 'workbook'}'s send: the header says it changed, and the file keeps the change`, halted && !holds(bytesAt(p), 3), await saveLine())
    }
    await closeTabByX(n)
    // Its last edit never reached the file (the change made there stopped it): closing asks first, and the dummy's is dropped.
    if (await until('the close question', 5_000, () => ev<boolean>(`!!document.querySelector('[role="alertdialog"]')`))) {
      log(`closing asks: ${await ev<string>(`document.querySelector('[role="alertdialog"]').textContent`)}`)
      await press('[role="alertdialog"] button', 'Discard')
    }
    await sleep(2000)
  }

  // The deck: a box on its slide, words typed, the box left open between sends.
  let boxOpen = false
  await copyCase(
    'Deck',
    `${DECK} teams`,
    '.pptx',
    async (i) => {
      if (!boxOpen) {
        await until('the deck draws', 180_000, () => ev<boolean>(`!!document.querySelector('[data-slides-shapes] [data-shape]')`))
        if (!(await oursShown())) throw new Error("the file shown is not this run's dummy: nothing typed")
        boxOpen = await pickAndOpenBox()
      }
      await typeKeys(` deck${i}x${STAMP.slice(-3)}`)
    },
    (bytes, i) => textOf(partOf(bytes, 'ppt/slides/slide1.xml')).includes(`deck${i}x${STAMP.slice(-3)}`),
    '25-teams-deck'
  )
  // The workbook: a cell a send.
  await copyCase(
    'Sheet',
    `${SHEET} teams`,
    '.xlsx',
    async (i) => {
      const cell = async (): Promise<{ x: number; y: number } | null> =>
        ev(`(() => { const c = [...document.querySelectorAll('[data-sheet-item] canvas')].find((e) => e.getBoundingClientRect().width > 100); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + 78), y: Math.round(r.y + 30) }; })()`)
      await until('the sheet', 180_000, async () => !!(await cell()))
      if (!(await oursShown())) throw new Error("the file shown is not this run's dummy: nothing typed")
      await sleep(1000)
      const at = (await cell())!
      await click(at.x, at.y + (i - 1) * 22)
      await sleep(300)
      await typeKeys(`cell${i}x${STAMP.slice(-3)}`)
      await key('Enter')
    },
    (bytes, i) => textOf(partOf(bytes, 'xl/sharedStrings.xml')).includes(`cell${i}x${STAMP.slice(-3)}`) || textOf(partOf(bytes, 'xl/worksheets/sheet1.xml')).includes(`cell${i}x${STAMP.slice(-3)}`),
    '26-teams-sheet'
  )
  // No Word left open in the VM by this run.
  const word = asUser(`'winword=' + @(Get-Process WINWORD -ErrorAction SilentlyContinue).Count`)
  check('no Word is left open in the VM', word.includes('winword=0'), word)
}
let proofFolder: string | null = null

async function newDocumentCase(): Promise<void> {
  const name = `${WORD} new.docx`
  await toOneDrive()
  if (!check('New → Document makes a Word file in My OneDrive in the VM', await make('Document', `${WORD} new`, '.docx'))) return
  if (!check('it opens from its row', await pressRow(name))) return
  const editor = await until('the document', 180_000, async () => !!(await centre('[data-files-file] [contenteditable="true"]')))
  check('it opens as the Word-backed document', editor, await saveLine())
  const where = box<{ tabs: { itemId?: string; key?: string }[] }>('work.files.tabs', { workspaceId: WS }).tabs.find((t) => t.key?.endsWith(name))
  keptDocs.push(box<{ items: { id: string; source: { path?: string } }[] }>('work.canvas.list', { sessionId: `filespane_${WS}` }).items.find((i) => i.id === where?.itemId)?.source.path ?? '')
  if (!check('the shown file is the new document', await oursShown())) return
  const ed = (await centre('[data-files-file] [contenteditable="true"]'))!
  await click(ed.x, ed.y)
  const three = `Roster ${STAMP.slice(-4)} night`
  await typeKeys(three)
  const landed = await until('the words in the VM', 120_000, () => partOf(bytesInVm(name), 'word/document.xml').includes('night'))
  const asked = await ev<boolean>(`!!document.querySelector('[role="alertdialog"]')`)
  await until('Saved to OneDrive', 30_000, async () => savedLine(await saveLine()))
  await shot('14-new-document-saved')
  check('typed into it, its words reach the .docx in the VM by themselves, with no notice', landed && !asked, await saveLine())
  check('its tab closes by its ×', await closeTabByX(name))
  await sleep(3000)
  await toOneDrive()
  check('closed and opened again: the same document, with his words', (await pressRow(name)) && (await until('his words', 120_000, async () => (await docText()).includes(three))))
  await closeTabByX(name)
}
const keptDocs: string[] = []

const cleanup = async (): Promise<void> => {
  // OneDrive in the VM is never left stopped by this run.
  if (oneDriveExe && !startOneDrive()) log('OneDrive in the VM did not start again: start it there')
  forward?.kill()
  // Every tab this run opened in his workspace goes; anything it made in the VM goes to its Recycle Bin.
  try {
    for (const t of tabsOfWs()) if (!before.has(t.id)) box('work.files.tabClose', { workspaceId: WS, tabId: t.id })
  } catch (err) {
    log(`tabs left: ${err}`)
  }
  // Save as Word's new file, and the Teams proof folder with what is in it.
  for (const name of keptExtra) {
    try {
      box('work.files.trash', { workspaceId: WS, refs: [{ at: 'file', host: boxId, path: guest(name) }], op: crypto.randomUUID(), asked: true })
    } catch (err) {
      log(`could not delete ${name}: ${String(err).slice(0, 200)}`)
    }
  }
  if (proofFolder) {
    try {
      box('work.files.trash', { workspaceId: WS, refs: [{ at: 'file', host: boxId, path: proofFolder }], op: crypto.randomUUID(), asked: true })
      log('the Teams proof folder is in the Recycle Bin')
    } catch (err) {
      log(`could not delete the Teams proof folder: ${String(err).slice(0, 200)}`)
    }
  }
  for (const name of failures && process.env.KEEP_ON_FAIL === '1' ? [] : [`${DECK}.pptx`, `${SHEET}.xlsx`, `${WORD}.docx`, `${WORD} (mine).docx`, `${WORD} new.docx`]) {
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
  // The workspace's folder last, with the window gone: a tab closing as it went writes its document there.
  for (const doc of keptDocs) {
    try {
      // The run's own document, removed outright: nothing of it is left in his workspace's folder or its Trash.
      if (doc.startsWith('/srv/agents/work/Work/Purdue/TempCode proof ')) rmSync(doc, { force: true })
    } catch (err) {
      log(`could not remove ${doc}: ${String(err).slice(0, 200)}`)
    }
  }
  // The Word file as it was, kept before the first write over it: the run's own, removed too.
  for (const n of readdirSync('/srv/agents/work/Work/Purdue')) {
    try {
      if (n.startsWith(`TempCode proof ${STAMP}`)) rmSync(join('/srv/agents/work/Work/Purdue', n), { force: true })
    } catch (err) {
      log(`could not delete ${n}: ${String(err).slice(0, 200)}`)
    }
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
  if (process.env.SKIP_DECK === '1') {
    // (the deck is proven on 367)
  } else if (process.env.SKIP_DECK_TYPING === '1') {
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
  if (process.env.SKIP_SHEET !== '1' && check(`New → Sheet named "${SHEET}" lies in the VM`, await make('Sheet', SHEET, '.xlsx'))) {
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
      const kept = await until('the VM workbook holds the value', 60_000, () => sheetHolds(value))
      await until('saved line', 20_000, async () => (await saveLine()).startsWith('saved'))
      await shot('4-sheet-saved')
      // The dummy's own strings, as the VM holds them (a value typed may lie in several rich text runs).
      if (!kept) log(`the dummy workbook's strings in the VM: ${partOf(bytesInVm(`${SHEET}.xlsx`), 'xl/sharedStrings.xml').slice(0, 1200)}`)
      check('A1 typed and Return: the workbook in the VM holds the value, the header says saved', kept && /^saved \| Saved to .*\d/.test(await saveLine()), await saveLine())
      // A second cell, and the tab closed by its × at once.
      await click(at.x, at.y + 22)
      await sleep(300)
      const second = `Second ${STAMP.slice(-4)}`
      await typeKeys(second)
      await key('Enter')
      await closeTabByX(`${SHEET}.xlsx`)
      const closed = await until('the VM workbook holds the second value', 60_000, () => sheetHolds(second))
      check('a second cell, then the tab closed by its × at once: the workbook in the VM holds it', closed, `toasts ${JSON.stringify(await toasts())}`)
      // The same workbook again, now one that was already there: a third cell.
      await until('the folder', 20_000, async () => !!(await centre('[data-files-row]')))
      if (check('the workbook, now an existing one, opens from its row again', await pressRow(`${SHEET}.xlsx`)) && (await until('the sheet', 180_000, async () => !!(await a1())))) {
        await sleep(1500)
        const again = (await a1())!
        await click(again.x, again.y + 40)
        await sleep(300)
        const third = `Third ${STAMP.slice(-4)}`
        await typeKeys(third)
        await key('Enter')
        const held = await until('the VM workbook holds the third value', 60_000, () => sheetHolds(third))
        await until('saved line', 20_000, async () => (await saveLine()).startsWith('saved'))
        check('A3 typed in the existing workbook: the workbook in the VM holds all three values, the header says saved', held && sheetHolds(value) && sheetHolds(second) && (await saveLine()).startsWith('saved'), await saveLine())
        await closeTabByX(`${SHEET}.xlsx`)
      }
    }
  }

  // 4. A Word file: a dummy .docx put in the folder by the guest's own helper (New offers no Word file in the VM).
  if (process.env.WORD !== '0') {
    if (process.env.SKIP_MINE === '1') check("this run's forward to the VM's helper opens (the VM is awake)", await openForward())
    else {
      await wordCase()
      await newDocumentCase()
    }
    if (process.env.SKIP_TEAMS !== '1') await teamsDocumentCase()
  }

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
