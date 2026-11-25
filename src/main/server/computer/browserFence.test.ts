import { lookup } from 'node:dns/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TEMPCODE_ORIGIN_REFUSAL, type TempCodeOrigins } from '../remote/tempcodeOrigins'
import { BROWSER_ADDRESS_UNAVAILABLE } from './policy'
import { computerHarness, type ComputerHarness } from './runHarness'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

const dns: Record<string, string[]> = {
  'ordinary.test': ['203.0.113.20'],
  'lan-alias.test': ['2001:db8::abcd', '192.168.4.20'],
  'tunnel-alias.test': ['2001:db8:abcd::8'],
  'tunnel.example': ['203.0.113.8', '2001:db8:abcd::8'],
  'peer.example': ['203.0.113.7'],
  'peer-alias.test': ['203.0.113.7'],
  'peer-lan-alias.test': ['2001:db8::abcd', '192.168.40.9']
}
beforeEach(() => {
  vi.mocked(lookup).mockImplementation((async (host: string, options: { all: boolean }) => {
    expect(options.all).toBe(true)
    const addresses = dns[host]
    if (!addresses) throw new Error('DNS failed')
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }) as typeof lookup)
})

const origins = () => ({
  listenerPorts: [7677],
  lanAddresses: ['192.168.4.20'],
  remoteRoutes: ['https://peer.example', 'https://tunnel.example'],
  tunnelHosts: ['tunnel.example']
})
const open: ComputerHarness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})
function make(vm: boolean, url?: string, readOrigins: () => TempCodeOrigins = origins): ComputerHarness {
  const h = computerHarness({ vm, origins: readOrigins, env: { FAKE_BROWSER_URL: url ?? '' } })
  open.push(h)
  return h
}

it.each([false, true])(
  'fences native browser reads and acts in each access mode (Windows VM: %s)',
  async (vm) => {
    const h = make(vm, 'http://127.0.0.1:7677/ui')
    const target = { app: 'Webby', window: 'Web front' }
    for (const scope of ['code', 'work'] as const) {
      for (const permission of ['safe', 'edits', 'auto'] as const) {
        h.set('t1', { scope, permission })
        for (const away of [false, true]) {
          h.setAway(away)
          const read = await h.run('computer_observe', target)
          const act = await h.run('computer_act', { ...target, action: 'key', text: 'Enter' })
          expect(read).toMatchObject({ isError: true, body: TEMPCODE_ORIGIN_REFUSAL })
          expect(act).toMatchObject({ isError: true, body: TEMPCODE_ORIGIN_REFUSAL })
        }
      }
    }
    expect(
      h.requests().some((req) => ['state.get', 'action.run', 'action.batch'].includes(req.method))
    ).toBe(false)
    expect(h.cards).toHaveLength(0)
  }
)

it.each([false, true])(
  'passes a verified ordinary URL to each native request (Windows VM: %s)',
  async (vm) => {
    const url = 'https://ordinary.test/'
    const h = make(vm, url)
    const target = { app: 'Webby' }
    expect((await h.run('computer_observe', target)).isError).toBe(false)
    expect((await h.run('computer_act', { ...target, action: 'key', text: 'Tab' })).isError).toBe(
      false
    )
    const requests = h
      .requests()
      .filter((req) => req.method === 'state.get' || req.method === 'action.run')
    expect(requests.map((req) => req.params.browserUrl)).toEqual([url, url])
  }
)

it('refuses an unreadable tab and a direct open to a linked host', async () => {
  const h = make(false)
  expect(await h.run('computer_observe', { app: 'Webby' })).toMatchObject({
    body: BROWSER_ADDRESS_UNAVAILABLE
  })
  expect(
    await h.run('computer_apps', { launch: 'Webby', open: ['https://peer.example/ui'] })
  ).toMatchObject({ body: TEMPCODE_ORIGIN_REFUSAL })
  expect(h.requests().some((req) => req.method === 'apps.launch')).toBe(false)
})

