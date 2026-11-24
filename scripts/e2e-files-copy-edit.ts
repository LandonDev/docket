/**
 * His hand edits to a Teams file opened from another computer reach that file (.temp-code/plans/landed/F-edits-lost.md):
 * the owner's loss of 2026-11-23, a deck he made in a Teams library and edited in a Files tab, whose edits never left
 * the copy and went with its tab.
 *
 * Two isolated instances of the BUILT tree under xvfb, each with its own HOME, userData and ports, set up as his Mac
 * and his box are: "mac" is windowed and holds a dummy Teams library under its own HOME (Library/CloudStorage); "box"
 * is headless and hosts a Work workspace that copies Teams files and may use mac's desktop. mac's window reaches box
 * over a saved link with a client key minted for the run (revoked at the end), as his Mac's window reaches the real
 * box, so every file below opens in box's workspace as a copy of mac's file (`openCopy`). Then, by hand in mac's
 * window with real pointer and key events over CDP:
 *  1. the rail's workspace, its Files view, the library and its channel
 *  2. a deck from its row: a shape on the stage clicked, then Delete; mac's file loses it within seconds, the header
 *     says so
 *  3. a workbook: A1 typed, Return; mac's file holds the value
 *  4. a text file: words typed; mac's file holds them
 *  5. a deck MADE there from New → Deck and named in place, opened from its row, a shape deleted: mac's file loses it
 *  6. each tab closed: nothing waits, mac's files keep his edits, no copy record is left
 *  7. a copy whose computer stops answering (mac's bridge set to off): an edit says it waits, the tab's close asks
 *     before anything is dropped, and Keep trying sends it once mac answers again
 * Pictures of the window go to the out folder.
 *
 * Run (repo root, after `bunx electron-vite build`; on the box through the heavy queue):
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-files-copy-edit.ts [--out <dir>]
 * TC_E2E_KEEP=1 leaves the run's folder. Dummy files only; nothing here touches /Applications, a real HOME, a sign-in
 * or the box's live service; it stops only the process groups it started.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { E2E_APP_TOKEN_SEED, withAppToken } from './lib/appToken'
import { attach, type Cdp } from './lib/packagedApp'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_E2E_KEEP === '1'
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
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

const root = Bun.spawnSync(['realpath', mkdtempSync(join(tmpdir(), 'tc-copy-edit-'))]).stdout.toString().trim()
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

// mac's Teams library, dummy files only.
const cloud = join(mac.home, 'Library', 'CloudStorage')
const general = join(cloud, 'OneDrive-SharedLibraries-Dummy U', 'Esports Staff - Documents', 'General')
mkdirSync(general, { recursive: true })
mkdirSync(join(cloud, 'OneDrive-Dummy U'), { recursive: true })
const files = { deck: join(general, 'Kickoff.pptx'), sheet: join(general, 'Roster.xlsx'), text: join(general, 'Notes.txt') }
copyFileSync(join(REPO, 'src/main/server/work/slides/fixtures/kinds.pptx'), files.deck)
copyFileSync(join(REPO, 'src/main/server/work/sheets/harness/corpus/formulas.xlsx'), files.sheet)
writeFileSync(files.text, 'Notes\n')
// box draws decks with the host's own work tools (python-pptx, LibreOffice): each folder linked, the run keeps its own jobs.
const TOOLS = process.env.E2E_WORK_TOOLS ?? '/srv/agents/temp-code-data/work-tools'
if (existsSync(join(TOOLS, 'state.json'))) {
  const mine = join(box.data, 'work-tools')
  mkdirSync(mine, { recursive: true })
  for (const name of readdirSync(TOOLS)) {
    if (['jobs', 'run', 'downloads'].includes(name)) mkdirSync(join(mine, name), { recursive: true })
    else if (name === 'state.json') writeFileSync(join(mine, name), readFileSync(join(TOOLS, name)))
    else symlinkSync(join(TOOLS, name), join(mine, name))
  }
}

function launch(inst: Inst, windowed: boolean): void {
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
    SHELL: '/bin/bash'
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
async function click(x: number, y: number, count = 1): Promise<void> {
  await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (let c = 1; c <= count; c++) {
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: c })
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: c })
  }
}
const centre = (selector: string, text?: string): Promise<{ x: number; y: number } | null> =>
  ev(
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].reverse().find((e) => ${text === undefined ? 'true' : `e.textContent.trim() === ${JSON.stringify(text)}`} && e.getClientRects().length); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`
  )
async function press(selector: string, text: string | undefined, count = 1, ms = 20_000): Promise<boolean> {
  let at: { x: number; y: number } | null = null
  await until(`${selector} ${text ?? ''}`, ms, async () => !!(at = await centre(selector, text)))
  if (!at) return false
  await click(at.x, at.y, count)
  return true
}
async function typeKeys(text: string): Promise<void> {
  for (const ch of text) {
    const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : ch === ' ' ? 'Space' : ''
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
  }
}
async function enter(): Promise<void> {
  const def = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...def, text: '\r' })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', ...def })
}
const saveLine = (): Promise<string> => ev(`(() => { const p = [...document.querySelectorAll('[data-files-save-line]')].find((e) => e.getClientRects().length); return p ? p.dataset.filesSaveLine + ' | ' + p.textContent : '(none)' })()`)
const toasts = (): Promise<string[]> => ev(`[...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim())`)
/** A row of the list by the name it shows (a key of another host's library is no path of this one). */
const rowAt = (name: string): Promise<{ x: number; y: number } | null> =>
  ev(`(() => { const el = [...document.querySelectorAll('[data-files-row]')].find((e) => e.getClientRects().length && [...e.querySelectorAll('*')].some((c) => c.childElementCount === 0 && c.textContent.trim() === ${JSON.stringify(name)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(160, r.width / 2)), y: Math.round(r.y + r.height / 2) }; })()`)
