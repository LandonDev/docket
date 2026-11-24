/**
 * The live tab, proven on the box with his real Purdue session (plan g6gWATXhCtN4 M3; docs/agents/work-office-live.md):
 *   heavy bun scripts/e2e-office-live.ts        (in the background: it runs for several minutes)
 *
 * As the trial did (.temp-code/plans/office-live/trial.md), and with no one signing in:
 * 1. A 0700 copy of the box Work browser's profile (Local State and Default, no caches, no sessions) opened in
 *    Playwright's Chromium build, driven over its DevTools; his Microsoft cookies exported from it
 *    (`Storage.getCookies`, what Playwright's `context.cookies()` calls). The live profile is only read.
 * 2. One dummy "TempCode proof live <time>.docx" put in his OWN OneDrive root with SharePoint's REST from the
 *    signed-in page, and opened in a second Chromium page to watch co-authoring.
 * 3. An Electron main (proof-office-live/live-main.ts): the real fence, the cookies in `persist:office-live-purdue0`
 *    before any guest attaches, a page running the real LiveLayer (live-harness.ts), the steps by real calls.
 * 4. Every view closed, the dummy sent to his OneDrive's recycle bin, nothing named "TempCode proof live" left, the
 *    /tmp folder deleted; one picture of the dummy in Word kept under .temp-code/plans/landed/F-office-live/.
 * A signed-out copy stops the run: it never signs in or types a password or code.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Cdp } from '../src/main/server/work/browser/box/cdp'

const REPO = resolve(import.meta.dir, '..')
const MAIN_CHECKOUT = '/srv/agents/work/temp-code'
const LIVE_PROFILE = '/srv/agents/temp-code-data/work-browser/box/profile'
const KEEP_DIR = join(MAIN_CHECKOUT, '.temp-code/plans/landed/F-office-live')
const CHROME = join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome')
const TENANT = 'https://purdue0-my.sharepoint.com'
const PREFIX = 'TempCode proof live'
const DUMMY_TEXT = 'TempCode proof dummy'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (s: string): void => console.log(`[e2e-office-live] ${new Date().toISOString()} ${s}`)

// Chromium and Electron draw on a display of their own: run again under xvfb with a D-Bus session.
if (!process.argv.includes('--inner')) {
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24 -nolisten tcp', 'dbus-run-session', '--', process.execPath, import.meta.path, '--inner'], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

// ── A docx of one line, stored (no compression) ──────────────────────

const head = (size: number): DataView => new DataView(new ArrayBuffer(size))

function zip(files: [string, string][]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of files) {
    const n = enc.encode(name)
    const d = enc.encode(text)
    const crc = Bun.hash.crc32(d)
    const local = head(30 + n.length)
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(12, 33, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, d.length, true)
    local.setUint32(22, d.length, true)
    local.setUint16(26, n.length, true)
    const lb = new Uint8Array(local.buffer)
    lb.set(n, 30)
    const c = head(46 + n.length)
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(14, 33, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, d.length, true)
    c.setUint32(24, d.length, true)
    c.setUint16(28, n.length, true)
    c.setUint32(42, offset, true)
    const cb = new Uint8Array(c.buffer)
    cb.set(n, 46)
    parts.push(lb, d)
    central.push(cb)
    offset += lb.length + d.length
  }
  const size = central.reduce((s, b) => s + b.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, size, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const outBytes = new Uint8Array(all.reduce((s, b) => s + b.length, 0))
  let at = 0
  for (const b of all) {
    outBytes.set(b, at)
    at += b.length
  }
  return outBytes
}

const dummyDocx = (): Uint8Array =>
  zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${DUMMY_TEXT}</w:t></w:r></w:p></w:body></w:document>`]
  ])

// ── The Chromium copy, over DevTools ─────────────────────────────────

/** Skipped in the copy: caches (as the trial left them out) and saved sessions, so no page of his is ever reopened. */
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache', 'Service Worker', 'Sessions', 'Current Session', 'Last Session', 'Current Tabs', 'Last Tabs', 'blob_storage', 'Download Service', 'optimization_guide_model_store'])

class Page {
  constructor(
    readonly cdp: Cdp,
    readonly targetId: string,
    readonly session: string
  ) {}
  static async open(cdp: Cdp, url = 'about:blank'): Promise<Page> {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url })
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    return new Page(cdp, targetId, sessionId)
  }
  async eval<T>(expression: string, timeoutMs = 60_000): Promise<T> {
    const r = await this.cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.session, timeoutMs)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  go(url: string): Promise<unknown> {
    return this.cdp.send('Page.navigate', { url }, this.session)
  }
  async close(): Promise<void> {
    await this.go('about:blank').catch(() => {})
    await sleep(1500)
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
  }
}

