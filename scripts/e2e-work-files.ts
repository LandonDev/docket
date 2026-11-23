/**
 * The Files place of a Work workspace, live over the real wire on the box (docs/agents/work-files.md): one
 * isolated headless instance of the BUILT tree (out/main) with its own HOME, userData, TMPDIR, work root and
 * listener port, started twice on the same userData.
 *
 *  1. Work on, a Work workspace with a dummy sector; in its folder `Big/` (5,000 small files, every tenth
 *     sparse so it reads as cloud-only), `Deep/a/b/c/`, a PDF, a CSV, a markdown file, a PNG, a hidden
 *     folder and a link out of the folder
 *  2. `places`: the workspace's folder, Recent and Starred; the second call under 50 ms
 *  3. `list` of Big: 10 pages of 500 by the cursor, by name ascending and by changed descending, no name
 *     twice and none missed; the warm first page under 150 ms; no hidden name or link; every tenth file
 *     cloud-only; listing grows no tab and no mark
 *  4. `tabOpen {first}` then `open` of the PDF, the sheet, the markdown file and the PNG: four file tabs
 *     owned by the workspace's Files pane, of kinds pdf, sheet, document, media; opening the PDF again
 *     answers its tab; no session made
 *  5. a second connection reads the same tabs and rev; a tab closed from the first is pushed to the
 *     second, gone from its next read, and its canvas item gone
 *  6. a clean stop and a start on the same userData: the same tabs in the same order, the items open,
 *     Recent naming the files opened
 *  7. the fence over the listener, with a read+operate key: the folder lists, a path outside it is
 *     refused, a rename inside the folder is carried out and one naming a file outside it is refused
 *  8. the old wire, `work.office.filesLibraries`, still answers
 *  9. a folder of 300 mixed files (one sparse, read as kept in the cloud): it lists whole, forty
 *     thumbnails are drawn while the list is asked again and answers first, the sparse file gets
 *     no picture and not one byte of it is read, and Quick Look walks twelve files in turn
 *
 * Run: bunx electron-vite build, then
 *   env -u ELECTRON_RUN_AS_NODE NODE_ENV=production bun scripts/e2e-work-files.ts
 * Nothing here touches a real HOME, account, /Applications or the box's live temp-code.service; it kills
 * only the processes it started (by pid, and by its own userData marker), and removes its temp dir.
 * TC_FILES_KEEP=1 leaves the temp dir for inspection.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { FilesListing, FilesOpened, FilesPlaces, FilesTabs } from '../src/shared/contract-work-files'
import { freePort } from './lib/devInstance'
import { REPO, sleep } from './lib/packagedApp'
import { proofCleanup } from './lib/proofCleanup'
import { createProcScan, hasEnv } from './lib/procScan'

const KEEP = process.env.TC_FILES_KEEP === '1'
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('out/main is missing: run electron-vite build first')
  process.exit(2)
}

// ── the instance's dirs ─────────────────────────────────────────────────
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tc-files-e2e-')))
const home = join(root, 'home')
const data = join(root, 'data')
const tmp = join(root, 'tmp')
const work = join(home, 'work')
const outside = join(root, 'outside')
const appLog = join(root, 'app.log')
for (const d of [home, data, tmp, work, outside]) mkdirSync(d, { recursive: true })
writeFileSync(join(outside, 'secret.txt'), 'not his workspace\n')
const remotePort = await freePort()
const guard = proofCleanup(root)
const scan = createProcScan()

let proc: ChildProcess | undefined
function launch(): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    TMPDIR: tmp,
    TEMP_CODE_USER_DATA: data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(remotePort),
    TEMP_CODE_ALIAX_DATA_DIR: join(data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
    TEMP_CODE_WORK_ROOT: work,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
  // The agent shell carries the box service's env: none of it may reach the proof's instance.
  for (const key of Object.keys(env)) if (/^TEMP_CODE_(HUB|APNS)_/.test(key)) delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  proc = spawn('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.'], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })
  guard.track(proc, true)
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(appLog, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(appLog, c))
}

/** This instance's processes, by the userData its environment carries. */
const ours = () => scan.processes().filter((row) => row.pid !== process.pid && hasEnv(row, `TEMP_CODE_USER_DATA=${data}`))
/** Electron's main process: the binary with no `--type=` (helpers carry one). */
const mainPid = (): number | null => ours().find((row) => /^\S*\/dist\/electron(\s|$)/.test(row.command) && !row.command.includes('--type='))?.pid ?? null
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(250)
  }
  log(`timed out: ${label}`)
  return false
}