async function openRow(name: string): Promise<boolean> {
  let at: { x: number; y: number } | null = null
  await until(`the row ${name}`, 30_000, async () => !!(at = await rowAt(name)))
  if (!at) return false
  await click(at.x, at.y, 2)
  return true
}
const unzip = (file: string, part: string): string => Bun.spawnSync(['unzip', '-p', file, part]).stdout.toString()
const holdsWord = (file: string, word: string): boolean => unzip(file, 'xl/sharedStrings.xml').includes(word) || unzip(file, 'xl/worksheets/sheet1.xml').includes(word)
type Back = { is: string; at?: number; detail?: string }
type TabRow = { id: string; name: string; kind: string; copyOf?: { host: string; path: string }; back?: Back }

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
  if (keyId) await rpc(box, 'remote.keys.revoke', { id: keyId }).catch(() => undefined)
  for (const inst of [mac, box]) if (inst.proc?.pid) process.kill(-inst.proc.pid, 'SIGTERM')
  await sleep(1500)
  for (const inst of [mac, box]) stop(inst)
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

launch(mac, true)
launch(box, false)
try {
  cdp = await attach(mac.debug, 180_000)
  await cdp.send('Page.enable')
  ports.set('mac', (await cdp.eval<number | null>('window.api.getServerPort()')) ?? 0)
  const up = ports.get('mac')! > 0 && (await until('box up', 120_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both instances are up', up)) throw new Error(`no local port; logs ${mac.log} ${box.log}`)
  const macId = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  const boxId = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  log(`mac ${macId}, box ${boxId}; logs ${mac.log} ${box.log}; pictures ${out}`)
  await rpc(mac, 'work.set', { enabled: true })
  await rpc(box, 'work.set', { enabled: true })
  const ws = await rpc<{ id: string; path: string }>(box, 'workspace.create', { kind: 'work', sector: 'purdue', name: 'Proof Esports' })
  await rpc(box, 'work.office.filesCopySet', { workspaceId: ws.id, on: true })
  await rpc(box, 'work.workspace.set', { workspaceId: ws.id, patch: { mayUseDesktop: [macId] } })
  const key = await rpc<{ token: string; id?: string; key?: { id: string } }>(box, 'remote.keys.create', { name: 'copy edit (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  keyId = key.id ?? key.key?.id ?? null
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  const registered = await until('mac registers on box', 90_000, async () => (await rpc<{ environmentId: string; registered: boolean }[]>(mac, 'macBridge.policy.get')).some((p) => p.environmentId === boxId && p.registered))
  check("mac's link registered on box", registered)
  // As his Mac lets the box run its Files verbs: a copy's bytes go back through work.files.writeBack.
  await rpc(mac, 'macBridge.policy.set', { environmentId: boxId, policy: 'read+run' })
  await cdp.eval('window.__monocode.loadSavedEnvironments()')
  const linked = await until('window reaches box', 60_000, () => cdp!.eval<boolean>(`window.__monocode.registry.has(${JSON.stringify(boxId)}) && window.__monocode.registry.statusOf(${JSON.stringify(boxId)}).transport === 'open'`))
  if (!check("mac's window reaches box", linked)) throw new Error('no link')
  const fromWindow = <T>(method: string, params: unknown): Promise<T> => ev<T>(`window.__monocode.registry.linkOf(${JSON.stringify(boxId)}).request(${JSON.stringify(method)}, ${JSON.stringify(params)})`)
  const tabs = (): Promise<TabRow[]> => fromWindow<{ tabs: TabRow[] }>('work.files.tabs', { workspaceId: ws.id }).then((t) => t.tabs)
  const tabNamed = async (name: string): Promise<TabRow | undefined> => (await tabs()).find((t) => t.name === name)
  const copies = async (): Promise<number> => (await tabs()).filter((t) => t.back).length

  // 1. The rail's workspace, its Files view, the library and its channel.
  check("the rail shows box's workspace and it opens", await press('button, a, [role="button"], [role="treeitem"], [role="link"], div', 'Proof Esports', 1, 60_000))
  check('its Files view opens', await press('button, a, [role="button"], [role="link"], div', 'Files'))
  await shot('0-files')
  const toLibrary = async (): Promise<boolean> => {
    if (!(await press('button, a, [role="button"], [role="link"], div', 'Esports Staff', 1, 60_000))) return false
    if (await until('the files', 8_000, async () => !!(await rowAt('Kickoff.pptx')))) return true
    await openRow('General')
    return until('the files', 30_000, async () => !!(await rowAt('Kickoff.pptx')))
  }
  if (!check("mac's library and its channel list the dummy files", await toLibrary())) throw new Error('no library')
  await shot('1-library')

  const libraryTab = async (): Promise<void> => {
    // The page tab that shows the library: the first tab on the row.
    await ev(`document.querySelector('[role="tab"]')?.click()`)
    await until('the rows', 20_000, async () => !!(await centre('[data-files-row]')))
  }
  const closeTab = async (name: string): Promise<void> => {
    await ev(`document.querySelector('[data-files-tab-close][aria-label=${JSON.stringify(`Close ${name}`)}]')?.click()`)
  }
  /** A line that says his changes are in the file there, by the computer's own name. */
  const savedThere = async (): Promise<boolean> => /Saved to /.test(await saveLine())

  // 2. A deck: a shape clicked on the stage, then Delete.
  const deckCase = async (tag: string, file: string, name: string): Promise<void> => {
    check(`${tag}: a double-click on its row opens it in a Files tab`, await openRow(name))
    const drawn = await until('the deck draws', 90_000, () => ev<boolean>(`!!document.querySelector('[data-slides-shapes] [data-shape]')`))
    await shot(`${tag}-1-opened`)
    if (!check(`${tag}: the deck editor draws it`, drawn, await saveLine())) return
    const tab = await tabNamed(name)
    check(`${tag}: it is a copy that saves back`, !!tab?.copyOf && tab.back?.is === 'ok', JSON.stringify(tab))
    log(`${tag}: header before: ${await saveLine()}`)
    // A shape on the stage picked by a click, then Delete: one of his edits, by hand.
    const shapes = (): number => (unzip(file, 'ppt/slides/slide1.xml').match(/<p:sp>|<p:sp |<p:graphicFrame|<p:cxnSp/g) ?? []).length
    const had = shapes()
    // A press on the slide where a shape lies picks it (the layer hit-tests by the shapes' corners).
    let picked = false
    for (const [fx, fy] of [[0.13, 0.46], [0.5, 0.3], [0.5, 0.55], [0.3, 0.2]] as const) {
      const box = await ev<{ x: number; y: number; w: number; h: number } | null>(`(() => { const l = document.querySelector('[data-slides-shapes]'); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`)
      if (!box) break
      await click(Math.round(box.x + box.w * fx), Math.round(box.y + box.h * fy))
      if (await until('a shape is picked', 2_000, () => ev<boolean>(`!!document.querySelector('[data-shape][aria-pressed="true"]')`))) {
        picked = true
        break
      }
    }
    check(`${tag}: a shape on the stage is picked by a click`, picked)
    await sleep(400)
    await cdp!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
    const landed = await until("mac's file loses the shape", 20_000, () => shapes() === had - 1)
    check(`${tag}: within seconds mac's file holds the edit`, landed, `${had} → ${shapes()} shapes; header "${await saveLine()}"; toasts ${JSON.stringify(await toasts())}; tab ${JSON.stringify(await tabNamed(name))}`)
    check(`${tag}: the header says it is saved there, with the time`, await until('the line says saved there', 10_000, savedThere), await saveLine())
    await shot(`${tag}-2-edited`)
  }
  await deckCase('deck', files.deck, 'Kickoff.pptx')

  // 3. A workbook: A1 typed, Return.
  await libraryTab()
  {
    const tag = 'sheet'
    check(`${tag}: a double-click on its row opens it`, await openRow('Roster.xlsx'))
    const cellA1 = async (): Promise<{ x: number; y: number } | null> =>
      ev(`(() => { const c = [...document.querySelectorAll('[data-sheet-item] canvas')].find((e) => e.getBoundingClientRect().width > 100); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + 78), y: Math.round(r.y + 30) }; })()`)
    if (check(`${tag}: the sheet draws`, await until('the sheet', 60_000, async () => !!(await cellA1())))) {
      await sleep(1500)
      const a1 = (await cellA1())!
      await click(a1.x, a1.y)
      await sleep(300)
      const value = `Hand ${Date.now() % 100000}`
      await typeKeys(value)
      await enter()
      const landed = await until("mac's file holds the value", 20_000, () => holdsWord(files.sheet, value))
      check(`${tag}: within seconds mac's workbook holds the typed value`, landed, `header "${await saveLine()}"; toasts ${JSON.stringify(await toasts())}; tab ${JSON.stringify(await tabNamed('Roster.xlsx'))}`)
      check(`${tag}: the header says it is saved there`, await until('saved there', 10_000, savedThere), await saveLine())
      await shot(`${tag}-2-edited`)
    }
  }

  // 4. A text file: words typed.
  await libraryTab()
  {
    const tag = 'text'
    check(`${tag}: a double-click on its row opens it`, await openRow('Notes.txt'))
    const editor = async (): Promise<{ x: number; y: number } | null> => centre('[data-files-file] .cm-content, [data-files-file] textarea, [data-files-file] [contenteditable="true"]')
    const drawn = await until('the editor', 30_000, async () => !!(await editor()))
    await shot(`${tag}-1-opened`)
    if (check(`${tag}: its editor draws`, drawn, await saveLine())) {
      const at = (await editor())!
      await click(at.x, at.y)
      await ev(`(() => { const el = document.activeElement; if (el && 'selectionStart' in el) { el.selectionStart = el.selectionEnd = el.value.length } })()`)
      const words = `doors at ${Date.now() % 1000}`
      await typeKeys(words)
      const landed = await until("mac's file holds the words", 20_000, () => readFileSync(files.text, 'utf8').includes(words))
      check(`${tag}: within seconds mac's text file holds the typed words`, landed, `file ${JSON.stringify(readFileSync(files.text, 'utf8'))}; header "${await saveLine()}"; toasts ${JSON.stringify(await toasts())}`)
      check(`${tag}: the header says it is saved there`, await until('saved there', 10_000, savedThere), await saveLine())
      await shot(`${tag}-2-edited`)
    }
  }

  // 5. A deck made there from New → Deck, then opened and edited.
  await libraryTab()
  {
    const tag = 'made'
    check(`${tag}: New opens its menu`, await press('button', 'New'))
    check(`${tag}: Deck makes one`, await press('[role="menuitem"]', 'Deck'))
    const made = await until('a new deck on mac', 30_000, () => readdirSync(general).some((n) => /^Untitled.*\.pptx$/i.test(n)))
    const name = readdirSync(general).find((n) => /^Untitled.*\.pptx$/i.test(n)) ?? ''
    if (check(`${tag}: the deck is made in mac's library`, made, readdirSync(general).join(', '))) {
      // He names it in place, as he named his.
      await sleep(1500)
      await typeKeys('Testing')
      await enter()
      const named = await until('the deck is renamed on mac', 30_000, () => existsSync(join(general, 'Testing.pptx')))
      check(`${tag}: named Testing.pptx in place`, named, readdirSync(general).join(', '))
      await sleep(800)
      await deckCase(tag, join(general, 'Testing.pptx'), 'Testing.pptx')
      // His words typed into a box on the slide, and the tab closed while the box is still open: by its ×, then by the
      // close key. The words reach mac's file either way.
      for (const how of ['the ×', 'the menu'] as const) {
        const file = join(general, 'Testing.pptx')
        const words = `Kickoff ${how === 'the ×' ? 'one' : 'two'} ${Date.now() % 1000}`
        if (await tabNamed('Testing.pptx')) await press('[role="tab"]', 'Testing.pptx')
        else {
          await libraryTab()
          await openRow('Testing.pptx')
        }
        await until('the deck draws', 60_000, () => ev<boolean>(`!!document.querySelector('[data-slides-shapes] [data-shape]')`))
        await sleep(800)
        let typing = false
        for (const [fx, fy] of [[0.5, 0.3], [0.5, 0.55], [0.5, 0.7], [0.13, 0.46]] as const) {
          const box = await ev<{ x: number; y: number; w: number; h: number } | null>(`(() => { const l = document.querySelector('[data-slides-shapes]'); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`)
          if (!box) break
          await click(Math.round(box.x + box.w * fx), Math.round(box.y + box.h * fy))
          if (!(await until('a shape is picked', 2_000, () => ev<boolean>(`!!document.querySelector('[data-shape][aria-pressed="true"]')`)))) continue
          await enter()
          if ((typing = await until('the box opens', 3_000, () => ev<boolean>(`!!document.querySelector('[data-slide-typing][data-phase="typing"]')`)))) break
        }
        if (!check(`${tag}: a box on the slide opens for his words (${how})`, typing)) continue
        await typeKeys(words)
        await sleep(300)
        await shot(`${tag}-typed-${how === 'the ×' ? 'x' : 'key'}`)
        log(`${tag}: header with the box open: ${await saveLine()}`)
        if (how === 'the ×') await closeTab('Testing.pptx')
        else {
          await press('button[aria-label="More for Testing.pptx"]', undefined)
          // The row reads "Close Tab" and its key.
          const row = await until('Close Tab', 5_000, () => ev<boolean>(`!![...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim().startsWith('Close Tab'))`))
          const at = row ? await ev<{ x: number; y: number }>(`(() => { const r = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim().startsWith('Close Tab')).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`) : null
          if (at) await click(at.x, at.y)
        }
        await until('the tab goes', 10_000, async () => !(await tabNamed('Testing.pptx')))
        const kept = await until("mac's deck holds his words", 30_000, () => unzip(file, 'ppt/slides/slide1.xml').includes(words))
        check(`${tag}: words typed and the tab closed by ${how} reach mac's file`, kept, `tab left: ${JSON.stringify(await tabNamed('Testing.pptx'))}; copies on box: ${await copies()}`)
      }
    }
  }

  // 6. Each tab closed: nothing waits, mac's files keep his edits, no copy is left.
  // Sends under way land first: a close while one is still on its way asks, as it should.
  await until('every send has landed', 30_000, async () => (await tabs()).every((t) => !t.back || t.back.is === 'ok'))
  const kept = { deck: Bun.file(files.deck).size, sheet: readFileSync(files.sheet), text: readFileSync(files.text, 'utf8') }
  for (const t of await tabs()) if (t.kind === 'file') await closeTab(t.name)
  await sleep(500)
  const asked = await ev<boolean>('!!document.querySelector(\'[role="alertdialog"]\')')
  check('closing tabs whose changes all landed asks nothing', !asked)
  await sleep(5000)
  check("after the close mac's files still hold his edits", Bun.file(files.deck).size === kept.deck && readFileSync(files.sheet).equals(kept.sheet) && readFileSync(files.text, 'utf8') === kept.text)
  check('and no copy is left on box', (await copies()) === 0 && !existsSync(join(box.data, 'attachments', 'teams-files', `filespane_${ws.id}`)) || readdirSync(join(box.data, 'attachments', 'teams-files', `filespane_${ws.id}`)).length === 0)

  // 7. mac stops answering: the edit waits, its close asks, and Keep trying sends it once mac answers.
  await libraryTab()
  {
    const tag = 'away'
    check(`${tag}: the text file opens again`, await openRow('Notes.txt'))
    const editor = async (): Promise<{ x: number; y: number } | null> => centre('[data-files-file] .cm-content, [data-files-file] textarea, [data-files-file] [contenteditable="true"]')
    if (await until('the editor', 30_000, async () => !!(await editor()))) {
      await rpc(mac, 'macBridge.policy.set', { environmentId: boxId, policy: 'off' })
      const at = (await editor())!
      await click(at.x, at.y)
      const words = ` waits ${Date.now() % 1000}`
      await typeKeys(words)
      const waiting = await until('the line says it waits or refused', 30_000, async () => /not answering|refused/i.test(await saveLine()))
      check(`${tag}: the header says the changes have not reached mac, never saved`, waiting && !(await savedThere()), await saveLine())
      check(`${tag}: mac's file is as it was`, !readFileSync(files.text, 'utf8').includes(words.trim()))
      await shot(`${tag}-1-waiting`)
      await closeTab('Notes.txt')
      const dialog = await until('the close asks', 10_000, () => ev<boolean>('!!document.querySelector(\'[role="alertdialog"]\')'))
      check(`${tag}: closing it asks before anything is dropped`, dialog, await ev<string>(`document.querySelector('[role="alertdialog"]')?.textContent ?? ''`))
      await shot(`${tag}-2-asked`)
      const keepWord = await ev<string>(`[...document.querySelectorAll('[role="alertdialog"] button')].map((b) => b.textContent.trim()).join(' / ')`)
      log(`${tag}: the close offers ${keepWord}`)
      await press('[role="alertdialog"] button', 'Keep trying') || (await press('[role="alertdialog"] button', 'Keep Both'))
      await rpc(mac, 'macBridge.policy.set', { environmentId: boxId, policy: 'read+run' })
      const sent = await until("mac's file holds the words once it answers", 90_000, () => readFileSync(files.text, 'utf8').includes(words.trim()))
      check(`${tag}: Keep trying sends them once mac answers again`, sent, JSON.stringify(readFileSync(files.text, 'utf8')))
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
