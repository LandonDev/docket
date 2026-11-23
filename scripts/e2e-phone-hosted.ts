/**
 * The owner's hosted editor on a phone (PF4; docs/agents/work-guests.md "The owner's hosted editor"):
 * a document and a sheet kept as files, opened from a ticket in a real WebKit at phone width.
 *
 *   bun run script:e2e-phone-hosted
 *
 * One isolated host: the iOS test server with its Work service in process (TC_TEST_WORK_SERVICE=1), serving the
 * hosted pages built here (Vite's CLI on scripts/hosted.vite.config.ts) on a port of its own, which is also the
 * public origin a ticket names (TEMP_CODE_WORK_PUBLIC_ORIGIN). Its data and Work root are under a scratch folder.
 * The seeds are the phone's review seeds (scripts/lib/ios-work-seeds.ts `seedReview`): a memo kept as a .tcdoc with
 * a comment thread and a waiting suggestion, a budget kept as a .tcsheet with a waiting change set, and beside them a
 * Word and an Excel file. Each is asked for a ticket (`work.guests.ticket {source: {at: 'item'}}`) with an operate
 * key, as the phone asks. WebKit opens the memo, types at the end of its first paragraph and reads the text back
 * through doc_read and from the file; opens the budget, types 525 into B5 and reads it back through sheet_read. The
 * Word and Excel tickets must be refused in words, and a used ticket must redeem to 403. With the memo and the
 * budget open as the owner, the page's comments, comment control, suggestions and marked cells are looked for.
 *
 * Writes PASS and FAIL lines, the pictures and report.md to TC_PROOF_OUT (default: the main checkout's
 * .temp-code/plans/landed/R3-phone-files/hosted). Run it through the box's heavy queue: it builds, starts a server
 * and a browser, and ends both.
 *
 *   TC_HOSTED_DIR=<built out/hosted>   skip the build
 *   TC_PLAYWRIGHT_CORE=<dir>           playwright-core 1.64.1 (its WebKit is webkit-2370 under ~/.cache/ms-playwright)
 *   TC_WEBKIT=<pw_run.sh>              a WebKit to launch in its place: on a host missing WebKit's system libraries, a copy of
 *                                      webkit-2370 with them unpacked into minibrowser-wpe/sys/lib (the box has no sudo)
 *   TC_WEBKIT_MESA=<dir>               an unpacked Mesa (usr/lib/x86_64-linux-gnu with dri/ and gbm/, usr/share/glvnd): headless
 *                                      WPE draws through EGL, and a host with no Mesa answers "Could not create EGL display"
 *   TC_PROOF_DIR=<dir>                 the scratch folder (default /tmp/tc-phone-hosted)
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { bundleNodeScript } from './lib/bundle-node-script'
import { REVIEW_MEMO, REVIEW_MEMO_TITLE, REVIEW_SHEET_TITLE, seedReview, socket, workTools, type WorkSeedReady } from './lib/ios-work-seeds'

const repo = resolve(import.meta.dir, '..')
const scratch = process.env.TC_PROOF_DIR ?? '/tmp/tc-phone-hosted'
const mainCheckout = (): string => {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  return common ? dirname(common) : repo
}
const out = process.env.TC_PROOF_OUT ?? join(mainCheckout(), '.temp-code/plans/landed/R3-phone-files/hosted')
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const TYPED_DOC = ' Confirmed.'
const TYPED_CELL = '525'
const WORD_TITLE = 'Trip itinerary'
const EXCEL_TITLE = 'Trip costs'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const lines: string[] = []
const say = (line: string): void => {
  lines.push(line)
  console.log(line)
}
type Row = { kind: string; opened: string; edited: string; readBack: string }
const rows: Row[] = []
const draws: { doc: string[]; sheet: string[] } = { doc: [], sheet: [] }
const shots: string[] = []

async function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = createServer()
    s.once('error', bad)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => ok(port))
    })
  })
}

/** Polls `read` until `done` holds or the time is up; answers the last read. */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number): Promise<{ value: T; held: boolean }> {
  const end = Date.now() + ms
  let value = await read()
  while (!done(value) && Date.now() < end) {
    await sleep(500)
    value = await read()
  }
  return { value, held: done(value) }
}

