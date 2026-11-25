import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCollaborationClient, DOCUMENT_FRAGMENT, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabClaims, type CollabSigner } from 'work-kit/collab-server'
import { BOX_DATA_DIR, BOX_PUBLIC_ORIGIN, isIsolatedInstance, lifeosServerOf, serviceOrigins, servicePaths, servicePort, INSTALLED_WORK_PORT } from './config'
import { BOX_PROD_DATA_DIR } from '../../processGuard'
import { startFakeConvex, type FakeConvex } from './fakeConvex'
import { PUBLIC_ROUTES } from './routes'
import { startWorkService, type RunningService } from './serve'
import { originAllowed } from './routes/route'
import type { ServiceConfig, ServiceLink, ServiceOrigins } from './wire'

/*
 * The Work service in process, as its utility process runs it: both
 * listeners, the routes, a real Hocuspocus and the package's own
 * collaboration client, against a fake LifeOS Convex.
 */

const SECRET = 's'.repeat(43)
const open: { dirs: string[]; services: RunningService[]; clients: CollaborationClient[]; convex: FakeConvex[] } = { dirs: [], services: [], clients: [], convex: [] }

afterEach(async () => {
  await Promise.all(open.clients.splice(0).map((c) => c.destroy()))
  await Promise.all(open.services.splice(0).map((s) => s.stop().catch(() => {})))
  await Promise.all(open.convex.splice(0).map((c) => c.close()))
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const until = async (what: string, ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Rig {
  keys: Awaited<ReturnType<typeof generateCollabKeys>>
  service: RunningService
  config: ServiceConfig
  convex: FakeConvex
  sign: CollabSigner
  dir: string
}

async function rig(o: { here?: boolean; links?: ServiceLink[]; dir?: string; convex?: FakeConvex; keys?: Awaited<ReturnType<typeof generateCollabKeys>>; origins?: ServiceOrigins; owner?: string; log?: (line: string) => void; sheetCommit?: (c: { key: string; rev: number }) => void } = {}): Promise<Rig> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'm18-svc-'))
  if (!o.dir) open.dirs.push(dir)
  const convex = o.convex ?? (await startFakeConvex())
  if (!o.convex) open.convex.push(convex)
  const keys = o.keys ?? (await generateCollabKeys('k'))
  const hosted = join(dir, 'hosted')
  mkdirSync(join(hosted, 'guest'), { recursive: true })
  writeFileSync(join(hosted, 'index.html'), '<!doctype html><p>hosted</p>')
  writeFileSync(join(hosted, 'guest', 'index.html'), '<!doctype html><p>guest</p>')
  writeFileSync(join(dir, 'secret-outside.txt'), 'never served')
  const config: ServiceConfig = {
    port: 0,
    ...(() => {
      const p = servicePaths(join(dir, 'data'))
      mkdirSync(join(dir, 'data'), { recursive: true })
      return { socketPath: p.socketPath }
    })(),
    secret: SECRET,
    dataDir: join(dir, 'data', 'work-service'),
    hostedDir: hosted,
    host: 'env_box',
    lifeos: o.here === false ? { here: false, host: 'env_box', url: convex.url } : { here: true, url: convex.url },
    trusted: [{ by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }],
    links: o.links ?? [],
    ...(o.origins ? { origins: o.origins } : {}),
    ...(o.owner ? { owner: o.owner } : {})
  }
  const service = await startWorkService(config, { jwt: async () => 'owner-jwt', log: o.log ?? (() => {}), ...(o.sheetCommit ? { sheetCommit: o.sheetCommit } : {}) })
  open.services.push(service)
  const sign = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  return { keys, service, config, convex, sign, dir }
}

const token = async (r: Rig, claims: Partial<CollabClaims> & { doc: string }, seconds = 300) =>
  (await r.sign.sign({ role: 'edit', principal: 'owner', ...claims }, seconds)).token

/** `path`: the socket's address when it is not the document's own (a guest link's `/g/ws/<id>`). */
function connect(r: Rig, name: string, tok: string, path = `/w/doc/${name}`) {
  const closes: string[] = []
  const client = createCollaborationClient({ documentName: name, token: tok, url: `ws://127.0.0.1:${r.service.port}${path}`, offline: false, retryRefusedToken: false, onClose: (why) => closes.push(why) })
  const refusals: string[] = []
  client.provider.on('authenticationFailed', ({ reason }: { reason: string }) => refusals.push(reason))
  open.clients.push(client)
  return { client, closes, refusals }
}
const synced = (c: CollaborationClient) => c.provider.isSynced && !c.provider.hasUnsyncedChanges
const probe = (c: CollaborationClient) => c.document.getText('probe').toString()

function call(socketPath: string, path: string, body: unknown, secret: string | null = SECRET): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const http = (port: number, path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init)

const fence = { botId: 'key1', sectors: ['life'], client: 'tempcode', draftOnly: true }
const addDoc = (r: Rig, id: string, extra: Partial<FakeConvex['docs'] extends Map<string, infer D> ? D : never> = {}) =>
  r.convex.docs.set(id, { _id: id, sector: 'life', seq: 0, title: id, shared: false, markdown: '', plain: '', ...extra })

