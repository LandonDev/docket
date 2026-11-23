/**
 * Opening Teams files from a desktop's window into a Work workspace on the box, one after another
 * (.temp-code/plans/landed/F-files-refused.md): the owner's fault of 2026-11-23, "forbidden:
 * work.office.filesCopy is outside app-managed roots" on every open after the first.
 *
 * Two isolated instances of the BUILT tree under xvfb, each with its own HOME, userData and ports:
 * "mac" is a windowed instance with a dummy OneDrive under its own HOME (Library/CloudStorage),
 * "box" a headless one with a Work workspace whose copy switch is on and which may use mac's desktop.
 * mac saves box with a client key minted for the run (every capability, as his Mac's own key: its link registers the Mac bridge; revoked at the end), so
 * mac's window reaches box as a remote key, as his Mac's window reaches the real box. Every request
 * below goes out on that window's own link (`window.__monocode.registry`). Two routes are proven:
 *
 * The route before tabs, where the workspace's host keeps none, in the order the window makes its requests
 * (src/renderer/src/work/files/open.ts `openEntry`):
 * `work.office.filesThreads` (a thread that holds the file already shows it again), else
 * `session.create`, `work.office.filesCopy` (box fetches the bytes from mac over the host link) and
 * `work.canvas.open`.
 *  - a deck, a PDF and a picture open one after another, each in its own thread with a copy
 *  - the deck again opens the deck's first thread, made no new one
 *
 * The Files place's route: one `work.files.open` to the workspace's host, which makes the same copy in a
 * tab of its own with no thread.
 *  - a deck, a PDF and a sheet open one after another, each in its tab; the deck again is its own tab
 *  - the deck the first route's thread holds opens in a tab of its own too (a copy keeps its own marks)
 *  - no thread is made, and the Files verbs that name mac's file pass the fence
 *  - a path of box's own disk outside its roots stays refused at the fence, by its own host or by a
 *    claim of another host's; a Windows guest path still passes the fence (and box, with no VM, refuses it)
 *
 * A copy saves back (docs/agents/work-files.md "A copy saves back"), once mac's bridge lets box run (read+run):
 *  - a workbook and a text file of mac's library open as copies in tabs; each copy's bytes changed as the owner's
 *    save leaves them, then `work.files.copyBack` as the window asks it: mac's file holds the new bytes and the tab
 *    says when its file took them
 *  - mac's file changed behind the copy's back: the send is the conflict and mac's file is left as it was; Keep Both
 *    puts his bytes beside it as "Roster (mine).xlsx" and the tab shows that file; Reload reads mac's file back in
 *  - a read key is refused, and so is a thread's own idea on the copy (sheets_write), mac's file untouched
 *
 * Run: env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-files-open-remote.ts   (electron-vite build first)
 * Dummy files only. Nothing here touches /Applications/TempCode.app, a real HOME or the box's live service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { teamsCanvasOf } from '../src/shared/contract-work-office'
import { E2E_APP_TOKEN_SEED, withAppToken } from './lib/appToken'
import { attach, type Cdp } from './lib/packagedApp'

const REPO = resolve(import.meta.dir, '..')
/** box's Work token key, so this script calls a thread's tools as its bridge does (work/ctx.ts `TEMP_CODE_WORK_TOKEN_SEED`). */
const WORK_SEED = randomBytes(32).toString('hex')
const workToken = (sessionId: string): string => createHmac('sha256', Buffer.from(WORK_SEED, 'hex')).update(sessionId).digest('base64url')
const KEEP = process.env.TC_E2E_KEEP === '1'
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('out/main is missing: run electron-vite build first')
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

const root = Bun.spawnSync(['realpath', mkdtempSync(join(tmpdir(), 'tc-files-open-e2e-'))]).stdout.toString().trim()
type Inst = { name: string; home: string; data: string; tmp: string; work: string; remote: number; debug: number; log: string; proc?: ChildProcess }
const mk = async (name: string): Promise<Inst> => {
  const home = join(root, `${name}-home`)
  const inst = { name, home, data: join(root, `${name}-data`), tmp: join(root, `${name}-tmp`), work: join(home, 'work'), remote: await freePort(), debug: await freePort(), log: join(root, `${name}.log`) }
  for (const d of [inst.home, inst.data, inst.tmp, inst.work]) mkdirSync(d, { recursive: true })
  return inst
}
const mac = await mk('mac')
const box = await mk('box')

