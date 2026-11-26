import { randomBytes } from 'node:crypto'
import { VIDEO_CLOSE, type VideoAccept, type VideoCloseReason } from '@shared/contract-video'
import { MESSAGE_TYPES, encodePong, messageType, parseFrame, pingSequence } from '@shared/video/nsl1'
import { VideoSamples } from '@shared/video/samples'
import type { StreamClaim, StreamHolder, StreamScope } from '../remote/auth'
import type { VideoFeed } from './feed'

/**
 * Joins a viewer's socket to its feed (docs/agents/live-video.md "The
 * relay"). A pipe, never a fan-out: one stream is one viewer, one socket and
 * one feed, so each encoder follows its own viewer's link. It reads a
 * message's type and samples capture time on a known clock:
 *   feed → viewer   frames and opted-in cursor shapes, as they came
 *   viewer → feed   acks, as they came; input only on a `drive` stream while he is the driver
 * Frames never touch the RPC socket, the push coalescer or the relay's JSON
 * lane, where a 120 Hz stream would starve everything else.
 */

/** A socket holding more than this unsent is closed (`slow`); the viewer opens another. */
export const VIDEO_MAX_UNSENT = 8 * 1024 * 1024
/** A stream nobody joined: its ticket is spent or expired by now, so its feed is let go. */
export const VIDEO_UNCLAIMED_MS = 35_000

/** The viewer's side: what the relay needs of a WebSocket. */
export interface ViewerSocket {
  readonly bufferedAmount: number
  send(data: Uint8Array): void
  close(code: number, reason: string): void
  on(event: 'message', fn: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown
  on(event: 'close', fn: () => void): unknown
}

export interface StreamGrant {
  /** the key `video.open` named: a thread's id, or a box thread's `macComputerKey` */
  thread: string
  scope: Exclude<StreamScope, 'publish'>
  holder: StreamHolder
  /** the RPC socket that asked: the stream ends with it */
  connection: object
  feed: VideoFeed
  /** what he drives as one (the box browser's pane): `setDriver` speaks of it */
  group?: string
  /** what the source keeps beside the stream (the box's page id) */
  tag?: string
  /** what the viewer reads beside frames (`video.open`'s `accepts`) */
  accepts?: readonly VideoAccept[]
  /** This source captures on the relay host’s monotonic clock. */
  captureClock?: true
  /** Omit X cursor shapes when Windows already draws its pointer into the frame. */
  cursor?: false
}

export interface StreamInfo {
  id: string
  thread: string
  scope: Exclude<StreamScope, 'publish'>
  holder: StreamHolder
  group: string | null
  tag: string | null
  accepts: readonly VideoAccept[]
  /** a viewer's socket has joined */
  joined: boolean
}

interface Stream extends StreamGrant {
  id: string
  socket: ViewerSocket | null
  timer: NodeJS.Timeout | null
}

const sameHolder = (a: StreamHolder, b: StreamHolder): boolean =>
  'keyId' in a ? 'keyId' in b && a.keyId === b.keyId : 'local' in b && a.local === b.local

export class VideoRelay {
  private readonly streams = new Map<string, Stream>()
  /** the groups he drives now */
  private readonly driven = new Set<string>()
  /** the stream each group's last input came on, and who held it */
  private readonly lastInput = new Map<string, { stream: string; holder: StreamHolder }>()
  /** When his last input came in for a group, on this process's clock (`performance.now()`). */
  private readonly lastInputAt = new Map<string, number>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly opts: { maxUnsent?: number; unclaimedMs?: number; nowMicros?: () => number } = {}) {}

  /** A stream for one viewer, not yet joined: its id goes back with a ticket. */
  open(grant: StreamGrant): string {
    const id = randomBytes(12).toString('base64url')
    const stream: Stream = { ...grant, id, socket: null, timer: null }
    stream.timer = setTimeout(() => this.end(id, 'ended'), this.opts.unclaimedMs ?? VIDEO_UNCLAIMED_MS)
    stream.timer.unref?.()
    this.streams.set(id, stream)
    this.changed()
    return id
  }

  /** Whether a ticket's claim may join this stream: it exists, nobody joined it, and the claim is the one it was opened for. */
  claimable(claim: StreamClaim): boolean {
    const s = this.streams.get(claim.stream)
    return !!s && !s.socket && s.scope === claim.scope && sameHolder(s.holder, claim.holder)
  }

