import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => '/tmp') },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))
vi.mock('./windows', () => ({ targetWindow: vi.fn(() => null) }))

const { appshotReady, excludeSearches, registerAppshotIpc } = await import('./appshots')
const electron = await import('electron')

it('finds the installed app by both its names, so a copy from before the rename stays out of the shot', () => {
  expect(excludeSearches()).toEqual([
    ['-x', 'Docket'],
    ['-x', 'TempCode'],
    ['-f', 'temp-code']
  ])
})

it('a window announcing appshot-ready any number of times is watched for its end once', () => {
  const destroyed: (() => void)[] = []
  const sent: unknown[] = []
  const sender = {
    id: 7,
    once: vi.fn((_event: 'destroyed', fn: () => void) => destroyed.push(fn)),
    send: vi.fn((_channel: string, payload: unknown) => sent.push(payload))
  }
  for (let i = 0; i < 12; i++) appshotReady(sender)
  expect(sender.once).toHaveBeenCalledTimes(1)
  expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
  // Gone and back (a reload lands a new announcement from a new id; the same id is watched afresh once forgotten).
  destroyed[0]()
  appshotReady(sender)
  expect(sender.once).toHaveBeenCalledTimes(2)
  expect(sent).toEqual([])
})

it('registers the ready listener with no server, so a window made before the server is heard (index.ts boot order)', () => {
  const on = vi.mocked(electron.ipcMain.on)
  on.mockClear()
  registerAppshotIpc()
  expect(on.mock.calls.filter(([channel]) => channel === 'appshot-ready')).toHaveLength(1)
  const listener = on.mock.calls.find(([channel]) => channel === 'appshot-ready')![1] as (e: unknown) => void
  const sent: unknown[] = []
  listener({ sender: { id: 77, once: () => undefined, send: (_c: string, p: unknown) => sent.push(p) } })
  // its window is ready: nothing was queued, nothing sent, and no server was needed to hear it
  expect(sent).toEqual([])
})
