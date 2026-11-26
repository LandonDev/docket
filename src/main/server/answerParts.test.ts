import { describe, expect, it } from 'vitest'
import { PART_CHARS, UNACKED_CHARS, readAck, readPart } from '@shared/answerParts'
import { AnswerParts } from './wire'
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
    expect(parts.map((w) => w.part!.index)).toEqual([...Array(parts[0]!.part!.count).keys()])
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
