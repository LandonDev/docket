import { describe, expect, it, vi } from 'vitest'
import { PART_CHARS, UNACKED_CHARS, partText, readAck, readPart } from '@shared/answerParts'
import { AnswerParts, PARTS_ACK_STALL_MS } from './wire'
import { Transport, type SocketLike } from '../../renderer/src/lib/connection/transport'

/**
 * The host's parts (wire.ts AnswerParts) into the window's own Transport: what is written to the socket, in order,
 * and what the window makes of it. Counts of chars, never a clock.
 */

type Wrote = { text: string; part: ReturnType<typeof readPart> }

function host() {
  const wire: Wrote[] = []
  const parts = new AnswerParts((text) => wire.push({ text, part: readPart(text) }))
  parts.enable()
  /** Every frame but a parted answer goes straight to the socket, as index.ts sendFrame does. */
  const send = (frame: { id?: string } & Record<string, unknown>): void => {
    const text = JSON.stringify(frame)
    if (frame.id && parts.take(frame.id, text, true)) return
    wire.push({ text, part: null })
  }
  return { wire, parts, send }
}

const piece = (chars: number): string => 'A'.repeat(chars)
const rowPush = (seq: number) => ({ push: 'event', row: { sessionId: 's', seq, ts: 1000 + seq, event: { type: 'assistant-text', text: `row ${seq}`, delta: false } } })

describe('AnswerParts', () => {
  it('with a 4 MiB piece queued, the shown thread\'s push is written with no more than 512 KiB of it ahead', () => {
    const h = host()
    h.parts.mark('7', 'fs.read')
    h.send({ id: '7', ok: true, result: { content: piece(4 * 1024 * 1024) } })
    const aheadOfPush = h.wire.reduce((n, w) => n + (w.part?.body.length ?? 0), 0)
    expect(aheadOfPush).toBeLessThanOrEqual(UNACKED_CHARS)
    expect(h.parts.waiting).toBe(1)
    h.send(rowPush(9))
    expect(h.wire.at(-1)!.part).toBeNull()
    // The window acks what it holds; only then do more parts go, never more than the window unacked.
    for (let acked = 0; h.parts.waiting > 0; ) {
      acked += PART_CHARS
      h.parts.ack(acked)
      expect(h.parts.unacked).toBeLessThanOrEqual(UNACKED_CHARS)
    }
    const parts = h.wire.filter((w) => w.part)
    // Offsets run on with no gap, and only the final part says last.
    let at = 0
    for (const [i, w] of parts.entries()) {
      expect(w.part!.offset).toBe(at)
      at += w.part!.body.length
      expect(w.part!.last).toBe(i === parts.length - 1)
    }
  })

  it('never splits a surrogate pair: a non-BMP character at every place around a part\'s end comes back exactly, each part sent as UTF-8', async () => {
    const compass = '\u{1F9ED}'
    for (const shift of [-3, -2, -1, 0, 1, 2]) {
      for (const boundary of [PART_CHARS, 2 * PART_CHARS]) {
        // Placed by the answer's JSON text, where the parts are cut: the high surrogate lands at boundary + shift.
        const prefix = JSON.stringify({ id: '9', ok: true, result: { content: '' } }).length - 3
        const before = 'a'.repeat(boundary + shift - prefix)
        const content = `${before}${compass}${'b'.repeat(PART_CHARS)}${compass}`
        const h = host()
        h.parts.mark('9', 'fs.read')
        h.send({ id: '9', ok: true, result: { content } })
        for (let acked = 0; h.parts.waiting > 0; ) h.parts.ack((acked += PART_CHARS))
        // Each message crosses the socket as its own UTF-8 text: a lone surrogate half would come back U+FFFD.
        const bodies = h.wire.filter((w) => w.part).map((w) => readPart(Buffer.from(w.text, 'utf8').toString('utf8'))!.body)
        expect(JSON.parse(bodies.join('')).result.content).toBe(content)
      }
    }
  })

  it('a list, a small page and an unmarked answer go whole; nothing is parted until the window asked', () => {
    const off = new AnswerParts(() => undefined)
    off.mark('1', 'fs.read')
    expect(off.take('1', piece(PART_CHARS * 3), true)).toBe(false)
    const h = host()
    h.parts.mark('2', 'session.list')
    expect(h.parts.take('2', piece(PART_CHARS * 3), true)).toBe(false)
    h.parts.mark('3', 'session.events')
    expect(h.parts.take('3', piece(PART_CHARS), true)).toBe(false)
    expect(h.parts.take('4', piece(PART_CHARS * 3), true)).toBe(false)
  })

  it('a resume page behind the piece, the same thread\'s pushes written before it: both answers whole, every push once, the pushes first', async () => {
    // The window's side: a Transport on a socket the test hands the host's wire to, its acks going back.
    let socket!: SocketLike & { sent: string[] }
    const t = new Transport('wss://box/ws', 'remote', {
      socket: () =>
        (socket = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null, sent: [], send(d: string) { this.sent.push(d) }, close() {} })
    })
    const opened = t.open()
    socket.onmessage!({ data: JSON.stringify({ push: 'hello', environmentId: 'env_box', contract: 3, caps: ['read'], features: ['answer.parts'] }) })
    await opened
    expect(socket.sent).toEqual(['#parts'])
    const pushes: number[] = []
    t.onPush((p) => pushes.push((p as { row: { seq: number } }).row.seq))
    const read = t.request<{ content: string }>('fs.read', {})
    const resume = t.request<{ rows: { seq: number }[] }>('session.events', {})
    const [readId, resumeId] = socket.sent.slice(1).map((m) => (JSON.parse(m) as { id: string }).id)
    // The host: the piece, then the resume page (rows 5..8, past a part long) behind it, then rows 7, 8, 9 pushed.
    const h = host()
    h.parts.mark(readId!, 'fs.read')
    h.send({ id: readId, ok: true, result: { content: piece(4 * 1024 * 1024) } })
    const rows = [5, 6, 7, 8].map((seq) => ({ ...rowPush(seq).row, event: { type: 'assistant-text', text: seq === 5 ? 'x'.repeat(PART_CHARS) : `row ${seq}`, delta: false } }))
    h.parts.mark(resumeId!, 'session.events')
    h.send({ id: resumeId, ok: true, result: { rows, moreBefore: false, moreAfter: false, reset: false } })
    for (const seq of [7, 8, 9]) h.send(rowPush(seq))
    let delivered = 0
    let acks = 0
    for (let rounds = 0; rounds < 1000 && (delivered < h.wire.length || h.parts.waiting > 0); rounds++) {
      for (; delivered < h.wire.length; delivered++) socket.onmessage!({ data: h.wire[delivered]!.text })
      const said = socket.sent.map(readAck).filter((n): n is number => n !== null)
      acks = said.length
      if (said.length) h.parts.ack(said.at(-1)!)
    }
    expect((await read).content.length).toBe(4 * 1024 * 1024)
    expect((await resume).rows.map((r) => r.seq)).toEqual([5, 6, 7, 8])
    // One ack a part; the pushes came ahead of the page, once each (the store folds them by seq: store.remote.test.ts).
    expect(acks).toBe(h.wire.filter((w) => w.part).length)
    expect(pushes).toEqual([7, 8, 9])
    expect(h.wire.findLastIndex((w) => !w.part)).toBeLessThan(h.wire.findIndex((w) => w.part?.id === resumeId))
    t.close()
  })
})

