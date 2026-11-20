import { WebSocket } from 'ws'
import type { ServerPush } from '@shared/contract'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { VIDEO_CLOSE, type VideoCloseReason } from '@shared/contract-video'
import { VIDEO_PUBLISH_PATH, VideoPublishParamsSchema, isVideoPeerMethod, type VideoPublishAnswer, type VideoPublishArgs } from '@shared/contract-videopublish'
import { MESSAGE_TYPES, SUBPROTOCOL, messageType } from '@shared/video/nsl1'
import { servePeerCall, type LinkRequest } from '../remote/peerCalls'
import type { VideoFeed } from './feed'
import type { VideoSource } from './rpc'

/**
 * The machine's end of the publish leg (docs/agents/live-video.md "From his
 * other devices"): this Mac or PC sends one session's video up to the host
 * it dials, for a viewer there. It publishes only while he has said its
 * windows may be watched from his other devices (`computer.video.remote`),
 * only to a host it has saved, and only up a socket it dials itself with
 * the single-use ticket that host's call carried. Turning the switch off
 * closes every stream it is publishing.
 */

/** What the publisher needs of the socket it dials (ws's WebSocket fits; a test passes a fake). */
export interface UpSocket {
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  on(event: 'open', fn: () => void): unknown
  on(event: 'message', fn: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown
  on(event: 'close', fn: () => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
}

export interface VideoPublisherDeps {
  /** `computer.video.remote` */
  remote(): boolean
  /** this machine's windows as a source (computer/videoFeed.ts) */
  source: Pick<VideoSource, 'open'>
  /** where a saved host's listener is, as this machine dials it; null for a host it does not know */
  urlOf(envId: string): string | null
  link(envId: string): LinkRequest | null
  dial?: (url: string, protocols: string[]) => UpSocket
  log?: (line: string) => void
}

/** The address of the socket to dial on a host whose RPC socket is at `rpcUrl`. */
export function publishUrl(rpcUrl: string, publish: string, ticket: string): string {
  const url = new URL(rpcUrl)
  url.pathname = `${VIDEO_PUBLISH_PATH}${publish}`
  url.search = ''
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

export class VideoPublisher {
  /** every stream being published now: its feed and the socket it goes up */
  private readonly live = new Set<{ feed: VideoFeed; socket: UpSocket }>()

  constructor(private readonly deps: VideoPublisherDeps) {}

  onPeerPush(envId: string, push: ServerPush): boolean {
    if (push.push !== 'peer.call' || !isVideoPeerMethod(push.method)) return false
    const request = this.deps.link(envId)
    if (!request) return true
    void servePeerCall(push, envId, (_method, params, ctx) => this.publish(ctx.from, VideoPublishParamsSchema.parse(params).args), request, this.deps.log)
    return true
  }

  /** `video.publish` from a host this machine has saved. */
  async publish(from: string, args: VideoPublishArgs): Promise<VideoPublishAnswer> {
    if (!this.deps.remote()) return { ok: false, reason: 'off' }
    const base = this.deps.urlOf(from)
    if (!base) return { ok: false, reason: 'refused' }
    // the viewer is his, on a device that host answers for: the question here is only whether this machine publishes
    const opening = await this.deps.source.open({ thread: args.key, maxEdge: args.maxEdge, take: false, drive: false, principal: LOCAL_PRINCIPAL, local: false, published: true })
    if (!opening) return { ok: false, reason: 'unsupported' }
    if (!opening.ok) return opening
    // he may have turned it off while the window's stream was starting
    if (!this.deps.remote()) {
      opening.feed.close()
      return { ok: false, reason: 'off' }
    }
    const socket = (this.deps.dial ?? ((url, protocols) => new WebSocket(url, protocols, { perMessageDeflate: false }) as unknown as UpSocket))(publishUrl(base, args.publish, args.ticket), [SUBPROTOCOL])
    const entry = { feed: opening.feed, socket }
    this.live.add(entry)
    let over = false
    const stop = (code?: number, reason?: string): void => {
      if (over) return
      over = true
      this.live.delete(entry)
      opening.feed.close()
      try {
        socket.close(code, reason)
      } catch {
        // closed already
      }
    }
    socket.on('open', () => {
      if (over) return
      opening.feed.start({
        frame: (bytes) => {
          try {
            socket.send(bytes)
          } catch {
            stop()
          }
        },
        // the host tells its viewer why with the same code
        end: (reason: VideoCloseReason) => stop(VIDEO_CLOSE[reason], reason)
      })
    })
    socket.on('message', (data, isBinary) => {
      if (!isBinary || over) return
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      // the host passes the viewer's acks down, and nothing else is taken
      if (messageType(bytes) === MESSAGE_TYPES.ack) opening.feed.ack(bytes)
    })
    socket.on('close', () => stop())
    socket.on('error', (err) => {
      this.deps.log?.(`video: the publish socket failed (${err.message})`)
      stop()
    })
    return { ok: true, width: opening.width, height: opening.height, fps: opening.fps }
  }

  /** How many streams this machine is publishing now. */
  get count(): number {
    return this.live.size
  }

  /** He turned the switch off, or the host is closing: nothing of this machine's windows goes on leaving it. */
  closeAll(): void {
    for (const { feed, socket } of [...this.live]) {
      feed.close()
      try {
        socket.close(VIDEO_CLOSE.ended, 'ended')
      } catch {
        // closed already
      }
    }
    this.live.clear()
  }
}

/** The offer a desktop with a computer service makes; the box has no windows of his to publish. */
export function videoOffers(hasService: boolean): string[] {
  return hasService ? ['video'] : []
}
