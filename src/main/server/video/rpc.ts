import type { Principal } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import { type VideoOpenAnswer, type VideoRefusal } from '@shared/contract-video'
import { mayWatch } from '@shared/video/access'
import type { RemoteAuth, StreamHolder } from '../remote/auth'
import type { VideoFeed } from './feed'
import type { StreamInfo, VideoRelay } from './relay'

/**
 * `video.open`, `video.close` and `video.paste` on the host the asking socket
 * is connected to (docs/agents/live-video.md). `mayWatch` decides who; a
 * source decides what: the box's browser, a window in tc-computer, or a
 * stream another host publishes here.
 */

export interface VideoAsk {
  thread: string
  maxEdge: number
  take: boolean
  drive: boolean
  principal: Principal
  /** the viewer is on this host's own socket: its frames cross no link */
  local: boolean
}

export type VideoOpening =
  | {
      ok: true
      feed: VideoFeed
      width: number
      height: number
      fps: number
      /** `drive` only when it was asked and he is the driver now */
      scope: 'watch' | 'drive'
      group?: string
      tag?: string
      /** told the stream's id once it is opened, for a source that keeps something beside each of its streams */
      opened?: (stream: string) => void
    }
  | { ok: false; reason: VideoRefusal }

export interface VideoSource {
  /** Opens a feed for one viewer, refuses, or answers null when the thread is not this source's. */
  open(ask: VideoAsk): Promise<VideoOpening | null>
  /** Text into the page he drives; only a source that takes his input has it. */
  paste?(stream: StreamInfo, text: string): Promise<void>
}

/** Who asks: the socket's principal and the socket itself. */
export interface VideoCaller {
  principal: Principal
  /** the RPC socket: a stream ends with it, and only it may close or paste into the stream */
  connection: object
  /** the socket's id on this host: who a desktop's own ticket names, since its socket has no key */
  connectionId: string
  /** the RPC socket is still open; a stream is never opened for one that closed while its source was asked */
  alive?: () => boolean
}

export class VideoRpc {
  private readonly sources: VideoSource[] = []
  /** the source each open stream came from */
  private readonly origin = new Map<string, VideoSource>()

  constructor(
    private readonly relay: VideoRelay,
    private readonly auth: Pick<RemoteAuth, 'mintStreamTicket'>,
    /** this host has a desktop of its own; the box does not */
    private readonly desktop: () => boolean
  ) {
    relay.onChange(() => {
      if (!this.origin.size) return
      const live = new Set(relay.list().map((s) => s.id))
      for (const id of this.origin.keys()) if (!live.has(id)) this.origin.delete(id)
    })
  }

  /** A source is asked in the order it was added; the first that knows the thread answers. */
  addSource(source: VideoSource): () => void {
    this.sources.push(source)
    return () => void this.sources.splice(this.sources.indexOf(source), 1)
  }

  async open(params: { threadId: string; maxEdge: number; take?: boolean; drive?: boolean }, caller: VideoCaller): Promise<VideoOpenAnswer> {
    if (!mayWatch(caller.principal, { desktop: this.desktop() })) return { ok: false, reason: 'refused' }
    const ask: VideoAsk = {
      thread: params.threadId,
      maxEdge: params.maxEdge,
      take: params.take === true,
      drive: params.drive === true,
      principal: caller.principal,
      local: caller.principal.kind === 'local'
    }
    for (const source of [...this.sources]) {
      const opening = await source.open(ask)
      if (!opening) continue
      if (!opening.ok) return opening
      if (caller.alive && !caller.alive()) {
        opening.feed.close()
        return { ok: false, reason: 'refused' }
      }
      const holder: StreamHolder = caller.principal.kind === 'local' ? { local: caller.connectionId } : { keyId: caller.principal.keyId }
      const stream = this.relay.open({
        thread: ask.thread,
        scope: opening.scope,
        holder,
        connection: caller.connection,
        feed: opening.feed,
        group: opening.group,
        tag: opening.tag
      })
      this.origin.set(stream, source)
      opening.opened?.(stream)
      const { ticket } = this.auth.mintStreamTicket({ stream, scope: opening.scope, holder })
      return { ok: true, stream, ticket, width: opening.width, height: opening.height, fps: opening.fps }
    }
    return { ok: false, reason: 'unsupported' }
  }

  close(stream: string, caller: VideoCaller): null {
    this.relay.close(stream, caller.connection)
    return null
  }

  /** Text into the page he drives: his own `drive` stream only, and only while he is the driver. */
  async paste(params: { stream: string; text: string }, caller: VideoCaller): Promise<null> {
    const stream = this.relay.own(params.stream, caller.connection)
    if (!stream || stream.scope !== 'drive' || !stream.group || !this.relay.driving(stream.group)) throw new Error('forbidden: video.paste needs a stream you are driving')
    const source = this.origin.get(stream.id)
    if (!source?.paste) throw new Error('This stream takes no paste')
    await source.paste(stream, params.text)
    return null
  }
}

export async function handleVideo(req: ClientRequest, video: VideoRpc, caller: VideoCaller): Promise<{ handled: boolean; result?: unknown }> {
  switch (req.method) {
    case 'video.open':
      return { handled: true, result: await video.open(req.params, caller) }
    case 'video.close':
      return { handled: true, result: video.close(req.params.stream, caller) }
    case 'video.paste':
      return { handled: true, result: await video.paste(req.params, caller) }
    default:
      return { handled: false }
  }
}