// mac's OneDrive: his own files and one library synced from Teams, dummy files only.
const cloud = join(mac.home, 'Library', 'CloudStorage')
const library = join(cloud, 'OneDrive-dummy.edu-Team-Docs')
mkdirSync(join(cloud, 'OneDrive-dummy.edu'), { recursive: true })
mkdirSync(join(library, 'General'), { recursive: true })
const files = {
  deck: join(library, 'General', 'Kickoff.pptx'),
  pdf: join(library, 'General', 'Budget.pdf'),
  picture: join(library, 'General', 'Court.png'),
  sheet: join(library, 'General', 'Travel.xlsx'),
  // The Files place's own: files no thread holds (a deck or a PDF a thread holds opens in that thread, by its marks).
  deck2: join(library, 'General', 'Agenda.pptx'),
  pdf2: join(library, 'General', 'Rules.pdf')
}
writeFileSync(files.sheet, Buffer.from('PK\u0003\u0004dummy sheet'))
writeFileSync(files.deck, Buffer.from('PK\u0003\u0004dummy deck'))
writeFileSync(files.deck2, Buffer.from('PK\u0003\u0004dummy deck two'))
writeFileSync(files.pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
writeFileSync(files.pdf2, '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
// a 1×1 PNG
writeFileSync(files.picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

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
    TEMP_CODE_WORK_TOKEN_SEED: WORK_SEED,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
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
    await sleep(300)
  }
  log(`timed out: ${label}`)
  return false
}
/** A headless instance writes its local port to server.json; a windowed one hands it to its window (`window.api.getServerPort`). */
const ports = new Map<string, number>()
const portOf = (inst: Inst): number => ports.get(inst.name) ?? (JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }).port

