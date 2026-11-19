import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { runInNewContext } from 'node:vm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { ClientRequest } from '@shared/contract'
import type { SheetChange } from 'work-kit/sheet/source'
import type { Caller, WorkCtx } from '../../modules'
import type { RouteCtx } from '../../service/routes/route'
import { officeRoute } from '../../service/routes/office'
import { ensureSuggestionTables, SuggestionStore } from '../../sheets/suggestions'
import { ensureExcelTables, ExcelHelper } from '../excel'
import { FakeOffice } from '../fake'
import { ADDIN_ASSETS, ADDIN_CORE } from './assets'
import { withAddin } from './carrier'
import { FakeExcelHost } from './fakeOfficeJs'
import { addinHandle, addinHub, carriedHere, ensureAddinTables, startAddin } from './index'
import { AddinKeys, CODE_TRIES } from './keys'
import { isMicrosoftUrl, plainChromeUa } from './web'

/**
 * The add-in end to end on the box: the Work service's relay route on a real
 * listener, main's link to it, and the add-in's own script (addins/office/
 * core.js) run in a sandbox against a stub Office.js, over real sockets.
 */

const SECRET = 'x'.repeat(40)
const BOOK = 'https://d.docs.live.net/abc/Budget.xlsx'
let server: Server
let base: string
const routeCtx = { config: () => ({ secret: SECRET }), wss: new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 }), log: () => {} } as unknown as RouteCtx

