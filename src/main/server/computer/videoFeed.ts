import type { ComputerClickPush } from '@shared/contract-computer'
import { VIDEO_FPS, VIDEO_LINK_EDGE, VIDEO_MAX_EDGE, type VideoCloseReason, type VideoRefusal } from '@shared/contract-video'
import { VIDEO_STREAM, type ComputerNotification } from '@shared/computer/protocol'
import { HEADER_SIZE, MESSAGE_TYPES, messageType } from '@shared/video/nsl1'
import type { FeedSink, VideoFeed } from '../video/feed'
import type { VideoAsk, VideoOpening, VideoSource } from '../video/rpc'
import { ComputerRpcError, type ComputerConnection } from './connection'
import type { ComputerService } from './service'
import type { PreviewTarget } from './preview'
import type { ComputerSessions } from './sessions'

/**
 * A window in tc-computer as a source of live video
 * (docs/computer-protocol.md §30, docs/agents/live-video.md "A Mac's or a
 * PC's window"). `video.open` names a thread; the stream is of the window
 * that thread's session last read, as the 4 fps preview's is, and follows
 * the session to another window under the same socket: the service is asked
 * for a new stream, and the viewer sees a new generation that starts with a
 * keyframe at the new size.
 *
 * The service numbers a generation within each of its streams. A viewer
 * takes generations in rising order only, so the feed numbers them itself
 * and writes its own number into each frame, and the service's back into
 * each ack.
 */

/** A copy of a message under another generation. (A copy made whole: a Node buffer's own `slice` shares its bytes.) */
function renumbered(message: Uint8Array, generation: number): Uint8Array {
  const out = new Uint8Array(message)
  new DataView(out.buffer).setUint32(8, generation)
  return out
}

/** What a `capture/videoEnded` reason is to a viewer. */
const ENDS: Record<string, VideoCloseReason> = { stopped: 'ended', 'window-closed': 'ended', permission: 'permission', error: 'error' }

const refusal = (error: unknown): VideoRefusal => (error instanceof ComputerRpcError && error.data?.kind === 'permission_missing' ? 'permission' : 'unsupported')

export interface ComputerVideoDeps {
  service: ComputerService
  sessions: ComputerSessions
  /** `computer.video.remote`: this machine's windows may be watched from his other devices */
  remote(): boolean
  log?: (line: string) => void
}

interface Started {
  stream: number
  width: number
  height: number
}

/** Frames kept for a viewer whose socket has not joined, or whose stream's number is not known yet: the service sends no more than its window of them. */
const HELD_MAX = 256

/**
 * One viewer's stream of one thread's window. The service sends as soon as
 * it is asked, which is before the viewer's socket has joined and may be
 * before its own answer has said the stream's number: what comes in that
 * time is kept and passed on when the socket joins, the keyframe first.
 */