/** One request on the instance's local socket (the implicit admin). */
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
/** One request from mac's window to box, on the window's own link: a remote key's request, as his Mac makes it. */
async function fromWindow<T>(boxId: string, method: string, params: unknown): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return cdp!.eval(
    `window.__monocode.registry.linkOf(${JSON.stringify(boxId)}).request(${JSON.stringify(method)}, ${JSON.stringify(params)}).then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: String(e && e.message || e) }))`
  )
}

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
  if (keyId) await rpc(box, 'remote.keys.revoke', { id: keyId }).then(() => log('the run key is revoked'), () => log('could not revoke the run key (box is gone with it)'))
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
  cdp = await attach(mac.debug, 120_000)
  ports.set('mac', (await cdp.eval<number | null>('window.api.getServerPort()')) ?? 0)
  const up = ports.get('mac')! > 0 && (await until('box up', 120_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both instances published their local socket', up)) throw new Error(`no local port; logs ${mac.log} ${box.log}`)
  const macId = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  const boxId = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  log(`mac ${macId}, box ${boxId}; logs ${mac.log} ${box.log}`)
  await rpc(mac, 'work.set', { enabled: true })
  await rpc(box, 'work.set', { enabled: true })

  // box: a Work workspace that copies Teams files and may use mac's desktop.
  const ws = await rpc<{ id: string; path: string }>(box, 'workspace.create', { kind: 'work', sector: 'purdue', name: 'E2E files open' })
  await rpc(box, 'work.office.filesCopySet', { workspaceId: ws.id, on: true })
  await rpc(box, 'work.workspace.set', { workspaceId: ws.id, patch: { mayUseDesktop: [macId] } })

  // Pair: box mints a client key for the run; mac saves box with it and lets it read.
  const key = await rpc<{ token: string; id?: string; key?: { id: string } }>(box, 'remote.keys.create', { name: 'files open (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  keyId = key.id ?? key.key?.id ?? null
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  const registered = await until('mac registers on box', 90_000, async () => (await rpc<{ environmentId: string; registered: boolean }[]>(mac, 'macBridge.policy.get')).some((p) => p.environmentId === boxId && p.registered))
  check("mac's link registered on box", registered)
  await rpc(mac, 'macBridge.policy.set', { environmentId: boxId, policy: 'read' })

  await cdp.eval('window.__monocode.loadSavedEnvironments()')
  const linked = await until('window reaches box', 60_000, () => cdp!.eval<boolean>(`window.__monocode.registry.has(${JSON.stringify(boxId)}) && window.__monocode.registry.statusOf(${JSON.stringify(boxId)}).transport === 'open'`))
  if (!check("mac's window reaches box over its saved link (a remote key there)", linked)) throw new Error('no link')

  const libs = await rpc<{ host: string; libraries: { id: string; path: string }[] }>(mac, 'work.office.filesLibraries', {})
  check("mac lists the dummy library as a Teams library", libs.libraries.some((l) => l.path === library), JSON.stringify(libs.libraries.map((l) => l.path)))

  /** The Files view's open, request for request, for a file of mac's library. */
  const open = async (path: string): Promise<{ sessionId?: string; reused?: boolean; error?: string; held?: string }> => {
    const source = { at: 'file' as const, host: macId, path }
    const held = await fromWindow<{ threads: { sessionId: string; itemId: string }[] }>(boxId, 'work.office.filesThreads', { workspaceId: ws.id, source })
    if (held.ok && held.value.threads[0]) {
      const again = await fromWindow(boxId, 'work.canvas.open', { sessionId: held.value.threads[0].sessionId, itemId: held.value.threads[0].itemId })
      return again.ok ? { sessionId: held.value.threads[0].sessionId, reused: true } : { error: again.error }
    }
    const made = await fromWindow<{ id: string }>(boxId, 'session.create', { workspaceId: ws.id, cwd: ws.path, threadType: 'chat', title: path.slice(path.lastIndexOf('/') + 1) })
    if (!made.ok) return { error: made.error }
    const copy = await fromWindow<{ source: { at: 'file'; host: string; path: string } }>(boxId, 'work.office.filesCopy', { sessionId: made.value.id, source })
    if (!copy.ok) {
      await fromWindow(boxId, 'session.delete', { sessionId: made.value.id })
      return { error: copy.error, ...(held.ok ? {} : { held: held.error }) }
    }
    const name = path.slice(path.lastIndexOf('/') + 1)
    const at = teamsCanvasOf({ name, path: copy.value.source.path, kind: 'file' }, copy.value.source.host, true)
    if (!at) return { error: `no canvas kind for ${name}` }
    const item = await fromWindow(boxId, 'work.canvas.open', { sessionId: made.value.id, kind: at.kind, source: at.source, title: name })
    if (!item.ok) return { error: item.error }
    return { sessionId: made.value.id, reused: false, ...(held.ok ? {} : { held: held.error }) }
  }

  const deck = await open(files.deck)
  check('the deck opens: a thread with its copy', !!deck.sessionId && !deck.error, deck.error)
  check('asking which thread holds the deck is answered, not refused', !deck.held, deck.held)
  const pdf = await open(files.pdf)
  check('then the PDF opens', !!pdf.sessionId && !pdf.error, pdf.error)
  const picture = await open(files.picture)
  check('then the picture opens', !!picture.sessionId && !picture.error, picture.error)
  const again = await open(files.deck)
  check("the deck again opens the deck's own thread", again.reused === true && again.sessionId === deck.sessionId, JSON.stringify(again))
  const copied = deck.sessionId ? readFileSync(files.deck).equals(readFileSync(join((await rpc<{ items: { source: { path?: string } }[] }>(box, 'work.canvas.list', { sessionId: deck.sessionId })).items[0]?.source.path ?? '/nonexistent'))) : false
  check("the deck's copy on box holds the file's own bytes", copied)

  writeFileSync(join(box.home, 'secret.txt'), 'not for a key\n')
  // The Files place (work/files): a file opens in a tab of its own with no thread, by one request to the workspace's
  // host, `work.files.open`, which makes the same copy. A deck, a PDF and a sheet one after another, then the deck again.
  const tab = async (path: string): Promise<{ tabId?: string; kind?: string; tabs?: number; held?: boolean; error?: string }> => {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const got = await fromWindow<{ tabId?: string; item?: { kind: string; sessionId: string }; held?: unknown; tabs: unknown[] }>(boxId, 'work.files.open', { workspaceId: ws.id, ref: { at: 'file', host: macId, path }, name, key: `lib:e2e:${name}` })
    return got.ok ? { tabId: got.value.tabId, kind: got.value.item?.kind, tabs: got.value.tabs.length, ...(got.value.held ? { held: true } : {}) } : { error: got.error }
  }
  const threads = async (): Promise<number> => {
    const got = await rpc<unknown>(box, 'session.list', {}).catch(() => null)
    return Array.isArray(got) ? got.length : ((got as { sessions?: unknown[] } | null)?.sessions?.length ?? -1)
  }
  const sessionsBefore = await threads()
  const deckTab = await tab(files.deck2)
  check('Files: a deck opens in a tab, with no refusal', !!deckTab.tabId && deckTab.kind === 'slides', JSON.stringify(deckTab))
  const pdfTab = await tab(files.pdf2)
  check('Files: then a PDF opens in its tab', !!pdfTab.tabId && pdfTab.kind === 'pdf', JSON.stringify(pdfTab))
  const sheetTab = await tab(files.sheet)
  check('Files: then the sheet opens in its tab', !!sheetTab.tabId && sheetTab.kind === 'sheet' && sheetTab.tabs === 3, JSON.stringify(sheetTab))
  const deckAgain = await tab(files.deck2)
  check("Files: the deck again is the deck's own tab, and no fourth is made", deckAgain.tabId === deckTab.tabId && deckAgain.tabs === 3, JSON.stringify(deckAgain))
  // A copy is a file of its own with its own marks: the deck a thread already shows opens in a tab of its own.
  const heldDeck = await tab(files.deck)
  check('Files: a deck a thread holds opens in a tab of its own', !heldDeck.error && !heldDeck.held && !!heldDeck.tabId && heldDeck.kind === 'slides' && heldDeck.tabs === 4, JSON.stringify(heldDeck))
  const sessionsAfter = await threads()
  check('Files: opening made no thread', sessionsAfter === sessionsBefore, `${sessionsBefore} before, ${sessionsAfter} after`)
  for (const [method, params] of [
    ['work.files.threads', { ref: { at: 'file', host: macId, path: files.deck } }],
    ['work.files.star', { ref: { at: 'file', host: macId, path: files.deck }, name: 'Kickoff.pptx', on: true }],
    ['work.files.tabOpen', { page: { at: { at: 'file', host: macId, path: join(library, 'General') }, name: 'General' } }]
  ] as [string, Record<string, unknown>][]) {
    const got = await fromWindow(boxId, method, { workspaceId: ws.id, ...params })
    check(`Files: ${method} naming mac's file passes`, got.ok, got.ok ? '' : got.error)
  }
  for (const host of [boxId, macId]) {
    const got = await fromWindow(boxId, 'work.files.open', { workspaceId: ws.id, ref: { at: 'file', host, path: join(box.home, 'secret.txt') } })
    check(`Files: an open of box's ${host === boxId ? 'own path' : 'path claimed for mac'} outside the roots makes no tab`, !got.ok, got.ok ? 'opened' : got.error)
  }

  // ── A copy saves back ────────────────────────────────────────────────
  // mac lets box run its Files verbs now: a copy's bytes go back through work.files.writeBack, a peer's operate verb.
  await rpc(mac, 'macBridge.policy.set', { environmentId: boxId, policy: 'read+run' })
  const roster = join(library, 'General', 'Roster.xlsx')
  const agenda = join(library, 'General', 'Agenda.md')
  copyFileSync(join(REPO, 'resources', 'work-files', 'blank', 'blank.xlsx'), roster)
  writeFileSync(agenda, '# Agenda\n')
  type Back = { is: string; at?: number; detail?: string }
  type TabRow = { id: string; name: string; copyOf?: { host: string; path: string }; back?: Back }
  const tabRow = async (tabId: string): Promise<TabRow | undefined> => {
    const got = await fromWindow<{ tabs: TabRow[] }>(boxId, 'work.files.tabs', { workspaceId: ws.id })
    return got.ok ? got.value.tabs.find((t) => t.id === tabId) : undefined
  }
  const openCopy = async (path: string): Promise<{ tabId: string; copy: string } | null> => {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const got = await fromWindow<{ tabId?: string; item?: { source: { path?: string } } }>(boxId, 'work.files.open', { workspaceId: ws.id, ref: { at: 'file', host: macId, path }, name })
    if (got.ok && got.value.tabId && got.value.item?.source.path) return { tabId: got.value.tabId, copy: got.value.item.source.path }
    log(`open ${name}: ${got.ok ? 'no tab' : got.error}`)
    return null
  }
  const sendBack = (tabId: string) => fromWindow<Back>(boxId, 'work.files.copyBack', { workspaceId: ws.id, tabId })
  const sheet = await openCopy(roster)
  const text = await openCopy(agenda)
  if (!check('save back: a workbook and a text file of mac open as copies that save back', !!sheet && !!text && (await tabRow(sheet.tabId))?.back?.is === 'ok' && (await tabRow(text.tabId))?.back?.is === 'ok')) throw new Error('no copies that save back')
  // The owner's save leaves new bytes in each copy; then the window asks, as it does once a kind says it saved.
  const edited = Buffer.concat([readFileSync(sheet!.copy), Buffer.from('owner edit')])
  writeFileSync(sheet!.copy, edited)
  const sent = await sendBack(sheet!.tabId)
  check("save back: the workbook's bytes reach mac's file", sent.ok && sent.value.is === 'ok' && readFileSync(roster).equals(edited), sent.ok ? JSON.stringify(sent.value) : sent.error)
  check('save back: the tab says when its file took them (the recorded version moved)', !!(await tabRow(sheet!.tabId))?.back?.at)
  writeFileSync(text!.copy, '# Agenda\n- doors at 5\n')
  const sentText = await sendBack(text!.tabId)
  check("save back: the text file's words reach mac's file", sentText.ok && readFileSync(agenda, 'utf8') === '# Agenda\n- doors at 5\n', sentText.ok ? JSON.stringify(sentText.value) : sentText.error)
  const mtime = Bun.file(roster).lastModified
  const idle = await sendBack(sheet!.tabId)
  check('save back: asked again with nothing changed, nothing is written', idle.ok && idle.value.is === 'ok' && Bun.file(roster).lastModified === mtime)

  // mac's file changed behind the copy: it is never written over.
  writeFileSync(roster, 'changed on mac')
  writeFileSync(sheet!.copy, Buffer.concat([edited, Buffer.from(' again')]))
  const clash = await sendBack(sheet!.tabId)
  check('save back: a file that changed on mac is the conflict, and is left as it was', clash.ok && clash.value.is === 'changed' && readFileSync(roster, 'utf8') === 'changed on mac', clash.ok ? JSON.stringify(clash.value) : clash.error)
  const both = await fromWindow<{ tabs: TabRow[] }>(boxId, 'work.files.copyKeep', { workspaceId: ws.id, tabId: sheet!.tabId })
  const mine = join(library, 'General', 'Roster (mine).xlsx')
  const kept = both.ok ? both.value.tabs.find((t) => t.id === sheet!.tabId) : undefined
  check('save back: Keep Both puts his bytes beside it on mac, and the tab shows that file', existsSync(mine) && readFileSync(mine).equals(readFileSync(sheet!.copy)) && kept?.name === 'Roster (mine).xlsx' && kept.copyOf?.path === mine && readFileSync(roster, 'utf8') === 'changed on mac', both.ok ? JSON.stringify(kept) : both.error)
  writeFileSync(mine, 'mine, changed on mac')
  writeFileSync(sheet!.copy, 'his unsent change')
  await sendBack(sheet!.tabId)
  const reloaded = await fromWindow(boxId, 'work.files.copyReload', { workspaceId: ws.id, tabId: sheet!.tabId })
  check("save back: Reload reads mac's file into the copy and drops what was not sent", reloaded.ok && readFileSync(sheet!.copy, 'utf8') === 'mine, changed on mac' && (await tabRow(sheet!.tabId))?.back?.is === 'ok', reloaded.ok ? '' : reloaded.error)

  // A read key may not send a copy back.
  const pairing = await rpc<{ code: string }>(box, 'remote.pairings.create', { audience: 'client', caps: ['read'], name: 'reader (e2e)' })
  const paired = await fetch(`http://127.0.0.1:${box.remote}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, kind: 'key' }) }).then((r) => r.json() as Promise<{ key: string }>)
  const ticket = await fetch(`http://127.0.0.1:${box.remote}/api/ticket`, { method: 'POST', headers: { authorization: `Bearer ${paired.key}` } }).then((r) => r.json() as Promise<{ ticket: string }>)
  writeFileSync(text!.copy, '# Agenda\n- a reader\n')
  const readerSaid = await new Promise<string>((ok) => {
    const sock = new WebSocket(`ws://127.0.0.1:${box.remote}/ws?ticket=${encodeURIComponent(ticket.ticket)}`)
    const timer = setTimeout(() => (sock.close(), ok('(no answer)')), 20_000)
    sock.addEventListener('open', () => sock.send(JSON.stringify({ id: 'r', method: 'work.files.copyBack', params: { workspaceId: ws.id, tabId: text!.tabId } })))
    sock.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; error?: string }
      if (frame.id !== 'r') return
      clearTimeout(timer)
      sock.close()
      ok(frame.ok ? '(sent)' : (frame.error ?? '(refused)'))
    })
  })
  check('save back: a read key is refused, and nothing reaches mac', readerSaid !== '(sent)' && readFileSync(agenda, 'utf8') === '# Agenda\n- doors at 5\n', readerSaid)
  writeFileSync(text!.copy, '# Agenda\n- doors at 5\n')

  // A thread's own idea on the copy is a suggestion at most: the copy reads as shared to the sheet's hold.
  const before = readFileSync(sheet!.copy)
  const tool = deck.sessionId
    ? await rpc<{ content?: { text?: string }[]; isError?: boolean }>(box, 'app.workCall', { sessionId: deck.sessionId, token: workToken(deck.sessionId), call: 1, tool: 'sheets_write', args: { file: sheet!.copy, cells: [{ at: 'A1', v: 'from a thread' }], because: 'own' } }).catch((err: Error) => ({ content: [{ text: err.message }], isError: true }))
    : { content: [{ text: '(no thread)' }], isError: true }
  const said = tool.content?.map((c) => c.text ?? '').join(' ') ?? ''
  check("save back: a thread's own idea on the copy is held or refused, and mac's file is untouched", !/^Wrote/.test(said) && readFileSync(sheet!.copy).equals(before) && readFileSync(mine, 'utf8') === 'mine, changed on mac', said.slice(0, 200))

  // The fence still holds a path of box's own disk to its roots, however the source names its host.
  const outside = join(box.home, 'secret.txt')
  for (const host of [boxId, macId, 'env_someone_else']) {
    const got = await fromWindow(boxId, 'work.office.filesCopy', { sessionId: deck.sessionId ?? 'x', source: { at: 'file', host, path: outside } })
    const words = got.ok ? '(copied)' : got.error
    check(`a copy of box's ${host === boxId ? 'own path' : 'path claimed for another host'} outside the roots never comes back to the key`, !got.ok && !words.includes('not for a key'), words)
  }
  const own = await fromWindow(boxId, 'work.canvas.open', { sessionId: deck.sessionId ?? 'x', kind: 'pdf', source: { at: 'file', host: boxId, path: outside }, title: 'secret' })
  check("box's own path outside the roots is refused at the fence for work.canvas.open", !own.ok && /outside app-managed roots/.test(own.error), own.ok ? 'opened' : own.error)
  const guest = await fromWindow(boxId, 'work.office.filesCopy', { sessionId: deck.sessionId ?? 'x', source: { at: 'file', host: boxId, path: 'C:\\Users\\tcuser\\OneDrive\\a.pptx' } })
  check('a Windows guest path passes the fence and box (no VM here) refuses it in words of its own', !guest.ok && !/outside app-managed roots/.test(guest.error), guest.ok ? 'copied' : guest.error)
} catch (err) {
  check('the run finished', false, String((err as Error).stack ?? err))
} finally {
  await cleanup()
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