// ── build, then one isolated host ───────────────────────────────────────

rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
mkdirSync(out, { recursive: true })
// A run's pictures are its own: the last run's go first.
for (const f of readdirSync(out)) if (f.endsWith('.png')) rmSync(join(out, f))
let hosted = process.env.TC_HOSTED_DIR ?? ''
if (!hosted) {
  hosted = join(scratch, 'hosted')
  console.log(`e2e-phone-hosted: building the hosted pages into ${hosted}`)
  const built = spawnSync(process.execPath, [resolve(repo, 'node_modules/vite/bin/vite.js'), 'build', '--config', resolve(repo, 'scripts/hosted.vite.config.ts')], { cwd: repo, stdio: 'inherit', env: { ...process.env, TEMP_CODE_HOSTED_OUT: hosted } })
  if (built.status !== 0) {
    console.error('e2e-phone-hosted: the hosted build failed')
    process.exit(1)
  }
}
if (!existsSync(join(hosted, 'guest', 'index.html'))) {
  console.error(`e2e-phone-hosted: ${hosted} holds no guest/index.html`)
  process.exit(1)
}
const serverOut = resolve(repo, 'scripts/.out/ios-client-test-server.mjs')
const broker = resolve(repo, 'scripts/.out/ios-test-exec-broker.mjs')
for (const [src, dst, opts] of [
  ['scripts/ios-client-test-server.ts', serverOut, { server: true }],
  ['scripts/lib/ios-test-exec-broker.ts', broker, undefined]
] as const) {
  const err = await bundleNodeScript(repo, src, dst, opts)
  if (err) {
    console.error(err)
    process.exit(1)
  }
}
const workPort = await freePort()
const origin = `http://127.0.0.1:${workPort}`
mkdirSync(join(scratch, 'userdata'), { recursive: true })
mkdirSync(join(scratch, 'work-root'), { recursive: true })
const server = spawn('node', [serverOut], {
  cwd: repo,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    TC_PROOF_SET: 'work',
    TC_TEST_WORK_SERVICE: '1',
    TC_TEST_HOSTED_DIR: hosted,
    TC_TEST_EXEC_BROKER: broker,
    TC_TEST_NO_RELAY: '1',
    TC_TEST_NO_HARNESS: '1',
    TEMP_CODE_USER_DATA: join(scratch, 'userdata'),
    TEMP_CODE_WORK_ROOT: join(scratch, 'work-root'),
    TEMP_CODE_WORK_PORT: String(workPort),
    TEMP_CODE_WORK_PUBLIC_ORIGIN: origin
  }
})
let serverLog = ''
server.stderr.on('data', (c: Buffer) => {
  serverLog = (serverLog + c.toString()).slice(-200_000)
})
type Ready = WorkSeedReady & { environmentId: string; operateKey: string }
const ready = await new Promise<Ready>((ok, bad) => {
  let buf = ''
  const timer = setTimeout(() => bad(new Error('the test server did not come up in 180 s')), 180_000)
  server.stdout.on('data', (c: Buffer) => {
    buf += c.toString()
    const line = buf.split('\n').find((l) => l.startsWith('{') && l.includes('"ready":true'))
    if (!line) return
    clearTimeout(timer)
    ok(JSON.parse(line) as Ready)
  })
  server.on('exit', (code) => bad(new Error(`the test server exited with ${code}\n${serverLog.slice(-4000)}`)))
}).catch((err: unknown) => {
  console.error(String(err))
  server.kill('SIGKILL')
  process.exit(1)
})
console.log(`e2e-phone-hosted: host on ${ready.baseUrl}, its hosted pages on ${origin}`)