/** SharePoint's REST from the signed-in page (same origin, his cookies). Answers `{status, body}`. */
const rest = (page: Page, method: 'GET' | 'POST', url: string, body64?: string): Promise<{ status: number; body: unknown }> =>
  page.eval(`(async () => {
    const h = { Accept: 'application/json;odata=nometadata' }
    if (${JSON.stringify(method)} === 'POST') {
      const c = await fetch(${JSON.stringify(TENANT)} + new URL(${JSON.stringify(url)}).pathname.replace(/\\/_api\\/.*$/, '') + '/_api/contextinfo', { method: 'POST', headers: h })
      if (!c.ok) return { status: c.status, body: 'contextinfo ' + c.status }
      h['X-RequestDigest'] = (await c.json()).FormDigestValue
    }
    const data = ${body64 ? `Uint8Array.from(atob(${JSON.stringify(body64)}), (ch) => ch.charCodeAt(0))` : 'undefined'}
    const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: h, body: data })
    const t = await r.text()
    let b = t; try { b = JSON.parse(t) } catch {}
    return { status: r.status, body: b }
  })()`)

// ── The run ──────────────────────────────────────────────────────────

const dir = mkdtempSync('/tmp/tc-officelive-e2e-')
chmodSync(dir, 0o700)
const r: Record<string, unknown> = {}
let chrome: ChildProcess | null = null
let electron: ChildProcess | null = null
let cdp: Cdp | null = null
let setup: Page | null = null
let coauthor: Page | null = null
let editorSession: string | null = null
let docs: { personal: string; docsPath: string } | null = null
let dummyName: string | null = null
let server: ReturnType<typeof Bun.serve> | null = null

/** The editor frame of Word in the Chromium page (an out-of-process frame), attached once. */
async function editorText(): Promise<string | null> {
  if (!cdp || !coauthor) return null
  if (!editorSession) {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets')
    const t = targetInfos.find((x) => x.type === 'iframe' && /wordeditorframe/i.test(x.url))
    if (!t) return null
    editorSession = (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId
  }
  const v = await cdp
    .send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }, editorSession, 10_000)
    .catch(() => {
      editorSession = null
      return null
    })
  return v?.result.value ?? null
}

async function waitFor<T>(ms: number, probe: () => Promise<T | null | undefined | false>, every = 1000): Promise<T | null> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = await probe().catch(() => null)
    if (v) return v as T
    await sleep(every)
  }
  return null
}

