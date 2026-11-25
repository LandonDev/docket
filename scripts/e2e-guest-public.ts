/**
 * The public proof of live editing by guest link (plan F-live-guest, milestone 4 item 3): the LIVE host on the box, its
 * guest pages on their own origin, reached from two clean headless Chromium profiles through Cloudflare.
 *
 * It reaches the live host only through `tc-local <method> '<json>'` (the host's local socket, the implicit admin) and
 * its public addresses; it never opens his database, his windows or his threads.
 *
 *   0  the root step is applied: https://share.landonhale.com/w/healthz answers 200 from the Work service, and the
 *      guest-origin setting names it. No method reads the setting back, so its one outward sign is read: a guest page
 *      asked for on https://tempcode.landonhale.com answers 308 to the same path on https://share.landonhale.com
 *      (service/routes/guests.ts `elsewhere`). Else "the root step is not applied yet", exit 2, nothing made.
 *   1  a scratch folder "Guest proof <stamp>" in the folder of his Life Work workspace (the box's work root holds only
 *      his workspaces' folders, and the Files methods reach a workspace's own folder alone), and in it
 *      `Guest proof.tcdoc` and `Guest proof.tcsheet` (`work.files.make`); two Edit links ("Proof Guest A", "Proof
 *      Guest B") and one View link ("Proof Reader") on each, ending in 61 minutes (`work.guests.create`; an end under
 *      an hour is refused)
 *   2  the document, then the sheet: two-way live edits between the two guests, presence with both names, the View
 *      link reading, a reload, Revoke of B's link (its page ends within 2 s, A's stays live). Expiry is "not run": no
 *      method sets a link's end, an end under an hour is refused, and this script reaches the host through tc-local
 *      alone, never its store
 *   3  each file's History over tc-local names both guests (`work.history.versions` for the document;
 *      `work.sheets.history` for the sheet, which takes a canvas item: a Files tab of the Life workspace is opened for
 *      that read alone and closed at once)
 *   4  every link it made revoked, the two files and the folder trashed and purged (`work.files.trash`,
 *      `work.files.purge`); the link ids made and revoked written to F-live-guest/M4.md, one picture a side a case in
 *      F-live-guest/M4/. All of 4 also runs in a `finally`, whatever failed; every Chromium is awaited before its
 *      profile goes.
 *
 * Only dummy words: "Bus at 7:30", numbers. No link's secret is printed or written.
 *
 * Run on the box, after the master's root step (root-change.md):
 *   /srv/agents/work/temp-code/.temp-code/bin/heavy bun scripts/e2e-guest-public.ts
 *   --dry   only the check of step 0, then what it would make; exit 2 when the root step is not applied
 *   TC_PROOF_OUT=<dir>  pictures (default the main checkout's .temp-code/plans/landed/F-live-guest/M4)
 *   TC_PROOF_DIR=<dir>  the Chromium profiles (default /tmp/tc-guest-public), removed at the end
 *
 * What it proves: DNS, Cloudflare's edge, TLS, the tunnel, the ingress rule, WebSockets through Cloudflare, the origin
 * rules, and milestones 1 to 3 on the live host. What it does not: another network, a real phone, load, expiry.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChromium } from '../src/main/server/work/browser/box/chromium'
import { Page } from '../src/main/server/work/guests/proofPage'

const DRY = process.argv.includes('--dry')
const ORIGIN = 'https://share.landonhale.com'
const HOST_ORIGIN = 'https://tempcode.landonhale.com'
const PROBE = '/g/probe00000001'
const TC_LOCAL = '/usr/local/bin/tc-local'
const NAMES = { a: 'Proof Guest A', b: 'Proof Guest B', reader: 'Proof Reader' } as const
const ENDED_WORDS = 'This link no longer opens anything'
/** A link's end: an hour is the least the host takes, and a minute more covers the clock between here and there. */
const ENDS_IN_MS = 61 * 60_000
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const mainCheckout = (): string => {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()
  return common ? dirname(common) : REPO
}
const PLANS = join(mainCheckout(), '.temp-code/plans/landed/F-live-guest')
const OUT = process.env.TC_PROOF_OUT ?? join(PLANS, 'M4')
const NOTE_FILE = join(PLANS, 'M4.md')
const SCRATCH = process.env.TC_PROOF_DIR ?? '/tmp/tc-guest-public'