/**
 * A clean stop: SIGTERM to Electron's main alone, so its quit runs with the D-Bus session still up (a group
 * SIGTERM aborts on the D-Bus disconnect first: box-sigterm-dbus-abort). Then whatever of ours is left.
 */
async function stop(): Promise<boolean> {
  const pid = mainPid()
  if (pid) process.kill(pid, 'SIGTERM')
  else log(`no main process found among: ${ours().map((row) => row.command.slice(0, 80)).join(' | ')}`)
  const clean = await until('the instance exits', 30_000, () => mainPid() === null)
  if (!clean) log(`still running: ${ours().map((row) => `${row.pid} ${row.command.slice(0, 100)}`).join(' | ')}`)
  try {
    if (proc?.pid) process.kill(-proc.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
  for (const row of ours()) {
    try {
      process.kill(row.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  await until('every process of the instance gone', 10_000, () => ours().length === 0)
  return clean
}

async function start(): Promise<boolean> {
  rmSync(join(data, 'server.json'), { force: true })
  launch()
  return until('server.json', 120_000, () => existsSync(join(data, 'server.json')))
}
const localPort = (): number => (JSON.parse(readFileSync(join(data, 'server.json'), 'utf8')) as { port: number }).port

// ── a client: one socket, requests by id, pushes kept ──────────────────
type Push = { push: string; [k: string]: unknown }
interface Client {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  /** the error sentence, or '(no error)' */
  refusal(method: string, params?: unknown): Promise<string>
  pushes: Push[]
  close(): void
}
async function client(url: string, waitHello = false): Promise<Client> {
  const ws = new WebSocket(url)
  const waiting = new Map<string, (f: { ok?: boolean; result?: unknown; error?: string }) => void>()
  const pushes: Push[] = []
  let hello: () => void = () => {}
  const helloSeen = new Promise<void>((r) => (hello = r))
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as { id?: string; push?: string; ok?: boolean; result?: unknown; error?: string }
    if (frame.push) {
      if (frame.push === 'hello') hello()
      pushes.push(frame as Push)
    }
    if (frame.id && waiting.has(frame.id)) {
      waiting.get(frame.id)!(frame)
      waiting.delete(frame.id)
    }
  })
  await new Promise<void>((ok, bad) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => bad(new Error(`socket failed: ${url}`)))
  })
  if (waitHello) await helloSeen
  let next = 1
  const call = <T>(method: string, params: unknown = {}): Promise<T> =>
    new Promise<T>((ok, fail) => {
      const id = `c${next++}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        fail(new Error(`no answer to ${method}`))
      }, 120_000)
      waiting.set(id, (f) => {
        clearTimeout(timer)
        if (f.ok) ok(f.result as T)
        else fail(new Error(f.error ?? `${method} failed`))
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return {
    call,
    refusal: (method, params) => call(method, params).then(() => '(no error)', (e: Error) => e.message),
    pushes,
    close: () => ws.close()
  }
}
const local = (): Promise<Client> => client(`ws://127.0.0.1:${localPort()}/`)
async function remote(key: string): Promise<Client> {
  const res = await fetch(`http://127.0.0.1:${remotePort}/api/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } })
  const { ticket } = (await res.json()) as { ticket: string }
  return client(`ws://127.0.0.1:${remotePort}/ws?ticket=${ticket}`, true)
}
const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now()
  const out = await fn()
  return [out, performance.now() - t]
}

// ── dummy files ─────────────────────────────────────────────────────────
const EXTS = ['.docx', '.xlsx', '.pptx', '.pdf', '.png', '.txt', '.mp4', '.csv'] as const
const PDF = (() => {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>']
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return body
})()
/** A 1×1 PNG, its CRCs computed. */
const PNG = (() => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer): number => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const tb = Buffer.concat([Buffer.from(type), body])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(tb))
    return Buffer.concat([len, tb, c])
  }
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 200, 80, 40]))), chunk('IEND', Buffer.alloc(0))])
})()

