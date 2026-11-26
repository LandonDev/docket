import { describe, expect, it, vi } from 'vitest'
import { TICKET_HEDGE_MS, readServerTiming, socketTicket, ticketLine, ticketServerTiming, windowTicket, type HttpsTiming, type Ticket } from './windowTicket'
import type { Principal } from '@shared/capabilities'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A peer ask and an HTTPS ask the test answers by hand, on fake time. */
function rig(peerUp = true) {
  vi.useFakeTimers()
  const lines: string[] = []
  const peerAsks: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = []
  const httpsAsks: { resolve: (t: Ticket) => void; reject: (e: Error) => void; timing: HttpsTiming }[] = []
  let t = 0
  const ask = (env = 'env_box', waited?: number) =>
    windowTicket(env, waited, {
      peer: () => (peerUp ? () => new Promise((resolve, reject) => peerAsks.push({ resolve, reject })) : null),
      https: (timing) => new Promise<Ticket>((resolve, reject) => httpsAsks.push({ resolve, reject, timing })),
      log: (line) => lines.push(line),
      now: () => (t += 10)
    })
  return { lines, peerAsks, httpsAsks, ask }
}

describe('windowTicket', () => {
  it('a live peer link mints the ticket in one ask: no HTTPS at all', async () => {
    const r = rig()
    const got = r.ask('env_box', 3)
    await flush()
    r.peerAsks[0]!.resolve({ ticket: 'tk_peer', expiresIn: 30 })
    expect(await got).toEqual({ ticket: 'tk_peer', expiresIn: 30 })
    await vi.advanceTimersByTimeAsync(10 * TICKET_HEDGE_MS)
    expect(r.peerAsks).toHaveLength(1)
    expect(r.httpsAsks).toHaveLength(0)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatch(/^ticket env=env_box via=peer ms=\d+ wait=3 peer=\d+ https=- connect=- .* outcome=ok$/)
    vi.useRealTimers()
  })

  it('a peer that does not answer in the hedge has HTTPS start beside it, and the first ticket back wins', async () => {
    const r = rig()
    const got = r.ask()
    await vi.advanceTimersByTimeAsync(TICKET_HEDGE_MS - 1)
    expect(r.httpsAsks).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.httpsAsks).toHaveLength(1)
    Object.assign(r.httpsAsks[0]!.timing, { connectMs: 900, answerMs: 120, boxMs: 1, boxLoopMs: 40 })
    r.httpsAsks[0]!.resolve({ ticket: 'tk_https', expiresIn: 30 })
    expect((await got).ticket).toBe('tk_https')
    // The peer's late answer is ignored: one line, one ticket.
    r.peerAsks[0]!.resolve({ ticket: 'tk_late', expiresIn: 30 })
    await flush()
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toContain('via=https')
    expect(r.lines[0]).toContain('connect=900 answer=120 box=1 boxloop=40 outcome=ok')
    vi.useRealTimers()
  })

  it('a peer that fails starts HTTPS at once, without waiting out the hedge', async () => {
    const r = rig()
    const got = r.ask()
    await flush()
    r.peerAsks[0]!.reject(new Error('remote.ticket on box timed out'))
    await flush()
    expect(r.httpsAsks).toHaveLength(1)
    r.httpsAsks[0]!.resolve({ ticket: 'tk_https', expiresIn: 30 })
    expect((await got).ticket).toBe('tk_https')
    expect(r.lines[0]).toContain('peer=fail')
    vi.useRealTimers()
  })

  it("with no peer link it is one HTTPS ask, and a failure is HTTPS's own reason, logged once", async () => {
    const r = rig(false)
    const got = r.ask()
    await flush()
    expect(r.peerAsks).toHaveLength(0)
    expect(r.httpsAsks).toHaveLength(1)
    r.httpsAsks[0]!.reject(new Error('unavailable: https://box/api/ticket did not answer in time'))
    await expect(got).rejects.toThrow(/^unavailable:/)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatch(/via=none .*https=fail .*outcome=unavailable$/)
    vi.useRealTimers()
  })

  it("when both fail the renderer reads HTTPS's reason (a refused key stays unauthorized)", async () => {
    const r = rig()
    const got = r.ask()
    await vi.advanceTimersByTimeAsync(TICKET_HEDGE_MS)
    r.httpsAsks[0]!.reject(new Error('unauthorized: https://box rejected the key for box'))
    await flush()
    r.peerAsks[0]!.reject(new Error('box is not connected'))
    await expect(got).rejects.toThrow(/^unauthorized:/)
    expect(r.lines).toHaveLength(1)
    vi.useRealTimers()
  })
})

describe('socketTicket (the box side)', () => {
  const key = (extra: Partial<Principal & { kind: 'remote' }> = {}): Principal => ({ kind: 'remote', keyId: 'k1', name: 'mac', audience: 'client', caps: ['admin'], ...extra })
  const auth = (farewell = false) => {
    const minted: string[] = []
    return { minted, mintTicket: (p: Principal & { kind: 'remote' }) => (minted.push(p.keyId), { ticket: 't', expiresIn: 30 }), inFarewell: () => farewell }
  }
  it("mints for a client key's own socket, once", () => {
    const a = auth()
    expect(socketTicket(a, key())).toEqual({ ticket: 't', expiresIn: 30 })
    expect(a.minted).toEqual(['k1'])
  })
  it('refuses this machine, a cookie session, a relayed lane, a bot key, a pending key and a key in farewell', () => {
    const cases: [ReturnType<typeof auth>, Principal][] = [
      [auth(), { kind: 'local' }],
      [auth(), key({ sessionId: 's1' })],
      [auth(), key({ via: 'env_box' })],
      [auth(), key({ audience: 'mcp' })],
      [auth(), key({ caps: ['pending'] })],
      [auth(true), key()]
    ]
    for (const [a, p] of cases) {
      expect(() => socketTicket(a, p)).toThrow(/^forbidden:/)
      expect(a.minted).toEqual([])
    }
  })
})

describe('the box time in Server-Timing', () => {
  it('round-trips, and an older box without it reads as nothing', () => {
    expect(readServerTiming(ticketServerTiming(1.4, 2638.2))).toEqual({ boxMs: 1, boxLoopMs: 2638 })
    expect(readServerTiming(null)).toEqual({})
    expect(ticketLine('e', { via: 'peer', ms: 80, peerMs: 80, outcome: 'ok' })).toBe(
      'ticket env=e via=peer ms=80 wait=- peer=80 https=- connect=- answer=- box=- boxloop=- outcome=ok'
    )
  })
})
