import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { SheetRevision, SheetView } from '@shared/contract-work-sheets'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb, Store } from '../../../db'
import type { SessionRegistry } from '../../../sessions'
import { servicePaths } from '../../service/config'
import type { RouteCtx } from '../../service/routes/route'
import { FULL_ROUTE } from './wire'

/**
 * The full editor end to end on the box (opt-in: `FULL_EDITOR_LIVE=1`, with
 * ONLYOFFICE installed under `/srv/agents/temp-code-data/work-tools` or
 * `FULL_EDITOR_TOOLS`, and `FULL_EDITOR_PLAYWRIGHT` naming a playwright-core
 * whose Chromium is installed). A workbook holding pivot tables and a chart
 * offers the switch; the switch answers the page; headless Chromium edits a
 * cell there and leaves; the save lands as a revision our grid reloads, with
 * the pivot and chart parts intact. Shots go to `FULL_EDITOR_SHOTS`.
 */

const LIVE = process.env.FULL_EDITOR_LIVE === '1'
const TOOLS = process.env.FULL_EDITOR_TOOLS ?? '/srv/agents/temp-code-data/work-tools'
const state = vi.hoisted(() => ({ base: '' }))
vi.mock('../../scope', () => ({
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
vi.mock('../../threads', () => ({ threadsPart: () => ({ threads: { start: async () => 'x', resume: async () => {}, ownerSaid: () => false } }) }))
// The Work service's listener is this test's: its /w/full route is the real one.
vi.mock('../../service/ctx', async (orig) => ({
  ...(await orig<object>()),
  servicePart: () => ({
    service: {
      url: (route: string) => `${state.base}${route}`,
      token: async () => 'x',
      internal: async () => {
        throw new Error('not in this test')
      }
    }
  })
}))

interface Locator {
  waitFor(o: { timeout: number }): Promise<void>
  click(o?: { timeout: number }): Promise<void>
  fill(v: string): Promise<void>
  press(k: string): Promise<void>
}
interface Playwright {
  chromium: {
    launch(): Promise<{
      newPage(o: object): Promise<{
        on(e: 'pageerror', f: (e: Error) => void): void
        on(e: 'response', f: (r: { status(): number; url(): string }) => void): void
        on(e: 'requestfailed', f: (r: { url(): string; failure(): { errorText: string } | null }) => void): void
        goto(url: string): Promise<unknown>
        frameLocator(s: string): { locator(s: string): Locator }
        waitForTimeout(ms: number): Promise<void>
        keyboard: { type(t: string): Promise<void>; press(k: string): Promise<void> }
        screenshot(o: { path: string }): Promise<unknown>
        close(): Promise<void>
      }>
      close(): Promise<void>
    }>
  }
}

const PARTS = /^xl\/(pivotTables|pivotCache|charts)\/[^/]+\.xml$/

function partsOf(path: string): Map<string, string> {
  const out = new Map<string, string>()
  const names = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).split('\n').filter((n) => PARTS.test(n))
  for (const n of names) out.set(n, execFileSync('unzip', ['-p', path, n], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  return out
}

describe.skipIf(!LIVE)('the full editor, live', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let work: ReturnType<Awaited<typeof import('../../ctx')>['startWork']>
  let listener: Server
  let path: string
  let itemId: string
  const pushes: WorkPush[] = []
  const logs: string[] = []
  const shots = process.env.FULL_EDITOR_SHOTS ?? join(tmpdir(), 'full-editor-shots')
  const call = async <T = unknown,>(method: string, params: unknown): Promise<T> => {
    const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), LOCAL_PRINCIPAL)
    return (out.handled ? out.result : undefined) as T
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-full-live-'))
    mkdirSync(join(dir, 'work-tools'))
    const box = JSON.parse(readFileSync(join(TOOLS, 'state.json'), 'utf8')) as { platform: string; tools: Record<string, unknown> }
    writeFileSync(join(dir, 'work-tools/state.json'), JSON.stringify({ platform: box.platform, at: 1, tools: { onlyoffice: box.tools.onlyoffice } }))
    symlinkSync(join(TOOLS, 'onlyoffice'), join(dir, 'work-tools/onlyoffice'))

    const { startWork } = await import('../../ctx')
    const { canvas } = await import('../../canvas/index')
    const { sheets } = await import('../index')
    const { setJobs } = await import('../held')
    const { localJobs } = await import('../workerClient')
    const { fullEditorRoute } = await import('../../service/routes/fullEditor')
    const { canvasStoreOf } = await import('../../canvas/store')
    setJobs(localJobs)

    const route = { config: () => ({ socketPath: servicePaths(dir).socketPath }), log: (l: string) => logs.push(l) } as unknown as RouteCtx
    listener = createServer((req, res) => {
      const m = FULL_ROUTE.exec(new URL(req.url ?? '/', 'http://x').pathname)
      if (!m) return void res.writeHead(404).end()
      void fullEditorRoute.http!(req, res, route, m)
    })
    listener.on('upgrade', (req, socket, head) => {
      const m = FULL_ROUTE.exec(new URL(req.url ?? '/', 'http://x').pathname)
      if (!m) return void socket.destroy()
      fullEditorRoute.upgrade!(req, socket, head, route, m)
    })
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', () => r()))
    state.base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`

    db = openDb(join(dir, 'test.db'))
    const sessions = new Map<string, SessionMeta>([['t1', { id: 't1', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta]])
    const registry = { get: (id: string) => sessions.get(id) ?? null, onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {} } as unknown as SessionRegistry
    work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: (l) => logs.push(l), remoteFence: { roots: () => [dir], denied: () => [] } }, [canvas, sheets])
    work.pushes.onPush((p) => pushes.push(p))
    await call('work.set', { enabled: true })
    path = join(dir, 'Report.xlsx')
    copyFileSync(join(import.meta.dirname, 'fixtures/pivot-chart.xlsx'), path)
    itemId = canvasStoreOf(db).open('t1', { kind: 'sheet', source: { at: 'file', host: 'env_test', path }, title: 'Report.xlsx' }).id
    mkdirSync(shots, { recursive: true })
  }, 60_000)

  afterAll(async () => {
    await call('work.set', { enabled: false }).catch(() => {})
    work?.close()
    db?.close()
    await new Promise<void>((r) => listener?.close(() => r()))
    console.log(logs.filter((l) => l.includes('full-editor')).join('\n'))
    if (process.env.FULL_EDITOR_KEEP) console.log(`kept ${dir}`)
    else rmSync(dir, { recursive: true, force: true })
  })

  /** Presses the switch, types `value` at `cell` in the editor, leaves, and waits until the canvas hears of it. */
  async function editThere(item: string, cell: string, value: string, shot: string): Promise<{ url: string; t0: number }> {
    const t0 = Date.now()
    const { url } = await call<{ opened: true; url: string }>('work.sheets.switch', { itemId: item })
    console.log(`switch answered in ${Date.now() - t0} ms: ${url.replace(/[0-9a-f]{64}/, '<token>')}`)
    expect(url).toMatch(new RegExp(`^${state.base}/w/full/[0-9a-f]{64}/$`))
    const pw = (await import(/* @vite-ignore */ process.env.FULL_EDITOR_PLAYWRIGHT ?? 'playwright-core')) as Playwright
    const browser = await pw.chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('response', (r) => {
        if (r.status() >= 400) console.log(`HTTP ${r.status()} ${r.url().replace(/[0-9a-f]{64}/, '<token>')}`)
      })
      page.on('requestfailed', (r) => console.log(`failed ${r.url().replace(/[0-9a-f]{64}/, '<token>')}: ${r.failure()?.errorText}`))
      await page.goto(url)
      const box = page.frameLocator('iframe[name="frameEditor"]').locator('#ce-cell-name')
      await box.waitFor({ timeout: 120_000 })
      await page.waitForTimeout(3000)
      console.log(`editor ready in ${Date.now() - t0} ms`)
      await box.click({ timeout: 30_000 }).catch(async (err: Error) => {
        await page.screenshot({ path: join(shots, `${shot}-stuck.png`) })
        throw err
      })
      await box.fill(cell)
      await box.press('Enter')
      await page.waitForTimeout(500)
      await page.keyboard.type(value)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(3000)
      await page.screenshot({ path: join(shots, `${shot}.png`) })
      expect(errors).toEqual([])
      await page.close()
    } finally {
      await browser.close()
    }
    // When everyone has left, the docservice saves through its callback, and the canvas hears of it.
    const from = pushes.length
    const deadline = Date.now() + 90_000
    while (!pushes.slice(from).some((p) => p.push === 'work.sheets' && (p as { itemId?: string }).itemId === item) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
    console.log(`the canvas heard ${Date.now() - t0} ms after the switch`)
    return { url, t0 }
  }

  it('opens a workbook with pivot tables and a chart from the switch, and an edit there comes back as a revision with those parts intact', async () => {
    const before = partsOf(path)
    expect([...before.keys()].some((n) => n.startsWith('xl/pivotTables/'))).toBe(true)
    expect([...before.keys()].some((n) => n.startsWith('xl/charts/chart'))).toBe(true)
    const view = await call<SheetView>('work.sheets.open', { itemId })
    expect(view.reach).toEqual({ parts: expect.arrayContaining(['pivot tables', 'charts']), to: 'full' })

    const { url } = await editThere(itemId, 'Data!F2', '4242', 'full-editor-edit')

    // The docservice had no TCP port; what this process listens on is loopback only.
    const ss = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8' })
    for (const line of ss.split('\n').filter((l) => l.includes(`pid=${process.pid},`))) expect(line).toMatch(/\s127\.0\.0\.[12]:\d+\s/)
    expect(ss).not.toMatch(/"docservice"/)
    expect((await fetch(`${state.base}/w/full/${'a'.repeat(64)}/`)).status).toBe(404)

    const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
    const data = workbook.sheetOrder.find((s) => workbook.sheets[s]?.name === 'Data')!
    expect(workbook.sheets[data]?.cellData?.[1]?.[5]?.v).toBe(4242)
    const reopened = await call<SheetView>('work.sheets.open', { itemId })
    expect(reopened.rev).toBe(1)
    expect(reopened.saveError).toBeUndefined()
    const { revisions } = await call<{ revisions: SheetRevision[] }>('work.sheets.history', { itemId })
    expect(revisions[0]).toMatchObject({ rev: 1, by: 'file' })

    const after = partsOf(path)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    const same = [...before.keys()].filter((n) => after.get(n) === before.get(n))
    console.log(`pivot and chart parts byte for byte: ${same.length} of ${before.size}; changed: ${[...before.keys()].filter((n) => !same.includes(n)).join(', ') || 'none'}`)
    for (const n of [...before.keys()].filter((k) => k.startsWith('xl/pivotTables/'))) {
      expect(after.get(n)).toContain(/<pivotTableDefinition[^>]* name="[^"]+"/.exec(before.get(n)!)![0].match(/ name="[^"]+"/)![0])
      expect(after.get(n)).toContain(/<location ref="[^"]+"/.exec(before.get(n)!)![0])
    }
    expect(after.get('xl/charts/chart1.xml')).toContain('<c:barChart>')

    // The ended open's token reaches nothing.
    await new Promise((r) => setTimeout(r, 2100))
    expect((await fetch(url)).status).toBe(404)
  }, 300_000)

  it('says over the grid when the editor cannot save, and leaves the file as it was (a LibreOffice-written pivot)', async () => {
    const other = join(dir, 'Pivot.xlsx')
    copyFileSync(join(import.meta.dirname, '../harness/corpus/pivot.xlsx'), other)
    const { canvasStoreOf } = await import('../../canvas/store')
    const item = canvasStoreOf(db).open('t1', { kind: 'sheet', source: { at: 'file', host: 'env_test', path: other }, title: 'Pivot.xlsx' }).id
    expect((await call<SheetView>('work.sheets.open', { itemId: item })).reach?.to).toBe('full')
    const bytes = readFileSync(other)
    await editThere(item, 'Data!H2', '4242', 'full-editor-unsaved')
    const view = await call<SheetView>('work.sheets.open', { itemId: item })
    expect(view.saveError).toBe('The full editor could not save the changes made there: this file does not have them.')
    expect(readFileSync(other).equals(bytes)).toBe(true)
  }, 300_000)
})