describe('the installed box is not an isolated instance', () => {
  // /etc/temp-code.env, as docs/box.md has it: the box's installed host runs with TEMP_CODE_USER_DATA set to its own dir.
  const box = { TEMP_CODE_USER_DATA: '/srv/agents/temp-code-data', TEMP_CODE_HEADLESS: '1', TEMP_CODE_CLAIM_SHIM: '1', TEMP_CODE_REMOTE_PORT: '7677', NODE_ENV: 'production' }
  const devOnBox = { TEMP_CODE_USER_DATA: '/tmp/tc-m7-proof-x/box-data', TEMP_CODE_HEADLESS: '1' }
  const mac = {}
  const devOnMac = { TEMP_CODE_USER_DATA: '/Users/landon/Library/Application Support/temp-code-dev' }
  it('names the same dir processGuard calls the box prod data', () => expect(BOX_DATA_DIR).toBe(BOX_PROD_DATA_DIR))
  it('the box: installed, port 7695, serves LifeOS documents', () => {
    expect(isIsolatedInstance(box)).toBe(false)
    expect(isIsolatedInstance({ ...box, TEMP_CODE_USER_DATA: '/srv/agents/temp-code-data/' })).toBe(false)
    expect(servicePort(box)).toBe(7695)
    expect(lifeosServerOf({ env: box, platform: 'linux', savedHosts: [] })).toEqual({ here: true })
  })
  it('a dev or proof instance on the box, headless too: isolated, any port, serves none', () => {
    expect(isIsolatedInstance(devOnBox)).toBe(true)
    expect(servicePort(devOnBox)).toBe(0)
    expect(lifeosServerOf({ env: devOnBox, platform: 'linux', savedHosts: [] })).toEqual({ here: false, host: null })
  })
  it('the installed Mac: port 7695, the box serves LifeOS documents', () => {
    expect(isIsolatedInstance(mac)).toBe(false)
    expect(servicePort(mac)).toBe(7695)
    expect(lifeosServerOf({ env: mac, platform: 'darwin', savedHosts: [{ id: 'env_box', platform: 'linux' }] })).toEqual({ here: false, host: 'env_box' })
  })
  it.skipIf(process.platform !== 'linux')("on the box a guest link's and a form's address is the tunnel's hostname; a dev instance's is its own", async () => {
    const { publicOrigin } = await import('../guests/links')
    const ctx = { service: { url: () => 'http://127.0.0.1:43953/' } } as unknown as Parameters<typeof publicOrigin>[0]
    expect(publicOrigin(ctx, box)).toBe('https://tempcode.landonhale.com')
    expect(publicOrigin(ctx, devOnBox)).toBe('http://127.0.0.1:43953')
  })
  it('a dev instance on the Mac: isolated, any port, serves none', () => {
    expect(isIsolatedInstance(devOnMac)).toBe(true)
    expect(servicePort(devOnMac)).toBe(0)
    expect(lifeosServerOf({ env: devOnMac, platform: 'darwin', savedHosts: [{ id: 'env_box', platform: 'linux' }] })).toEqual({ here: false, host: null })
  })
})

describe('where the service listens', () => {
  it('7695 for the installed host, any free port for an isolated instance, TEMP_CODE_WORK_PORT over both', () => {
    expect(servicePort({})).toBe(INSTALLED_WORK_PORT)
    expect(INSTALLED_WORK_PORT).toBe(7695)
    expect(servicePort({ TEMP_CODE_USER_DATA: '/x' })).toBe(0)
    expect(servicePort({ TEMP_CODE_WORK_PORT: '7699' })).toBe(7699)
    expect(() => servicePort({ TEMP_CODE_WORK_PORT: 'many' })).toThrow(/not a port/)
  })
  it('the socket and the secret sit in userData, where the LifeOS worker looks; a path too long for a socket moves the socket only', () => {
    expect(servicePaths('/srv/agents/temp-code-data')).toEqual({
      socketPath: '/srv/agents/temp-code-data/work-service.sock',
      secretFile: '/srv/agents/temp-code-data/work-service.secret',
      serviceDir: '/srv/agents/temp-code-data/work-service',
      moved: false
    })
    const deep = `/tmp/${'d'.repeat(120)}`
    expect(servicePaths(deep).socketPath).toMatch(/^.*tc-work-[0-9a-f]{16}\.sock$/)
    expect(servicePaths(deep).secretFile).toBe(`${deep}/work-service.secret`)
  })
  it('the box serves LifeOS documents; a Mac that knows a Linux host is its client; a host with no box serves them itself', () => {
    expect(lifeosServerOf({ env: {}, platform: 'linux', savedHosts: [] })).toEqual({ here: true })
    expect(lifeosServerOf({ env: {}, platform: 'darwin', savedHosts: [{ id: 'env_mac2', platform: 'darwin' }, { id: 'env_box', platform: 'linux' }] })).toEqual({ here: false, host: 'env_box' })
    expect(lifeosServerOf({ env: {}, platform: 'darwin', savedHosts: [] })).toEqual({ here: true })
    // Only an isolated instance may name the server, and one that names none serves none: it is never a second writer.
    expect(lifeosServerOf({ env: { TEMP_CODE_WORK_LIFEOS_SERVER: 'env_x' }, platform: 'linux', savedHosts: [] })).toEqual({ here: true })
    expect(lifeosServerOf({ env: { TEMP_CODE_USER_DATA: '/d', TEMP_CODE_WORK_LIFEOS_SERVER: 'env_x' }, platform: 'linux', savedHosts: [] })).toEqual({ here: false, host: 'env_x' })
    expect(lifeosServerOf({ env: { TEMP_CODE_USER_DATA: '/d' }, platform: 'linux', savedHosts: [] })).toEqual({ here: false, host: null })
    expect(lifeosServerOf({ env: { TEMP_CODE_USER_DATA: '/d', TEMP_CODE_WORK_LIFEOS_SERVER: 'here' }, platform: 'darwin', savedHosts: [] })).toEqual({ here: true })
  })
})

