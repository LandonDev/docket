import { describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL, type Capability, type Principal } from '@shared/capabilities'
import { VIDEO_CLOSE } from '@shared/contract-video'
import { MESSAGE_TYPES, encodeAck, encodeInput, header, parseFrame, parseInput } from '@shared/video/nsl1'
import type { StreamClaim } from '../remote/auth'
import { FakeFeed } from './feed'
import { VideoRelay, type StreamGrant, type ViewerSocket } from './relay'
import { VideoRpc, type VideoOpening, type VideoSource } from './rpc'

/** A viewer's socket as the relay sees one: what it was sent, and how it was closed. */
class FakeSocket implements ViewerSocket {
  bufferedAmount = 0
  readonly sent: Uint8Array[] = []
  closed: { code: number; reason: string } | null = null
  private readonly handlers: { message: ((data: Buffer, isBinary: boolean) => void)[]; close: (() => void)[] } = { message: [], close: [] }
  send(data: Uint8Array): void {
    this.sent.push(data)
  }
  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = { code, reason }
    for (const fn of this.handlers.close) fn()
  }
  on(event: 'message' | 'close', fn: never): void {
    ;(this.handlers[event] as unknown[]).push(fn)
  }
  /** the viewer sends a binary message */
  say(bytes: Uint8Array): void {
    for (const fn of this.handlers.message) fn(Buffer.from(bytes), true)
  }
  /** the viewer sends text, which the wire never carries */
  text(words: string): void {
    for (const fn of this.handlers.message) fn(Buffer.from(words), false)
  }
  /** the viewer's end drops */
  drop(): void {
    this.close(1006, '')
  }
}

const KEY = { keyId: 'k1' }
const asker = {}
function joined(relay: VideoRelay, grant: Partial<StreamGrant> = {}) {
  const feed = new FakeFeed()
  const full: StreamGrant = { thread: 't1', scope: 'watch', holder: KEY, connection: asker, feed, ...grant }
  const id = relay.open(full)
  const socket = new FakeSocket()
  const claim: StreamClaim = { stream: id, scope: full.scope, holder: full.holder }
  expect(relay.attach(claim, socket)).toBe(true)
  return { id, feed, socket, claim }
}

