import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, chmodSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cacheControlOf, fullEditorRoute, forwardedHeaders, reachesEditor } from '../../service/routes/fullEditor'
import type { RouteCtx } from '../../service/routes/route'
import { FullEditor, signHs256, uiThemeOf, verifyHs256, type FullOpen, type SavedTo } from './editor'
import { closeCarriers, carry } from '../../../../fullEditorCarry'
import { fullEditorOf, openFull, reachOf } from './index'
import { EDITOR_PATHS, FULL_ROUTE, editorPage, lookupSocketOf } from './wire'

/**
 * The full editor without ONLYOFFICE: a stand-in docservice (a node server
 * on the socket its config names) answers the healthcheck and hands back a
 * "saved" workbook, so the opens, the route, the callbacks, the write-back
 * and every way it stops are tested here. live.test.ts runs the real one.
 */

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('saved by the editor')])
const STANDIN = `
const http = require('node:http'), fs = require('node:fs');
const socket = JSON.parse(fs.readFileSync(process.env.NODE_CONFIG_DIR + '/local.json', 'utf8')).services.CoAuthoring.server.port;
const server = http.createServer((req, res) => {
  if (req.url === '/healthcheck') return res.end('true');
  if (req.url.startsWith('/cache/files/')) return res.end(fs.readFileSync(process.env.STANDIN_SAVED));
  if (req.url.startsWith('/web-apps/')) return res.writeHead(200, { 'x-frame-options': 'DENY', 'x-seen-host': req.headers['x-forwarded-host'] || '' }).end('api');
  res.writeHead(404).end();
});
server.on('upgrade', (req, sock) => {
  sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nX-Seen-Path: ' + req.url + '\\r\\n\\r\\n');
  sock.pipe(sock);
});
server.listen(socket);
`

let dir: string
let tool: string
let saved: Array<{ open: FullOpen; to: SavedTo }>
let failed: string[]
let logs: string[]
let enabled: boolean
let rss: number
let now: number
let fe: FullEditor
let listener: Server
let base: string

function fakeTool(): string {
  const t = join(dir, 'tool')
  const etc = join(t, 'etc/onlyoffice/documentserver')
  mkdirSync(join(etc, 'log4js'), { recursive: true })
  writeFileSync(join(etc, 'default.json'), '{}')
  writeFileSync(join(etc, 'production-linux.json'), JSON.stringify({ storage: { fs: { folderPath: '/var/lib/onlyoffice/documentserver/App_Data/cache/files' } } }))
  writeFileSync(join(etc, 'log4js/production.json'), '{}')
  mkdirSync(join(t, 'var/www/onlyoffice/documentserver/server/DocService'), { recursive: true })
  return t
}

const standinSpawn = ((_cmd: string, _args: string[], opts: { env: Record<string, string>; detached: boolean }) =>
  spawn(process.execPath, ['-e', STANDIN], { env: { ...opts.env, STANDIN_SAVED: join(dir, 'saved.xlsx') }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })) as unknown as typeof spawn

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    request(`${base}${path}`, { headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
      .on('error', reject)
      .end()
  })
}

