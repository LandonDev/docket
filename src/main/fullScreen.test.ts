import { describe, expect, it } from 'vitest'
import { followFullScreen, isFull, isFullScreenKey, setFull, type FullScreenEvents, type FullScreenWindow, type KeyInput } from './fullScreen'

function fakeWindow(log: string[]) {
  const listeners = new Map<string, () => void>()
  const w = {
    full: false,
    simple: false,
    destroyed: false,
    isDestroyed: () => w.destroyed,
    isFullScreen: () => w.full,
    isSimpleFullScreen: () => w.simple,
    setFullScreen: (on: boolean) => {
      log.push(`full ${on}`)
      w.full = on
    },
    setSimpleFullScreen: (on: boolean) => {
      log.push(`simple ${on}`)
      w.simple = on
    },
    setFullScreenable: (on: boolean) => void log.push(`fullscreenable ${on}`),
    on: (event: string, listener: () => void) => void listeners.set(event, listener),
    fire: (event: string) => listeners.get(event)?.()
  }
  return w satisfies FullScreenWindow & FullScreenEvents
}

const key = (over: Partial<KeyInput>): KeyInput => ({ type: 'keyDown', key: 'f', control: false, meta: false, alt: false, shift: false, ...over })

describe('full screen for a picture', () => {
  it('takes a Mac window full screen on its own Space, at once, and back', () => {
    const log: string[] = []
    const w = fakeWindow(log)
    expect(setFull(w, true, 'darwin')).toBe(false)
    expect(isFull(w, 'darwin')).toBe(true)
    // asked again, nothing changes
    expect(setFull(w, true, 'darwin')).toBe(true)
    expect(setFull(w, false, 'darwin')).toBe(true)
    expect(log).toEqual(['simple true', 'simple false'])
  })

  it("leaves a Mac's own full screen (the green button) the way it came in", () => {
    const log: string[] = []
    const w = fakeWindow(log)
    w.full = true
    expect(setFull(w, true, 'darwin')).toBe(true)
    expect(log).toEqual([])
    setFull(w, false, 'darwin')
    expect(log).toEqual(['full false'])
  })

  it('takes a window full screen elsewhere, even one made unable to', () => {
    const log: string[] = []
    const w = fakeWindow(log)
    expect(setFull(w, true, 'win32')).toBe(false)
    expect(setFull(w, false, 'win32')).toBe(true)
    expect(log).toEqual(['fullscreenable true', 'full true', 'full false'])
  })

  it('does nothing to a window that is gone', () => {
    const log: string[] = []
    const w = fakeWindow(log)
    w.destroyed = true
    expect(setFull(w, true, 'darwin')).toBe(false)
    expect(log).toEqual([])
  })

  it('tells each change, and leaves full screen as the window closes', () => {
    const log: string[] = []
    const told: boolean[] = []
    const w = fakeWindow(log)
    followFullScreen(w, (on) => told.push(on), 'darwin')
    w.fire('enter-full-screen')
    w.fire('leave-full-screen')
    expect(told).toEqual([true, false])
    // closed while not full: nothing to leave
    w.fire('close')
    expect(log).toEqual([])
    setFull(w, true, 'darwin')
    w.fire('close')
    expect(log).toEqual(['simple true', 'simple false'])
    expect(told).toEqual([true, false, false])
  })

  it('hears ⌃⌘F on a Mac and F11 elsewhere, nothing else', () => {
    expect(isFullScreenKey(key({ control: true, meta: true }), 'darwin')).toBe(true)
    expect(isFullScreenKey(key({ key: 'F', control: true, meta: true }), 'darwin')).toBe(true)
    expect(isFullScreenKey(key({ meta: true }), 'darwin')).toBe(false)
    expect(isFullScreenKey(key({ control: true, meta: true, shift: true }), 'darwin')).toBe(false)
    expect(isFullScreenKey(key({ control: true, meta: true, type: 'keyUp' }), 'darwin')).toBe(false)
    expect(isFullScreenKey(key({ control: true, meta: true, isAutoRepeat: true }), 'darwin')).toBe(false)
    expect(isFullScreenKey(key({ key: 'F11' }), 'win32')).toBe(true)
    expect(isFullScreenKey(key({ key: 'F11' }), 'darwin')).toBe(false)
    expect(isFullScreenKey(key({ key: 'F11', control: true }), 'linux')).toBe(false)
    expect(isFullScreenKey(key({ control: true, meta: true }), 'linux')).toBe(false)
  })
})