describe('VideoRelay', () => {
  it('passes frames to the viewer as they came, and starts the feed only when the viewer joins', () => {
    const relay = new VideoRelay()
    const feed = new FakeFeed()
    const id = relay.open({ thread: 't1', scope: 'watch', holder: KEY, connection: asker, feed })
    expect(feed.started).toBe(false)
    const socket = new FakeSocket()
    expect(relay.attach({ stream: id, scope: 'watch', holder: KEY }, socket)).toBe(true)
    expect(feed.started).toBe(true)
    feed.push({ size: 900 })
    feed.push({ size: 40 })
    expect(socket.sent.map((b) => parseFrame(b).sequence)).toEqual([1, 2])
    expect(parseFrame(socket.sent[0])).toMatchObject({ keyframe: true, width: 1280, height: 800 })
    expect(socket.sent[0].byteLength).toBe(20 + 12 + 900)
  })

  it('passes acks straight through, in order, with the wait they carry', () => {
    const relay = new VideoRelay()
    const { feed, socket } = joined(relay)
    const acks = [encodeAck(1, 1, 3.5), encodeAck(1, 2), encodeAck(1, 3, 0)]
    for (const ack of acks) socket.say(ack)
    expect(feed.acks.map((b) => [...b])).toEqual(acks.map((b) => [...b]))
    expect(feed.acked()).toEqual([1, 2, 3])
  })

  it("drops a watch socket's input, and anything that is not an ack or input", () => {
    const relay = new VideoRelay()
    relay.setDriver('pane', true)
    const { feed, socket } = joined(relay, { group: 'pane' })
    socket.say(encodeInput({ type: 'keyDown', key: 4 }, 1))
    socket.say(encodeInput({ type: 'pointerMove', x: 0.5, y: 0.5 }, 1))
    socket.say(header(MESSAGE_TYPES.cursor, 1, 0, 8))
    socket.say(Uint8Array.of(1, 2, 3))
    socket.text('{"method":"video.open"}')
    expect(feed.inputs).toEqual([])
    expect(feed.acks).toEqual([])
    expect(socket.closed).toBeNull()
  })

  it("passes a drive socket's input only while he is the driver, and sends release-all when he hands back", () => {
    const relay = new VideoRelay()
    const { feed, socket } = joined(relay, { scope: 'drive', group: 'pane' })
    const key = encodeInput({ type: 'keyDown', key: 4 }, 1)
    socket.say(key)
    expect(feed.inputs).toEqual([])
    relay.setDriver('pane', true)
    expect(relay.driving('pane')).toBe(true)
    socket.say(key)
    expect(feed.inputs.map((b) => parseInput(b))).toEqual([{ type: 'keyDown', key: 4, buttons: 0, modifiers: 0 }])
    relay.setDriver('other', false)
    socket.say(key)
    expect(feed.inputs).toHaveLength(2)
    relay.setDriver('pane', false)
    expect(parseInput(feed.inputs[2])).toEqual({ type: 'releaseAll' })
    socket.say(key)
    expect(feed.inputs).toHaveLength(3)
    // a watch stream from then on: taking over again needs a new ticket
    expect(relay.list()[0].scope).toBe('watch')
    relay.setDriver('pane', true)
    socket.say(key)
    expect(feed.inputs).toHaveLength(3)
    // acks never stop
    socket.say(encodeAck(1, 1))
    expect(feed.acked()).toEqual([1])
  })

  it('never passes a feed message that is not a frame', () => {
    const relay = new VideoRelay()
    const { feed, socket } = joined(relay)
    feed.raw(header(MESSAGE_TYPES.cursor, 1, 0, 8))
    feed.raw(encodeAck(1, 1))
    feed.raw(Uint8Array.of(9, 9))
    expect(socket.sent).toEqual([])
  })

  it('closes a socket that holds more than 8 MiB unsent, and lets the feed go', () => {
    const relay = new VideoRelay()
    const { feed, socket } = joined(relay)
    socket.bufferedAmount = 8 * 1024 * 1024
    feed.push()
    expect(socket.closed).toBeNull()
    socket.bufferedAmount = 8 * 1024 * 1024 + 1
    feed.push()
    expect(socket.closed).toEqual({ code: VIDEO_CLOSE.slow, reason: 'slow' })
    expect(socket.sent).toHaveLength(1)
    expect(feed.closed).toBe(true)
    expect(relay.list()).toEqual([])
  })

  it("carries the reason in the close code: the feed's own end, and an end the host asks for", () => {
    const relay = new VideoRelay()
    for (const reason of ['ended', 'moved', 'busy', 'held', 'revoked', 'error', 'permission'] as const) {
      const a = joined(relay)
      a.feed.finish(reason)
      expect(a.socket.closed).toEqual({ code: VIDEO_CLOSE[reason], reason })
      expect(a.feed.closed).toBe(true)
      const b = joined(relay)
      relay.end(b.id, reason)
      expect(b.socket.closed).toEqual({ code: VIDEO_CLOSE[reason], reason })
    }
    expect(relay.list()).toEqual([])
  })

  it('lets the feed go when the viewer drops, and sends it nothing after', () => {
    const relay = new VideoRelay()
    const { feed, socket } = joined(relay)
    socket.drop()
    expect(feed.closed).toBe(true)
    feed.push()
    socket.say(encodeAck(1, 1))
    expect(feed.acks).toEqual([])
    expect(relay.list()).toEqual([])
  })

  it('joins a stream once, and only on the claim it was opened for', () => {
    const relay = new VideoRelay()
    const feed = new FakeFeed()
    const id = relay.open({ thread: 't1', scope: 'watch', holder: KEY, connection: asker, feed })
    expect(relay.attach({ stream: id, scope: 'drive', holder: KEY }, new FakeSocket())).toBe(false)
    expect(relay.attach({ stream: id, scope: 'watch', holder: { keyId: 'k2' } }, new FakeSocket())).toBe(false)
    expect(relay.attach({ stream: id, scope: 'watch', holder: { local: 'k1' } }, new FakeSocket())).toBe(false)
    expect(relay.attach({ stream: 'nope', scope: 'watch', holder: KEY }, new FakeSocket())).toBe(false)
    expect(feed.started).toBe(false)
    expect(relay.attach({ stream: id, scope: 'watch', holder: KEY }, new FakeSocket())).toBe(true)
    expect(relay.attach({ stream: id, scope: 'watch', holder: KEY }, new FakeSocket())).toBe(false)
  })

  it('ends a stream nobody joined, once its ticket can no longer open it', () => {
    vi.useFakeTimers()
    try {
      const relay = new VideoRelay({ unclaimedMs: 1_000 })
      const feed = new FakeFeed()
      const id = relay.open({ thread: 't1', scope: 'watch', holder: KEY, connection: asker, feed })
      vi.advanceTimersByTime(999)
      expect(relay.list().map((s) => s.id)).toEqual([id])
      vi.advanceTimersByTime(1)
      expect(relay.list()).toEqual([])
      expect(feed.closed).toBe(true)
      // a joined stream has no such clock
      const live = joined(relay)
      vi.advanceTimersByTime(60_000)
      expect(live.socket.closed).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a revoked key's streams close with revoked; another key's and the desktop's stay", () => {
    const relay = new VideoRelay()
    const mine = joined(relay)
    const waiting = relay.open({ thread: 't1', scope: 'watch', holder: KEY, connection: asker, feed: new FakeFeed() })
    const other = joined(relay, { holder: { keyId: 'k2' } })
    const desk = joined(relay, { holder: { local: '7' } })
    relay.revoke('k1')
    expect(mine.socket.closed).toEqual({ code: VIDEO_CLOSE.revoked, reason: 'revoked' })
    expect(relay.list().some((s) => s.id === waiting)).toBe(false)
    expect(other.socket.closed).toBeNull()
    expect(desk.socket.closed).toBeNull()
  })

  it('a socket closes only the streams it opened, and its streams end with it', () => {
    const relay = new VideoRelay()
    const a = {}
    const b = {}
    const mine = joined(relay, { connection: a })
    const theirs = joined(relay, { connection: b })
    expect(relay.close(theirs.id, a)).toBe(false)
    expect(relay.own(theirs.id, a)).toBeNull()
    expect(theirs.socket.closed).toBeNull()
    expect(relay.own(mine.id, a)?.id).toBe(mine.id)
    expect(relay.close(mine.id, a)).toBe(true)
    expect(mine.socket.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
    relay.dropConnection(b)
    expect(theirs.socket.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
  })

  it('ends the streams a source names, and tells whoever counts viewers', () => {
    const relay = new VideoRelay()
    const changes = vi.fn()
    relay.onChange(changes)
    const one = joined(relay, { tag: 'page-1' })
    const two = joined(relay, { tag: 'page-2' })
    expect(relay.list().map((s) => [s.tag, s.joined])).toEqual([
      ['page-1', true],
      ['page-2', true]
    ])
    const before = changes.mock.calls.length
    expect(relay.endWhere((s) => s.tag === 'page-1', 'moved')).toBe(1)
    expect(one.socket.closed).toEqual({ code: VIDEO_CLOSE.moved, reason: 'moved' })
    expect(two.socket.closed).toBeNull()
    expect(changes.mock.calls.length).toBeGreaterThan(before)
    relay.shutdown()
    expect(two.socket.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
  })
})

describe('VideoRpc', () => {
  const key = (caps: Capability[], audience: 'client' | 'mcp' = 'client'): Principal => ({ kind: 'remote', keyId: 'k1', name: 'Phone', audience, caps })
  const tickets = () => {
    const minted: StreamClaim[] = []
    return { minted, auth: { mintStreamTicket: (claim: StreamClaim) => (minted.push(claim), { ticket: `ticket-${minted.length}`, expiresIn: 30 }) } }
  }
  const source = (opening: VideoOpening | null, extra: Partial<VideoSource> = {}): VideoSource & { asks: unknown[] } => {
    const asks: unknown[] = []
    return { asks, open: async (ask) => (asks.push(ask), opening), ...extra }
  }
  const caller = (principal: Principal) => ({ principal, connection: {}, connectionId: '12' })
  const live = (scope: 'watch' | 'drive' = 'watch'): VideoOpening => ({ ok: true, feed: new FakeFeed(), width: 1280, height: 800, fps: 120, scope, group: 'pane' })
  const ASK = { threadId: 't1', maxEdge: 1280 }

  it('refuses a caller who may not watch before any source is asked', async () => {
    const relay = new VideoRelay()
    const { auth, minted } = tickets()
    const s = source(live())
    const box = new VideoRpc(relay, auth, () => false)
    box.addSource(s)
    expect(await box.open(ASK, caller(key(['read'])))).toEqual({ ok: false, reason: 'refused' })
    expect(await box.open(ASK, caller(key(['operate', 'read'])))).toEqual({ ok: false, reason: 'refused' })
    expect(await box.open(ASK, caller(key(['approve', 'read'], 'mcp')))).toEqual({ ok: false, reason: 'refused' })
    // the box's own socket: any process of its user reaches it
    expect(await box.open(ASK, caller(LOCAL_PRINCIPAL))).toEqual({ ok: false, reason: 'refused' })
    expect(s.asks).toEqual([])
    expect(minted).toEqual([])
    expect(relay.list()).toEqual([])
  })

  it('opens a stream for a key that may watch, with a ticket bound to the stream, its scope and the key', async () => {
    const relay = new VideoRelay()
    const { auth, minted } = tickets()
    const s = source(live())
    const rpc = new VideoRpc(relay, auth, () => false)
    rpc.addSource(s)
    const answer = await rpc.open({ ...ASK, take: true }, caller(key(['approve', 'read'])))
    expect(answer).toMatchObject({ ok: true, ticket: 'ticket-1', width: 1280, height: 800, fps: 120 })
    if (!answer.ok) throw new Error()
    expect(minted).toEqual([{ stream: answer.stream, scope: 'watch', holder: { keyId: 'k1' } }])
    expect(s.asks).toEqual([{ thread: 't1', maxEdge: 1280, take: true, drive: false, principal: key(['approve', 'read']), local: false }])
    expect(relay.list()).toMatchObject([{ id: answer.stream, thread: 't1', scope: 'watch', group: 'pane', joined: false }])
  })

  it("binds a desktop's own stream to the socket that asked", async () => {
    const relay = new VideoRelay()
    const { auth, minted } = tickets()
    const rpc = new VideoRpc(relay, auth, () => true)
    rpc.addSource(source(live('drive')))
    const answer = await rpc.open({ ...ASK, drive: true }, caller(LOCAL_PRINCIPAL))
    expect(answer.ok).toBe(true)
    expect(minted[0]).toMatchObject({ scope: 'drive', holder: { local: '12' } })
  })

  it('asks the sources in order: the first that knows the thread answers, and none says unsupported', async () => {
    const relay = new VideoRelay()
    const { auth } = tickets()
    const rpc = new VideoRpc(relay, auth, () => true)
    expect(await rpc.open(ASK, caller(LOCAL_PRINCIPAL))).toEqual({ ok: false, reason: 'unsupported' })
    const stranger = source(null)
    const busy = source({ ok: false, reason: 'busy' })
    const never = source(live())
    rpc.addSource(stranger)
    const off = rpc.addSource(busy)
    rpc.addSource(never)
    expect(await rpc.open(ASK, caller(LOCAL_PRINCIPAL))).toEqual({ ok: false, reason: 'busy' })
    expect(never.asks).toEqual([])
    off()
    expect((await rpc.open(ASK, caller(LOCAL_PRINCIPAL))).ok).toBe(true)
  })

  it('pastes only into a stream the caller opened, of the drive kind, while he is the driver', async () => {
    const relay = new VideoRelay()
    const { auth } = tickets()
    const pasted: string[] = []
    const rpc = new VideoRpc(relay, auth, () => true)
    rpc.addSource(source(live('drive'), { paste: async (_stream, text) => void pasted.push(text) }))
    const me = caller(LOCAL_PRINCIPAL)
    const answer = await rpc.open({ ...ASK, drive: true }, me)
    if (!answer.ok) throw new Error()
    const refusal = 'forbidden: video.paste needs a stream you are driving'
    await expect(rpc.paste({ stream: answer.stream, text: 'hello' }, me)).rejects.toThrow(refusal)
    relay.setDriver('pane', true)
    await expect(rpc.paste({ stream: answer.stream, text: 'hello' }, caller(LOCAL_PRINCIPAL))).rejects.toThrow(refusal)
    await expect(rpc.paste({ stream: 'nope', text: 'hello' }, me)).rejects.toThrow(refusal)
    expect(await rpc.paste({ stream: answer.stream, text: 'hello' }, me)).toBeNull()
    expect(pasted).toEqual(['hello'])
    relay.setDriver('pane', false)
    await expect(rpc.paste({ stream: answer.stream, text: 'again' }, me)).rejects.toThrow(refusal)
    // closing is the caller's own stream only
    rpc.close(answer.stream, caller(LOCAL_PRINCIPAL))
    expect(relay.list()).toHaveLength(1)
    rpc.close(answer.stream, me)
    expect(relay.list()).toEqual([])
  })

  it('a watch stream takes no paste', async () => {
    const relay = new VideoRelay()
    const { auth } = tickets()
    const rpc = new VideoRpc(relay, auth, () => true)
    rpc.addSource(source(live('watch'), { paste: async () => {} }))
    const me = caller(LOCAL_PRINCIPAL)
    const answer = await rpc.open(ASK, me)
    if (!answer.ok) throw new Error()
    relay.setDriver('pane', true)
    await expect(rpc.paste({ stream: answer.stream, text: 'x' }, me)).rejects.toThrow('needs a stream you are driving')
  })
})
