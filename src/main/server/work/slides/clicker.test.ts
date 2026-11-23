import { afterEach, describe, expect, it, vi } from 'vitest'
import { METHOD_CAPABILITY } from '@shared/capabilities'
import type { ShowLive, SlidesShowPush } from '@shared/contract-work-slides'
import { effectsChanged, SHOW_PLAYED_TRANSITIONS, SLIDES_RELAY } from '@shared/contract-work-slides'
import { PLAYED_TRANSITIONS } from './builds'
import type { CanvasItem } from '@shared/work'
import type { Caller } from '../modules'
import { clickerHandle, GONE_MS, NOT_A_THREAD, NOT_HIS, pressShow, RUN_HOLD_MS, runShow, setClickerClock, showStates, stopClicker, TAKE_MS, type RunParams } from './clicker'

/**
 * The clicker's wire (docs/agents/work-slides.md "The clicker"): the window that runs a show tells its host the
 * show's state and waits for presses; another device of his reads it and presses; a press on a state that moved
 * on, or for a show that ended, is dropped; a thread and a key that may only read are refused; a call relayed from
 * another host of his drives as any; the show is forgotten when its window goes.
 */

const deck = (id: string, path: string): CanvasItem => ({ id, sessionId: 's1', workspaceId: 'w1', kind: 'slides', title: 'Talk.pptx', source: { at: 'file', host: 'h1', path }, state: 'open', position: 0, rev: 1, createdAt: 0, updatedAt: 0 })
const ITEMS = new Map([
  ['i1', deck('i1', '/roots/Talk.pptx')],
  ['i2', deck('i2', '/private/Other.pptx')]
])

const pushes: Array<{ push: SlidesShowPush; to: unknown }> = []
const ctx = {
  host: 'h1',
  dataDir: '/tmp',
  canvas: { get: (id: string) => ITEMS.get(id) ?? null },
  // A remote key reaches only the files under /roots; this host's window and a peer of his anything.
  reaches: (by: Caller, path: string) => by.kind !== 'remote' || !!by.peer || path.startsWith('/roots/'),
  push: (push: SlidesShowPush, to?: unknown) => void pushes.push({ push, to })
} as never

const WINDOW: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
const PHONE: Caller = { kind: 'remote', caps: ['read', 'operate'] }
const VIEWER: Caller = { kind: 'remote', caps: ['read'] }
const THREAD: Caller = { kind: 'model', caps: [], sessionId: 's1' }
const PEER: Caller = { kind: 'remote', caps: ['read', 'operate'], peer: 'env_mac' }

const live = (rev: number, over: Partial<RunParams['live'] & object> = {}): NonNullable<RunParams['live']> => ({
  title: 'Talk',
  rev,
  slide: 4,
  count: 12,
  step: 0,
  steps: 0,
  next: { kind: 'slide', number: 5, title: 'Packages' },
  notes: 'Say the price last.',
  timer: { elapsed: 60_000, paused: false, target: 20 },
  blank: false,
  ended: false,
  ...over
})

const run = (p: Partial<RunParams> & { live: RunParams['live'] }, signal?: AbortSignal) => runShow(ctx, WINDOW, { itemId: 'i1', showId: 'show-0001', ...p }, signal)

afterEach(() => {
  stopClicker(ctx)
  pushes.length = 0
  vi.useRealTimers()
  setClickerClock(Date.now)
})