export class ServiceVideoFeed implements VideoFeed {
  private sink: FeedSink | null = null
  private closed = false
  /** the service's stream now, and the generation it last sent under */
  private stream: number | null = null
  /** records that came while a start was out: one of them may be the new stream's */
  private early: { stream: number; message: Uint8Array }[] | null = null
  private readonly held: Uint8Array[] = []
  private serviceGeneration = 0
  /** the number the viewer knows the stream's encoder by; it only rises */
  private generation = 0
  /** the viewer's own stream id, once the relay has opened it: a click is pushed under it */
  private id: string | null = null
  private readonly offs: (() => void)[] = []
  /** one change of window at a time */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: ComputerVideoDeps,
    conn: ComputerConnection,
    private readonly thread: string,
    private readonly ask: { maxEdge: number; mode: 'quality' | 'budget'; push?: (push: ComputerClickPush) => void }
  ) {
    this.offs.push(conn.onBytes((stream, message) => this.bytes(stream, message)))
  }

  /** Asks the service for the window's stream. What it sends before its answer is kept until the answer names it. */
  async begin(target: PreviewTarget): Promise<Started> {
    this.early = []
    try {
      const started = await startVideo(this.deps, target, this.ask)
      const early = this.early
      this.early = null
      if (this.closed) {
        void this.deps.service.request('capture.video.stop', { stream: started.stream }).catch(() => {})
        return started
      }
      this.stream = started.stream
      for (const record of early) this.bytes(record.stream, record.message)
      return started
    } finally {
      this.early = null
    }
  }

  opened(id: string): void {
    this.id = id
  }

  start(sink: FeedSink): void {
    if (this.closed) return
    this.sink = sink
    for (const frame of this.held.splice(0)) sink.frame(frame)
    const { service, sessions } = this.deps
    this.offs.push(
      service.onNotification((n) => this.notification(n)),
      // the service went and another came up: its streams went with it
      service.onEpoch(() => this.end('error')),
      sessions.onTarget((thread) => {
        if (thread === this.thread) this.follow()
      }),
      sessions.onRows((rows) => {
        if (!rows.some((r) => r.threadId === this.thread)) this.end('ended')
      })
    )
  }

  ack(bytes: Uint8Array): void {
    if (this.closed || this.stream === null || bytes.byteLength < HEADER_SIZE) return
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // an ack of a window the stream has left is owed to nobody
    if (view.getUint32(8) !== this.generation || !this.serviceGeneration) return
    const out = renumbered(bytes, this.serviceGeneration)
    void this.deps.service.connection().then((conn) => this.stream !== null && conn.sendBytes(this.stream, out)).catch(() => {})
  }

  // a person's window takes no input through the picture: he uses the real one
  input(): void {}
  release(): void {}

  close(): void {
    if (this.closed) return
    this.closed = true
    this.sink = null
    for (const off of this.offs.splice(0)) off()
    this.stop()
  }

  private stop(): void {
    const stream = this.stream
    this.stream = null
    if (stream !== null) void this.deps.service.request('capture.video.stop', { stream }).catch(() => {})
  }

  private end(reason: VideoCloseReason): void {
    if (this.closed) return
    const sink = this.sink
    this.close()
    sink?.end(reason)
  }

  private bytes(stream: number, message: Uint8Array): void {
    if (this.closed) return
    if (this.early) {
      if (this.early.length < HELD_MAX) this.early.push({ stream, message })
      return
    }
    if (stream !== this.stream || messageType(message) !== MESSAGE_TYPES.frame) return
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength)
    const theirs = view.getUint32(8)
    if (theirs !== this.serviceGeneration) {
      this.serviceGeneration = theirs
      this.generation++
    }
    const out = renumbered(message, this.generation)
    if (this.sink) this.sink.frame(out)
    else if (this.held.length < HELD_MAX) this.held.push(out)
  }

  private notification(n: ComputerNotification): void {
    if (n.method === 'capture/videoEnded' && n.params.stream === this.stream) {
      this.stream = null
      return this.end(ENDS[n.params.reason] ?? 'error')
    }
    // the agent's click, in the picture's own pixels: the viewer rings it
    if (n.method === 'capture/click' && this.stream !== null && n.params.stream === String(this.stream) && this.id) {
      this.ask.push?.({ push: 'computer-click', preview: this.id, at: n.params.at, width: n.params.width, height: n.params.height })
    }
  }

  /** The session reads another window now: the stream follows it, under the same socket. */
  private follow(): void {
    this.queue = this.queue.then(async () => {
      if (this.closed) return
      const target = this.deps.sessions.previewTarget(this.thread)
      if (!target) return this.end('ended')
      this.stop()
      // nothing of the old window's encoder is of use to the new one's
      this.serviceGeneration = 0
      try {
        await this.begin(target)
      } catch (error) {
        this.deps.log?.(`Computer video: ${(error as Error).message}`)
        this.end(refusal(error) === 'permission' ? 'permission' : 'error')
      }
    })
  }
}

function startVideo(deps: ComputerVideoDeps, target: PreviewTarget, ask: { maxEdge: number; mode: 'quality' | 'budget' }): Promise<Started> {
  return deps.service.request('capture.video.start', {
    session: target.serviceSession,
    app: { pid: target.app.pid },
    window: { id: target.window.id },
    maxEdge: ask.maxEdge,
    fps: VIDEO_STREAM.defaultFps,
    mode: ask.mode
  })
}

export class ComputerVideo implements VideoSource {
  constructor(private readonly deps: ComputerVideoDeps) {}

  async open(ask: VideoAsk): Promise<VideoOpening | null> {
    const { service, sessions } = this.deps
    const target = sessions.previewTarget(ask.thread)
    // not a session of this machine's service: another source may know the thread
    if (!target) return null
    // A person's windows go to this machine's own desktop. A viewer elsewhere gets them only through the host that
    // publishes them, and only while he has said they may be watched from his other devices.
    if (!ask.local && !ask.published) return { ok: false, reason: this.deps.remote() ? 'unsupported' : 'off' }
    if (ask.published && !this.deps.remote()) return { ok: false, reason: 'off' }
    let conn
    try {
      conn = await service.connection()
    } catch {
      return { ok: false, reason: 'unsupported' }
    }
    if (!conn.video) return { ok: false, reason: 'unsupported' }
    // across a link the picture is at most 1280 on its long edge and the encoder follows the link; here it is the window's own
    const shape = ask.local && !ask.published ? { maxEdge: Math.min(ask.maxEdge, VIDEO_MAX_EDGE), mode: 'quality' as const } : { maxEdge: Math.min(ask.maxEdge, VIDEO_LINK_EDGE), mode: 'budget' as const }
    try {
      await sessions.ensureOpen(ask.thread)
      const feed = new ServiceVideoFeed(this.deps, conn, ask.thread, { ...shape, push: ask.push })
      let started
      try {
        started = await feed.begin(target)
      } catch (error) {
        feed.close()
        throw error
      }
      return { ok: true, feed, width: started.width, height: started.height, fps: VIDEO_FPS, scope: 'watch', tag: `window:${target.app.pid}:${target.window.id}`, opened: (stream) => feed.opened(stream) }
    } catch (error) {
      this.deps.log?.(`Computer video: ${(error as Error).message}`)
      return { ok: false, reason: refusal(error) }
    }
  }
}
