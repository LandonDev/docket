import { lookup } from 'node:dns/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TEMPCODE_ORIGIN_REFUSAL, type TempCodeOrigins } from '../remote/tempcodeOrigins'
import { BROWSER_INPUT_PROOF_MS } from '../remote/ownerBrowserEndpoints'
import { BROWSER_ADDRESS_UNAVAILABLE, BROWSER_PEER_UNCONFIRMED } from './policy'
import { computerHarness, type ComputerHarness } from './runHarness'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

const dns: Record<string, string[]> = {
  'ordinary.test': ['93.184.215.14', '2606:4700:4700::1111'],
  'lan-alias.test': ['2001:db8::abcd', '192.168.4.20'],
  'tunnel-alias.test': ['2001:db8:abcd::8'],
  'tunnel.example': ['203.0.113.8', '2001:db8:abcd::8'],
  'peer.example': ['203.0.113.7'],
  'peer-alias.test': ['203.0.113.7'],
  'peer-lan-alias.test': ['2606:4700:4700::1111', '192.168.40.9']
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

it.each([
  'http://192.168.40.9:8192/ui',
  'http://peer.local:8192/ui',
  'http://peer:8192/ui',
  'http://peer-lan-alias.test:8192/ui',
  'http://unresolved.test:8192/ui',
  'http://127.1:8192/ui',
  'http://169.254.1.4:8192/ui',
  'http://[fd00::1]:8192/ui',
  'http://[fe80::1]:8192/ui',
  'http://[::ffff:192.168.40.9]:8192/ui',
  'about:blank'
])('fails closed while a peer has never announced its addresses at %s', async (url) => {
  const h = make(false, url, () => ({ ...origins(), linkedEndpointsUnknown: true }))
  const target = { app: 'Webby' }
  expect(await h.run('computer_observe', target)).toMatchObject({ body: BROWSER_ADDRESS_UNAVAILABLE })
  expect(await h.run('computer_act', { ...target, action: 'key', text: 'Enter' })).toMatchObject({ body: BROWSER_PEER_UNCONFIRMED })
  expect(h.requests().some(({ method }) => method === 'state.get' || method === 'action.run')).toBe(false)
})

it.each(['https://ordinary.test/', 'http://ordinary.test:7677/', 'http://ordinary.test:8192/'])(
  'allows a public read and refuses public input while a peer is unknown at %s',
  async (url) => {
    const h = make(false, url, () => ({ ...origins(), linkedEndpointsUnknown: true }))
    const target = { app: 'Webby' }
    expect((await h.run('computer_observe', target)).isError).toBe(false)
    h.set('t1', { scope: 'work', permission: 'auto' })
    h.setAway(true)
    expect(await h.run('computer_act', { ...target, action: 'key', text: 'Enter' })).toMatchObject({ body: BROWSER_PEER_UNCONFIRMED })
    expect(h.requests().some(({ method }) => method === 'action.run')).toBe(false)
  }
)

it('refuses to open a public browser URL while a peer set is missing', async () => {
  const h = make(false, undefined, () => ({ ...origins(), linkedEndpointsUnknown: true }))
  expect(await h.run('computer_apps', { launch: 'Webby', open: ['https://ordinary.test/'] })).toMatchObject({
    body: BROWSER_PEER_UNCONFIRMED
  })
  expect(h.requests().some(({ method }) => method === 'apps.launch')).toBe(false)
})

it.each(['192.168.40.9', 'peer-lan-alias.test'])('recognizes a moved peer by its LAN address at %s', async (host) => {
  const h = make(false, `http://${host}:8192/ui`, () => ({ ...origins(), linkedEndpoints: [linkedPeer] }))
  expect(await h.run('computer_observe', { app: 'Webby' })).toMatchObject({ body: TEMPCODE_ORIGIN_REFUSAL })
  expect(h.requests().some(({ method }) => method === 'state.get')).toBe(false)
})

it('fences a moved peer before and after the announcement, even if another peer lists the new port', async () => {
  const other = { listenerPorts: [8192], lanAddresses: ['192.168.40.8'], remoteRoutes: [] }
  let moving = linkedPeer
  // Model both an old port list and a LAN address not in that list.
  const h = make(false, 'http://192.168.40.10:8192/ui', () => ({ ...origins(), linkedEndpoints: [moving, other] }))
  const target = { app: 'Webby' }
  expect(await h.run('computer_observe', target)).toMatchObject({ body: BROWSER_ADDRESS_UNAVAILABLE })
  expect(await h.run('computer_act', { ...target, action: 'key', text: 'Enter' })).toMatchObject({ body: BROWSER_ADDRESS_UNAVAILABLE })

  moving = { ...linkedPeer, listenerPorts: [8192], lanAddresses: ['192.168.40.10'] }
  expect(await h.run('computer_observe', target)).toMatchObject({ body: TEMPCODE_ORIGIN_REFUSAL })
  expect(await h.run('computer_act', { ...target, action: 'key', text: 'Enter' })).toMatchObject({ body: TEMPCODE_ORIGIN_REFUSAL })
  expect(h.requests().some(({ method }) => method === 'state.get' || method === 'action.run')).toBe(false)
})

it('refuses input with an old peer list until the move is confirmed', async () => {
  let confirmed = false
  const stillCached = () => ({ ...origins(), linkedEndpoints: [linkedPeer] })
  const h = computerHarness({
    origins: stillCached,
    confirmBrowserInput: async () => ({ origins: { ...stillCached(), linkedEndpointsUnknown: !confirmed }, valid: () => true, expiresAt: performance.now() + BROWSER_INPUT_PROOF_MS }),
    env: { FAKE_BROWSER_URL: 'https://ordinary.test/' }
  })
  open.push(h)
  const act = { app: 'Webby', action: 'key', text: 'Tab' }
  expect(await h.run('computer_act', act)).toMatchObject({ body: BROWSER_PEER_UNCONFIRMED })
  expect(h.requests().some(({ method }) => method === 'action.run')).toBe(false)

  confirmed = true
  expect((await h.run('computer_act', act)).isError).toBe(false)
  expect(h.requests().some(({ method }) => method === 'action.run')).toBe(true)
})

it('refuses browser input if its peer proof expires before dispatch', async () => {
  const h = computerHarness({
    origins,
    confirmBrowserInput: async () => ({ origins: origins(), valid: () => false, expiresAt: performance.now() }),
    env: { FAKE_BROWSER_URL: 'https://ordinary.test/' }
  })
  open.push(h)
  expect(await h.run('computer_act', { app: 'Webby', action: 'key', text: 'Tab' })).toMatchObject({ body: BROWSER_PEER_UNCONFIRMED })
  expect(h.requests().some(({ method }) => method === 'action.run')).toBe(false)
})

it.each([false, true])('sends a relative proof on a standalone host for browser actions (Windows VM: %s)', async (vm) => {
  const url = 'https://ordinary.test/'
  const h = computerHarness({
    vm,
    origins,
    confirmBrowserInput: async () => ({ origins: origins(), valid: () => true, expiresAt: performance.now() + BROWSER_INPUT_PROOF_MS }),
    env: { FAKE_BROWSER_URL: url }
  })
  open.push(h)
  const target = { app: 'Webby' }
  const key = { action: 'key', text: 'Tab' }
  expect((await h.run('computer_observe', target)).isError).toBe(false)
  expect((await h.run('computer_act', { ...target, ...key })).isError).toBe(false)
  expect((await h.run('computer_batch', { ...target, actions: [key, key] })).isError).toBe(false)
  const requests = h.requests()
  expect(requests.find(({ method }) => method === 'state.get')?.params).not.toHaveProperty('browserInputBudget')
  for (const method of ['action.run', 'action.batch']) {
    const params = requests.find((req) => req.method === method)?.params
    expect(params?.browserUrl).toBe(url)
    const budget = params?.browserInputBudget as { remainingMs: number; sampleBudgetMs: number; sample: unknown }
    expect(budget.sample).toEqual({ elapsedUs: 5_000_000, sleepUpperUs: 20 })
    expect(budget.remainingMs).toBeGreaterThan(0)
    expect(budget.remainingMs).toBeLessThanOrEqual(BROWSER_INPUT_PROOF_MS)
    expect(budget.sampleBudgetMs).toBeGreaterThanOrEqual(budget.remainingMs)
    expect(params).not.toHaveProperty('browserDeadlineMs')
  }
})

it('refuses input that needs a deadline on an older service', async () => {
  const h = computerHarness({
    origins,
    confirmBrowserInput: async () => ({ origins: origins(), valid: () => true, expiresAt: performance.now() + BROWSER_INPUT_PROOF_MS }),
    env: { FAKE_BROWSER_URL: 'https://ordinary.test/', FAKE_BROWSER_CLOCK: 'missing' }
  })
  open.push(h)
  expect(await h.run('computer_act', { app: 'Webby', action: 'key', text: 'Tab' })).toMatchObject({
    body: 'refused: update the computer service to check when browser input expires.'
  })
  expect(h.requests().some(({ method }) => method === 'action.run')).toBe(false)
})

it('allows an ordinary address on a peer port once all peer sets are fresh', async () => {
  const h = make(false, 'http://192.168.40.11:8191/', () => ({ ...origins(), linkedEndpoints: [linkedPeer] }))
  expect((await h.run('computer_observe', { app: 'Webby' })).isError).toBe(false)
})

it('reads a tab a step moved to another page at its new address, checked again', async () => {
  const h = computerHarness({ origins, env: { FAKE_BROWSER_URL: 'https://ordinary.test/', FAKE_BROWSER_NAVIGATES: 'https://ordinary.test/next' } })
  open.push(h)
  const act = await h.run('computer_act', { app: 'Webby', action: 'key', text: 'Enter' })
  expect(act.isError).toBe(false)
  expect(act.body).not.toContain('could not be verified')
  const reads = h.requests().filter((req) => req.method === 'state.get')
  expect(reads.map((req) => req.params.browserUrl)).toEqual(['https://ordinary.test/next'])
})

it('still refuses to read a tab a step moved onto the app’s own page', async () => {
  const h = computerHarness({ origins, env: { FAKE_BROWSER_URL: 'https://ordinary.test/', FAKE_BROWSER_NAVIGATES: 'http://127.0.0.1:7677/ui' } })
  open.push(h)
  const act = await h.run('computer_act', { app: 'Webby', action: 'key', text: 'Enter' })
  expect(act.body).toBe('observation failed: refused: the browser tab is off limits or its address could not be verified.')
  expect(h.requests().some((req) => req.method === 'state.get')).toBe(false)
  expect(await h.run('computer_observe', { app: 'Webby' })).toMatchObject({ isError: true, body: TEMPCODE_ORIGIN_REFUSAL })
})
