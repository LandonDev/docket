import type { Principal } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { ComputerClickPush } from '@shared/contract-computer'
import { type VideoCopyAnswer, type VideoOpenAnswer, type VideoRefusal } from '@shared/contract-video'
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
  /** the computer asked for by its name (`vm:windows`), whose source answers whatever the thread */
  computer?: string
  maxEdge: number
  take: boolean
  drive: boolean
  principal: Principal
  /** the viewer is on this host's own socket: its frames cross no link */
  local: boolean
  /** another host of his asks, to pass the stream on to a viewer there (the publish leg): the frames cross a link */
  published?: boolean
  /** a push to the asking socket, for what rides beside a stream (the agent's click on a window) */
  push?: (push: ComputerClickPush) => void
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
  /** The far clipboard's text after his copy, for his own; only a source that takes his input has it. */
  copy?(stream: StreamInfo): Promise<VideoCopyAnswer>
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
  /** a push to this socket */
  push?: (push: ComputerClickPush) => void
}

export class VideoRpc {
  private readonly sources: VideoSource[] = []
  /** asked after every other source, whenever each was added: one that reaches for another host */
  private readonly last: VideoSource[] = []
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

  /**
   * A source is asked in the order it was added; the first that knows the thread answers. A `last` source is asked
   * after all the others: a thread whose page this host shows itself is never asked of another host.
   */
  addSource(source: VideoSource, where: 'first' | 'last' = 'first'): () => void {
    const list = where === 'last' ? this.last : this.sources
    list.push(source)
    return () => void list.splice(list.indexOf(source), 1)
  }

  /**
   * `via` answers in the sources' place: a relayed socket's ask is for a session on the host it is relayed to, which
   * this host reaches by the publish leg alone.
   */
  async open(
    params: { threadId: string; computer?: string; maxEdge: number; take?: boolean; drive?: boolean },
    caller: VideoCaller,
    via?: (ask: VideoAsk) => Promise<VideoOpening | null>
  ): Promise<VideoOpenAnswer> {
    if (!mayWatch(caller.principal, { desktop: this.desktop() })) return { ok: false, reason: 'refused' }
    const ask: VideoAsk = {
      thread: params.threadId,
      ...(params.computer ? { computer: params.computer } : {}),
      maxEdge: params.maxEdge,
      take: params.take === true,
      drive: params.drive === true,
      principal: caller.principal,
      local: caller.principal.kind === 'local',
      ...(caller.push ? { push: caller.push } : {})
    }
    for (const source of via ? [{ open: via } satisfies VideoSource] : [...this.sources, ...this.last]) {
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

  /** The far clipboard's text after his copy: his own `drive` stream only, and only while he is the driver. */
  async copy(params: { stream: string }, caller: VideoCaller): Promise<VideoCopyAnswer> {
    const stream = this.relay.own(params.stream, caller.connection)
    if (!stream || stream.scope !== 'drive' || !stream.group || !this.relay.driving(stream.group)) throw new Error('forbidden: video.copy needs a stream you are driving')
    const source = this.origin.get(stream.id)
    if (!source?.copy) throw new Error('This stream gives no copy')
    return source.copy(stream)
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
    case 'video.copy':
      return { handled: true, result: await video.copy(req.params, caller) }
    default:
      return { handled: false }
  }
}