it('refuses a known browser on an old native service', async () => {
  const h = computerHarness({
    origins,
    env: { FAKE_OLD_BROWSER_SERVICE: '1' },
    resolveApp: (name) => (name === 'Chrome' ? { pid: 17100 } : null)
  })
  open.push(h)
  expect(await h.run('computer_observe', { app: 'Chrome' })).toMatchObject({
    body: BROWSER_ADDRESS_UNAVAILABLE
  })
  expect((await h.run('computer_observe', { app: 'TextEdit' })).isError).toBe(false)
})

it('treats the Windows VM gateway as the box loopback at the listener port', async () => {
  const h = make(true, 'http://10.0.2.2:7677/ui')
  expect(await h.run('computer_observe', { app: 'Webby' })).toMatchObject({
    body: TEMPCODE_ORIGIN_REFUSAL
  })
})

it.each([
  ['http://lan-alias.test:7677/ui', TEMPCODE_ORIGIN_REFUSAL],
  ['https://tunnel-alias.test/ui', TEMPCODE_ORIGIN_REFUSAL],
  ['https://tunnel-alias.test:7677/ui', TEMPCODE_ORIGIN_REFUSAL],
  ['https://peer-alias.test/ui', TEMPCODE_ORIGIN_REFUSAL],
  ['http://unresolved.test:7677/ui', BROWSER_ADDRESS_UNAVAILABLE]
])('refuses reads and acts before dispatch on %s', async (url, line) => {
  const h = make(false, url)
  const target = { app: 'Webby' }
  expect(await h.run('computer_observe', target)).toMatchObject({ isError: true, body: line })
  expect(await h.run('computer_act', { ...target, action: 'key', text: 'Enter' })).toMatchObject({
    isError: true,
    body: line
  })
  expect(h.requests().some(({ method }) => method === 'state.get' || method === 'action.run')).toBe(
    false
  )
})

const linkedPeer = {
  listenerPorts: [8191],
  lanAddresses: ['192.168.40.9', 'peer.local'],
  remoteRoutes: ['https://peer.example']
}

it.each(['192.168.40.9', 'peer.local', 'peer-lan-alias.test'])('blocks a tunnel-linked peer on its own LAN port at %s', async (host) => {
  const h = make(false, `http://${host}:8191/ui`, () => ({ ...origins(), linkedEndpoints: [linkedPeer] }))
  const target = { app: 'Webby' }
  expect(await h.run('computer_observe', target)).toMatchObject({ body: TEMPCODE_ORIGIN_REFUSAL })
  expect(await h.run('computer_act', { ...target, action: 'key', text: 'Enter' })).toMatchObject({ body: TEMPCODE_ORIGIN_REFUSAL })
  expect(h.requests().some(({ method }) => method === 'state.get' || method === 'action.run')).toBe(false)
})

it.each(['https://ordinary.test/', 'http://ordinary.test:7677/', 'http://ordinary.test:8191/'])('fails closed on a known port while a peer set is missing at %s', async (url) => {
  const h = make(false, url, () => ({ ...origins(), linkedEndpoints: [linkedPeer], linkedEndpointsUnknown: true }))
  expect(await h.run('computer_observe', { app: 'Webby' })).toMatchObject({ body: BROWSER_ADDRESS_UNAVAILABLE })
  expect(h.requests().some(({ method }) => method === 'state.get')).toBe(false)
})

it('keeps unrelated ports available while a peer set is missing', async () => {
  const h = make(false, 'http://ordinary.test:8192/', () => ({ ...origins(), linkedEndpoints: [linkedPeer], linkedEndpointsUnknown: true }))
  expect((await h.run('computer_observe', { app: 'Webby' })).isError).toBe(false)
})

it('allows an ordinary address on a peer port once all peer sets are fresh', async () => {
  const h = make(false, 'http://192.0.2.30:8191/', () => ({ ...origins(), linkedEndpoints: [linkedPeer] }))
  expect((await h.run('computer_observe', { app: 'Webby' })).isError).toBe(false)
})