describe('which pages may open a socket', () => {
  const req = (origin?: string) => ({ headers: origin === undefined ? {} : { origin } }) as never
  const box: ServiceOrigins = { allowed: [BOX_PUBLIC_ORIGIN], guest: null, loopback: false }
  const flipped: ServiceOrigins = { allowed: [BOX_PUBLIC_ORIGIN, 'https://share.landonhale.com'], guest: 'https://share.landonhale.com', loopback: false }
  const isolated: ServiceOrigins = { allowed: ['http://127.0.0.1:7001'], guest: null, loopback: true }

  it('the box names its hostname, a proof the origin it was given, an installed Mac none; only an isolated instance takes loopback for a guest', () => {
    expect(serviceOrigins(null, { TEMP_CODE_USER_DATA: BOX_DATA_DIR }, 'linux')).toEqual(box)
    expect(serviceOrigins('https://share.landonhale.com', { TEMP_CODE_USER_DATA: BOX_DATA_DIR }, 'linux')).toEqual(flipped)
    expect(serviceOrigins(null, { TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_WORK_PUBLIC_ORIGIN: 'http://127.0.0.1:7001/' }, 'linux')).toEqual(isolated)
    expect(serviceOrigins(null, {}, 'darwin')).toEqual({ allowed: [], guest: null, loopback: false })
  })

  it('a socket that names no origin is a native client or main: it passes, but never as a guest on a public host', () => {
    expect(originAllowed(req(), box, '/w/doc/kd1')).toBe(true)
    expect(originAllowed(req(), box, '/w/sheet/ks1')).toBe(true)
    expect(originAllowed(req(), box, '/g/ws/L1')).toBe(false)
    expect(originAllowed(req(), isolated, '/g/ws/L1')).toBe(true)
  })

  it("this host's own pages pass; another site's, a sandboxed frame's and a look-alike's do not", () => {
    for (const path of ['/w/doc/kd1', '/w/sheet/ks1', '/g/ws/L1', '/w/office', `/w/full/${'a'.repeat(64)}/x`]) {
      expect(originAllowed(req(BOX_PUBLIC_ORIGIN), box, path), path).toBe(true)
      for (const foreign of ['https://evil.example', 'null', 'https://tempcode.landonhale.com.evil.example', 'http://tempcode.landonhale.com', `${BOX_PUBLIC_ORIGIN}/`])
        expect(originAllowed(req(foreign), box, path), `${foreign} on ${path}`).toBe(false)
    }
  })

  it("LifeOS's desktop window (a file) and a page on loopback reach the owner's sockets, never a guest's on a public host", () => {
    for (const origin of ['file://', 'http://localhost:5173', 'http://127.0.0.1:9000', 'http://[::1]:5173']) {
      expect(originAllowed(req(origin), box, '/w/doc/kd1'), origin).toBe(true)
      expect(originAllowed(req(origin), box, '/g/ws/L1'), origin).toBe(false)
    }
    expect(originAllowed(req('http://127.0.0.1:9000'), isolated, '/g/ws/L1')).toBe(true)
    expect(originAllowed(req('http://127.0.0.1.evil.example'), isolated, '/g/ws/L1')).toBe(false)
  })

  it('once guest pages have their own origin, a guest socket takes that one alone; the old hostname still opens the owner\'s', () => {
    expect(originAllowed(req('https://share.landonhale.com'), flipped, '/g/ws/L1')).toBe(true)
    expect(originAllowed(req(BOX_PUBLIC_ORIGIN), flipped, '/g/ws/L1')).toBe(false)
    expect(originAllowed(req(BOX_PUBLIC_ORIGIN), flipped, '/w/doc/kd1')).toBe(true)
    expect(originAllowed(req('https://share.landonhale.com'), flipped, '/w/sheet/ks1')).toBe(true)
  })

  it('every route that takes a socket refuses a foreign page at the upgrade (403) and hands its own to the route', async () => {
    const r = await rig({ origins: { allowed: ['https://pages.test'], guest: null, loopback: false } })
    const { WebSocket: Ws } = await import('ws')
    const probes: Record<string, string> = { doc: '/w/doc/kd1', sheet: '/w/sheet/ks1', guest: '/g/ws/L1', office: '/w/office', full: `/w/full/${'a'.repeat(64)}/x` }
    const sockets = PUBLIC_ROUTES.filter((x) => x.upgrade)
    const status = (path: string, origin?: string) =>
      new Promise<number>((resolve) => {
        const ws = new Ws(`ws://127.0.0.1:${r.service.port}${path}`, origin ? { origin } : {})
        ws.on('open', () => (ws.terminate(), resolve(101)))
        ws.on('unexpected-response', (_q, res) => (ws.terminate(), resolve(res.statusCode ?? 0)))
        ws.on('error', () => resolve(0))
      })
    for (const route of sockets) {
      const path = Object.entries(probes).find(([, p]) => route.match.test(p))?.[1]
      expect(path, `a probe for "${route.name}"`).toBeDefined()
      expect(await status(path!, 'https://evil.example'), `${path} from another site`).toBe(403)
      expect(await status(path!, 'https://pages.test'), `${path} from this host's page`).not.toBe(403)
      // No origin at all: a guest's socket is a browser's alone on a public host; the others take a native client.
      const none = await status(path!)
      if (path!.startsWith('/g/ws/')) expect(none, `${path} with no origin`).toBe(403)
      else expect(none, `${path} with no origin`).not.toBe(403)
    }
  })
})