/** What the docservice posts to the callback URL in the config, signed the way it signs. */
async function callback(config: Record<string, unknown>, body: Record<string, unknown>, secretFrom = config): Promise<unknown> {
  const url = (config.editorConfig as { callbackUrl: string }).callbackUrl
  const secret = (fe as unknown as { secrets: { outbox: string } }).secrets.outbox
  const token = secretFrom === config ? signHs256({ payload: body }, secret) : 'x.y.z'
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return res.json()
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-full-'))
  tool = fakeTool()
  writeFileSync(join(dir, 'saved.xlsx'), ZIP)
  saved = []
  failed = []
  logs = []
  enabled = true
  rss = 0
  now = 1_000_000
  fe = new FullEditor({
    dataDir: dir,
    serviceSocket: join(dir, 'svc.sock'),
    toolDir: () => tool,
    enabled: () => enabled,
    log: (l) => logs.push(l),
    saved: (open, to) => saved.push({ open, to }),
    failed: (_open, words) => failed.push(words),
    now: () => now,
    spawn: standinSpawn,
    rss: async () => rss,
    memoryCapBytes: 1000,
    idleMs: 60_000,
    tickMs: 3_600_000
  })
  const ctx = { config: () => ({ socketPath: join(dir, 'svc.sock') }), log: (l: string) => logs.push(l) } as unknown as RouteCtx
  listener = createServer((req, res) => {
    const m = FULL_ROUTE.exec(new URL(req.url ?? '/', 'http://x').pathname)
    if (!m) return void res.writeHead(404).end()
    void fullEditorRoute.http!(req, res, ctx, m)
  })
  listener.on('upgrade', (req, socket, head) => {
    const m = FULL_ROUTE.exec(new URL(req.url ?? '/', 'http://x').pathname)
    if (!m) return void socket.destroy()
    fullEditorRoute.upgrade!(req, socket, head, ctx, m)
  })
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
})

