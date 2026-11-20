import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCollabSigner, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import type { WorkCtx } from '../modules'
import { servicePaths } from '../service/config'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { startWorkService, type RunningService } from '../service/serve'
import { GuestRuntime } from './links'
import { Page } from './proofPage'
import { ensureGuestTables } from './store'

/*
 * The live proof of a project's guest link (landed/P7.md): the real Work
 * service on the box's own listener, the built hosted page in a headless
 * Chromium driven over CDP, against a LifeOS that stands in. Opt-in:
 *
 *   P7_PROOF=1 P7_HOSTED=/tmp/p7-hosted P7_SHOTS=<dir> NODE_ENV=test bunx vitest run src/main/server/work/guests/projectLinks.live.proof.test.ts
 */

const ON = !!process.env.P7_PROOF
const HOSTED = process.env.P7_HOSTED ?? ''
const CHROME = process.env.P7_CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell`
const PROJECT = 'kprojproof'
const DESC = 'kdescproof'
const RUN = 'kdocrunproof'
const SHEET = 'ksheetproof'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
Page.shots = process.env.P7_SHOTS ?? ''

const task = (id: string, key: string, title: string, status: string, over: Record<string, unknown> = {}) => ({ id, key, parentId: null, rank: key, title, status, priority: null, dueAt: null, notes: '', ...over })
const TASKS = [
  task('kt1', 'PUR-1', 'Book the Union ballroom', 'done'),
  task('kt2', 'PUR-2', 'Network for 64 seats', 'doing', { priority: 'high', notes: 'Wired only. Two switches on loan from ITaP.', waitingOn: 'Marcus Reed' }),
  task('kt3', 'PUR-3', 'Run a cable test', 'todo', { parentId: 'kt2' }),
  task('kt4', 'PUR-4', 'Sponsor banners', 'waiting'),
  task('kt5', 'PUR-5', 'Print the brackets', 'todo', { dueAt: Date.now() + 5 * 86_400_000 })
]
const view = (tasks = TASKS, docs = [{ id: RUN, title: 'Run of show' }]) => ({
  project: { id: PROJECT, name: 'Spring LAN', status: 'active', description: 'Two days in the Union ballroom, 64 seats, the varsity teams on stage.', docId: DESC },
  counts: { todo: tasks.filter((t) => t.status === 'todo').length, doing: tasks.filter((t) => t.status === 'doing').length, waiting: tasks.filter((t) => t.status === 'waiting').length, done: tasks.filter((t) => t.status === 'done').length },
  tasks,
  truncated: false,
  docs,
  sheets: [{ id: SHEET, title: 'Budget' }],
  comments: [{ body: 'A comment only he reads' }]
})

const box: { dir: string; convex: FakeConvex; service: RunningService; rt: GuestRuntime; signer: CollabSigner; chrome: ChildProcess; debugPort: number; base: string; setView(next: unknown): void } = {} as never

beforeAll(async () => {
  if (!ON) return
  box.dir = mkdtempSync(join(tmpdir(), 'p7-proof-'))
  box.convex = await startFakeConvex()
  box.convex.docs.set(DESC, { _id: DESC, sector: 'purdue', seq: 0, title: 'Spring LAN', shared: false, markdown: '', plain: '' })
  box.convex.docs.set(RUN, { _id: RUN, sector: 'purdue', seq: 0, title: 'Run of show', shared: false, markdown: '', plain: '' })
  box.convex.sheets.set(SHEET, { title: 'Budget', sector: 'purdue', ops: [] })
  const keys = await generateCollabKeys('proof')
  box.signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  mkdirSync(join(box.dir, 'data'), { recursive: true })
  box.service = await startWorkService(
    {
      port: 0,
      socketPath: servicePaths(join(box.dir, 'data')).socketPath,
      secret: 's'.repeat(43),
      dataDir: join(box.dir, 'data', 'work-service'),
      hostedDir: HOSTED,
      host: 'env_box',
      lifeos: { here: true, url: box.convex.url },
      trusted: [{ by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }],
      links: []
    },
    { jwt: async () => 'owner-jwt', log: (l) => console.log(`[service] ${l}`) }
  )
  box.base = `http://127.0.0.1:${box.service.port}`
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('work.ownerName', 'Landon Hale')
  ensureGuestTables(db)
  let shared = false
  let current: unknown = view()
  const watchers = new Set<(v: unknown) => void>()
  const answer = (): unknown => (shared ? current : null)
  box.setView = (next) => {
    current = next
    for (const w of [...watchers]) w(answer())
  }
  const ctx = {
    db,
    host: 'env_box',
    log: (l: string) => console.log(l),
    push: () => {},
    service: { url: (r: string) => `${box.base}${r}`, token: async () => 'ok', internal: async () => ({ seen: {} }) },
    lifeos: {
      owner: () => ({
        query: async (fn: string, a: { id: string }) => (fn === 'projects:get' ? { project: { sector: 'purdue', name: 'Spring LAN' } } : (box.convex.docs.get(a.id) ?? null)),
        mutation: async (fn: string, a: { id: string; shared: boolean }) => {
          if (fn === 'projects:setShared') {
            shared = a.shared
            for (const w of [...watchers]) w(answer())
          }
          return null
        }
      }),
      subscribe: (_fn: string, _args: unknown, on: (v: unknown) => void) => {
        watchers.add(on)
        queueMicrotask(() => watchers.has(on) && on(answer()))
        return () => void watchers.delete(on)
      }
    }
  } as unknown as WorkCtx
  process.env.TEMP_CODE_WORK_PUBLIC_ORIGIN = box.base
  box.rt = new GuestRuntime(ctx, () => ({ tokenSigner: () => box.signer, setLinks: (l) => box.service.setLinks(l), setProject: (id, project) => box.service.setProject(id, project) }))
  box.chrome = spawn(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${join(box.dir, 'chrome')}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  box.debugPort = await new Promise<number>((resolve, reject) => {
    let err = ''
    box.chrome.stderr!.on('data', (c: Buffer) => {
      err += c.toString()
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)
      if (m) resolve(Number(m[1]))
    })
    box.chrome.on('exit', () => reject(new Error(`chrome exited: ${err}`)))
  })
}, 60_000)