async function run(): Promise<void> {
  // 1. The profile copy, and Chromium on it.
  r.liveBrowserRunning = spawnSync('pgrep', ['-f', `user-data-dir=${LIVE_PROFILE}`]).status === 0
  const copy = join(dir, 'profile')
  mkdirSync(copy, { mode: 0o700 })
  copyFileSync(join(LIVE_PROFILE, 'Local State'), join(copy, 'Local State'))
  cpSync(join(LIVE_PROFILE, 'Default'), join(copy, 'Default'), { recursive: true, filter: (src) => !SKIP.has(basename(src)) && !/^Singleton/.test(basename(src)) })
  log('profile copied')
  chrome = spawn(CHROME, [
    `--user-data-dir=${copy}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--disable-dev-shm-usage',
    '--hide-crash-restore-bubble',
    '--window-size=1400,950',
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  r.chromePid = chrome.pid
  const port = await waitFor(20_000, async () => (existsSync(join(copy, 'DevToolsActivePort')) ? readFileSync(join(copy, 'DevToolsActivePort'), 'utf8').split('\n') : null), 250)
  if (!port) throw new Error('Chromium did not open its DevTools')
  cdp = await Cdp.open(`ws://127.0.0.1:${port[0]}${port[1]}`)
  setup = await Page.open(cdp)

  // His session: SharePoint answers his page, or a sign-in page shows and the run stops.
  await setup.go(`${TENANT}/`)
  const landed = await waitFor(90_000, async () => {
    const at = await setup!.eval<{ href: string; ready: string }>('({ href: location.href, ready: document.readyState })')
    return new URL(at.href).host === new URL(TENANT).host && at.ready === 'complete' ? at.href : null
  }, 1500)
  const where = await setup.eval<string>('location.host').catch(() => 'unknown')
  if (!landed) {
    r.signedOut = true
    r.signedOutAt = where
    log(`STOP: the copy is not signed in (on ${where}); nothing was typed`)
    return
  }
  const me = await rest(setup, 'GET', `${TENANT}/_api/SP.UserProfiles.PeopleManager/GetMyProperties?$select=PersonalUrl`)
  const personal = (me.body as { PersonalUrl?: string })?.PersonalUrl
  if (me.status !== 200 || !personal) {
    r.signedOut = true
    r.signedOutAt = `REST ${me.status}`
    log(`STOP: SharePoint did not answer as him (${me.status})`)
    return
  }
  r.signedIn = true
  const docsPath = `${new URL(personal).pathname.replace(/\/$/, '')}/Documents`
  docs = { personal: personal.replace(/\/$/, ''), docsPath }

  // 2. The dummy in his OneDrive root.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12)
  const name = `${PREFIX} ${stamp}.docx`
  const up = await rest(setup, 'POST', `${docs.personal}/_api/web/GetFolderByServerRelativeUrl('${docsPath}')/Files/add(url='${name}',overwrite=false)`, Buffer.from(dummyDocx()).toString('base64'))
  r.upload = up.status
  if (up.status !== 200) throw new Error(`the upload answered ${up.status}: ${JSON.stringify(up.body).slice(0, 300)}`)
  dummyName = name
  const docUrl = `${TENANT}${docsPath}/${encodeURIComponent(name)}?web=1`
  r.dummy = name
  log(`dummy put: ${name}`)

  // His cookies for Microsoft's sites, for the Electron guest's session.
  const { cookies } = await cdp.send<{ cookies: { domain: string }[] }>('Storage.getCookies')
  const ours = cookies.filter((c) => /(^|\.)(login\.microsoftonline\.com|microsoftonline\.com|sharepoint\.com|office\.com|officeapps\.live\.com|microsoft\.com|cloud\.microsoft)$/i.test(c.domain.replace(/^\./, '')))
  writeFileSync(join(dir, 'cookies.json'), JSON.stringify(ours), { mode: 0o600 })
  r.cookiesExported = ours.length

  // A second, separate Chromium page on the dummy: the co-author that must see the typed line.
  coauthor = await Page.open(cdp, docUrl)
  const coReady = await waitFor(120_000, async () => ((await editorText())?.includes(DUMMY_TEXT) ? true : null), 2000)
  r.coauthorReady = !!coReady
  log(`co-author page ${coReady ? 'has Word up' : 'did not draw Word'}`)

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const text = new URL(req.url).searchParams.get('text') ?? ''
      return Response.json({ seen: !!text && !!(await editorText())?.includes(text) })
    }
  })

  // 3. The Electron main: bundled from the real fence and the real layer.
  for (const [entry, outName, target] of [
    ['live-main.ts', 'main.js', 'node'],
    ['live-preload.ts', 'preload.js', 'node'],
    ['live-harness.ts', 'harness.js', 'browser']
  ] as const) {
    const b = spawnSync('bun', ['build', join(REPO, 'scripts/proof-office-live', entry), `--target=${target}`, ...(target === 'node' ? ['--format=cjs', '--external', 'electron'] : ['--define', 'process.env.NODE_ENV="production"']), '--outfile', join(dir, outName)], { stdio: 'inherit', cwd: REPO })
    if (b.status !== 0) throw new Error(`bundle ${entry} failed`)
  }
  const out = join(dir, 'result.json')
  electron = spawn(join(REPO, 'node_modules', '.bin', 'electron'), [`--user-data-dir=${join(dir, 'electron-data')}`, join(dir, 'main.js')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PROOF_OUT: out, PROOF_DIR: dir, PROOF_URL: docUrl, PROOF_SEEN: `http://127.0.0.1:${server.port}/seen` }
  })
  r.electronPid = electron.pid
  const code = await new Promise<number | null>((res) => {
    const timer = setTimeout(() => {
      r.electronKilled = true
      electron?.kill('SIGTERM')
    }, 480_000)
    electron!.once('exit', (c) => {
      clearTimeout(timer)
      res(c)
    })
  })
  electron = null
  r.electronExit = code
  r.live = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
}

