import type { IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { VIDEO_LINK_EDGE, videoCloseReason, type VideoCloseReason } from '@shared/contract-video'
import { VIDEO_PUBLISH_MS, VIDEO_PUBLISH_PATH, VideoPublishAnswerSchema, type VideoPublishAnswer, type VideoPublishArgs } from '@shared/contract-videopublish'
import { MAX_MESSAGE_BYTES, MESSAGE_TYPES, SUBPROTOCOL, messageType } from '@shared/video/nsl1'
import type { RemoteAuth } from '../remote/auth'
import type { FeedSink, VideoFeed } from './feed'
import type { VideoAsk, VideoOpening, VideoSource } from './rpc'
import { offeredProtocols, type VideoUpgradeRefusal } from './sockets'

/**
 * The host's end of the publish leg (docs/agents/live-video.md "From his
 * other devices"): a stream another machine of his sends up to this host,
 * for a viewer here. The viewer asks this host; this host asks the machine
 * over the peer link to publish (`video.publish`), with the id of a socket
 * to dial and a single-use ticket for it; the machine dials
 * `/video-publish/<id>` and sends its frames. To the relay it is a feed
 * like any other: frames to the viewer, the viewer's acks back.
 */

/** A machine that was asked to publish has this long to dial in. */
export const PUBLISH_JOIN_MS = 10_000
/** Frames kept for a viewer whose own socket has not joined yet: the publisher sends no more than its window of them. */
const HELD_MAX = 256

/** The id a `/video-publish/<id>` path names, or null for any other path. */
export function publishIdOf(path: string): string | null {
  if (!path.startsWith(VIDEO_PUBLISH_PATH)) return null
  const id = path.slice(VIDEO_PUBLISH_PATH.length)
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null
}

/** What the feed needs of the publishing machine's socket (ws's WebSocket fits; a test passes a fake). */
export interface PublisherSocket {
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  on(event: 'message', fn: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown
  on(event: 'close', fn: (code: number) => void): unknown
}

export class PublishedFeed implements VideoFeed {
  private sink: FeedSink | null = null
  private socket: PublisherSocket | null = null
  private readonly held: Uint8Array[] = []
  private closed = false
  private timer: NodeJS.Timeout | null

  constructor(
    readonly id: string,
    private readonly gone: () => void,
    joinMs = PUBLISH_JOIN_MS
  ) {
    // a machine that never dials in leaves no stream waiting for it
    this.timer = setTimeout(() => this.end('error'), joinMs)
    this.timer.unref?.()
  }

  /** The publishing machine dialed in. False when the feed is gone or another socket has it. */
  attach(socket: PublisherSocket): boolean {
    if (this.closed || this.socket) return false
    this.socket = socket
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    socket.on('message', (data, isBinary) => {
      if (!isBinary || this.closed) return
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      // a publisher sends frames and nothing else
      if (messageType(bytes) !== MESSAGE_TYPES.frame) return
      if (this.sink) this.sink.frame(bytes)
      else if (this.held.length < HELD_MAX) this.held.push(new Uint8Array(bytes))
    })
    // the machine says why its stream ended in the close code, as a viewer's socket is told
    socket.on('close', (code) => this.end(videoCloseReason(code) ?? 'error'))
    return true
  }

  start(sink: FeedSink): void {
    if (this.closed) return
    this.sink = sink
    for (const frame of this.held.splice(0)) sink.frame(frame)
  }

  ack(bytes: Uint8Array): void {
    if (this.closed) return
    try {
      this.socket?.send(bytes)
    } catch {
      // the socket is going: its close ends the stream
    }
  }

  // a person's window takes no input through the picture
  input(): void {}
  release(): void {}

  close(): void {
    if (this.closed) return
    this.closed = true
    this.sink = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.gone()
    try {
      this.socket?.close(1000, 'closed')
    } catch {
      // closed already
    }
  }

  private end(reason: VideoCloseReason): void {
    if (this.closed) return
    const sink = this.sink
    this.close()
    sink?.end(reason)
  }
}

export interface PublishingDeps {
  auth: Pick<RemoteAuth, 'mintStreamTicket' | 'consumeStreamTicket'>
  /** asks a machine of his to publish; rejects when it is not connected or does not answer */
  call(mac: string, args: VideoPublishArgs, deadlineMs: number): Promise<unknown>
  /** the machine whose computer service holds a thread of this host's session, and the key it knows it by; null when none does */
  macOf(thread: string): { mac: string; key: string } | null
  joinMs?: number
  log?: (line: string) => void
}

/** The feeds waiting for or fed by a publishing machine, and the upgrade of that machine's socket. */
export class VideoPublishing implements VideoSource {
  private readonly feeds = new Map<string, PublishedFeed>()
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES, handleProtocols: () => SUBPROTOCOL })

  constructor(private readonly deps: PublishingDeps) {}

  /** A thread of this host whose computer session lives on a machine of his (a box thread that drives the Mac). */
  async open(ask: VideoAsk): Promise<VideoOpening | null> {
    const at = this.deps.macOf(ask.thread)
    return at ? this.from(at.mac, at.key, ask.maxEdge) : null
  }

  /** Asks `mac` to publish the session it knows as `key`. Every such viewer is across a link: the picture is at most 1280 on its long edge. */
  async from(mac: string, key: string, maxEdge: number): Promise<VideoOpening> {
    const id = randomBytes(12).toString('base64url')
    const feed = new PublishedFeed(id, () => void this.feeds.delete(id), this.deps.joinMs)
    this.feeds.set(id, feed)
    const { ticket } = this.deps.auth.mintStreamTicket({ stream: id, scope: 'publish', holder: { local: `publish:${mac}` } })
    let answer: VideoPublishAnswer
    try {
      answer = VideoPublishAnswerSchema.parse(await this.deps.call(mac, { key, publish: id, ticket, maxEdge: Math.min(maxEdge, VIDEO_LINK_EDGE) }, VIDEO_PUBLISH_MS))
    } catch (err) {
      feed.close()
      // not connected, an older build that does not know the call, or no answer in time
      this.deps.log?.(`video: ${mac} did not publish (${err instanceof Error ? err.message : String(err)})`)
      return { ok: false, reason: 'unsupported' }
    }
    if (!answer.ok) {
      feed.close()
      return answer
    }
    return { ok: true, feed, width: answer.width, height: answer.height, fps: answer.fps, scope: 'watch', tag: `published:${mac}` }
  }

  /** Upgrades a publishing machine's request, or answers the status to refuse it with. The ticket is spent whatever the answer. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): VideoUpgradeRefusal | null {
    const url = new URL(req.url ?? '/', 'http://host')
    const id = publishIdOf(url.pathname)
    if (!id) return 404
    if (!offeredProtocols(req).includes(SUBPROTOCOL)) return 400
    const ticket = url.searchParams.get('ticket')
    const claim = ticket ? this.deps.auth.consumeStreamTicket(ticket, id) : null
    if (!claim || claim.scope !== 'publish') return 401
    const feed = this.feeds.get(id)
    if (!feed) return 404
    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      if (!feed.attach(ws as unknown as PublisherSocket)) ws.close(1008, 'gone')
    })
    return null
  }

  /** How many machines are publishing or expected now. */
  get count(): number {
    return this.feeds.size
  }

  close(): void {
    for (const feed of [...this.feeds.values()]) feed.close()
    for (const ws of this.wss.clients) ws.terminate()
  }
}