let browser: { close(): Promise<void>; newContext(o: unknown): Promise<any> } | null = null
try {
  // ── the seeds ─────────────────────────────────────────────────────────
  const admin = await socket(ready)
  let purdue: string
  let sessionId: string
  let dir: string
  try {
    await admin.call('work.set', { enabled: true })
    purdue = (await admin.call<{ id: string }>('workspace.create', { kind: 'work', name: 'Purdue Esports', sector: 'purdue' })).id
    sessionId = (await admin.call<{ id: string }>('session.create', { scope: 'work', workspaceId: purdue, threadType: 'chat', provider: 'claude', model: 'claude-opus-5-5', title: 'Regional trip' })).id
    const workspaces = await admin.call<{ id: string; path: string }[]>('workspace.list', {})
    dir = `${workspaces.find((w) => w.id === purdue)!.path}/Regional trip`
  } finally {
    admin.close()
  }
  const seeded = await seedReview(ready, purdue, sessionId)
  for (const l of seeded.lines) say(l.startsWith('NOT RUN') ? `FAIL seed ${l}` : l)
  // A Word and an Excel file beside them, written by the app's own writers.
  const kit = resolve(repo, 'node_modules/work-kit/src/formats')
  const { readMarkdown } = (await import(`${kit}/markdown/index.ts`)) as { readMarkdown: (t: string) => { blocks: unknown[]; sidecar: unknown } }
  const { writeDocx } = (await import(`${kit}/docx/index.ts`)) as { writeDocx: (b: unknown[], s: unknown) => Promise<Uint8Array> }
  const { readCsv, writeXlsx } = (await import(resolve(repo, 'src/main/server/work/sheets/writer.ts'))) as { readCsv: (t: string, id: string, n: string) => unknown; writeXlsx: (wb: unknown) => Uint8Array }
  const itinerary = readMarkdown('Friday: leave at 7:00 AM.\n\nSaturday: matches from 9:00 AM.')
  const wordPath = `${dir}/${WORD_TITLE}.docx`
  const excelPath = `${dir}/${EXCEL_TITLE}.xlsx`
  writeFileSync(wordPath, await writeDocx(itinerary.blocks, itinerary.sidecar))
  writeFileSync(excelPath, writeXlsx(readCsv('Item,Cost\nBus,1200\nHotel,960\n', 'workbook', 'Costs')))
  const phone = await socket(ready, ready.operateKey)
  const host = ready.environmentId
  const a = await socket(ready)
  try {
    await a.call('work.canvas.open', { sessionId, kind: 'document', title: WORD_TITLE, source: { at: 'file', host, path: wordPath } })
    await a.call('work.canvas.open', { sessionId, kind: 'sheet', title: EXCEL_TITLE, source: { at: 'file', host, path: excelPath } })
  } finally {
    a.close()
  }
  const { items } = await phone.call<{ items: { id: string; kind: string; title: string; source: { path?: string } }[] }>('work.canvas.list', { sessionId })
  const item = (title: string) => items.find((i) => i.title === title)
  const memo = item(REVIEW_MEMO_TITLE)
  const budget = item(REVIEW_SHEET_TITLE)
  const ticket = async (title: string): Promise<{ url: string } | { refused: string }> => {
    const it = item(title)
    if (!it) return { refused: `no item "${title}" is open` }
    try {
      return await phone.call<{ url: string }>('work.guests.ticket', { source: { at: 'item', itemId: it.id }, title })
    } catch (err) {
      return { refused: String(err).replace(/^Error: work\.guests\.ticket: /, '') }
    }
  }

  // ── Word and Excel: refused in words ──────────────────────────────────
  const { TICKET_REFUSALS } = (await import(resolve(repo, 'src/main/server/work/guests/links.ts'))) as { TICKET_REFUSALS: Record<string, string> }
  for (const [title, kind, want] of [
    [WORD_TITLE, '.docx', TICKET_REFUSALS.word],
    [EXCEL_TITLE, '.xlsx', TICKET_REFUSALS.excel]
  ] as const) {
    const got = await ticket(title)
    const words = 'refused' in got ? got.refused : `opened at ${got.url.split('#')[0]}`
    const pass = 'refused' in got && got.refused.includes(want)
    say(`${pass ? 'PASS' : 'FAIL'} ${kind} "${title}": ${words}`)
    rows.push({ kind, opened: 'refused' in got ? `refused: "${got.refused}"` : 'yes (it should not)', edited: 'no', readBack: 'no' })
  }

  // ── WebKit at phone width ─────────────────────────────────────────────
  const core =
    process.env.TC_PLAYWRIGHT_CORE ??
    [join(homedir(), '.temp-code/t32-pw/node_modules/playwright-core'), join(homedir(), '.bun/install/cache/playwright-core@1.64.1@@@1')].find((d) => existsSync(join(d, 'index.js')))
  if (!core) throw new Error('no playwright-core 1.64.1: set TC_PLAYWRIGHT_CORE')
  const { webkit } = (await import(join(core, 'index.js'))) as { webkit: { launch(o: unknown): Promise<NonNullable<typeof browser>> } }
  const mesa = process.env.TC_WEBKIT_MESA
  const lib = mesa ? join(mesa, 'usr/lib/x86_64-linux-gnu') : ''
  const mesaEnv = mesa
    ? { __EGL_VENDOR_LIBRARY_FILENAMES: join(mesa, 'usr/share/glvnd/egl_vendor.d/50_mesa.json'), LIBGL_DRIVERS_PATH: join(lib, 'dri'), GBM_BACKENDS_PATH: join(lib, 'gbm'), EGL_PLATFORM: 'surfaceless', LIBGL_ALWAYS_SOFTWARE: '1' }
    : {}
  browser = await webkit.launch({ headless: true, env: { ...process.env, ...mesaEnv }, ...(process.env.TC_WEBKIT ? { executablePath: process.env.TC_WEBKIT } : {}) })
  const phoneContext = () => browser!.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: PHONE_UA, colorScheme: 'light' })
  const shoot = async (page: { screenshot(o: unknown): Promise<unknown> }, name: string): Promise<void> => {
    await page.screenshot({ path: join(out, name) })
    shots.push(name)
  }
  const docRead = async (): Promise<string> => {
    const [got] = await workTools(ready, [{ sessionId, tool: 'doc_read', args: { item: memo!.id } }])
    return got.failed ? `(doc_read failed: ${got.text})` : got.text
  }

  // The memo.
  let usedTicket: string | null = null
  if (!memo) say(`FAIL .tcdoc: no "${REVIEW_MEMO_TITLE}" is open`)
  else {
    const t = await ticket(REVIEW_MEMO_TITLE)
    if ('refused' in t) {
      say(`FAIL .tcdoc ticket refused: ${t.refused}`)
      rows.push({ kind: '.tcdoc', opened: `refused: "${t.refused}"`, edited: 'no', readBack: 'no' })
    } else {
      usedTicket = new URLSearchParams(t.url.split('#')[1]).get('t')
      const context = await phoneContext()
      const page = await context.newPage()
      const consoleLines: string[] = []
      page.on('console', (m: { type(): string; text(): string }) => consoleLines.push(`${m.type()}: ${m.text()}`))
      await page.goto(t.url)
      const opened = await page
        .waitForFunction((words: string) => document.querySelector('.ProseMirror')?.textContent?.includes(words), REVIEW_MEMO[0].slice(0, 30), { timeout: 30_000 })
        .then(() => true, () => false)
      await sleep(1500)
      await shoot(page, 'memo-open.png')
      say(`${opened ? 'PASS' : 'FAIL'} .tcdoc: the editor opened with the memo's text${opened ? '' : `; console: ${consoleLines.slice(-5).join(' | ')}`}`)
      if (opened) {
        // What the owner's page draws of the comments and the suggestion.
        const facts = (await page.evaluate(() => {
          const count = (q: string) => document.querySelectorAll(q).length
          const controls = [...document.querySelectorAll('button, [role=button]')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean)
          return {
            threadMarks: count('.bn-thread-mark'),
            threadCards: count('[data-thread-card], [data-thread]'),
            reviewMarks: count('[data-change], .te-ins, .te-del'),
            controls,
            title: document.querySelector('header')?.textContent?.trim() ?? ''
          }
        })) as { threadMarks: number; threadCards: number; reviewMarks: number; controls: string[]; title: string }
        draws.doc.push(`header line: "${facts.title}"; buttons on the page: ${facts.controls.length ? facts.controls.map((c) => `"${c}"`).join(', ') : 'none'}`)
        draws.doc.push(`comment marks on the words (.bn-thread-mark): ${facts.threadMarks}; thread cards or margin rows: ${facts.threadCards}`)
        draws.doc.push(`suggestion marks ([data-change], .te-ins, .te-del): ${facts.reviewMarks}; an Accept or Reject control: ${facts.controls.some((c) => /accept|reject/i.test(c)) ? 'yes' : 'no'}`)
        // Select the words the agent's comment is on, as a long press would: is there a Comment control?
        await page.evaluate((quote: string) => {
          const root = document.querySelector('.ProseMirror')!
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const at = n.textContent!.indexOf(quote)
            if (at < 0) continue
            const r = document.createRange()
            r.setStart(n, at)
            r.setEnd(n, at + quote.length)
            const sel = document.getSelection()!
            sel.removeAllRanges()
            sel.addRange(r)
            return
          }
        }, 'the charter bus')
        await sleep(1200)
        await shoot(page, 'memo-selected.png')
        const selected = (await page.evaluate(() =>
          [...document.querySelectorAll('button, [role=button], [role=menuitem]')]
            .filter((b) => (b as HTMLElement).offsetParent !== null)
            .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim())
            .filter(Boolean)
        )) as string[]
        const comment = selected.find((c) => /^comment$/i.test(c))
        draws.doc.push(`with "the charter bus" selected, the controls shown: ${selected.length ? selected.map((c) => `"${c}"`).join(', ') : 'none'}; a Comment control: ${comment ? 'yes' : 'no'}`)
        if (comment) try {
          await page.locator('button, [role=button], [role=menuitem]').filter({ hasText: /^Comment$/ }).first().click({ timeout: 10_000 })
          await sleep(800)
          await shoot(page, 'memo-comment-pressed.png')
          const after = (await page.evaluate(() => document.body.innerText.slice(0, 4000))) as string
          draws.doc.push(`after pressing Comment, the page reads: ${JSON.stringify(after.split('\n').filter((l) => /comment|tempcode/i.test(l)).slice(0, 4))}`)
          // Write one and send it, as he would: does the owner's comment go through?
          await page.keyboard.type('Owner comment from the phone', { delay: 20 })
          // Enter breaks the line in the composer; Ctrl+Enter sends, as its arrow does (work-kit/editor comment-composer.tsx).
          await page.keyboard.press('Control+Enter')
          await sleep(2000)
          await shoot(page, 'memo-comment-sent.png')
          const sent = (await page.evaluate(() => document.body.innerText)) as string
          const errors = (await page.evaluate(() => [...document.querySelectorAll('[role=alert], [role=status], [data-error], .text-destructive')].map((e) => e.textContent?.trim() ?? '').filter(Boolean))) as string[]
          const { rows: threadRows } = await (async () => {
            const s = await socket(ready)
            try {
              return await s.call<{ rows: { comments: { body: string }[] }[] }>('work.docs.threads', { source: memo.source })
            } finally {
              s.close()
            }
          })()
          const landed = threadRows.some((r) => r.comments.some((c) => c.body.includes('Owner comment from the phone')))
          draws.doc.push(`after typing a comment and sending it (Ctrl+Enter): the host ${landed ? 'holds it' : 'holds no such comment'}; the page's words about it: ${JSON.stringify([...errors, ...sent.split('\n').filter((l) => /tempcode|did not|try again|could not|failed/i.test(l))].slice(0, 5))}`)
          await page.keyboard.press('Escape')
          await sleep(300)
        } catch (err) {
          draws.doc.push(`making a comment could not be driven: ${String(err).split('\n')[0]}`)
        }
        await page.evaluate(() => document.getSelection()?.removeAllRanges())

        // Type at the end of the first paragraph, as a tap there and the keyboard would.
        const before = statSync(memo.source.path!).mtimeMs
        const first = page.locator('.ProseMirror p').first()
        await first.tap()
        await page.evaluate(() => {
          const p = document.querySelector('.ProseMirror p')!
          const r = document.createRange()
          r.selectNodeContents(p)
          r.collapse(false)
          const sel = document.getSelection()!
          sel.removeAllRanges()
          sel.addRange(r)
        })
        await page.keyboard.type(TYPED_DOC, { delay: 40 })
        const shown = await page
          .waitForFunction((w: string) => document.querySelector('.ProseMirror p')?.textContent?.endsWith(w.trim()), TYPED_DOC, { timeout: 10_000 })
          .then(() => true, () => false)
        const read = await until(docRead, (t) => t.includes(`${REVIEW_MEMO[0]}${TYPED_DOC}`), 30_000)
        const saved = await until(
          async () => {
            const m = statSync(memo.source.path!).mtimeMs
            return { m, text: m > before ? await fileText(memo.source.path!) : '' }
          },
          (v) => v.m > before && v.text.includes(TYPED_DOC.trim()),
          90_000
        )
        await shoot(page, 'memo-edited.png')
        say(`${shown ? 'PASS' : 'FAIL'} .tcdoc: "${TYPED_DOC.trim()}" typed at the end of the first paragraph shows in the editor`)
        say(`${read.held ? 'PASS' : 'FAIL'} .tcdoc: doc_read holds "${REVIEW_MEMO[0]}${TYPED_DOC}"${read.held ? '' : `; it read ${JSON.stringify(read.value.slice(0, 300))}`}`)
        say(`${saved.held ? 'PASS' : 'FAIL'} .tcdoc: the file on disk changed (mtime ${new Date(before).toISOString()} → ${new Date(saved.value.m).toISOString()}) and still opens holding the words${saved.held ? '' : `; its text: ${JSON.stringify(saved.value.text.slice(0, 200))}`}`)
        rows.push({ kind: '.tcdoc', opened: 'yes', edited: shown ? `yes ("${TYPED_DOC.trim()}")` : 'no', readBack: `${read.held ? 'doc_read yes' : 'doc_read no'}, ${saved.held ? 'file yes' : 'file no'}` })
      } else rows.push({ kind: '.tcdoc', opened: 'no (the editor never showed the text)', edited: 'no', readBack: 'no' })
      await context.close()
    }
  }

  // The budget.
  if (!budget) say(`FAIL .tcsheet: no "${REVIEW_SHEET_TITLE}" is open`)
  else {
    const t = await ticket(REVIEW_SHEET_TITLE)
    if ('refused' in t) {
      say(`FAIL .tcsheet ticket refused: ${t.refused}`)
      rows.push({ kind: '.tcsheet', opened: `refused: "${t.refused}"`, edited: 'no', readBack: 'no' })
    } else {
      const context = await phoneContext()
      const page = await context.newPage()
      const consoleLines: string[] = []
      page.on('console', (m: { type(): string; text(): string }) => consoleLines.push(`${m.type()}: ${m.text()}`))
      await page.goto(t.url)
      const opened = await page
        .waitForFunction(() => !!document.querySelector('main canvas') && !document.querySelector('[aria-busy=true]'), undefined, { timeout: 30_000 })
        .then(() => true, () => false)
      await sleep(2500)
      await shoot(page, 'budget-open.png')
      say(`${opened ? 'PASS' : 'FAIL'} .tcsheet: the grid opened${opened ? '' : `; console: ${consoleLines.slice(-5).join(' | ')}`}`)
      if (opened) {
        const facts = (await page.evaluate(() => {
          const controls = [...document.querySelectorAll('button, [role=button]')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean)
          return { controls, alerts: [...document.querySelectorAll('[role=status], [role=alert]')].map((e) => e.textContent?.trim() ?? ''), canvases: document.querySelectorAll('main canvas').length }
        })) as { controls: string[]; alerts: string[]; canvases: number }
        draws.sheet.push(`buttons on the page: ${facts.controls.length ? facts.controls.map((c) => `"${c}"`).join(', ') : 'none'}; status lines: ${facts.alerts.length ? facts.alerts.map((c) => `"${c}"`).join(', ') : 'none'}; the grid is ${facts.canvases} canvas`)
        draws.sheet.push(`an Accept or Reject control: ${facts.controls.some((c) => /accept|reject|review/i.test(c)) ? 'yes' : 'no'}`)
        // Tap B5 where Univer draws it (its row header 46 px, column header 20 px, columns 88 px, rows 24 px), type, Enter.
        // The grid is the largest canvas on screen (Univer keeps others off it, for measuring).
        const box = (await page.evaluate(() => {
          const shown = [...document.querySelectorAll('main canvas')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0)
          const r = shown.sort((p, q) => q.width * q.height - p.width * p.height)[0]
          return r ? { x: r.left, y: r.top } : null
        })) as { x: number; y: number } | null
        if (!box) throw new Error('no grid canvas is on screen')
        const at = { x: box.x + 46 + 88 + 44, y: box.y + 20 + 24 * 4 + 12 }
        await page.touchscreen.tap(at.x, at.y)
        await sleep(400)
        const fields = (await page.evaluate(() => [...document.querySelectorAll('main input, main [contenteditable=true]')].map((e) => ((e as HTMLInputElement).value ?? e.textContent ?? '').trim()).filter(Boolean))) as string[]
        draws.sheet.push(`after the tap at B5, the name box and formula bar read: ${fields.length ? fields.map((f) => `"${f}"`).join(', ') : 'nothing'}`)
        await page.keyboard.type(TYPED_CELL, { delay: 60 })
        await page.keyboard.press('Enter')
        const cell = async (): Promise<string> => {
          const [got] = await workTools(ready, [{ sessionId, tool: 'sheet_read', args: { item: budget.id, range: 'B5' } }])
          return got.text
        }
        let read = await until(cell, (t) => /\bB5 525\b/.test(t), 15_000)
        let how = `a tap at B5 (${Math.round(at.x)}, ${Math.round(at.y)}), "${TYPED_CELL}" typed, Enter`
        if (!read.held) {
          // A tap may not reach Univer's cell editor in headless WebKit: a double click there opens it with a mouse.
          await page.mouse.dblclick(at.x, at.y)
          await sleep(400)
          await page.keyboard.type(TYPED_CELL, { delay: 60 })
          await page.keyboard.press('Enter')
          read = await until(cell, (t) => /\bB5 525\b/.test(t), 15_000)
          how += read.held ? '; the tap did not open the cell, a mouse double click there did' : '; then a mouse double click there, typed, Enter'
        }
        await shoot(page, 'budget-edited.png')
        say(`${read.held ? 'PASS' : 'FAIL'} .tcsheet: B5 reads 525 through sheet_read after ${how}${read.held ? '' : `; it read ${JSON.stringify(read.value)}`}`)
        rows.push({ kind: '.tcsheet', opened: 'yes', edited: read.held ? 'yes (525 in B5)' : 'no', readBack: read.held ? 'sheet_read yes' : `sheet_read no: ${read.value.replace(/\n/g, ' ')}` })
      } else rows.push({ kind: '.tcsheet', opened: 'no (the grid never showed)', edited: 'no', readBack: 'no' })
      await context.close()
    }
  }

  // ── a used ticket: 403 ────────────────────────────────────────────────
  if (usedTicket) {
    const again = await fetch(`${origin}/w/open/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: usedTicket }) })
    const body = await again.text()
    say(`${again.status === 403 ? 'PASS' : 'FAIL'} a second redeem of the memo's used ticket answered ${again.status}: ${body}`)
    rows.push({ kind: 'used ticket', opened: `refused: ${again.status} ${JSON.parse(body).error ?? body}`, edited: 'no', readBack: 'no' })
  }
  phone.close()
} catch (err) {
  say(`FAIL the proof stopped: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  say(`INFO the server's last words: ${serverLog.slice(-2000).replace(/\n/g, ' | ')}`)
} finally {
  await browser?.close().catch(() => {})
  server.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      server.kill('SIGKILL')
      done()
    }, 5_000)
    server.on('exit', () => {
      clearTimeout(timer)
      done()
    })
  })
}