describe('the two listeners', () => {
  it("answers /w/healthz with this run's start mark and nothing else; a restart is a new mark", async () => {
    const r = await rig()
    const res = await http(r.service.port, '/w/healthz')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(r.service.mark)
    expect(r.service.mark).toMatch(/^[0-9a-f]{32}$/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await http(r.service.port, '/w/healthz', { method: 'POST' })).status).toBe(405)
    expect((await http(r.service.port, '/w/healthz/more')).status).toBe(404)
    const again = await rig()
    expect(again.service.mark).not.toBe(r.service.mark)
  })

  it('a stopping service tells every open socket it is restarting (1012), so a page waits and does not end', async () => {
    const r = await rig()
    addDoc(r, 'kd9')
    const { WebSocket: Ws } = await import('ws')
    const ws = new Ws(`ws://127.0.0.1:${r.service.port}/w/doc/kd9`)
    await new Promise((resolve, reject) => (ws.on('open', resolve), ws.on('error', reject)))
    const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    await r.service.stop()
    expect(await closed).toEqual({ code: 1012, reason: 'the service is restarting' })
  })

  it('an internal route answers on the socket with the secret, refuses it without, and is unreachable on the public port either way', async () => {
    const r = await rig()
    addDoc(r, 'kd1', { markdown: 'stored', plain: 'stored' })
    const ok = await call(r.config.socketPath, '/internal/doc/read', { docId: 'kd1', fence })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ markdown: '', seq: 0 })
    expect((await call(r.config.socketPath, '/internal/doc/read', { docId: 'kd1', fence }, null)).status).toBe(401)
    expect((await call(r.config.socketPath, '/internal/doc/read', { docId: 'kd1', fence }, 'x'.repeat(43))).status).toBe(401)
    for (const auth of [undefined, `Bearer ${SECRET}`]) {
      for (const method of ['GET', 'POST']) {
        const res = await http(r.service.port, '/internal/doc/read', { method, headers: auth ? { Authorization: auth, 'Content-Type': 'application/json' } : {}, ...(method === 'POST' ? { body: JSON.stringify({ docId: 'kd1', fence }) } : {}) })
        expect(res.status, `${method} ${auth ? 'with' : 'without'} the secret`).toBe(404)
        expect(await res.text()).toBe('not found')
      }
    }
    // Nor under any spelling the router might fold onto it.
    for (const path of ['/internal/doc/read/', '//internal/doc/read', '/w/../internal/doc/read', '/%69nternal/doc/read', '/w/hosted/../../internal/doc/read'])
      expect((await http(r.service.port, path, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` }, body: '{}' })).status, path).not.toBe(200)
  })

  it('the public listener binds to loopback only', async () => {
    const r = await rig()
    const { networkInterfaces } = await import('node:os')
    const outside = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)
    if (!outside) return
    await expect(fetch(`http://${outside.address}:${r.service.port}/w/hosted/`)).rejects.toThrow()
  })

  it('every later route answers "not built" with its milestone, over HTTP and as a socket; anything else is not found', async () => {
    const r = await rig()
    const probes: Record<string, string> = { 27: '/w/sheet/s1', 29: '/w/office', 36: '/f/f1', 40: '/w/full/t/x' }
    // Built: 18's documents and pages, 27's live sheets (routes/sheet.test.ts), 29's add-in relay (office/addin/addin.test.ts),
    // 31's guest links and hosted editor (guests/guests.test.ts), 36's forms (forms/forms.test.ts).
    for (const route of PUBLIC_ROUTES.filter((x) => ![18, 27, 29, 31, 36].includes(x.milestone))) {
      const paths = [probes[route.milestone] ?? '']
      for (const p of paths) {
        if (!route.match.test(p)) continue
        const res = await http(r.service.port, p)
        expect(res.status, p).toBe(501)
        expect(await res.text(), p).toBe(`not built: ${route.name} (milestone ${route.milestone})`)
        const ws = new WebSocket(`ws://127.0.0.1:${r.service.port}${p}`)
        const failed = await new Promise<boolean>((resolve) => {
          ws.onopen = () => resolve(false)
          ws.onerror = () => resolve(true)
        })
        expect(failed, `${p} as a socket`).toBe(true)
      }
    }
    expect(new Set(PUBLIC_ROUTES.map((x) => x.milestone))).toEqual(new Set([18, 27, 31, 29, 36, 40]))
    expect((await http(r.service.port, '/')).status).toBe(404)
    expect((await http(r.service.port, '/w/elsewhere')).status).toBe(404)
  })

  it('holds sockets to a cap per caller, counting by the tunnel\'s CF-Connecting-IP', async () => {
    const r = await rig()
    const { MAX_SOCKETS_PER_CALLER } = await import('./serve')
    const { WebSocket: Ws } = await import('ws')
    const opened: InstanceType<typeof Ws>[] = []
    const openOne = (ip: string) =>
      new Promise<boolean>((resolve) => {
        const ws = new Ws(`ws://127.0.0.1:${r.service.port}/w/doc/kd1`, { headers: { 'CF-Connecting-IP': ip } })
        opened.push(ws)
        ws.on('open', () => resolve(true))
        ws.on('error', () => resolve(false))
        ws.on('unexpected-response', () => resolve(false))
      })
    for (let i = 0; i < MAX_SOCKETS_PER_CALLER; i++) expect(await openOne('203.0.113.7')).toBe(true)
    expect(await openOne('203.0.113.7')).toBe(false)
    expect(await openOne('203.0.113.8')).toBe(true)
    for (const ws of opened) ws.terminate()
    await sleep(100)
    expect(await openOne('203.0.113.7')).toBe(true)
    for (const ws of opened) ws.terminate()
  })

  it('serves out/hosted at /w/hosted/ with its headers, and nothing outside it', async () => {
    const r = await rig()
    const page = await http(r.service.port, '/w/hosted/')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('hosted')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await http(r.service.port, '/w/hosted/guest/')).status).toBe(200)
    for (const p of ['/w/hosted/../secret-outside.txt', '/w/hosted/%2e%2e/secret-outside.txt', '/w/hosted/..%2fsecret-outside.txt', '/w/hosted/nothing.js'])
      expect((await http(r.service.port, p)).status, p).toBe(404)
    expect((await http(r.service.port, '/w/hosted/', { method: 'POST' })).status).toBe(405)
  })
})