// ── the record ───────────────────────────────────────────────────────────
const lines: string[] = []
const times: [string, string][] = []
let failures = 0
let step = '0'
const check = (label: string, ok: boolean, detail = ''): boolean => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${step} ${label}${detail ? ` (${detail.slice(0, 300)})` : ''}`
  lines.push(line)
  console.log(line)
  if (!ok) failures++
  return ok
}
const notRun = (label: string, why: string): void => {
  const line = `NOT RUN ${step} ${label}: ${why}`
  lines.push(line)
  console.log(line)
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
/** Seen within `budget` of `from`; the time is printed either way. */
const seenWithin = async (label: string, budget: number, from: number, test: () => Promise<boolean>): Promise<boolean> => {
  const seen = await until(Math.max(budget * 10, 15_000), test, 50)
  const ms = Date.now() - from
  timed(label, seen ? `${ms} ms` : 'never')
  return check(`${label} within ${budget / 1000} s`, seen && ms <= budget, seen ? `${ms} ms` : 'never')
}

// ── the live host, through tc-local alone ────────────────────────────────
async function tc<T>(method: string, params: unknown = {}): Promise<T> {
  const env = { ...process.env } as Record<string, string>
  // tc-local reads the box's own host unless this names another: the agent shell may carry a proof's.
  delete env.TEMP_CODE_USER_DATA
  const child = spawn(TC_LOCAL, [method, JSON.stringify(params)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout!.on('data', (c: Buffer) => (out += c.toString()))
  child.stderr!.on('data', (c: Buffer) => (err += c.toString()))
  const code = await new Promise<number | null>((done) => {
    child.once('error', (e) => ((err += e.message), done(1)))
    child.once('close', (c) => done(c))
  })
  if (code !== 0) throw new Error(`${method}: ${err.trim().replace(/^tc-local: /, '') || `exit ${code}`}`)
  return JSON.parse(out) as T
}

/** Step 0: why the root step is not applied, or null when it is. */
async function rootStepMissing(): Promise<string | null> {
  try {
    const res = await fetch(`${ORIGIN}/w/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    void res.body?.cancel().catch(() => {})
    // Every answer of the Work service carries X-Frame-Options: DENY (service/routes/route.ts BASE_HEADERS).
    if (res.status !== 200 || res.headers.get('x-frame-options') !== 'DENY') return `${ORIGIN}/w/healthz answered ${res.status}, not the Work service's 200`
  } catch (err) {
    return `${ORIGIN}/w/healthz did not answer (${(err as Error).message})`
  }
  try {
    const res = await fetch(`${HOST_ORIGIN}${PROBE}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    void res.body?.cancel().catch(() => {})
    const to = res.headers.get('location')
    if (res.status !== 308 || to !== `${ORIGIN}${PROBE}`) return `the guest origin is not set to ${ORIGIN}: ${HOST_ORIGIN}${PROBE} answered ${res.status}${to ? ` to ${to}` : ''}, not 308 to ${ORIGIN}${PROBE}`
  } catch (err) {
    return `${HOST_ORIGIN}${PROBE} did not answer (${(err as Error).message})`
  }
  return null
}

// ── what this run made, so the finally can take it all back ──────────────
type ItemKind = 'document' | 'sheet'
interface MadeLink {
  id: string
  name: string
  role: 'edit' | 'view'
  item: ItemKind
  url: string
  revoked: boolean
}
const made = {
  workspaceId: '',
  workspaceName: '',
  host: '',
  folder: null as string | null,
  files: {} as Partial<Record<ItemKind, string>>,
  links: [] as MadeLink[],
  tab: null as string | null,
  trashed: [] as string[],
  removed: false
}
const op = (what: string): string => `e2e-guest-public-${what}-${randomBytes(4).toString('hex')}`
const fileRef = (path: string) => ({ at: 'file' as const, host: made.host, path })

async function revoke(link: MadeLink): Promise<void> {
  if (link.revoked) return
  await tc('work.guests.revoke', { linkId: link.id })
  link.revoked = true
}

/** Everything made, taken back: links revoked, the Files tab closed, the files and the folder trashed and purged. */
async function takeBack(): Promise<void> {
  for (const link of made.links) await revoke(link).catch((err: Error) => check(`revoke link ${link.id}`, false, err.message))
  if (made.tab) {
    await tc('work.files.tabClose', { workspaceId: made.workspaceId, tabId: made.tab }).catch((err: Error) => check('close the Files tab opened for the sheet History', false, err.message))
    made.tab = null
  }
  const refs = [made.files.document, made.files.sheet, made.folder].filter((p): p is string => !!p && existsSync(p)).map(fileRef)
  if (refs.length) {
    try {
      const done = await tc<{ trashed?: string[]; refused: { name: string; text: string }[] }>('work.files.trash', { workspaceId: made.workspaceId, refs, op: op('trash') })
      made.trashed.push(...(done.trashed ?? []))
      if (done.refused.length) check('trash what this run made', false, done.refused.map((r) => `${r.name}: ${r.text}`).join('; '))
    } catch (err) {
      check('trash what this run made', false, (err as Error).message)
    }
  }
  if (made.trashed.length) await tc('work.files.purge', { workspaceId: made.workspaceId, ids: made.trashed }).catch((err: Error) => check('purge what this run trashed', false, err.message))
  made.removed = [made.files.document, made.files.sheet, made.folder].every((p) => !p || !existsSync(p))
}

// ── the guests' browsers ─────────────────────────────────────────────────
interface Browser {
  name: string
  proc: ChildProcess
  exit: Promise<void>
  debug: number
  profile: string
}
const browsers: Browser[] = []
async function startBrowser(name: string, root: string): Promise<Browser> {
  const bin = findChromium()
  if (!bin) throw new Error("no Chromium (the box's Playwright one)")
  const profile = join(root, name)
  mkdirSync(profile, { recursive: true })
  const proc = spawn(bin, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { env: { ...process.env, HOME: join(root, `${name}-home`) }, stdio: ['ignore', 'ignore', 'pipe'] })
  const exit = new Promise<void>((done) => proc.once('exit', () => done()))
  const debug = await new Promise<number>((ok, fail) => {
    let err = ''
    const timer = setTimeout(() => fail(new Error(`Chromium gave no debug port: ${err.slice(-300)}`)), 30_000)
    proc.stderr!.on('data', (c: Buffer) => {
      err += c.toString()
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)
      if (m) {
        clearTimeout(timer)
        ok(Number(m[1]))
      }
    })
    void exit.then(() => fail(new Error(`Chromium exited: ${err.slice(-300)}`)))
  })
  const b = { name, proc, exit, debug, profile }
  browsers.push(b)
  return b
}
async function stopBrowsers(): Promise<void> {
  for (const b of browsers) {
    if (b.proc.exitCode === null && !b.proc.signalCode) b.proc.kill('SIGTERM')
    if (!(await Promise.race([b.exit.then(() => true), sleep(5000).then(() => false)]))) {
      b.proc.kill('SIGKILL')
      await b.exit
    }
  }
}

/** A tab of `b` on `url`, as a guest's browser opens it: no header of ours rides along (Cloudflare sets its own). */
async function open(b: Browser, url: string): Promise<Page> {
  const p = await Page.open(b.debug)
  await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await p.send('Page.navigate', { url })
  return p
}
/** A tab really closed (CDP `Page.close`), so its sockets end. */
async function closeTab(p: Page | null): Promise<void> {
  if (!p) return
  void p.send('Page.close').catch(() => {})
  await sleep(300)
  p.close()
}
const bodyText = (p: Page): Promise<string> => p.eval<string>('document.body.innerText').catch(() => '')
const ended = async (p: Page): Promise<boolean> => (await bodyText(p)).includes(ENDED_WORDS)
const shot = async (p: Page, name: string): Promise<void> => {
  try {
    const { data } = await p.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
  } catch (err) {
    note(`no picture ${name}: ${(err as Error).message}`)
  }
}

// ── the document's page ──────────────────────────────────────────────────
const EDITOR = `document.querySelector('.ProseMirror')`
/** The editor's words without the carets' name labels, which sit inside the text. */
const docText = (p: Page): Promise<string> =>
  p.eval<string>(`(() => { const ed = ${EDITOR}; if (!ed) return ''; const c = ed.cloneNode(true); c.querySelectorAll('.bn-collaboration-cursor__base').forEach((e) => e.remove()); return c.textContent })()`)
const docType = async (p: Page, text: string): Promise<void> => {
  await p.eval(`(() => { const ed = ${EDITOR}; const ps = [...ed.querySelectorAll('p')]; const at = ps.at(-1) ?? ed; const r = document.createRange(); r.selectNodeContents(at); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); ed.focus(); return true })()`)
  await p.type(text)
}
const carets = (p: Page): Promise<string[]> => p.eval<string[]>(`[...document.querySelectorAll('.bn-collaboration-cursor__label')].map((e) => e.textContent.trim())`)
const faces = (p: Page): Promise<string[]> => p.eval<string[]>(`[...document.querySelectorAll('[data-guest-faces] [data-person]')].map((e) => e.title)`)

// ── the sheet's page ─────────────────────────────────────────────────────
/** The grid's SheetHandle, found through the format row's `sheet` prop (an Edit page draws the row), as `window.__h`. */
const FIND_GRID = `(() => { for (const el of document.querySelectorAll('*')) { const k = Object.keys(el).find((k) => k.startsWith('__reactFiber$')); if (!k) continue; let f = el[k]; while (f) { const s = f.memoizedProps && f.memoizedProps.sheet; if (s && s.api) { window.__h = s; return true } f = f.return } } return false })()`
const ACTIVE = `(${FIND_GRID}, window.__h.api.getActiveWorkbook().getActiveSheet())`
const shows = (p: Page, r: number, c: number): Promise<string> => p.eval<string>(`(() => { const v = ${ACTIVE}.getRange(${r}, ${c}).getDisplayValue(); return v == null ? '' : String(v) })()`)
const sheetLabels = (p: Page): Promise<string[]> => p.eval<string[]>(`[...document.querySelectorAll('[data-slot=sheet-presence]')].map((e) => e.textContent.trim())`)
/** Typed as a person types: a click gives the grid the keys, the cell is made active, a key starts its editor, Enter ends it. */
async function typeCell(p: Page, r: number, c: number, text: string): Promise<number> {
  const box = await p.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0].getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height } })()`)
  const x = box.x + Math.min(box.w - 20, 46 + 88 * 8 + 40)
  const y = box.y + Math.min(box.h - 20, 20 + 24 * 14 + 10)
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  await sleep(150)
  await p.eval(`(() => { const s = ${ACTIVE}; const x = s.getRange(${r}, ${c}); if (x.activate) x.activate(); else s.setActiveRange(x); return true })()`)
  await sleep(250)
  const first = text[0]!
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: first, text: first, windowsVirtualKeyCode: first.toUpperCase().charCodeAt(0) })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: first, windowsVirtualKeyCode: first.toUpperCase().charCodeAt(0) })
  if (text.length > 1) await p.send('Input.insertText', { text: text.slice(1) })
  await sleep(80)
  const at = Date.now()
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  if (await until(3000, async () => (await shows(p, r, c)) === text, 50)) return at
  // The keys missed the cell (a rig fault): the value goes through the grid's own API, so it still travels the page's own path.
  note(`the keys did not reach row ${r + 1} column ${c + 1}; set through the grid's API`)
  const setAt = Date.now()
  await p.eval(`(${ACTIVE}.getRange(${r}, ${c}).setValue(${JSON.stringify(/^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text)}), true)`)
  return setAt
}