describe('the clicker', () => {
  it('hands a second device\'s press to the window that runs the show, and answers what the window did', async () => {
    const waiting = run({ live: live(1) })
    expect(showStates(ctx, PHONE).shows).toMatchObject([{ showId: 'show-0001', itemId: 'i1', slide: 4, count: 12, notes: 'Say the price last.', next: { kind: 'slide', title: 'Packages' } }])
    const pressed = pressShow(ctx, PHONE, { showId: 'show-0001', act: 'next', rev: 1 })
    const { press } = await waiting
    expect(press).toMatchObject({ act: 'next', rev: 1 })
    // The window ran it through its reducer: slide 5 now, and it says so with its next call.
    const next = run({ live: live(2, { slide: 5 }), answered: { seq: press!.seq, applied: true } })
    await expect(pressed).resolves.toMatchObject({ applied: true, live: { slide: 5, rev: 2 } })
    // Each change reached his devices that could name the file, and only those.
    expect(pushes.map((p) => (p.push.live ? p.push.live.slide : null))).toEqual([4, 5])
    expect(pushes[0]!.to).toEqual({ path: '/roots/Talk.pptx' })
    await run({ live: null })
    await expect(next).resolves.toEqual({ press: null })
  })

  it('jumps to a slide by its number, and refuses a jump with none', async () => {
    const waiting = run({ live: live(1) })
    void pressShow(ctx, PHONE, { showId: 'show-0001', act: 'goto', at: 9, rev: 1 })
    expect((await waiting).press).toMatchObject({ act: 'goto', at: 9 })
    await expect(pressShow(ctx, PHONE, { showId: 'show-0001', act: 'goto', rev: 1 })).rejects.toThrow('A jump names a slide by its number.')
  })

  it('drops a press made on a state that moved on, never applying it to a slide he did not see', async () => {
    void run({ live: live(3) })
    await expect(pressShow(ctx, PHONE, { showId: 'show-0001', act: 'next', rev: 2 })).resolves.toMatchObject({ dropped: 'moved', live: { rev: 3 } })
    // Taken, but the window moved on (a key on the desktop) before it ran it: it says so, and so does the answer.
    const waiting = run({ live: live(4) })
    const pressed = pressShow(ctx, PHONE, { showId: 'show-0001', act: 'next', rev: 4 })
    const { press } = await waiting
    void run({ live: live(5), answered: { seq: press!.seq, applied: false } })
    await expect(pressed).resolves.toMatchObject({ dropped: 'moved', live: { rev: 5 } })
  })

  it('drops a press waiting for the window when the window tells a newer state first', async () => {
    vi.useFakeTimers()
    const first = run({ live: live(1) })
    await vi.advanceTimersByTimeAsync(RUN_HOLD_MS)
    await expect(first).resolves.toEqual({ press: null })
    // No call waits now; a press comes, and the window then reports a key's change before it asks again.
    const pressed = pressShow(ctx, PHONE, { showId: 'show-0001', act: 'next', rev: 1 })
    void run({ live: live(2) })
    await expect(pressed).resolves.toMatchObject({ dropped: 'moved', live: { rev: 2 } })
  })

  it('answers a press for a show that ended, or that is not there, as dropped', async () => {
    await expect(pressShow(ctx, PHONE, { showId: 'show-none1', act: 'next', rev: 1 })).resolves.toEqual({ dropped: 'ended', live: null })
    void run({ live: live(1) })
    await run({ live: null })
    expect(showStates(ctx, PHONE).shows).toEqual([])
    expect(pushes.at(-1)!.push).toEqual({ push: 'work.slides.show', itemId: 'i1', showId: 'show-0001', live: null })
    await expect(pressShow(ctx, PHONE, { showId: 'show-0001', act: 'next', rev: 1 })).resolves.toEqual({ dropped: 'ended', live: null })
  })

  it('forgets the show when its window\'s socket goes, and when its window stops calling', async () => {
    const socket = new AbortController()
    const waiting = run({ live: live(1) }, socket.signal)
    const pressed = pressShow(ctx, PHONE, { showId: 'show-0002', act: 'next', rev: 1 })
    socket.abort()
    await expect(waiting).resolves.toEqual({ press: null })
    expect(showStates(ctx, WINDOW).shows).toEqual([])
    expect(pushes.at(-1)!.push.live).toBeNull()
    await expect(pressed).resolves.toEqual({ dropped: 'ended', live: null })

    vi.useFakeTimers()
    void run({ live: live(1) })
    await vi.advanceTimersByTimeAsync(RUN_HOLD_MS)
    expect(showStates(ctx, WINDOW).shows).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(GONE_MS)
    expect(showStates(ctx, WINDOW).shows).toEqual([])
  })

  it('drops a press no window takes in time, so it is never handed over late', async () => {
    vi.useFakeTimers()
    const first = run({ live: live(1) })
    await vi.advanceTimersByTimeAsync(RUN_HOLD_MS)
    await first
    const pressed = pressShow(ctx, PHONE, { showId: 'show-0001', act: 'next', rev: 1 })
    await vi.advanceTimersByTimeAsync(TAKE_MS)
    await expect(pressed).resolves.toMatchObject({ dropped: 'ended' })
    // The window's next call is handed nothing.
    const again = run({ live: live(1) })
    await vi.advanceTimersByTimeAsync(RUN_HOLD_MS)
    await expect(again).resolves.toEqual({ press: null })
  })

  it('refuses a thread, and a key that may only read, each with a sentence', async () => {
    void run({ live: live(1) })
    expect(() => showStates(ctx, THREAD)).toThrow(NOT_A_THREAD)
    await expect(pressShow(ctx, THREAD, { showId: 'show-0001', act: 'next', rev: 1 })).rejects.toThrow(NOT_A_THREAD)
    await expect(runShow(ctx, THREAD, { itemId: 'i1', showId: 'show-0009', live: live(1) })).rejects.toThrow(NOT_A_THREAD)
    await expect(pressShow(ctx, VIEWER, { showId: 'show-0001', act: 'next', rev: 1 })).rejects.toThrow(NOT_HIS)
    // A key that may read sees the show; the wire's own gate asks operate of a press and read of the state.
    expect(showStates(ctx, VIEWER).shows).toHaveLength(1)
    expect(METHOD_CAPABILITY['work.slides.show.press']).toBe('operate')
    expect(METHOD_CAPABILITY['work.slides.show.run']).toBe('operate')
    expect(METHOD_CAPABILITY['work.slides.show.state']).toBe('read')
    // Through the module's own door too.
    const { slides } = await import('.')
    await expect(slides.handle!({ id: '1', method: 'work.slides.show.state', params: {} } as never, ctx, THREAD)).rejects.toThrow(NOT_A_THREAD)
  })

  it('shows a key only the shows of decks it could name, and drops its press on any other', async () => {
    void runShow(ctx, WINDOW, { itemId: 'i2', showId: 'show-0003', live: live(1) })
    expect(showStates(ctx, PHONE).shows).toEqual([])
    expect(showStates(ctx, WINDOW, 'i2').shows).toHaveLength(1)
    await expect(pressShow(ctx, PHONE, { showId: 'show-0003', act: 'next', rev: 1 })).resolves.toEqual({ dropped: 'ended', live: null })
    expect(pushes[0]!.to).toEqual({ path: '/private/Other.pptx' })
  })

  it('takes a press relayed from another host of his as from any of his devices', async () => {
    expect((SLIDES_RELAY as Record<string, string>)['work.slides.show.press']).toBeUndefined()
    const waiting = run({ live: live(1) })
    const pressed = pressShow(ctx, PEER, { showId: 'show-0001', act: 'blank', rev: 1 })
    const { press } = await waiting
    void run({ live: live(2, { blank: true }), answered: { seq: press!.seq, applied: true } })
    await expect(pressed).resolves.toMatchObject({ applied: true, live: { blank: true } })
    await expect(clickerHandle({ method: 'work.slides.show.state', params: { itemId: 'i1' } }, ctx, PEER)).resolves.toMatchObject({ handled: true, result: { shows: [{ blank: true }] } })
  })

  it('counts the time on from when the window told it, and holds it while paused', async () => {
    let now = 1_000
    setClickerClock(() => now)
    void run({ live: live(1) })
    now += 5_000
    expect(showStates(ctx, PHONE).shows[0]!.timer).toEqual({ elapsed: 65_000, paused: false, target: 20 })
    void run({ live: live(2, { timer: { elapsed: 65_000, paused: true, target: 20 } }) })
    now += 9_000
    expect((showStates(ctx, PHONE).shows[0] as ShowLive).timer.elapsed).toBe(65_000)
  })

  it('refuses a show id that names another deck', async () => {
    void run({ live: live(1) })
    await expect(runShow(ctx, WINDOW, { itemId: 'i2', showId: 'show-0001', live: live(1) })).rejects.toThrow('That show is of another deck.')
  })
})

describe('the canvas\'s count of effects that play only in PowerPoint', () => {
  it('is the show\'s own count: the same transitions played, the same sum', () => {
    expect([...SHOW_PLAYED_TRANSITIONS].sort()).toEqual([...PLAYED_TRANSITIONS].sort())
    expect(effectsChanged([{ builds: { changed: 2 } }, { transition: { kind: 'morph' } }, { transition: { kind: 'fade' } }, {}])).toBe(3)
  })
})