beforeAll(async () => {
  server = createServer((req, res) => {
    const m = officeRoute.match.exec(new URL(req.url ?? '/', 'http://x').pathname)
    if (m) void officeRoute.http!(req, res, routeCtx, m)
    else res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    const m = officeRoute.match.exec(new URL(req.url ?? '/', 'http://x').pathname)
    if (m) officeRoute.upgrade!(req, socket, head, routeCtx, m)
    else socket.destroy()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const until = async (ok: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** One socket to the relay: how it ended, or the first message it got. */
function knock(path: string, first?: unknown, headers: Record<string, string> = {}): Promise<{ status?: number; code?: number; reason?: string; got?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}${path}`, { headers })
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }))
    ws.on('open', () => first !== undefined && ws.send(typeof first === 'string' ? first : JSON.stringify(first)))
    ws.on('message', (d) => resolve({ got: d.toString() }))
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    ws.on('error', () => undefined)
  })
}

/** The add-in's script, loaded as the pane loads it, on a stub host. */
function addin(host: { Office: unknown; Excel: unknown }, storage = new Map<string, string>()) {
  // What a page gives a script and Node does not put in a new context: its timers.
  const sandbox: Record<string, unknown> = { setTimeout, clearTimeout }
  runInNewContext(ADDIN_CORE, sandbox)
  const states: { phase: string; words: string }[] = []
  const a = (sandbox.TempCodeAddin as { createAddin(env: unknown): { start(): void; pair(code: string): void; stop(): void; state(): { phase: string } } }).createAddin({
    Office: host.Office,
    Excel: host.Excel,
    WebSocket,
    storage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
    url: `ws://${base}/w/office`,
    onState: (s: { phase: string; words: string }) => states.push(s)
  })
  return Object.assign(a, { states, storage })
}

describe('the relay with main away', () => {
  it('refuses an add-in while main is not linked, and main without the secret or through the tunnel', async () => {
    expect(await knock('/w/office')).toEqual({ status: 503 })
    expect(await knock('/w/office/host')).toEqual({ status: 401 })
    expect(await knock('/w/office/host', undefined, { Authorization: 'Bearer wrong' })).toEqual({ status: 401 })
    expect(await knock('/w/office/host', undefined, { Authorization: `Bearer ${SECRET}`, 'CF-Connecting-IP': '1.2.3.4' })).toEqual({ status: 404 })
  })

  it("serves the add-in's files, framable by Office on the web", async () => {
    const res = await fetch(`http://${base}/w/addin/taskpane.html`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('content-security-policy')).toContain('frame-ancestors')
    expect(await res.text()).toContain('appsforoffice.microsoft.com/lib/1/hosted/office.js')
    const manifest = await (await fetch(`http://${base}/w/addin/manifest.xml`)).text()
    expect(manifest).toContain('<SourceLocation DefaultValue="https://tempcode.landonhale.com/w/addin/taskpane.html" />')
    const icon = Buffer.from(await (await fetch(`http://${base}/w/addin/icon-32.png`)).arrayBuffer())
    expect(icon.subarray(1, 4).toString()).toBe('PNG')
    expect((await fetch(`http://${base}/w/addin/../keys`)).status).toBe(404)
    expect(Object.keys(ADDIN_ASSETS).sort()).toEqual(['core.js', 'icon-32.png', 'icon-64.png', 'icon-80.png', 'manifest.xml', 'taskpane.html', 'taskpane.js'])
  })
})

describe('the add-in through the relay', () => {
  let db: DatabaseSync
  let ctx: WorkCtx
  let stop: () => void
  let desktop: FakeOffice
  let excel: ExcelHelper
  let host: FakeExcelHost
  const local: Caller = { kind: 'local', caps: ['read', 'operate'] }
  const call = (method: string, params: unknown = {}, by: Caller = local) => addinHandle({ id: '1', method, params } as unknown as ClientRequest, ctx, by) as unknown as Promise<{ result: never }>

  beforeEach(async () => {
    db = new DatabaseSync(':memory:')
    ensureExcelTables(db)
    ensureSuggestionTables(db)
    ensureAddinTables(db)
    ctx = { db, host: 'env_box', log: () => {} } as unknown as WorkCtx
    desktop = new FakeOffice()
    desktop.addBook(BOOK, { Sheet1: { A1: 'from the desktop' } })
    const carrier = withAddin(desktop, addinHub)
    excel = new ExcelHelper(carrier, db, new SuggestionStore(db))
    stop = startAddin(ctx, (book, sheet, address) => void excel.heard(book, sheet, address), () => ({ url: `ws://${base}/w/office/host`, secret: SECRET }))
    // Main's link is up once the relay stops answering 503.
    for (let i = 0; i < 100 && (await knock('/w/office', { t: 'nothing' })).status === 503; i++) await new Promise((r) => setTimeout(r, 20))
    host = new FakeExcelHost(BOOK, { Sheet1: { A1: 'from the add-in', B2: 2 }, Notes: {} })
  })
  afterEach(() => {
    stop()
    excel.stop()
  })

  const paired = async () => {
    const { result } = await call('work.office.addin.pair')
    const a = addin(host)
    a.pair((result as { code: string }).code)
    await until(() => a.state().phase === 'connected')
    await until(() => !!addinHub()?.sessionFor('excel', BOOK))
    return a
  }

  it('pairs once with the short code, which gives the add-in its own key', async () => {
    await expect(call('work.office.addin.pair', {}, { kind: 'model', caps: ['read', 'operate'], sessionId: 's' })).rejects.toThrow('Only the owner')
    const a = await paired()
    expect(a.storage.get('tempcode.addin.key')).toMatch(/^tca_/)
    const { result } = await call('work.office.addin.list')
    expect(result).toMatchObject({ keys: [{ app: 'excel', name: 'excel on web', live: true }] })
    // The key, not the code, opens the next connection.
    a.stop()
    await until(() => !addinHub()?.sessionFor('excel', BOOK))
    a.start()
    await until(() => !!addinHub()?.sessionFor('excel', BOOK))
    a.stop()
  })

  it('refuses a wrong code, an unknown key and a socket that does not say hello', async () => {
    await call('work.office.addin.pair')
    expect(await knock('/w/office', { t: 'pair', code: 'WRONGCOD', app: 'excel' })).toMatchObject({ code: 4401 })
    expect(await knock('/w/office', { t: 'hello', key: 'tca_made-up', app: 'excel' })).toMatchObject({ code: 4403 })
    expect(await knock('/w/office', { t: 'call', id: 1, op: 'excel.read' })).toMatchObject({ code: 4401 })
    expect(await knock('/w/office', 'not json')).toMatchObject({ code: 1007 })
    const a = addin(host, new Map([['tempcode.addin.key', 'tca_made-up']]))
    a.start()
    await until(() => a.state().phase === 'unpaired')
    expect(a.storage.has('tempcode.addin.key')).toBe(false)
  })

  it('carries a range read and write, and the helper answers conflict on a stale write', async () => {
    const a = await paired()
    const carrier = withAddin(desktop, addinHub)
    expect((await carrier.workbooks()).find((b) => b.key === BOOK)).toMatchObject({ name: 'Budget.xlsx', sheets: [{ name: 'Sheet1', rows: 2, columns: 2 }, { name: 'Notes', rows: 0, columns: 0 }] })
    expect((await carrier.readRange(BOOK, 'Sheet1', 'A1:B2')).values).toEqual([['from the add-in', null], [null, 2]])
    const read = await excel.read(BOOK, 'Sheet1', { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 })
    const w = await excel.write(BOOK, 'Sheet1', { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }, [['=A1*2']], { base: undefined, by: 'agent:env_box:s1' })
    expect(w).toMatchObject({ ok: true })
    expect(host.sheets[0]!.cells.get('1,1')).toEqual({ v: 0, f: '=A1*2' })
    host.type('Sheet1', 'A1', 'he typed')
    expect(await excel.write(BOOK, 'Sheet1', { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }, [[1, 2], [3, 4]], { base: read.hash, by: 'agent:env_box:s1' })).toMatchObject({ conflict: true })
    expect(host.get('Sheet1', 'A1')).toBe('he typed')
    a.stop()
  })

  it('reports a change by range within a second, and never our own write as his', async () => {
    const a = await paired()
    const heard: SheetChange[] = []
    excel.watch(BOOK, 'Sheet1', { startRow: 0, endRow: 9, startColumn: 0, endColumn: 4 }, (c) => heard.push(c))
    await new Promise((r) => setTimeout(r, 100))
    const t0 = Date.now()
    host.type('Sheet1', 'C3', 7, 'Remote')
    await until(() => heard.some((c) => c.kind === 'cells' && c.by === 'excel'), 1000)
    expect(Date.now() - t0).toBeLessThan(1000)
    heard.length = 0
    await excel.write(BOOK, 'Sheet1', { startRow: 3, endRow: 3, startColumn: 0, endColumn: 0 }, [['ours']], { by: 'agent:env_box:s1' })
    await new Promise((r) => setTimeout(r, 200))
    expect(heard.map((c) => c.kind === 'cells' && c.by)).toEqual(['tempcode'])
    // A change outside every watched block reads nothing.
    host.type('Sheet1', 'Z99', 1)
    await new Promise((r) => setTimeout(r, 200))
    expect(heard).toHaveLength(1)
    a.stop()
  })

  it('falls back to the desktop carrier when the add-in closes', async () => {
    const a = await paired()
    const carrier = withAddin(desktop, addinHub)
    expect((await carrier.readRange(BOOK, 'Sheet1', 'A1')).values).toEqual([['from the add-in']])
    a.stop()
    await until(() => !addinHub()?.sessionFor('excel', BOOK))
    expect((await carrier.readRange(BOOK, 'Sheet1', 'A1')).values).toEqual([['from the desktop']])
    // With no desktop either, the call says where to open the file.
    await expect(withAddin(null, addinHub).readRange(BOOK, 'Sheet1', 'A1')).rejects.toThrow('not open with the TempCode add-in')
  })

  it('closes an add-in whose key he removed', async () => {
    const a = await paired()
    const { result } = await call('work.office.addin.list')
    await call('work.office.addin.remove', { id: (result as { keys: { id: string }[] }).keys[0]!.id })
    await until(() => a.state().phase === 'unpaired')
    expect(a.states.at(-1)?.words).toBe('Removed in TempCode.')
    expect(((await call('work.office.addin.list')).result as { keys: unknown[] }).keys).toEqual([])
  })

  it('runs a tool here only for a file an add-in has open, where this host has no Office of its own', async () => {
    const alone = withAddin(null, addinHub)
    expect(carriedHere(alone, 'office_range_read', { workbook: BOOK })).toBe(false)
    expect(carriedHere(alone, 'office_files', {})).toBe(false)
    const a = await paired()
    expect(carriedHere(alone, 'office_range_read', { workbook: BOOK })).toBe(true)
    expect(carriedHere(alone, 'office_range_read', { workbook: '/Users/o/Other.xlsx' })).toBe(false)
    expect(carriedHere(alone, 'office_files', {})).toBe(true)
    expect(carriedHere(alone, 'office_mail_send', { to: ['a@b.c'] })).toBe(false)
    expect(carriedHere(withAddin(desktop, addinHub), 'office_mail_send', {})).toBe(true)
    expect((await alone.apps()).find((x) => x.app === 'excel')).toMatchObject({ installed: true, running: true })
    await expect(alone.sendMail({ to: ['a@b.c'], cc: [], bcc: [], subject: 's', html: '' })).rejects.toThrow('does not carry Outlook')
    a.stop()
  })
})

describe('pairing codes', () => {
  it('opens one pairing, dies after five wrong tries and after five minutes', () => {
    let now = 0
    const db = new DatabaseSync(':memory:')
    ensureAddinTables(db)
    const keys = new AddinKeys(db, () => now)
    const { code } = keys.mint()
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    expect(keys.pair(code.toLowerCase(), 'Excel', 'excel')).toMatchObject({ key: expect.stringMatching(/^tca_/) })
    expect(keys.pair(code, 'Excel', 'excel')).toBeNull()
    const second = keys.mint().code
    for (let i = 0; i < CODE_TRIES; i++) expect(keys.pair('AAAAAAAA', 'x', 'excel')).toBeNull()
    expect(keys.pair(second, 'x', 'excel')).toBeNull()
    const third = keys.mint().code
    now += 5 * 60_000
    expect(keys.pair(third, 'x', 'excel')).toBeNull()
    expect(keys.list()).toHaveLength(1)
    expect(keys.check('tca_nothing')).toBeNull()
  })
})

describe('Office on the web', () => {
  it("goes only to Microsoft's own sites, and shows Microsoft plain Chrome", () => {
    expect(isMicrosoftUrl('https://onedrive.live.com/edit?id=1')).toBe(true)
    expect(isMicrosoftUrl('https://purdue0-my.sharepoint.com/:x:/r/personal/b.xlsx')).toBe(true)
    expect(isMicrosoftUrl('https://excel.cloud.microsoft/open')).toBe(true)
    expect(isMicrosoftUrl('http://onedrive.live.com/')).toBe(false)
    expect(isMicrosoftUrl('https://evil-sharepoint.com.example.org/')).toBe(false)
    expect(isMicrosoftUrl('https://notmicrosoft.com/')).toBe(false)
    expect(plainChromeUa('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) TempCode/1.0.400 Chrome/142.0.0.0 Electron/39.2.0 Safari/537.36')).toBe(
      'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
    )
  })
})
