import { afterEach, expect, it } from 'vitest'
import { TEMPCODE_ORIGIN_REFUSAL } from '../remote/tempcodeOrigins'
import { BROWSER_ADDRESS_UNAVAILABLE } from './policy'
import { computerHarness, type ComputerHarness } from './runHarness'

const origins = () => ({
  listenerPorts: [7677],
  lanAddresses: [],
  remoteRoutes: ['https://peer.example']
})
const open: ComputerHarness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})
function make(vm: boolean, url?: string): ComputerHarness {
  const h = computerHarness({ vm, origins, env: { FAKE_BROWSER_URL: url ?? '' } })
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
  expect(await h.run('computer_observe', { app: 'Webby' })).toMatchObject({ body: TEMPCODE_ORIGIN_REFUSAL })
})