describe('live documents', () => {
  it('two editors on one LifeOS document converge, and the state is stored in LifeOS with its projections', async () => {
    const r = await rig()
    addDoc(r, 'kd2', { seed: '# Plan\n\nFirst words' })
    const a = connect(r, 'kd2', await token(r, { doc: 'kd2' }))
    const b = connect(r, 'kd2', await token(r, { doc: 'kd2', principal: 'agent:env_box:t1' }))
    await until('both synced', () => synced(a.client) && synced(b.client))
    // The seed became the first state.
    expect(a.client.document.getXmlFragment(DOCUMENT_FRAGMENT).length).toBeGreaterThan(0)
    a.client.document.getText('probe').insert(0, 'abc')
    b.client.document.getText('probe').insert(0, 'xyz')
    await until('converged', () => probe(a.client).length === 6 && probe(a.client) === probe(b.client))
    await until('stored', () => (r.convex.docs.get('kd2')?.seq ?? 0) > 0, 8000)
    expect(r.convex.docs.get('kd2')!.markdown).toContain('# Plan')
    expect(r.convex.docs.get('kd2')!.plain).toContain('First words')
  })

  it('refuses a socket with no token, an expired one, one for another document, or one signed by another key', async () => {
    const r = await rig()
    addDoc(r, 'kd3')
    const other = await createCollabSigner({ privateJwk: (await generateCollabKeys('o')).privateJwk, iss: 'tempcode:env_box' })
    const past = await createCollabSigner({ privateJwk: r.keys.privateJwk, iss: 'tempcode:env_box', now: () => Date.now() - 3_600_000 })
    const tokens: [string, string][] = [
      ['none', ''],
      ['expired', (await past.sign({ doc: 'kd3', role: 'edit', principal: 'owner' }, 60)).token],
      ['another document', await token(r, { doc: 'kd4' })],
      ['another key', (await other.sign({ doc: 'kd3', role: 'edit', principal: 'owner' }, 60)).token]
    ]
    for (const [what, tok] of tokens) {
      const { client, refusals } = connect(r, 'kd3', tok)
      await until(`the socket refused ${what}`, () => refusals.length > 0)
      expect(client.provider.isSynced, what).toBe(false)
    }
    expect(r.convex.calls).not.toContain('docs:get')
  })

  it('a revoked link closes its socket within a second, and the owner stays', async () => {
    const link = { linkId: 'L1', item: { doc: 'kd5' }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null, guest: { secretHash: 'x', name: 'Dana Lee', title: 'kd5', owner: 'Landon Hale', token: '', tokenExp: 0 } } as ServiceLink
    const r = await rig({ links: [link] })
    addDoc(r, 'kd5')
    const guest = connect(r, 'kd5', await token(r, { doc: 'kd5', principal: 'guest:L1', link: 'L1' }), '/g/ws/L1')
    const owner = connect(r, 'kd5', await token(r, { doc: 'kd5' }))
    await until('both synced', () => synced(guest.client) && synced(owner.client))
    const at = Date.now()
    r.service.setLinks([{ ...link, revokedAt: Date.now() }])
    await until('the guest closed', () => guest.closes.length > 0, 1000)
    expect(Date.now() - at).toBeLessThan(1000)
    owner.client.document.getText('probe').insert(0, 'still here')
    await until('owner synced', () => synced(owner.client))
  })

  it("a token opens its own address alone: a guest link's nothing on the document's route or another link's, the owner's nothing on a link's", async () => {
    const facts = { secretHash: 'x', name: 'Dana Lee', title: 'kd7', owner: 'Landon Hale', token: '', tokenExp: 0 }
    const links = ['L1', 'L2'].map((linkId) => ({ linkId, item: { doc: 'kd7' }, role: 'edit', expiresAt: Date.now() + 60_000, revokedAt: null, guest: facts }) as ServiceLink)
    const r = await rig({ links })
    addDoc(r, 'kd7')
    const guestToken = await token(r, { doc: 'kd7', principal: 'guest:L1', link: 'L1' })
    const refusedOn = async (what: string, tok: string, path?: string) => {
      const { client, refusals } = connect(r, 'kd7', tok, path)
      await until(`refused: ${what}`, () => refusals.length > 0)
      expect(client.provider.isSynced, what).toBe(false)
    }
    // Reached directly, the document's route counts no guest socket, holds no budget and cuts no version of the visit.
    await refusedOn("a guest's token on the document's own route", guestToken)
    await refusedOn("a guest's token on another link's address", guestToken, '/g/ws/L2')
    await refusedOn("the owner's token on a link's address", await token(r, { doc: 'kd7' }), '/g/ws/L1')
    const own = connect(r, 'kd7', guestToken, '/g/ws/L1')
    const owner = connect(r, 'kd7', await token(r, { doc: 'kd7' }))
    await until('each on its own address', () => synced(own.client) && synced(owner.client))
  })

  it("the owner's own connections carry his name as he set it, whatever their page says, and keep the rest they sent", async () => {
    const r = await rig({ owner: 'Landon Hale' })
    addDoc(r, 'kd8')
    const page = connect(r, 'kd8', await token(r, { doc: 'kd8' }))
    const other = connect(r, 'kd8', await token(r, { doc: 'kd8' }))
    await until('both synced', () => synced(page.client) && synced(other.client))
    page.client.provider.awareness!.setLocalState({ user: { id: 'owner', name: 'You', color: '#14b8a6', avatarUrl: 'face.png' }, member: { id: 'owner' } })
    const seen = () => [...other.client.provider.awareness!.getStates().values()].map((st) => (st as { user?: { name?: string; color?: string; avatarUrl?: string } }).user).find((u) => u?.avatarUrl === 'face.png')
    await until('the other window sees him', () => !!seen())
    expect(seen()).toMatchObject({ name: 'Landon Hale', color: '#14b8a6', avatarUrl: 'face.png' })
  })

  it('a host that does not serve LifeOS documents refuses their sockets and reads the stored state instead', async () => {
    const r = await rig({ here: false })
    addDoc(r, 'kd6', { markdown: '# Stored', plain: 'Stored', seq: 4 })
    const { client, refusals } = connect(r, 'kd6', await token(r, { doc: 'kd6' }))
    await until('the socket refused on the non-serving host', () => refusals.length > 0)
    expect(client.provider.isSynced).toBe(false)
    const read = await call(r.config.socketPath, '/internal/doc/read', { docId: 'kd6', fence })
    expect(read).toEqual({ status: 200, body: { markdown: '# Stored', plain: 'Stored', seq: 4, stored: true } })
    const write = await call(r.config.socketPath, '/internal/doc/write', { docId: 'kd6', markdown: 'x', because: 'asked', botId: 'key1', fence })
    expect(write.status).toBe(409)
    expect(String(write.body.error)).toMatch(/does not serve LifeOS documents; env_box does/)
    expect(r.convex.calls).not.toContain('docs:store')
  })

  it('the service restarts without losing a keystroke it acknowledged, though no store landed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm18-restart-'))
    open.dirs.push(dir)
    const convex = await startFakeConvex()
    open.convex.push(convex)
    const keys = await generateCollabKeys('k')
    const first = await rig({ dir, convex, keys })
    addDoc(first, 'kd7')
    convex.failStores = true
    const a = connect(first, 'kd7', await token(first, { doc: 'kd7' }))
    await until('synced', () => synced(a.client))
    for (const ch of 'kept') a.client.document.getText('probe').insert(probe(a.client).length, ch)
    await until('acknowledged', () => synced(a.client))
    await a.client.destroy()
    open.services.splice(open.services.indexOf(first.service), 1)
    await first.service.stop()
    expect(convex.docs.get('kd7')!.stateFile).toBeUndefined()
    convex.failStores = false
    const second = await rig({ dir, convex, keys })
    const b = connect(second, 'kd7', await token(second, { doc: 'kd7' }))
    await until('synced again', () => synced(b.client))
    expect(probe(b.client)).toBe('kept')
    // and the edits the journal held are stored once the document is up
    await until('stored', () => !!convex.docs.get('kd7')!.stateFile, 5000)
  })

  it('a .tcdoc is served under its path on the host it is on', async () => {
    const r = await rig()
    const { fileDocName } = await import('work-kit/collab-server')
    const path = join(r.dir, 'Plan.tcdoc')
    const name = fileDocName(path)
    const a = connect(r, name, await token(r, { doc: name, file: { path } }))
    await until('synced', () => synced(a.client))
    a.client.document.getText('probe').insert(0, 'on disk')
    await until('acknowledged', () => synced(a.client))
    await r.service.collab.flush()
    const { unzipSync } = await import('fflate')
    const { readFileSync } = await import('node:fs')
    expect(Object.keys(unzipSync(new Uint8Array(readFileSync(path)))).sort()).toEqual(['preview.md', 'sidecar.json', 'state.yjs', 'threads.json'])
  })
})