afterEach(async () => {
  await fe.stop('test over')
  await new Promise<void>((r) => listener.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

const workbook = (): string => {
  const path = join(dir, 'Report.xlsx')
  writeFileSync(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('as opened')]))
  chmodSync(path, 0o640)
  return path
}

describe.skipIf(process.platform !== 'linux')('the full editor', () => {
  it('opens a workbook: the route serves our page for its token, the editor paths behind it, and nothing else', async () => {
    const path = workbook()
    const token = await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(fe.running()).toBe(true)
    // A second press on the same file is the same session.
    expect(await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })).toBe(token)

    const page = await get(`/w/full/${token}/`)
    expect(page.status).toBe(200)
    expect(page.body).toContain(`/w/full/${token}/web-apps/apps/api/documents/api.js`)
    expect(page.headers['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+'; .*frame-ancestors 'none'/)
    expect(page.headers['x-frame-options']).toBe('DENY')

    // Under any name but this host's loopback, and with no carrier, the editor is not reached.
    expect((await get(`/w/full/${token}/web-apps/apps/api/documents/api.js`, { Host: 'tempcode.example' })).status).toBe(404)
    const api = await get(`/w/full/${token}/web-apps/apps/api/documents/api.js`, { Cookie: 'tc_session=secret' })
    expect(api.status).toBe(200)
    expect(api.body).toBe('api')
    // The editor's own frames are this origin's; its links come back through the token's prefix.
    expect(api.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(api.headers['x-seen-host']).toBe(`${new URL(base).host}/w/full/${token}`)
    expect(api.headers['cache-control']).toBe('no-store')

    expect((await get(`/w/full/${token}/info/info.json`)).status).toBe(404)
    expect((await get(`/w/full/${token}/coauthoring/CommandService.ashx`)).status).toBe(404)
    expect((await get(`/w/full/${'a'.repeat(64)}/`)).status).toBe(404)
    // The storage server is on a loopback address of its own, the one private address the docservice may fetch from.
    const config = JSON.parse(/DocEditor\('editor', (.*)\)<\/script>/.exec(page.body)![1]!) as { document: { url: string } }
    expect(config.document.url).toMatch(/^http:\/\/127\.0\.0\.2:\d+\/file\/[0-9a-f]{48}$/)
    expect((await fetch(config.document.url)).status).toBe(200)
  })

  it('opens in the theme of the window that asked, and follows the browser\'s system when none is sent', async () => {
    const path = workbook()
    const themeOf = (token: string): unknown => {
      const open = (fe as unknown as { opens: Map<string, FullOpen> }).opens.get(token)!
      const signed = fe.configOf(open) as { token: string; editorConfig: { customization: { uiTheme: string } } }
      // The theme is inside the signed config: the docservice takes it from nowhere else.
      expect(JSON.parse(Buffer.from(signed.token.split('.')[1], 'base64url').toString()).editorConfig.customization.uiTheme).toBe(signed.editorConfig.customization.uiTheme)
      return signed.editorConfig.customization.uiTheme
    }
    // The phone sends none.
    const token = await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    expect(themeOf(token)).toBe('theme-system')
    // The same file from a light window: the same session, in that window's theme the next time its page loads.
    expect(await fe.open({ path, itemId: 'i1', title: 'Report.xlsx', scheme: 'light' })).toBe(token)
    expect(themeOf(token)).toBe('theme-light')
    expect(await fe.open({ path, itemId: 'i1', title: 'Report.xlsx', scheme: 'dark' })).toBe(token)
    expect(themeOf(token)).toBe('theme-dark')
    // A press that names no theme leaves the one it has.
    await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    expect(themeOf(token)).toBe('theme-dark')
    expect([uiThemeOf('light'), uiThemeOf('dark'), uiThemeOf(undefined)]).toEqual(['theme-light', 'theme-dark', 'theme-system'])
  })

  it('a save lands in the file, keeping its mode; when everyone has left the token reaches nothing', async () => {
    const path = workbook()
    const token = await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    const config = (fe as unknown as { opens: Map<string, FullOpen> }).opens.get(token)!
    const signed = fe.configOf(config)
    expect(await callback(signed, { key: config.id, status: 1, users: ['owner'] })).toEqual({ error: 0 })
    expect(await callback(signed, { key: config.id, status: 6, url: `https://tempcode.example/w/full/${token}/cache/files/data/k/output.xlsx/output.xlsx?md5=x` })).toEqual({ error: 0 })
    expect(readFileSync(path).equals(ZIP)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o640)
    expect(saved.map((s) => s.to)).toEqual([{ path, beside: false }])
    // Still open after a forcesave; gone after the save that ends it.
    expect((await get(`/w/full/${token}/`)).status).toBe(200)
    expect(await callback(signed, { key: config.id, status: 2, url: `http://127.0.0.1:1/cache/files/data/k/output.xlsx` })).toEqual({ error: 0 })
    expect(saved).toHaveLength(2)
    await new Promise((r) => setTimeout(r, 2100))
    expect((await get(`/w/full/${token}/`)).status).toBe(404)
  })

  it('never overwrites a file changed outside the editor meanwhile: the save goes beside it', async () => {
    const path = workbook()
    const token = await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    const open = (fe as unknown as { opens: Map<string, FullOpen> }).opens.get(token)!
    writeFileSync(path, 'Excel saved this')
    utimesSync(path, new Date(), new Date(Date.now() + 5000))
    expect(await callback(fe.configOf(open), { key: open.id, status: 6, url: 'http://x/cache/files/a/output.xlsx' })).toEqual({ error: 0 })
    expect(readFileSync(path, 'utf8')).toBe('Excel saved this')
    expect(saved).toEqual([])
    const beside = /as (Report \(full editor .+\)\.xlsx):/.exec(failed[0]!)![1]!
    expect(readFileSync(join(dir, beside)).equals(ZIP)).toBe(true)
    // A second save in the same second gets a name of its own.
    expect(await callback(fe.configOf(open), { key: open.id, status: 2, url: 'http://x/cache/files/a/output.xlsx' })).toEqual({ error: 0 })
    const second = /as (Report \(full editor .+\)\.xlsx):/.exec(failed[1]!)![1]!
    expect(second).not.toBe(beside)
    expect(readFileSync(join(dir, second)).equals(ZIP)).toBe(true)
  })

  it('keeps a save whose file was moved away in its own folder, and says where', async () => {
    const path = workbook()
    const token = await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    const open = (fe as unknown as { opens: Map<string, FullOpen> }).opens.get(token)!
    rmSync(path)
    expect(await callback(fe.configOf(open), { key: open.id, status: 2, url: 'http://x/cache/files/a/output.xlsx' })).toEqual({ error: 0 })
    expect(failed[0]).toMatch(/in .*full-editor\/rescued, as Report \(full editor .+\)\.xlsx: this file was moved or removed/)
  })

  it('says a save is lost when it could not be fetched, never silently', async () => {
    const path = workbook()
    const token = await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    const open = (fe as unknown as { opens: Map<string, FullOpen> }).opens.get(token)!
    rmSync(join(dir, 'saved.xlsx'))
    expect(await callback(fe.configOf(open), { key: open.id, status: 2, url: 'http://x/cache/files/a/output.xlsx' })).toEqual({ error: 1 })
    expect(failed).toEqual(['The full editor could not save the changes made there: this file does not have them.'])
  })

  it('two presses on one file at once make one session, and a stop waits for an open in flight', async () => {
    const path = workbook()
    const [a, b] = await Promise.all([fe.open({ path, itemId: 'i1', title: 'Report.xlsx' }), fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })])
    expect(a).toBe(b)
    await fe.stop('test')
    const opening = fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    const stopping = fe.stop('Work is off')
    await opening
    await stopping
    expect(fe.running()).toBe(false)
    expect(existsSync(lookupSocketOf(join(dir, 'svc.sock')))).toBe(false)
  })

  it('carries the editor\'s socket through to the docservice', async () => {
    const token = await fe.open({ path: workbook(), itemId: 'i1', title: 'Report.xlsx' })
    const port = (listener.address() as AddressInfo).port
    const got = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`GET /w/full/${token}/doc/k/c/?EIO=4&transport=websocket HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: tc_session=x\r\n\r\n`))
      let text = ''
      sock.on('data', (c) => {
        text += c.toString()
        if (text.includes('\r\n\r\n') && !text.includes('ping')) sock.write('ping')
        if (text.endsWith('ping')) {
          sock.destroy()
          resolve(text)
        }
      })
      sock.on('error', reject)
    })
    expect(got).toMatch(/^HTTP\/1\.1 101/)
    expect(got).toContain('X-Seen-Path: /doc/k/c/?EIO=4&transport=websocket')
    const refused = await new Promise<string>((resolve) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`GET /w/full/${token}/info/x HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`))
      sock.on('data', (c) => resolve(c.toString()))
    })
    expect(refused).toMatch(/^HTTP\/1\.1 404/)
  })

  it('refuses a callback the docservice did not sign, one for another document, and a save from outside its cache', async () => {
    const path = workbook()
    const token = await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    const open = (fe as unknown as { opens: Map<string, FullOpen> }).opens.get(token)!
    const signed = fe.configOf(open)
    expect(await callback(signed, { key: open.id, status: 2, url: 'http://x/cache/files/a' }, {})).toEqual({ error: 1 })
    expect(await callback(signed, { key: 'another', status: 2, url: 'http://x/cache/files/a' })).toEqual({ error: 1 })
    expect(await callback(signed, { key: open.id, status: 2, url: 'http://x/info/info.json' })).toEqual({ error: 1 })
    expect(readFileSync(path, 'utf8')).toContain('as opened')
    expect(saved).toEqual([])
  })

  it('says when the editor could not save, and leaves the file as it was', async () => {
    const path = workbook()
    const token = await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    const open = (fe as unknown as { opens: Map<string, FullOpen> }).opens.get(token)!
    expect(await callback(fe.configOf(open), { key: open.id, status: 3, url: 'http://x/cache/files/a/output.xlsx' })).toEqual({ error: 0 })
    expect(failed).toEqual(['The full editor could not save the changes made there: this file does not have them.'])
    expect(readFileSync(path, 'utf8')).toContain('as opened')
  })

  it('stops when Work turns off, over its memory cap, and when nothing has been open for its idle time', async () => {
    const path = workbook()
    await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    rss = 5000
    await fe.tick()
    expect(fe.running()).toBe(false)
    expect(logs.some((l) => l.includes('over its 0 MB cap'))).toBe(true)

    rss = 0
    const token = await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    const open = (fe as unknown as { opens: Map<string, FullOpen> }).opens.get(token)!
    await fe.tick()
    expect(fe.running()).toBe(true)
    // An open nobody loaded is let go after fifteen minutes; idle time counts from then.
    now += 16 * 60_000
    await fe.tick()
    expect((fe as unknown as { opens: Map<string, FullOpen> }).opens.size).toBe(0)
    expect(fe.running()).toBe(true)
    now += 61_000
    await fe.tick()
    expect(fe.running()).toBe(false)
    expect(existsSync(open.snapshot)).toBe(false)

    await fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })
    enabled = false
    await fe.tick()
    expect(fe.running()).toBe(false)
    expect(existsSync(lookupSocketOf(join(dir, 'svc.sock')))).toBe(false)
    await expect(fe.open({ path, itemId: 'i1', title: 'Report.xlsx' })).rejects.toThrow('Work is off')
  })

  it('has no TCP port of its own: the docservice is on a socket in a folder only this user opens', async () => {
    await fe.open({ path: workbook(), itemId: 'i1', title: 'Report.xlsx' })
    const conf = JSON.parse(readFileSync(join(dir, 'full-editor/conf/local.json'), 'utf8')) as { services: { CoAuthoring: { server: { port: unknown } } } }
    expect(typeof conf.services.CoAuthoring.server.port).toBe('string')
    expect(statSync(join(dir, 'full-editor/conf/local.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'full-editor/run')).mode & 0o777).toBe(0o700)
    expect(statSync(lookupSocketOf(join(dir, 'svc.sock'))).mode & 0o777).toBe(0o600)
  })
})

describe('the full editor\'s pieces', () => {
  it('signs and checks HS256 tokens, refusing a changed one and one that ran out', () => {
    const t = signHs256({ a: 1, exp: 2000 }, 's')
    expect(verifyHs256(t, 's', 1_000_000)).toEqual({ a: 1, exp: 2000 })
    expect(verifyHs256(t, 'other', 1_000_000)).toBeNull()
    expect(verifyHs256(t.replace(/\.[^.]+\./, `.${Buffer.from('{"a":2}').toString('base64url')}.`), 's', 1_000_000)).toBeNull()
    expect(verifyHs256(t, 's', 3_000_000)).toBeNull()
  })

  it('reaches only the editor\'s paths of the docservice', () => {
    for (const ok of ['/web-apps/apps/api/documents/api.js', '/sdkjs/cell/sdk-all.js', '/doc/abc/c/?EIO=4&transport=websocket', '/cache/files/data/x/output.xlsx', '/fonts/000', '/downloadas/k?cmd=1']) expect(EDITOR_PATHS.test(ok), ok).toBe(true)
    for (const no of ['/info/info.json', '/welcome/', '/coauthoring/CommandService.ashx', '/converter', '/ConvertService.ashx', '/docbuilder', '/healthcheck', '/internal/cluster/inactive', '/web-appsx/']) expect(EDITOR_PATHS.test(no), no).toBe(false)
  })

  it('lets the browser keep only the vendor\'s static files', () => {
    expect(cacheControlOf('/web-apps/apps/api/documents/api.js', 'public, max-age=604800')).toBe('private, max-age=604800')
    expect(cacheControlOf('/cache/files/data/k/output.xlsx', 'public, max-age=604800')).toBe('no-store')
    expect(cacheControlOf('/sdkjs/cell/sdk-all.js', undefined)).toBe('no-store')
  })

  it('lets a request through the tunnel reach the editor only from the desktop\'s carrier, on a loopback origin', () => {
    expect(reachesEditor({ host: '127.0.0.1:7695' })).toBe(true)
    expect(reachesEditor({ host: 'tempcode.example', 'cf-ray': 'r' })).toBe(false)
    // Closed by default: the remote UI's hostname with no Cloudflare header at all is still refused.
    expect(reachesEditor({ host: 'tempcode.example' })).toBe(false)
    expect(reachesEditor({ host: '127.0.0.1:7695', 'cf-ray': 'r' })).toBe(false)
    expect(reachesEditor({ host: 'tempcode.example', 'cf-ray': 'r', 'x-tempcode-carry': 'http://127.0.0.1:99999' })).toBe(false)
    expect(reachesEditor({ host: 'tempcode.example', 'cf-connecting-ip': '1.2.3.4', 'x-tempcode-carry': 'https://evil.example' })).toBe(false)
    expect(reachesEditor({ host: 'tempcode.example', 'cf-ray': 'r', 'x-tempcode-carry': 'http://127.0.0.1:51234' })).toBe(true)
    const h = forwardedHeaders({ host: 'tempcode.example', 'x-forwarded-proto': 'https', 'cloudfront-forwarded-proto': 'https', forwarded: 'proto=https', 'x-tempcode-carry': 'http://127.0.0.1:51234' }, 'T')
    expect(h).toEqual({ host: '127.0.0.1:51234', 'x-forwarded-host': '127.0.0.1:51234/w/full/T', 'x-forwarded-proto': 'http' })
  })

  it('offers the switch to another computer only where the box\'s page reaches beyond it', () => {
    expect(reachOf({ parts: ['a pivot table'] }, true, true)).toEqual({ parts: ['a pivot table'], to: 'full', carried: true })
    expect(reachOf({ parts: ['a pivot table'] }, true, false)).toEqual({ parts: ['a pivot table'], to: 'full' })
    expect(reachOf({ parts: ['macros'] }, false, true)).toEqual({ parts: ['macros'], to: 'excel' })
  })

  it('hands the docservice none of the caller\'s credentials', () => {
    const h = forwardedHeaders({ host: 'h', cookie: 'c', authorization: 'a', 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-host': 'evil', 'x-forwarded-proto': 'https', accept: '*/*' }, 'T')
    expect(h).toEqual({ host: 'h', accept: '*/*', 'x-forwarded-host': 'h/w/full/T', 'x-forwarded-proto': 'https' })
  })

  it('writes a config that cannot close its script element', () => {
    const page = editorPage({ token: 'T', nonce: 'n', title: '<b>Q</b>', config: { title: '</script><script>alert(1)</script>' } })
    expect(page).not.toContain('</script><script>alert')
    expect(page).toContain('<title>&#60;b&#62;Q&#60;/b&#62;</title>')
  })

  it('opens only for the owner: never for a thread, never for a key short of admin', async () => {
    const ctx = { service: { url: () => 'http://127.0.0.1:1/w/full/' } } as never
    const item = { id: 'i1', title: 'R.xlsx' } as never
    await expect(openFull(ctx, item, '/x.xlsx', { kind: 'model', caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't1' })).rejects.toThrow('a thread cannot open it')
    await expect(openFull(ctx, item, '/x.xlsx', { kind: 'remote', caps: ['read', 'operate'] })).rejects.toThrow('owner\'s own devices')
    const admin = { kind: 'remote' as const, caps: ['read', 'operate', 'approve', 'admin'] }
    // A host whose pages reach no farther than itself, and an older desktop that cannot carry it: one plain sentence each, no path.
    await expect(openFull(ctx, item, '/x.xlsx', admin, { carry: true }, { TEMP_CODE_USER_DATA: '/tmp/elsewhere' })).rejects.toThrow(/^The full editor opens only in a window on the box\.$/)
    await expect(openFull(ctx, item, '/x.xlsx', admin, {}, { TEMP_CODE_WORK_PUBLIC_ORIGIN: 'https://tempcode.example' })).rejects.toThrow(/^Update TempCode on this computer to open the full editor from here\.$/)
  })

  it('answers another computer the page on the box\'s public origin, which the desktop carries on a loopback origin of its own', async () => {
    const ctx = { db: {}, dataDir: dir, service: { url: () => `${base}/w/full/` }, enabled: () => true, log: (l: string) => logs.push(l) } as never
    const seams = (fe as unknown as { deps: object }).deps
    fullEditorOf(ctx, seams as never)
    const admin = { kind: 'remote' as const, caps: ['read', 'operate', 'approve', 'admin'] }
    const answer = await openFull(ctx, { id: 'i1', title: 'Report.xlsx' } as never, workbook(), admin, { carry: true }, { TEMP_CODE_WORK_PUBLIC_ORIGIN: base })
    expect(answer).toEqual({ carry: expect.stringMatching(new RegExp(`^${base}/w/full/[0-9a-f]{64}/$`)) })
    const local = await openFull(ctx, { id: 'i1', title: 'Report.xlsx' } as never, join(dir, 'Report.xlsx'), { kind: 'local', caps: [] })
    expect(local).toEqual({ url: `${base}/w/full/${(answer as { carry: string }).carry.split('/')[5]}/` })
    await fullEditorOf(ctx).stop('test over')
  })

  it('reaches the editor through the tunnel only by the carrier, whose loopback origin the editor\'s links name', async () => {
    const token = await fe.open({ path: workbook(), itemId: 'i1', title: 'Report.xlsx' })
    // As the tunnel delivers it: Cloudflare's headers on the remote UI's hostname.
    const tunnel = { Host: 'tempcode.example', 'CF-Ray': 'r1', 'CF-Connecting-IP': '1.2.3.4' }
    expect((await get(`/w/full/${token}/`, tunnel)).status).toBe(404)
    expect((await get(`/w/full/${token}/web-apps/apps/api/documents/api.js`, tunnel)).status).toBe(404)
    try {
      const page = await carry(`${base}/w/full/${token}/`)
      expect(page).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/w/full/${token}/$`))
      const via = new URL(page)
      const at = (path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> =>
        new Promise((resolve, reject) => {
          request(`${via.origin}${path}`, { headers }, (res) => {
            let body = ''
            res.on('data', (c) => (body += c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
          }).on('error', reject).end()
        })
      // The browser names the carrier's own address; the carrier passes Cloudflare's headers on as the tunnel would add them.
      const cf = { 'CF-Ray': 'r1', 'CF-Connecting-IP': '1.2.3.4' }
      expect((await at(`/w/full/${token}/`, { ...cf, Host: 'rebound.example' })).status).toBe(404)
      const shown = await at(`/w/full/${token}/`, cf)
      expect(shown.status).toBe(200)
      expect(shown.body).toContain(`/w/full/${token}/web-apps/apps/api/documents/api.js`)
      const api = await at(`/w/full/${token}/web-apps/apps/api/documents/api.js`, cf)
      expect(api.status).toBe(200)
      expect(api.headers['x-seen-host']).toBe(`${via.host}/w/full/${token}`)
      // Nothing else of the box goes through the carrier.
      expect((await at(`/w/open`)).status).toBe(404)
      expect((await at(`/w/full/${'a'.repeat(64)}/`)).status).toBe(404)
      // The editor's socket too.
      const got = await new Promise<string>((resolve, reject) => {
        const sock = connect(Number(via.port), '127.0.0.1', () => sock.write(`GET /w/full/${token}/doc/k/c/?EIO=4&transport=websocket HTTP/1.1\r\nHost: ${via.host}\r\nOrigin: ${via.origin}\r\nCF-Ray: r1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`))
        let text = ''
        sock.on('data', (c) => {
          text += c.toString()
          if (text.includes('\r\n\r\n') && !text.includes('ping')) sock.write('ping')
          if (text.endsWith('ping')) {
            sock.destroy()
            resolve(text)
          }
        })
        sock.on('error', reject)
      })
      expect(got).toMatch(/^HTTP\/1\.1 101/)
      // A socket that names no origin, or another, is not passed.
      const refused = await new Promise<string>((resolve) => {
        const sock = connect(Number(via.port), '127.0.0.1', () => sock.write(`GET /w/full/${token}/doc/k/c/?EIO=4&transport=websocket HTTP/1.1\r\nHost: ${via.host}\r\nOrigin: https://evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`))
        sock.on('data', (c) => resolve(c.toString()))
      })
      expect(refused).toMatch(/^HTTP\/1\.1 404/)
    } finally {
      await closeCarriers()
    }
  })
})
