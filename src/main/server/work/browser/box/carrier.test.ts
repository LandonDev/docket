import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerToolOutcome } from '../../../computer/result'
import { carrierComputer, setBoxBrowser, type BoxBrowserHost } from './index'
import { isCarrierSession } from './service'

/** The msforms carrier's hands (`carrierComputer`): a marked session of its own, run through the box's computer sessions with no card. */

const done: ComputerToolOutcome = { steps: [], shots: [], body: 'ok', isError: false }

function fakeHost() {
  const sessions = {
    run: vi.fn(async () => done),
    previewTarget: vi.fn((thread: string) => ({ serviceSession: thread, app: { pid: 1, name: 'Chromium' }, window: { id: 4, title: 'Untitled form' } })),
    end: vi.fn(async () => {})
  }
  setBoxBrowser({ sessions, browser: { touch: () => {} } } as unknown as BoxBrowserHost)
  return sessions
}

afterEach(() => setBoxBrowser(null))

describe('carrierComputer', () => {
  it('is null where the box has no browser', () => {
    setBoxBrowser(null)
    expect(carrierComputer()).toBeNull()
  })

  it('runs the tools on a session marked as the carrier, with no card, and drops the mark at its end', async () => {
    const sessions = fakeHost()
    const c = carrierComputer()!
    expect(isCarrierSession(c.session)).toBe(true)
    expect(await c.run('computer_observe', { app: 'Chromium' })).toBe(done)
    const [ctx, tool, args] = sessions.run.mock.calls[0] as unknown as [{ threadId: string; permission: () => string; approve: () => Promise<boolean> }, string, unknown]
    expect(ctx.threadId).toBe(c.session)
    expect(ctx.permission()).toBe('auto')
    expect(await ctx.approve()).toBe(false)
    expect([tool, args]).toEqual(['computer_observe', { app: 'Chromium' }])
    expect(c.window()).toEqual({ id: 4, title: 'Untitled form' })
    await c.end()
    expect(sessions.end).toHaveBeenCalledWith([c.session])
    expect(isCarrierSession(c.session)).toBe(false)
  })

  it('gives each carrier its own session', async () => {
    fakeHost()
    const a = carrierComputer()!
    const b = carrierComputer()!
    expect(a.session).not.toBe(b.session)
    await a.end()
    expect([isCarrierSession(a.session), isCarrierSession(b.session)]).toEqual([false, true])
    await b.end()
  })
})