/** A Transport on a socket the test hands frames to, after a hello that names parts. */
async function windowSide() {
  let socket!: SocketLike & { sent: string[] }
  const t = new Transport('wss://box/ws', 'remote', {
    socket: () => (socket = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null, sent: [], send(d: string) { this.sent.push(d) }, close() {} })
  })
  const opened = t.open()
  socket.onmessage!({ data: JSON.stringify({ push: 'hello', environmentId: 'env_box', contract: 3, caps: ['read'], features: ['answer.parts'] }) })
  await opened
  const deliver = (text: string): void => socket.onmessage!({ data: text })
  const acks = (): number[] => socket.sent.map(readAck).filter((n): n is number => n !== null)
  return { t, socket: () => socket, deliver, acks }
}

describe('AnswerParts framing and credit (M6 review, finding 10)', () => {
  it('takes only a whole ack within what was acked and sent; anything else moves nothing', () => {
    const h = host()
    h.parts.mark('7', 'fs.read')
    h.send({ id: '7', ok: true, result: { content: piece(2 * 1024 * 1024) } })
    const out = h.wire.length
    for (const bad of [PART_CHARS + 0.5, Number.NaN, -1, h.parts.unacked + 1, 1e30]) h.parts.ack(bad)
    expect(h.wire.length).toBe(out)
    expect(readAck('#ack 12.5')).toBeNull()
    h.parts.ack(PART_CHARS)
    expect(h.wire.length).toBe(out + 1)
    h.parts.ack(PART_CHARS - 1)
    expect(h.wire.length).toBe(out + 1)
  })

  it('checks the credit against the next part\'s own length: a short tail out never lets a full part pass the cap', () => {
    const h = host()
    // The first answer's JSON is 4 parts less 10 chars: all of it goes, UNACKED_CHARS - 10 out.
    const prefix = JSON.stringify({ id: '1', ok: true, result: { content: '' } }).length
    h.parts.mark('1', 'fs.read')
    h.send({ id: '1', ok: true, result: { content: piece(4 * PART_CHARS - 10 - prefix) } })
    expect(h.parts.unacked).toBe(UNACKED_CHARS - 10)
    h.parts.mark('2', 'fs.read')
    h.send({ id: '2', ok: true, result: { content: piece(3 * PART_CHARS) } })
    expect(h.wire.filter((w) => w.part?.id === '2')).toHaveLength(0)
    expect(h.parts.unacked).toBeLessThanOrEqual(UNACKED_CHARS)
    h.parts.ack(PART_CHARS)
    expect(h.wire.filter((w) => w.part?.id === '2')).toHaveLength(1)
    expect(h.parts.unacked).toBeLessThanOrEqual(UNACKED_CHARS)
  })

  it('an id with a space crosses the header whole; a duplicate outstanding id goes whole', () => {
    expect(readPart(partText('a b/ç', 0, true, 'x'))).toEqual({ id: 'a b/ç', offset: 0, last: true, body: 'x' })
    expect(readPart('#part a b 0 1\nx')).toBeNull()
    const h = host()
    h.parts.mark('5', 'fs.read')
    h.parts.mark('5', 'fs.read')
    expect(h.parts.take('5', piece(3 * PART_CHARS), true)).toBe(false)
    h.parts.mark('6', 'fs.read')
    expect(h.parts.take('6', piece(8 * PART_CHARS), true)).toBe(true)
    expect(h.parts.waiting).toBe(1)
    h.parts.mark('6', 'session.events')
    expect(h.parts.take('6', piece(3 * PART_CHARS), true)).toBe(false)
  })

  it('the window puts together only an answer it waits for, in order from 0, and drops one whose request timed out; every part is acked', async () => {
    vi.useFakeTimers()
    try {
      const w = await windowSide()
      const answer = (id: string): string => JSON.stringify({ id, ok: true, result: { content: piece(PART_CHARS) } })
      // An id it never asked for: acked, never answered.
      const stray = answer('99')
      w.deliver(partText('99', 0, false, stray.slice(0, PART_CHARS)))
      w.deliver(partText('99', PART_CHARS, true, stray.slice(PART_CHARS)))
      expect(w.acks()).toEqual([PART_CHARS, stray.length])
      // Out of order: what was held of it is dropped, and the rest does not answer.
      const first = w.t.request<{ content: string }>('fs.read', {}, { timeoutMs: 10_000 })
      const firstId = (JSON.parse(w.socket().sent.at(-1)!) as { id: string }).id
      const text = answer(firstId)
      w.deliver(partText(firstId, 0, false, text.slice(0, 1000)))
      w.deliver(partText(firstId, 2000, true, text.slice(2000)))
      let settled = false
      void first.then(() => (settled = true), () => (settled = true))
      await Promise.resolve()
      expect(settled).toBe(false)
      // A request that times out takes its partial answer with it: a late last part answers nothing.
      vi.advanceTimersByTime(10_000)
      await expect(first).rejects.toThrow(/timed out/)
      const second = w.t.request<{ content: string }>('fs.read', {}, { timeoutMs: 10_000 })
      const secondId = (JSON.parse(w.socket().sent.at(-1)!) as { id: string }).id
      const whole = answer(secondId)
      w.deliver(partText(secondId, 0, false, whole.slice(0, PART_CHARS)))
      w.deliver(partText(secondId, PART_CHARS, true, whole.slice(PART_CHARS)))
      expect((await second).content.length).toBe(PART_CHARS)
      w.t.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AnswerParts bounds (M6 review, finding 1)', () => {
  it('a window that never acks: past the held bound the socket closes 1013 once, and nothing more is sent or held', () => {
    const wire: string[] = []
    const closes: [number, string][] = []
    const parts = new AnswerParts((t) => wire.push(t), { close: (code, reason) => closes.push([code, reason]), maxHeldChars: 16 * 1024 * 1024, setTimer: () => 0, clearTimer: () => undefined })
    parts.enable()
    let n = 0
    for (; closes.length === 0 && n < 50; n++) {
      parts.mark(String(n), 'fs.read')
      parts.take(String(n), piece(4 * 1024 * 1024), true)
    }
    expect(closes).toEqual([[1013, 'answers waiting in parts passed 64 MiB']])
    expect(n).toBeLessThan(6)
    expect(parts.heldChars).toBe(0)
    const sent = wire.length
    parts.mark('late', 'fs.read')
    parts.take('late', piece(4 * 1024 * 1024), true)
    parts.ack(PART_CHARS)
    expect(wire.length).toBe(sent)
  })

  it('parts out and no ack that moves for 60 s close the socket; an ack that moves in time keeps it', () => {
    vi.useFakeTimers()
    try {
      const run = (ackAt: number | null): [number, string][] => {
        const closes: [number, string][] = []
        const parts = new AnswerParts(() => undefined, { close: (code, reason) => closes.push([code, reason]) })
        parts.enable()
        parts.mark('1', 'fs.read')
        parts.take('1', piece(2 * 1024 * 1024), true)
        if (ackAt !== null) {
          vi.advanceTimersByTime(ackAt)
          parts.ack(PART_CHARS)
          vi.advanceTimersByTime(PARTS_ACK_STALL_MS - ackAt - 1)
        } else vi.advanceTimersByTime(PARTS_ACK_STALL_MS - 1)
        expect(closes).toEqual([])
        vi.advanceTimersByTime(1)
        return closes
      }
      expect(run(null)).toEqual([[1013, 'parts went unacknowledged for 60 s']])
      expect(run(30_000)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

