import { randomBytes } from 'node:crypto'
import { VIDEO_CLOSE, type VideoCloseReason } from '@shared/contract-video'
import { MESSAGE_TYPES, messageType } from '@shared/video/nsl1'
import type { StreamClaim, StreamHolder, StreamScope } from '../remote/auth'
import { isFrame, type VideoFeed } from './feed'

/**
 * Joins a viewer's socket to its feed (docs/agents/live-video.md "The
 * relay"). A pipe, never a fan-out: one stream is one viewer, one socket and
 * one feed, so each encoder follows its own viewer's link. It reads a
 * message's type and nothing else:
 *   feed → viewer   frames only, as they came
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
}

export interface StreamInfo {
  id: string
  thread: string
  scope: Exclude<StreamScope, 'publish'>
  holder: StreamHolder
  group: string | null
  tag: string | null
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
  private readonly listeners = new Set<() => void>()

  constructor(private readonly opts: { maxUnsent?: number; unclaimedMs?: number } = {}) {}

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
    socket.on('message', (data, isBinary) => {
      if (!isBinary || this.streams.get(s.id) !== s) return
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data
      const type = messageType(bytes)
      // a feed that throws ends its own stream, never the process
      this.guard(s, () => {
        if (type === MESSAGE_TYPES.ack) s.feed.ack(bytes)
        else if (type === MESSAGE_TYPES.input && this.drives(s)) s.feed.input(bytes)
      })
    })
    socket.on('close', () => this.remove(s))
    this.guard(s, () =>
      s.feed.start({
        frame: (bytes) => {
          if (this.streams.get(s.id) !== s || !isFrame(bytes)) return
          if (socket.bufferedAmount > max) return this.end(s.id, 'slow')
          socket.send(bytes)
        },
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

  /** He drives `group` now. */
  driving(group: string): boolean {
    return this.driven.has(group)
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
    return { id: s.id, thread: s.thread, scope: s.scope, holder: s.holder, group: s.group ?? null, tag: s.tag ?? null, joined: !!s.socket }
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