describe('a sheet the service holds', () => {
  it('tells main of every op that lands on it, whoever wrote it: the key main knows the sheet by, and its revision', async () => {
    const { TcsheetBackend } = await import('../sheets/host/backends')
    const commits: { key: string; rev: number }[] = []
    const r = await rig({ sheetCommit: (c) => commits.push(c) })
    const path = join(r.dir, 'Budget.tcsheet')
    TcsheetBackend.create(path, 'Budget')
    for (const [at, by] of [['A1', 'owner'], ['A2', 'guest:L1']] as const) expect((await call(r.config.socketPath, '/internal/sheet/cells', { sheet: { tcsheet: path }, cells: [{ at, v: 1 }], by })).status).toBe(200)
    expect(commits).toEqual([
      { key: `tcsheet:${path}`, rev: 1 },
      { key: `tcsheet:${path}`, rev: 2 }
    ])
  })
})

describe('compaction that runs', () => {
  it('a document grown past the line is compacted once its last editor has left, and a copy from before it merges back with no word lost or doubled', async () => {
    const { COMPACTION } = await import('./compaction')
    const was = { ...COMPACTION }
    Object.assign(COMPACTION, { settleMs: 0, minBytes: 4000 })
    try {
      const logs: string[] = []
      const r = await rig({ log: (line) => logs.push(line) })
      addDoc(r, 'kd10')
      const a = connect(r, 'kd10', await token(r, { doc: 'kd10' }))
      await until('synced', () => synced(a.client))
      const text = a.client.document.getText('probe')
      // Typed and deleted many times over: the state keeps every deleted run until it is compacted.
      for (let i = 0; i < 40; i++) {
        text.insert(0, `draft ${i} ${'x'.repeat(200)} `)
        text.delete(0, text.length)
      }
      text.insert(0, 'The plan as it stands.')
      await until('stored', () => synced(a.client))
      // A device's copy from before the compaction (an offline copy), and a word typed on it since.
      const { encodeStateAsUpdate, applyUpdate } = await import('yjs')
      const copy = encodeStateAsUpdate(a.client.document)
      // The host keeps what the device lets go: its state is past the line.
      expect(encodeStateAsUpdate(r.service.collab.hocuspocus.documents.get('kd10')!).byteLength).toBeGreaterThan(4000)
      await a.client.destroy()
      await until('the last editor has left', () => (r.service.collab.hocuspocus.documents.get('kd10')?.getConnectionsCount() ?? 0) === 0)
      await sleep(50)
      await r.service.compactTick()
      await until('compacted', () => logs.some((l) => l.includes('kd10: compacted from')), 8000)
      const back = connect(r, 'kd10', await token(r, { doc: 'kd10' }))
      applyUpdate(back.client.document, copy)
      back.client.document.getText('probe').insert(0, 'Offline: ')
      await until('the copy merged', () => synced(back.client))
      const fresh = connect(r, 'kd10', await token(r, { doc: 'kd10' }))
      await until('a third reads it', () => synced(fresh.client) && probe(fresh.client).length > 0)
      expect(probe(fresh.client)).toBe('Offline: The plan as it stands.')
      expect(probe(back.client)).toBe('Offline: The plan as it stands.')
    } finally {
      Object.assign(COMPACTION, was)
    }
  }, 30_000)
})