// ── one item, all its cases ──────────────────────────────────────────────
async function item(kind: ItemKind, n: string, a: Browser, b: Browser): Promise<void> {
  step = n
  const links = made.links.filter((l) => l.item === kind)
  const [la, lb, lr] = [links.find((l) => l.name === NAMES.a)!, links.find((l) => l.name === NAMES.b)!, links.find((l) => l.name === NAMES.reader)!]
  const doc = kind === 'document'
  const ready = doc ? `!!${EDITOR} && ${EDITOR}.isContentEditable` : `!!document.querySelector('canvas') && ${FIND_GRID}`
  const pages: Page[] = []
  const tag = doc ? 'doc' : 'sheet'
  try {
    const pa = await open(a, la.url)
    pages.push(pa)
    await pa.until(`${NAMES.a}'s ${kind}`, ready, 60_000)
    const pb = await open(b, lb.url)
    pages.push(pb)
    await pb.until(`${NAMES.b}'s ${kind}`, ready, 60_000)
    check(`both Edit links open the ${kind} through ${ORIGIN}`, (await pa.eval<string>('location.origin')) === ORIGIN && (await pb.eval<string>('location.origin')) === ORIGIN)

    // Two-way live edits.
    if (doc) {
      const one = 'Bus at 7:30.'
      const sentA = Date.now()
      await docType(pa, one)
      await seenWithin(`${NAMES.a}'s words on ${NAMES.b}'s page`, 2000, sentA, async () => (await docText(pb)).includes(one))
      const two = ' Seats: 42.'
      const sentB = Date.now()
      await docType(pb, two)
      await seenWithin(`${NAMES.b}'s words on ${NAMES.a}'s page`, 2000, sentB, async () => (await docText(pa)).includes(two.trim()))
    } else {
      const sentA = await typeCell(pa, 0, 0, 'Bus at 7:30')
      await seenWithin(`${NAMES.a}'s cell A1 on ${NAMES.b}'s grid`, 2000, sentA, async () => (await shows(pb, 0, 0)) === 'Bus at 7:30')
      const sentB = await typeCell(pb, 1, 0, '42')
      await seenWithin(`${NAMES.b}'s cell A2 on ${NAMES.a}'s grid`, 2000, sentB, async () => (await shows(pa, 1, 0)) === '42')
    }
    // Presence with both names: each page draws the other's caret or selection, and their face in its line.
    const named = async (p: Page, who: string): Promise<boolean> => (doc ? await carets(p) : await sheetLabels(p)).includes(who)
    check(`${NAMES.a}'s page names ${NAMES.b} on their ${doc ? 'caret' : 'selection'}`, await until(8000, () => named(pa, NAMES.b)), JSON.stringify(doc ? await carets(pa) : await sheetLabels(pa)))
    check(`${NAMES.b}'s page names ${NAMES.a} on their ${doc ? 'caret' : 'selection'}`, await until(8000, () => named(pb, NAMES.a)), JSON.stringify(doc ? await carets(pb) : await sheetLabels(pb)))
    check(`both faces: ${NAMES.b}'s in ${NAMES.a}'s line, ${NAMES.a}'s in ${NAMES.b}'s`, await until(8000, async () => (await faces(pa)).includes(NAMES.b) && (await faces(pb)).includes(NAMES.a)), JSON.stringify([await faces(pa), await faces(pb)]))
    await shot(pa, `${n}-${tag}-live-guest-a`)
    await shot(pb, `${n}-${tag}-live-guest-b`)

    // The View link reads, and draws nothing to edit with.
    const pr = await open(b, lr.url)
    pages.push(pr)
    const reads = doc
      ? await until(60_000, async () => (await pr.eval<boolean>(`!!${EDITOR} && !${EDITOR}.isContentEditable`)) && (await docText(pr)).includes('Bus at 7:30.'), 250)
      : await until(60_000, async () => (await pr.eval<boolean>(`!!document.querySelector('canvas')`)) && (await bodyText(pr)).includes('Can view') && !(await pr.eval<boolean>(FIND_GRID)), 250)
    check(`the View link opens the ${kind} read only${doc ? ', with both guests\' words' : ' (its line says Can view; no format row)'}`, reads, (await bodyText(pr)).slice(0, 160))
    await shot(pr, `${n}-${tag}-view-reader`)

    // A reload brings everything back.
    const reloadAt = Date.now()
    await pa.send('Page.reload', { ignoreCache: false })
    await sleep(300)
    const back = doc
      ? await until(60_000, async () => (await pa.eval<boolean>(ready)) && (await docText(pa)).includes('Bus at 7:30.') && (await docText(pa)).includes('Seats: 42.'), 100)
      : await until(60_000, async () => (await pa.eval<boolean>(ready)) && (await shows(pa, 0, 0)) === 'Bus at 7:30' && (await shows(pa, 1, 0)) === '42', 100)
    timed(`${tag}: reload to everything back`, back ? `${Date.now() - reloadAt} ms` : 'never (60 s)')
    check(`after a reload ${NAMES.a}'s page holds both guests' edits`, back)
    if (doc) check('…and the editor has focus', await until(5000, () => pa.eval<boolean>(`!!${EDITOR} && !!document.activeElement && ${EDITOR}.contains(document.activeElement)`)))
    await shot(pa, `${n}-${tag}-reload-guest-a`)

    // Revoke B's link: B's page ends within 2 s, A's stays live.
    const revokeAt = Date.now()
    await revoke(lb)
    await seenWithin(`${NAMES.b}'s page ends after Revoke`, 2000, revokeAt, () => ended(pb))
    await sleep(3000)
    if (doc) {
      const more = ' Back at 3:15.'
      const sent = Date.now()
      await docType(pa, more)
      check(`${NAMES.a}'s page stays live: not ended, and a new edit reaches the reader`, !(await ended(pa)) && (await until(15_000, async () => (await docText(pr)).includes(more.trim()), 100)), `${Date.now() - sent} ms`)
    } else {
      await typeCell(pa, 2, 0, '7')
      const quiet = await until(15_000, async () => !(await ended(pa)) && (await pa.eval<boolean>(`!document.querySelector('[data-sheet-offline], [data-sheet-refused], [data-sheet-dropped]')`)), 250)
      check(`${NAMES.a}'s page stays live: not ended, a new edit taken with no offline, refused or dropped line`, quiet && (await shows(pa, 2, 0)) === '7')
    }
    await shot(pb, `${n}-${tag}-revoked-guest-b`)
    await shot(pa, `${n}-${tag}-revoked-guest-a`)

    notRun(
      `expiry of a ${kind} link with its page open`,
      'the host takes no end under an hour ("A link ends at least an hour from now."), no method sets a link\'s end, and this run reaches the live host through tc-local alone, never its store; milestone 1\'s isolated proofs cover expiry'
    )
  } finally {
    for (const p of pages) await closeTab(p)
  }
}