/** A .tcdoc's text as the file holds it: its Yjs state read into a document and back to markdown. */
async function fileText(path: string): Promise<string> {
  try {
    const { unzipSync } = (await import('fflate')) as { unzipSync: (b: Uint8Array) => Record<string, Uint8Array> }
    const Y = (await import('yjs')) as typeof import('yjs')
    const { readDocument } = (await import(resolve(repo, 'node_modules/work-kit/src/collab-server/markdown.ts'))) as { readDocument: (f: unknown) => { markdown: string } }
    const { DOCUMENT_FRAGMENT } = (await import(resolve(repo, 'node_modules/work-kit/src/collab/document.ts'))) as { DOCUMENT_FRAGMENT: string }
    const files = unzipSync(new Uint8Array(readFileSync(path)))
    const doc = new Y.Doc()
    Y.applyUpdate(doc, files['state.yjs']!)
    const text = readDocument(doc.getXmlFragment(DOCUMENT_FRAGMENT)).markdown
    doc.destroy()
    return text
  } catch (err) {
    return `(did not open: ${String(err)})`
  }
}

// ── the report ──────────────────────────────────────────────────────────

/** Why the page draws what it does, from its code (src/hosted/guest); the lines under each say what was seen. */
const WHY_DOC =
  "The page is the owner's own editor (DocPage.tsx), editable, and his typing reaches the file. Comments: the agent's thread is marked in the text itself (one `.bn-thread-mark` around \"the charter bus\"), but nothing shows it: no tint, no card, no count, because for the owner `Session.threads()` answers no rows (session.ts reads comments on a guest's link only), so the threads adapter DocPage hands the editor (guestThreads) has none to draw. The editor still offers Comment over selected words (canComment and a margin are set), and its composer opens under the text, but a comment made there never reaches the host: `Session.comment` throws \"Comments are made in TempCode.\" for the owner, and the page shows no words for it; the draft just stays in the field. Suggestions: DocPage passes DocumentEditor no `review` (nor `onReviewPick`), so the waiting branch is neither drawn on the text nor offered for Accept or Reject."