afterAll(async () => {
  if (!ON) return
  box.chrome?.kill('SIGKILL')
  await box.service?.stop()
  await box.convex?.close()
  await sleep(500)
  rmSync(box.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const link = (name = 'Dana Lee') => box.rt.create({ source: { at: 'lifeos', table: 'projects', id: PROJECT }, title: 'Spring LAN', name, role: 'view', expiresAt: Date.now() + 29 * 24 * 3600_000, bySession: null })
const press = (words: string): string => `(() => { const el = [...document.querySelectorAll('button, [role="button"], li, a, span, p')].reverse().find((x) => x.textContent.trim() === ${JSON.stringify(words)}); if (!el) return false; el.click(); return true })()`
// Anything a guest could type in or tick. A read-only editor keeps its textbox role with contenteditable off and a hidden file input nothing opens: neither is a control.
const CONTROLS = `[...document.querySelectorAll('input:not([type="hidden"]):not([hidden]), textarea, [contenteditable="true"], [role="checkbox"]')].length`

describe.skipIf(!ON)("a project's guest page, live on the box listener", () => {
  it('shows the project read only in light and dark, with nothing of his comments, and no way out', async () => {
    await box.service.collab.writeMarkdown(DESC, 'owner', 'Two days in the Union ballroom, 64 seats, the varsity teams on stage.\n\nDoors at 9:00 both days.')
    // A sentence he cut, and a comment of his on words that stand: neither is his guest's.
    await box.service.collab.writeMarkdown(RUN, 'owner', '# Saturday\n\nThe venue fee is 4,000 dollars.\n\nCheck-in opens at the north doors.')
    await box.service.collab.markThread(RUN, 'owner', 'north doors', 'kthreadproof')
    await box.service.collab.writeMarkdown(RUN, 'owner', '# Saturday\n\nCheck-in opens at the north doors.')
    const made = await link()
    for (const scheme of ['light', 'dark'] as const) {
      const page = await Page.open(box.debugPort)
      await page.go(made.url, scheme)
      await page.until('the project', `document.body.innerText.includes('Network for 64 seats') && document.body.innerText.includes('Run of show')`)
      expect(await page.eval<string>(`document.querySelector('header').innerText`)).toMatch(/Spring LAN[\s\S]*Landon Hale[\s\S]*Can view[\s\S]*until/)
      const text = await page.eval<string>('document.body.innerText')
      // A done task rests under Done 1 until it is opened.
      for (const words of ['Run a cable test', 'Sponsor banners', 'Print the brackets', 'Budget', 'Done']) expect(text).toContain(words)
      // His comments and the history are not his guest's; nor whom a task waits on.
      for (const never of ['Activity', 'A comment only he reads', 'Marcus Reed', 'Leave a comment']) expect(text).not.toContain(never)
      // The description is its document's text, past the stored lead; nothing on the page can be typed in or ticked, and no editor is mounted.
      await page.until('the description', `document.body.innerText.includes('Doors at 9:00 both days')`)
      expect(await page.eval<number>(`document.querySelectorAll('.ProseMirror').length`)).toBe(0)
      expect(await page.eval<number>(CONTROLS)).toBe(0)
      expect(await page.eval<string[]>(`[...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))`)).toEqual([])
      const html = await page.eval<string>('document.documentElement.outerHTML')
      for (const never of ['/w/full', 'Marcus Reed']) expect(html).not.toContain(never)
      await page.shot(`01-project.${scheme}`)
      page.close()
    }
  }, 90_000)

  it('opens a task in its peek and the board, and a document and a sheet in place, read only, with the way back', async () => {
    const made = await link('Sam Ortiz')
    const page = await Page.open(box.debugPort)
    await page.go(made.url)
    await page.until('the project', `document.body.innerText.includes('Network for 64 seats')`)
    expect(await page.eval<boolean>(press('Network for 64 seats'))).toBe(true)
    await page.until('the peek', `document.body.innerText.includes('Two switches on loan')`)
    expect(await page.eval<number>(CONTROLS)).toBe(0)
    await sleep(400)
    await page.shot('02-task-peek.light')
    await page.key('Escape', 'Escape', 27)
    // The line's one control: the list or the board.
    await page.eval(`(document.querySelector('[data-project-bar] [aria-label="Board"]').click(), true)`)
    await sleep(500)
    await page.shot('03-board.light')
    await page.eval(`(document.querySelector('[data-project-bar] [aria-label="List"]').click(), true)`)
    await page.until('the list again', `document.body.innerText.includes('Run of show')`)
    // A document of the project, in place.
    expect(await page.eval<boolean>(press('Run of show'))).toBe(true)
    await page.until('the document', `!!document.querySelector('[data-guest-doc]') && document.querySelector('[data-guest-doc]').innerText.includes('north doors')`)
    // Its text as it stands, with no editor, no socket, no deleted words and no comment's mark.
    expect(await page.eval<number>(CONTROLS)).toBe(0)
    const shown = await page.eval<string>('document.documentElement.outerHTML')
    for (const never of ['4,000', 'kthreadproof']) expect(shown).not.toContain(never)
    expect(await page.eval<string>(`document.querySelector('header').innerText`)).toMatch(/Run of show/)
    await page.shot('04-document.light')
    await page.eval(`(document.querySelector('header button[aria-label^="Back to"]').click(), true)`)
    await page.until('the project again', `!document.querySelector('[data-guest-project]').hidden && document.body.innerText.includes('Network for 64 seats')`)
    // And a sheet.
    expect(await page.eval<boolean>(press('Budget'))).toBe(true)
    await page.until('the grid', `!!document.querySelector('canvas')`, 30_000)
    await sleep(2000)
    await page.shot('05-sheet.light')
    page.close()
  }, 120_000)

  it("shows a task change within the page's next read, and sends a document that left the project back to the project", async () => {
    const made = await link('Maya Chen')
    const page = await Page.open(box.debugPort)
    await page.go(made.url)
    await page.until('the project', `document.body.innerText.includes('Network for 64 seats')`)
    const at = Date.now()
    box.setView(view([...TASKS, task('kt6', 'PUR-6', 'Order the trophies', 'todo')]))
    await page.until('the new task', `document.body.innerText.includes('Order the trophies')`, 20_000)
    console.log(`[proof] a task an agent added showed in ${Date.now() - at} ms`)
    // The guest is reading a document when it is moved out of the project.
    expect(await page.eval<boolean>(press('Run of show'))).toBe(true)
    await page.until('the document', `!!document.querySelector('[data-guest-doc]') && document.querySelector('[data-guest-doc]').innerText.includes('north doors')`)
    const left = Date.now()
    box.setView(view(TASKS, []))
    // The service hands it no more at once (projectLinks.test.ts); the page closes it at its next read.
    await page.until('back at the project', `!document.querySelector('[data-guest-project]').hidden`, 20_000)
    console.log(`[proof] a document that left the project was closed on the page in ${Date.now() - left} ms`)
    await page.until('the document is no longer listed', `!document.body.innerText.includes('Run of show')`, 20_000)
    page.close()
    box.setView(view())
  }, 90_000)

  it('revoked with the page open, the page says so at its next read; a wrong secret opens nothing', async () => {
    const made = await link('Tom Reyes')
    const page = await Page.open(box.debugPort)
    await page.go(made.url, 'dark')
    await page.until('the project', `document.body.innerText.includes('Network for 64 seats')`)
    const at = Date.now()
    await box.rt.revoke(made.link.id)
    await page.until('the end', `document.body.innerText.includes('This link no longer opens anything')`, 20_000)
    console.log(`[proof] revoked → the page said so in ${Date.now() - at} ms`)
    await page.shot('06-revoked.dark')
    const fresh = await link('Jess Park')
    await page.go(fresh.url.replace(/#k=.*/, '#k=' + 'A'.repeat(43)))
    await page.until('refused', `document.body.innerText.includes('This link no longer opens anything')`)
    page.close()
  }, 60_000)
})