// ── the run ──────────────────────────────────────────────────────────────
const startedAt = new Date()
let profiles: string | null = null
let commit = ''
try {
  step = '0'
  const missing = await rootStepMissing()
  if (missing) {
    console.log(`the root step is not applied yet: ${missing}`)
    process.exit(2)
  }
  check(`${ORIGIN}/w/healthz answers 200 from the Work service, and the guest origin is ${ORIGIN} (the 308 from ${HOST_ORIGIN})`, true)
  const workspaces = await tc<{ id: string; name: string; kind?: string; sector?: string; path: string }[]>('workspace.list')
  const life = workspaces.find((w) => w.kind === 'work' && w.sector === 'life')
  if (!life) {
    console.log('no Life Work workspace on the box: nothing made')
    process.exit(2)
  }
  made.workspaceId = life.id
  made.workspaceName = life.name
  made.host = (await tc<{ environmentId: string }>('remote.status')).environmentId
  const stamp = startedAt.toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
  const folderName = `Guest proof ${stamp}`
  if (DRY) {
    console.log(`would make, in ${life.name}'s folder (workspace ${life.id}, host ${made.host}):`)
    console.log(`  ${join(life.path, folderName)}/  with  Guest proof.tcdoc  and  Guest proof.tcsheet`)
    console.log(`  on each: Edit links for "${NAMES.a}" and "${NAMES.b}", a View link for "${NAMES.reader}", ending in ${ENDS_IN_MS / 60_000} minutes`)
    console.log('then drive two clean Chromium profiles through', ORIGIN, 'and take everything back')
    process.exit(0)
  }
  mkdirSync(OUT, { recursive: true })
  mkdirSync(SCRATCH, { recursive: true })
  profiles = realpathSync(mkdtempSync(join(SCRATCH, 'run-')))
  commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()

  // 1: the scratch folder, the two files, the six links.
  step = '1'
  const folder = await tc<{ entries: { folder: { path?: string } | null; ref: { path?: string } | null }[]; refused: { text: string }[] }>('work.files.make', { workspaceId: life.id, at: fileRef(life.path), kind: 'folder', name: folderName, op: op('folder') })
  made.folder = folder.entries[0]?.folder?.path ?? folder.entries[0]?.ref?.path ?? null
  if (!check(`a scratch folder "${folderName}" in ${life.name}'s folder`, !!made.folder && existsSync(made.folder), folder.refused.map((r) => r.text).join('; ') || (made.folder ?? ''))) throw new Error('no scratch folder')
  for (const kind of ['document', 'sheet'] as const) {
    const got = await tc<{ entries: { ref: { path?: string } | null }[]; refused: { text: string }[] }>('work.files.make', { workspaceId: life.id, at: fileRef(made.folder!), kind, name: 'Guest proof', op: op(kind) })
    const path = got.entries[0]?.ref?.path
    if (path) made.files[kind] = path
    const ext = kind === 'document' ? '.tcdoc' : '.tcsheet'
    if (!check(`Guest proof${ext} made in it`, !!path && path.endsWith(ext) && existsSync(path), got.refused.map((r) => r.text).join('; ') || (path ?? ''))) throw new Error(`no ${ext}`)
  }
  const expiresAt = Date.now() + ENDS_IN_MS
  for (const kind of ['document', 'sheet'] as const) {
    for (const [name, role] of [[NAMES.a, 'edit'], [NAMES.b, 'edit'], [NAMES.reader, 'view']] as const) {
      const got = await tc<{ link: { id: string }; url: string }>('work.guests.create', { source: fileRef(made.files[kind]!), title: 'Guest proof', name, role, expiresAt })
      made.links.push({ id: got.link.id, name, role, item: kind, url: got.url, revoked: false })
      if (!check(`${role === 'edit' ? 'an Edit' : 'a View'} link on the ${kind} for ${name} (${got.link.id}), on ${ORIGIN}`, new URL(got.url).origin === ORIGIN, new URL(got.url).origin)) throw new Error('a link names another origin')
    }
  }

  // 2: two clean profiles, the document then the sheet.
  const a = await startBrowser('guest-a', profiles)
  const b = await startBrowser('guest-b', profiles)
  for (const [kind, n] of [['document', '2'], ['sheet', '3']] as const) {
    try {
      await item(kind, n, a, b)
    } catch (err) {
      check(`the ${kind}'s cases ran to their end`, false, (err as Error).message)
    }
  }

  // 3: History names both guests (their sockets have closed: a document's guest-end versions are cut then).
  step = '4'
  await sleep(4000)
  type Versions = { versions: { cause: string; by: string[] }[]; names: Record<string, string> }
  let docHistory: Versions = { versions: [], names: {} }
  const docNamed = await until(30_000, async () => {
    docHistory = await tc<Versions>('work.history.versions', { source: fileRef(made.files.document!) })
    const who = new Set(docHistory.versions.flatMap((v) => v.by.map((p) => docHistory.names[p])))
    return who.has(NAMES.a) && who.has(NAMES.b)
  }, 1000)
  check(`the document's History names ${NAMES.a} and ${NAMES.b}`, docNamed, JSON.stringify(docHistory.versions.slice(0, 6).map((v) => [v.cause, v.by.map((p) => docHistory.names[p] ?? p)])))
  // The sheet's History is asked by canvas item: a Files tab of the workspace, opened for this read and closed at once.
  const tab = await tc<{ tabId?: string; item?: { id: string } }>('work.files.open', { workspaceId: life.id, ref: fileRef(made.files.sheet!), name: 'Guest proof.tcsheet' })
  if (tab.tabId) made.tab = tab.tabId
  type Revisions = { revisions: { by: string; label: string }[]; names: Record<string, string> }
  let sheetHistory: Revisions = { revisions: [], names: {} }
  const sheetNamed =
    !!tab.item &&
    (await until(30_000, async () => {
      sheetHistory = await tc<Revisions>('work.sheets.history', { itemId: tab.item!.id })
      // A host from before History named a sheet's writers answers no names: then nobody is named, and the check says so.
      const names = sheetHistory.names ?? {}
      const who = new Set(sheetHistory.revisions.map((r) => names[r.by]))
      return who.has(NAMES.a) && who.has(NAMES.b)
    }, 1000))
  check(`the sheet's History names ${NAMES.a} and ${NAMES.b}`, sheetNamed, JSON.stringify(sheetHistory.revisions.slice(0, 6).map((r) => [r.label, (sheetHistory.names ?? {})[r.by] ?? r.by])))
  if (made.tab) {
    await tc('work.files.tabClose', { workspaceId: life.id, tabId: made.tab })
    made.tab = null
  }
} catch (err) {
  check('the run ran to its end', false, err instanceof Error ? err.message : String(err))
} finally {
  // 4: everything made, taken back; every browser awaited before its profile goes.
  step = '5'
  if (!DRY) {
    await takeBack()
    await stopBrowsers()
    if (profiles) rmSync(profiles, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    try {
      if (existsSync(SCRATCH) && readdirSync(SCRATCH).length === 0) rmSync(SCRATCH, { recursive: true, force: true })
    } catch {
      /* someone else's */
    }
    if (made.links.length || made.folder) {
      check('every link it made is revoked', made.links.every((l) => l.revoked), made.links.filter((l) => !l.revoked).map((l) => l.id).join(', '))
      check('the two files and the scratch folder are gone', made.removed, [made.files.document, made.files.sheet, made.folder].filter((p) => p && existsSync(p)).join(', '))
      writeNote()
    }
  }
}
process.exit(failures ? 1 : 0)

function writeNote(): void {
  const pictures = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith('.png')).sort() : []
  const text = [
    '# Live editing by guest link: the public proof (milestone 4)',
    '',
    `Run ${startedAt.toISOString()} on the box against the LIVE host (through \`tc-local\` and ${ORIGIN}), by \`bun scripts/e2e-guest-public.ts\` at ${commit || '(no commit read)'}.`,
    `Workspace: ${made.workspaceName} (\`${made.workspaceId}\`, host \`${made.host}\`), his Life Work workspace; nothing of it was touched but the scratch folder made and removed in its folder.`,
    '',
    `**${failures ? `${failures} FAILED` : 'ALL PASS'}**`,
    '',
    '## Links made and revoked',
    '',
    '| Link id | For | Can | On | Revoked |',
    '|---|---|---|---|---|',
    ...made.links.map((l) => `| \`${l.id}\` | ${l.name} | ${l.role} | ${l.item} | ${l.revoked ? 'yes' : '**no**'} |`),
    '',
    '## Files made and removed',
    '',
    `- folder \`${made.folder ?? '(none)'}\``,
    `- \`${made.files.document ?? '(none)'}\``,
    `- \`${made.files.sheet ?? '(none)'}\``,
    `- trashed and purged: ${made.removed ? 'all gone from the disk' : '**not all gone**'} (bin rows ${made.trashed.join(', ') || 'none'})`,
    '',
    '## Checks',
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    '## Times',
    '',
    '| What | Measured |',
    '|---|---|',
    ...times.map(([w, v]) => `| ${w} | ${v} |`),
    '',
    '## What this proves, and what it does not',
    '',
    '- Proves: DNS, Cloudflare\'s edge, TLS, the tunnel, the ingress rule, WebSockets through Cloudflare, the origin rules, and milestones 1 to 3 on the live host.',
    '- Does not: another network (both guests ran on the box), a real phone, load, or expiry (not run: see its line).',
    '',
    '## Pictures (F-live-guest/M4/)',
    '',
    ...pictures.map((p) => `- ${p}`),
    ''
  ].join('\n')
  writeFileSync(NOTE_FILE, text)
  console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASS'}; ${NOTE_FILE}`)
}
