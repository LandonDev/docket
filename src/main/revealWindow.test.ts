import { EventEmitter } from 'node:events'
import type { BrowserWindow, IpcMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { REVEAL_LOCKED, REVEAL_NO_WINDOW } from '@shared/contract-work-reveal'
import { registerRevealWindow, revealScreenRefusal } from './revealWindow'
import type { MacPresence } from '@shared/macPresence'

function rig() {
  const ipc = new EventEmitter()
  const log: string[] = []
  const win = {
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: vi.fn<(channel: string, ...args: unknown[]) => void>((channel) => { log.push(channel) }),
    }),
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => log.push('restore'),
    show: () => log.push('show'),
    focus: () => log.push('focus'),
  }
  const state: Pick<MacPresence, 'screen' | 'power' | 'saver'> = { screen: 'unlocked', power: 'awake' }
  const ready = vi.fn()
  const target = win as unknown as BrowserWindow
  const service = registerRevealWindow(ipc as unknown as IpcMain, {
    target: (accept) => accept(target) ? target : null,
    presence: () => state,
    dismissSaver: async () => { log.push('dismiss saver'); state.saver = false },
    onReady: ready,
  })
  const contents = win.webContents
  return {
    service, state, log, ready, contents,
    readyWindow: () => ipc.emit('app:reveal-ready', { sender: contents }),
    prepared: (sender: unknown = contents) => ipc.emit('app:reveal-prepared', { sender }, contents.send.mock.calls[0]?.[1]),
  }
}

const nav = { target: { thread: 's1' } }

describe('the local window for a reveal', () => {
  it('waits for the chosen renderer to prepare before sending navigation or raising its window', async () => {
    const r = rig()
    expect(r.service.check()).toBe(REVEAL_NO_WINDOW)
    r.readyWindow()
    expect(r.ready).toHaveBeenCalledOnce()
    expect(r.service.check()).toBeNull()
    const opening = r.service.open(nav)
    r.prepared(new EventEmitter())
    await Promise.resolve()
    expect(r.log).toEqual(['app:reveal-prepare'])
    r.prepared()
    await opening
    expect(r.log).toEqual(['app:reveal-prepare', 'app:reveal-open', 'restore', 'show', 'focus'])
    expect(r.contents.send).toHaveBeenLastCalledWith('app:reveal-open', r.contents.send.mock.calls[0]?.[1], nav)
  })

  it('refuses a window that reloads before navigation', async () => {
    const r = rig()
    r.readyWindow()
    const opening = r.service.open(nav)
    r.contents.emit('did-start-loading')
    r.readyWindow()
    r.prepared()
    await expect(opening).rejects.toThrow(REVEAL_NO_WINDOW)
    expect(r.log).toEqual(['app:reveal-prepare', 'app:reveal-cancel'])
  })

  it('checks the lock again before navigation', async () => {
    const r = rig()
    r.readyWindow()
    const opening = r.service.open(nav)
    r.state.screen = 'locked'
    r.prepared()
    await expect(opening).rejects.toThrow(REVEAL_LOCKED)
    expect(r.contents.send.mock.calls).toEqual([['app:reveal-prepare', expect.any(String)], ['app:reveal-cancel', r.contents.send.mock.calls[0]?.[1]]])
  })

  it('cancels a prepare whose acknowledgement never reaches main', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      r.readyWindow()
      const rejected = expect(r.service.open(nav)).rejects.toThrow(REVEAL_NO_WINDOW)
      await vi.advanceTimersByTimeAsync(5_000)
      await rejected
      expect(r.contents.send).toHaveBeenLastCalledWith('app:reveal-cancel', r.contents.send.mock.calls[0]?.[1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a prepared reveal when the caller disconnects', async () => {
    const r = rig()
    r.readyWindow()
    const caller = new AbortController()
    const opening = r.service.open(nav, caller.signal)
    r.prepared()
    caller.abort()
    await expect(opening).rejects.toThrow('The connection closed')
    expect(r.log).toEqual(['app:reveal-prepare', 'app:reveal-cancel'])
  })

  it('cancels its token when sending navigation to the prepared window fails', async () => {
    const r = rig()
    r.readyWindow()
    const opening = r.service.open(nav)
    r.contents.send.mockImplementation((channel) => {
      if (channel === 'app:reveal-open') throw new Error('Renderer went away')
    })
    r.prepared()
    await expect(opening).rejects.toThrow('Renderer went away')
    expect(r.contents.send).toHaveBeenLastCalledWith('app:reveal-cancel', r.contents.send.mock.calls[0]?.[1])
  })

  it('dismisses a passwordless screen saver before opening the destination', async () => {
    const r = rig()
    r.readyWindow()
    r.state.saver = true
    const opening = r.service.open(nav)
    r.prepared()
    await opening
    expect(r.log).toEqual(['app:reveal-prepare', 'dismiss saver', 'app:reveal-open', 'restore', 'show', 'focus'])
  })

  it('requires a known unlocked screen on an awake host', () => {
    expect(revealScreenRefusal({ screen: 'locked', power: 'awake' })).toBe(REVEAL_LOCKED)
    expect(revealScreenRefusal({ screen: 'unknown', power: 'awake' })).toBe('This computer’s screen is unavailable.')
    expect(revealScreenRefusal({ screen: 'unlocked', power: 'asleep' })).toBe('Wake this computer to open that destination.')
    expect(revealScreenRefusal({ screen: 'unlocked', power: 'awake' })).toBeNull()
  })
})