const WHY_SHEET =
  "The page is the owner's grid (SheetPage.tsx), editable, with the name box, the formula bar and the tab row; his typing reaches the file. It passes SheetCanvas no `marks`, and neither the redeemed answer (routes/item.ts) nor the sheet socket's state carries suggestions, so the three suggested cells show what the file holds (B2 1200, B4 400, C4 empty) with no mark, and nothing offers Accept or Reject."

const report = [
  "# The owner's hosted editor on a phone (PF4)",
  '',
  `Run ${new Date().toISOString()} by scripts/e2e-phone-hosted.ts: headless WebKit (Playwright's webkit-2370) at 390×844, a phone's user agent and touch, against the iOS test server with its Work service in process, the hosted pages built from this tree.`,
  '',
  '| File kind | Opened | Edited | Read back |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.kind} | ${r.opened} | ${r.edited} | ${r.readBack} |`),
  '',
  "## What the owner's hosted page draws",
  '',
  `**The document** (${shots.filter((n) => n.startsWith('memo-')).join(', ')}). ${WHY_DOC}`,
  '',
  ...draws.doc.map((d) => `- ${d}`),
  '',
  `**The sheet** (${shots.filter((n) => n.startsWith('budget-')).join(', ')}). ${WHY_SHEET}`,
  '',
  ...draws.sheet.map((d) => `- ${d}`),
  '',
  '## What failed, and why',
  '',
  ...(lines.some((l) => l.startsWith('FAIL')) ? lines.filter((l) => l.startsWith('FAIL')).map((l) => `- ${l}`) : ['Nothing failed in this run.']),
  '',
  ...(process.env.TC_WEBKIT
    ? [
        '## How WebKit ran on this host',
        '',
        `Playwright's own webkit-2370 does not start here: the host lacks GTK 4, GStreamer and about forty other libraries, and the box has no sudo. This run launched a copy of it with those libraries unpacked into minibrowser-wpe/sys/lib (TC_WEBKIT=${process.env.TC_WEBKIT})${process.env.TC_WEBKIT_MESA ? `, and Mesa's software EGL from ${process.env.TC_WEBKIT_MESA} (headless WPE draws through EGL; without it the page process aborts with "Could not create EGL display")` : ''}.`,
        ''
      ]
    : []),
  '## Lines',
  '',
  '```',
  ...lines,
  '```',
  ''
].join('\n')
writeFileSync(join(out, 'report.md'), report)
console.log(`e2e-phone-hosted: ${lines.filter((l) => l.startsWith('PASS')).length} PASS, ${lines.filter((l) => l.startsWith('FAIL')).length} FAIL; report and pictures in ${out}`)
process.exit(lines.some((l) => l.startsWith('FAIL')) ? 1 : 0)