/** Every view closed, the dummy to his recycle bin once Word lets go, the check that nothing of ours is left. */
async function cleanUp(): Promise<void> {
  if (electron) electron.kill('SIGTERM')
  server?.stop(true)
  await coauthor?.close().catch(() => {})
  if (setup && docs) {
    if (dummyName) {
      const path = `${docs.docsPath}/${dummyName}`
      const recycled = await waitFor(240_000, async () => {
        const a = await rest(setup!, 'POST', `${docs!.personal}/_api/web/GetFileByServerRelativeUrl('${path}')/recycle()`)
        if (a.status === 423) log('the file is still locked by Word; waiting')
        return a.status === 200 ? true : a.status === 404 ? true : null
      }, 10_000)
      r.recycled = !!recycled
    }
    // Names only, and only ours are kept.
    const list = await rest(setup, 'GET', `${docs.personal}/_api/web/GetFolderByServerRelativeUrl('${docs.docsPath}')/Files?$select=Name`)
    const names = ((list.body as { value?: { Name: string }[] })?.value ?? []).map((f) => f.Name)
    r.listStatus = list.status
    r.leftOver = list.status === 200 ? names.filter((n) => n.startsWith(PREFIX)) : null
  }
  await setup?.close().catch(() => {})
  if (cdp) {
    await cdp.send('Browser.close').catch(() => {})
    cdp.close()
  }
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise<void>((res) => chrome!.once('exit', () => res()))
    await Promise.race([exited, sleep(10_000)])
    if (chrome.exitCode === null) chrome.kill('SIGTERM')
    await Promise.race([exited, sleep(10_000)])
  }
  // One picture kept: the guest cropped, the dummy in Word.
  const pic = join(dir, 'live-word.png')
  if (existsSync(pic)) {
    mkdirSync(KEEP_DIR, { recursive: true })
    copyFileSync(pic, join(KEEP_DIR, 'live-word.png'))
    r.picture = join(KEEP_DIR, 'live-word.png')
  }
  rmSync(dir, { recursive: true, force: true })
  r.tmpDeleted = !existsSync(dir)
}

try {
  await run()
} catch (e) {
  r.error = String(e instanceof Error ? e.stack : e)
  log(`error: ${r.error}`)
} finally {
  await cleanUp().catch((e) => {
    r.cleanupError = String(e)
  })
}

const L = (r.live ?? {}) as Record<string, any>
console.log(JSON.stringify({ ...r, live: L }, null, 2))
if (r.signedOut) {
  console.log(`FAIL his session in the copy is signed out (${r.signedOutAt}); stopped, nothing typed`)
  process.exit(1)
}
const stages = (L.stages ?? []) as string[]
const ts = L.tabSwitch ?? {}
const checks: [string, boolean][] = [
  ['his session in the copy is signed in, with no one signing in', r.signedIn === true],
  ['the dummy was put in his own OneDrive', r.upload === 200],
  ['one guest attached, on the layer\'s ticket', L.attached === 1],
  ['the layer went to editor, then ready, within 90 s', stages.indexOf('editor') >= 0 && stages.indexOf('ready') > stages.indexOf('editor') && typeof L.readyMs === 'number' && L.readyMs <= 90_000],
  ['Word\'s editor frame drew the dummy within 90 s', L.editorUp === true && typeof L.wordReadyMs === 'number' && L.wordReadyMs <= 90_000],
  ['a picture of the window, cropped to the guest', typeof r.picture === 'string'],
  ['the line typed over the guest\'s DevTools shows in our guest', L.lineInGuest === true],
  ['the line shows in the Chromium page within 20 s (co-authoring)', typeof L.coauthorMs === 'number' && L.coauthorMs <= 20_000],
  ['the guest is under the page at its centre', L.over?.bare === 'webview'],
  ['the dialog (z 90) draws above the guest', L.over?.dialog === 'dialog'],
  ['the menu (z 95) draws above the guest', L.over?.menu === 'menu'],
  ['another tab hides the guest', ts.hiddenVisibility === 'hidden' && ts.after?.visibility === 'visible'],
  ['back on its tab: the same guest, not reloaded (same webContents, marks kept, no top-frame navigation)', ts.before?.id === ts.after?.id && ts.before?.layerId === ts.after?.layerId && !ts.after?.destroyed && ts.before?.topNavs === ts.after?.topNavs && !!ts.mark && ts.marks?.top === ts.mark && ts.marks?.editor === ts.mark],
  ['no did-start-loading while hidden and shown again', ts.before?.startLoads === ts.after?.startLoads],
  ['layer.typed() counts his typing', typeof L.typed === 'number' && L.typed > 0],
  ['layer.leave() answers true and the guest is gone', L.leave?.answer === true && L.leave?.left === true && L.guestDestroyed === true],
  ['the dummy went to his OneDrive\'s recycle bin', r.recycled === true],
  ['nothing named "TempCode proof live" is left', Array.isArray(r.leftOver) && (r.leftOver as string[]).length === 0],
  ['the /tmp folder is deleted', r.tmpDeleted === true],
  ['no time out, no error', !L.timedOut && !r.error && !r.electronKilled]
]
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failed++
}
process.exit(failed ? 1 : 0)