describe('the internal document routes', () => {
  it('write, comment and create act as the owner, credit the principal, and hold the caller\'s fence', async () => {
    const r = await rig()
    addDoc(r, 'kd8', { seed: 'The budget is due Friday.' })
    addDoc(r, 'kd9', { sector: 'cosmic' })
    const a = connect(r, 'kd8', await token(r, { doc: 'kd8' }))
    await until('synced', () => synced(a.client))
    const origin = { host: 'env_box', threadId: 't9' }
    const wrote = await call(r.config.socketPath, '/internal/doc/write', { docId: 'kd8', markdown: 'The budget is due Monday.', because: 'asked', quote: 'move it', botId: 'key1', origin, fence })
    expect(wrote).toEqual({ status: 200, body: { mode: 'direct', versionId: expect.any(String) } })
    await until('the editor sees the write', () => a.client.document.getXmlFragment(DOCUMENT_FRAGMENT).toString().includes('Monday'))
    expect(Object.values(r.service.collab.clients('kd8'))).toContain('agent:env_box:t9')
    const commented = await call(r.config.socketPath, '/internal/doc/comment', { docId: 'kd8', anchorText: 'due Monday', body: 'Is Monday right?', botId: 'key1', fence })
    expect(commented.status).toBe(200)
    expect(r.convex.threads[0]).toMatchObject({ docId: 'kd8', quote: 'due Monday', author: 'lifeos:bot:key1' })
    expect(JSON.parse(r.convex.threads[0]!.body)[0].content[0].text).toBe('Is Monday right?')
    await until('the mark reaches the editor', () => a.client.document.getXmlFragment(DOCUMENT_FRAGMENT).toString().includes(String(commented.body.threadId)))
    expect((await call(r.config.socketPath, '/internal/doc/comment', { docId: 'kd8', anchorText: 'not there', body: 'x', botId: 'key1', fence })).status).toBe(400)
    // A bot's comment on a shared document is refused: it would reach the other readers before Landon saw it.
    r.convex.docs.get('kd8')!.shared = true
    expect((await call(r.config.socketPath, '/internal/doc/comment', { docId: 'kd8', anchorText: 'due Monday', body: 'Again?', botId: 'key1', fence })).status).toBe(403)
    expect(r.convex.threads).toHaveLength(1)
    r.convex.docs.get('kd8')!.shared = false
    // Another sector's document is not found, whatever the route.
    for (const route of ['/internal/doc/read', '/internal/doc/write', '/internal/doc/comment'])
      expect((await call(r.config.socketPath, route, { docId: 'kd9', markdown: 'x', because: 'asked', anchorText: 'x', body: 'x', botId: 'key1', fence })).status, route).toBe(404)
    const created = await call(r.config.socketPath, '/internal/doc/create', { sector: 'life', title: 'Notes', markdown: '# Notes\n\nFrom the agent', botId: 'key1', origin, fence })
    expect(created.status).toBe(200)
    const docId = String(created.body.docId)
    expect(r.convex.docs.get(docId)!.markdown).toContain('From the agent')
    expect((await call(r.config.socketPath, '/internal/doc/create', { sector: 'cosmic', title: 'No', markdown: '', botId: 'key1', fence })).status).toBe(404)
  })

  it('an agent\'s own change to a shared document goes into its branch and the live text waits; so does a bot key\'s "asked", which only main can check (milestones 19, 20)', async () => {
    const r = await rig()
    addDoc(r, 'kd10', { shared: false })
    const first = await call(r.config.socketPath, '/internal/doc/write', { docId: 'kd10', markdown: 'Owner words', because: 'asked', botId: 'key1', fence })
    expect(first.body).toMatchObject({ mode: 'direct', versionId: expect.any(String) })
    r.convex.docs.get('kd10')!.shared = true
    const own = await call(r.config.socketPath, '/internal/doc/write', { docId: 'kd10', markdown: 'Agent idea', because: 'own', origin: { host: 'env_box', threadId: 't1' }, fence })
    expect(own.status).toBe(200)
    expect(own.body).toMatchObject({ mode: 'branch' })
    expect(r.convex.branches).toHaveLength(1)
    expect(r.convex.branches[0]).toMatchObject({ docId: 'kd10', authors: ['agent:env_box:t1'], state: 'pending' })
    expect((await call(r.config.socketPath, '/internal/doc/read', { docId: 'kd10', fence })).body.markdown).toBe('Owner words\n')
    // The worker cannot show the owner's words: its "asked" on a shared document is a suggestion too.
    const asked = await call(r.config.socketPath, '/internal/doc/write', { docId: 'kd10', markdown: 'Asked words', because: 'asked', quote: 'write it', botId: 'key1', fence })
    expect(asked.status).toBe(200)
    expect(asked.body).toMatchObject({ mode: 'branch' })
    expect((await call(r.config.socketPath, '/internal/doc/read', { docId: 'kd10', fence })).body.markdown).toBe('Owner words\n')
    expect(r.convex.branches.map((b) => b.authors)).toEqual([['agent:env_box:t1'], ['lifeos:bot:key1']])
    // The version the first write cut is the branches' base: nothing changed since it.
    expect(r.convex.versions.map((v) => v.cause)).toEqual(['agent-turn'])
    expect(r.convex.branches.map((b) => b.baseVersionId)).toEqual([r.convex.versions[0]!._id, r.convex.versions[0]!._id])
  })

  it('the sheet routes (milestone 27) answer "not found" for a sheet LifeOS does not have; a bad body is a 400 with words', async () => {
    const r = await rig()
    expect((await call(r.config.socketPath, '/internal/sheet/read', { sheetId: 's', range: 'A1', fence })).status).toBe(404)
    const res = await call(r.config.socketPath, '/internal/sheet/write', { sheetId: 's', range: 'A1', fence })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('because is asked, routine or own')
    expect((await call(r.config.socketPath, '/internal/sheet/open', { sheet: { tcsheet: 'relative.tcsheet' } })).status).toBe(400)
    expect((await call(r.config.socketPath, '/internal/doc/write', { docId: 'kd1', fence })).status).toBe(400)
    expect((await call(r.config.socketPath, '/internal/doc/write', { docId: 'kd1', markdown: 'x', because: 'asked', fence })).status).toBe(400)
    expect((await call(r.config.socketPath, '/internal/nothing', {})).status).toBe(404)
  })
})