  /** The viewer's socket joins; frames flow from here. False when the claim does not hold (the socket is then the caller's to close). */
  attach(claim: StreamClaim, socket: ViewerSocket): boolean {
    if (!this.claimable(claim)) return false
    const s = this.streams.get(claim.stream)!
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    s.socket = socket
    const max = this.opts.maxUnsent ?? VIDEO_MAX_UNSENT
    const pong = s.accepts?.includes('pong')
    const cursor = s.cursor !== false && s.accepts?.includes('cursor')
    const capture = pong && s.captureClock ? new VideoSamples() : null
    let generation = 0
    const send = (bytes: Uint8Array): void => {
      if (socket.bufferedAmount > max) return this.end(s.id, 'slow')
      socket.send(bytes)
    }
    socket.on('message', (data, isBinary) => {
      if (!isBinary || this.streams.get(s.id) !== s) return
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data
      const type = messageType(bytes)
      // a feed that throws ends its own stream, never the process
      this.guard(s, () => {
        if (type === MESSAGE_TYPES.ping && pong) {
          const sequence = pingSequence(bytes)
          if (sequence !== null) send(encodePong(sequence, capture?.median()))
        } else if (type === MESSAGE_TYPES.ack) s.feed.ack(bytes)
        else if (type === MESSAGE_TYPES.input && this.drives(s)) {
          this.lastInput.set(s.group!, { stream: s.id, holder: s.holder })
          this.lastInputAt.set(s.group!, performance.now())
          s.feed.input(bytes)
        }
      })
    })
    socket.on('close', () => this.remove(s))
    this.guard(s, () =>
      s.feed.start({
        frame: (bytes) => this.guard(s, () => {
          if (this.streams.get(s.id) !== s) return
          const type = messageType(bytes)
          if (type === MESSAGE_TYPES.cursor && cursor) return send(bytes)
          if (type !== MESSAGE_TYPES.frame) return
          if (capture) {
            const now = this.opts.nowMicros?.() ?? Number(process.hrtime.bigint() / 1000n)
            const frame = parseFrame(bytes)
            if (frame.generation !== generation) {
              capture.clear()
              generation = frame.generation
            }
            if (now >= frame.timestamp) capture.add((now - frame.timestamp) / 1000)
          }
          send(bytes)
        }),
        end: (reason) => this.end(s.id, reason)
      })
    )
    this.changed()
    return true
  }

  private guard(s: Stream, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.error('[video] a feed failed', err)
      this.end(s.id, 'error')
    }
  }

  /** Ends one stream: its socket closes with the reason's code and its feed is let go. */
  end(id: string, reason: VideoCloseReason): void {
    const s = this.streams.get(id)
    if (!s) return
    this.remove(s)
    s.socket?.close(VIDEO_CLOSE[reason], reason)
  }

  /** Ends every stream that matches; answers how many. */
  endWhere(match: (s: StreamInfo) => boolean, reason: VideoCloseReason): number {
    const ids = this.list().filter(match).map((s) => s.id)
    for (const id of ids) this.end(id, reason)
    return ids.length
  }

  /** `video.close`: a socket ends a stream it opened, and no other. */
  close(id: string, connection: object): boolean {
    const s = this.streams.get(id)
    if (!s || s.connection !== connection) return false
    this.end(id, 'ended')
    return true
  }

  /** The stream `id` if this socket opened it. */
  own(id: string, connection: object): StreamInfo | null {
    const s = this.streams.get(id)
    return s && s.connection === connection ? this.info(s) : null
  }

  /** The RPC socket that asked is gone: its streams end with it. */
  dropConnection(connection: object): void {
    for (const s of [...this.streams.values()]) if (s.connection === connection) this.end(s.id, 'ended')
  }

  /** The key was revoked: every stream it opened closes. */
  revoke(keyId: string): void {
    this.endWhere((s) => 'keyId' in s.holder && s.holder.keyId === keyId, 'revoked')
  }

  /**
   * Who drives `group` now, told by the drive push and never read per record.
   * When he hands back, each of the group's drive streams lets go of every
   * key and button and is a watch stream from then on. One nobody joined yet
   * is ended: its ticket was for a drive stream, which it no longer is.
   */
  setDriver(group: string, owner: boolean): void {
    if (owner) {
      this.driven.add(group)
      return
    }
    const was = this.driven.delete(group)
    this.lastInput.delete(group)
    this.lastInputAt.delete(group)
    for (const s of [...this.streams.values()]) {
      if (s.group !== group || s.scope !== 'drive') continue
      if (!s.socket) {
        this.end(s.id, 'ended')
        continue
      }
      if (was) this.guard(s, () => s.feed.release())
      s.scope = 'watch'
    }
    this.changed()
  }

  /**
   * Whether stream `id` is the one his last input in its group came on: true too before any input since he took over,
   * and for a stream of the same holder once that one is gone (the viewer opened it again).
   */
  sentLastInput(id: string): boolean {
    const s = this.streams.get(id)
    if (!s?.group) return false
    const last = this.lastInput.get(s.group)
    if (!last || last.stream === id) return true
    return !this.streams.has(last.stream) && sameHolder(last.holder, s.holder)
  }

  /** He drives `group` now. */
  driving(group: string): boolean {
    return this.driven.has(group)
  }

  /** Ms since his last input for `group` while he drives it; null when he does not, or has sent none since he took over. */
  sinceInput(group: string): number | null {
    const at = this.driven.has(group) ? this.lastInputAt.get(group) : undefined
    return at === undefined ? null : performance.now() - at
  }

  list(): StreamInfo[] {
    return [...this.streams.values()].map((s) => this.info(s))
  }

  /** Called after a stream opens, joins or goes: a source counts its viewers from `list`. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Every stream ends: the host is closing. */
  shutdown(): void {
    for (const id of [...this.streams.keys()]) this.end(id, 'ended')
  }

  private drives(s: Stream): boolean {
    return s.scope === 'drive' && !!s.group && this.driven.has(s.group)
  }

  private info(s: Stream): StreamInfo {
    return { id: s.id, thread: s.thread, scope: s.scope, holder: s.holder, group: s.group ?? null, tag: s.tag ?? null, accepts: s.accepts ?? [], joined: !!s.socket }
  }

  private remove(s: Stream): void {
    if (this.streams.get(s.id) !== s) return
    this.streams.delete(s.id)
    if (s.timer) clearTimeout(s.timer)
    s.feed.close()
    this.changed()
  }

  private changed(): void {
    for (const fn of this.listeners) fn()
  }
}
