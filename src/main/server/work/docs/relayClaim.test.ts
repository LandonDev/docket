import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRelay, IDLE_MS } from './relay'

/**
 * A pushed socket no window claimed (sol S5): a ready open whose tab went before its answer landed. It idles out as any
 * socket does, and its window socket's abort listener goes with it; one the window sent on lives as long as the window.
 */

const fakeSocket = () => {
  const closes: number[] = []
  const ws = { on() {}, close: (code: number) => void closes.push(code), terminate() {}, send() {}, readyState: 1, binaryType: '' }
  return { ws, closes }
}
/** A window socket's signal that counts its listeners. */
const windowSignal = () => {
  const listeners = new Set<() => void>()
  return {
    listeners,
    signal: { aborted: false, addEventListener: (_: string, l: () => void) => void listeners.add(l), removeEventListener: (_: string, l: () => void) => void listeners.delete(l) } as unknown as AbortSignal,
  }
}

afterEach(() => vi.useRealTimers())

describe('a pushed socket', () => {
  it('no window claimed idles out and lets go of its listener; one its window sent on stays', () => {
    vi.useFakeTimers()
    let now = 0
    const a = fakeSocket()
    const b = fakeSocket()
    const sockets = [a.ws, b.ws]
    const relay = createRelay({ now: () => now, socket: () => sockets.shift() as never })
    const win = windowSignal()
    relay.connect('ws://x', 'unclaimed', { send: () => undefined, signal: win.signal })
    const claimed = relay.connect('ws://x', 'claimed', { send: () => undefined, signal: win.signal })
    relay.send(claimed, [])
    expect(win.listeners.size).toBe(2)
    now = IDLE_MS + 1
    vi.advanceTimersByTime(5_000)
    expect(relay.docs()).toEqual(new Set(['claimed']))
    expect(a.closes).toEqual([1000])
    expect(b.closes).toEqual([])
    expect(win.listeners.size).toBe(1)
    relay.stop()
  })
})
