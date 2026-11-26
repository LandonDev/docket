import { describe, expect, it } from 'vitest'
import { formatSpan, SEND_SPAN_DEADLINE_MS, SendSpans } from './sendSpans'

function rig() {
  let clock = 1_000
  const lines: string[] = []
  const timers: { fn: () => void; due: number; cleared: boolean }[] = []
  const spans = new SendSpans({
    write: (line) => lines.push(line),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, due: clock + ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    }
  })
  const advance = (ms: number): void => {
    clock += ms
    for (const t of timers) {
      if (!t.cleared && t.due <= clock) {
        t.cleared = true
        t.fn()
      }
    }
  }
  return { spans, lines, advance, timers, now: () => clock }
}

const content = (sessionId: string, seq: number) => ({
  sessionId, seq, ts: 0, event: { type: 'assistant-text' as const, text: 'hello', delta: true }
})

describe('SendSpans', () => {
  it('a complete span is one line with every phase in order, ms from accepted', () => {
    const { spans, lines, advance } = rig()
    spans.begin('s1')
    spans.handoff('s1', false)
    advance(12)
    spans.mark('s1', 'prepared')
    advance(328)
    spans.mark('s1', 'handle', 'warm')
    advance(15)
    spans.mark('s1', 'delivered')
    advance(545)
    spans.mark('s1', 'init')
    advance(300)
    spans.mark('s1', 'first-message')
    advance(900)
    spans.mark('s1', 'first-content')
    spans.contentRow(content('s1', 2))
    spans.rowOut(content('s1', 1))
    expect(lines).toHaveLength(0)
    spans.rowOut(content('s1', 2))
    spans.rowOut(content('s1', 2))
    expect(lines).toEqual([expect.stringMatching(/^send session=s1 accepted=0 prepared=\d+ handle=\d+\(warm\) delivered=\d+ init=\d+ first-message=\d+ model=- first-content=\d+ queue=0 handle-wait=- mcp=- gateway-dispatch=- first-byte=- first-row=\d+$/)])
    expect(spans.open()).toEqual([])
    // Marks after the flush say nothing.
    spans.mark('s1', 'first-content')
    expect(lines).toHaveLength(1)
  })

  it("a muse send: a cold handle, init at the handshake, no model phase (the host sees no provider frame)", () => {
    const { spans, lines, advance } = rig()
    spans.begin('m1')
    advance(10)
    spans.mark('m1', 'prepared')
    advance(600)
    spans.mark('m1', 'handle', 'cold')
    advance(250)
    spans.mark('m1', 'init')
    advance(40)
    spans.mark('m1', 'delivered')
    advance(700)
    spans.mark('m1', 'first-message')
    advance(1_200)
    spans.mark('m1', 'first-content')
    spans.flush('m1')
    expect(lines).toEqual([expect.stringMatching(/handle=\d+\(cold\).* model=- first-content=\d+ .*gateway-dispatch=- first-byte=- first-row=-$/)])
  })

  it('a stalled span flushes at the deadline naming the phases missing', () => {
    const { spans, lines, advance } = rig()
    spans.begin('s1')
    advance(40)
    spans.mark('s1', 'handle', 'cold')
    spans.mark('s1', 'prepared')
    advance(SEND_SPAN_DEADLINE_MS - 41)
    expect(lines).toEqual([])
    advance(1)
    expect(lines).toEqual([expect.stringMatching(/handle=\d+\(cold\) delivered=- init=- first-message=- model=- first-content=- queue=/)])
  })

  it('two sends on one session never share a span: the second begin flushes the first', () => {
    const { spans, lines, advance, timers } = rig()
    spans.begin('s1')
    advance(100)
    spans.mark('s1', 'delivered')
    spans.begin('s1')
    expect(lines).toEqual([expect.stringMatching(/handle=- delivered=\d+ init=- first-message=- model=- first-content=- queue=/)])
    expect(timers[0].cleared).toBe(true)
    advance(50)
    spans.mark('s1', 'first-content')
    spans.flush('s1')
    expect(lines[1]).toMatch(/handle=- delivered=- init=- first-message=- model=- first-content=\d+ queue=/)
  })

  it('a dropped span writes nothing and clears its timer; a mark with no span is ignored', () => {
    const { spans, lines, advance, timers } = rig()
    spans.begin('s1')
    spans.drop('s1')
    expect(timers[0].cleared).toBe(true)
    advance(SEND_SPAN_DEADLINE_MS + 1)
    spans.mark('s2', 'init')
    expect(lines).toEqual([])
  })

  it('the first mark of a phase keeps its time; a later note is taken', () => {
    const { spans, lines, advance } = rig()
    spans.begin('s1')
    advance(10)
    spans.mark('s1', 'handle')
    advance(10)
    spans.mark('s1', 'handle', 'live')
    spans.mark('s1', 'first-content')
    spans.flush('s1')
    expect(lines[0]).toContain('handle=10(live)')
  })

  it('the model phase sits between first-message and first-content with its cache note', () => {
    const { spans, lines, advance } = rig()
    spans.begin('s1')
    advance(20)
    spans.mark('s1', 'handle', 'live')
    advance(10)
    spans.mark('s1', 'delivered')
    advance(400)
    spans.mark('s1', 'first-message')
    advance(1_700)
    spans.mark('s1', 'model', 'miss 88k')
    advance(500)
    spans.mark('s1', 'first-content')
    spans.flush('s1')
    expect(lines).toEqual([expect.stringMatching(/first-message=\d+ model=\d+\(miss 88k\) first-content=\d+ queue=/)])
  })

  it('formatSpan rounds and tags', () => {
    expect(formatSpan('x', { accepted: 0, prepared: 1.6 }, { prepared: 'n' })).toBe('send session=x accepted=0 prepared=2(n) handle=- delivered=- init=- first-message=- model=- first-content=- queue=- handle-wait=- mcp=- gateway-dispatch=- first-byte=- first-row=-')
  })

  it('keeps a parked send and ignores stale or unrelated gateway marks', () => {
    const { spans, lines, advance, now } = rig()
    const parkedAt = now()
    advance(SEND_SPAN_DEADLINE_MS * 2)
    spans.begin('s1', parkedAt)
    spans.handleWait('s1', 6)
    spans.mcp('s1', { ms: 1700, source: 'codex-gate', servers: new Map([['app', 120], ['linear local', 1650]]) })
    spans.handoff('s1', true)
    spans.gateway({ thread: 's1', id: 1, phase: 'gateway-dispatch', at: parkedAt })
    spans.gateway({ thread: 's1', id: 2, phase: 'gateway-dispatch', at: now() })
    spans.mark('s1', 'delivered', 'mcp=1800')
    spans.mark('s1', 'first-content')
    spans.contentRow(content('s1', 4))
    spans.rowOut(content('s1', 4))
    spans.gateway({ thread: 's1', id: 1, phase: 'first-byte', at: now() })
    expect(lines).toHaveLength(0)
    spans.gateway({ thread: 's1', id: 2, phase: 'first-byte', at: now() })
    expect(lines).toEqual([expect.stringMatching(/delivered=\d+\(mcp=1800\).* queue=\d+ handle-wait=6 mcp=1700 gateway-dispatch=\d+ first-byte=\d+ first-row=\d+ mcp.source=codex-gate mcp.servers=app:120,linear%20local:1650$/)])
  })
})