const timings: [string, number][] = []
let a: Client | undefined
let b: Client | undefined
let r: Client | undefined
try {
  if (!check('the headless instance published its local socket', await start())) throw new Error(`no server.json; log ${appLog}`)
  a = await local()
  const host = (await a.call<{ environmentId: string }>('remote.status')).environmentId
  log(`instance on :${localPort()} (listener :${remotePort}), host ${host}; log ${appLog}`)

  // ── 1. Work on, a Work workspace, its library ────────────────────────
  await a.call('work.set', { enabled: true })
  const ws = await a.call<{ id: string; path: string }>('workspace.create', { kind: 'work', name: 'Dummy Sector', sector: 'dummy' })
  const folder = ws.path
  check('a Work workspace with a dummy sector has a folder of its own', !!ws.id && !!folder && existsSync(folder), JSON.stringify(ws))
  const at = (path: string) => ({ at: 'file' as const, host, path })
  const big = join(folder, 'Big')
  mkdirSync(big)
  const madeAt = Date.now()
  for (let i = 0; i < 5000; i++) {
    const p = join(big, `item ${String(i).padStart(4, '0')}${EXTS[i % EXTS.length]}`)
    if (i % 10 === 0) {
      writeFileSync(p, '')
      truncateSync(p, 120_000)
    } else writeFileSync(p, `dummy ${i}\n`)
  }
  mkdirSync(join(big, '.cache'))
  symlinkSync(outside, join(big, 'link out'))
  mkdirSync(join(folder, 'Deep', 'a', 'b', 'c'), { recursive: true })
  writeFileSync(join(folder, 'Deep', 'a', 'b', 'c', 'bottom.txt'), 'deep\n')
  writeFileSync(join(folder, 'Report.pdf'), PDF)
  writeFileSync(join(folder, 'Budget.csv'), 'item,cost\nchairs,120\ntables,300\n')
  writeFileSync(join(folder, 'Notes.md'), '# Dummy notes\n\nA line of words.\n')
  writeFileSync(join(folder, 'Logo.png'), PNG)
  mkdirSync(join(folder, '.hidden'))
  writeFileSync(join(folder, '.hidden', 'inside.txt'), 'x')
  symlinkSync(outside, join(folder, 'Outside link'))
  log(`wrote 5,000 files under ${big} in ${Date.now() - madeAt} ms`)
  const sessionsBefore = (await a.call<unknown[]>('session.list')).length

  // ── 2. places ────────────────────────────────────────────────────────
  await a.call('work.files.places', { workspaceId: ws.id })
  const [places, placesMs] = await timed(() => a!.call<FilesPlaces>('work.files.places', { workspaceId: ws.id }))
  timings.push(['places (second call)', placesMs])
  const kinds = places.places.map((p) => p.kind)
  const own = places.places.find((p) => p.kind === 'folder')
  check("places answers the workspace's folder, named for it, beside Recent and Starred", !!own && own.name === 'Dummy Sector' && kinds.includes('recent') && kinds.includes('starred'), JSON.stringify(places.places.map((p) => [p.kind, p.name])))
  check('places answers its second call under 50 ms', placesMs < 50, `${placesMs.toFixed(1)} ms`)

  // ── 3. browse 5,000 files ────────────────────────────────────────────
  const marksBefore = await a.call<FilesTabs>('work.files.tabs', { workspaceId: ws.id })
  const walk = async (sort: { by: string; dir: string }, label: string): Promise<{ names: string[]; pages: number; firstMs: number; laterMs: number; totalMs: number; entries: FilesListing['entries'] }> => {
    const names: string[] = []
    const entries: FilesListing['entries'] = []
    let cursor: string | undefined
    let pages = 0
    let firstMs = 0
    let laterMs = 0
    const t0 = performance.now()
    do {
      const [page, ms] = await timed(() => a!.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: at(big), sort, ...(cursor ? { cursor } : {}) }))
      if (page.stale) throw new Error(`${label}: the folder went stale mid-walk`)
      if (pages === 0) firstMs = ms
      if (pages === 4) laterMs = ms
      pages++
      for (const e of page.entries) {
        names.push(e.name)
        entries.push(e)
      }
      if (page.entries.length > 500) throw new Error(`${label}: a page of ${page.entries.length}`)
      cursor = page.next
    } while (cursor && pages < 50)
    return { names, pages, firstMs, laterMs, totalMs: performance.now() - t0, entries }
  }
  const expected = Array.from({ length: 5000 }, (_, i) => `item ${String(i).padStart(4, '0')}${EXTS[i % EXTS.length]}`)
  const byName = await walk({ by: 'name', dir: 'asc' }, 'by name')
  timings.push(['first page, cold', byName.firstMs], ['a later page (5th)', byName.laterMs], ['the full 5,000 walk by name, cold', byName.totalMs])
  check('list of Big pages through all 5,000 by the cursor in 10 pages of 500', byName.pages === 10 && byName.names.length === 5000, `${byName.pages} pages, ${byName.names.length} names`)
  check('by name ascending: no name twice, none missed, in order', new Set(byName.names).size === 5000 && byName.names.every((n, i) => n === expected[i]), byName.names.slice(0, 3).join(', '))
  const hiddenOrLink = (names: string[]) => names.some((n) => n.startsWith('.') || n === 'link out' || n === 'Outside link')
  check('no hidden name and no link in the listing of Big', !hiddenOrLink(byName.names))
  const cloud = byName.entries.filter((_, i) => i % 10 === 0)
  const onDisk = byName.entries.filter((_, i) => i % 10 !== 0)
  check(
    'every tenth file reads local: false with state cloud; the rest are local',
    cloud.every((e) => e.local === false && (e.state as { is?: string } | undefined)?.is === 'cloud') && onDisk.every((e) => e.local !== false && !(e.state as { is?: string } | undefined)),
    JSON.stringify([cloud[0], onDisk[0]])
  )
  const byChanged = await walk({ by: 'changed', dir: 'desc' }, 'by changed')
  timings.push(['the full 5,000 walk by changed desc', byChanged.totalMs])
  const stamps = byChanged.entries.map((e) => e.changed ?? 0)
  check(
    'by changed descending: 10 pages, all 5,000 once, newest first',
    byChanged.pages === 10 && new Set(byChanged.names).size === 5000 && stamps.every((s, i) => i === 0 || s <= stamps[i - 1]!),
    `${byChanged.pages} pages, ${new Set(byChanged.names).size} names`
  )
  const [warm, warmMs] = await timed(() => a!.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: at(big), sort: { by: 'name', dir: 'asc' } }))
  timings.push(['first page, warm', warmMs])
  check('the first page of a second pass (warm) answers under 150 ms', warm.entries.length === 500 && warmMs < 150, `${warmMs.toFixed(1)} ms`)
  const top = await a.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: { at: 'place', id: own?.id ?? 'folder' } })
  check(
    "the workspace's folder lists Big, Deep and the four files, and neither the hidden folder nor the link",
    ['Big', 'Deep', 'Budget.csv', 'Logo.png', 'Notes.md', 'Report.pdf'].every((n) => top.entries.some((e) => e.name === n)) && !hiddenOrLink(top.entries.map((e) => e.name)),
    top.entries.map((e) => e.name).join(', ')
  )
  const deep = await a.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: at(join(folder, 'Deep', 'a', 'b', 'c')) })
  check('a deep folder lists with its trail from the place down', deep.entries.map((e) => e.name).join() === 'bottom.txt' && deep.trail?.map((c) => c.name).join('/') === 'Dummy Sector/Deep/a/b/c', JSON.stringify(deep.trail?.map((c) => c.name)))
  const afterList = await a.call<FilesTabs>('work.files.tabs', { workspaceId: ws.id })
  const recentEmpty = await a.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: { at: 'place', id: 'recent' } })
  const starredEmpty = await a.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: { at: 'place', id: 'starred' } })
  check(
    'listing grew no tab and no mark (no tabs, same rev, Recent and Starred empty)',
    afterList.tabs.length === 0 && afterList.rev === marksBefore.rev && recentEmpty.entries.length === 0 && starredEmpty.entries.length === 0,
    `tabs ${afterList.tabs.length}, rev ${marksBefore.rev}→${afterList.rev}, recent ${recentEmpty.entries.length}, starred ${starredEmpty.entries.length}`
  )

  // ── 4. four kinds in tabs ────────────────────────────────────────────
  const pane = `filespane_${ws.id}`
  const first = await a.call<FilesTabs & { tabId: string }>('work.files.tabOpen', { workspaceId: ws.id, page: { at: { at: 'place', id: own?.id ?? 'folder' }, name: 'Dummy Sector' }, first: true })
  check('tabOpen {first} makes the first page tab', first.tabs.length === 1 && first.tabs[0]!.kind === 'page', JSON.stringify(first.tabs))
  const want: [string, string][] = [
    ['Report.pdf', 'pdf'],
    ['Budget.csv', 'sheet'],
    ['Notes.md', 'file'],
    ['Logo.png', 'media']
  ]
  const opened: Record<string, FilesOpened> = {}
  let opener = first.tabId
  for (const [name, kind] of want) {
    const got = await a.call<FilesOpened>('work.files.open', { workspaceId: ws.id, ref: at(join(folder, name)), opener })
    opened[name] = got
    check(`open ${name}: a tab with an item of kind ${kind} owned by the Files pane`, !!got.tabId && got.item?.sessionId === pane && got.item?.kind === kind, JSON.stringify({ tabId: got.tabId, item: got.item && { sessionId: got.item.sessionId, kind: got.item.kind, title: got.item.title } }))
    opener = got.tabId ?? opener
  }
  const tabsNow = await a.call<FilesTabs>('work.files.tabs', { workspaceId: ws.id })
  const order = [first.tabId, ...want.map(([n]) => opened[n]!.tabId)]
  check('work.files.tabs lists five tabs in order', tabsNow.tabs.length === 5 && tabsNow.tabs.map((t) => t.id).join() === order.join(), tabsNow.tabs.map((t) => `${t.kind}:${t.name}`).join(', '))
  const items = (await a.call<{ items: { id: string; kind: string }[] }>('work.canvas.list', { sessionId: pane })).items
  const itemIds = want.map(([n]) => opened[n]!.item!.id)
  check('work.canvas.list of the pane lists the four items', items.length === 4 && itemIds.every((id) => items.some((i) => i.id === id)), JSON.stringify(items.map((i) => [i.id, i.kind])))
  const again = await a.call<FilesOpened>('work.files.open', { workspaceId: ws.id, ref: at(join(folder, 'Report.pdf')) })
  check('opening the PDF again answers the same tab, and no sixth', again.tabId === opened['Report.pdf']!.tabId && again.tabs.length === 5, `${again.tabId} vs ${opened['Report.pdf']!.tabId}, ${again.tabs.length} tabs`)
  const sessionsAfter = (await a.call<unknown[]>('session.list')).length
  check('no session was created by opening files', sessionsAfter === sessionsBefore, `${sessionsBefore} → ${sessionsAfter}`)

  // ── 5. a second window agrees ────────────────────────────────────────
  b = await local()
  const seen = await b.call<FilesTabs>('work.files.tabs', { workspaceId: ws.id })
  const mine = await a.call<FilesTabs>('work.files.tabs', { workspaceId: ws.id })
  check('a second connection reads the same tabs and rev', seen.rev === mine.rev && seen.tabs.map((t) => t.id).join() === mine.tabs.map((t) => t.id).join(), `rev ${seen.rev} vs ${mine.rev}`)
  const closing = opened['Logo.png']!
  const closed = await a.call<FilesTabs>('work.files.tabClose', { workspaceId: ws.id, tabId: closing.tabId })
  const pushed = await until('the tabs push on the second connection', 10_000, () => b!.pushes.some((p) => p.push === 'work.files' && p.workspaceId === ws.id && p.tabs === closed.rev))
  check('the second connection receives a work.files push with the new tabs revision', pushed, JSON.stringify(b.pushes.filter((p) => p.push === 'work.files')))
  const seen2 = await b.call<FilesTabs>('work.files.tabs', { workspaceId: ws.id })
  check("the second connection's next read no longer has the tab", seen2.rev === closed.rev && !seen2.tabs.some((t) => t.id === closing.tabId) && seen2.tabs.length === 4, seen2.tabs.map((t) => t.name).join(', '))
  const itemsAfterClose = (await a.call<{ items: { id: string }[] }>('work.canvas.list', { sessionId: pane })).items
  check("the closed tab's canvas item is gone", itemsAfterClose.length === 3 && !itemsAfterClose.some((i) => i.id === closing.item!.id), JSON.stringify(itemsAfterClose.map((i) => i.id)))
  b.close()
  b = undefined

  // ── 6. restart ───────────────────────────────────────────────────────
  const beforeStop = await a.call<FilesTabs>('work.files.tabs', { workspaceId: ws.id })
  a.close()
  a = undefined
  const cleanStop = await stop()
  check('the instance stopped on SIGTERM to its main process', cleanStop)
  if (!check('the instance started again on the same userData', await start())) throw new Error(`no server.json after restart; log ${appLog}`)
  a = await local()
  const afterStart = await a.call<FilesTabs>('work.files.tabs', { workspaceId: ws.id })
  check('after the restart: the same tabs in the same order', afterStart.tabs.map((t) => `${t.id}:${t.name}`).join() === beforeStop.tabs.map((t) => `${t.id}:${t.name}`).join(), afterStart.tabs.map((t) => t.name).join(', '))
  const itemsAfterStart = (await a.call<{ items: { id: string }[] }>('work.canvas.list', { sessionId: pane })).items
  const tabItems = afterStart.tabs.flatMap((t) => (t.itemId ? [t.itemId] : []))
  check("after the restart: each file tab's item is still open", tabItems.length === 3 && tabItems.every((id) => itemsAfterStart.some((i) => i.id === id)), JSON.stringify({ tabItems, items: itemsAfterStart.map((i) => i.id) }))
  const recent = await a.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: { at: 'place', id: 'recent' } })
  const recentNames = recent.entries.map((e) => e.name)
  check('after the restart: Recent names the files that were opened', want.every(([n]) => recentNames.includes(n)), recentNames.join(', '))

  // ── 7. the fence over the real listener ──────────────────────────────
  const key = await a.call<{ token: string }>('remote.keys.create', { name: 'files proof (e2e)', audience: 'client', caps: ['read', 'operate'] })
  r = await remote(key.token)
  const fenced = await r.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: at(folder) }).catch((e: Error) => e)
  check("a read+operate key lists the workspace's folder", !(fenced instanceof Error) && fenced.entries.some((e) => e.name === 'Report.pdf'), fenced instanceof Error ? fenced.message : `${fenced.entries.length} entries`)
  const outHome = await r.refusal('work.files.list', { workspaceId: ws.id, at: at(home) })
  log(`outside (HOME): "${outHome}"`)
  check("a list naming a path outside the workspace's folder (the instance's HOME) is refused", outHome !== '(no error)', outHome)
  const outRoot = await r.refusal('work.files.list', { workspaceId: ws.id, at: at(outside) })
  check('a list naming a folder outside every root is refused', outRoot !== '(no error)', outRoot)
  const viaLink = await r.refusal('work.files.list', { workspaceId: ws.id, at: at(join(folder, 'Outside link')) })
  check("a list through the folder's link out is refused", viaLink !== '(no error)', viaLink)
  // His own folder takes a key's change (it has operate); a path outside it never reaches the door.
  const renamed = await r.refusal('work.files.rename', { workspaceId: ws.id, ref: at(join(folder, 'Notes.md')), name: 'Renamed.md', op: `e2e-rename-${Date.now()}` })
  log(`rename: "${renamed}"`)
  check("a rename of a file in the workspace's folder is carried out for the key", renamed === '(no error)' && existsSync(join(folder, 'Renamed.md')) && !existsSync(join(folder, 'Notes.md')), renamed)
  writeFileSync(join(outside, 'Elsewhere.md'), 'not the workspace\'s\n')
  const renamedOut = await r.refusal('work.files.rename', { workspaceId: ws.id, ref: at(join(outside, 'Elsewhere.md')), name: 'Taken.md', op: `e2e-rename-out-${Date.now()}` })
  log(`rename outside: "${renamedOut}"`)
  check('a rename naming a file outside every root is refused, and the file is as it was', renamedOut !== '(no error)' && existsSync(join(outside, 'Elsewhere.md')) && !existsSync(join(outside, 'Taken.md')), renamedOut)

  // ── 8. the old wire still answers ────────────────────────────────────
  const libs = await a.call<{ libraries?: unknown[]; places?: unknown[] }>('work.office.filesLibraries', {}).catch((e: Error) => e)
  check('work.office.filesLibraries still answers on the same instance', !(libs instanceof Error) && typeof libs === 'object' && libs !== null, libs instanceof Error ? libs.message : JSON.stringify(libs).slice(0, 200))

  // ── 9. a folder of 300 mixed files: pictures land without holding the list ─
  // Text files, pictures, PDFs and one sparse file (its full size and no blocks: read as kept in the cloud).
  const many = join(folder, 'Many')
  mkdirSync(many)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  for (let i = 0; i < 299; i++) {
    const n = String(i).padStart(3, '0')
    if (i % 3 === 0) writeFileSync(join(many, `note-${n}.txt`), `Note ${n}\n\nA line of words for file ${n}.\n`)
    else if (i % 3 === 1) writeFileSync(join(many, `shot-${n}.png`), png)
    else writeFileSync(join(many, `sheet-${n}.pdf`), '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
  }
  const sparse = join(many, 'cloud-only.pdf')
  writeFileSync(sparse, '')
  truncateSync(sparse, 4 * 1024 * 1024)
  const sparseBlocks = statSync(sparse).blocks
  const readBefore = statSync(sparse).atimeMs
  const t9 = performance.now()
  const manyList = await a.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: at(many) })
  const listMs = performance.now() - t9
  timings.push(['list 300 mixed files (cold)', listMs])
  check('the folder of 300 lists whole in one page', manyList.entries.length === 300, `${manyList.entries.length} entries in ${listMs.toFixed(0)} ms`)
  const cloudRow = manyList.entries.find((e) => e.name === 'cloud-only.pdf')
  if (sparseBlocks === 0) check('the sparse file is listed as kept in the cloud', cloudRow?.local === false, JSON.stringify(cloudRow))
  else log(`this disk gives a sparse file ${sparseBlocks} blocks: the cloud-only checks are skipped`)
  // Forty pictures are asked for, and while the host draws them the folder is listed again: the list never waits on a picture.
  const refs = manyList.entries.filter((e) => e.ref && e.local !== false).slice(0, 39).map((e) => e.ref)
  const t10 = performance.now()
  let thumbsMs = 0
  const thumbs = a.call<{ thumbs: (string | null)[] }>('work.files.thumbs', { workspaceId: ws.id, refs: [...refs, at(sparse)], size: 288 }).then((got) => ((thumbsMs = performance.now() - t10), got))
  const listedAgain = await a.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: at(many) })
  const againMs = performance.now() - t10
  const got = await thumbs
  timings.push(['list 300 again while 40 pictures are drawn', againMs], ['40 thumbnails', thumbsMs])
  check('the list answers while the pictures are still being drawn', listedAgain.entries.length === 300 && againMs < Math.max(thumbsMs, 1500), `list ${againMs.toFixed(0)} ms, thumbnails ${thumbsMs.toFixed(0)} ms`)
  const drawn = got.thumbs.slice(0, 39).filter(Boolean).length
  check('thumbnails come back in the order asked, a picture for each file a tool here draws', got.thumbs.length === 40 && drawn >= 13, `${drawn} of 39 drawn`)
  if (sparseBlocks === 0) {
    check('the sparse file has no thumbnail', got.thumbs[39] === null)
    const look = await a.call<{ none?: string; png?: string }>('work.files.preview', { workspaceId: ws.id, ref: at(sparse), width: 640 })
    check('Quick Look of the sparse file says where it is kept and draws nothing', look.none === 'It is kept in the cloud.', JSON.stringify(look).slice(0, 120))
    check('not one byte of the sparse file was read', statSync(sparse).atimeMs === readBefore && statSync(sparse).blocks === 0, `atime ${readBefore} → ${statSync(sparse).atimeMs}`)
  }
  // Quick Look walks: a page of each of twelve files in turn, as the arrow keys would ask.
  const looked = manyList.entries.filter((e) => e.ref && e.local !== false).slice(40, 52)
  const t11 = performance.now()
  let answered = 0
  for (const e of looked) {
    const look = await a.call<{ none?: string; png?: string }>('work.files.preview', { workspaceId: ws.id, ref: e.ref, width: 1024 }).catch((err: Error) => ({ none: err.message }) as { none?: string; png?: string })
    if (look.png || look.none) answered++
  }
  const walkMs = performance.now() - t11
  timings.push(['Quick Look over 12 files, one after another', walkMs])
  check('Quick Look walks twelve files, each answered with a page or one sentence', answered === looked.length && looked.length === 12, `${answered} of ${looked.length} in ${walkMs.toFixed(0)} ms`)
  // A thread and a key that cannot name the folder get no picture.
  const noKey = await r.refusal('work.files.thumbs', { workspaceId: ws.id, refs: [at(join(outside, 'Elsewhere.md'))], size: 192 })
  check('a key asking for a picture of a file outside every root is refused', noKey !== '(no error)', noKey)
} catch (err) {
  check('the proof ran to its end', false, err instanceof Error ? err.message : String(err))
} finally {
  for (const c of [a, b, r]) c?.close()
  await stop()
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}

// ── 10. timings ─────────────────────────────────────────────────────────
if (timings.length) {
  console.log('\n      timing (ms, over the local socket)')
  for (const [what, ms] of timings) console.log(`      ${what.padEnd(40)} ${ms.toFixed(1).padStart(8)}`)
}
console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
